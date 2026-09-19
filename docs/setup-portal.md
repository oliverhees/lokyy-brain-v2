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
| Invitation link | One-time Authentik link (recovery flow `lokyy-set-password`) where the employee sets their own password. Valid 7 days (`PORTAL_INVITE_VALIDITY`, at most 14). Authentik keeps one such token per user: "resend" re-issues the same link with a new expiry, there is never a second valid link. |
| Route | EUrouter routing rule (UUID `id`, `name`). The vaults send it as `rule_id` on `/chat/completions` without a model; vault config field `ruleId` (LBV2-30). |
| Provisioning | MetaMCP account, servers, endpoint and API key per employee, ported from `deploy/stack/metamcp/provision.mjs`. |

## Deployment contract

Service `portal`, image from `apps/portal/Dockerfile` (build context: repo root), port 3000, healthcheck
`GET /healthz`. The container runs as `node`, needs no Docker socket and works with a read-only root
filesystem; it writes only to `/state`. MetaMCP provisioning is done by the portal itself (lead decision).

Networks: `edge` (MetaMCP HTTP, egress to `https://api.eurouter.ai` for the route lookup),
`metamcp-internal` (MetaMCP Postgres: provisioning and immediate key revocation), an internal network
shared only with Traefik (portal traffic and the vault config entrypoint) and the internal `portal-gate`
network to `authentik-gate`. Never a vault network (`web-*`, `mcp-*`). The portal holds **no Authentik
token**; every Authentik change goes through `authentik-gate` (below).

Volume `lokyy-state` at `LOKYY_STATE_DIR`, read-write for the portal only:

| File | Content |
|---|---|
| `state.json` | company, LLM (masked key hints, route id/name per vault), SMTP without password, slot → user, retired slots, last provisioning run |
| `secrets.json` | SMTP password, CSRF key (mode 600) |
| `users.json` | derived, format of `provision.mjs` (`vault` = slot, `allowVaultNameMismatch: true`), mode 600 (contains no keys, but usernames). mcp-gate needs only the user count: prefer `GATE_MAX_BINDINGS`; mounting this file would need a shared gid and mode 640 |
| `audit.log` | JSON lines: admin actions, every vault config call, key reveal/rotation; no secrets or links |

### Environment

| Variable | Required | Default / meaning |
|---|---|---|
| `LOKYY_DOMAIN` | yes | base domain, e.g. `firma.de` |
| `LOKYY_SLOTS` | yes | deployed slots, `v01,v02,…` |
| `VAULT_PROXY_SECRET` | yes | ≥ 32 chars; Traefik sets it as `X-Vault-Proxy-Secret` on the `app.<domain>` router after forward-auth |
| `AUTHENTIK_GATE_SECRET` | yes | ≥ 32 chars, shared bearer secret with `authentik-gate` (its `GATE_SECRET`) |
| `METAMCP_DATABASE_URL` | yes | `postgresql://metamcp:…@metamcp-db:5432/metamcp` |
| `VAULT_ADMIN_URL` | yes | the vault config entrypoint, e.g. `http://<traefik ip on the portal network>:8090` |
| `MCP_TOKEN_V01…`, `MCP_TOKEN_FIRMA`, `MCP_READONLY_TOKEN_FIRMA` | yes | vault MCP tokens (looked up by name like `provision.mjs`) |
| `LOKYY_STATE_DIR` | no | `/state` |
| `LOKYY_PACKAGE` | no | package name, shown to admins |
| `AUTHENTIK_GATE_URL` / `METAMCP_URL` | no | `http://authentik-gate:8080` / `http://metamcp:12008` |
| `LOKYY_PUBLIC_SCHEME` / `LOKYY_PUBLIC_PORT` | no | `https` / none; public URLs are `<scheme>://<host>.<domain>[:port]` |
| `AUTHENTIK_PUBLIC_URL`, `METAMCP_PUBLIC_BASE`, `PORTAL_PUBLIC_ORIGIN` | no | derived: `auth.`, `mcp.`, `app.<domain>` |
| `METAMCP_ORIGIN` | no | Origin for MetaMCP's better-auth sign-in; defaults to `METAMCP_PUBLIC_BASE` (= MetaMCP `APP_URL`) |
| `PORTAL_INVITE_VALIDITY` | no | `days=7` (`days=1…14` or `hours=1…336`) |
| `SMTP_ALLOWED_HOSTS` | no | comma list of SMTP hosts allowed although they resolve to private addresses (internal relay) |
| `PORT` | no | `3000` |

### Traefik

- Router `app.<domain>`: `authentik` forward-auth (identity headers in `authResponseHeaders`), then a headers
  middleware setting `X-Vault-Proxy-Secret`; the outpost path bypasses forward-auth like on the vault hosts.
  In Coolify pin `X-Forwarded-Host/Proto` before forward-auth as for the vaults.
- Vault config entrypoint: **bound to Traefik's address on the portal's internal network** (not `:8090`, which
  would also listen on `edge`) plus `ipallowlist` = the portal's fixed address /32. Per vault only
  `(Path(/<v>/api/config) && (Method(GET) || Method(PUT))) || (Path(/<v>/api/config/test) && Method(POST))`,
  `stripprefix /<v>`, headers `X-Vault-Proxy-Secret=<that vault's secret>`, `X-authentik-groups=lokyy-admins`,
  `X-authentik-username=lokyy-portal`, `X-authentik-email`/`X-authentik-uid` blanked. Every call is audited
  (`vault.config`).

Working reference: `apps/portal/test/e2e/compose.yml` (`run.sh test` checks the allowed and refused routes from
inside the portal container).

### authentik-gate

Service `authentik-gate`, image from `deploy/stack/authentik-gate/Dockerfile` (build context: that directory;
TypeScript on Node 24 type stripping, Node built-ins only, tests run in the build), port 8080, runs as `node`,
read-only root filesystem, `cap_drop: ALL`, no volumes. Healthcheck: unauthenticated `GET /v1/users` answers 401.
It alone holds the `lokyy-portal` service-account token and lets the portal manage only its own employees.

| Variable | Required | Default / meaning |
|---|---|---|
| `AUTHENTIK_API_TOKEN` | yes | token of the `lokyy-portal` service account (least privilege, below) — **not** the bootstrap token |
| `GATE_SECRET` | yes | ≥ 32 chars, same value as the portal's `AUTHENTIK_GATE_SECRET` |
| `AUTHENTIK_URL` | no | `http://authentik-server:9000` |
| `PORT` / `GATE_RATE_PER_MINUTE` | no | `8080` / `120` (all calls together) |

Networks: `portal-gate` (internal, portal ↔ gate only) and an internal network with `authentik-server` only
(not the Authentik database network, no `edge`, no egress).

API (bearer `GATE_SECRET`, JSON bodies ≤ 16 KB, nothing else is served):

| Call | Does |
|---|---|
| `GET /v1/users` | managed users (path `lokyy`, policy below) |
| `POST /v1/users/lookup {username}` | `absent`, `managed` + user, or `foreign` (nothing about foreign accounts) |
| `POST /v1/users {username,name,email,slot,groups}` | create; the gate itself sets `path: lokyy`, `lokyy_managed: true`, `lokyy_slot` |
| `PATCH /v1/users/:pk {name?,email?,isActive?,groups?}` | update; only allowlisted groups are changed, other memberships stay |
| `POST /v1/users/:pk/recovery {tokenDuration}` | invitation (recovery) link, at most 14 days |
| `DELETE /v1/users/:pk/sessions`, `DELETE /v1/users/:pk` | end sessions, delete |

Every call on `:pk` fetches the target from Authentik first and is refused (403) unless it has
`attributes.lokyy_managed = true`, is not a superuser, is not `akadmin`/`admin`/`root`/`lokyy-portal`, is an
internal/external user and is in no superuser group, `authentik Admins` or `lokyy-admins`. Assignable groups:
`vault-vNN`, `vault-firma-read`, `vault-firma-write`, `lokyy-users` only. No password endpoint, no passthrough,
unknown fields are refused. Errors are generic (`401 unauthorized`, `403 forbidden_target`, `404 not_found`,
`409 exists`, `413`, `422 group_missing`, `424 no_recovery_flow`, `429`, `502 upstream`); the audit log
(stdout, JSON lines) names action, target and changed fields, never links or tokens. The portal shows a refusal
as `authentik_forbidden` ("change this account in Authentik directly").

### Authentik

- Mount `apps/portal/authentik/lokyy-portal.yaml` into `/blueprints/custom` (server and worker). It creates
  the flow `lokyy-set-password` (password twice, min. 12 characters, user_write `never_create`, login), sets it
  as recovery flow of the default brand, sets the brand locale to German, and binds a policy that allows the
  flow only for portal-managed employees (`attributes.lokyy_managed`, not superuser, not in `lokyy-admins`).
  The policy's `ak_message` replaces Authentik's generic denial: a used or expired link shows "Dieser
  Einladungslink ist abgelaufen oder wurde schon benutzt. Bitte deine Administratorin/deinen Administrator um
  einen neuen Link.", any other account "Dieser Link gilt nicht für dein Konto …". The "Go back" button on that
  page is Authentik's own UI text and stays English in 2026.8.2.
- The stack blueprint provides the groups `vault-v01…`, `vault-firma-read`, `vault-firma-write`,
  `lokyy-admins` (with akadmin), `lokyy-users`, the per-slot proxy providers and a proxy provider/application
  `portal` for `app.<domain>` bound to `lokyy-users` **and** `lokyy-admins`, all in the embedded outpost's
  provider list. **Every proxy provider needs explicit `property_mappings`** (managed scopes openid, email,
  profile, entitlements and `goauthentik.io/providers/proxy/scope-proxy`, after
  `metaapplyblueprint` of "System - OAuth2 Provider - Scopes" / "System - Proxy Provider - Scopes");
  otherwise the outpost can send an empty `X-authentik-username`.
- Setting akadmin's groups in a blueprint replaces them: keep `authentik Admins`
  (`groups: [!Find [authentik_core.group, [name, "authentik Admins"]], !KeyOf group-admins]`, LBV2-29).
- **Service account of the gate (least privilege):** user `lokyy-portal` (type `service_account`) with a role
  `lokyy-portal` and an API token (intent `api`, not expiring), handed only to `authentik-gate`. Permissions,
  derived from the gate's API calls (`deploy/stack/authentik-gate/src/gate.ts`):

  | Permission | Used for |
  |---|---|
  | `authentik_core.view_user` | find a user by username, read groups |
  | `authentik_core.add_user` | create the employee |
  | `authentik_core.change_user` | name, e-mail, groups, active |
  | `authentik_core.delete_user` | remove |
  | `authentik_core.reset_user_password` | invitation (recovery) link |
  | `authentik_core.view_group` | resolve group names |
  | `authentik_core.add_user_to_group`, `authentik_core.remove_user_from_group` | group membership |
  | `authentik_core.view_authenticatedsession`, `authentik_core.delete_authenticatedsession` | end sessions on disable/remove |

  Verified live: everything the portal does works through the gate with this token; the token cannot create a
  recovery link for akadmin (flow policy), cannot add anyone to a superuser group, sees only its own token and
  gets 403 for roles, providers and flows. `change_user`, `delete_user` and `reset_user_password` are global in
  Authentik (no path scoping) — the reason the token lives in the gate and not in the portal: a compromised
  portal can only do what the gate's policy allows (verified live: every write on akadmin and on a
  `lokyy-admins` member is refused). Reference blueprint: `apps/portal/test/e2e/blueprints/e2e-stack.yaml`.

## Behaviour

- **Invite:** validate (username rule of `provision.mjs`: 2–31 chars `a-z0-9-`, starting with a letter, no
  `--`, no trailing `-`, reserved names and slot names refused) → reserve the next free slot → Authentik user
  (path `lokyy`, attributes `lokyy_managed`, `lokyy_slot`; an existing foreign account is never adopted) with
  `vault-<slot>`, `vault-firma-read|write` and `lokyy-users` → invitation link (rewritten to the public Authentik
  URL) → MetaMCP provisioning → mail if SMTP is configured. Authentik failure frees the slot again; a MetaMCP
  failure keeps the user with `provisioning: failed` and a retry button.
- **Former usernames:** a removed person's slot keeps its data and is never handed out automatically. Inviting
  the same username again gives a free slot; the old slot (and data) only with `restoreSlot: true` (unchecked
  checkbox with a warning in the UI). A retired slot can be **released** explicitly (typed slot name, warning
  that the next person sees the data).
- **Why no Authentik invitation/enrollment:** the user_write stage discards `groups` from invitation data,
  so an enrolled user would have no vault access. The portal creates the user and hands out a recovery link.
- **Access revocation first (disable, remove, role change):** the user's MetaMCP API keys are deleted directly in
  MetaMCP's database before anything else, independent of MetaMCP HTTP, Authentik and other users. MetaMCP checks
  the key on every request and mcp-gate drops the binding on 401, so open sessions end too (no MetaMCP restart
  needed). If the revocation fails the API answers `502 revocation_failed` (audit `revoked: false`); the user
  stays disabled so the action can be retried. Provisioning then runs with the state read inside its queue:
  removals first and always completed in the database, one broken account or missing token fails only that user.
- **Reader tripwire:** if a reader's company server exposes any tool outside the read allowlist (wrong vault
  token), provisioning first deletes all of that reader's MetaMCP API keys in the database (existing and
  just issued), then marks the tools INACTIVE. The reader gets `provisioning: failed`, no key is handed out,
  and the audit log gets `provision.tripwire` (actor `system`, `revoked`, `revokedKeys`; no key). Other users
  are unaffected.
- **Role change:** old key revoked, groups swapped, provisioning issues a new key with the new company token.
- **Disable:** key revoked, Authentik user inactive, sessions ended, MetaMCP account removed. **Enable** issues a new key.
- **Remove:** key revoked, Authentik user and MetaMCP account deleted after typing the username; the vault data
  stays and the slot is retired. Wiping vault data is a separate item (`wipe_unsupported`).
- **Mein Zugang:** vault links (company vault web link for writers only), MCP URL
  `https://mcp.<domain>/metamcp/<username>/mcp`, key reveal/regenerate, snippets for Claude Code
  (`claude mcp add --scope user --transport http …`) and Claude Desktop (`mcp-remote` bridge, key in an env
  variable). The key is read from MetaMCP on demand and never stored by the portal. `GET /api/me` has no side
  effects; the UI marks the first visit with `POST /api/me/activate`.
  The vault web UI (Settings → Connect to AI clients) points users here. To show a direct link, build the
  vault image with `--build-arg VITE_LOKYY_PORTAL_URL=https://app.<domain>`; without it the UI names
  "Mein Zugang" without a link.
- **LLM (EUrouter):** key + route only, no model. The portal lists the key's enabled routes (`GET
  /routing-rules`, which also checks the key live: "Der Schlüssel ist ungültig oder nicht berechtigt"), the admin
  picks one, the portal checks that the route belongs to the key and sends `{provider: "openai", baseUrl, apiKey,
  ruleId, ruleName}` to each vault (vault config API of LBV2-30; with a ruleId the vault sends `rule_id` and no
  model). Saving is not rate limited on the vault side; the vault's probe limit (20/min per vault) applies only to
  `POST /api/config/test` and the vault's own rules lookup. Shared or per vault. Keys stay only in the vaults; the portal stores `••••<last 4>`,
  route id and name.
- **SMTP:** hosts that resolve to private or internal addresses are refused unless listed in `SMTP_ALLOWED_HOSTS`;
  checked on save and on every send, and the connection goes to the checked address (TLS verifies the hostname).

## Security

Proxy secret compared in constant time; identity only from Traefik-set headers (a duplicated groups header
grants nothing); `/api/admin/*` needs `lokyy-admins`; CSRF: per-user HMAC token header, same-origin `Origin`,
JSON bodies only (16 KB); per-user rate limits (240/min, 10/min for invite, SMTP test, key reveal/rotate);
CSP `default-src 'self'` without inline scripts or styles, `frame-ancestors 'none'`, `no-store` on the API;
generic error bodies (Authentik/MetaMCP details only in the log). Secrets never leave the server except the
caller's own MCP key on explicit reveal. No Authentik token in the portal: `authentik-gate` holds it and
refuses anything but the portal's own employees.

## Known limits

- No MetaMCP restart from the portal (no Docker socket): key revocation replaces it (accepted by the lead).
- One portal process per stack (state writes and provisioning runs are serialised in-process).
- A leaked invitation link stays valid until used or expired (resend extends the same link); remove the user
  and invite again to invalidate it.
- Changing only the EUrouter route needs the key again (the portal does not keep keys).

## Tests

```bash
pnpm -F @mindbase/portal test          # unit + API + UI tests (fakes for Authentik, MetaMCP, vaults, SMTP)
node --test deploy/stack/authentik-gate/test/*.test.ts  # gate policy + HTTP (the portal tests also run it in-process)
apps/portal/test/e2e/run.sh up         # full stack: project lokyy-portal, 127.0.0.1:18380, 10.234.0-13.0/24
apps/portal/test/e2e/run.sh test       # gate against real Authentik (refusals on akadmin/lokyy-admins) + E2E + vault config route checks
apps/portal/test/e2e/run.sh down
# parallel stacks (e.g. QA and dev at the same time): own project, port and subnet block
apps/portal/test/e2e/run.sh -p lokyy-portal-qa --port 18382 --net 3 up|test|down
# vaults from this branch instead of the shared lokyy-brain-v2:dev image
docker build -f deploy/Dockerfile -t lokyy-brain-v2:lbv2-28 . && apps/portal/test/e2e/run.sh --vault-image lokyy-brain-v2:lbv2-28 … up
# positive LLM path with a real key (never printed): route list, pick a route, every vault answers a chat
EUROUTER_ENV=<file with EUROUTER_API_KEY=…> apps/portal/test/e2e/run.sh … up|test
node apps/portal/test/dev/serve.ts     # UI preview on 127.0.0.1:18390 against fakes (?as=anna for an employee)
```
