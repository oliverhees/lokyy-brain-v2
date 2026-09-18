import { Router, type Response } from 'express';
import {
  createAdapter, effectiveLlmBaseUrl, isLlmUrlAllowed, LLM_HOST_NOT_ALLOWED_ERROR,
  EurouterHttpError, EUROUTER_KEY_INVALID, EUROUTER_ROUTE_REQUIRED, EUROUTER_ROUTE_UNAVAILABLE, EUROUTER_RULE_NOT_FOUND, isEurouterBaseUrl, isEurouterRuleId, listEurouterRules,
  probeToolCalling, ROUTE_NO_TOOLS_WARNING,
} from '@mindbase/core';
import type { ServerContext } from '../context';
import type { AtlasConfig } from '../config';
import { ConfigInputError, INVALID_RULE_ID_ERROR, maskConfig, mergeSecrets, unmaskApiKey, maskUrlCredentials, resolveStoredBaseUrl } from '../lib/config-secrets';
import { requireConfigAdminAlways } from '../lib/proxy-identity';
import { probeRateLimiter } from '../lib/probe-rate-limit';

const GENERIC_TEST_ERROR = 'Connection test failed';
// Test results that carry no upstream detail and tell the user what to fix.
const ACTIONABLE_TEST_ERRORS: ReadonlySet<string> = new Set([
  EUROUTER_RULE_NOT_FOUND, EUROUTER_KEY_INVALID, EUROUTER_ROUTE_REQUIRED, EUROUTER_ROUTE_UNAVAILABLE,
]);
const NOT_EUROUTER_ERROR = 'EUrouter is not the configured endpoint';
const RULES_FAILED_ERROR = 'Could not load EUrouter routes';

/** Lists the routing rules for the route picker (LBV2-30); upstream details are logged, never returned. */
async function sendEurouterRules(res: Response, apiKey: string, baseUrl: string): Promise<void> {
  try {
    res.json({ rules: await listEurouterRules({ apiKey, baseUrl }) });
  } catch (e) {
    console.warn(`[config/eurouter/rules] ${(e as Error).message}`);
    if (e instanceof EurouterHttpError && (e.status === 401 || e.status === 403)) {
      res.status(400).json({ error: EUROUTER_KEY_INVALID });
      return;
    }
    res.status(502).json({ error: RULES_FAILED_ERROR });
  }
}

function llmEndpointAllowed(provider: string | undefined, baseUrl: string | undefined): boolean {
  const allowed = isLlmUrlAllowed(effectiveLlmBaseUrl(provider ?? '', baseUrl));
  if (!allowed) console.warn(`[config] LLM endpoint refused for provider ${provider ?? '?'}: host not in VAULT_LLM_ALLOWED_HOSTS`);
  return allowed;
}

export function configRoutes(ctx: ServerContext): Router {
  const router = Router();
  // Shared by both routes that call the provider with a key from the request body.
  const probeLimit = probeRateLimiter(process.env);

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

  // Uses the stored key, so reading it is an admin action too (GET passes requireConfigAdmin).
  router.get('/eurouter/rules', requireConfigAdminAlways(process.env), async (_req, res) => {
    const { apiKey, baseUrl } = ctx.config;
    if (!isEurouterBaseUrl(baseUrl)) {
      res.status(400).json({ error: NOT_EUROUTER_ERROR });
      return;
    }
    await sendEurouterRules(res, apiKey, baseUrl);
  });

  // Same, for a key typed into the form but not saved yet; the mask follows unmaskApiKey's rules.
  router.post('/eurouter/rules', probeLimit, async (req, res) => {
    const { provider, apiKey, baseUrl } = (req.body ?? {}) as Partial<AtlasConfig>;
    const endpoint = resolveStoredBaseUrl(baseUrl, ctx.config);
    if (!isEurouterBaseUrl(endpoint)) {
      res.status(400).json({ error: NOT_EUROUTER_ERROR });
      return;
    }
    if (!llmEndpointAllowed(provider, endpoint)) {
      res.status(400).json({ error: LLM_HOST_NOT_ALLOWED_ERROR });
      return;
    }
    let key: string;
    try {
      key = unmaskApiKey({ apiKey, provider, baseUrl }, ctx.config);
    } catch (e) {
      if (!(e instanceof ConfigInputError)) throw e;
      res.status(400).json({ error: e.message });
      return;
    }
    await sendEurouterRules(res, key, endpoint);
  });

  router.post('/test', probeLimit, async (req, res) => {
    const { provider, apiKey, model, baseUrl, ruleId } = (req.body ?? {}) as Partial<AtlasConfig>;
    if (ruleId && !isEurouterRuleId(ruleId)) {
      res.status(400).json({ ok: false, error: INVALID_RULE_ID_ERROR });
      return;
    }
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
      const adapter = createAdapter(provider as AtlasConfig['provider'], {
        apiKey: key, model: model ?? '', baseUrl: endpoint || undefined, ruleId: ruleId || undefined,
      });
      const result = await adapter.testConnection();
      if (result.ok) {
        // EUrouter routes pick their own models; ingest needs one that calls tools (LBV2-32).
        if (isEurouterBaseUrl(endpoint)) {
          const probe = await probeToolCalling(adapter, model ?? '');
          if (probe.status === 'unsupported') {
            res.json({ ok: true, warning: ROUTE_NO_TOOLS_WARNING });
            return;
          }
          if (probe.status === 'unknown') logFailure(`tool probe: ${probe.error}`);
        }
        res.json({ ok: true });
        return;
      }
      logFailure(result.error);
      res.json({ ok: false, error: result.error && ACTIONABLE_TEST_ERRORS.has(result.error) ? result.error : GENERIC_TEST_ERROR });
    } catch (e) {
      logFailure((e as Error).message);
      res.json({ ok: false, error: GENERIC_TEST_ERROR });
    }
  });

  return router;
}
