# One-shot MetaMCP hardening (deploy/stack/metamcp/init.sh) for the Coolify packages (LBV2-27), plus the
# lokyy-init check (operator input + state volume ownership; run with its own entrypoint, see compose).
# Build context: repository root.
FROM postgres:16-alpine
COPY deploy/stack/metamcp/init.sh /init.sh
COPY deploy/coolify/metamcp-init/init-check.sh /lokyy/init-check.sh
USER postgres
ENTRYPOINT ["/init.sh"]
