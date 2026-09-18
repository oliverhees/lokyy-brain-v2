// The real authentik-gate (deploy/stack/authentik-gate) in-process, in front of the fake Authentik:
// portal tests exercise the same policy the deployed gate enforces.
import { createGateHandler } from '../../../../deploy/stack/authentik-gate/src/gate.ts';
import type { FetchFn } from '../../src/server/authentik.ts';
import type { FakeAuthentik } from './authentik.ts';

export const GATE_URL = 'http://authentik-gate:8080';
export const GATE_SECRET = 'g'.repeat(40);

export interface FakeGate {
  fetch: FetchFn;
  requests: { method: string; url: string; authorization: string | null; body: unknown }[];
  logs: string[];
  /** Makes the next gate call fail on the network */
  down: boolean;
}

export function fakeGate(ak: FakeAuthentik): FakeGate {
  const gate: FakeGate = { requests: [], logs: [], down: false, fetch: async () => { throw new Error('unset'); } };
  const handler = createGateHandler({
    authentikUrl: 'http://authentik-server:9000', authentikToken: 'tok-secret', secret: GATE_SECRET,
    log: (l) => gate.logs.push(l), ratePerMinute: 1_000_000, fetch: ak.fetch as typeof fetch,
  });
  gate.fetch = async (input, init = {}) => {
    if (gate.down) { gate.down = false; throw new TypeError('fetch failed'); }
    const url = new URL(String(input));
    const authorization = new Headers(init.headers).get('authorization');
    const raw = typeof init.body === 'string' ? init.body : '';
    gate.requests.push({ method: init.method ?? 'GET', url: url.toString(), authorization, body: raw ? JSON.parse(raw) : undefined });
    const r = await handler({ method: (init.method ?? 'GET').toUpperCase(), path: url.pathname + url.search, authorization: authorization ?? undefined, body: Buffer.from(raw) });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  };
  return gate;
}
