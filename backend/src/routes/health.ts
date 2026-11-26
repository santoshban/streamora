import os from 'node:os';
import { count } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { profiles } from '../db/schema.js';
import { reachableAddresses } from '../lib/addresses.js';
import { requireProfile } from '../lib/auth.js';
import { SERVER_VERSION } from '../version.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const { db, ffmpeg, startedAt, plugins, serverId } = app.services;
    const profileCount = db.select({ n: count() }).from(profiles).get()?.n ?? 0;
    const pluginList = plugins.list();
    return {
      status: 'ok',
      name: 'Streamora',
      version: SERVER_VERSION,
      serverId,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      setupRequired: profileCount === 0,
      ffmpeg,
      plugins: {
        total: pluginList.length,
        active: pluginList.filter((p) => p.status === 'active').length,
      },
    };
  });

  // The Android app remembers these, so it can switch between the home network
  // and a VPN. Only for signed-in devices: they reveal the computer's addresses.
  app.get('/server/addresses', { preHandler: requireProfile }, async () => {
    const { config, serverId } = app.services;
    return {
      serverId,
      addresses: reachableAddresses(os.networkInterfaces(), config.host, config.port, config.advertisedUrls),
    };
  });
};
