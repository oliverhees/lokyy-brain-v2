# Setup portal (LBV2-28)

After the one-click Coolify deploy an admin logs in at `https://app.<domain>` and the portal does the rest:
company data, the EUrouter key for the vaults, optional SMTP, inviting employees, roles, disabling and
removing them. Employees use the same URL ("Mein Zugang") for their vault links and MCP credentials.

Source: `apps/portal` (server `src/server`, UI `src/client`, all German UI copy in `src/shared/i18n/de.ts`).
API: `apps/portal/openapi.json` (checked against the server by `src/server/openapi.test.ts`).

## Terms

| Term | Meaning |
|---|---|
| Slot | A pre-deployed personal vault `v01…vNN` (service `vault-v01`, host `v01.<domain>`). The portal assigns one slot per employee. |
| Company vault | `vault-firma` at `firma.<domain>`. Readers use it only through MCP with the read-only token; writers also in the browser. |
| Retired slot | Slot of a removed employee whose vault data was kept. Never handed to someone else automatically; the same username invited again gets it back. |
| Invitation link | One-time Authentik link (recovery flow `lokyy-set-password`) where the employee sets their own password. Valid 7 days (`PORTAL_INVITE_VALIDITY`). |
| Provisioning | MetaMCP account, servers, endpoint and API key per employee, ported from `deploy/stack/metamcp/provision.mjs`. |

## Deployment contract

Service `portal`, image from `apps/portal/Dockerfile` (build context: repo root), port 3000, healthcheck
`GET /healthz`. The container runs as `node`, needs no Docker socket and works with a read-only root
filesystem; it writes only to `/state`.

Networks: `edge` (Authentik API, MetaMCP HTTP), `metamcp-internal` (MetaMCP Postgres) and an internal
`portal-admin` network shared only with Traefik. Never a vault network (`web-*`, `mcp-*`).

Volume `lokyy-state` at `/state`, read-write for the portal only:

| File | Content |
|---|---|
| `state.json` | company, LLM settings (masked key hints only), SMTP settings without password, slot → user, retired slots, last provisioning run |
| `secrets.json` | SMTP password, CSRF key (mode 600) |
| `users.json` | derived, format of `provision.mjs` (`vault` = slot, `allowVaultNameMismatch: true`); mcp-gate may mount it read-only |
| `audit.log` | JSON lines: admin actions and key reveal/rotation, no secrets or links |

### Environment

| Variable | Required | Default / meaning |
|---|---|---|
| `LOKYY_DOMAIN` | yes | base domain, e.g. `firma.de` |
| `LOKYY_SLOTS` | yes | deployed slots, `v01,v02,…` |
| `PORTAL_PROXY_SECRET` | yes | ≥ 32 chars; Traefik sets it as `X-Portal-Proxy-Secret` on the `app.<domain>` router after forward-auth |
| `AUTHENTIK_API_TOKEN` | yes | same value as `AUTHENTIK_BOOTSTRAP_TOKEN` of Authentik (token of akadmin) |
| `METAMCP_DATABASE_URL` | yes | `postgresql://metamcp:…@metamcp-db:5432/metamcp` |
| `VAULT_ADMIN_URL` | yes | Traefik's portal-admin entrypoint, e.g. `http://10.x.y.2:8090` |
| `MCP_TOKEN_V01…`, `MCP_TOKEN_FIRMA`, `MCP_READONLY_TOKEN_FIRMA` | yes | vault MCP tokens (looked up by name like `provision.mjs`) |
| `AUTHENTIK_URL` | no | `http://authentik-server:9000` |
| `METAMCP_URL` | no | `http://metamcp:12008` |
| `LOKYY_PUBLIC_SCHEME` / `LOKYY_PUBLIC_PORT` | no | `https` / none; public URLs are `<scheme>://<host>.<domain>[:port]` |
| `AUTHENTIK_PUBLIC_URL`, `METAMCP_PUBLIC_BASE`, `PORTAL_PUBLIC_ORIGIN` | no | derived: `auth.`, `mcp.`, `app.<domain>` |
| `METAMCP_ORIGIN` | no | Origin for MetaMCP's better-auth sign-in; defaults to `METAMCP_PUBLIC_BASE` (= MetaMCP `APP_URL`) |
| `PORTAL_INVITE_VALIDITY` | no | `days=7` (`days=N` or `hours=N`) |

### Traefik

- Router `app.<domain>`: middlewares `authentik` (forward-auth, identity headers in `authResponseHeaders`)
  and a headers middleware setting `X-Portal-Proxy-Secret`; the outpost path bypasses forward-auth like on
  the vault hosts. In Coolify pin `X-Forwarded-Host/Proto` before forward-auth as for the vaults.
- Entrypoint `portal-admin`, **bound to Traefik's address on the `portal-admin` network** (not `:8090`, which
  would also listen on `edge`). Per vault a router `PathPrefix(/<vault>/api/config)` → vault service with
  `ipallowlist` (portal address /32), `stripprefix /<vault>` and headers `X-Vault-Proxy-Secret=<that vault's
  secret>`, `X-authentik-groups=lokyy-admins`, `X-authentik-username=lokyy-portal`. The vault's guarded
  config API then accepts the EUrouter settings; the portal itself holds no vault secret.

Working reference: `apps/portal/test/e2e/compose.yml`.

### Authentik

- Mount `apps/portal/authentik/lokyy-portal.yaml` into `/blueprints/custom` (server and worker). It creates
  the flow `lokyy-set-password` (password twice, min. 12 characters, user_write `never_create`, login) and
  sets it as recovery flow of the default brand.
- The stack blueprint provides the groups `vault-v01…`, `vault-firma-read`, `vault-firma-write`,
  `lokyy-admins` (with akadmin), the per-slot proxy providers and a proxy provider/application `portal` for
  `app.<domain>` **without** policy binding (every authenticated user reaches the portal; it checks
  `lokyy-admins` itself), all in the embedded outpost's provider list.
- Setting akadmin's groups in a blueprint replaces them: keep `authentik Admins`, otherwise akadmin and the
  bootstrap token lose all permissions (`groups: [lokyy-admins, !Find [authentik_core.group, [name, "authentik Admins"]]]`).

## Behaviour

- **Invite:** validate (username rule of `provision.mjs`: 2–31 chars `a-z0-9-`, starting with a letter, no
  `--`, no trailing `-`, reserved names and slot names refused) → reserve the next free slot → Authentik user
  (path `lokyy`, attributes `lokyy_managed`, `lokyy_slot`; an existing foreign account is never adopted) with
  `vault-<slot>` + `vault-firma-read|write` → invitation link (rewritten to the public Authentik URL) →
  MetaMCP provisioning → mail if SMTP is configured. Authentik failure frees the slot again; a MetaMCP failure
  keeps the user with `provisioning: failed` and a retry button.
- **Why no Authentik invitation/enrollment:** the user_write stage discards `groups` from invitation data,
  so an enrolled user would have no vault access. The portal therefore creates the user and hands out a
  recovery link.
- **Role change:** groups swapped, provisioning swaps the company token; the user's MCP key is rotated.
- **Disable:** Authentik user inactive, sessions ended, MetaMCP account removed (key revoked). **Enable**
  issues a new key.
- **Remove:** Authentik user and MetaMCP account deleted after typing the username; the vault data stays and
  the slot is retired. Wiping vault data is refused (`wipe_unsupported`) until the vault offers an API for it.
- **Mein Zugang:** vault links (company vault web link for writers only), MCP URL
  `https://mcp.<domain>/metamcp/<username>/mcp`, key reveal/regenerate, snippets for Claude Code
  (`claude mcp add --transport http …`) and `mcpServers` JSON. The key is read from MetaMCP on demand and never
  stored by the portal.
- **LLM:** only `https://api.eurouter.ai/api/v1`; shared key or one per vault; keys go only to the vaults,
  the portal keeps `••••<last 4>`.

## Security

Proxy secret compared in constant time; identity only from Traefik-set headers (a duplicated groups header
grants nothing); `/api/admin/*` needs `lokyy-admins`; CSRF: per-user HMAC token header, same-origin `Origin`,
JSON bodies only (16 KB); per-user rate limits (240/min, 10/min for invite, SMTP test, key reveal/rotate);
CSP `default-src 'self'` without inline scripts or styles, `frame-ancestors 'none'`, `no-store` on the API;
generic error bodies (Authentik/MetaMCP details only in the log). Secrets never leave the server except the
caller's own MCP key on explicit reveal.

## Known limits

- The portal cannot restart MetaMCP (no Docker socket). After role changes or removals `provision.sh` would
  restart MetaMCP to end open sessions; the portal instead rotates the key: the old key gets 401 on every
  request (open sessions included) and mcp-gate drops the binding. The admin UI shows a hint when a restart
  would have happened (`lastProvisioning.restartMetamcp`).
- One portal process per stack (state writes and provisioning runs are serialised in-process).

## Tests

```bash
pnpm -F @mindbase/portal test          # unit + API + UI tests (fakes for Authentik, MetaMCP, vaults, SMTP)
apps/portal/test/e2e/run.sh up         # full stack: project lokyy-portal, 127.0.0.1:18380, 10.234.0.0/16
apps/portal/test/e2e/run.sh test       # Authentik adapter + E2E: invite → accept → vault login → MCP tools/list
apps/portal/test/e2e/run.sh down
node apps/portal/test/dev/serve.ts     # UI preview on 127.0.0.1:18390 against fakes (?as=anna for an employee)
```
