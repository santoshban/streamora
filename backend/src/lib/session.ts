import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'ls_session';

interface SessionPayload {
  /** Profile id. */
  pid: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * Returns the configured secret, or a random one persisted in the data folder
 * so sessions survive restarts.
 */
export function resolveSessionSecret(configured: string | undefined, dataDir: string): string {
  if (configured) return configured;
  const file = path.join(dataDir, '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first run
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export class SessionSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  get maxAgeSeconds(): number {
    return this.ttlSeconds;
  }

  issue(profileId: number, nowMs = Date.now()): string {
    const payload: SessionPayload = { pid: profileId, exp: Math.floor(nowMs / 1000) + this.ttlSeconds };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** Returns the profile id for a valid, unexpired token. */
  verify(token: string | undefined | null, nowMs = Date.now()): number | null {
    if (!token) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;

    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
      if (typeof payload.pid !== 'number' || typeof payload.exp !== 'number') return null;
      if (payload.exp * 1000 < nowMs) return null;
      return payload.pid;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
