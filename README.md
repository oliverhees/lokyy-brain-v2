# Lokyy Brain V2

[![License: MIT + PolyForm NC](https://img.shields.io/badge/license-MIT%20%2B%20PolyForm%20NC-orange)](NOTICE.md)

**The knowledge base for a company: every employee gets a personal vault, the company shares one company vault, and an AI keeps both as a maintained wiki.** Claude and other MCP clients reach all of it through one connection per user. LLM calls go to EU-hosted models through EUrouter routes.

Lokyy Brain follows Andrej Karpathy's [LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): you add sources (notes, PDFs, web pages); the LLM reads them, cross-references them, flags contradictions and writes structured wiki pages. Knowledge accumulates instead of being re-derived from raw documents on every question.

**Status:** beta, one company server per customer (up to 15 users). What's new: [CHANGELOG](CHANGELOG.md).

<p align="center">
  <img alt="Lokyy Brain web UI — category tree on the left, the LLM-maintained context.md in the center, chat on the right" src="docs/assets/webui.png" width="920">
</p>

## Features

- **Personal vault per employee** — own wiki, own sources, own web UI; nobody else can open it.
- **Company vault** — shared knowledge with writers and readers; readers get a read-only view that hides pages marked `internal` or `pii`.
- **AI-maintained wiki** — ingest a source, review the takeaways and a checkbox plan, and only what you approve is written. `build` regenerates `context.md`, `lint` audits the wiki for contradictions, stale claims and orphans, `research` answers with cited sources.
- **Ask with citations** — answers from the wiki cite the pages and sources they come from.
- **Hybrid search** — full-text plus semantic search (BGE-M3 embeddings from one shared service per server).
- **MCP access with one connection** — each user gets one MetaMCP endpoint and one API key; behind it sit the personal vault and the company vault. Works with Claude Code, Claude Desktop, Cursor, Windsurf, Cline and other MCP clients.
- **EU LLM via EUrouter** — the LLM is configured by EUrouter route (routing rule), not by model; vaults only talk to `api.eurouter.ai`.
- **Setup portal** — German admin UI for the company: setup wizard (company, EUrouter key and route, optional SMTP), inviting employees, roles, disabling and removing users, audit log. Employees find their vault links, MCP URL, API key and ready-to-paste snippets under **Mein Zugang**.
- **Plain markdown on disk** — every vault is a directory of markdown files; no proprietary database.

## Architecture

One company server runs these services behind Traefik:

| Component | Role |
|---|---|
| **Vaults** (`apps/server`, `apps/web`, `apps/mcp`, `packages/core`) | One container per employee plus the company vault (`firma`). Web UI and API on port 4321, MCP over Streamable HTTP for MetaMCP only. Each vault sits on its own internal networks and cannot reach the others. |
| **Authentik** | Login and groups. Forward-auth protects every vault and the MetaMCP admin UI; group membership decides who may open, write or administer a vault. |
| **mcp-gate + MetaMCP** | MetaMCP gives each user one MCP endpoint (`https://mcp.<domain>/metamcp/<user>/mcp`) that aggregates their vaults. `mcp-gate` sits in front of it: API key only, sessions bound to key and endpoint, rate and session limits, uniform errors. MetaMCP reaches the vaults only through `vault-connector`, never the other way round. |
| **Embedding service** (`deploy/stack/embed`) | One BGE-M3 instance for all vaults; per-vault tokens and networks, request limits, fair queueing. |
| **Setup portal** (`apps/portal`) | Admin and self-service UI at `app.<domain>`, behind Authentik. Provisions Authentik users and MetaMCP accounts; holds no Authentik token itself. |
| **authentik-gate** (`deploy/stack/authentik-gate`) | The only holder of the least-privilege Authentik service token. Lets the portal manage only its own employees (never superusers or admins, allowlisted groups, no password endpoint). |

Details: [deploy/stack/README.md](deploy/stack/README.md) (reference stack), [docs/self-hosting-mcp-http.md](docs/self-hosting-mcp-http.md) (vault container, MCP over HTTP, access profiles, embedding service) and [docs/setup-portal.md](docs/setup-portal.md) (portal and authentik-gate).

## Deployment

- **Production (Coolify):** follow [docs/beta-runbook.md](docs/beta-runbook.md) — prerequisites, DNS, secrets, [Deploy in Coolify](docs/beta-runbook.md#5-deploy-plain-docker-compose-behind-coolify-proxy-default), network verification, users, MCP provisioning, EUrouter, smoke tests, backup and rollback. Template: `deploy/coolify/compose.yml`.
- **Local reference stack:** [deploy/stack/README.md](deploy/stack/README.md) — the full setup (Traefik, Authentik, three vaults, MetaMCP, embedding service) on `127.0.0.1:18080` with demo users and attack test suites.
- **Vault image:** `deploy/Dockerfile` builds the vault from source.

Connecting an AI client: take the MCP URL and API key from **Mein Zugang** in the setup portal, for example with Claude Code:

```bash
claude mcp add --scope user --transport http lokyy-brain https://mcp.<domain>/metamcp/<username>/mcp --header "Authorization: Bearer <api-key>"
```

## Security

The security model — forward-auth per vault, proxy secrets, per-vault networks, one-way MetaMCP access, the MCP gate, admin groups, LLM host allow-list, disabled capture — is documented in [deploy/stack/README.md → Security model](deploy/stack/README.md#security-model), with the vault-side rules in [docs/self-hosting-mcp-http.md → Security behaviour](docs/self-hosting-mcp-http.md#security-behaviour). The server and MCP server refuse to fetch URLs that point at `localhost` or private addresses (SSRF protection); for a local single-user setup only, `MINDBASE_ALLOW_PRIVATE_FETCH=1` lifts that.

## Development

```bash
pnpm install
pnpm -F @mindbase/core build
pnpm test            # all workspace test suites
pnpm typecheck
pnpm check:brand     # no old product name or upstream pointer in user-visible surfaces
```

Monorepo: `packages/core` (wiki engine) · `apps/server` + `apps/web` (vault web server and UI) · `apps/mcp` (MCP server) · `apps/portal` (setup portal) · `deploy/` (images, stack, Coolify template). Package names (`@mindbase/*`) and `MINDBASE_*` variables are internal and stay as they are — see [ADR 0001](docs/adr/0001-rebrand-lokyy-brain.md).

## Contact

Questions, feedback, commercial licensing: [info@lokyy.de](mailto:info@lokyy.de).

## License and attribution

Lokyy Brain V2 is a fork of [MindBase](https://github.com/frankchu91/mindbase-llm-wiki) by Haobing Chu and contains code under two licenses — see [NOTICE.md](NOTICE.md):

- Upstream MindBase code (up to commit `7aa8fcd`, and later changes merged from upstream): [MIT](LICENSE-MIT), Copyright (c) 2026 Haobing Chu.
- Modifications made in this fork after `7aa8fcd`: [PolyForm Noncommercial 1.0.0](LICENSE). Commercial use of these modifications requires a separate license — contact info@lokyy.de.
