// EUrouter routing rules ("routes"). A vault's LLM calls pass the chosen rule as `rule_id` next to
// `model` on POST /api/v1/chat/completions (docs: eurouter.ai/docs/api/routing-rules, /docs/api/chat).
// GET /routing-rules needs a valid key, so listing the rules also validates the key (/models does not).
import { EUROUTER_BASE_URL } from '../shared/validation.ts';
import type { FetchFn } from './authentik.ts';

export interface RoutingRule {
  id: string;
  name: string;
}

export class EurouterError extends Error {
  readonly code: 'invalid_key' | 'unavailable';
  constructor(code: 'invalid_key' | 'unavailable', message: string) {
    super(message);
    this.name = 'EurouterError';
    this.code = code;
  }
}

function extractRules(body: unknown): RoutingRule[] {
  const list = Array.isArray(body) ? body
    : body && typeof body === 'object'
      ? ['data', 'rules', 'routing_rules'].map((k) => (body as Record<string, unknown>)[k]).find(Array.isArray) ?? []
      : [];
  return (list as unknown[]).flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const id = o['id'];
    const name = o['rule_name'] ?? o['name'];
    return typeof id === 'string' && id.length > 0 && id.length <= 100 && typeof name === 'string' ? [{ id, name: name.slice(0, 200) }] : [];
  });
}

export class EurouterClient {
  readonly #fetch: FetchFn;

  constructor(fetchFn: FetchFn = fetch) {
    this.#fetch = fetchFn;
  }

  async listRules(apiKey: string): Promise<RoutingRule[]> {
    let res: Response;
    try {
      res = await this.#fetch(`${EUROUTER_BASE_URL}/routing-rules`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new EurouterError('unavailable', `EUrouter unreachable: ${(e as Error).name}`);
    }
    if (res.status === 401 || res.status === 403) throw new EurouterError('invalid_key', `EUrouter rejected the key (HTTP ${res.status})`);
    if (!res.ok) throw new EurouterError('unavailable', `EUrouter routing-rules: HTTP ${res.status}`);
    return extractRules(await res.json().catch(() => null));
  }
}
