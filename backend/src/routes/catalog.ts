import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { episodes, mediaFiles, mediaItems, seasons } from '../db/schema.js';
import { requireProfile } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { numericIdParams, parseOrThrow } from '../lib/validation.js';

const kind = z.enum(['movie', 'show']);
const browseQuery = z.object({
  kind: kind.optional(),
  genre: z.string().trim().max(100).optional(),
  libraryId: z.coerce.number().int().positive().optional(),
  sort: z.enum(['added', 'title', 'year', 'rating', 'release']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
const searchQuery = z.object({ q: z.string().trim().min(1).max(200) });
const genresQuery = z.object({ kind: kind.optional() });
const seasonParams = z.object({ id: z.coerce.number().int().positive(), season: z.coerce.number().int().min(0).max(10_000) });
const progressBody = z.object({
  positionSeconds: z.number().min(0).max(1e6),
  durationSeconds: z.number().min(0).max(1e6).optional(),
});
const watchedBody = z.strictObject({ watched: z.boolean(), episodeId: z.number().int().positive().optional() });
const artworkParams = z.object({
  scope: z.enum(['item', 'season', 'episode']),
  id: z.coerce.number().int().positive(),
  kind: z.string().regex(/^(?:poster|backdrop|logo|thumb|still|cast-\d{1,3})$/),
});

/** Browsing, details, progress and My List for the signed-in profile. */
export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const { db, catalog, artwork } = app.services;
  app.addHook('preHandler', requireProfile);

  const visibleItem = (request: FastifyRequest, id: number) => {
    const item = catalog.findVisible(request.profile!, id);
    if (!item) throw notFound('Title not found');
    return item;
  };

  app.get('/catalog/home', async (request) => catalog.home(request.profile!));

  app.get('/catalog/browse', async (request) => {
    const q = parseOrThrow(browseQuery, request.query, 'browse query');
    return catalog.browse(request.profile!, q);
  });

  app.get('/catalog/genres', async (request) => {
    const q = parseOrThrow(genresQuery, request.query, 'genres query');
    return { genres: catalog.genres(request.profile!, q.kind) };
  });

  app.get('/catalog/search', async (request) => {
    const { q } = parseOrThrow(searchQuery, request.query, 'search');
    return { items: catalog.search(request.profile!, q) };
  });

  app.get('/catalog/my-list', async (request) => ({ items: catalog.myList(request.profile!) }));

  app.get('/catalog/items/:id', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'title id');
    return { item: catalog.detail(request.profile!, visibleItem(request, id)) };
  });

  app.get('/catalog/items/:id/seasons/:season', async (request) => {
    const { id, season } = parseOrThrow(seasonParams, request.params, 'season');
    const episodesOut = catalog.season(request.profile!, visibleItem(request, id), season);
    if (!episodesOut) throw notFound('Season not found');
    return { episodes: episodesOut };
  });

  app.get('/catalog/files/:id/context', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'file id');
    const file = db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get();
    const context = file && catalog.playerContext(request.profile!, file);
    if (!context) throw notFound('Title not found');
    return context;
  });

  // ── My List ────────────────────────────────────────────────────────────────

  app.put('/catalog/my-list/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'title id');
    catalog.setInList(request.profile!, visibleItem(request, id).id, true);
    return reply.status(204).send();
  });

  app.delete('/catalog/my-list/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'title id');
    catalog.setInList(request.profile!, id, false);
    return reply.status(204).send();
  });

  // ── progress ───────────────────────────────────────────────────────────────

  const saveProgress = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'file id');
    // sendBeacon posts text/plain; accept a JSON string body too.
    const raw = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body;
    const body = parseOrThrow(progressBody, raw, 'progress');
    const file = db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get();
    if (!file || !catalog.findVisible(request.profile!, file.mediaItemId)) throw notFound('Title not found');
    return reply.send(catalog.saveProgress(request.profile!, file, body.positionSeconds, body.durationSeconds));
  };
  app.put('/progress/:id', saveProgress);
  app.post('/progress/:id', saveProgress);

  app.put('/catalog/items/:id/watched', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'title id');
    const body = parseOrThrow(watchedBody, request.body, 'watched');
    const item = visibleItem(request, id);
    if (body.episodeId) {
      const ep = db.select({ showId: episodes.showId }).from(episodes).where(eq(episodes.id, body.episodeId)).get();
      if (ep?.showId !== item.id) throw notFound('Episode not found');
    }
    catalog.setWatched(request.profile!, item, body.watched, body.episodeId);
    return reply.status(204).send();
  });

  app.delete('/catalog/continue/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'title id');
    catalog.hideFromContinue(request.profile!, id);
    return reply.status(204).send();
  });

  // ── artwork ────────────────────────────────────────────────────────────────

  app.get('/artwork/:scope/:id/:kind', async (request, reply) => {
    const { scope, id, kind: artKind } = parseOrThrow(artworkParams, request.params, 'artwork');
    let ref: string | null | undefined;
    let itemId: number | undefined;
    if (scope === 'item') {
      const item = db.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
      itemId = item?.id;
      if (item) {
        const cast = /^cast-(\d+)$/.exec(artKind);
        ref = cast ? item.cast[Number(cast[1])]?.photo : (item as unknown as Record<string, string | null>)[artKind];
      }
    } else if (scope === 'season') {
      const season = db.select().from(seasons).where(eq(seasons.id, id)).get();
      itemId = season?.showId;
      if (artKind === 'poster') ref = season?.poster;
    } else {
      const episode = db.select().from(episodes).where(eq(episodes.id, id)).get();
      itemId = episode?.showId;
      if (artKind === 'still') ref = episode?.still;
    }
    if (!ref || !itemId || !catalog.findVisible(request.profile!, itemId)) throw notFound('Artwork not found');

    let resolved;
    try {
      resolved = await artwork.resolve(ref);
    } catch (err) {
      request.log.debug({ err, ref }, 'Artwork unavailable');
    }
    if (!resolved) throw notFound('Artwork not available');
    return reply
      .type(resolved.contentType)
      .header('cache-control', resolved.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400')
      // Remote SVG logos are served from our origin: never let them run scripts.
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(fs.createReadStream(resolved.file));
  });
};
