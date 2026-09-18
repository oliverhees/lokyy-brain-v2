import { describe, it, expect, vi } from 'vitest';
import { isEurouterBaseUrl, isEurouterRuleId, eurouterRulesUrl, listEurouterRules } from './eurouter';

const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
const EU = 'https://api.eurouter.ai/api/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isEurouterBaseUrl', () => {
  it.each([EU, 'https://API.EUROUTER.AI/api/v1/', 'https://api.eurouter.ai/api/v1/chat/completions'])('accepts %s', (u) => {
    expect(isEurouterBaseUrl(u)).toBe(true);
  });
  it.each(['', undefined, 'http://api.eurouter.ai/api/v1', 'ftp://api.eurouter.ai/x', 'https://api.openai.com', 'https://eurouter.ai/api/v1', 'https://api.eurouter.ai.evil.example/v1', 'https://evil.example/api.eurouter.ai', 'not a url'])(
    'rejects %s', (u) => {
      expect(isEurouterBaseUrl(u)).toBe(false);
    },
  );
});

describe('isEurouterRuleId', () => {
  it('accepts a UUID in any case', () => {
    expect(isEurouterRuleId(RULE)).toBe(true);
    expect(isEurouterRuleId(RULE.toUpperCase())).toBe(true);
  });
  it.each(['', 'my-rule', `${RULE} `, `${RULE}x`, '3f1c2b9a-8d4e-9f6a-9b2c-1d2e3f4a5b6c', 42, null, undefined])('rejects %s', (v) => {
    expect(isEurouterRuleId(v)).toBe(false);
  });
});

describe('eurouterRulesUrl', () => {
  it('derives the routing-rules URL from the API base', () => {
    expect(eurouterRulesUrl(EU)).toBe('https://api.eurouter.ai/api/v1/routing-rules');
    expect(eurouterRulesUrl(`${EU}/`)).toBe('https://api.eurouter.ai/api/v1/routing-rules');
    expect(eurouterRulesUrl(`${EU}/chat/completions`)).toBe('https://api.eurouter.ai/api/v1/routing-rules');
  });
});

describe('listEurouterRules', () => {
  it('lists rules with the bearer key and returns id, name and model only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      data: [
        { id: RULE, name: 'EU only', description: 'secret-ish', model: 'mistral/mistral-large', user_id: 'u1', provider: { only: ['x'] } },
        { id: '11111111-2222-4333-8444-555555555555', name: 'Cheap', model: null },
      ],
    }));
    const rules = await listEurouterRules({ apiKey: 'eur_key', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rules).toEqual([
      { id: RULE, name: 'EU only', model: 'mistral/mistral-large' },
      { id: '11111111-2222-4333-8444-555555555555', name: 'Cheap', model: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.eurouter.ai/api/v1/routing-rules', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer eur_key' }),
    }));
  });

  it('drops malformed entries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: 'nope', name: 'x' }, { id: RULE }, null, { id: RULE, name: 'ok' }] }));
    const rules = await listEurouterRules({ apiKey: 'k', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rules).toEqual([{ id: RULE, name: 'ok', model: null }]);
  });

  it('fails on a rejected key without echoing the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: 'invalid key eur_key' }, 401));
    await expect(listEurouterRules({ apiKey: 'eur_key', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/^EUrouter routing rules request failed \(HTTP 401\)$/);
  });

  it('drops disabled rules (enabled === false) and keeps rules without the flag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [
      { id: RULE, name: 'on', enabled: true },
      { id: '11111111-2222-4333-8444-555555555555', name: 'off', enabled: false },
      { id: '22222222-3333-4444-8555-666666666666', name: 'unflagged' },
    ] }));
    const rules = await listEurouterRules({ apiKey: 'k', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rules.map((r) => r.name)).toEqual(['on', 'unflagged']);
  });

  it('carries the HTTP status on failures so callers can tell a rejected key apart', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}, 403));
    await expect(listEurouterRules({ apiKey: 'k', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ name: 'EurouterHttpError', status: 403 });
  });

  it('fails on an unexpected response shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ rules: [] }));
    await expect(listEurouterRules({ apiKey: 'k', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('EUrouter routing rules response was not understood');
  });

  it('refuses a non-EUrouter base URL without calling it', async () => {
    const fetchImpl = vi.fn();
    await expect(listEurouterRules({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('Not an EUrouter endpoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
