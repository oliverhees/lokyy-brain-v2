import { describe, expect, it } from 'vitest';
import { EurouterClient, EurouterError } from './eurouter.ts';

const reply = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
let calls: { url: string; auth: string | null }[] = [];

describe('EurouterClient.listRules', () => {
  it('GETs the routing rules of the key from the fixed API host with the key as bearer', async () => {
    calls = [];
    const c = new EurouterClient(reply(200, { data: [{ id: '4f1c2b9e-1111-4222-8333-444455556666', rule_name: 'eu-default', description: 'x' }] }));
    expect(await c.listRules('sk-eu-abc')).toEqual([{ id: '4f1c2b9e-1111-4222-8333-444455556666', name: 'eu-default' }]);
    expect(calls).toEqual([{ url: 'https://api.eurouter.ai/api/v1/routing-rules', auth: 'Bearer sk-eu-abc' }]);
  });

  it('shows name (falls back to rule_name) and leaves out disabled rules', async () => {
    const body = { data: [
      { id: 'a1', name: 'Standard', rule_name: 'std', enabled: true },
      { id: 'a2', rule_name: 'legacy' },
      { id: 'a3', name: 'Aus', enabled: false },
    ] };
    expect(await new EurouterClient(reply(200, body)).listRules('k')).toEqual([{ id: 'a1', name: 'Standard' }, { id: 'a2', name: 'legacy' }]);
  });

  it('accepts a bare array and rules/routing_rules containers; drops malformed entries', async () => {
    for (const body of [[{ id: 'a1', rule_name: 'A' }], { rules: [{ id: 'a1', rule_name: 'A' }] }, { routing_rules: [{ id: 'a1', name: 'A' }, { name: 'no id' }, 'x'] }]) {
      expect(await new EurouterClient(reply(200, body)).listRules('k')).toEqual([{ id: 'a1', name: 'A' }]);
    }
  });

  it('a rejected key is invalid_key; other failures are unavailable; nothing of the key in messages', async () => {
    for (const s of [401, 403]) {
      await expect(new EurouterClient(reply(s, { error: 'bad sk-eu-secret' })).listRules('sk-eu-secret')).rejects.toMatchObject({ code: 'invalid_key' });
    }
    const e = await new EurouterClient(reply(500, { error: 'sk-eu-secret' })).listRules('sk-eu-secret').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EurouterError);
    expect((e as EurouterError).code).toBe('unavailable');
    expect(String(e)).not.toContain('sk-eu-secret');
    const net = new EurouterClient(async () => { throw new TypeError('fetch failed'); });
    await expect(net.listRules('k')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
