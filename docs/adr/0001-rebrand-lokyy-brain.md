# ADR 0001 — Product name "Lokyy Brain" in all user-visible surfaces

- Status: accepted
- Date: 2026-09-18
- Work item: LBV2-35
- Decision by: Oliver

## Context

Lokyy Brain v2 is a fork of MindBase (see [NOTICE.md](../../NOTICE.md)). The setup portal already used the name "Lokyy Brain", but the vault web UI, the MCP server, the daily brief e-mail and the LLM system prompts still introduced the product as "MindBase". Users, admins and the LLM (via MCP instructions and tool descriptions) saw two product names for one product.

## Decision

Everything a user, admin or LLM reads names the product **Lokyy Brain**:

- Web UI (`apps/web`): `<title>`, wordmark, onboarding and setup wizard, settings, empty states, help texts.
- MCP server (`apps/mcp`): `serverInfo.name` is `lokyy-brain`; server instructions, tool, resource and prompt descriptions, error texts.
- Web server (`apps/server`): brief e-mail (subject, HTML, text), log lines, LLM system prompts of the recipes, mDNS display name, default HTTP `User-Agent` (`LokyyBrain/0.1`, `LokyyBrain-research/1.0`).
- Core (`packages/core`) and vault schema (`schema/`): LLM prompts, headings of newly written `INDEX.md`, log and schema files, graph export page.
- Docs in prose: `README.md`, `docs/guide.md`, `docs/remote-access.md`, `docs/testing-walkthrough.md` (web parts), `apps/mcp/README.md`.

## What stays internal, and why

| Kept | Why |
|------|-----|
| Package names `@mindbase/*`, `mindbase-mcp`, root `mindbase` | Renaming touches every import, the lockfile and CI filters for no user benefit. |
| `MINDBASE_*` environment variables, `mindbase.config.json`, `~/mindbase-data` | Existing deployments and vaults depend on them. |
| MCP tool names (`mindbase_*`) and the `mindbase://` resource URI scheme | Client configs, prompts and saved conversations reference them; changing them breaks compatibility. |
| Header `X-Mindbase-User` | Wire protocol between proxy and vault; Traefik configs in `deploy/stack` and `deploy/coolify` strip and set it. |
| Browser `localStorage` keys and DOM event names (`mindbase.*`, `mindbase:*`) | Renaming would reset user preferences. |
| File and directory names, code identifiers | Internal. |
| Upstream attribution in `NOTICE.md`, `LICENSE-MIT`, `CONTRIBUTING.md`, the license section of READMEs, and links to the upstream project | Legal requirement of the MIT license and honest attribution. |
| Existing `CHANGELOG.md` entries and dated planning docs (`docs/pivot-plan-2026-05-25.md`, `docs/product-strategy-2026-05-25*.md`) | Historical records. |
| Native and browser clients (`apps/ios`, `apps/android`, `apps/browser-ext`, `apps/extension`, `apps/cli`, `apps/plugin`, `apps/app`) and `website/` | Not part of the Lokyy Brain v2 deliverable yet; rebrand when they are shipped. |

Vault files written before this change keep their old headings (`# MindBase Wiki Index` etc.). No code parses these headings, so old and new vaults behave identically.

## Enforcement

`scripts/check-brand.mjs` (`pnpm check:brand`, CI step "Brand guard") fails when the old product name appears in `apps/web/src`, `apps/web/index.html`, `apps/portal/src`, `apps/mcp/src`, `apps/server/src`, `packages/core/src` or `schema/`. Test files are skipped (they may hold pre-rebrand fixtures). Wire identifiers go into the script's allowlist.

## Consequences

- MCP clients show the server as `lokyy-brain`. Tool names are unchanged, so existing client configs keep working.
- Feed and article servers see a new default `User-Agent`; `rss.fetchUserAgent` still overrides it.
- Deployed images show the new name only after a rebuild; the portal E2E test (`apps/portal/test/integration/e2e.int.test.ts`) expects `<title>Lokyy Brain`.
