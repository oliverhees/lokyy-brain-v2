import { Router } from 'express';
import { createAdapter, effectiveLlmBaseUrl, isLlmUrlAllowed, LLM_HOST_NOT_ALLOWED_ERROR } from '@mindbase/core';
import type { ServerContext } from '../context';
import type { AtlasConfig } from '../config';
import { ConfigInputError, maskConfig, mergeSecrets, unmaskApiKey, maskUrlCredentials, resolveStoredBaseUrl } from '../lib/config-secrets';

const GENERIC_TEST_ERROR = 'Connection test failed';

function llmEndpointAllowed(provider: string | undefined, baseUrl: string | undefined): boolean {
  const allowed = isLlmUrlAllowed(effectiveLlmBaseUrl(provider ?? '', baseUrl));
  if (!allowed) console.warn(`[config] LLM endpoint refused for provider ${provider ?? '?'}: host not in VAULT_LLM_ALLOWED_HOSTS`);
  return allowed;
}

export function configRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(maskConfig(ctx.config));
  });

  router.put('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged = mergeSecrets(body, ctx.config);
      // Only a changed destination is checked here, so unrelated settings stay
      // savable; the adapters refuse a non-allowed host at call time anyway (LBV2-19).
      const destinationChanged = merged.provider !== ctx.config.provider || merged.baseUrl !== ctx.config.baseUrl;
      if (destinationChanged && !llmEndpointAllowed(merged.provider, merged.baseUrl)) {
        res.status(400).json({ ok: false, error: LLM_HOST_NOT_ALLOWED_ERROR });
        return;
      }
      await ctx.saveConfig(merged);
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
    if (!llmEndpointAllowed(provider, resolveStoredBaseUrl(baseUrl, ctx.config))) {
      res.status(400).json({ ok: false, error: LLM_HOST_NOT_ALLOWED_ERROR });
      return;
    }
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
