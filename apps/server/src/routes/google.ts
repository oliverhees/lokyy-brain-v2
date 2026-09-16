import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ingestPaste, compileL1 } from '@mindbase/core';
import type { ServerContext } from '../context';
import { makeHybridSearchClosure } from '../lib/compile-deps';
import { getAuthUrl, exchangeCode, listFiles, downloadFileContent, isSupported } from '../google-drive';
import { loadManifest, contentHash, isDuplicate } from '../manifest';
import { OAuthStateStore } from '../lib/oauth-state';
import { identityHeaderName, isGuarded, requireConfigAdminAlways } from '../lib/proxy-identity';

export interface GoogleOAuthDeps {
  stateStore: OAuthStateStore;
  getAuthUrl: (params: { state: string; codeChallenge: string }) => string;
  exchangeCode: typeof exchangeCode;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** HttpOnly, SameSite=Lax browser nonce that binds an OAuth state to the initiating browser. */
export const OAUTH_COOKIE = 'mindbase_oauth';
const OAUTH_COOKIE_PATH = '/api/google/auth';
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function googleRoutes(
  ctx: ServerContext,
  deps: GoogleOAuthDeps = { stateStore: new OAuthStateStore(), getAuthUrl, exchangeCode },
): Router {
  const router = Router();
  const env = deps.env ?? process.env;

  // Guarded mode: connecting Drive is a configuration change → admins only, for every step.
  const adminOnly = requireConfigAdminAlways(env);
  router.use(['/auth/url', '/auth/start', '/auth/callback', '/auth/disconnect', '/set-sync-folder'], adminOnly);

  /** Proxy identity in guarded mode ('' locally); null when guarded but missing. */
  function initiatorIdentity(req: Request): string | null {
    if (!isGuarded(env)) return '';
    const raw = req.headers[identityHeaderName(env)];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  function newAuthUrl(req: Request, res: Response): string | null {
    const identity = initiatorIdentity(req);
    if (identity === null) return null;
    const existing = readCookie(req.headers.cookie, OAUTH_COOKIE);
    const nonce = existing && NONCE_RE.test(existing) ? existing : randomBytes(32).toString('base64url');
    res.cookie(OAUTH_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isGuarded(env) || req.secure,
      path: OAUTH_COOKIE_PATH,
      maxAge: 10 * 60_000,
    });
    const owner = identity || `browser:${nonce}`;
    const { state, codeChallenge } = deps.stateStore.issue({ owner, binding: `${identity}\n${nonce}` });
    return deps.getAuthUrl({ state, codeChallenge });
  }

  // --- Auth routes ---

  router.get('/auth/status', async (_req, res) => {
    await ctx.reloadConfig();
    const connected = !!ctx.config.googleTokens?.access_token;
    res.json({ connected });
  });

  router.get('/auth/url', (req, res) => {
    try {
      const url = newAuthUrl(req, res);
      if (!url) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Server-side redirect — frontend opens this in a popup directly,
   *  preserving the user-gesture chain so popups aren't blocked. */
  router.get('/auth/start', (req, res) => {
    try {
      const url = newAuthUrl(req, res);
      if (!url) { res.status(401).send('Unauthenticated'); return; }
      res.redirect(url);
    } catch (e) {
      res.status(500).send(`OAuth start failed: ${(e as Error).message}`);
    }
  });

  router.get('/auth/callback', async (req, res) => {
    const code = req.query['code'];
    // Verify state before anything else: a missing, unknown, expired, replayed
    // or foreign (other identity / other browser) state must never reach the
    // token exchange (login CSRF).
    const identity = initiatorIdentity(req);
    const nonce = readCookie(req.headers.cookie, OAUTH_COOKIE) ?? '';
    const codeVerifier = identity === null || !NONCE_RE.test(nonce)
      ? null
      : deps.stateStore.consume(req.query['state'], `${identity}\n${nonce}`);
    if (!codeVerifier) { res.status(400).send('Invalid OAuth state'); return; }
    if (typeof code !== 'string' || !code) { res.status(400).send('Missing code'); return; }
    try {
      const tokens = await deps.exchangeCode(code, codeVerifier);
      const updated = { ...ctx.config, googleTokens: tokens };
      await ctx.saveConfig(updated);
      // Redirect back to app
      res.redirect('/');
    } catch (e) {
      res.status(500).send(`OAuth failed: ${(e as Error).message}`);
    }
  });

  router.post('/auth/disconnect', async (_req, res) => {
    const { googleTokens, googleSyncFolderId, googleSyncFolderName, ...rest } = ctx.config as unknown as Record<string, unknown>;
    await ctx.saveConfig(rest as unknown as typeof ctx.config);
    res.json({ ok: true });
  });

  // --- Drive routes ---

  router.get('/files', async (req, res) => {
    try {
      const folderId = (req.query['folderId'] as string) || 'root';
      const files = await listFiles(ctx.config, ctx.saveConfig, folderId);
      res.json({ files });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post('/import', async (req, res) => {
    const { fileIds } = req.body as { fileIds: Array<{ id: string; name: string; mimeType: string }> };
    if (!fileIds?.length) { res.status(400).json({ error: 'fileIds required' }); return; }

    // SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const file of fileIds) {
      try {
        if (!isSupported(file.mimeType) || file.mimeType === 'application/vnd.google-apps.folder') {
          skipped++;
          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'skipped', reason: 'unsupported type' })}\n\n`);
          continue;
        }

        res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'downloading' })}\n\n`);
        const dl = await downloadFileContent(ctx.config, ctx.saveConfig, file.id, file.mimeType);

        // Check manifest for duplicates
        const manifest = await loadManifest(ctx.store);
        const hash = contentHash(dl.text);
        if (isDuplicate(manifest, hash)) {
          skipped++;
          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'skipped', reason: 'already imported' })}\n\n`);
          continue;
        }

        res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'ingesting' })}\n\n`);
        const raw = await ingestPaste(ctx.store, {
          text: dl.text,
          title: file.name.replace(/\.\w+$/, ''),
          source_url: `https://drive.google.com/file/d/${file.id}`,
          binary: dl.binary,
          binary_ext: dl.binaryExt,
        });

        res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'compiling' })}\n\n`);
        const adapter = ctx.getAdapter();
        await compileL1({ raw, adapter, store: ctx.store, model: ctx.config.model, wikiIndex: ctx.wikiIndex, hybridSearch: makeHybridSearchClosure(ctx) });
        await ctx.reindexWiki();

        imported++;
        res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'done' })}\n\n`);
      } catch (e) {
        errors.push(`${file.name}: ${(e as Error).message}`);
        res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'error', error: (e as Error).message })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ kind: 'done', imported, skipped, errors })}\n\n`);
    res.end();
  });

  router.post('/set-sync-folder', async (req, res) => {
    const { folderId, folderName } = req.body as { folderId: string; folderName: string };
    if (!folderId) { res.status(400).json({ error: 'folderId required' }); return; }
    const updated = { ...ctx.config, googleSyncFolderId: folderId, googleSyncFolderName: folderName };
    await ctx.saveConfig(updated);
    res.json({ ok: true });
  });

  router.post('/sync', async (_req, res) => {
    if (!ctx.config.googleSyncFolderId) {
      res.status(400).json({ error: 'No sync folder configured' });
      return;
    }

    // SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      const files = await listFiles(ctx.config, ctx.saveConfig, ctx.config.googleSyncFolderId);
      const manifest = await loadManifest(ctx.store);

      for (const file of files) {
        if (file.isFolder || !isSupported(file.mimeType)) {
          skipped++;
          continue;
        }

        try {
          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'downloading' })}\n\n`);
          const dl = await downloadFileContent(ctx.config, ctx.saveConfig, file.id, file.mimeType);
          const hash = contentHash(dl.text);

          if (isDuplicate(manifest, hash)) {
            skipped++;
            res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'skipped' })}\n\n`);
            continue;
          }

          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'ingesting' })}\n\n`);
          const raw = await ingestPaste(ctx.store, {
            text: dl.text,
            title: file.name.replace(/\.\w+$/, ''),
            source_url: `https://drive.google.com/file/d/${file.id}`,
            binary: dl.binary,
            binary_ext: dl.binaryExt,
          });

          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'compiling' })}\n\n`);
          const adapter = ctx.getAdapter();
          await compileL1({ raw, adapter, store: ctx.store, model: ctx.config.model, wikiIndex: ctx.wikiIndex, hybridSearch: makeHybridSearchClosure(ctx) });
          await ctx.reindexWiki();

          imported++;
          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'done' })}\n\n`);
        } catch (e) {
          errors.push(`${file.name}: ${(e as Error).message}`);
          res.write(`data: ${JSON.stringify({ kind: 'progress', file: file.name, status: 'error', error: (e as Error).message })}\n\n`);
        }
      }
    } catch (e) {
      errors.push((e as Error).message);
    }

    res.write(`data: ${JSON.stringify({ kind: 'done', imported, skipped, errors })}\n\n`);
    res.end();
  });

  return router;
}
