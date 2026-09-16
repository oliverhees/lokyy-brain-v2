import { Router } from 'express';
import { createAdapter } from '@mindbase/core';
import type { ServerContext } from '../context';
import type { AtlasConfig } from '../config';
import { maskConfig, mergeSecrets, unmaskApiKey } from '../lib/config-secrets';

export function configRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(maskConfig(ctx.config));
  });

  router.put('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await ctx.saveConfig(mergeSecrets(body, ctx.config));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  router.post('/test', async (req, res) => {
    try {
      const { provider, apiKey, model, baseUrl } = req.body as AtlasConfig;
      const adapter = createAdapter(provider, { apiKey: unmaskApiKey(apiKey, ctx.config), model, baseUrl: baseUrl || undefined });
      const result = await adapter.testConnection();
      res.json(result);
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
