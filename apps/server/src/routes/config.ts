import { Router } from 'express';
import { createAdapter } from '@mindbase/core';
import type { ServerContext } from '../context';
import type { AtlasConfig } from '../config';
import { ConfigInputError, maskConfig, mergeSecrets, unmaskApiKey, maskUrlCredentials, resolveStoredBaseUrl } from '../lib/config-secrets';

const GENERIC_TEST_ERROR = 'Connection test failed';

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
      if (e instanceof ConfigInputError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  router.post('/test', async (req, res) => {
    const { provider, apiKey, model, baseUrl } = (req.body ?? {}) as Partial<AtlasConfig>;
    let key: string;
    try {
      key = unmaskApiKey({ apiKey, provider, baseUrl }, ctx.config);
    } catch (e) {
      if (!(e instanceof ConfigInputError)) throw e;
      res.status(400).json({ ok: false, error: e.message });
      return;
    }
    // Upstream error text can echo request details; log it, return a generic message.
    const logFailure = (detail: string | undefined): void => {
      console.warn(`[config/test] ${provider ?? '?'} @ ${maskUrlCredentials(baseUrl ?? '')}: ${detail ?? 'failed'}`);
    };
    try {
      const endpoint = resolveStoredBaseUrl(baseUrl, ctx.config);
      const adapter = createAdapter(provider as AtlasConfig['provider'], { apiKey: key, model: model ?? '', baseUrl: endpoint || undefined });
      const result = await adapter.testConnection();
      if (result.ok) {
        res.json({ ok: true });
        return;
      }
      logFailure(result.error);
      res.json({ ok: false, error: GENERIC_TEST_ERROR });
    } catch (e) {
      logFailure((e as Error).message);
      res.json({ ok: false, error: GENERIC_TEST_ERROR });
    }
  });

  return router;
}
