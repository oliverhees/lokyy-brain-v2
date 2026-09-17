import { Router, type Response } from 'express';
import type { ServerContext } from '../context';
import { FileStore, isValidTrashEntryId } from '@mindbase/core';

/** Maps store errors to generic client responses; details stay in the server log. */
function sendTrashError(res: Response, op: string, e: unknown): void {
  const message = (e as Error).message;
  if (message === 'Trash entry not found') {
    res.status(404).json({ error: 'Trash entry not found' });
    return;
  }
  if (message === 'Invalid trash manifest') {
    res.status(400).json({ error: 'Invalid trash manifest' });
    return;
  }
  console.error(`[trash] ${op} failed:`, e);
  res.status(500).json({ error: `Trash ${op} failed` });
}

export function trashRoutes(ctx: ServerContext): Router {
  const router = Router();
  // The trash is global (<dataDir>/.trash) and its manifests hold root-relative
  // paths, so it is served from the unscoped FileStore. ctx.store is a
  // ProjectScopedStore in the default layout and has no trash methods (LBV2-14).
  const store = ctx.rawStore;
  if (!(store instanceof FileStore)) {
    router.use((_req, res) => { res.status(501).json({ error: 'Trash is not available for this store' }); });
    return router;
  }

  router.get('/', async (_req, res) => {
    try {
      res.json({ entries: await store.listTrash() });
    } catch (e) {
      sendTrashError(res, 'list', e);
    }
  });

  router.post('/restore/:id', async (req, res) => {
    const id = req.params['id']!;
    if (!isValidTrashEntryId(id)) return res.status(400).json({ error: 'Invalid trash entry id' });
    try {
      const result = await store.restoreFromTrash(id);
      await ctx.reindexWiki();
      return res.json({ ok: true, ...result });
    } catch (e) {
      return sendTrashError(res, 'restore', e);
    }
  });

  router.post('/permanent-delete/:id', async (req, res) => {
    const id = req.params['id']!;
    if (!isValidTrashEntryId(id)) return res.status(400).json({ error: 'Invalid trash entry id' });
    try {
      await store.permanentlyDelete(id);
      return res.json({ ok: true });
    } catch (e) {
      return sendTrashError(res, 'delete', e);
    }
  });

  router.post('/empty', async (_req, res) => {
    try {
      await store.emptyTrash();
      res.json({ ok: true });
    } catch (e) {
      sendTrashError(res, 'empty', e);
    }
  });

  return router;
}
