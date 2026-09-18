# Beta runbook: one company server on Coolify (LBV2-16)

Scope: one server for one company, at most 15 users; the beta runs 3–5 users plus one company vault. The template is `deploy/coolify/compose.yml`. It is derived from the locally verified stack in `deploy/stack/` (see its README for the full security model and the attack suites). Default deployment: plain `docker compose` on the host behind coolify-proxy (section 5). Nothing in this runbook has been run on a real server yet: steps marked **STAGING CHECK** must be done and recorded on the Plane item before beta users get access.

## 0. Differences to `deploy/stack`

Every difference is marked `COOLIFY:` in the compose file.

| Difference | Why |
|---|---|
| Inner Traefik (`lokyy-traefik`) publishes no port; it joins the external `coolify` network and carries labels for Coolify's proxy (`https` entrypoint, `letsencrypt` resolver, HTTP→HTTPS redirect) | Coolify's proxy owns ports 80/443 and TLS. Keeping our own Traefik behind it keeps the verified routing model (forward-auth, per-vault networks, proxy secrets, mcp-gate) byte-for-byte; only `lokyy-traefik` touches the shared `coolify` network |
| Provider constraint on label `lokyy.stack=<LOKYY_STACK_ID>` instead of `com.docker.compose.project` | Coolify sets the compose project name to the resource UUID |
| `forwardedHeaders.trustedIPs=${COOLIFY_PROXY_IP}/32` on the inner entrypoint | Client IP comes from coolify-proxy; trust forwarded headers only from that one container, not the whole shared `coolify` network |
| Per-router `<router>-fwd` headers middleware before `authentik@docker` (vault routers, MetaMCP admin router) sets `X-Forwarded-Host` to the router's own host and `X-Forwarded-Proto=https` | Forward-auth selects the Authentik provider by `X-Forwarded-Host`; a forged value must not pick another vault's provider. The mcp-gate route has no forward-auth (API keys) and needs no pinning |
| Deployed as plain `docker compose -p lokyy` on the host, not as a Coolify Compose resource | Coolify attaches a resource network to every service of a Compose resource, which would void the per-vault isolation |
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

`LOKYY_ASSETS_DIR=/opt/lokyy/lokyy-brain-v2`. The Authentik blueprint, `deploy/stack/models` (prefetch manifest) and `deploy/stack/metamcp/init.sh` are mounted from here. `deploy/stack/users.beta.json` is mounted into `mcp-gate` too (its session cap = users × 20 × 1.25, min 100): **create it (section 9, first command) before the first deploy** — if it is missing, Docker creates a directory at that path and the gate falls back to the minimum cap (log line `WARN mcp-gate: users file not readable`). After adding users, recreate the gate: `docker compose -p lokyy --env-file /root/lokyy.env -f deploy/coolify/compose.yml up -d --force-recreate mcp-gate`. This checkout is also what section 5 builds and deploys.

## 4. Environment and secrets

Generate on the server (never commit, never paste into chat or tickets):

```bash
umask 077
/opt/lokyy/lokyy-brain-v2/deploy/coolify/gen-env.sh lokyy.example.de anna ben carl ops@example.de /opt/lokyy/lokyy-brain-v2 > /root/lokyy.env
```

Usernames: **plain ASCII** (`a-z`, `0-9`, `-`), 2–31 characters, starting with a letter, no `--`, no trailing `-`, no `@`, no umlauts; reserved (any case): `unknown`, `firma`, `auth`, `mcp`. Same rule as provisioning; `gen-env.sh` enforces it and also validates domain, e-mail and assets path. Store `/root/lokyy.env` (mode 600) in the password manager as well; it is also the input for the scripts in sections 8–11.

Set `COOLIFY_PROXY_IP` (mandatory) to the IP of the coolify-proxy container on the `coolify` network. The inner Traefik trusts `X-Forwarded-*` only from that single address (`/32`):

```bash
docker inspect coolify-proxy -f '{{(index .NetworkSettings.Networks "coolify").IPAddress}}'
```

**Re-check `COOLIFY_PROXY_IP` after every coolify-proxy restart/recreate, Docker daemon restart, Coolify upgrade or server reboot** (the address can change). Symptom of a stale value: every MCP client shares one rate-limit bucket (429 for everyone under load) and logged client IPs are the proxy's. Fix: update `COOLIFY_PROXY_IP` in `/root/lokyy.env`, then recreate the inner Traefik: `docker compose -p lokyy --env-file /root/lokyy.env -f deploy/coolify/compose.yml up -d --force-recreate lokyy-traefik`. Headers from any other peer are overwritten by Traefik; `X-Forwarded-Host`/`-Proto` are additionally pinned per router (see section 0 and smoke test 14).

Coolify's magic variables (`SERVICE_PASSWORD_*`, `SERVICE_FQDN_*`) are deliberately not used: rotation and provisioning need known variable names, and the hostnames are routed by `lokyy-traefik`, not by Coolify-generated domains.

## 5. Deploy: plain `docker compose` behind coolify-proxy (default)

Coolify attaches its own resource network to **every** service of a Docker Compose resource. That would put all vaults, MetaMCP and the databases on one shared network and void the isolation model. Therefore the default is: **Coolify only provides the proxy and TLS; the stack runs as a plain compose project on the host.** Do not create a Coolify "Docker Compose" resource from this repository.

```bash
cd /opt/lokyy/lokyy-brain-v2
docker compose -p lokyy --env-file /root/lokyy.env -f deploy/coolify/compose.yml up -d --build
```

coolify-proxy discovers `lokyy-traefik` through its labels (Docker provider, shared `coolify` network) and requests the certificates. Updates: `git pull` / `git checkout <tag>` in the checkout, then the same command.

Documented alternative: a Coolify **"Docker Compose Empty" / Raw Compose Deployment** resource with this file's content, only if the network verification below passes unchanged. If it shows any extra network, delete that resource and use the default path.

### Mandatory network verification (after every deploy, before any user access)

```bash
for s in lokyy-traefik authentik-server authentik-worker authentik-db metamcp metamcp-db mcp-gate vault-connector vault-u1 vault-u2 vault-u3 vault-firma; do
  printf '%s: ' "$s"
  docker inspect "$(docker compose -p lokyy -f deploy/coolify/compose.yml ps -q "$s")" \
    -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sort | xargs
done
```

Expected output, exactly (any additional network, e.g. a UUID-named one or `coolify` on another service = **stop, do not onboard users**):

```
lokyy-traefik: coolify lokyy-edge lokyy-web-firma lokyy-web-u1 lokyy-web-u2 lokyy-web-u3
authentik-server: lokyy-authentik-internal lokyy-edge
authentik-worker: lokyy-authentik-internal
authentik-db: lokyy-authentik-internal
metamcp: lokyy-edge lokyy-mcp-upstream lokyy-metamcp-internal
metamcp-db: lokyy-metamcp-internal
mcp-gate: lokyy-edge
vault-connector: lokyy-mcp-firma lokyy-mcp-u1 lokyy-mcp-u2 lokyy-mcp-u3 lokyy-mcp-upstream
vault-u1: lokyy-egress lokyy-mcp-u1 lokyy-web-u1
vault-u2: lokyy-egress lokyy-mcp-u2 lokyy-web-u2
vault-u3: lokyy-egress lokyy-mcp-u3 lokyy-web-u3
vault-firma: lokyy-egress lokyy-mcp-firma lokyy-web-firma
```

Also check that each network has only the expected members, e.g. `docker network inspect lokyy-web-u1 -f '{{range .Containers}}{{.Name}} {{end}}'` → `lokyy-traefik` and `vault-u1` only. Record the output on the Plane item.

Before deploying a changed template, run the static checks locally: `deploy/coolify/tests/config-check.sh` (renders the compose file with random values; asserts no published ports, network membership, pinned forwarded headers, `/32` trust).

## 6. First start

Deploy with the section 5 command. Order is enforced by `depends_on`: `model-prefetch` downloads and verifies the model (several minutes, fails loudly on checksum mismatch or without internet) → vaults start; `metamcp` healthy → `mcp-gate`, `metamcp-init` (creates the MetaMCP admin and closes self-registration).

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

General procedure: [`deploy/stack/README.md` → Add a user](../deploy/stack/README.md#add-a-user). Differences on this server: each user gets a **slot** (`u1`…`u3`) instead of an own vault service; web access comes from membership in the group `vault-u<n>-access` (no per-user blueprint binding); URLs are `https://<user>.vault.<domain>` instead of `http://<user>.vault.localhost:18080`. For a new slot user, set `VAULT_U<n>_USER` in `/root/lokyy.env` and redeploy (section 5).

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
export COMPOSE_PROJECT_NAME=lokyy
export COMPOSE_FILE=/opt/lokyy/lokyy-brain-v2/deploy/coolify/compose.yml
export METAMCP_PUBLIC_BASE=https://mcp.lokyy.example.de
docker compose ps                                        # must list the Lokyy services
docker compose exec metamcp true && echo exec-ok
```

(With the Raw Compose alternative, use the project name and rendered file path Coolify shows for the resource.)

## 9. users.json and MCP provisioning

```bash
cp ../coolify/users.example.json users.beta.json   # edit: username = Authentik username, vault = slot
USERS_FILE=users.beta.json metamcp/provision.sh
```

- `vault` is the slot (`u1`…), therefore `"allowVaultNameMismatch": true` per user. `role`: `writer` or `reader` for the company vault — keep it consistent with the Authentik groups (`vault-firma-write` / `vault-firma-read`).
- Output: `secrets/metamcp-clients.json` (mode 600) with URL `https://mcp.<domain>/metamcp/<user>/mcp` and API key per user. Hand out each key individually over a secure channel (password manager share), never by e-mail/chat in plain text.
- Re-running is idempotent; removing a user from the file removes their MetaMCP account, endpoint and key.

## 10. EUrouter key

In `deploy/stack/.env` (server only, never in `/root/lokyy.env`):

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

Per-vault keys are recommended: a leaked key or one heavy user cannot exhaust the whole budget, and one vault can be revoked alone.

Route (routing rule): an admin picks it in the vault's Settings → Provider → EUrouter → Route; it is stored as `ruleId` and sent as `rule_id`. `configure-eurouter.sh` keeps an existing `ruleId` (it only merges provider, base URL, model and key). See `docs/self-hosting-mcp-http.md#eurouter-routes-routing-rules`. Note: `GET /api/config` shows the key to anyone who can open that vault's web UI — another reason for per-vault keys.

## 11. Connecting an MCP client

Follow [`deploy/stack/README.md` → Connect an MCP client](../deploy/stack/README.md#connect-an-mcp-client) (Claude Code, Claude Desktop). Coolify difference: the URL is `https://mcp.<domain>/metamcp/<user>/mcp` (TLS, real domain) instead of `http://mcp.localhost:18080/metamcp/<user>/mcp`; the API key comes from `secrets/metamcp-clients.json` on the server (section 9). Header `Authorization: Bearer <api-key>`; query-string keys are disabled.

The user sees two servers: `<user>-vault` (own vault, all tools) and `<user>-firma` (company vault; readers get only the read tools).

**Troubleshooting MCP clients (mcp-gate responses):**

| Status | Meaning | What to do |
|---|---|---|
| `401` | Missing, wrong, rotated or removed key; also a session the gate does not know for this key and endpoint (e.g. after a gate or MetaMCP restart, or a key rotation) | Check the key; clients re-initialize automatically |
| `400` | Request without session that is not a single `initialize` | Client bug or wrong transport |
| `429` + `Retry-After` | Too many `initialize` requests for this key (burst 5, then 1/s), or too many open streams (2 per session, 10 per key) | Wait `Retry-After` seconds; close unused sessions. A loop of reconnects usually means the key is wrong |
| `503` | The gate's session table is full (users × 20 × 1.25) — new keys are refused, nobody is evicted | Check `docker compose -p lokyy --env-file /root/lokyy.env -f deploy/coolify/compose.yml logs mcp-gate` for `WARN bindings`; recreate `mcp-gate` after adding users to `users.beta.json` |

MetaMCP itself allows only one open `GET` stream per session (a second one gets `409`, shown to the client as the gate's static error); the gate's stream caps are an upper bound on top of that. Every `--rotate` and every access change restarts MetaMCP: all clients reconnect once.

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
| 14 | Forged forwarded host, no session: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "X-Forwarded-Host: ben.vault.<domain>" https://anna.vault.<domain>/`; logged in as anna, the same request with anna's cookies against `ben` (`-H "X-Forwarded-Host: anna.vault.<domain>" https://ben.vault.<domain>/`) | `302` whose redirect names **anna's** host (first case) / `302` login or `403` (second case), never `200` from the other vault |

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

- Access secrets (MCP tokens, read-only token, proxy secrets) after suspected exposure, e.g. of the MetaMCP DB: generate new values for `MCP_TOKEN_*`, `MCP_READONLY_TOKEN_FIRMA`, `PROXY_SECRET_*` (`openssl rand -hex 32`), update them **in `/root/lokyy.env` and `deploy/stack/.env`**, redeploy (section 5 command), then `metamcp/provision.sh --rotate-all` and hand out the new keys. MCP clients are down between redeploy and provisioning. (`deploy/stack/rotate-secrets.sh` edits only `deploy/stack/.env` and uses the local stack's compose file, so do the steps by hand.)
- One user's API key: `USERS_FILE=users.beta.json metamcp/provision.sh --rotate <user>`. This restarts MetaMCP (all MCP clients reconnect) so no session of the old key survives; the gate also drops a session as soon as MetaMCP rejects its key.
- Authentik secret key, DB passwords, `METAMCP_AUTH_SECRET`: separate maintenance window; changing Postgres passwords also requires `ALTER USER` inside the DB.
- EUrouter keys: revoke at EUrouter, set new key, `llm/configure-eurouter.sh <vault>`.

## 16. Backup

Named volumes are prefixed with the compose project name: with the default `-p lokyy` they are `lokyy_vault-u1`, `lokyy_authentik-db`, … (only a Coolify Raw Compose resource uses its UUID as prefix). List: `docker volume ls | grep -E '^local +lokyy_'`.

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
docker stop <vault-u1> && docker run --rm -v lokyy_vault-u1:/v:ro -v /backup:/b alpine tar czf /b/vault-u1-$(date +%F).tgz -C /v . && docker start <vault-u1>
```

Keep backups encrypted and off the server (e.g. restic to a storage box); also back up `/root/lokyy.env` and `deploy/stack/.env` to the password manager. Test one restore before the beta starts.

## 17. Rollback

1. `git checkout <previous-tag>` in `/opt/lokyy/lokyy-brain-v2`, then the section 5 deploy command (`:beta` images are rebuilt from that commit; blueprint and manifest match automatically). Run the network verification again.
2. Data-shape changes are not reversible by redeploy: restore volumes / DB dumps from section 16 (stop the stack first).
3. Emergency stop (keeps data): `docker compose -p lokyy -f deploy/coolify/compose.yml stop`. Volumes remain.

## 18. Known limitations for the beta

- **MetaMCP stores API keys and vault bearer tokens in plain text** in `metamcp-db` (accepted risk, see `deploy/stack/README.md`): DB stays on an internal network, backups encrypted, rotate everything on suspected exposure.
- **Embedding model stays loaded** after the first search (~2.6 GiB per vault until restart); reindex happens only on server start. Model unload after idle is a follow-up.
- **PDF chat via EUrouter** sends locally extracted text (no figures/layout) via chat completions with the route; text longer than `maxContextChars` (default 50000 characters) is refused. `/v1/responses` is never used for EUrouter.
- `GET /api/config` returns the vault's EUrouter key to everyone with web access to that vault.
- The stack attack suites are not yet runnable against the server (localhost URLs, demo users); only the manual smoke tests in section 12 apply.
- Adding a vault slot (u4, u5) is a manual template change: copy a vault block, its `web-`/`mcp-` networks (new subnets), volumes, `vault-connector` networks/aliases/`CONNECTOR_VAULTS`, the `lokyy-traefik` networks and host rules, blueprint group/provider/application/binding/outpost entries, and the env variables.
- Open hardening items are tracked in **LBV2-24**.
- Items not verified on a real server yet (marked **STAGING CHECK** above, plus the mandatory network verification in section 5): Authentik cookie SameSite with the Google callback, groups header reaching the vault, host egress rules surviving restarts, `COOLIFY_PROXY_IP` stability across proxy restarts, coolify-proxy ignoring the inner routers (they use entrypoint `web`, which coolify-proxy does not have — expect "entryPoint web doesn't exist" warnings in its log and confirm no Lokyy host is served without passing `lokyy-traefik`).
