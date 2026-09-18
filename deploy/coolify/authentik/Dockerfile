# Authentik for the Coolify packages (LBV2-27) with the generated blueprint of one package baked in.
# The file name is the same for every package, so an S -> M upgrade updates the same blueprint instance.
# Build context: repository root.
FROM ghcr.io/goauthentik/server:2026.8.2
ARG LOKYY_PACKAGE=s
COPY deploy/coolify/authentik/blueprints/lokyy-${LOKYY_PACKAGE}.yaml /blueprints/custom/lokyy-slots.yaml
