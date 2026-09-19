# lokyy-traefik for the Coolify packages (LBV2-27): Traefik with the generated routes of one package
# baked in (file provider, no Docker socket). Build context: repository root.
FROM traefik:v3.7.13
ARG LOKYY_PACKAGE=s
COPY deploy/coolify/traefik/dynamic-${LOKYY_PACKAGE}.yml /etc/lokyy/dynamic.yml
COPY deploy/coolify/traefik/entrypoint.sh /lokyy-entrypoint.sh
USER 65534:65534
ENTRYPOINT ["/lokyy-entrypoint.sh"]
