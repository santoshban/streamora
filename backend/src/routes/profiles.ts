import { count, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { profiles, type Profile, type ProfilePreferences } from '../db/schema.js';
import { requireAdmin, requireProfile } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from '../lib/errors.js';
import { hashPin, verifyPin } from '../lib/pin.js';
import { SESSION_COOKIE } from '../lib/session.js';
import { numericIdParams, parseOrThrow } from '../lib/validation.js';

const avatar = z.string().regex(/^[a-z0-9-]{1,32}$/, 'avatar must be a short key such as "crimson"');
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');

const preferencesSchema = z.strictObject({
  audioLanguage: z.string().max(16).optional(),
  subtitleLanguage: z.string().max(16).nullable().optional(),
  subtitleStyle: z
    .strictObject({
      size: z.enum(['small', 'medium', 'large']).optional(),
      background: z.enum(['none', 'shadow', 'box']).optional(),
    })
    .optional(),
  autoplayNext: z.boolean().optional(),
  autoplayPreviews: z.boolean().optional(),
});

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  avatar: avatar.optional(),
  isKids: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  pin: pin.optional(),
});

const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  avatar: avatar.optional(),
  isKids: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  /** `null` removes the PIN. */
  pin: pin.nullable().optional(),
  preferences: preferencesSchema.optional(),
});

const sessionSchema = z.strictObject({ pin: z.string().max(16).optional() });

export function toProfileDto(profile: Profile, includePrivate = false) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    isKids: profile.isKids,
    isAdmin: profile.isAdmin,
    hasPin: profile.pinHash !== null,
    ...(includePrivate ? { preferences: profile.preferences } : {}),
    createdAt: profile.createdAt.toISOString(),
  };
}

export const profileRoutes: FastifyPluginAsync = async (app) => {
  const { db, sessions, pinAttempts } = app.services;

  const profileCount = () => db.select({ n: count() }).from(profiles).get()?.n ?? 0;
  const adminCount = () => db.select({ n: count() }).from(profiles).where(eq(profiles.isAdmin, true)).get()?.n ?? 0;
  const findProfile = (id: number) => db.select().from(profiles).where(eq(profiles.id, id)).get();

  const startSession = (request: FastifyRequest, reply: FastifyReply, profile: Profile) => {
    reply.setCookie(SESSION_COOKIE, sessions.issue(profile.id), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
      maxAge: sessions.maxAgeSeconds,
    });
  };

  // "Who's watching?" — public so the profile gate can render before login.
  app.get('/profiles', async () => {
    const rows = db.select().from(profiles).orderBy(profiles.createdAt).all();
    return { setupRequired: rows.length === 0, profiles: rows.map((p) => toProfileDto(p)) };
  });

  app.post('/profiles', async (request, reply) => {
    const existing = profileCount();
    // The very first profile can be created without a session and becomes the admin.
    if (existing > 0) await requireAdmin(request, reply);
    const body = parseOrThrow(createSchema, request.body, 'profile');

    const isAdmin = existing === 0 ? true : body.isAdmin === true;
    const isKids = body.isKids === true;
    if (isAdmin && isKids) {
      throw badRequest(existing === 0 ? 'The first profile must be an adult admin profile' : 'Kids profiles cannot be admins');
    }

    const created = db
      .insert(profiles)
      .values({
        name: body.name,
        avatar: body.avatar ?? 'crimson',
        isKids,
        isAdmin,
        pinHash: body.pin ? await hashPin(body.pin) : null,
      })
      .returning()
      .get();

    if (existing === 0) startSession(request, reply, created);
    reply.status(201);
    return { profile: toProfileDto(created, true) };
  });

  /** Full profile (with preferences) for its owner or an admin. */
  app.get('/profiles/:id', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'profile id');
    const actor = request.profile!;
    if (actor.id !== id && !actor.isAdmin) throw forbidden('You can only view your own profile');
    const target = findProfile(id);
    if (!target) throw notFound('Profile not found');
    return { profile: toProfileDto(target, true) };
  });

  app.patch('/profiles/:id', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'profile id');
    const actor = request.profile!;
    if (actor.id !== id && !actor.isAdmin) throw forbidden('You can only edit your own profile');

    const target = findProfile(id);
    if (!target) throw notFound('Profile not found');
    const body = parseOrThrow(updateSchema, request.body, 'profile');

    if (!actor.isAdmin && (body.isAdmin !== undefined || body.isKids !== undefined)) {
      throw forbidden('Only admins can change kids or admin flags');
    }
    const nextAdmin = body.isAdmin ?? target.isAdmin;
    const nextKids = body.isKids ?? target.isKids;
    if (nextAdmin && nextKids) throw badRequest('Kids profiles cannot be admins');
    if (target.isAdmin && !nextAdmin && adminCount() <= 1) throw conflict('At least one admin profile is required');

    const preferences: ProfilePreferences | undefined = body.preferences
      ? {
          ...target.preferences,
          ...body.preferences,
          subtitleStyle: { ...target.preferences.subtitleStyle, ...body.preferences.subtitleStyle },
        }
      : undefined;

    const updated = db
      .update(profiles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        isKids: nextKids,
        isAdmin: nextAdmin,
        ...(body.pin !== undefined ? { pinHash: body.pin === null ? null : await hashPin(body.pin) } : {}),
        ...(preferences ? { preferences } : {}),
      })
      .where(eq(profiles.id, id))
      .returning()
      .get();
    return { profile: toProfileDto(updated, true) };
  });

  app.delete('/profiles/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'profile id');
    const target = findProfile(id);
    if (!target) throw notFound('Profile not found');
    if (target.isAdmin && adminCount() <= 1) throw conflict('At least one admin profile is required');
    db.delete(profiles).where(eq(profiles.id, id)).run();
    if (request.profile?.id === id) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  // Select a profile ("log in"), verifying its PIN when one is set.
  app.post('/profiles/:id/session', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'profile id');
    const body = parseOrThrow(sessionSchema, request.body ?? {}, 'session');
    const target = findProfile(id);
    if (!target) throw notFound('Profile not found');

    if (target.pinHash) {
      const waitMs = pinAttempts.retryAfterMs(id);
      if (waitMs > 0) {
        reply.header('retry-after', Math.ceil(waitMs / 1000));
        throw tooManyRequests(`Too many attempts. Try again in ${Math.ceil(waitMs / 1000)} s`);
      }
      if (!body.pin || !(await verifyPin(body.pin, target.pinHash))) {
        pinAttempts.recordFailure(id);
        throw unauthorized('Incorrect PIN');
      }
      pinAttempts.recordSuccess(id);
    }

    startSession(request, reply, target);
    return { profile: toProfileDto(target, true) };
  });

  app.get('/session', { preHandler: requireProfile }, async (request) => ({
    profile: toProfileDto(request.profile!, true),
  }));

  app.delete('/session', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });
};
