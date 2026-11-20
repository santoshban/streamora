import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { parseOrThrow, stringIdParams } from '../lib/validation.js';

const patchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});

const settingsSchema = z.strictObject({
  /** Partial update. `null` resets a key; the secret mask keeps a stored secret. */
  values: z.record(z.string(), z.unknown()),
});

/** Admin > Plugins API. */
export const adminPluginRoutes: FastifyPluginAsync = async (app) => {
  const { plugins, config } = app.services;
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/plugins', async () => ({
    pluginsDir: config.plugins.dir,
    hotReload: config.plugins.hotReload,
    plugins: plugins.list(),
  }));

  app.post('/admin/plugins/rescan', async () => {
    await plugins.syncAll();
    return { plugins: plugins.list() };
  });

  app.get('/admin/plugins/:id', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    return { plugin: plugins.get(id) };
  });

  app.patch('/admin/plugins/:id', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    const body = parseOrThrow(patchSchema, request.body, 'plugin update');
    if (body.enabled === undefined && body.priority === undefined) throw badRequest('Nothing to update');
    if (body.priority !== undefined) await plugins.setPriority(id, body.priority);
    if (body.enabled !== undefined) await plugins.setEnabled(id, body.enabled);
    return { plugin: plugins.get(id) };
  });

  app.put('/admin/plugins/:id/settings', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    const body = parseOrThrow(settingsSchema, request.body, 'plugin settings');
    return { plugin: await plugins.updateSettings(id, body.values) };
  });

  app.post('/admin/plugins/:id/reload', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    return { plugin: await plugins.reload(id) };
  });

  app.post('/admin/plugins/:id/test', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    return { result: await plugins.healthCheck(id) };
  });

  app.delete('/admin/plugins/:id/cache', async (request) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'plugin id');
    return { cleared: plugins.clearCache(id) };
  });
};
