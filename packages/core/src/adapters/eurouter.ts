// EUrouter routing rules (LBV2-30). A rule is selected per request with the
// top-level body field `rule_id` next to `model`; the list endpoint needs the
// API key, unlike the public /models, so it doubles as the key check.
// Docs: https://www.eurouter.ai/docs/api/routing-rules
import { guardLlmFetch } from '../net/llm-host-policy';

export const EUROUTER_HOST = 'api.eurouter.ai';

// Same pattern as EUrouter's own schema for `rule_id` (format uuid).
const RULE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export const EUROUTER_RULE_NOT_FOUND = 'EUrouter routing rule not found or disabled';

export interface EurouterRule {
  id: string;
  name: string;
  /** The rule's primary model, if it sets one. */
  model: string | null;
}

export function isEurouterRuleId(value: unknown): value is string {
  return typeof value === 'string' && RULE_ID.test(value);
}

export function isEurouterBaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === EUROUTER_HOST;
  } catch {
    return false;
  }
}

/** https://api.eurouter.ai/api/v1[/chat/completions] → …/api/v1/routing-rules */
export function eurouterRulesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${base}/routing-rules`;
}

function toRule(entry: unknown): EurouterRule | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (!isEurouterRuleId(e['id']) || typeof e['name'] !== 'string') return null;
  return { id: e['id'], name: e['name'], model: typeof e['model'] === 'string' ? e['model'] : null };
}

/**
 * Lists the enabled routing rules the key can use. Errors carry only the HTTP
 * status, never the response body or the key.
 */
export async function listEurouterRules(opts: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch }): Promise<EurouterRule[]> {
  if (!isEurouterBaseUrl(opts.baseUrl)) throw new Error('Not an EUrouter endpoint');
  const fetchImpl = guardLlmFetch(opts.fetchImpl ?? fetch.bind(globalThis));
  const r = await fetchImpl(eurouterRulesUrl(opts.baseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`EUrouter routing rules request failed (HTTP ${r.status})`);
  const body = (await r.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw new Error('EUrouter routing rules response was not understood');
  return body.data.map(toRule).filter((rule): rule is EurouterRule => rule !== null);
}
