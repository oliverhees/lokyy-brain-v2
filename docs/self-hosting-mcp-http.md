# Self-hosting: MCP over HTTP

This guide is for operators who run Lokyy Brain vaults as containers, one per company or team, and connect them to an MCP aggregator.

> **Warning — the web UI port has no user authentication.** Port `4321` (`PORT`) serves the web UI and the full HTTP API (`/api/*`, see `apps/server/src/index.ts`) without any login. The only built-in check is the proxy shared secret (see below): requests without the `X-Vault-Proxy-Secret` header get `403`. Anyone who can reach the port with the secret — normally only your reverse proxy — has full read and write access to the vault, including `internal`/`pii` pages and `PUT /api/config` (LLM API key). This bypasses both MCP token profiles described below. Never publish this port. Reach it only through an authenticating reverse proxy (for example Traefik with Authentik forward-auth), and keep it off every network the MCP aggregator or other services share. Configure the proxy to inject `X-Vault-Proxy-Secret` (overwriting any client-supplied value) only on that vault's route.

It covers configuration, the two access profiles, what read-only sessions can see, the security behaviour of the HTTP transport, known limitations, and how to run the tests.

Sources of truth: `apps/mcp/src/http.ts`, `apps/mcp/src/access.ts`, `apps/mcp/src/visibility.ts`, `deploy/Dockerfile`, `deploy/entrypoint.sh`. If this document and the code disagree, the code wins. Please report the mismatch.

## Overview

- **One vault = one container.** Each container serves one data directory (`MINDBASE_DATA_DIR`, `/data` in the image, declared as a volume).
- **Web UI** listens on port `4321` (`PORT`).
- **MCP server** is served over Streamable HTTP at the path `/mcp` on `MCP_HTTP_PORT`. It only starts when `MCP_HTTP_PORT` is set to a non-empty value (`deploy/entrypoint.sh`). The image exposes `4321` and `4322`.
- **Network placement.** The MCP endpoint is meant to be reached only by an MCP aggregator (for example MetaMCP) on an internal container network. Do not publish the MCP port to the host or the internet. The endpoint has no TLS. Its security rests on bearer tokens and on staying inside the internal network.

```
MCP clients ──► aggregator (e.g. MetaMCP) ──internal network──► vault container
                                                                  ├─ web UI   :4321
                                                                  └─ MCP      :MCP_HTTP_PORT/mcp
```

### Build and run

```bash
# from the repository root
docker build -f deploy/Dockerfile -t lokyy-brain-vault .

docker network create --internal mcp-acme   # vault <-> aggregator only, no egress
docker run -d --name vault-acme --network mcp-acme \
  -v vault-acme-data:/data \
  -e MCP_HTTP_PORT=4322 \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  -e MCP_HTTP_READONLY_TOKEN="$(openssl rand -hex 32)" \
  -e MCP_HTTP_ALLOWED_HOSTS=vault-acme:4322 \
  -e VAULT_PROXY_SECRET="$(openssl rand -hex 32)" \
  lokyy-brain-vault
```

No `-p` flag: the ports stay on the internal `mcp-acme` network, which only the vault and the aggregator join (one such network per vault). The aggregator connects to `http://vault-acme:4322/mcp`. Because port 4321 is reachable on every network the container joins, the aggregator can reach the web port too; the proxy secret guard answers `403` to it, but for real deployments also put the web UI on a separate network shared only with the authenticating reverse proxy. A complete reference setup (Traefik, Authentik, per-vault networks, egress) is developed in LBV2-2. In a real deployment, pass the tokens from your secret store instead of generating them inline, so you can also configure them in the aggregator.

The container runs as the non-root user `vault` (uid 10001) under `tini`.

### Image contents and size

`deploy/Dockerfile` is a three-stage build on Debian bookworm:

1. **build** (`node:20-bookworm`): installs the whole workspace, builds `@mindbase/core`, the web UI and the MCP server, and compiles the web server with `deploy/build-server.mjs` into `apps/server/dist/server.mjs` (esbuild; `@mindbase/core` is inlined, packages from `apps/server/package.json` `dependencies` stay external).
2. **prod-deps** (`node:20-bookworm`): installs production dependencies only, for `@mindbase/server` and `mindbase-mcp`. Native modules (`better-sqlite3`, `argon2`, `sharp`, `onnxruntime-node`) are built or downloaded here for Debian glibc. Unused files are removed: `tsx`/`esbuild`, musl and macOS/Windows binaries, `*.d.ts` and `*.map`.
3. **runtime** (`node:20-bookworm-slim`): only `node_modules`, `apps/server/dist`, `apps/mcp/dist`, `apps/web/dist`, `schema/`, `apps/plugin/templates/` and `deploy/entrypoint.sh`. No TypeScript sources, no dev dependencies, no `tsx`.

| | Before LBV2-6 (whole workspace + dev deps, `tsx` at runtime) | Since LBV2-6 |
|---|---|---|
| `docker image ls` disk usage | 1.82 GB | 800 MB |
| Content size (compressed layers) | 367 MB | 179 MB |

The remaining `node_modules` is about 360 MB; the largest packages are `tesseract.js-core`, `@xenova/transformers` and `onnxruntime-node` (embeddings), `googleapis` (37 MB, Google Drive import), `@napi-rs/canvas` and `pdfjs-dist`. The web server needs no build step at runtime and starts in a few seconds.

`deploy/build-server.mjs` rewrites `import.meta.dirname` in server sources to the original source directory, so `schema/`, `apps/web/dist` and `.env` resolve as they do in development. The build fails if server code uses `import.meta.url`, `import.meta.filename`, `__dirname` or `__filename`, because those would silently point to `dist/` in the bundle.

**Embedding model cache (`/models`).** The web server's embedding indexer and the MCP server load the BGE-M3 model through `@xenova/transformers`, which downloads it from Hugging Face on first use (about 560 MB) and caches it in the package directory. In the image that cache directory is a symlink to `/models`, owned by `vault`. Without a mount the model is downloaded again after every container recreation. To keep it, mount a named volume:

```bash
docker run ... -v lokyy-models:/models ...
```

One volume can be shared by several vault containers; the files are read-only after the download. Without outbound access to `huggingface.co` the download fails; the indexer logs the failure per page and keyword search keeps working.

With the model in-process, every vault holds it in memory (measured 2.62 GiB peak per vault). For several vaults on one server use the [shared embedding service](#shared-embedding-service) instead: the vault then does not need `/models` at all.

### Shared embedding service

`deploy/stack/embed` (LBV2-26) loads BGE-M3 once for all vaults of a server. Build it with `docker build -f deploy/Dockerfile --target embed .`; `deploy/stack/compose.yml` shows the complete wiring.

**Vault side.** Set both variables on the vault container (web server and MCP process read them):

| Variable | Effect |
|---|---|
| `MINDBASE_EMBED_URL` | Base URL of the service, e.g. `http://embed:8080`. Plain `http(s)` URL without credentials, query or fragment. |
| `MINDBASE_EMBED_TOKEN` | This vault's own token (`openssl rand -hex 32`). Never share a token between vaults. |
| `MINDBASE_EMBED_TIMEOUT_MS` | Optional, per attempt, default `45000`. |
| `MINDBASE_EMBED_RETRIES` | Optional, extra attempts on `429`/`502`/`503`/`504`, timeouts and network errors, default `2` (exponential backoff from 500 ms; `Retry-After` is honoured up to 10 s). |

With both set, the vault never loads the model: page indexing and hybrid search in the web server, and `semantic_search` in the MCP server (no LLM configuration needed; page vectors already cached by the web server are reused), go to `POST <url>/embed`. Setting only one of the two is a configuration error: embedding calls fail instead of silently loading the model in-process. Service errors are logged without text content; hybrid search falls back to keyword results, `semantic_search` to keyword search. Without both variables the in-process behaviour is unchanged. The service URL comes from the operator, not from the vault configuration, so `VAULT_LLM_ALLOWED_HOSTS` does not apply to it; requests never follow redirects.

Vectors are interchangeable with in-process ones (same model files, mean pooling, normalisation, 8000-character cut; `deploy/stack/tests/embed.sh` compares them), so an existing embedding cache stays valid when you switch.

**Service side** (`EMBED_*` environment of the `embed` container):

| Variable | Default | Effect |
|---|---|---|
| `EMBED_VAULTS` | required | Comma-separated vault names (`^[a-z][a-z0-9-]*$`). |
| `EMBED_TOKEN_SHA256_<VAULT>` | required | SHA-256 hex digest of that vault's token (upper case, `-` → `_`). The service only ever sees hashes; missing, malformed or duplicate hashes stop it at startup. `deploy/stack/embed-tokens.sh` derives them from `EMBED_TOKEN_<VAULT>`. |
| `EMBED_SOURCE_<VAULT>` | unset | Comma-separated IPv4 networks. When set, that vault's token is accepted only from these addresses (its own network), so a token that leaks to another vault is useless there. Set it for every vault. |
| `EMBED_MAX_TEXTS` / `EMBED_MAX_CHARS` / `EMBED_MAX_BODY_BYTES` | `32` / `8000` / `1048576` | Per request; larger requests get `400` or `413` before any inference. |
| `EMBED_RATE_PER_SEC` / `EMBED_BURST` | `20` / `200` | Texts per second per vault (token bucket); over the limit `429` with `Retry-After`. |
| `EMBED_MAX_PENDING_PER_VAULT` / `EMBED_MAX_QUEUE` | `4` / `64` | Queued plus running requests per vault (`429`) and in total (`503`). |
| `EMBED_QUEUE_TIMEOUT_MS` | `30000` | A request that has not started within this time gets `503`. |
| `EMBED_MODELS_DIR` / `EMBED_PORT` | `/models` / `8080` | Read-only model cache (filled and verified by `model-prefetch`) and listen port. |

Texts are embedded one at a time, round-robin across vaults, so one vault's indexing run cannot starve another vault's search. A client that disconnects cancels its remaining texts. Error bodies are static (`{"error":"unauthorized"}`, …); log lines carry vault name, text count, status and duration, never text or token material. `GET /healthz` answers `200` once the model is loaded.

**Network model.** Give each vault its own internal network that contains only that vault and the service (`embed-<vault>` in `deploy/stack`), and do not attach the service to any other network: it needs no outbound access, and a vault reaches only the service's address on its own network. The service has no proxy or forwarding code (anything but `POST /embed` and `GET /healthz` is `404`/`405`). Run it with a read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges` and a memory limit.

**Residual risk.** The service is a shared component on every vault's embed network. A compromised vault can send it arbitrary input (bounded by the limits above) and try to exploit the HTTP server, tokenizer or ONNX runtime. If that succeeded, the attacker would control a process with a network path to every vault's embed network, i.e. to every other vault's ports; those still require the proxy secret (web) or bearer token (MCP), but the lateral step is possible. The service holds no vault data, no plain tokens and no credentials, and has no outbound network. Mitigations in place: the limits and fair queue, token plus source-network binding, static errors, no forwarding, hardened container. Further hardening, not done yet: a seccomp profile, dropping the ONNX runtime's unused execution providers, egress/ingress firewall rules on the host so the service can only answer (not open) connections towards vaults, and one service per vault group if a server mixes trust domains.

## Configuration

### MCP HTTP transport (`apps/mcp/src/http.ts`)

The server validates every integer variable at startup. A value that is not an integer, or is below the minimum, makes the process exit with code 1. The server never silently falls back to the default. An unset or empty variable uses the default.

| Variable | Default | Validation | Effect |
|---|---|---|---|
| `MCP_HTTP_TOKEN` | none (required) | at least 32 characters, otherwise the process exits 1 | Token for the **full** access profile. Clients send `Authorization: Bearer <token>` (the scheme name is case-insensitive). |
| `MCP_HTTP_READONLY_TOKEN` | unset (no read-only profile) | if set: at least 32 characters and different from `MCP_HTTP_TOKEN`, otherwise the process exits 1 | Token for the **read-only** access profile (see [Access profiles](#access-profiles)). |
| `MCP_HTTP_PORT` | `4322` when `http.js` runs directly | integer, at least 1 | Listen port. In the container, the MCP server only starts if this variable is set. |
| `MCP_HTTP_HOST` | `0.0.0.0` | none | Listen address. Keep `0.0.0.0` inside a container so the aggregator can reach it over the container network. |
| `MCP_HTTP_MAX_SESSIONS` | `32` | integer, at least 1 | Maximum number of concurrent full-profile sessions. |
| `MCP_HTTP_MAX_READONLY_SESSIONS` | value of `MCP_HTTP_MAX_SESSIONS` | integer, at least 1 | Separate maximum for read-only sessions. The two profiles never evict each other's sessions. |
| `MCP_HTTP_SESSION_IDLE_MS` | `1800000` (30 min) | integer, at least 1000 | Sessions idle longer than this are closed. |
| `MCP_HTTP_READONLY_LLM_RATE` | `20` | integer, at least 0 | Maximum LLM provider requests (today: from `ask_wiki`) **per read-only session** within the window. `0` disables LLM-backed tools for readers. Counted per process, reset on restart; see [Reader LLM access](#reader-llm-access-ask_wiki). |
| `MCP_HTTP_READONLY_LLM_RATE_TOTAL` | `60` | integer, at least 0 | Maximum LLM provider requests of **all read-only sessions together** (that is, per read-only token) within the window. Opening more sessions does not raise it. |
| `MCP_HTTP_READONLY_LLM_WINDOW_MS` | `600000` (10 min) | integer, at least 1000 | Sliding window for both reader LLM limits. |
| `MCP_HTTP_ALLOWED_HOSTS` | unset (no Host check) | comma-separated, trimmed, case-insensitive | If set, requests whose `Host` header is not in the list get `403`. The list is compared against the full header value, including the port (for example `vault-acme:4322`). |

### Container and web server

| Variable | Default in image | Effect |
|---|---|---|
| `MINDBASE_DATA_DIR` | `/data` | Vault data directory, used by both the web server and the MCP server. Without it, both fall back to `~/mindbase-data`. |
| `PORT` | `4321` | Web server port. The healthcheck assumes `4321`. |
| `MINDBASE_MDNS` | `off` | Any value other than `off` makes the web server advertise itself via mDNS (`_mindbase._tcp`). Keep `off` in containers. |
| `NODE_ENV` | `production` | Standard Node.js setting. |
| `MINDBASE_ALLOW_PRIVATE_FETCH` | unset (protection on) | Only the exact value `1` turns off the SSRF address check for URL fetches in both the web server and the MCP server (see [Outbound URL fetches](#outbound-url-fetches-ssrf-protection)). Meant for local single-user setups that ingest from `localhost` or the LAN. Never set it in a multi-tenant or self-hosted container. |
| `MINDBASE_FETCH_CONCURRENCY` | unset (4) | Maximum concurrent outbound URL fetches per process, integer 1–64. |
| `MINDBASE_LLM_TIMEOUT_MS` | unset (120000) | Inactivity timeout for LLM provider requests (OpenAI, Anthropic, Ollama), integer 1000–3600000. A request fails with `LLM provider did not respond in time` when the provider sends no response headers, or no further stream data, for this long; answers that keep streaming are not cut off. An invalid value makes the web server and the MCP server (HTTP and stdio) exit with code 1 at startup. |
| `MINDBASE_PLUGIN_ROOT` | `/app/apps/plugin` | Location of the schema page templates (`templates/schema-templates/`) used by the tree template route. |
| `VAULT_PROXY_SECRET` | unset — **required** in the image | At least 32 characters and no leading or trailing whitespace, otherwise the web server exits. Every web request must carry header `X-Vault-Proxy-Secret` with this value (constant-time compare), otherwise `403`; the header is stripped before handlers. Not passed to the MCP process. The healthcheck sends it via stdin. Generate with `openssl rand -hex 32`, one per vault. |
| `VAULT_REQUIRE_PROXY_SECRET` | `1` | When set (any non-empty value), a missing or empty `VAULT_PROXY_SECRET` aborts web server startup instead of disabling the guard. An empty value turns the requirement off. |
| `VAULT_LLM_ALLOWED_HOSTS` | unset — **set it** in the image | Comma-separated `host` or `host:port` entries (exact match, case-insensitive) that the configured LLM and embeddings endpoint may use, for example `api.eurouter.ai` or `ollama:11434`. A bare host allows only `https` on port 443; plain `http` needs an explicit `host:80`. Enforced in guarded mode (`VAULT_PROXY_SECRET` or `VAULT_REQUIRE_PROXY_SECRET` set) and whenever the variable is set. **Unset or empty in guarded mode = no outbound LLM or embeddings calls at all** (fail closed). Pass it to the web server **and** the MCP process. See [LLM endpoint allow-list](#llm-endpoint-allow-list). |

### Generating tokens

```bash
openssl rand -hex 32   # 64 hex characters, meets the 32-character minimum
```

Generate a separate token for each vault and for each profile. The read-only token must differ from the full token, or the server refuses to start.

## Access profiles

Each token maps to one access profile:

| Profile | Token | Tools | Data visible |
|---|---|---|---|
| full | `MCP_HTTP_TOKEN` | all registered tools | everything in the vault |
| readonly | `MCP_HTTP_READONLY_TOKEN` | the 13 allowlisted tools below | only the reader view (see [Visibility](#visibility-read-only-sessions)) |

**A session is bound to the token that opened it.** A request that carries a valid token for the other profile on an existing session gets `403 Forbidden: token does not match session`. A read-only client therefore cannot escalate an existing session by switching tokens.

### Read-only tools

`READ_ONLY_TOOL_NAMES` in `apps/mcp/src/access.ts` lists these tools. The list is frozen, and the lookup set is private to the module:

| Tool | Purpose |
|---|---|
| `search_wiki` | keyword search |
| `search_all_projects` | keyword search across projects (readers only see the root wiki) |
| `search_in_project` | project-scoped search |
| `read_wiki_page` | read one page |
| `list_recent` | recently updated pages |
| `find_related` | related pages |
| `get_graph_insights` | hubs, orphans, broken links |
| `find_orphans` | pages without incoming links |
| `suggest_links` | link suggestions (review only, no changes) |
| `export_subgraph` | page plus neighbours as markdown |
| `list_feeds` | RSS feed summaries |
| `list_review_cards` | review cards |
| `ask_wiki` | question answered by the configured LLM from visible pages, with citations; rate limited (see [Reader LLM access](#reader-llm-access-ask_wiki)) |

For read-only sessions:

- `tools/list` returns only these tools.
- `tools/call` for any other name, including names that do not exist, is rejected with `Tool not available: <name>` ("This session has read-only access."). The check runs before the handler lookup, so a reader cannot tell a hidden tool from a nonexistent one.
- Chat resources (`mindbase://chats/*`) are not listed and cannot be read.
- Only prompts whose tools are all on the allowlist are offered: `daily-digest`, `brainstorm`, `connect`, `explain`, `quiz`. A prompt with no entry in the prompt-to-tool map is offered to full sessions only.
- The server sends reader-specific instructions that name only allowlisted tools.

### What readers cannot do, and why

The review rule for the allowlist, from `access.ts`: no persistent writes to the data directory, no outbound network or URL fetching. An LLM call is allowed only for a tool that was reviewed against the reader view; today that is `ask_wiki` only. Every reader provider request goes through the reader LLM adapter, which enforces the rate limit.

| Excluded | Examples | Reason |
|---|---|---|
| Writes | `create_note`, `append_to_page`, `set_visibility`, `mindbase_contribute`, … | they change the vault |
| URL fetching | `mindbase_ingest_file` (URL mode), `add_rss_feed` | outbound network access, and they write |
| Other LLM and embedding calls | `semantic_search`, `synthesize_topic`, `find_contradictions`, `find_gaps`, `get_pulse`, `generate_daily_brief` | not reviewed against the reader view; they call the LLM or embedding API or write shared caches |
| Chats | `list_chats`, `recall_chat` | they expose other users' chat history |
| Project wikis and status tools | `mindbase_status`, `mindbase_gather_sources`, `mindbase_validate_structure` | they read the data directory directly with `node:fs`, bypassing the reader view, and expose file names, modification times, and absolute project paths |

All store write methods and `reindex` reject with `read-only session`.

### Reader LLM access (`ask_wiki`)

Decision of 2026-09-16 (LBV2-18): readers may use `ask_wiki` through the vault's configured LLM provider (for example EUrouter), rate limited, and only visible pages may ever be sent to the provider.

**What a reader's `ask_wiki` call sends to the LLM provider.** One chat request containing:

- a fixed instruction text,
- the reader's question, as typed (at most 2000 characters),
- for up to `max_pages` (default 8, max 20) pages: title, slug, and the markdown body.

**Bounds (all profiles).** `question` is limited to 2000 characters and `context_pages` to 20 entries; larger input is rejected with `Invalid input` before any retrieval or LLM request. Each page body is cut at 8000 characters, and pages are added in retrieval order until the context block reaches 40000 characters; the last section is cut there and later pages are left out. Cuts are marked `[… truncated]` and are deterministic for the same pages. The mark counts toward the 40000-character block limit, so the block never exceeds it; a cut never splits a character.

The pages are chosen from the reader view only: the top keyword search hits for the question, the pages named in `context_pages`, and their 1-hop wikilink neighbours. A slug is looked up in `wiki/notes` first, then in `wiki/concepts`. Every page is read through the reader store, which checks the page's meta on disk right before returning it. Hidden pages (`internal`, `pii`, broken meta, in either layer), project wikis, raw sources, and chats can therefore never enter the prompt, even when `context_pages` names them. They are skipped exactly like pages that do not exist, so a reader cannot tell a hidden page from a missing one. If no visible page remains, no LLM request is made.

**Data protection note.** Everything in public root-wiki pages can be sent to the configured provider, together with whatever the reader types into the question. Treat the provider as a processor of that data (DPA, region, retention). Do not mark a page `public` if its content must not leave your infrastructure. The provider's answer is returned to the reader, and nothing is written to the vault: no chat history, no cache, no log page.

**Response.** `answer` (LLM text), `citations` (visible pages only), `pages_read` (only the pages actually sent), and `tokens_used`. Provider errors are replaced by the generic `LLM error: LLM request failed`, because provider error bodies can contain internal host names or prompt fragments. Unexpected failures inside `ask_wiki` return `ask_wiki failed` for every profile; the detail is written only to the server log (stderr).

**Answers are untrusted output.** The answer is generated from page content. A visible page can contain text written to steer an LLM (prompt injection), and that text can shape the answer the reader's own agent then acts on. Clients should treat `answer` like any other untrusted document content, not as instructions.

**Credentials stay on the server.** The reader context carries only `provider` and `model` of the configuration. API key and base URL are not part of it.

**Rate limit.** Every provider request of a read-only session is counted, synchronously and right before the request is sent, by the reader LLM adapter: per session (`MCP_HTTP_READONLY_LLM_RATE`, default 20) and for all read-only sessions together (`MCP_HTTP_READONLY_LLM_RATE_TOTAL`, default 60), in a sliding window of `MCP_HTTP_READONLY_LLM_WINDOW_MS` (default 10 minutes). A request over either limit is not sent; the tool returns `LLM error: Rate limit exceeded for LLM-backed tools`. Calls that never reach the provider (invalid input, unsafe slug, "No relevant pages found") consume no budget, so failing calls cannot lock out other readers. Full sessions are not limited.

**The limits are per process.** Counters live in the memory of one MCP process: they reset when the process restarts, and they are not shared between instances. Running several replicas behind a load balancer multiplies the effective limit by the number of replicas. Run one MCP instance per vault if the limit must hold.

**Fail-closed allowlist.** The profile is an allowlist, not a denylist. Tools added upstream later are denied to read-only sessions until someone reviews them and adds them to `READ_ONLY_TOOL_NAMES`. Treat tool deactivation in the aggregator as a second layer only. The vault enforces the profile itself.

## Visibility (read-only sessions)

Read-only sessions work on a filtered reader view (`apps/mcp/src/visibility.ts`). Full sessions are unaffected.

**Readers never see pages whose meta has `visibility` `internal` or `pii`.** These pages are not listed, not searchable, not readable, and cannot be told apart from pages that do not exist.

Rules, all fail-closed:

- **Visibility comes from meta files on disk.** A page is visible only if its `<slug>.meta.json` exists, parses as a JSON object, and has `visibility` absent, `null`, or `"public"`. The page is hidden if the meta file is missing or unreadable, if it is not an object, or if it has any other `visibility` value.
- **Visibility is re-read before every request.** Each tool call and each resource list or read refreshes the visible set from disk. The page's meta is checked again right before a page file is returned.
- **Index rows are never trusted for visibility.** The SQLite index may be stale and does not record the layer.
- **Hidden pages answer like missing pages.** Hidden, disallowed, and nonexistent paths all fail with the same `Not found` error. The error shows only a relative page path, or `requested path`.
- **Only the root wiki is visible.** That covers `wiki/notes/<slug>` and `wiki/concepts/<slug>` in index project `default`. Project wikis (`projects/*`), project context, sources, raw files, chats, and every other path are invisible, even when a project page's own meta says `public`.
- **Slug collisions fail closed.** If a slug is hidden in one layer, slug-keyed views (graph, page rows, cards) do not show it, even if the other layer has a public page with that slug.
- **Links.**
  - A wikilink in a visible page's body that points to a hidden page stays in the graph as a broken link, exactly like a link to a page that does not exist.
  - Links not taken from a page body (LLM-inferred links, or links of unknown origin) are dropped when the target is not visible, whether it is hidden or missing.
  - Links from hidden pages are dropped.
- **Community ids are removed** from page rows and graph nodes, because they are computed over all pages.
- **Search results carry rank, not score.** Readers get a descending position number (`hits.length - i`) instead of the raw score, which would reveal statistics of hidden pages.
- **Review cards** are shown only if their `source_slug` is a visible slug. Cards without `source_slug` are hidden.
- **The `mindbase://insights` resource** is generated live from the filtered graph for readers. The stored `wiki/_insights.md` is not served to readers because it may name restricted pages.
- **Configuration and paths are withheld.** The reader context does not contain `dataDir` (an absolute path), the API key or base URL (its `config` holds only `provider` and `model`), the synthesis cache, or templates.

## Security behaviour

### Authentication and request handling

The server checks each request in this order:

1. **Token.**
   - Only the `Authorization: Bearer <token>` header is accepted; the scheme name is matched case-insensitively (`bearer` works, RFC 7235). A token in the query string gets `401`.
   - The given token and each configured token are SHA-256 hashed and compared with `timingSafeEqual`, against every configured token.
   - A missing or wrong token gets `401 Unauthorized`.
   - Both tokens must be at least 32 characters long.
2. **Host allow-list.** If `MCP_HTTP_ALLOWED_HOSTS` is set, requests with a `Host` header outside the list get `403 Forbidden host`. The check runs after authentication.
3. **Path.** Only `/mcp` is served. Anything else gets `404`.
4. **Session.**
   - An unknown `mcp-session-id` gets `404` (JSON-RPC code `-32001`), so the client re-initializes.
   - A token for the other profile gets `403`.
   - A POST without a session that is not an `initialize` request gets `400`.
   - Methods other than POST, GET, and DELETE get `405`.
5. **Body.** JSON bodies are limited to 4 MiB. A larger declared `Content-Length`, or a larger streamed body, gets `413 Payload too large`, and the connection is closed after the response. A malformed body gets `400 Bad Request`.

### Sessions

- **Idle expiry.** A background sweep closes sessions idle for longer than `MCP_HTTP_SESSION_IDLE_MS`. It skips sessions with a request in flight.
- **Per-profile caps with LRU eviction.**
  - When a profile reaches its cap, a new `initialize` evicts that profile's least recently used session that has no POST or DELETE in flight.
  - Long-lived GET notification streams do not count as in flight.
  - If every session of the profile is busy, the server answers `503 Too many active sessions`.
  - Sessions still initializing count toward the cap.
  - A read-only session never evicts a full session, and a full session never evicts a read-only one.
- **Shutdown.** On `SIGTERM` or `SIGINT`, the server closes all sessions and the HTTP server.

### Paths and slugs

- **Unsafe slugs are rejected centrally.**
  - The tool dispatcher checks the arguments `slug`, `slugs`, `source_slug`, `target_slug`, `root`, `context_pages` (`ask_wiki`), and `raw_id` (`ingest_plan`), for every tool and both profiles.
  - It rejects a `.` or `..` path segment, a backslash, a NUL byte, or a leading `/`, all with the same error: `Invalid input: unsafe slug`.
  - Because the check matches argument names, tools added later that use these names are covered too.
  - `mindbase://wiki/<slug>` resources apply the same check.
- **Path containment.** `FileStore` resolves every store path relative to the data directory. It refuses any path that would leave the directory (`Path is outside the store root`).
- **Local file paths are disabled over HTTP.** The HTTP transport sets `allowLocalFilePaths: false`, so `mindbase_ingest_file` rejects local paths ("Local file paths are not accepted on this server"). Local paths still work over stdio.

### Outbound URL fetches (SSRF protection)

Every fetch of a URL that comes from a client, a user, or feed content goes through one helper, `safeFetch` (`packages/core/src/net/safe-fetch.ts`). That covers `mindbase_ingest_file` (URL mode) and `add_rss_feed` in the MCP server, and in the web server `POST /api/feeds`, `POST /api/ingest/text` with a URL, article extraction for captures, the RSS worker (feed and article URLs), and result pages of the research web search. Endpoints from configuration (LLM provider, Ollama, embeddings, Brave API) do not use `safeFetch`; the LLM and embeddings endpoint is restricted by the [LLM endpoint allow-list](#llm-endpoint-allow-list) instead.

- **Schemes.** Only `http` and `https`. Other schemes, also in a redirect, are refused.
- **Address check.** The host name is resolved and **every** resolved address must be public.
  - IPv4 refused: `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (incl. the cloud metadata address), `172.16/12`, `192.0.0/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`.
  - IPv6 is **default-deny outside global unicast `2000::/3`**. That covers `::`, `::1`, IPv4-compatible and IPv4-translated addresses (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), `fc00::/7`, `fe80::/10`, multicast and everything else outside `2000::/3`. Inside it, `2001::/23` (incl. Teredo `2001::/32`), `2001:db8::/32` and `3fff::/20` are refused. IPv4-mapped (`::ffff:a.b.c.d`) and 6to4 (`2002::/16`) addresses are judged by the embedded IPv4 address.
- **DNS rebinding.** The connection is pinned to the address that passed the check, so a second DNS answer cannot redirect it.
- **Redirects** are followed manually, at most 5, and each hop is checked again. A redirect from `https` to `http` is refused. Userinfo (`user:pass@`) in a redirect target is removed.
- **Limits.** Timeout for the whole request including redirects, and a maximum decoded response size (after gzip/deflate/br). URL downloads for `mindbase_ingest_file` and `POST /api/ingest/text` are limited to 20 MB (local files over stdio: 50 MB).
- **Concurrency.** At most `MINDBASE_FETCH_CONCURRENCY` fetches (default 4, integer 1–64) run at once per process; further requests wait. At most 64 further fetches wait; the next one fails at once, and a waiting fetch fails as soon as its timeout expires. An invalid value makes both the MCP HTTP server and the web server exit with code 1 at startup.
- **Errors.** Clients get one message for every failure: `URL not allowed or unreachable`. Blocked addresses, DNS failures, refused connections, HTTP statuses, timeouts and size limits look the same, so the error cannot be used to map internal names or ports. The detail is written to the server log (`[safe-fetch] <scheme://host/path> <code>: …`, no query string). The same generic text is stored as a feed's `last_error`.

`MINDBASE_ALLOW_PRIVATE_FETCH=1` disables the address check (schemes, redirect rules, limits and generic errors still apply). Use it only for local single-user setups. Code can also exempt specific host names (`trustedHosts` option of `safeFetch`); no current call site uses it, and it must never be filled from client input.

### LLM endpoint allow-list

The LLM base URL (`baseUrl` in the vault config) is set by an admin in the UI or edited in the config file on disk, and every request to it carries the API key. Without a check it could point at an internal address (SSRF from the vault) or at a host that collects the key. `VAULT_LLM_ALLOWED_HOSTS` restricts it (`packages/core/src/net/llm-host-policy.ts`).

- **When enforced.** In guarded mode (`VAULT_PROXY_SECRET` or `VAULT_REQUIRE_PROXY_SECRET` set; the MCP process in the image only sees the latter) and whenever `VAULT_LLM_ALLOWED_HOSTS` is set. Local single-user setups without either variable are unchanged.
- **Matching.** Comma-separated `host` or `host:port` entries, compared exactly and case-insensitively (a trailing dot is ignored; IPv6 as `::1`, `[::1]` or `[::1]:8080`). No wildcards, no schemes, no paths: `api.eurouter.ai` does not allow `eu.api.eurouter.ai` or `eurouter.ai`.
- **Ports and schemes.** A bare host allows only `https://host` (port 443), so the API key never travels in plaintext by accident. Plain `http://host` needs an explicit `host:80` entry. `host:443` allows only `https`, `host:80` only `http`; any other listed port (for example `ollama:11434`) allows both. Every other port must be listed as `host:port`: `localhost` does not allow `http://localhost` or `http://localhost:6379`, and `api.eurouter.ai` does not allow `https://api.eurouter.ai:8443`. There is no exception for Ollama: its port `11434` must be listed (`ollama:11434`). Invalid entries (scheme, path, userinfo, port outside 1–65535) are ignored and logged at startup.
- **Fail closed.** Enforced with an unset or empty list, no LLM or embeddings request leaves the process. The web server and the MCP HTTP server log `[llm-host-policy] VAULT_LLM_ALLOWED_HOSTS is not set: all outbound LLM and embeddings calls are refused` at startup.
- **Private hosts only when listed.** A listed host may resolve to a private address and may use `http` if its entry allows it (for example a local Ollama container: `VAULT_LLM_ALLOWED_HOSTS=ollama:11434`, `baseUrl` `http://ollama:11434`). An unlisted host is never called, whatever it resolves to. Only `http` and `https` are accepted. The allow-list is by name: DNS for a listed name is trusted, so list only names you control or trust.
- **Provider defaults count.** An empty `baseUrl` means the provider default (`api.openai.com`, `api.anthropic.com`, `api.deepseek.com`, `localhost:11434` for Ollama); that entry must be listed too.
- **Config writes.** `PUT /api/config` answers `400 {"ok":false,"error":"LLM endpoint not allowed"}` when the provider or `baseUrl` changes to a destination whose host is not listed; the stored config stays unchanged. Saving other settings is not blocked. `POST /api/config/test` gives the same `400` before any request is made.
- **Call time (defence in depth).** The OpenAI/DeepSeek, Anthropic and Ollama adapters and semantic search (web server `GET /api/semantic-search`, MCP `semantic_search`) and the voice-capture transcription (Whisper, `api.openai.com`) check host and port again on every request, so an edited config file does not bypass the list. A refused chat shows the error `LLM endpoint not allowed`; the server log names the refused host (`[llm-host-policy] refused request to <host:port>: host or port not allowed by VAULT_LLM_ALLOWED_HOSTS`). MCP `semantic_search` falls back to keyword search.
- **Redirects.** While enforced, redirects from the LLM endpoint are handled manually: at most 5, and only within the same origin (scheme, host, port). A redirect to any other origin is refused before it is requested, even if the target host is also listed.

- **Ollama onboarding.** In guarded mode `GET /api/system`, `GET /api/ollama/status` and `POST /api/ollama/pull` do not exist (`404`): they would probe and pull on the container's own `localhost` and reveal hardware details. Configure a hosted Ollama through the normal provider settings instead.
  `GET /api/health` reports this as `features.localModels: false`; the setup wizard then disables the local-model option ("Local models are disabled on this server — choose a cloud provider") and never polls the missing routes.
- **Startup log without policy.** Outside guarded mode and without the variable, both servers log `[llm-host-policy] LLM host allowlist not configured; all LLM hosts allowed (unguarded mode)`. A redirect loop from an allowed host is refused after 5 hops and logged as `too many redirects`.
- **Exceptions.** None. No provider, port or local address is allowed implicitly.

Example for EUrouter (OpenAI-compatible): provider `openai`, `baseUrl` `https://api.eurouter.ai/api/v1`, and

```bash
VAULT_LLM_ALLOWED_HOSTS=api.eurouter.ai
```

Example for EUrouter plus an Ollama container on the same Docker network (provider `ollama`, `baseUrl` `http://ollama:11434`):

```bash
VAULT_LLM_ALLOWED_HOSTS=api.eurouter.ai,ollama:11434
```

### Container

- **Process supervision.** `deploy/entrypoint.sh` starts the web server and, if `MCP_HTTP_PORT` is set, the MCP server.
  - If either process exits, even with code 0, the other is stopped with `SIGTERM` and the container exits with a non-zero code. `on-failure` restart policies therefore apply.
  - `SIGTERM` and `SIGINT` sent to the container are forwarded to both processes (exit code 143), so in-flight writes can finish.
- **Healthcheck.** Every 30 s (timeout 5 s, start period 60 s, 3 retries):
  - `GET http://127.0.0.1:4321/` must succeed.
  - If `MCP_HTTP_PORT` is set, `POST http://127.0.0.1:$MCP_HTTP_PORT/mcp` without a token must return `401`. That shows the MCP process is alive and authentication is on.

## Identity and attribution

Contributor files and quick-capture entries are attributed to a username that becomes a directory under `sources/contributors/`.

When the proxy guard is active (`VAULT_PROXY_SECRET` set), attribution comes only from the identity header that the reverse proxy sets. The header name is `VAULT_IDENTITY_HEADER` (default `x-authentik-username`, compared case-insensitively). A client-sent `X-Mindbase-User` header is ignored in this mode. Configure Traefik's forward-auth middleware with `authResponseHeaders: X-authentik-username` so the proxy overwrites any value the client sends. If the header is missing or empty, every route that needs attribution (all `/api/tree` and `/api/ops` routes, including reads) answers `401 Unauthenticated`, and the server logs a warning at most once per minute with the number of occurrences. A missing header means the proxy is misconfigured, so the failure is deliberately loud. A value that is not a valid username (ASCII letters `A-Z`/`a-z`, digits, `_`, `-`, `.`; at most 64 characters; not starting with `.` or `-`; no `@`, spaces, non-ASCII letters such as `ü`, or `..`) or is the reserved name `unknown` (any case) gets `400 Invalid identity header`. Authentik usernames that are e-mail addresses therefore need a username without `@`.

Without the guard (local, single-user), `X-Mindbase-User` is used as before. If it is absent, the OS username is mapped to a valid name: every character outside the ASCII username alphabet becomes `_`, leading `.`/`-` are removed, `..` is collapsed, and the result is cut to 64 characters (`oliver@corp` → `oliver_corp`, `jürgen` → `j_rgen`); a result without any ASCII letter or digit, or `unknown`, becomes `user`. An invalid explicit header (including `unknown`) still gets `400`.

The MCP tool `mindbase_contribute` uses the same username rules. Over the HTTP transport its `user` argument is **required** (the server's OS account says nothing about the remote caller); a missing `user` is an error. Over stdio an omitted `user` falls back to the local OS account, mapped as above. An explicit `user` is never mapped, only validated.

| Variable | Default | Effect |
|---|---|---|
| `VAULT_IDENTITY_HEADER` | `x-authentik-username` | Name of the proxy-set identity header. Only read when `VAULT_PROXY_SECRET` is set. |
| `VAULT_GROUPS_HEADER` | `x-authentik-groups` | Name of the proxy-set groups header. Groups are split on `\|` only (Authentik format); a comma is part of the group name. A duplicated header (sent twice, which Node joins with `, `) or any value containing `, ` grants no groups. Group names must not contain `|`: how Authentik escapes it has not been verified, so such a group could be split into names you did not intend. Only read when `VAULT_PROXY_SECRET` is set. |
| `VAULT_ADMIN_GROUPS` | unset | Comma-separated group names (exact match), for example `lokyy-admins,vault-firma-admin`. In guarded mode only members may change server configuration. **Unset or empty = nobody may** (fail closed). |

The web server refuses to start if `VAULT_IDENTITY_HEADER` or `VAULT_GROUPS_HEADER` names a header the client controls or the server uses for something else (`x-mindbase-user`, `x-vault-proxy-secret`, `authorization`, `cookie`, `host`, `content-type`, `content-length`, `origin`, `referer`, `user-agent`), or if both variables name the same header.

**Both trusted headers must be listed in Traefik's `authResponseHeaders`** (for example `X-authentik-username` and `X-authentik-groups`). Traefik then overwrites whatever the client sent. A header that is missing from the list is passed through from the client unchanged and can be forged.

### Configuration changes (admin groups)

In guarded mode, these requests need membership in a `VAULT_ADMIN_GROUPS` group, otherwise they get `403 Forbidden`:

- every non-GET request under `/api/config` (`PUT /api/config`, `POST /api/config/test`)
- every non-GET request under `/api/server` (`PUT /api/server/data-dir`)
- `/api/google/auth/url`, `/api/google/auth/start`, `/api/google/auth/callback`, `/api/google/auth/disconnect` and `/api/google/set-sync-folder`, for any method

`GET /api/config` stays open to every signed-in user and returns the masked view. Without the guard, nothing changes.

### API key masking

`GET /api/config` never returns stored secrets. `apiKey`, `braveApiKey` and `dailyBrief.smtp.pass` come back as `********` when set (empty when not), `hasApiKey` reports whether an LLM key is stored, and `googleTokens` is left out. In `baseUrl`, a user name, a password and the values of query parameters whose name contains `key`, `token`, `secret`, `pass`, `auth`, `sig` or `credential` are replaced by `********`.

`PUT /api/config` merges the request onto the stored configuration, so a partial request does not remove other settings. The sections `dailyBrief`, `rss` and `srs` are merged field by field. `googleTokens` in the request is ignored; only the Google OAuth callback sets them. A stored secret is kept when the request sends `********` or leaves the field out, and replaced when the request sends any other value (an empty string clears it). A masked `baseUrl` sent back unchanged keeps the stored `baseUrl`.

**Re-entering the key when the destination changes:** the stored LLM key is kept only if `provider` and `baseUrl` stay the same (surrounding spaces and trailing `/` do not count as a change). If either changes and the request does not contain a new key, `PUT /api/config` answers `400 Re-enter the API key when changing provider or endpoint` and saves nothing. The SMTP password follows the same rule when `dailyBrief.smtp.host`, `port` or `secure` changes. A non-object value (for example `null`) for `dailyBrief`, `rss` or `srs` is ignored and the stored section is kept. `POST /api/config/test` calls the stored `baseUrl` when it receives the masked form of it. `POST /api/config/test` uses the stored key for `********` only for the stored provider and `baseUrl`; otherwise it answers the same `400` without contacting the endpoint. This stops a user from sending the stored key to a server of their choice.

`POST /api/config/test` returns only `Connection test failed` when the test fails; the upstream error text is written to the server log.

**Keyless providers:** if the new `provider` is `ollama` (which uses no API key) and the request contains no new key, the stored LLM key is cleared instead of answering `400`. The key is not needed there, and keeping it would let the semantic search send it to the new `baseUrl`. The chat model picker sends only `{provider, model}`. Switching back to a cloud provider requires entering the key again.

A key whose literal value is `********` cannot be saved, because it is indistinguishable from the mask (accepted limitation). Any other new secret that contains `********` (for example `********abc`, typed into the masked field) gets `400`. The settings dialog clears a masked key when you change provider or `baseUrl`, and removes the mask when you type into the field. The web UI shows the server's `error` text for failed saves and connection tests (for example `Forbidden (403)`).

`GET /api/health` no longer returns the data directory.

### Google Drive connect (OAuth)

In guarded mode, `/api/google/auth/url`, `/api/google/auth/start` and `/api/google/auth/callback` require a `VAULT_ADMIN_GROUPS` member (otherwise `403`). Without an identity header, `auth/url` and `auth/start` answer `401`; `auth/callback` answers `400 Invalid OAuth state`. If `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are not set, `auth/url` and `auth/start` answer `503` with a generic message before any state or cookie is created.

`/api/google/auth/start` and `/api/google/auth/url` create a random, single-use `state` (256 bit) and a PKCE `code_verifier` with an S256 `code_challenge`. Each state is bound to whoever started the flow: the proxy identity (guarded mode) and a random browser nonce in the cookie `mindbase_oauth` (`HttpOnly`, `SameSite=Lax`, path `/api/google/auth`, 10 minutes, `Secure` in guarded mode). Pending states are kept in server memory for 10 minutes, at most 3 per identity (or per browser locally) and 100 in total; the oldest are dropped. `/api/google/auth/callback` answers `400 Invalid OAuth state` and does not exchange the code when the `state` is missing, unknown, expired or already used, or when the identity or cookie differs from the one that started the flow. A mismatched attempt also invalidates the state. So a callback URL passed to another user, including another admin, is useless. This blocks login CSRF, where an attacker's authorization code would link the vault to the attacker's Drive. A server restart invalidates pending logins; start the connection again.

## Capture disabled

| Variable | Default | Effect |
|---|---|---|
| `MINDBASE_DISABLE_CAPTURE` | unset | `1`, `true` or `yes` turns off capture and device pairing: `/api/capture` and `/api/devices` (including `pair-code` and `pair`) return `404`, the background capture worker does not start, and mDNS advertising stays off regardless of `MINDBASE_MDNS`. `GET /api/health` reports `features.capture: false`, and the web UI's Devices page shows a "disabled" notice instead of the pairing QR code. |

`/api/inbox` stays available because RSS feeds write into the inbox. With capture disabled, queued inbox entries (including RSS items) are no longer compiled automatically; use the Compile button in the inbox.

## Known limitations and residual risks

The items below are **limitations, not features**. They came out of the security audits of LBV2-7, LBV2-10, LBV2-11, and LBV2-12, and they are tracked. Decide whether they are acceptable for your deployment.

| # | Limitation | Affects | Details |
|---|---|---|---|
| 1 | Search ordering may depend on hidden pages | readonly | The underlying search index also contains hidden pages. Readers get the filtered hits with rank-only scores, but the order of visible hits can still be influenced by term statistics that include hidden pages. |
| 2 | Meta is re-read on every reader request | readonly, performance | Before each tool call or resource request, the server lists `wiki/notes` and `wiki/concepts` and reads every page's meta file. The cost grows with the number of pages. |
| 3 | Stale body-link edges until reindex | readonly | The graph comes from the SQLite index. Body wikilink edges reflect page bodies as of the last reindex, so a removed link can keep appearing (as a broken link) until the index is rebuilt. |
| 4 | Outbound fetches still reach the public internet | full token only | Since LBV2-13, URL fetches refuse private, loopback, link-local and reserved targets (see [Outbound URL fetches](#outbound-url-fetches-ssrf-protection)). A full-token client can still make the container request arbitrary **public** hosts. Restrict egress on the container network if that matters. The check is off when `MINDBASE_ALLOW_PRIVATE_FETCH=1`. Internal services reachable under a public address (for example through NAT hairpinning) are not detected. |
| 5 | Public page content goes to the LLM provider | readonly (`ask_wiki`) | Readers can have any public root-wiki page sent to the configured provider, and the question text is sent as typed. The rate limit bounds cost, not data flow; it is per process and resets on restart. Answers are untrusted output: visible pages may carry prompt injection aimed at the reader's own agent. See [Reader LLM access](#reader-llm-access-ask_wiki). (The former item 5, `context_pages`/`raw_id` bypassing the slug check, was fixed in LBV2-18.) |
| 6 | Upstream server e2e tests are broken | development | The `apps/server/test/*-e2e.test.ts` suites failed before the LBV2 changes as well (commit `b78f97c`). They do not currently give regression signal. |
| 7 | Upstream typecheck error | development | `pnpm -F mindbase-mcp typecheck` reports an error in `apps/mcp/src/tools/get-pulse.ts` (line 94). It is inherited from upstream and does not affect the build (`tsup`). |
| 8 | Web UI / HTTP API on port 4321 has no user authentication | all deployments | Protection is the reverse proxy plus the proxy shared secret. Anyone holding the secret and reaching the port has full access; isolation still depends on the network. See the warning at the top. |

## Testing

The MCP tests are plain Node.js scripts in `apps/mcp/test/`. They run against the built `dist/`, create temporary fixture vaults, and print one `OK:` or `FAIL` line per check. A script exits non-zero if any check fails.

### Running the tests in Docker (Node 20)

This runs the tests without touching your checkout. The repository is mounted read-only and copied inside the container:

```bash
# from the repository root
docker run --rm -v "$PWD":/repo:ro node:20-bookworm bash -c '
  set -e
  mkdir /src && cd /repo
  tar --exclude=./node_modules --exclude="*/node_modules" --exclude="*/dist" --exclude=./.git -cf - . | tar -xf - -C /src
  cd /src && corepack enable
  CI=1 pnpm install --frozen-lockfile
  pnpm -F @mindbase/core build
  pnpm -F mindbase-mcp build
  cd apps/mcp && pnpm test'
```

`pnpm test` runs the scripts below in sequence and stops at the first failing script. To run a single script, run `node test/<name>.mjs` from `apps/mcp/` after building.

### What each script covers

| Script | Transport | Covers |
|---|---|---|
| `full-smoke.mjs` | stdio | Tool surface (required tools present), resources, prompts. |
| `tools-call.mjs` | stdio | `tools/call` round trip on a fixture wiki: `search_wiki`, `list_review_cards`, `get_graph_insights`. |
| `http-transport.mjs` | HTTP | Startup refuses a missing or short token and invalid integer variables. Also: `401` for a missing or wrong token and for a token in the query string, `404` for an unknown path or unknown session, `403` for a foreign Host, `413` for an oversized body, a tool round trip, concurrent sessions, LRU eviction at the cap, idle expiry. |
| `http-readonly.mjs` | HTTP | Read-only startup validation (identical or short token), `tools/list` equals the allowlist, every non-allowlisted tool and unknown tools rejected, data directory unchanged after write attempts, chat resources hidden, session-to-token binding (`403` in both directions). |
| `path-traversal.mjs` | HTTP | Traversal slugs in `read_wiki_page`, wiki resources, and `export_subgraph`, plus traversal `projectId`s and contributor usernames, do not leak a canary from outside the vault or from `mindbase.config.json`. Also: local paths in `mindbase_ingest_file` rejected over HTTP, and errors without absolute paths. |
| `ssrf.mjs` | HTTP | `mindbase_ingest_file` (direct, redirect chain, `localhost`, IPv4-mapped IPv6, metadata address) and `add_rss_feed` cannot reach a service on loopback, the service receives no request, and every error is the generic `URL not allowed or unreachable` (also for refused ports, HTTP 404 and unresolvable names); with `MINDBASE_ALLOW_PRIVATE_FETCH=1` the redirect chain works. Address classification, per-hop redirect checks, DNS answers with private addresses, pinning, https downgrade, userinfo stripping, concurrency, size and timeout limits are unit-tested in `packages/core/src/net/safe-fetch.test.ts`. |
| `ingest-local-stdio.mjs` | stdio | `mindbase_ingest_file` still accepts local paths over stdio, and its errors do not echo the path. |
| `http-readonly-visibility.mjs` | HTTP | `internal`, `pii`, and broken-meta pages invisible to readers in every allowlisted tool and resource, hidden pages failing like missing pages, project, source, and raw data invisible, full sessions unchanged, per-profile session caps, allowlist immutability, reader instructions and prompts. |
| `http-readonly-graph-leaks.mjs` | HTTP | LLM-inferred links to hidden or missing pages never reveal the target slug, community ids never exposed, central unsafe-slug rejection with one generic error while legitimate slugs keep working. |
| `http-readonly-ask-wiki.mjs` | HTTP | Reader `ask_wiki` against a local mock of the Ollama chat API (provider `ollama`, `baseUrl` on `127.0.0.1`, no test-only server code): no canary from hidden, project, concept, raw, or chat data in any prompt even when `context_pages` names hidden pages, no hidden slug or provider error detail in the response, no LLM call when only hidden pages match, data directory unchanged, per-session and per-token rate limits without LLM calls, 100 failing calls consuming no budget, full sessions unlimited, invalid rate-limit variables refused at startup, `context_pages`/`raw_id` slug check, question and `context_pages` caps, deterministic prompt truncation, concept-layer pages as context, generic unexpected-failure error. |

`smoke.mjs` (stdio tool listing) is a minimal check that `pnpm test` does not run.
