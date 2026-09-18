// HTTP layer of the portal. The portal is reachable only through Traefik (app.<domain>) behind
// Authentik forward-auth (lokyy-users, lokyy-admins); Traefik overwrites the identity headers and adds the
// proxy secret as X-Vault-Proxy-Secret (same header as on the vault hosts).
// Every /api request: proxy secret → identity → (admin group) → CSRF for mutations → rate limit.
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, type PortalService } from './service.ts';
import type { AuditLog } from './audit.ts';
import type { SlotUser } from './state.ts';

export const ADMIN_GROUP = 'lokyy-admins';
const IDENTITY_HEADER = 'x-authentik-username';
const GROUPS_HEADER = 'x-authentik-groups';
const PROXY_HEADER = 'x-vault-proxy-secret';
const CSRF_HEADER = 'x-csrf-token';
/** Authentik usernames (admins may have names the portal would not create, e.g. akadmin) */
const IDENTITY_RE = /^[A-Za-z0-9_.@+-]{1,150}$/;
const PATH_USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const PATH_SLOT_RE = /^v\d{2,3}$/;

export interface AppOptions {
  service: PortalService;
  audit: AuditLog;
  proxySecret: string;
  csrfSecret: string;
  /** https://app.<domain>; a mutation with another Origin is refused */
  publicOrigin: string;
  /** LOKYY_PACKAGE, shown to admins */
  packageName?: string | null;
  /** Built client (vite build), null in API-only tests */
  staticDir: string | null;
  log: (msg: string) => void;
}

interface Caller {
  username: string;
  groups: string[];
  isAdmin: boolean;
}

type Req = Request & { caller?: Caller };

export function csrfToken(secret: string, username: string): string {
  return createHmac('sha256', secret).update(`csrf:${username}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Authentik separates groups with "|". A duplicated header (array or ", "-joined) grants nothing. */
export function parseGroups(raw: string | string[] | undefined): string[] {
  if (typeof raw !== 'string' || raw.includes(', ')) return [];
  return raw.split('|').map((g) => g.trim()).filter((g) => g.length > 0);
}

/** Fixed-window limiter per key; small and dependency-free (one portal process). */
class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, { count: number; reset: number }>();
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }
  /** Seconds until retry, or 0 when allowed. */
  take(key: string): number {
    const t = Date.now();
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.reset <= t) this.#hits.delete(k);
    const e = this.#hits.get(key);
    if (!e || e.reset <= t) { this.#hits.set(key, { count: 1, reset: t + this.#windowMs }); return 0; }
    e.count += 1;
    return e.count > this.#limit ? Math.ceil((e.reset - t) / 1000) : 0;
  }
}

const publicUser = (u: SlotUser) => ({
  slot: u.slot, username: u.username, email: u.email, displayName: u.displayName, role: u.role, status: u.status,
  provisioning: u.provisioning, invitedAt: u.invitedAt, activatedAt: u.activatedAt ?? null,
});

export function createApp(o: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const general = new RateLimiter(240, 60_000);
  const sensitive = new RateLimiter(10, 60_000);

  app.use((_req, res, next) => {
    res.set({
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  // ------------------------------------------------------------ perimeter for everything else
  app.use((req: Req, res, next) => {
    const secret = req.headers[PROXY_HEADER];
    if (typeof secret !== 'string' || !safeEqual(secret, o.proxySecret)) { res.status(403).json({ error: 'forbidden' }); return; }
    const username = req.headers[IDENTITY_HEADER];
    if (typeof username !== 'string' || !IDENTITY_RE.test(username)) { res.status(401).json({ error: 'unauthenticated' }); return; }
    const groups = parseGroups(req.headers[GROUPS_HEADER]);
    req.caller = { username, groups, isAdmin: groups.includes(ADMIN_GROUP) };
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
  api.use((req: Req, res, next) => {
    const wait = general.take(req.caller!.username);
    if (wait > 0) { res.set('retry-after', String(wait)).status(429).json({ error: 'rate_limited' }); return; }
    next();
  });
  // CSRF: mutations need the per-user token (custom header → no cross-site form/simple request),
  // a same-origin Origin when the browser sends one, and a JSON body.
  api.use((req: Req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
    const token = req.headers[CSRF_HEADER];
    const origin = req.headers['origin'];
    if (typeof token !== 'string' || !safeEqual(token, csrfToken(o.csrfSecret, req.caller!.username))
      || (origin !== undefined && origin !== o.publicOrigin)) {
      res.status(403).json({ error: 'csrf' });
      return;
    }
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !req.is('application/json')) { res.status(415).json({ error: 'unsupported_media_type' }); return; }
    next();
  });
  api.use(express.json({ limit: '16kb', strict: true }));

  const limitSensitive = (req: Req, res: Response, next: NextFunction) => {
    const wait = sensitive.take(req.caller!.username);
    if (wait > 0) { res.set('retry-after', String(wait)).status(429).json({ error: 'rate_limited' }); return; }
    next();
  };
  const requireAdmin = (req: Req, res: Response, next: NextFunction) => {
    if (!req.caller!.isAdmin) { res.status(403).json({ error: 'forbidden' }); return; }
    next();
  };
  const wrap = (fn: (req: Req, res: Response) => Promise<void>) => (req: Req, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const pathUser = (req: Req): string => {
    const u = String(req.params['username'] ?? '');
    if (!PATH_USERNAME_RE.test(u)) throw new ServiceError(404, 'user_not_found');
    return u;
  };
  const who = (req: Req) => req.caller!.username;

  api.get('/session', wrap(async (req, res) => {
    const c = req.caller!;
    const users = (await o.service.listUsers()).users;
    const setup = await o.service.setupStatus();
    res.json({ username: c.username, isAdmin: c.isAdmin, csrfToken: csrfToken(o.csrfSecret, c.username),
      hasAccess: users.some((u) => u.username === c.username && u.status !== 'disabled'),
      setupComplete: setup.setupCompletedAt !== null, companyName: setup.company?.name ?? null,
      ...(c.isAdmin ? { package: o.packageName ?? null } : {}) });
  }));

  // ------------------------------------------------------------ admin
  const admin = express.Router();
  admin.use(requireAdmin);
  admin.get('/setup', wrap(async (_req, res) => { res.json(await o.service.setupStatus()); }));
  admin.put('/setup/company', wrap(async (req, res) => { await o.service.setCompany(who(req), req.body ?? {}); res.status(204).end(); }));
  admin.post('/setup/llm/routes', limitSensitive, wrap(async (req, res) => { res.json({ routes: await o.service.listRoutes(who(req), req.body ?? {}) }); }));
  admin.put('/setup/llm', wrap(async (req, res) => { res.json(await o.service.setLlm(who(req), req.body ?? {})); }));
  admin.put('/setup/smtp', wrap(async (req, res) => { await o.service.setSmtp(who(req), req.body ?? {}); res.status(204).end(); }));
  admin.delete('/setup/smtp', wrap(async (req, res) => { await o.service.removeSmtp(who(req)); res.status(204).end(); }));
  admin.post('/setup/smtp/test', limitSensitive, wrap(async (req, res) => { await o.service.testSmtp(who(req), req.body?.to); res.status(204).end(); }));
  admin.post('/setup/complete', wrap(async (req, res) => { await o.service.completeSetup(who(req)); res.status(204).end(); }));

  admin.get('/users', wrap(async (_req, res) => {
    const l = await o.service.listUsers();
    res.json({ ...l, users: l.users.map(publicUser) });
  }));
  admin.post('/users', limitSensitive, wrap(async (req, res) => {
    const r = await o.service.invite(who(req), req.body ?? {});
    res.status(201).json({ ...r, user: publicUser(r.user) });
  }));
  admin.post('/users/:username/invite', limitSensitive, wrap(async (req, res) => { res.json(await o.service.resendInvite(who(req), pathUser(req))); }));
  admin.patch('/users/:username', wrap(async (req, res) => { res.json({ user: publicUser(await o.service.changeRole(who(req), pathUser(req), req.body?.role)) }); }));
  admin.post('/users/:username/disable', wrap(async (req, res) => { await o.service.disable(who(req), pathUser(req)); res.status(204).end(); }));
  admin.post('/users/:username/enable', wrap(async (req, res) => { await o.service.enable(who(req), pathUser(req)); res.status(204).end(); }));
  admin.delete('/users/:username', wrap(async (req, res) => {
    await o.service.remove(who(req), pathUser(req), { confirm: req.body?.confirm, keepData: req.body?.keepData });
    res.status(204).end();
  }));
  admin.post('/slots/:slot/release', wrap(async (req, res) => {
    const slot = String(req.params['slot'] ?? '');
    if (!PATH_SLOT_RE.test(slot)) throw new ServiceError(404, 'slot_not_retired');
    await o.service.releaseSlot(who(req), slot, { confirm: req.body?.confirm });
    res.status(204).end();
  }));
  admin.post('/provision', wrap(async (req, res) => {
    const r = await o.service.reprovision(who(req));
    res.status(r.status === 'ok' ? 200 : 502).json({ status: r.status });
  }));
  admin.get('/audit', wrap(async (_req, res) => { res.json({ entries: await o.audit.recent(200) }); }));
  api.use('/admin', admin);

  // ------------------------------------------------------------ self service
  api.get('/me', wrap(async (req, res) => { res.json(await o.service.myAccess(who(req))); }));
  api.post('/me/activate', wrap(async (req, res) => { await o.service.activate(who(req)); res.status(204).end(); }));
  api.post('/me/key/reveal', limitSensitive, wrap(async (req, res) => { res.json({ apiKey: await o.service.revealKey(who(req)) }); }));
  api.post('/me/key/rotate', limitSensitive, wrap(async (req, res) => { res.json({ apiKey: await o.service.rotateKey(who(req)) }); }));

  api.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use('/api', api);

  // ------------------------------------------------------------ client
  if (o.staticDir && existsSync(o.staticDir)) {
    const dir = o.staticDir;
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set('cache-control', 'no-store').sendFile(join(dir, 'index.html'));
    });
  }

  // ------------------------------------------------------------ errors
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.code, ...(err.fields ? { fields: err.fields } : {}) });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') { res.status(413).json({ error: 'too_large' }); return; }
    if (e?.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_json' }); return; }
    o.log(`internal error: ${e?.message ?? String(err)}`);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
