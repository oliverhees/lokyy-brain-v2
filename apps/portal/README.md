# Lokyy setup portal

Admin setup, employee invitations and "Mein Zugang" for a Lokyy Brain company server.
Documentation: [docs/setup-portal.md](../../docs/setup-portal.md). API: [openapi.json](openapi.json).

```bash
pnpm -F @mindbase/portal test     # unit, API and UI tests
pnpm -F @mindbase/portal build    # client bundle (dist/client)
test/e2e/run.sh up|test|down      # full local stack, 127.0.0.1:18380
```
