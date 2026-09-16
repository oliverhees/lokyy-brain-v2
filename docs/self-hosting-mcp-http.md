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

docker network create vaults   # internal network shared with the aggregator

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

## Configuration

### MCP HTTP transport (`apps/mcp/src/http.ts`)

The server validates every integer variable at startup. A value that is not an integer, or is below the minimum, makes the process exit with code 1. The server never silently falls back to the default. An unset or empty variable uses the default.

| Variable | Default | Validation | Effect |
|---|---|---|---|
| `MCP_HTTP_TOKEN` | none (required) | at least 32 characters, otherwise the process exits 1 | Token for the **full** access profile. Clients send `Authorization: Bearer <token>`. |
| `MCP_HTTP_READONLY_TOKEN` | unset (no read-only profile) | if set: at least 32 characters and different from `MCP_HTTP_TOKEN`, otherwise the process exits 1 | Token for the **read-only** access profile (see [Access profiles](#access-profiles)). |
| `MCP_HTTP_PORT` | `4322` when `http.js` runs directly | integer, at least 1 | Listen port. In the container, the MCP server only starts if this variable is set. |
| `MCP_HTTP_HOST` | `0.0.0.0` | none | Listen address. Keep `0.0.0.0` inside a container so the aggregator can reach it over the container network. |
| `MCP_HTTP_MAX_SESSIONS` | `32` | integer, at least 1 | Maximum number of concurrent full-profile sessions. |
| `MCP_HTTP_MAX_READONLY_SESSIONS` | value of `MCP_HTTP_MAX_SESSIONS` | integer, at least 1 | Separate maximum for read-only sessions. The two profiles never evict each other's sessions. |
| `MCP_HTTP_SESSION_IDLE_MS` | `1800000` (30 min) | integer, at least 1000 | Sessions idle longer than this are closed. |
| `MCP_HTTP_ALLOWED_HOSTS` | unset (no Host check) | comma-separated, trimmed, case-insensitive | If set, requests whose `Host` header is not in the list get `403`. The list is compared against the full header value, including the port (for example `vault-acme:4322`). |

### Container and web server

| Variable | Default in image | Effect |
|---|---|---|
| `MINDBASE_DATA_DIR` | `/data` | Vault data directory, used by both the web server and the MCP server. Without it, both fall back to `~/mindbase-data`. |
| `PORT` | `4321` | Web server port. The healthcheck assumes `4321`. |
| `MINDBASE_MDNS` | `off` | Any value other than `off` makes the web server advertise itself via mDNS (`_mindbase._tcp`). Keep `off` in containers. |
| `NODE_ENV` | `production` | Standard Node.js setting. |
| `VAULT_PROXY_SECRET` | unset — **required** in the image | At least 32 characters, otherwise the web server exits. Every web request must carry header `X-Vault-Proxy-Secret` with this value (constant-time compare), otherwise `403`; the header is stripped before handlers. Not passed to the MCP process. The healthcheck sends it via stdin. Generate with `openssl rand -hex 32`, one per vault. |
| `VAULT_REQUIRE_PROXY_SECRET` | `1` | When set (any non-empty value), a missing or empty `VAULT_PROXY_SECRET` aborts web server startup instead of disabling the guard. An empty value turns the requirement off. |

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
| readonly | `MCP_HTTP_READONLY_TOKEN` | the 12 allowlisted tools below | only the reader view (see [Visibility](#visibility-read-only-sessions)) |

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

For read-only sessions:

- `tools/list` returns only these tools.
- `tools/call` for any other name, including names that do not exist, is rejected with `Tool not available: <name>` ("This session has read-only access."). The check runs before the handler lookup, so a reader cannot tell a hidden tool from a nonexistent one.
- Chat resources (`mindbase://chats/*`) are not listed and cannot be read.
- Only prompts whose tools are all on the allowlist are offered: `daily-digest`, `brainstorm`, `connect`, `explain`, `quiz`. A prompt with no entry in the prompt-to-tool map is offered to full sessions only.
- The server sends reader-specific instructions that name only allowlisted tools.

### What readers cannot do, and why

The review rule for the allowlist, from `access.ts`: no persistent writes to the data directory, no outbound network or URL fetching, no LLM or embedding API calls.

| Excluded | Examples | Reason |
|---|---|---|
| Writes | `create_note`, `append_to_page`, `set_visibility`, `mindbase_contribute`, … | they change the vault |
| URL fetching | `mindbase_ingest_file` (URL mode), `add_rss_feed` | outbound network access, and they write |
| LLM and embedding calls | `ask_wiki`, `semantic_search`, `synthesize_topic`, `find_contradictions`, `find_gaps`, `get_pulse`, `generate_daily_brief` | they call the LLM or embedding API or write shared caches |
| Chats | `list_chats`, `recall_chat` | they expose other users' chat history |
| Project wikis and status tools | `mindbase_status`, `mindbase_gather_sources`, `mindbase_validate_structure` | they read the data directory directly with `node:fs`, bypassing the reader view, and expose file names, modification times, and absolute project paths |

The reader context has no LLM adapter: `getAdapter()` throws. All store write methods and `reindex` reject with `read-only session`.

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
- **Configuration and paths are withheld.** The reader context does not contain `dataDir` (an absolute path), `config` (API key), the synthesis cache, or templates.

## Security behaviour

### Authentication and request handling

The server checks each request in this order:

1. **Token.**
   - Only the `Authorization: Bearer <token>` header is accepted. A token in the query string gets `401`.
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
  - The tool dispatcher checks the arguments `slug`, `slugs`, `source_slug`, `target_slug`, and `root`, for every tool and both profiles.
  - It rejects a `.` or `..` path segment, a backslash, a NUL byte, or a leading `/`, all with the same error: `Invalid input: unsafe slug`.
  - Because the check matches argument names, tools added later that use these names are covered too.
  - `mindbase://wiki/<slug>` resources apply the same check.
- **Path containment.** `FileStore` resolves every store path relative to the data directory. It refuses any path that would leave the directory (`Path is outside the store root`).
- **Local file paths are disabled over HTTP.** The HTTP transport sets `allowLocalFilePaths: false`, so `mindbase_ingest_file` rejects local paths ("Local file paths are not accepted on this server"). Local paths still work over stdio. See also the SSRF limitation below.

### Container

- **Process supervision.** `deploy/entrypoint.sh` starts the web server and, if `MCP_HTTP_PORT` is set, the MCP server.
  - If either process exits, even with code 0, the other is stopped with `SIGTERM` and the container exits with a non-zero code. `on-failure` restart policies therefore apply.
  - `SIGTERM` and `SIGINT` sent to the container are forwarded to both processes (exit code 143), so in-flight writes can finish.
- **Healthcheck.** Every 30 s (timeout 5 s, start period 60 s, 3 retries):
  - `GET http://127.0.0.1:4321/` must succeed.
  - If `MCP_HTTP_PORT` is set, `POST http://127.0.0.1:$MCP_HTTP_PORT/mcp` without a token must return `401`. That shows the MCP process is alive and authentication is on.

## Identity and attribution

Contributor files and quick-capture entries are attributed to a username that becomes a directory under `sources/contributors/`.

When the proxy guard is active (`VAULT_PROXY_SECRET` set), attribution comes only from the identity header that the reverse proxy sets. The header name is `VAULT_IDENTITY_HEADER` (default `x-authentik-username`, compared case-insensitively). A client-sent `X-Mindbase-User` header is ignored in this mode. Configure Traefik's forward-auth middleware with `authResponseHeaders: X-authentik-username` so the proxy overwrites any value the client sends. If the header is missing, writes are attributed to the fixed user `unknown` and the server logs one warning. A value that is not a valid username (letters, digits, `_`, `-`, `.`; no `@`, spaces, or `..`) gets `400 Invalid identity header`. Authentik usernames that are e-mail addresses therefore need a username without `@`.

Without the guard (local, single-user), `X-Mindbase-User` is used as before. If it is absent, the OS username is mapped to a valid name: invalid characters become `_`, leading `.`/`-` are removed, `..` is collapsed, and the result is cut to 64 characters (`oliver@corp` → `oliver_corp`). An invalid explicit header still gets `400`.

| Variable | Default | Effect |
|---|---|---|
| `VAULT_IDENTITY_HEADER` | `x-authentik-username` | Name of the proxy-set identity header. Only read when `VAULT_PROXY_SECRET` is set. |

### API key masking

`GET /api/config` never returns stored secrets. `apiKey`, `braveApiKey` and `dailyBrief.smtp.pass` come back as `********` when set (empty when not), `hasApiKey` reports whether an LLM key is stored, and `googleTokens` is left out. `PUT /api/config` keeps a stored secret when the request sends `********` or leaves the field out, and replaces it when the request sends any other value (an empty string clears it). `POST /api/config/test` uses the stored key when it receives `********`.

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
| 4 | SSRF in `mindbase_ingest_file` URL mode | full token only | An `http(s)` URL is fetched server-side with redirects followed and no restriction on the target host, so a full-token client can make the container request internal addresses. Tracked as LBV2-13. The tool is not available to read-only sessions. |
| 5 | `ask_wiki.context_pages` and `ingest_plan.raw_id` bypass the central slug check | full token only | These argument names are not in `SLUG_ARGUMENT_NAMES`. `FileStore` containment still keeps reads inside the data directory. Neither tool is available to read-only sessions. |
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
| `ingest-local-stdio.mjs` | stdio | `mindbase_ingest_file` still accepts local paths over stdio, and its errors do not echo the path. |
| `http-readonly-visibility.mjs` | HTTP | `internal`, `pii`, and broken-meta pages invisible to readers in every allowlisted tool and resource, hidden pages failing like missing pages, project, source, and raw data invisible, full sessions unchanged, per-profile session caps, allowlist immutability, reader instructions and prompts. |
| `http-readonly-graph-leaks.mjs` | HTTP | LLM-inferred links to hidden or missing pages never reveal the target slug, community ids never exposed, central unsafe-slug rejection with one generic error while legitimate slugs keep working. |

`smoke.mjs` (stdio tool listing) is a minimal check that `pnpm test` does not run.
