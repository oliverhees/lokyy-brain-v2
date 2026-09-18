# Authentik for the Coolify packages (LBV2-27) with the generated blueprint of one package baked in,
# plus the portal's blueprint (LBV2-28: set-password flow behind invitation links).
# The file name is the same for every package, so an S -> M upgrade updates the same blueprint instance.
# Build context: repository root.
FROM ghcr.io/goauthentik/server:2026.8.2
ARG LOKYY_PACKAGE=s
COPY deploy/coolify/authentik/blueprints/lokyy-${LOKYY_PACKAGE}.yaml /blueprints/custom/lokyy-slots.yaml
COPY apps/portal/authentik/lokyy-portal.yaml /blueprints/custom/
