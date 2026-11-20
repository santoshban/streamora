import type { FastifyPluginAsync } from 'fastify';
import { requireProfile } from '../lib/auth.js';
import type { ServerEventEnvelope } from '../lib/events.js';

const HEARTBEAT_MS = 25_000;

/** Server-Sent Events stream: plugin status, scan progress, metadata updates, transcode readiness. */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events', { preHandler: requireProfile }, (request, reply) => {
    reply.hijack();
    const res = reply.raw;

    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    const origin = request.headers.origin;
    if (origin && app.services.config.corsOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
      headers.vary = 'Origin';
    }
    res.writeHead(200, headers);
    res.write('retry: 3000\n: connected\n\n');

    const send = (event: ServerEventEnvelope) => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`);
    };
    const unsubscribe = app.services.events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    // ServerResponse 'close' fires when the client goes away.
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};
