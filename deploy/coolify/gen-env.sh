#!/usr/bin/env bash
# LBV2-16 — print a fresh env file for deploy/coolify/compose.yml (default: plain
# `docker compose -p lokyy --env-file /root/lokyy.env ...` behind coolify-proxy, docs/beta-runbook.md section 5).
# Generates every secret with openssl; never reads existing secrets.
#
# Usage: deploy/coolify/gen-env.sh <domain> <u1-user> <u2-user> <u3-user> <admin-email> [assets-dir]
#   e.g. umask 077; deploy/coolify/gen-env.sh lokyy.example.de anna ben carl ops@example.de /opt/lokyy/lokyy-brain-v2 > /root/lokyy.env
# Usernames follow the provisioning rule: 2–31 chars, ASCII a-z 0-9 and "-", starting with a letter, no "--",
# no trailing "-"; reserved: unknown, firma, auth, mcp (case-insensitive). Afterwards fill in COOLIFY_PROXY_IP.
set -euo pipefail
export LC_ALL=C
(($# >= 5)) || { sed -n 2,9p "$0" >&2; exit 2; }
domain=$1 u1=$2 u2=$3 u3=$4 email=$5 assets=${6:-/opt/lokyy/lokyy-brain-v2}
die() { echo "$1" >&2; exit 2; }

# Domain: lower-case ASCII labels separated by single dots, at least one dot
[[ $domain =~ ^[a-z0-9.-]+$ && $domain == *.* && $domain != .* && $domain != *. && $domain != *..* ]] \
  || die "domain '$domain' must be lower-case ASCII (a-z 0-9 . -) with at least one dot"
IFS=. read -ra labels <<<"$domain"
for l in "${labels[@]}"; do
  [[ $l =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "domain '$domain': label '$l' must not start or end with '-'"
done
[[ $email =~ ^[A-Za-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+$ ]] || die "invalid admin e-mail '$email'"
[[ $assets =~ ^/[A-Za-z0-9._/-]+$ ]] || die "assets dir must be an absolute path without spaces or special characters"

for u in "$u1" "$u2" "$u3"; do
  [[ $u =~ ^[a-z0-9-]+$ ]] || die "username '$u': only ASCII a-z, 0-9 and '-' (no @, no umlauts)"
  [[ $u =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "username '$u': 2-31 characters, starting with a letter"
  [[ $u != *--* && $u != *- ]] || die "username '$u': no '--' and no trailing '-'"
  lower=$(printf '%s' "$u" | tr 'A-Z' 'a-z')
  case $lower in unknown | firma | auth | mcp) die "username '$u' is reserved" ;; esac
done
[[ $u1 != "$u2" && $u1 != "$u3" && $u2 != "$u3" ]] || { echo "usernames must be distinct" >&2; exit 2; }
secret() { openssl rand -hex 32; }
cat <<EOF
LOKYY_DOMAIN=$domain
LOKYY_ASSETS_DIR=$assets
LOKYY_STACK_ID=lokyy
# fill in: docker inspect coolify-proxy -f '{{(index .NetworkSettings.Networks "coolify").IPAddress}}'
COOLIFY_PROXY_IP=
VAULT_MEM_LIMIT=3500m
VAULT_U1_USER=$u1
VAULT_U2_USER=$u2
VAULT_U3_USER=$u3
AUTHENTIK_ADMIN_EMAIL=$email
METAMCP_ADMIN_EMAIL=$email
AUTHENTIK_SECRET_KEY=$(secret)
AUTHENTIK_PG_PASS=$(secret)
AUTHENTIK_ADMIN_PASS=$(secret)
METAMCP_PG_PASS=$(secret)
METAMCP_AUTH_SECRET=$(secret)
METAMCP_ADMIN_PASS=$(secret)
MCP_TOKEN_U1=$(secret)
MCP_TOKEN_U2=$(secret)
MCP_TOKEN_U3=$(secret)
MCP_TOKEN_FIRMA=$(secret)
MCP_READONLY_TOKEN_FIRMA=$(secret)
PROXY_SECRET_U1=$(secret)
PROXY_SECRET_U2=$(secret)
PROXY_SECRET_U3=$(secret)
PROXY_SECRET_FIRMA=$(secret)
EOF
