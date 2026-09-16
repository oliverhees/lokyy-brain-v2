import { Router } from 'express';
import type { ServerContext } from '../../context.js';
import { listRoutes } from './list.js';
import { crudRoutes } from './crud.js';
import { quickRoutes } from './quick.js';
import { rawTreeRoutes } from './raw.js';
import { attachmentsTreeRoutes } from './attachments.js';
import { backlinksTreeRoutes } from './backlinks.js';
import { templateTreeRoutes } from './template.js';
import { rejectInvalidUser } from '../../lib/user-attribution.js';

export function treeRoutes(ctx: ServerContext): Router {
  const router = Router();
  // The user header names a contributor directory; reject bad values up front.
  router.use(rejectInvalidUser);
  router.use('/', quickRoutes(ctx));
  router.use('/', attachmentsTreeRoutes(ctx));
  router.use('/', templateTreeRoutes(ctx));
  router.use('/', rawTreeRoutes(ctx));
  router.use('/', backlinksTreeRoutes(ctx));
  router.use('/', listRoutes(ctx));
  router.use('/', crudRoutes(ctx));
  return router;
}
