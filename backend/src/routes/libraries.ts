import fs from 'node:fs/promises';
import path from 'node:path';
import { count, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { libraries, mediaItems, type Library } from '../db/schema.js';
import { requireAdmin, requireProfile } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isPathInside } from '../lib/paths.js';
import { numericIdParams, parseOrThrow } from '../lib/validation.js';
import type { PluginManager } from '../plugins/manager.js';

const libraryType = z.enum(['movies', 'shows', 'anime']);
const language = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'must be a language tag such as en-US');

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  type: libraryType,
  paths: z.array(z.string().trim().min(1)).min(1).max(20),
  language: language.default('en-US'),
  watch: z.boolean().default(true),
  agents: z.array(z.string()).max(20).nullable().optional(),
});

const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  paths: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  language: language.optional(),
  watch: z.boolean().optional(),
  agents: z.array(z.string()).max(20).nullable().optional(),
});

/**
 * Every path must be an existing, absolute directory that does not overlap
 * another library's folders (a file belongs to exactly one library).
 * Returns normalised, de-duplicated paths.
 */
async function validatePaths(paths: string[], db: DB, libraryId?: number): Promise<string[]> {
  const errors: string[] = [];
  const out: string[] = [];
  const others = db
    .select({ name: libraries.name, paths: libraries.paths })
    .from(libraries)
    .where(libraryId === undefined ? undefined : ne(libraries.id, libraryId))
    .all();
  for (const raw of paths) {
    if (!path.isAbsolute(raw)) {
      errors.push(`"${raw}" must be an absolute path`);
      continue;
    }
    const resolved = path.resolve(raw);
    try {
      const st = await fs.stat(resolved);
      const clash = others.find((o) => o.paths.some((p) => isPathInside(resolved, p) || isPathInside(p, resolved)));
      if (!st.isDirectory()) errors.push(`"${raw}" is not a directory`);
      else if (clash) errors.push(`"${raw}" overlaps a folder of the "${clash.name}" library`);
      else if (!out.includes(resolved)) out.push(resolved);
    } catch {
      errors.push(`"${raw}" does not exist or is not readable`);
    }
  }
  if (errors.length) throw badRequest('Invalid library folders', errors);
  return out;
}

function validateAgents(agents: string[] | null | undefined, plugins: PluginManager): string[] | null | undefined {
  if (!agents) return agents;
  const known = new Set(plugins.list().filter((p) => p.capabilities.includes('metadata')).map((p) => p.id));
  const unknown = agents.filter((a) => !known.has(a));
  if (unknown.length) throw badRequest(`Unknown metadata agents: ${unknown.join(', ')}`);
  return [...new Set(agents)];
}

function libraryCounts(db: DB): Map<number, { movies: number; shows: number }> {
  const rows = db
    .select({ libraryId: mediaItems.libraryId, kind: mediaItems.kind, n: count() })
    .from(mediaItems)
    .groupBy(mediaItems.libraryId, mediaItems.kind)
    .all();
  const map = new Map<number, { movies: number; shows: number }>();
  for (const r of rows) {
    const entry = map.get(r.libraryId) ?? { movies: 0, shows: 0 };
    if (r.kind === 'movie') entry.movies = r.n;
    else entry.shows = r.n;
    map.set(r.libraryId, entry);
  }
  return map;
}

function toLibraryDto(lib: Library, counts?: { movies: number; shows: number }) {
  return {
    id: lib.id,
    name: lib.name,
    type: lib.type,
    paths: lib.paths,
    language: lib.language,
    watch: lib.watch,
    agents: lib.agents ?? null,
    lastScannedAt: lib.lastScannedAt?.toISOString() ?? null,
    createdAt: lib.createdAt.toISOString(),
    counts: counts ?? { movies: 0, shows: 0 },
  };
}

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const { db, plugins, events } = app.services;
  const find = (id: number) => db.select().from(libraries).where(eq(libraries.id, id)).get();

  app.get('/libraries', { preHandler: requireProfile }, async () => {
    const counts = libraryCounts(db);
    const rows = db.select().from(libraries).orderBy(libraries.name).all();
    return { libraries: rows.map((l) => toLibraryDto(l, counts.get(l.id))) };
  });

  app.get('/libraries/:id', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    const lib = find(id);
    if (!lib) throw notFound('Library not found');
    return { library: toLibraryDto(lib, libraryCounts(db).get(id)) };
  });

  app.post('/libraries', { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseOrThrow(createSchema, request.body, 'library');
    const created = db
      .insert(libraries)
      .values({
        name: body.name,
        type: body.type,
        paths: await validatePaths(body.paths, db),
        language: body.language,
        watch: body.watch,
        agents: validateAgents(body.agents, plugins) ?? null,
      })
      .returning()
      .get();
    events.emit('library.changed', { libraryId: created.id, action: 'created' });
    reply.status(201);
    return { library: toLibraryDto(created) };
  });

  app.patch('/libraries/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    if (!find(id)) throw notFound('Library not found');
    const body = parseOrThrow(updateSchema, request.body, 'library');
    const agents = validateAgents(body.agents, plugins);
    const updated = db
      .update(libraries)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.paths !== undefined ? { paths: await validatePaths(body.paths, db, id) } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
        ...(body.watch !== undefined ? { watch: body.watch } : {}),
        ...(agents !== undefined ? { agents } : {}),
      })
      .where(eq(libraries.id, id))
      .returning()
      .get();
    events.emit('library.changed', { libraryId: id, action: 'updated' });
    return { library: toLibraryDto(updated, libraryCounts(db).get(id)) };
  });

  app.delete('/libraries/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'library id');
    if (!find(id)) throw notFound('Library not found');
    db.delete(libraries).where(eq(libraries.id, id)).run();
    events.emit('library.changed', { libraryId: id, action: 'deleted' });
    return reply.status(204).send();
  });
};
