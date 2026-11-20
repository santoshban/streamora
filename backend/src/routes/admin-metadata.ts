import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { parseOrThrow } from '../lib/validation.js';

const kind = z.enum(['movie', 'show']);
const language = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default('en-US');

const matchSchema = z.strictObject({
  kind,
  title: z.string().trim().min(1).max(300),
  year: z.number().int().min(1870).max(2200).optional(),
  language,
  libraryType: z.enum(['movies', 'shows', 'anime']).optional(),
  externalIds: z.record(z.string(), z.string()).optional(),
  folderPath: z.string().optional(),
  filePaths: z.array(z.string()).max(20).default([]),
  agents: z.array(z.string()).optional(),
});

const searchSchema = z.object({
  kind,
  q: z.string().trim().min(1).max(300),
  year: z.coerce.number().int().min(1870).max(2200).optional(),
  language,
});

/**
 * Lets an admin exercise the metadata pipeline without a scan, e.g. to check a
 * TMDB key or compare agents. Nothing is written to the library.
 */
export const adminMetadataRoutes: FastifyPluginAsync = async (app) => {
  const { metadata } = app.services;
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/metadata/providers', async () => ({
    providers: metadata.providers().map((p) => ({
      id: p.id,
      name: p.name,
      priority: p.priority,
      supportsSeasons: typeof p.impl.getSeason === 'function',
      supportsSearch: typeof p.impl.search === 'function',
    })),
  }));

  app.post('/admin/metadata/match', async (request, reply) => {
    const body = parseOrThrow(matchSchema, request.body, 'metadata match');
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort(new Error('Client disconnected'));
    });
    return metadata.match(
      {
        kind: body.kind,
        title: body.title,
        year: body.year,
        language: body.language,
        libraryType: body.libraryType ?? (body.kind === 'movie' ? 'movies' : 'shows'),
        externalIds: body.externalIds,
        folderPath: body.folderPath,
        filePaths: body.filePaths,
      },
      { agents: body.agents, signal: controller.signal },
    );
  });

  app.get('/admin/metadata/search', async (request) => {
    const query = parseOrThrow(searchSchema, request.query, 'metadata search');
    return metadata.search({ kind: query.kind, query: query.q, year: query.year, language: query.language });
  });
};
