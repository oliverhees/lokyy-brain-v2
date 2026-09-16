# Changelog

## Unreleased — Lokyy Brain v2 fork

### Added
- MCP over Streamable HTTP (`apps/mcp/dist/http.js`) with bearer token, session limits and Host allow-list; optional read-only token profile with a fail-closed allowlist of 13 tools and a reader view that hides `internal`/`pii` pages. See `docs/self-hosting-mcp-http.md`.
- Readers may use `ask_wiki` (LBV2-18): retrieval runs only through the reader view, so only visible root-wiki pages are sent to the configured LLM provider; provider errors are generic; nothing is written. Only provider requests count against the rate limit: calls that never reach the provider (invalid input, unsafe slug, no visible page) are free; requests the provider answers with an error (e.g. HTTP 500) consume budget. Rate limited per read-only session (`MCP_HTTP_READONLY_LLM_RATE`, default 20) and for all read-only sessions together (`MCP_HTTP_READONLY_LLM_RATE_TOTAL`, default 60) per `MCP_HTTP_READONLY_LLM_WINDOW_MS` (default 10 min).
- Source-built vault Docker image (`deploy/Dockerfile`).
- Slim vault image (LBV2-6): multi-stage build with production-only dependencies and a compiled web server (`deploy/build-server.mjs`, no `tsx` at runtime). Image disk usage 1.82 GB -> 800 MB. Embedding models are cached in `/models` (mount a volume to keep them); `MINDBASE_PLUGIN_ROOT` is set in the image. See `docs/self-hosting-mcp-http.md#image-contents-and-size`.
- Web server proxy shared-secret guard (`VAULT_PROXY_SECRET`, header `X-Vault-Proxy-Secret`); required by the Docker image (`VAULT_REQUIRE_PROXY_SECRET=1`). Unset outside the image = previous behaviour.

- Trusted user attribution behind the proxy: with `VAULT_PROXY_SECRET` set, the contributor username comes only from the proxy identity header (`VAULT_IDENTITY_HEADER`, default `x-authentik-username`); a client `X-Mindbase-User` is ignored; a missing identity answers 401 on attributed routes; the name `unknown` is reserved.
- Admin groups for configuration changes in guarded mode: `VAULT_ADMIN_GROUPS` (fail closed when unset) matched against `VAULT_GROUPS_HEADER` (default `x-authentik-groups`, split on `|` only; a duplicated header grants no groups). Applies to non-GET `/api/config` and `/api/server` and to the Google routes `auth/url`, `auth/start`, `auth/callback`, `auth/disconnect` and `set-sync-folder`. Startup is refused if a trusted header is set to a client-controlled or reserved name.
- `MINDBASE_DISABLE_CAPTURE=1`: `/api/capture` and `/api/devices` return 404, the capture worker and mDNS do not start, `/api/health` reports `features.capture`, and the Devices page shows a disabled notice.

### Changed — may affect existing (stdio / single-user) setups
- **Slugs are validated for every MCP tool** (`slug`, `slugs`, `source_slug`, `target_slug`, `root`, and since LBV2-18 `context_pages`, `raw_id`): a leading `/`, backslash, NUL, or a `.`/`..` path segment is rejected with `Invalid input: unsafe slug`. Previously e.g. `read_wiki_page {slug: "/flip"}` resolved to the page.
- **Project ids** must be directory names (`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`), also `currentProjectId` in `config.json`.
- **File store paths** that would leave the data directory are refused; leading slashes stay relative to the data directory.
- **Web API**: `POST /api/tree/research` accepts only plain slugs (`[a-z0-9-]`); an invalid `X-Mindbase-User` header returns 400; contributor usernames must be letters, digits, `_`, `-`, `.` (an OS username with `@` or spaces now fails for quick capture / contributor files); trash restore/delete reject ids not in the generated format and error messages no longer include ids or paths.
- `mindbase_ingest_file` no longer accepts local file paths over the HTTP transport (stdio unchanged).
- **SSRF protection for URL fetches** (LBV2-13): `mindbase_ingest_file` (URL mode), `add_rss_feed`, `POST /api/feeds`, `POST /api/ingest/text` with a URL, capture article extraction, the RSS worker and research web-search pages refuse targets that resolve to private, loopback, link-local (incl. `169.254.169.254`), CGNAT, ULA or reserved addresses, re-check every redirect (max 5), pin the connection to the checked address, and enforce timeout and size limits. **Ingesting from `localhost` or the LAN now fails** unless `MINDBASE_ALLOW_PRIVATE_FETCH=1` is set. IPv6 targets outside `2000::/3` are refused, https → http redirects are refused, at most `MINDBASE_FETCH_CONCURRENCY` (default 4) fetches run at once, URL downloads for ingest are limited to 20 MB (was 50 MB), and every fetch failure is reported to clients as `URL not allowed or unreachable` (details only in the server log, also for a feed's `last_error`).
- MCP HTTP accepts the `Authorization` scheme case-insensitively (`bearer <token>`).
- The web server refuses to start when `VAULT_PROXY_SECRET` has leading or trailing whitespace (or is only whitespace).
- Claude Code plugin manifest license now points to `NOTICE.md` (mixed MIT / PolyForm Noncommercial); the plugin README notes that it runs the upstream `mindbase-mcp` npm package without the fork's changes.
- **`ask_wiki` for all profiles (LBV2-18):**
  - `pages_read` now means "pages actually read and sent as context". Full clients previously also got candidate slugs that could not be read (missing pages, graph neighbours).
  - `question` is limited to 2000 characters and `context_pages` to 20 entries (`Invalid input` otherwise); page bodies are cut at 8000 characters and the context block at 40000 characters.
  - Slugs are also looked up in `wiki/concepts` (previously only `wiki/notes`, so concept pages were never used as context).
  - Unexpected failures return `ask_wiki failed` without detail; the detail goes to the server log.

- **`GET /api/config` masks secrets**: `apiKey`, `braveApiKey` and `dailyBrief.smtp.pass` are returned as `********` (plus `hasApiKey`), `googleTokens` is omitted. `PUT /api/config` keeps a stored secret when it receives the mask or no value. Scripts that read the key from this endpoint no longer get it. Credentials in `baseUrl` are masked too.
- **Changing provider or `baseUrl` (or the SMTP host) requires re-entering the key**: otherwise `PUT /api/config` and `POST /api/config/test` answer 400, so a kept key can no longer be sent to a new endpoint.
- **`PUT /api/config` merges** onto the stored config instead of replacing it (partial saves no longer drop `dailyBrief`, `rss`, `srs`, Google sync settings); client-sent `googleTokens` are ignored.
- **Google Drive OAuth** uses a single-use `state` and PKCE (S256), bound to the initiating identity and an HttpOnly browser cookie; a callback without a matching `state` answers 400. In guarded mode every auth step (url, start, callback) is admin-only. At most 3 pending states per identity.
- The SMTP password is kept only while SMTP host, port and `secure` are unchanged; non-object `dailyBrief`/`rss`/`srs` values in `PUT /api/config` are ignored.
- **Switching to a keyless provider (Ollama) without a key clears the stored cloud API key** (the chat model switch now sends only `provider` and `model`); enter the cloud key again when switching back. A new secret that contains `********` is rejected with 400. The web UI shows the server's error message for failed saves and connection tests.
- `POST /api/config/test` returns a generic error message (details in the server log); `GET /api/health` no longer returns `dataDir`.
- **OS username fallback is sanitized**: an OS account like `oliver@corp` is attributed as `oliver_corp` instead of failing with 500.

### Licensing
- Fork modifications after `7aa8fcd` are licensed under PolyForm Noncommercial 1.0.0; upstream code remains MIT. See `NOTICE.md`.


## 0.4.5 (2026-09-13)

### Added — wiki integrity (ideas from the Karpathy LLM-wiki thread)

- **Sources vs wiki in answers** — retrieval indexes your own notes,
  daily files and raw imports as a `source` layer alongside AI-written
  pages; answers prefer your material, and each citation is tagged
  `source` / `wiki` so you can see what is yours vs derived.
- **`[@path]` citations** — every research page and context bullet the
  maintainer writes points back at the source file it came from, added
  deterministically even when the model forgets. Rendered as clickable
  chips in notes and on the wiki home. Lint gains `unsourced page` and
  `uncited source` findings, computed in code rather than by the model.
- **Evidence-checked lint** — contradiction / stale findings must carry
  verbatim quotes; the server verifies each quote against the page and
  drops findings that don't hold up (`dropped=N` in the log). Cards show
  `✓ verified` per quote.
- **Free-text contribute lands in your layer first** — `/contribute`
  text is appended to `sources/contributors/<you>/<date>.md` before the
  wiki is touched, so it is citable and never lost; re-submitting the
  same text is a no-op. Notes cite their own path.
- **Duplicate-page guard** — a plan cannot create a research page that
  already exists (case/separator-insensitive) or that another pending
  plan is about to create; the approval card says what was skipped.
- **State rule** in build / contribute / research prompts: document the
  shape of things, never live values (SHAs, counts, "last synced").

## 0.4.3 (2026-08-19)

### Added

- **`npx mindbase-app`** — the web UI's first distribution channel: one
  command starts the bundled server + web app and opens your browser
  (previously clone + pnpm only). 2.8MB tarball; `--port`, `--no-open`.
- **Website** — https://frankchu91.github.io/mindbase-llm-wiki/ with live
  demo clips, deployed from `website/` via GitHub Pages.
- Muse Glimmer recommended on 32GB+ Apple Silicon; quick model switcher
  on the composer badge; thinking-model reasoning streamed live in chat.

## 0.4.0 (2026-08-07)

### Added — write full notes in the UI

- **Cmd+N (or "+" → New note)** creates a real note and opens it in the
  full WYSIWYG editor — headings, GFM, markdown links, `[[wikilink]]`
  autocomplete, outline, backlinks. Previously every "new note" path
  dead-ended in the quick-capture textarea.
- Notes live in **your** layer (`sources/contributors/<user>/notes/`),
  so the AI never rewrites them — it digests them into the wiki on
  Rebuild, or on demand. The first title you type becomes the filename.
- **Wiki-status chip** replaces the old "Process" button: a note newer
  than the last build shows **✨ Add to wiki**; while the AI works it
  shows **Adding…**; after your approval it flips to **✓ In wiki · N
  pages**. Editing the note lights the chip up again. The status reuses
  the build pipeline's own newer-than-context rule — no separate state
  to drift.
- `Cmd+I` quick capture is unchanged: log a line in 3 seconds vs sit
  down and write — two different verbs, now two different surfaces.

### Fixed

- WYSIWYG body edits silently saved a copy of every note into the
  LLM-owned `sources/research/` layer (hardcoded legacy path) — user
  content no longer leaks across the layer boundary.
- Renaming a contributor file doubled the user segment in the path and
  the failed rename crashed the server process.
- The file tree didn't refresh after renames/creates from outside it.

## 0.3.0 (2026-08-06)

### Added — Web UI runs the core operations

The Web UI now has the same core functionality as the MCP/plugin path,
orchestrated server-side with whatever LLM you configure (cloud or the
free local model):

- **`/contribute` in the chat composer** — type `/` for a command menu.
  The AI reads your thought, streams takeaways plus a plan of wiki
  updates; each update is a checkbox row and only approved actions are
  written. Plans are held for 10 minutes.
- **`/build` + a real Rebuild button** — regenerates `context.md` from
  unbuilt sources. Snapshots the old context first
  (`state/builder/snapshots/`), enforces a per-project lock, refreshes
  the page when done.
- **✨ Process on any note** — sends the note body through the same
  contribute approval flow.
- **`/api/ops/{contribute,build}`** — SSE endpoints backing all of the
  above. One constrained JSON completion per operation (no multi-step
  tool loops — far more reliable on small local models). The action
  vocabulary is schema-limited: no action can write `sources/`
  (contributors or raw), mirroring the plugin sub-agents' tool
  allowlists.
- **`/lint` + a rebuilt Wiki Health view** — the AI reads your wiki and
  surfaces contradictions, orphan pages, stale claims, missing pages,
  missing links, and gaps as cards. Per-card: open the cited pages,
  Dismiss (persists), or Follow up (files into today's contributor
  note). Findings cached to `artifacts/lint/<date>.json`.
- **`/research <topic>`** — synthesizes a cited research page from your
  wiki; add a Brave Search API key (Settings → Web Search) and it pulls
  live web results in too. No key → clearly labeled wiki-only mode.
- Every operation appends to `logs/<date>.md` in the same format the
  plugin uses, so editor sessions and UI sessions share one history.

### Fixed — ask on v2 projects

- v2 projects had an **empty search index** (only v1 `wiki/` paths were
  indexed), so chat answers cited nothing. `sources/research/` and
  `context.md` are now indexed at boot and after every operation.
- Ask's auto-save filed answers into the v1 `wiki/notes/` tree; on v2 it
  now creates a proper research page and logs the query.

## 0.2.0 (2026-08-06)

### Added — free local model onboarding

- Setup wizard can configure MindBase with **no subscription and no API
  key**: detects your hardware (RAM/CPU/platform), recommends the best
  Ollama model that fits (`llama3.2:3b` < 12GB → `qwen3:8b` < 24GB →
  `qwen3:14b` ≥ 24GB, `qwen3:30b-a3b` advanced), guides the Ollama
  install, pulls the model with live progress (`/api/ollama/pull` SSE
  proxy), and verifies with a real 1-token generation.
- `GET /api/system` (hardware report) and `GET /api/ollama/status`
  (3-state: not-installed / not-running / ready).

### Fixed

- Ollama: thinking-mode models (qwen3, deepseek-r1) returned 88s of
  blank output — thinking is now disabled for chat and verification
  (88.7s → 1.1s measured).
- Ollama verify no longer false-positives when the service runs but the
  model isn't pulled.
- Chat composer's first message was silently unsendable on empty
  conversations.
- Removed v1 classify/breadcrumb chrome from v2 note pages
  ("Reclassify failed: note not found").

## 0.1.3 (2026-07-24)

### Added

- **`mindbase_ingest_file`** — first-class file ingestion for every MCP
  client: takes a local path **or a direct URL** (e.g. an arXiv `/pdf/`
  link), downloads if remote, archives the original into
  `sources/raw/<date>/`, extracts text locally via pdfjs, writes an
  `.extracted.md` sidecar for PDFs, and returns the text for the
  contribute flow. 50MB cap; HTML URLs are rejected with guidance.
- Web UI: upload button on the Raw category row + empty-state upload row;
  `POST /api/tree/raw/upload`.
- `mindbase_init_project` result carries a one-time feedback note.

### Fixed

- `GET /api/tree/raw/:date/:id` returned utf-8 garbage for PDFs — now
  serves the extracted-text sidecar when present; raw listing hides
  sidecars.
- Project switcher menu painted underneath the sidebar (stacking
  context); now portaled to <body> and fully opaque.

## 0.1.2 (2026-07-21)

### Fixed

- **Zero-state first run**: on a fresh machine with no projects, every
  project-scoped tool (contribute, status, gather_sources, and 8 more) now
  returns an actionable instruction — create a project via
  `mindbase_init_project`, or pick from the listed existing ones — instead of
  `Invalid input: Required` or a dead-end pointer to `load_project`.
- `mindbase_init_project` writes `meta.json`, so plugin-created projects
  appear in the web UI's project list immediately.
- Server no longer resurrects a broken v1 "Default project" on boot when
  empty legacy dirs are present or v2 projects already exist.

### Added

- `mcpName` ownership field + `server.json` for publishing to the official
  MCP Registry (registry.modelcontextprotocol.io).

## 0.1.0 (2026-07-11)

First public release. MindBase is an AI research assistant that builds and
maintains a markdown wiki from your sources — Karpathy's LLM-Wiki pattern as
a product. Ships as an MCP server (works in Claude Code, Cursor, Windsurf,
Cline, Continue.dev, and any MCP-compatible client) plus an optional web UI.

### Added

- **Multi-IDE support verified** — MCP server tested end-to-end in Claude Code
  (flagship: slash commands + sub-agents) and Cursor (natural-language tool
  calls). Same `~/mindbase-data/` disk shared across all clients.
- **`-p` / `--project` routing flag** on all slash commands (`/mb:contribute`,
  `/mb:build`, `/mb:status`, `/mb:ask`, `/mb:lint`, `/mb:daily-brief`,
  `/mb:research`, `/mb:export`) — target any project without switching the
  current one. `/mb:load` remains the single path that changes
  `currentProjectId`.
- **Self-contained plugin bundle** via `pnpm deploy` — plugin's MCP server
  ships with its own `node_modules`, boots on a clean machine with only Node 20.
- **Rewritten README** — install guides for 6 editors, feature matrix,
  troubleshooting, data-layout documentation.

### Fixed

- `mindbase_load_project` no longer silently switches the current project as a
  side-effect; persisting is opt-in (`persist: true`).
- Plugin `.mcp.json` pointed at the library entry (`index.js`) instead of the
  executable (`cli.js`) — MCP server never started in fresh installs.
- `mindbase_init_project` / `load` now persist `currentProjectId` to
  `config.json` so follow-up tool calls resolve the project automatically.
- Sub-agent tool allowlists referenced the old `mcp__mindbase__*` namespace;
  now `mcp__mb__*` (matches the plugin's server key).
- Web UI: stripped all v1 dead paths (QuickCaptureModal, DailyNoteHeader,
  TemplatesSettings, `/api/wiki/*` callers) — the first-minute 404 storm is
  gone. Net -648 lines.

## 0.1.0-beta (2026-06-09)

### Added — Plugin pivot

- **`apps/plugin/`** — new Claude Code plugin package bundling the MCP server, slash commands, sub-agents, hooks, and templates. Install via `claude --plugin-dir apps/plugin` or eventually `/plugin install mindbase@mindbase`.
- **Per-project v2 layout** (`packages/core/src/plugin-layout/`) — `README.md` + `context.md` + `index.yaml` + `sources/contributors/<user>/YYYY-MM-DD.md` + `state/` + `logs/` + `artifacts/`. Replaces legacy `wiki/notes`, `wiki/concepts`, `wiki/sources` for new projects.
- **Migration pipeline** (`packages/core/src/migrate/`) — atomic legacy → v2-layout converter with snapshot, transforms (schema→README, INDEX→context, notes→contributors, sources→research, log split), and recovery archive. Vitest covered.
- **12 new MCP tools** in `apps/mcp`:
  - `mindbase_init_project` / `mindbase_load_project` — scaffold + load
  - `mindbase_contribute` / `mindbase_validate_structure` / `mindbase_append_log` — write + check
  - `mindbase_gather_sources` / `mindbase_atomic_write_context` / `mindbase_rebuild_index` — build pipeline
  - `mindbase_status` — dashboard JSON
  - `mindbase_migrate` — legacy conversion
- **9 slash commands** (`apps/plugin/commands/`): `/mb:init`, `/mb:load`, `/mb:contribute`, `/mb:build`, `/mb:ask`, `/mb:lint`, `/mb:status`, `/mb:daily-brief`, `/mb:migrate`.
- **4 sub-agents** (`apps/plugin/agents/`): `builder`, `contributor`, `curator`, `migrator`. Tool-restricted per agent: builder/contributor/curator cannot Edit/Write/Bash; only MCP tools.
- **SessionStart hook** (`apps/plugin/hooks/session-start`) — auto-injects current project's README + context + index.yaml as `additionalContext` JSON on every Claude Code session start. Cross-platform (Claude Code / Cursor / Copilot CLI variants).
- **9 templates** (`apps/plugin/templates/`): `README.md.template`, `soul.md.template`, `context.md.template`, `empty.md.template`, plus 5 schema templates ported from `apps/skill/`.
- **`apps/server` v2-awareness helpers** (`context.ts`): `currentProjectIdFromConfig`, `projectRoot`, `detectLayoutVersion`.
- **`POST /api/compile/build`** — stub endpoint that tells the UI to invoke `/mb:build` in Claude Code (v0.1 doesn't host server-side LLM synthesis).
- **`apps/web/src/lib/wikiPaths.ts`** — TS mirror of core's `projectPaths` for the bundle.

### Changed

- `apps/mcp` search/ask tools (`search-wiki`, `ask-wiki`) now accept both v1 (`wiki/notes/`) and v2 (`projects/<id>/sources/...`) slug paths via dual-regex.
- `apps/server` compile/lint/projects routes now resolve `wiki/log.md`, `wiki/_insights.md` via the v1/v2 helper; `GET /api/projects/:id` surfaces `layoutVersion`, `lastBuild`, `contributorsCount`.

### Deferred (manual follow-up before UI works on migrated data)

- `apps/server/src/routes/wiki.ts` (1098 lines) — the `/api/wiki/*` read/write routes still serve v1 paths exclusively. After running `/mb:migrate` on a project, the UI's tree + page views will 404 against that project. Needs a targeted refactor (likely via a `WikiCategories` abstraction) to add v2 categories to the `/wiki?category=` API surface.
- `apps/web` LeftRail/TreeRoot — depends on the above. The tree's categories are fetched from `/api/wiki?category=`; without v2 server support there is no v2 data to render.
- `apps/web/src/components/{NotesView,WikiView}.tsx` — file names from the plan did not match the codebase. Actual components (`WikiHome.tsx`, etc.) were not refactored; same blockers apply.

### Removed

- `apps/skill/` — legacy skill-based install (`install.sh` + `~/.claude/skills/mindbase/` deploy) deleted. The `mindbase-synthesizer` weekly-summary sub-agent was not ported (read v1 `wiki/log.md`; the plugin's `curator` + `builder` cover the same surface area for v2). Users with the old install must manually remove `~/.claude/{skills/mindbase, commands/mb-*.md, agents/mindbase-synthesizer.md}`.

### Notes

- Pre-existing typecheck error in `apps/mcp/src/tools/get-pulse.ts(94,47)` was not touched; unrelated to the pivot.
- `apps/plugin/mcp-server/dist/` is gitignored; rebuild via `pnpm -F @mindbase/plugin build` after pulling.
