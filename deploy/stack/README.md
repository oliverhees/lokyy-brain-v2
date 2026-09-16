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
```

| URL | What |
|---|---|
| `http://auth.localhost:18080` | Authentik (admin: `akadmin`, password `AUTHENTIK_ADMIN_PASS`) |
| `http://anna.vault.localhost:18080` | Anna's vault — only user `anna` |
| `http://ben.vault.localhost:18080` | Ben's vault — only user `ben` |
| `http://firma.vault.localhost:18080` | Company vault web UI — only group `vault-firma-write` (ben) |
| `http://mcp.localhost:18080` | MetaMCP admin UI — only group `lokyy-admins`; `/metamcp/*` endpoints use MetaMCP API keys |

Demo users and groups come from `authentik/blueprints/lokyy-vaults.yaml`: `anna` is in `vault-firma-read`, `ben` in `vault-firma-write`. Passwords are `DEMO_PASS_ANNA` / `DEMO_PASS_BEN`.

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
| Readers of the company vault | `MCP_HTTP_READONLY_TOKEN` on `vault-firma`: 12 read tools, no `internal`/`pii` pages, enforced inside the vault (fail closed). MetaMCP's own tool deactivation is only a second layer |
| MetaMCP accounts | `metamcp-init` creates the admin and closes self-registration (open by default in MetaMCP 2.4.22) |

Middleware order on each vault router is `authentik@docker,vault-<vault>-secret@docker`: forward-auth runs first, so Authentik never receives the proxy secret.

Networks use explicit `10.231.x.0/28` subnets because the default Docker address pools can be exhausted on developer machines.

## Attack tests

`tests/isolation.sh` (59 checks) logs in through the real Authentik flow (`tests/login.sh`) and verifies:

1. Anonymous requests are redirected to the login.
2. Browser isolation: each user reaches only their own vault; readers are denied the company vault web UI; only admins reach MetaMCP.
3. Header forgery: forged `X-authentik-username` is denied; a client-supplied `X-Vault-Proxy-Secret` is overwritten; the proxy secret alone is not a login.
4. Direct container access: MetaMCP gets `403` on a vault web port and `401` on MCP without a token; tokens do not work across vaults.
5. Company vault read-only profile: 12 tools, `create_note` rejected, session bound to the read-only token, full token still sees all 50 tools.
6. Lateral movement from a vault (e.g. SSRF): other vaults, Authentik and databases unreachable by name; MetaMCP reachable but authenticated, and a signup attempt creates no account; internet (EUrouter) reachable.
7. Network topology, independent of DNS: each `web-<vault>` / `mcp-<vault>` network has exactly the expected two members, each vault joins exactly its three networks, egress has inter-container traffic disabled, and every other vault is unreachable on every one of its IPs and ports.
8. Only Traefik publishes a port, bound to `127.0.0.1`.

## Known limitations

- MetaMCP must reach the vaults, so a vault can reach MetaMCP back (compose has no one-way rules). Its surface stays authenticated.
- MetaMCP 2.4.22's tool deactivation is a fail-open denylist — never rely on it alone (see LBV2-4).
- `X-Mindbase-User` is not yet set by the proxy from the Authentik identity (LBV2-9).
- MetaMCP namespaces, endpoints and API keys are not provisioned automatically yet.
- Vaults can reach services published on the Docker host through the egress gateway (and cloud metadata endpoints, if any). Harmless on a developer machine, relevant for the Coolify template (LBV2-16).
- The stack suite does not re-test the `internal`/`pii` visibility rules; those are covered by `apps/mcp/test/http-readonly-visibility.mjs`.
- Traefik mounts the Docker socket (read-only) for label discovery.
