import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { registerAuth } from './lib/auth.js';
import { HttpError } from './lib/errors.js';
import { REPO_ROOT } from './lib/paths.js';
import { adminFsRoutes } from './routes/admin-fs.js';
import { adminMetadataRoutes } from './routes/admin-metadata.js';
import { catalogRoutes } from './routes/catalog.js';
import { adminPluginRoutes } from './routes/admin-plugins.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { libraryRoutes } from './routes/libraries.js';
import { playbackRoutes } from './routes/playback.js';
import { profileRoutes } from './routes/profiles.js';
import { scanRoutes } from './routes/scans.js';
import type { Services } from './services.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

export const FRONTEND_DIST = path.join(REPO_ROOT, 'frontend', 'dist');

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config } = services;

  const app = Fastify({
    loggerInstance: services.log as FastifyBaseLogger,
    // Per-request lines are logged by the onResponse hook below (debug level).
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    // Close long-lived SSE/stream connections on shutdown.
    forceCloseConnections: true,
  });

  app.decorate('services', services);

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  registerAuth(app);

  app.addHook('onResponse', async (request, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : 'debug';
    request.log[level](
      { method: request.method, url: request.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.code ?? 'ERROR',
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'Unhandled error');
    return reply.status(status).send({
      error: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'ERROR'),
      message: status >= 500 && !config.isDev ? 'Internal server error' : error.message,
    });
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(eventRoutes);
      await api.register(profileRoutes);
      await api.register(libraryRoutes);
      await api.register(adminPluginRoutes);
      await api.register(adminMetadataRoutes);
      await api.register(scanRoutes);
      await api.register(playbackRoutes);
      await api.register(adminFsRoutes);
      await api.register(catalogRoutes);
    },
    { prefix: '/api' },
  );

  // Serve the built web UI (production). In development Vite serves it on :5173.
  const hasFrontend = fs.existsSync(path.join(FRONTEND_DIST, 'index.html'));
  if (hasFrontend) {
    await app.register(fastifyStatic, { root: FRONTEND_DIST, prefix: '/', wildcard: true });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasFrontend && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` });
  });

  return app;
}
