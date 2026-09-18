# Deploy Lokyy Brain in Coolify

One company server, one Coolify application. You enter two values (`BASE_DOMAIN`, `ADMIN_EMAIL`); Coolify generates every secret, the first start sets everything up, and the setup portal at `https://app.<BASE_DOMAIN>` does the rest (users, slots, MCP keys).

| Package | Compose file | Personal vaults | RAM (all vaults + shared embedding service, limits) |
|---|---|---|---|
| S | `deploy/coolify/compose-s.yml` | 15 slots (`v01`–`v15`) + company vault `firma` | 16 × 1 GB + 4 GB → 24 GB recommended |
| M | `deploy/coolify/compose-m.yml` | 30 slots (`v01`–`v30`) + `firma` | 31 × 1 GB + 4 GB → 48 GB recommended |

Server: Coolify v4 with its proxy (Traefik) running, ≥ 40 GB free disk, outbound HTTPS to `huggingface.co` (model download on first start) and `api.eurouter.ai`. The address range `10.231.0.0/16` must be unused by other Docker networks on the server (see "Settings you normally leave alone").

## Deploy (7 steps)

1. **DNS:** one wildcard record `*.<BASE_DOMAIN>` (A/AAAA) pointing to the server, e.g. `*.lokyy.example.de`. Port 80 must be reachable for the Let's Encrypt HTTP-01 challenge (one certificate per host).
2. **New application:** in Coolify, *+ New → Application → Public/Private GitHub repository* `oliverhees/lokyy-brain-v2`, branch `main` (or a release tag).
3. **Build pack:** *Docker Compose*. **Docker Compose location:** `/deploy/coolify/compose-s.yml` (package S) or `/deploy/coolify/compose-m.yml` (package M).
4. **Raw mode ON** ("Deploy the compose file as is") and **"Connect to predefined network" OFF.** Both are required: otherwise Coolify joins every service to one shared network and the per-vault isolation is gone. Do not set domains on the services; routing is done by the compose file.
5. **Environment variables:** set `BASE_DOMAIN` (e.g. `lokyy.example.de`, lower-case, no `https://`) and `ADMIN_EMAIL`. Leave every `SERVICE_*` variable as Coolify generated it.
6. **Deploy.** The first deploy builds the images and downloads the embedding model (several minutes). Everything else is automatic: Authentik admin, blueprint (groups, vault apps, forward-auth), MetaMCP admin with self-registration closed, model verification (SHA-256), MCP gate.
7. **Log in:** open `https://app.<BASE_DOMAIN>` and sign in with `ADMIN_EMAIL` and the password from Coolify → your application → *Environment Variables* → `SERVICE_PASSWORD_ADMIN`. MFA is mandatory for administrators: on this first login Authentik walks you through setting up an authenticator app (TOTP) or a security key (WebAuthn); every later admin login asks for it. Employees log in with their password only. The portal guides you through adding people and assigning slots.

Hosts: `app.` (setup portal), `auth.` (Authentik), `mcp.` (MetaMCP admin + MCP endpoints `/metamcp/<user>/mcp`), `firma.` (company vault), `v01.`…`v15`/`v30.` (personal vaults, one person per slot).

## Optional one-time hardening: host egress firewall (recommended before real data)

Vaults need the internet (EUrouter) through the `egress` network (`10.231.1.0/26`), the model download uses `model-egress` (`10.231.0.64/28`). Without extra rules both can also reach services on the Docker host (Coolify UI, SSH) and cloud metadata endpoints. As root on the server:

```bash
for NET in 10.231.1.0/26 10.231.0.64/28; do
  iptables -I INPUT -s $NET -j DROP
  for DST in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
    iptables -I DOCKER-USER -s $NET -d $DST -j DROP
  done
  iptables -I DOCKER-USER -s $NET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done
apt-get install -y iptables-persistent && netfilter-persistent save
```

Check: `docker exec <vault-v01 container> node -e "fetch('http://169.254.169.254/').then(()=>console.log('OPEN'),()=>console.log('blocked'))"` prints `blocked`; `fetch('https://api.eurouter.ai/api/v1/models')` still works. Re-check after Docker or Coolify upgrades (`iptables -S DOCKER-USER`).

## Upgrade S → M

**Only upward.** M → S is not supported: slots `v16`–`v30` would lose their services while their volumes and Authentik users stay behind. To shrink, export the data of those slots, remove their people in the portal, then create a fresh S application.

In the same Coolify application change *Docker Compose location* to `/deploy/coolify/compose-m.yml` and deploy. Volumes, users, slots and MCP keys stay; Coolify generates the magic variables of the new slots. The new hosts (`v16.`–`v30.`) answer `404` until Authentik has applied the updated blueprint (measured ~6–10 minutes after the deploy); existing slots keep working meanwhile. Never delete and re-create the application for an upgrade: the volumes belong to it.

## Where things are

| What | Where |
|---|---|
| Admin password | Coolify env `SERVICE_PASSWORD_ADMIN` (user `akadmin`, e-mail `ADMIN_EMAIL`) |
| All other secrets | Coolify env `SERVICE_*` (vault MCP tokens `SERVICE_HEX_64_MCP<SLOT>`, proxy secrets `SERVICE_HEX_64_PROXY<SLOT>`, the portal's Authentik service-account token `SERVICE_HEX_64_PORTALAKTOKEN`, …). Never change one by hand without the rotation procedure below |
| Slot → person assignment, MCP keys | the portal: its private volume `lokyy-state` (`users.json`, mode 600) and MetaMCP (`metamcp-db`) |
| Vault data | volumes `vault-<slot>` (and `vault-<slot>-home`), `vault-firma` |
| Users, groups, MFA | volume `authentik-db` |
| MCP accounts and keys (plain text) | volume `metamcp-db` — encrypt its backups |

Volume names are prefixed with the application's UUID (`docker volume ls | grep <uuid>`).

## Settings you normally leave alone

| Variable | Default | When to set |
|---|---|---|
| `LOKYY_NET_PREFIX` | `10.231` | Another Docker network on the server already uses `10.231.x.x`. Set e.g. `10.232` **before the first deploy**, and adjust the firewall rules above |
| `LOKYY_TRUSTED_PROXY_CIDRS` | the `coolify` network's subnet, detected at start | Which peers may set `X-Forwarded-For` (client IP for MCP rate limits and Authentik's per-IP throttling). Set it only to narrow further, e.g. to coolify-proxy's address `/32`. Never add `LOKYY_NET_PREFIX` ranges: vaults could then forge client IPs. Host and scheme are pinned per route regardless. `lokyy-traefik` refuses to start if it cannot tell which network is Coolify's |
| `VAULT_MEM_LIMIT` | `3500m` | Per-vault memory limit (LBV2-20: idle ~200 MiB, peak 2.6 GiB with the embedding model loaded) |

## Operations

- **Health:** in Coolify all services except `model-prefetch` and `metamcp-init` (one-shot, "exited 0") must be running/healthy. Right after a deploy vault hosts may answer `404` for a few minutes until the Authentik worker has applied the blueprint. `https://v01.<BASE_DOMAIN>/` must answer with a redirect to `auth.` — never with vault content.
- **Rotation after suspected exposure** (MCP tokens, proxy secrets): delete the affected `SERVICE_*` variables in Coolify so it generates new ones, redeploy, then re-run provisioning from the portal (hands out new MCP keys). Authentik secret key and database passwords: maintenance window only (Postgres passwords also need `ALTER USER` inside the database).
- **Backup:** `pg_dump` of `authentik-db` and `metamcp-db` (the latter encrypted), tar of the `vault-*` volumes (stop the vault briefly for a consistent copy). Test one restore before onboarding people.
- **Rollback:** deploy the previous commit/tag in Coolify. Data-shape changes are not undone by a redeploy: restore from backup.

## How the package is built (for maintainers)

The compose files, the inner Traefik routes (`deploy/coolify/traefik/dynamic-{s,m}.yml`) and the Authentik blueprints (`deploy/coolify/authentik/blueprints/lokyy-{s,m}.yaml`) are generated by `node deploy/coolify/generate.ts` from one template. Never edit them by hand; `node --test deploy/coolify/tests/generate.test.ts` fails when a committed file is stale.

Security model (same as `deploy/stack`, see its README): each vault is only on its own internal `web-<slot>` network (with `lokyy-traefik`) and `mcp-<slot>` network (with `vault-connector`), plus `egress` with inter-container traffic disabled; MetaMCP is on no vault network and reaches vaults only through `vault-connector`; MCP clients reach MetaMCP only through `mcp-gate`; every vault route runs Authentik forward-auth, pins `X-Forwarded-Host`/`-Proto`, strips `X-Mindbase-User` and sets that vault's own proxy secret; models are pinned, SHA-256 verified and mounted read-only, vaults never download models; capture is off; LLM calls only to `api.eurouter.ai`.

Coolify-specific design:

- Request path: internet → coolify-proxy (TLS, Let's Encrypt) → `lokyy-traefik` → service. Only `lokyy-traefik` joins the `coolify` network and only it carries `traefik.*` labels (one TLS router per host, names prefixed with the Coolify resource UUID so two installations on one server do not collide).
- Other Coolify apps share the `coolify` network and could register a container named like one of ours. `lokyy-traefik` therefore reaches every upstream by fixed IP (vaults `.14` on their `web-` network; Authentik `.10`, MetaMCP `.11`, gate `.12` on `edge`; portal `.94`), never by name.
- `lokyy-init` (one-shot, no network) validates `BASE_DOMAIN` / `ADMIN_EMAIL` before anything uses them and prepares ownership of the shared state volumes.
- `lokyy-traefik` routes from a baked-in file (Go template: `BASE_DOMAIN` and proxy secrets from its environment). It has no Docker socket and reads no labels, so coolify-proxy and the inner Traefik can never pick up each other's routes. It deletes aliasing headers (`X_authentik_username`) and refuses to start with an invalid `BASE_DOMAIN`.
- Repository assets are baked into images (blueprint into the Authentik image, routes into the Traefik image, model manifest/prefetch/offline loader into the vault image, `init.sh` into the MetaMCP init image): no bind mounts into a checkout.
- Networks are project-scoped with fixed /28 subnets from `LOKYY_NET_PREFIX`: infrastructure `<prefix>.0.x`, `egress` `<prefix>.1.0/26`, `firma` `<prefix>.2.x`, slot `vNN` `<prefix>.(2+NN).0/28` (web) and `.16/28` (mcp). S and M share the same names and subnets, so an upgrade only adds.
- The portal provisions MetaMCP directly (MetaMCP API + database, vault tokens as env; `deploy/stack/metamcp/provision.mjs` behaviour: removals first, every user on its own, no key for a failed user; a disabled or removed person's key is revoked in MetaMCP's database at once). It holds no Authentik token: user and group changes go through `authentik-gate` (shared secret), the only holder of the least-privilege service-account token (`lokyy-portal`: 10 user/group/session permissions, no superuser), on two internal networks (portal ↔ gate, gate ↔ authentik-server). No bootstrap API token exists. `mcp-gate`'s session cap comes from the package size (slots × 20 × 1.25).

Tests: `deploy/coolify/tests/config-check.sh` (static: generator tests, `docker compose config` with Coolify-like env, network/label/secret invariants for both packages) and `deploy/coolify/tests/smoke/smoke.sh` (live on a dev machine: package S behind a coolify-proxy stand-in, admin login, slot isolation, MCP keys, then upgrade to M with data kept).

## Known limitations

- MetaMCP stores API keys and vault tokens in plain text in `metamcp-db` (accepted risk, see `deploy/stack/README.md`).
- The embedding model stays loaded after the first search (~2.6 GiB per vault until restart).
- `GET /api/config` shows the vault's EUrouter key to everyone with web access to that vault.
- EUrouter: the model is chosen as a route (routing rule, `ruleId`) in the portal or the vault settings; PDF chat sends locally extracted text only (no figures/layout), limited by `maxContextChars`.
- Embeddings come from one shared `embed` service (LBV2-26): each vault reaches it only over its own `embed-<slot>` network with its own token; the model loads once (4 GB limit) instead of in every vault.
- Admin MFA is enforced in Authentik's default authentication flow for superusers and members of `lokyy-admins` / `authentik Admins` (TOTP or WebAuthn). Invitation / recovery links cannot be used for admin accounts (the portal's set-password flow refuses them).
- Not yet verified on a real Coolify server: Raw-mode deploy end to end, certificates for all hosts, cookie SameSite with the Google callback, egress rules surviving restarts.
