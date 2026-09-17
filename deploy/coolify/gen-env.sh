#!/usr/bin/env bash
# LBV2-16 — print a fresh environment for the Coolify template (paste into Coolify: Environment Variables,
# "Developer view"). Generates every secret with openssl; never reads existing secrets.
#
# Usage: deploy/coolify/gen-env.sh <domain> <u1-user> <u2-user> <u3-user> <admin-email> [assets-dir]
#   e.g. deploy/coolify/gen-env.sh lokyy.example.de anna ben carl ops@example.de /opt/lokyy/lokyy-brain-v2
# Output goes to stdout: redirect into a mode-600 file outside the repo, or straight into the Coolify UI.
set -euo pipefail
(($# >= 5)) || { sed -n 2,7p "$0" >&2; exit 2; }
domain=$1 u1=$2 u2=$3 u3=$4 email=$5 assets=${6:-/opt/lokyy/lokyy-brain-v2}
name_re='^[a-z][a-z0-9-]*$'
for u in "$u1" "$u2" "$u3"; do
  [[ $u =~ $name_re ]] || { echo "username '$u' must match $name_re (plain ASCII, no @)" >&2; exit 2; }
  [[ $u != firma && $u != auth && $u != mcp ]] || { echo "username '$u' is reserved" >&2; exit 2; }
done
secret() { openssl rand -hex 32; }
cat <<EOF
LOKYY_DOMAIN=$domain
LOKYY_ASSETS_DIR=$assets
LOKYY_STACK_ID=lokyy
COOLIFY_PROXY_CIDR=10.0.1.0/24
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
