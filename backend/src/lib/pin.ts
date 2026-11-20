import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 32;

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(pin, Buffer.from(saltB64, 'base64url'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Simple per-profile lockout: 5 wrong PINs → 60 s cool-down. */
export class PinAttemptLimiter {
  private readonly attempts = new Map<number, { failures: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 60_000,
  ) {}

  /** Milliseconds until the profile may try again (0 = allowed). */
  retryAfterMs(profileId: number, now = Date.now()): number {
    const entry = this.attempts.get(profileId);
    return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  recordFailure(profileId: number, now = Date.now()): void {
    const entry = this.attempts.get(profileId) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.failures = 0;
      entry.lockedUntil = now + this.lockMs;
    }
    this.attempts.set(profileId, entry);
  }

  recordSuccess(profileId: number): void {
    this.attempts.delete(profileId);
  }
}
