# Local prototype stack (LBV2-2)

A local reference setup for one company server: Traefik, Authentik, three vaults (`anna`, `ben` and the company vault `firma`) and MetaMCP. It exists to verify the security model end to end before building the Coolify template. It is not a production deployment: plain HTTP on `127.0.0.1:18080`, demo users, generated secrets.

For the vault container itself (environment variables, access profiles, visibility rules), see [`docs/self-hosting-mcp-http.md`](../../docs/self-hosting-mcp-http.md).

## Start

```bash
cd deploy/stack
cp .env.example .env && chmod 600 .env
for k in $(grep -oE '^[A-Z_]+' .env.example); do sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env; done
docker compose up -d --build     # first build takes a few minutes
tests/wait-ready.sh              # healthy services, blueprint applied, routes protected, signup closed
tests/isolation.sh               # also waits on its own (WAIT_TIMEOUT, default 300 s)
metamcp/provision.sh             # MetaMCP users, endpoints, API keys → secrets/metamcp-clients.json
tests/metamcp-attacks.sh         # MCP endpoint attack tests (rotates anna's key, re-creates ben)
```

`STACK_NAME` (optional, in `.env`) changes the compose project name, e.g. to start a fresh stack while another stack's volumes still exist. Only one stack can run at a time (port 18080, fixed subnets).

| URL | What |
|---|---|
| `http://auth.localhost:18080` | Authentik (admin: `akadmin`, password `AUTHENTIK_ADMIN_PASS`) |
| `http://anna.vault.localhost:18080` | Anna's vault — only user `anna` |
| `http://ben.vault.localhost:18080` | Ben's vault — only user `ben` |
| `http://firma.vault.localhost:18080` | Company vault web UI — only group `vault-firma-write` (ben) |
| `http://mcp.localhost:18080` | MetaMCP admin UI — only group `lokyy-admins`; `/metamcp/*` endpoints use MetaMCP API keys |

Demo users and groups come from `authentik/blueprints/lokyy-vaults.yaml`: `anna` is in `vault-firma-read` and `vault-anna-admin`, `ben` in `vault-firma-write`, `vault-ben-admin` and `vault-firma-admin`. Passwords are `DEMO_PASS_ANNA` / `DEMO_PASS_BEN`. Usernames must stay plain (no `@`): the vault rejects them as identity.

On a fresh start Authentik applies the blueprint in the background; right after `up` the vault routes answer `404` until it is done, which is why `tests/wait-ready.sh` waits for it. If the blueprint ends in status `error` (seen once during development, when Authentik's default flows did not exist yet), re-apply it:

```bash
docker compose exec authentik-worker ak apply_blueprint custom/lokyy-vaults.yaml
```

## Security model

| Boundary | How it is enforced |
|---|---|
| Who may open a vault in the browser | Authentik forward-auth on each vault router, one proxy provider + policy binding per vault |
| Web server only reachable through the proxy | Traefik injects `X-Vault-Proxy-Secret` (per vault, overwriting any client value) after forward-auth; the vault answers `403` without it (`VAULT_PROXY_SECRET`) |
| Vaults cannot reach each other | No published ports. Per-vault internal networks: `web-<vault>` (Traefik only) and `mcp-<vault>` (MetaMCP only, alias `mcp.vault-<vault>`). Shared `egress` network with inter-container traffic disabled |
| MCP access | Per-vault `MCP_HTTP_TOKEN`, known only to MetaMCP; `MCP_HTTP_ALLOWED_HOSTS=mcp.vault-<vault>:4322` |
| Identity for the vault web server | Traefik forward-auth `authResponseHeaders` delete any client `X-authentik-username` / `X-authentik-groups` and set Authentik's values; the `vault-identity` middleware strips `X-Mindbase-User`. The vault trusts these headers only behind the proxy secret (LBV2-9) |
| Vault administration (config writes) | `VAULT_ADMIN_GROUPS=vault-<vault>-admin,lokyy-admins`, checked against the proxy-set groups header |
| Readers of the company vault | `MCP_HTTP_READONLY_TOKEN` on `vault-firma`: 12 read tools, no `internal`/`pii` pages, enforced inside the vault (fail closed). MetaMCP's own tool deactivation is only a second layer |
| MCP clients (AI tools) | One MetaMCP endpoint per user, API key only (no OAuth, no key in the query string). Traefik routes only `/metamcp/<endpoint>/mcp` |
| MetaMCP accounts | `metamcp-init` creates the admin and closes self-registration (open by default in MetaMCP 2.4.22) |

Middleware order on each vault router is `authentik@docker,vault-<vault>-secret@docker`: forward-auth runs first, so Authentik never receives the proxy secret.

Networks use explicit `10.231.x.0/28` subnets because the default Docker address pools can be exhausted on developer machines.

## MetaMCP provisioning (LBV2-4)

`users.json` declares who gets MCP access:

```json
{ "companyVault": "firma",
  "users": [ { "username": "anna", "role": "reader", "vault": "anna" },
             { "username": "ben",  "role": "writer", "vault": "ben" } ] }
```

`metamcp/provision.sh` reconciles MetaMCP with that file and can be re-run at any time; it never duplicates anything. It runs a Node script inside the `metamcp` container (MetaMCP's own `pg` and `better-auth`), so the host needs only docker and jq. For each user it creates or updates:

| Object | Value |
|---|---|
| MetaMCP account | `lokyy-<user>`, owner of everything below. Logged in with a one-time password during the run; credential and sessions are deleted afterwards, so nobody can log in as it |
| MCP server `<user>-vault` | Streamable HTTP `http://mcp.vault-<vault>:4322/mcp`, bearer `MCP_TOKEN_<VAULT>` |
| MCP server `<user>-firma` | `http://mcp.vault-firma:4322/mcp`, bearer `MCP_TOKEN_FIRMA` (writer) or `MCP_READONLY_TOKEN_FIRMA` (reader) |
| Namespace `<user>` | both servers |
| Endpoint `<user>` | API-key auth only: `http://mcp.localhost:18080/metamcp/<user>/mcp` |
| API key `lokyy` | written with the URL to `secrets/metamcp-clients.json` (mode 600, gitignored) for handing out |

Users removed from the file lose their account, endpoint and key. `metamcp/provision.sh --rotate <user>` replaces a key; the old key stops working immediately, also on open sessions. `USERS_FILE=… metamcp/provision.sh` uses another file.

Why one MetaMCP account per user: MetaMCP 2.4.22 only checks that an API key and an endpoint have the same owner. With admin-owned endpoints and keys, anna's key would open ben's endpoint, and any key opens a public endpoint.

Second layer for readers: MetaMCP's tool deactivation is a denylist that fails open (unknown mapping, unparsable name, lookup error: allowed), and MetaMCP deletes tools a server no longer lists, so write tools cannot be deactivated in advance. The real boundary is the read-only token: the vault exposes 12 read tools and answers `Tool not available` to everything else. Provisioning adds a tripwire: it lists each reader's tools through the endpoint and, if the company server shows any tool outside the read allowlist, marks it INACTIVE in MetaMCP and exits with an error.

## LLM via EUrouter (LBV2-5)

Put `EUROUTER_API_KEY` and `EUROUTER_MODEL` (an id from `https://api.eurouter.ai/api/v1/models`, e.g. `qwen3.6-27b`) into `.env`, then:

```bash
llm/configure-eurouter.sh          # all vaults; or: llm/configure-eurouter.sh anna firma
```

It merges `provider: openai`, `baseUrl: https://api.eurouter.ai/api/v1`, model and key into `/data/mindbase.config.json` of each vault (mode 600) and restarts vaults whose file changed. The key is passed by variable name, never printed. `https://www.eurouter.ai/api/v1` is the website and answers 404.

Risks:
- The OpenAI adapter uses `/v1/responses` instead of chat completions whenever a message carries a document block (PDF chat). EUrouter answers `400` (not `404`) on `/api/v1/responses`, so the route exists, but PDF chat through EUrouter is untested without a real key.
- `GET /api/config` returns the whole config including `apiKey` to every user who can open the vault web UI.
- Embeddings do not use EUrouter: BGE-M3 runs locally in the vault (`/transformers`, ~570 MB download from Hugging Face on first use into the container home, so again after every container re-creation).

## Attack tests

`tests/isolation.sh` (71 checks) logs in through the real Authentik flow (`tests/login.sh`) and verifies:

1. Anonymous requests are redirected to the login.
2. Browser isolation: each user reaches only their own vault; readers are denied the company vault web UI; only admins reach MetaMCP.
3. Header forgery: forged `X-authentik-username` is denied; a client-supplied `X-Vault-Proxy-Secret` is overwritten; the proxy secret alone is not a login.
   Identity headers as the vault receives them are checked with a test-only `traefik/whoami` behind anna's router chain (`tests/echo.override.yml`, started and removed by the test): client `X-authentik-username` (any case, duplicated, underscore variant) and `X-authentik-groups` are replaced by Authentik's values, `X-Mindbase-User` is stripped, forged headers without a session get the login redirect.
4. Direct container access: MetaMCP gets `403` on a vault web port and `401` on MCP without a token; tokens do not work across vaults.
5. Company vault read-only profile: 12 tools, `create_note` rejected, session bound to the read-only token, full token still sees all 50 tools.
6. Lateral movement from a vault (e.g. SSRF): other vaults, Authentik and databases unreachable by name; MetaMCP reachable but authenticated, and a signup attempt creates no account; internet (EUrouter) reachable.
7. Network topology, independent of DNS: each `web-<vault>` / `mcp-<vault>` network has exactly the expected two members, each vault joins exactly its three networks, egress has inter-container traffic disabled, and every other vault is unreachable on every one of its IPs and ports.
8. Only Traefik publishes a port, bound to `127.0.0.1`.

`tests/metamcp-attacks.sh` (64 checks, all through Traefik with the provisioned keys):

0. Provisioning is idempotent (object counts and keys unchanged on re-run), output file mode 600 and gitignored, all objects private, provisioned accounts keep no login.
1. No key or invented key: `401`; anna's key on ben's endpoint (header, Bearer): `403`; query-string keys disabled; only `/metamcp/<endpoint>/mcp` is routed.
2. anna sees `anna-vault` (50 tools) and `anna-firma` with exactly the 12 read tools; ben sees `ben-vault` and `ben-firma` (50); nobody sees another user's servers.
3. anna calling company write tools under 15 name variants (own prefix, ben's prefix, unprefixed, wrong case, extra underscores, nested prefixes, other tools) is rejected and nothing is written; writing to her own vault works.
4. ben writes to the company vault.
5. Fail-open cases: the reader's company server stores the read-only token, never the full one; with all MetaMCP tool mappings deleted, and with an unparsable name, the write is still rejected; replaying all 38 non-read tools with anna-firma's stored credential directly against the vault is rejected 38/38.
6. Key rotation and user removal: old key `401` also on an open session, removed user's key `401` everywhere, a re-added user gets a new working key.

## Known limitations

- MetaMCP must reach the vaults, so a vault can reach MetaMCP back (compose has no one-way rules). Its surface stays authenticated.
- MetaMCP 2.4.22's tool deactivation is a fail-open denylist — never rely on it alone (see LBV2-4).
- MetaMCP stores API keys and vault bearer tokens in plain text in its database.
- Guarded-mode identity and admin checks inside the vault (LBV2-9) are verified here at header level only.
- Vaults can reach services published on the Docker host through the egress gateway (and cloud metadata endpoints, if any). Harmless on a developer machine, relevant for the Coolify template (LBV2-16).
- The stack suite does not re-test the `internal`/`pii` visibility rules; those are covered by `apps/mcp/test/http-readonly-visibility.mjs`.
- Traefik mounts the Docker socket (read-only) for label discovery.
