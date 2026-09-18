// The OpenAPI document (apps/portal/openapi.json) must describe the routes the server really has,
// and the server must not have /api routes the document does not list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { harness, type Harness } from '../../test/fakes/harness.ts';
import { AuditLog } from './audit.ts';
import { createApp, csrfToken } from './app.ts';

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const operations = Object.entries(spec.paths).flatMap(([path, ops]) => METHODS.filter((m) => m in ops).map((m) => [m, path] as const));

let h: Harness;
let app: Express;
beforeEach(() => {
  h = harness();
  app = createApp({ service: h.service, audit: new AuditLog(join(h.dir, 'audit.log')), proxySecret: 'p'.repeat(40), csrfSecret: 'c', publicOrigin: 'https://app.example.com', staticDir: null, log: () => {} });
});
afterEach(() => h.cleanup());

const call = (method: string, path: string) => (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path)
  .set('x-vault-proxy-secret', 'p'.repeat(40)).set('x-authentik-username', 'akadmin').set('x-authentik-groups', 'lokyy-admins')
  .set('x-csrf-token', csrfToken('c', 'akadmin'));

describe('openapi.json', () => {
  it('is OpenAPI 3.1 with paths', () => {
    expect(operations.length).toBeGreaterThan(15);
  });

  it.each(operations)('%s %s exists on the server', async (method, path) => {
    const r = await call(method, path.replace('{username}', 'anna').replace('{slot}', 'v01')).send(method === 'get' ? undefined : {});
    expect(r.body?.error).not.toBe('not_found');
  });

  it('the server has no undocumented /api routes', () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean> }; name: string; handle: { stack?: Layer[] }; regexp: RegExp };
    const found: string[] = [];
    const walk = (stack: Layer[], prefix: string) => {
      for (const l of stack) {
        if (l.route) for (const m of Object.keys(l.route.methods)) found.push(`${m} ${prefix}${l.route.path}`);
        else if (l.name === 'router' && l.handle.stack) {
          const mount = /^\^\\\/([a-z]+)/.exec(l.regexp.source)?.[1];
          walk(l.handle.stack, mount ? `${prefix}/${mount}` : prefix);
        }
      }
    };
    walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');
    const documented = new Set(operations.map(([m, p]) => `${m} ${p.replace('{username}', ':username').replace('{slot}', ':slot')}`));
    expect(found.length).toBeGreaterThanOrEqual(operations.length);
    const undocumented = found.filter((r) => !documented.has(r));
    expect(undocumented).toEqual([]);
  });
});
