import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { profiles, type Profile } from '../db/schema.js';
import { forbidden, unauthorized } from './errors.js';
import { SESSION_COOKIE } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Profile selected by the session cookie / bearer token, if any. */
    profile: Profile | null;
  }
}

function readToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return request.cookies?.[SESSION_COOKIE];
}

/** Resolves `request.profile` for every API request. Never rejects. */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('profile', null);
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const profileId = app.services.sessions.verify(readToken(request));
    if (profileId === null) return;
    request.profile = app.services.db.select().from(profiles).where(eq(profiles.id, profileId)).get() ?? null;
  });
}

export async function requireProfile(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.profile) throw unauthorized();
}

export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.profile) throw unauthorized();
  if (!request.profile.isAdmin) throw forbidden();
}
