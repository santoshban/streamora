import crypto from 'node:crypto';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import type { PluginCache } from '@streamora/plugin-sdk';
import type { DB } from '../../db/client.js';
import { pluginCache } from '../../db/schema.js';

const MEMORY_ENTRIES = 500;

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

function normaliseKey(key: string): string {
  if (typeof key !== 'string' || key === '') throw new Error('Cache key must be a non-empty string');
  return key.length <= 200 ? key : `sha1:${crypto.createHash('sha1').update(key).digest('hex')}`;
}

/** SQLite-backed cache with a small in-memory LRU in front. */
export class SqlitePluginCache implements PluginCache {
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DB,
    private readonly pluginId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private remember(key: string, entry: MemoryEntry): void {
    this.memory.delete(key);
    this.memory.set(key, entry);
    if (this.memory.size > MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
  }

  async get<T = unknown>(rawKey: string): Promise<T | undefined> {
    const key = normaliseKey(rawKey);
    const now = this.now();

    const hit = this.memory.get(key);
    if (hit) {
      if (hit.expiresAt === null || hit.expiresAt > now) {
        this.remember(key, hit);
        return hit.value as T;
      }
      this.memory.delete(key);
    }

    const row = this.db
      .select()
      .from(pluginCache)
      .where(and(eq(pluginCache.pluginId, this.pluginId), eq(pluginCache.key, key)))
      .get();
    if (!row) return undefined;
    if (row.expiresAt !== null && row.expiresAt <= now) {
      await this.delete(rawKey);
      return undefined;
    }
    const value = JSON.parse(row.value) as T;
    this.remember(key, { value, expiresAt: row.expiresAt });
    return value;
  }

  async set(rawKey: string, value: unknown, ttlMs?: number): Promise<void> {
    const key = normaliseKey(rawKey);
    if (value === undefined) return this.delete(rawKey);
    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? this.now() + ttlMs : null;
    const json = JSON.stringify(value);
    this.db
      .insert(pluginCache)
      .values({ pluginId: this.pluginId, key, value: json, expiresAt })
      .onConflictDoUpdate({ target: [pluginCache.pluginId, pluginCache.key], set: { value: json, expiresAt } })
      .run();
    // Store the round-tripped value so memory hits behave exactly like DB hits.
    this.remember(key, { value: JSON.parse(json), expiresAt });
  }

  async delete(rawKey: string): Promise<void> {
    const key = normaliseKey(rawKey);
    this.memory.delete(key);
    this.db
      .delete(pluginCache)
      .where(and(eq(pluginCache.pluginId, this.pluginId), eq(pluginCache.key, key)))
      .run();
  }

  async wrap<T>(rawKey: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(rawKey);
    if (cached !== undefined) return cached;

    const key = normaliseKey(rawKey);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const run = (async () => {
      try {
        const value = await producer();
        if (value !== undefined) await this.set(rawKey, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  async clear(): Promise<void> {
    this.memory.clear();
    this.db.delete(pluginCache).where(eq(pluginCache.pluginId, this.pluginId)).run();
  }
}

export function clearPluginCache(db: DB, pluginId: string): number {
  return db.delete(pluginCache).where(eq(pluginCache.pluginId, pluginId)).run().changes;
}

export function purgeExpiredCache(db: DB, now = Date.now()): number {
  return db
    .delete(pluginCache)
    .where(and(isNotNull(pluginCache.expiresAt), lt(pluginCache.expiresAt, now)))
    .run().changes;
}
