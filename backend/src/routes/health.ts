import { count } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { profiles } from '../db/schema.js';
import { SERVER_VERSION } from '../version.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const { db, ffmpeg, startedAt, plugins } = app.services;
    const profileCount = db.select({ n: count() }).from(profiles).get()?.n ?? 0;
    const pluginList = plugins.list();
    return {
      status: 'ok',
      name: 'Streamora',
      version: SERVER_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      setupRequired: profileCount === 0,
      ffmpeg,
      plugins: {
        total: pluginList.length,
        active: pluginList.filter((p) => p.status === 'active').length,
      },
    };
  });
};
