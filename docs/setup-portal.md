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
| Provisioning | MetaMCP account, servers, endpoint and API key per employee. Done by the provisioning watcher in the metamcp container (LBV2-27), driven by the portal's `users.json`. |
| Route | EUrouter routing rule (UUID `id`, unique `rule_name`). The vaults send it as `rule_id` next to `model` on `/chat/completions`; vault config field `ruleId` (LBV2-30). |

## Deployment contract

Service `portal`, image from `apps/portal/Dockerfile` (build context: repo root), port 3000, healthcheck
`GET /healthz`. Runs as `node` (uid 1000), needs no Docker socket, works with a read-only root filesystem.

Networks: `edge` (Authentik API; egress to `https://api.eurouter.ai` for the route lookup) and the internal
network of the vault config entrypoint shared only with Traefik. Never a vault network (`web-*`, `mcp-*`),
no MetaMCP database or MetaMCP tokens.

Volumes:

| Volume | Portal | File | Content |
|---|---|---|---|
| `lokyy-state` at `LOKYY_STATE_DIR` | rw (only the portal) | `state.json` (600) | company, LLM (masked key hints, route id/name per vault), SMTP without password, slot → user, retired slots, users.json generation |
| | | `secrets.json` (600) | SMTP password, CSRF key |
| | | `users.json` (644) | watcher input, see below |
| | | `audit.log` (600) | JSON lines, no secrets or links |
| `lokyy-provision` at `LOKYY_PROVISION_DIR` | ro | `metamcp-clients.json` | watcher output, must be readable by uid 1000 |

### Provisioning contract (portal ↔ watcher)

`users.json`, written atomically (tmp + rename) on every change:

```json
{ "companyVault": "firma", "generation": 7,
  "users": [ { "username": "anna", "role": "reader", "vault": "v01", "allowVaultNameMismatch": true, "keyRotation": "3f0c…" } ] }
```

- Format of `deploy/stack/users.json` (`provision.mjs` ignores the extra fields). Only invited and active users
  are listed; disabled and removed users are absent, so the watcher removes their MetaMCP account and key.
- `generation` rises whenever the provisioning input changes, and on "retry" (same content).
- `keyRotation` (optional, opaque): the watcher rotates that user's key when the value differs from the one it
  recorded for the user in the previous `metamcp-clients.json` (absent = no extra rotation). The portal sets a
  new value on "regenerate key" and on every role change (the role change rotates anyway; belt and braces).

`metamcp-clients.json`, written by the watcher (current `provision.sh` format) plus:

- top-level `sourceGeneration`: the `generation` of the `users.json` it processed;
- per user `keyRotation`: the value it applied.

The portal derives per user: `ok` when the user has a non-stale entry whose `keyRotation` matches (the key is
revealed from there), `pending` while `sourceGeneration` is older or a rotation is outstanding (UI polls), `failed`
when the processed run failed for that user. `restartMetamcp` is shown to admins. Reference implementation of the
contract: `apps/portal/test/e2e/watcher/main.ts` (E2E stand-in).

### Environment

| Variable | Required | Default / meaning |
|---|---|---|
| `LOKYY_DOMAIN` | yes | base domain, e.g. `firma.de` |
| `LOKYY_SLOTS` | yes | deployed slots, `v01,v02,…` |
| `VAULT_PROXY_SECRET` | yes | ≥ 32 chars; Traefik sets it as `X-Vault-Proxy-Secret` on the `app.<domain>` router after forward-auth |
| `AUTHENTIK_API_TOKEN` | yes | same value as `AUTHENTIK_BOOTSTRAP_TOKEN` of Authentik (token of akadmin) |
| `VAULT_ADMIN_URL` | yes | the vault config entrypoint, e.g. `http://10.x.y.2:8090` |
| `LOKYY_STATE_DIR` / `LOKYY_PROVISION_DIR` | no | `/state` / `/provision` |
| `LOKYY_PACKAGE` | no | package name, shown to admins |
| `AUTHENTIK_URL` | no | `http://authentik-server:9000` |
| `LOKYY_PUBLIC_SCHEME` / `LOKYY_PUBLIC_PORT` | no | `https` / none; public URLs are `<scheme>://<host>.<domain>[:port]` |
| `AUTHENTIK_PUBLIC_URL`, `METAMCP_PUBLIC_BASE`, `PORTAL_PUBLIC_ORIGIN` | no | derived: `auth.`, `mcp.`, `app.<domain>` |
| `PORTAL_INVITE_VALIDITY` | no | `days=7` (`days=N` or `hours=N`) |
| `PORT` | no | `3000` |

### Traefik

- Router `app.<domain>`: `authentik` forward-auth (identity headers in `authResponseHeaders`), then a headers
  middleware setting `X-Vault-Proxy-Secret`; the outpost path bypasses forward-auth like on the vault hosts. In
  Coolify pin `X-Forwarded-Host/Proto` before forward-auth as for the vaults.
- Vault config entrypoint: **bound to Traefik's address on the portal's internal network** (not `:8090`, which
  would also listen on `edge`), plus `ipallowlist` = the portal's fixed address /32. Per vault only
  `GET|PUT /<vault>/api/config` and `POST /<vault>/api/config/test` →
  `(Path(/v01/api/config) && (Method(GET) || Method(PUT))) || (Path(/v01/api/config/test) && Method(POST))`,
  `stripprefix /<vault>`, headers `X-Vault-Proxy-Secret=<that vault's secret>`, `X-authentik-groups=lokyy-admins`,
  `X-authentik-username=lokyy-portal`. Every call is audited by the portal (`vault.config`).

Working reference: `apps/portal/test/e2e/compose.yml` (`run.sh test` checks the allowed and refused routes from
inside the portal container).

### Authentik

- Mount `apps/portal/authentik/lokyy-portal.yaml` into `/blueprints/custom` (server and worker). It creates
  the flow `lokyy-set-password` (password twice, min. 12 characters, user_write `never_create`, login) and
  sets it as recovery flow of the default brand.
- The stack blueprint provides the groups `vault-v01…`, `vault-firma-read`, `vault-firma-write`,
  `lokyy-admins` (with akadmin), `lokyy-users`, the per-slot proxy providers and a proxy provider/application
  `portal` for `app.<domain>` bound to `lokyy-users` **and** `lokyy-admins` (admins are not in
  `lokyy-users`), all in the embedded outpost's provider list. The portal checks `lokyy-admins` itself.
- Setting akadmin's groups in a blueprint replaces them: keep `authentik Admins`
  (`groups: [!Find [authentik_core.group, [name, "authentik Admins"]], !KeyOf group-admins]`, LBV2-29).

## Behaviour

- **Invite:** validate (username rule of `provision.mjs`: 2–31 chars `a-z0-9-`, starting with a letter, no
  `--`, no trailing `-`, reserved names and slot names refused) → reserve the next free slot → Authentik user
  (path `lokyy`, attributes `lokyy_managed`, `lokyy_slot`; a foreign account is never adopted) with
  `vault-<slot>`, `vault-firma-read|write` and `lokyy-users` → invitation link (rewritten to the public Authentik
  URL) → users.json → mail if SMTP is configured. Authentik failure frees the slot again. The watcher provisions
  asynchronously; the admin list and "Mein Zugang" show `pending` until it is done.
- **Why no Authentik invitation/enrollment:** the user_write stage discards `groups` from invitation data,
  so an enrolled user would have no vault access. The portal creates the user and hands out a recovery link.
- **Role change:** groups swapped; users.json gets the new role and a new `keyRotation`.
- **Disable:** Authentik user inactive, sessions ended, user dropped from users.json (MetaMCP account and key
  removed by the watcher). **Enable** lists the user again (new key).
- **Remove:** Authentik user deleted after typing the username, user dropped from users.json; the vault data stays
  and the slot is retired. The same username invited again gets the slot back. An admin can **release** a retired
  slot explicitly (typed slot name, warning that the next person sees the data). Wiping vault data is a separate
  follow-up; the API answers `wipe_unsupported`.
- **Mein Zugang:** vault links (company vault web link for writers only), MCP URL from the watcher result, key
  reveal (from `metamcp-clients.json`), regenerate (new `keyRotation`, the UI polls until the new key exists),
  snippets for Claude Code (`claude mcp add --transport http …`) and `mcpServers` JSON.
- **LLM (EUrouter):** only `https://api.eurouter.ai/api/v1`. The admin enters a key, the portal lists the key's
  routes (`GET /routing-rules`, which also validates the key), the admin picks one (rule name shown, rule id
  stored); shared or per vault. The portal checks that the route belongs to the key and sends
  `{provider: "openai", baseUrl, apiKey, ruleId}` (optional `model`, no default) to each vault. Keys are kept
  only in the vaults; the portal stores `••••<last 4>`, route id and name. To change only the route the key must
  be entered again.

## Security

Proxy secret compared in constant time; identity only from Traefik-set headers (a duplicated groups header
grants nothing); `/api/admin/*` needs `lokyy-admins`; CSRF: per-user HMAC token header, same-origin `Origin`,
JSON bodies only (16 KB); per-user rate limits (240/min, 10/min for invite, SMTP test, key reveal/rotate);
CSP `default-src 'self'` without inline scripts or styles, `frame-ancestors 'none'`, `no-store` on the API;
generic error bodies (Authentik/EUrouter details only in the log). Secrets never leave the server except the
caller's own MCP key on explicit reveal. Rate limit 10/min also covers the EUrouter route lookup.

## Known limits

- MetaMCP restarts are done by the watcher, not the portal; the portal only shows that one happened.
- One portal process per stack (state writes are serialised in-process).
- Changing only the EUrouter route needs the key again (the portal does not keep keys).

## Tests

```bash
pnpm -F @mindbase/portal test          # unit + API + UI tests (fakes for Authentik, MetaMCP, vaults, SMTP)
apps/portal/test/e2e/run.sh up         # full stack incl. stand-in watcher: project lokyy-portal, 127.0.0.1:18380, 10.234.0.0/16
apps/portal/test/e2e/run.sh test       # Authentik adapter, E2E (invite → accept → vault login → MCP tools/list,
                                       # regenerate, role change, disable, remove) + vault config entrypoint checks
apps/portal/test/e2e/run.sh down
node apps/portal/test/dev/serve.ts     # UI preview on 127.0.0.1:18390 against fakes (?as=anna for an employee)
```
