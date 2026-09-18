# One-shot MetaMCP hardening (deploy/stack/metamcp/init.sh) for the Coolify packages (LBV2-27).
# Build context: repository root.
FROM postgres:16-alpine
COPY deploy/stack/metamcp/init.sh /init.sh
USER postgres
ENTRYPOINT ["/init.sh"]
