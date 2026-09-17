# Beta runbook: one company server on Coolify (LBV2-16)

Scope: one server for one company, at most 15 users; the beta runs 3–5 users plus one company vault. The template is `deploy/coolify/compose.yml`. It is derived from the locally verified stack in `deploy/stack/` (see its README for the full security model and the attack suites). Nothing in this runbook has been run on a real Coolify server yet: steps marked **STAGING CHECK** must be done and recorded on the Plane item before beta users get access.

## 0. Differences to `deploy/stack`

Every difference is marked `COOLIFY:` in the compose file.

| Difference | Why |
|---|---|
| Inner Traefik (`lokyy-traefik`) publishes no port; it joins the external `coolify` network and carries labels for Coolify's proxy (`https` entrypoint, `letsencrypt` resolver, HTTP→HTTPS redirect) | Coolify's proxy owns ports 80/443 and TLS. Keeping our own Traefik behind it keeps the verified routing model (forward-auth, per-vault networks, proxy secrets, mcp-gate) byte-for-byte; only `lokyy-traefik` touches the shared `coolify` network |
| Provider constraint on label `lokyy.stack=<LOKYY_STACK_ID>` instead of `com.docker.compose.project` | Coolify sets the compose project name to the resource UUID |
| `forwardedHeaders.trustedIPs=${COOLIFY_PROXY_CIDR}` on the inner entrypoint | Client IP and `X-Forwarded-Proto` come from coolify-proxy; only trust them from its network |
| `ratelimit.sourcecriterion.ipstrategy.depth=1` on the MCP endpoint rate limit | Behind a proxy every request has the proxy as TCP peer; without this all clients would share one bucket |
| Networks have fixed `name:` values (`lokyy-*`) | `traefik.docker.network` labels must not depend on Coolify's generated project name |
| Vault slots `u1`, `u2`, `u3` (+ `firma`) instead of `anna`/`ben`; hostname from `VAULT_U<n>_USER` | Service, token, network and group names must be static in compose; only the public hostname carries the user name |
| Blueprint `deploy/coolify/authentik/blueprints/lokyy-beta.yaml`: no users, group-based bindings (`vault-u<n>-access`), `https://` hosts from env | Real users are created in the Authentik UI; no demo passwords on a server |
| Bind mounts use `${LOKYY_ASSETS_DIR}` (absolute path of a checkout on the server) | Coolify does not fill relative bind mounts with repository files |
| `mem_limit` on every long-running service (vaults `3500m`) | LBV2-20 measurements (section 13) |
| Admin e-mails from env, images tagged `:beta` | No `example.local` addresses on a server |

Unchanged: Authentik forward-auth on every vault router, per-vault `web-<vault>` / `mcp-<vault>` internal networks, `egress` with inter-container traffic disabled, `mcp-gate` in front of MetaMCP, MetaMCP on no vault network (only via `vault-connector`), `models` volume read-only for vaults and filled by `model-prefetch` with pinned revision + SHA-256, `MINDBASE_DISABLE_CAPTURE=1`, `VAULT_LLM_ALLOWED_HOSTS=api.eurouter.ai`.

## 1. Server prerequisites

- Linux server with Docker, Coolify v4 installed (Coolify's proxy = Traefik, running).
- **RAM**: beta (up to 5 personal vaults + `firma` = 6 vaults) worst case ~17 GiB for vaults + ~1.5 GiB for the rest → **32 GB**. Full size (15 users + `firma`) → **64 GB**, or ~16 GB once the model is unloaded after idle (follow-up item).
- Disk: ≥ 40 GB free (images ~2 GB, BGE-M3 model ~570 MB, vault data, Postgres).
- Outbound HTTPS to `huggingface.co` (first start, model download) and `api.eurouter.ai`.
- `jq`, `openssl`, `flock`, `git` on the host (for provisioning scripts).
- The address range `10.231.0.0/24` must be free on the host: `docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' | grep 10.231` must print nothing.

## 2. DNS

Base domain `LOKYY_DOMAIN`, e.g. `lokyy.example.de`. A records (or one wildcard `*.lokyy.example.de` plus `*.vault.lokyy.example.de`) to the server IP:

| Host | Purpose |
|---|---|
| `auth.<domain>` | Authentik |
| `mcp.<domain>` | MetaMCP admin UI + MCP endpoints |
| `firma.vault.<domain>` | company vault |
| `<user>.vault.<domain>` | one per beta user (the value of `VAULT_U<n>_USER`) |

Let's Encrypt HTTP-01 needs port 80 reachable for every host.

## 3. Checkout on the server (assets)

```bash
sudo install -d -o root -m 755 /opt/lokyy
cd /opt/lokyy && sudo git clone https://github.com/oliverhees/lokyy-brain-v2.git
cd lokyy-brain-v2 && sudo git checkout <release-tag-or-branch>
```

`LOKYY_ASSETS_DIR=/opt/lokyy/lokyy-brain-v2`. The Authentik blueprint, `deploy/stack/models` (prefetch manifest) and `deploy/stack/metamcp/init.sh` are mounted from here. Keep this checkout at the same commit Coolify deploys.

## 4. Environment and secrets

Generate on the server (never commit, never paste into chat or tickets):

```bash
umask 077
/opt/lokyy/lokyy-brain-v2/deploy/coolify/gen-env.sh lokyy.example.de anna ben carl ops@example.de /opt/lokyy/lokyy-brain-v2 > /root/lokyy.env
```

Usernames: **plain ASCII**, `^[a-z][a-z0-9-]*$`, no `@`, not `firma`/`auth`/`mcp` (the vault rejects `@` identities; provisioning and hostnames use the same name). Store `/root/lokyy.env` (mode 600) in the password manager as well; it is also the input for the scripts in sections 8–11.

Set `COOLIFY_PROXY_CIDR` to the subnet of the `coolify` network: `docker network inspect coolify -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`.

Coolify's magic variables (`SERVICE_PASSWORD_*`, `SERVICE_FQDN_*`) are deliberately not used: rotation and provisioning need known variable names, and the hostnames are routed by `lokyy-traefik`, not by Coolify-generated domains.

## 5. Coolify project

1. Projects → New → `lokyy-<company>` → environment `production`.
2. Add resource → Public/Private Repository → `oliverhees/lokyy-brain-v2`, branch/tag as in section 3.
3. Build pack **Docker Compose**, base directory `/`, compose file `/deploy/coolify/compose.yml`.
4. Do **not** assign domains to any service in the Coolify UI (routing is done by the labels on `lokyy-traefik`). Leave "Connect to predefined network" **off**.
5. Environment variables → Developer view → paste `/root/lokyy.env`. Mark all secrets as "locked/secret".
6. Deploy.

**STAGING CHECK (Coolify network rewrite):** Coolify's compose parser may add its own resource network to every service. That would put all vaults on one shared network and break isolation. After the first deploy:

```bash
for c in $(docker ps --filter label=lokyy.stack=lokyy -q) $(docker ps -q --filter name=vault-connector) ; do
  docker inspect -f '{{.Name}} {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"; done
```

Expected: each `vault-*` is on exactly `lokyy-web-<slot>`, `lokyy-mcp-<slot>`, `lokyy-egress`; `metamcp` on `lokyy-edge`, `lokyy-metamcp-internal`, `lokyy-mcp-upstream`; only `lokyy-traefik` on `coolify`. Any extra network (e.g. a UUID-named one) = **stop, do not onboard users**. Fallback: deploy the same compose file with plain `docker compose -p lokyy --env-file /root/lokyy.env -f deploy/coolify/compose.yml up -d --build` on the server (Coolify then only provides the proxy/TLS) and record that decision as an ADR.

## 6. First start

Order is enforced by `depends_on`: `model-prefetch` downloads and verifies the model (several minutes, fails loudly on checksum mismatch or without internet) → vaults start; `metamcp` healthy → `mcp-gate`, `metamcp-init` (creates the MetaMCP admin and closes self-registration).

Checks:

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'vault|metamcp|authentik|traefik|gate|connector'
docker logs $(docker ps -aq --filter name=model-prefetch) | tail -5      # must end successfully
curl -sI https://auth.lokyy.example.de/ | head -1                           # 200/302 with valid TLS
curl -s -o /dev/null -w '%{http_code}\n' https://anna.vault.lokyy.example.de/   # 302 to auth (not 200, not 404)
curl -s -o /dev/null -w '%{http_code}\n' http://anna.vault.lokyy.example.de/    # 308 to https
```

Right after the first start the vault routes answer `404` until Authentik has applied the blueprint. If it ends in `error`, re-apply: `docker exec <authentik-worker> ak apply_blueprint custom/lokyy-beta.yaml`.

## 7. Authentik: admin, beta users, groups

General procedure: [`deploy/stack/README.md` → Add a user](../deploy/stack/README.md#add-a-user). Coolify differences: users get a **slot** (`u1`…`u3`) instead of an own vault service, access is the group `vault-u<n>-access` (no per-user blueprint binding), URLs are `https://<user>.vault.<domain>` instead of `http://<user>.vault.localhost:18080`, and a new slot user needs `VAULT_U<n>_USER` set in Coolify plus a redeploy.

1. `https://auth.<domain>/if/admin/` → login `akadmin` / `AUTHENTIK_ADMIN_PASS`. Set up MFA (TOTP/WebAuthn) for `akadmin` immediately.
2. Directory → Users → Create for each beta user. **Username exactly as `VAULT_U<n>_USER`** (plain ASCII, no `@`), real e-mail. Send a recovery link instead of setting a password.
3. Groups per user:

| User | Groups |
|---|---|
| slot u1 user | `vault-u1-access`, `vault-u1-admin` (if they may change their vault settings) |
| slot u2 user | `vault-u2-access`, `vault-u2-admin` |
| slot u3 user | `vault-u3-access`, `vault-u3-admin` |
| company writers | `vault-firma-write` (+ `vault-firma-admin` for one responsible person) |
| company readers | `vault-firma-read` (MCP read-only, no company web UI) |
| operators | `lokyy-admins` (MetaMCP admin UI, admin on every vault) |

Exactly one user per `vault-u<n>-access` group — the group is the access boundary of a personal vault.

**STAGING CHECK (groups header):** log in as a slot user, open the vault, and verify the vault receives the groups (settings page allows config changes only for admin-group members; a non-admin gets `403` on saving config). The vault splits `X-authentik-groups` on `|`.

**STAGING CHECK (cookie SameSite / Google callback):** vault Google connect (`/api/google/auth/callback`) comes back via a cross-site redirect from Google. Authentik's forward-auth session cookie must survive it (SameSite=Lax is fine for top-level GET redirects; `Strict` breaks it). Test the Google connect flow once end to end on a vault; if the callback lands on the Authentik login, record it on the Plane item and do not offer Google sync in the beta.

## 8. Operator shell for the scripts

The provisioning scripts from `deploy/stack` run `docker compose` in `deploy/stack` and source `deploy/stack/.env`. On the server:

```bash
cd /opt/lokyy/lokyy-brain-v2/deploy/stack
install -m 600 /root/lokyy.env .env                     # gitignored
export COMPOSE_PROJECT_NAME=<coolify-resource-uuid>     # docker ps --filter name=metamcp --format '{{.Label "com.docker.compose.project"}}'
export COMPOSE_FILE=/data/coolify/applications/<uuid>/docker-compose.yaml   # Coolify's rendered file
export METAMCP_PUBLIC_BASE=https://mcp.lokyy.example.de
docker compose ps                                        # must list the Lokyy services
```

**STAGING CHECK:** confirm the rendered compose path and that `docker compose exec metamcp true` works with these variables. With the plain-compose fallback use `COMPOSE_PROJECT_NAME=lokyy` and `COMPOSE_FILE=../coolify/compose.yml`.

## 9. users.json and MCP provisioning

```bash
cp ../coolify/users.example.json users.beta.json   # edit: username = Authentik username, vault = slot
USERS_FILE=users.beta.json metamcp/provision.sh
```

- `vault` is the slot (`u1`…), therefore `"allowVaultNameMismatch": true` per user. `role`: `writer` or `reader` for the company vault — keep it consistent with the Authentik groups (`vault-firma-write` / `vault-firma-read`).
- Output: `secrets/metamcp-clients.json` (mode 600) with URL `https://mcp.<domain>/metamcp/<user>/mcp` and API key per user. Hand out each key individually over a secure channel (password manager share), never by e-mail/chat in plain text.
- Re-running is idempotent; removing a user from the file removes their MetaMCP account, endpoint and key.

## 10. EUrouter key

In `deploy/stack/.env` (server only), not in Coolify:

```bash
EUROUTER_MODEL=qwen3.6-27b          # id from https://api.eurouter.ai/api/v1/models
EUROUTER_API_KEY_U1=...             # recommended: one key per vault with its own spend limit
EUROUTER_API_KEY_FIRMA=...
# or a shared fallback: EUROUTER_API_KEY=...
```

```bash
llm/configure-eurouter.sh --dry-run   # which vault uses which key source (never values)
llm/configure-eurouter.sh
```

Per-vault keys are recommended: a leaked key or one heavy user cannot exhaust the whole budget, and one vault can be revoked alone. Note: `GET /api/config` shows the key to anyone who can open that vault's web UI — another reason for per-vault keys.

## 11. Connecting an MCP client

Follow [`deploy/stack/README.md` → Connect an MCP client](../deploy/stack/README.md#connect-an-mcp-client) (Claude Code, Claude Desktop). Coolify difference: the URL is `https://mcp.<domain>/metamcp/<user>/mcp` (TLS, real domain) instead of `http://mcp.localhost:18080/metamcp/<user>/mcp`; the API key comes from `secrets/metamcp-clients.json` on the server (section 9). Header `Authorization: Bearer <api-key>`; query-string keys are disabled.

The user sees two servers: `<user>-vault` (own vault, all tools) and `<user>-firma` (company vault; readers get only the read tools).

## 12. Smoke tests (before every beta user gets access)

**Never run `tests/metamcp-attacks.sh` (or `tests/isolation.sh`) against the live beta:** the attack suite rotates keys, removes and re-creates users and restarts MetaMCP; both suites also assume demo users and `*.localhost:18080`. Follow-up: a read-only, parameterised server smoke suite. Minimum manual checks, record results on the Plane item:

| # | Check | Expected |
|---|---|---|
| 1 | Anonymous `GET https://<user>.vault.<domain>/` | `302` to `auth.<domain>` |
| 2 | User A logs in, opens user B's vault URL | Authentik "permission denied" |
| 3 | Reader opens `firma.vault.<domain>` | denied; writer: allowed |
| 4 | Non-admin opens `https://mcp.<domain>/` | denied |
| 5 | `curl -H 'X-authentik-username: <other>' https://<user>.vault.<domain>/api/health` without session | `302` login |
| 6 | `curl -X POST https://mcp.<domain>/metamcp/<user>/mcp` without key / with another user's key | `401` both |
| 7 | MCP client of a reader calls `create_note` on `<user>-firma` | rejected, nothing written |
| 8 | Writer creates a note in the company vault via MCP | visible in `firma` web UI |
| 9 | From a vault: `docker exec <vault-u1> node -e "fetch('http://vault-u2:4321').then(()=>console.log('OPEN'),()=>console.log('blocked'))"` | `blocked` (and for `authentik-server:9000`, `metamcp-db:5432`) |
| 10 | Network topology (section 5 command) | exactly the expected networks |
| 11 | `docker ps --format '{{.Names}} {{.Ports}}'` for Lokyy containers | no published host ports |
| 12 | Host egress (section 14 rule applied): from a vault, `fetch('http://169.254.169.254/')` and `fetch('http://<host-ip>:8000/')` (Coolify UI) | both blocked; `fetch('https://api.eurouter.ai/api/v1/models')` works |
| 13 | Chat with a text question in a vault (EUrouter key set) | answer; PDF chat: see limitations |

## 13. Sizing and memory (LBV2-20, measured)

| Service | Memory |
|---|---|
| vault idle | ~200 MiB |
| vault with BGE-M3 loaded (after first search / indexing) | peak 2.62 GiB, stays resident until restart |
| authentik-server / worker | ~700 MiB / ~310 MiB |
| metamcp | ~240 MiB |
| Postgres (each), Traefik | < 100 MiB, ~30 MiB |

Limits in the template: vaults `3500m`, metamcp `1536m`, mcp-gate / vault-connector `128m`, Authentik `1g` each, Postgres `512m`, lokyy-traefik `256m`. A vault hitting its limit is OOM-killed and restarted by Docker (`restart: unless-stopped`); watch `docker inspect -f '{{.State.OOMKilled}}'`.

## 14. Host egress blocking (required before beta)

Vaults reach the internet through `lokyy-egress` (`10.231.9.0/28`). Without extra rules they can also reach services on the Docker host (Coolify UI on :8000, Coolify's Postgres/Redis if published, SSH) and cloud metadata endpoints. Block everything except public internet:

```bash
EG=10.231.9.0/28; MG=10.231.10.0/28
for NET in $EG $MG; do
  # traffic to the host itself (any host IP, incl. the bridge gateway) goes through INPUT
  iptables -I INPUT -s $NET -j DROP
  # forwarded traffic: metadata + private ranges (other containers, LAN, other Coolify apps)
  iptables -I DOCKER-USER -s $NET -d 169.254.0.0/16 -j DROP
  iptables -I DOCKER-USER -s $NET -d 10.0.0.0/8 -j DROP
  iptables -I DOCKER-USER -s $NET -d 172.16.0.0/12 -j DROP
  iptables -I DOCKER-USER -s $NET -d 192.168.0.0/16 -j DROP
  iptables -I DOCKER-USER -s $NET -d 100.64.0.0/10 -j DROP
  iptables -I DOCKER-USER -s $NET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done
apt-get install -y iptables-persistent && netfilter-persistent save
```

Container DNS uses Docker's embedded resolver inside the container namespace, so dropping host INPUT does not break name resolution. **STAGING CHECK:** verify with smoke test 12, and after a Docker/Coolify restart confirm the rules are still in place (`iptables -S DOCKER-USER`, `iptables -S INPUT | grep 10.231`). IPv6: if the server has IPv6 and Docker `ipv6` is enabled for these networks, add equivalent `ip6tables` rules (the template does not enable IPv6).

## 15. Rotation

- Access secrets (MCP tokens, read-only token, proxy secrets) after suspected exposure, e.g. of the MetaMCP DB: generate new values for `MCP_TOKEN_*`, `MCP_READONLY_TOKEN_FIRMA`, `PROXY_SECRET_*` (`openssl rand -hex 32`), update them **in Coolify and in `deploy/stack/.env`**, redeploy in Coolify, then `metamcp/provision.sh --rotate-all` and hand out the new keys. MCP clients are down between redeploy and provisioning. (`deploy/stack/rotate-secrets.sh` only edits the local `.env` and restarts via compose; on Coolify the env lives in Coolify, so do the steps by hand.)
- One user's API key: `USERS_FILE=users.beta.json metamcp/provision.sh --rotate <user>`.
- Authentik secret key, DB passwords, `METAMCP_AUTH_SECRET`: separate maintenance window; changing Postgres passwords also requires `ALTER USER` inside the DB.
- EUrouter keys: revoke at EUrouter, set new key, `llm/configure-eurouter.sh <vault>`.

## 16. Backup

Named volumes (Coolify prefixes them with the resource UUID; list with `docker volume ls | grep -E 'vault-|authentik-db|metamcp-db'`):

| Volume | Content | Note |
|---|---|---|
| `vault-u<n>`, `vault-firma` | vault data (`/data`: wiki, raw, config incl. EUrouter key) | critical |
| `vault-*-home` | tesseract cache | optional |
| `authentik-db` | users, groups, MFA | critical; use `pg_dump` |
| `metamcp-db` | MetaMCP accounts, **API keys and vault tokens in plain text** | encrypt the backup |
| `models` | re-downloadable | skip |

```bash
# consistent Postgres dumps
docker exec <authentik-db> pg_dump -U authentik authentik | gzip > authentik-$(date +%F).sql.gz
docker exec <metamcp-db> pg_dump -U metamcp metamcp | gzip | age -r <recipient> > metamcp-$(date +%F).sql.gz.age
# vault data (stop the vault briefly for a consistent copy)
docker stop <vault-u1> && docker run --rm -v <uuid>_vault-u1:/v:ro -v /backup:/b alpine tar czf /b/vault-u1-$(date +%F).tgz -C /v . && docker start <vault-u1>
```

Keep backups encrypted and off the server (e.g. restic to a storage box); also back up `/root/lokyy.env` and `deploy/stack/.env` to the password manager. Test one restore before the beta starts.

## 17. Rollback

1. Coolify → Deployments → redeploy the previous successful deployment (same env). The `:beta` images are rebuilt from that commit; also `git checkout` the matching commit in `/opt/lokyy/lokyy-brain-v2` (blueprint/manifest must match).
2. Data-shape changes are not reversible by redeploy: restore volumes / DB dumps from section 16 (stop the stack first).
3. Emergency stop (keeps data): Coolify → Stop. Volumes remain.

## 18. Known limitations for the beta

- **MetaMCP stores API keys and vault bearer tokens in plain text** in `metamcp-db` (accepted risk, see `deploy/stack/README.md`): DB stays on an internal network, backups encrypted, rotate everything on suspected exposure.
- **Embedding model stays loaded** after the first search (~2.6 GiB per vault until restart); reindex happens only on server start. Model unload after idle is a follow-up.
- **PDF chat via EUrouter is untested** without a real key (the OpenAI adapter uses `/v1/responses` for document blocks; EUrouter's route answers `400` to empty requests).
- `GET /api/config` returns the vault's EUrouter key to everyone with web access to that vault.
- The stack attack suites are not yet runnable against the server (localhost URLs, demo users); only the manual smoke tests in section 12 apply.
- Adding a vault slot (u4, u5) is a manual template change: copy a vault block, its `web-`/`mcp-` networks (new subnets), volumes, `vault-connector` networks/aliases/`CONNECTOR_VAULTS`, the `lokyy-traefik` networks and host rules, blueprint group/provider/application/binding/outpost entries, and the env variables.
- Open hardening items are tracked in **LBV2-24**.
- Coolify-specific items not verified yet (all marked **STAGING CHECK** above): network rewrite by Coolify's compose parser, rendered compose path for the scripts, Authentik cookie SameSite with the Google callback, groups header reaching the vault, host egress rules surviving restarts, `COOLIFY_PROXY_CIDR` value, coolify-proxy ignoring the inner routers (they use entrypoint `web`, which coolify-proxy does not have — expect "entryPoint web doesn't exist" warnings in its log and confirm no Lokyy host is served without passing `lokyy-traefik`).
