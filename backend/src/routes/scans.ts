import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { libraries, mediaItems, type MediaItem } from '../db/schema.js';
import { requireAdmin, requireProfile } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { numericIdParams, parseOrThrow } from '../lib/validation.js';

const scanSchema = z.strictObject({ refreshMetadata: z.boolean().default(false) });
const refreshSchema = z.strictObject({ rematch: z.boolean().default(false) });
const matchSchema = z.strictObject({
  externalIds: z
    .record(z.string().regex(/^[a-z0-9_-]{1,32}$/i), z.string().trim().min(1).max(200))
    .refine((ids) => Object.keys(ids).length > 0, 'at least one id is required'),
  lock: z.boolean().default(true),
});
const patchItemSchema = z.strictObject({ locked: z.boolean() });

function itemDto(item: MediaItem) {
  return {
    id: item.id,
    libraryId: item.libraryId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    overview: item.overview,
    poster: item.poster,
    backdrop: item.backdrop,
    externalIds: item.externalIds,
    metadataSources: item.metadataSources,
    metadataUpdatedAt: item.metadataUpdatedAt?.toISOString() ?? null,
    locked: item.locked,
  };
}

/** Aborts plugin calls when the admin closes the dialog. */
function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort(new Error('Client disconnected'));
  });
  return controller.signal;
}

export const scanRoutes: FastifyPluginAsync = async (app) => {
  const { db, scans } = app.services;
  const requireLibrary = (id: number) => {
    if (!db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, id)).get()) throw notFound('Library not found');
  };
  const requireItem = (id: number) => {
    const item = db.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
    if (!item) throw notFound('Item not found');
    return item;
  };

  app.get('/scans', { preHandler: requireAdmin }, async () => ({ scans: scans.list() }));

  app.get('/libraries/:id/scan', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    requireLibrary(id);
    return { scan: scans.status(id) };
  });

  app.post('/libraries/:id/scan', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    const body = parseOrThrow(scanSchema, request.body ?? {}, 'scan request');
    requireLibrary(id);
    reply.status(202);
    return { scan: scans.requestScan(id, { refreshMetadata: body.refreshMetadata }) };
  });

  app.delete('/libraries/:id/scan', { preHandler: requireAdmin }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    requireLibrary(id);
    return { cancelled: scans.cancel(id) };
  });

  app.post('/items/:id/refresh', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'item id');
    const body = parseOrThrow(refreshSchema, request.body ?? {}, 'refresh request');
    requireItem(id);
    const item = await scans.refreshItem(id, {
      rematch: body.rematch,
      ...(body.rematch ? { lock: false } : {}),
      signal: abortOnDisconnect(reply),
    });
    return { item: itemDto(item) };
  });

  /** "Fix match": pin the item to specific provider ids and lock it against automatic re-matching. */
  app.post('/items/:id/match', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'item id');
    const body = parseOrThrow(matchSchema, request.body, 'match');
    requireItem(id);
    const externalIds = Object.fromEntries(Object.entries(body.externalIds).map(([k, v]) => [k.toLowerCase(), v]));
    const item = await scans.refreshItem(id, { externalIds, lock: body.lock, signal: abortOnDisconnect(reply) });
    return { item: itemDto(item) };
  });

  app.patch('/items/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'item id');
    const body = parseOrThrow(patchItemSchema, request.body, 'item');
    requireItem(id);
    const item = db.update(mediaItems).set({ locked: body.locked }).where(eq(mediaItems.id, id)).returning().get();
    return { item: itemDto(item) };
  });
};
