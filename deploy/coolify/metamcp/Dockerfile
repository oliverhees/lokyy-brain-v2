# MetaMCP for the Coolify packages (LBV2-27): the pinned upstream image plus the provisioning watcher
# (supervisor.mjs runs MetaMCP and provisions from the portal's users.json with provision.mjs).
# Build context: repository root.
FROM ghcr.io/metatool-ai/metamcp:2.4.22
USER root
COPY deploy/stack/metamcp/provision.mjs /lokyy/provision.mjs
COPY deploy/coolify/metamcp/supervisor.mjs /lokyy/supervisor.mjs
# Mount point of lokyy-provision: written by the watcher (uid nextjs), read by the portal (gid 1000)
RUN mkdir -p /var/lib/lokyy-provision && chown nextjs:1000 /var/lib/lokyy-provision && chmod 2750 /var/lib/lokyy-provision
USER nextjs
ENTRYPOINT ["node", "/lokyy/supervisor.mjs"]
CMD ["./docker-entrypoint.sh"]
