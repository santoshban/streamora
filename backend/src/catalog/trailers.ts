import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { libraries, type MediaItem } from '../db/schema.js';
import type { Logger } from '../lib/logger.js';
import type { MetadataService } from '../plugins/services/metadata.js';

export interface TrailerDto {
  site: 'youtube';
  key: string;
  name: string | null;
}

const HOUR = 60 * 60 * 1000;
/** Trailers rarely change; a miss is retried sooner (a TMDB key may get added). */
const HIT_TTL = 12 * HOUR;
const MISS_TTL = HOUR / 2;
const MAX_ENTRIES = 2000;

interface Entry {
  /** The ids the lookup was made with: a re-match invalidates the entry. */
  ids: string;
  expires: number;
  value: TrailerDto | null;
}

/**
 * Looks up a title's trailer through the metadata providers (TMDB lists YouTube
 * trailers) on first use, for the browse previews. Results are cached in memory
 * and concurrent requests for the same title share one lookup.
 */
export class TrailerService {
  private readonly cache = new Map<number, Entry>();
  private readonly pending = new Map<number, Promise<TrailerDto | null>>();

  constructor(
    private readonly db: DB,
    private readonly metadata: MetadataService,
    private readonly log: Logger,
  ) {}

  async forItem(item: MediaItem): Promise<TrailerDto | null> {
    const ids = JSON.stringify(item.externalIds ?? {}) + item.title;
    const cached = this.cache.get(item.id);
    if (cached && cached.ids === ids && cached.expires > Date.now()) return cached.value;

    let lookup = this.pending.get(item.id);
    if (!lookup) {
      lookup = this.lookup(item, ids).finally(() => this.pending.delete(item.id));
      this.pending.set(item.id, lookup);
    }
    return lookup;
  }

  private async lookup(item: MediaItem, ids: string): Promise<TrailerDto | null> {
    const library = this.db
      .select({ language: libraries.language, agents: libraries.agents })
      .from(libraries)
      .where(eq(libraries.id, item.libraryId))
      .get();
    const outcome = await this.metadata.getVideos(
      {
        kind: item.kind,
        title: item.title,
        year: item.year ?? undefined,
        language: library?.language ?? 'en-US',
        externalIds: item.externalIds ?? {},
      },
      { agents: library?.agents },
    );
    // Provider errors (network, bad key) are not cached, so the next hover retries.
    if (!outcome.videos.length && outcome.errors.length) {
      this.log.debug({ itemId: item.id, errors: outcome.errors }, 'Trailer lookup failed');
      return null;
    }
    const best = outcome.videos.find((v) => v.site === 'youtube');
    const value: TrailerDto | null = best ? { site: 'youtube', key: best.key, name: best.name ?? null } : null;

    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(item.id, { ids, value, expires: Date.now() + (value ? HIT_TTL : MISS_TTL) });
    return value;
  }
}
