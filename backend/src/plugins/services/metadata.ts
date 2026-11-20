import type {
  ExternalIds,
  MediaMetadata,
  MetadataMatchRequest,
  MetadataSearchQuery,
  MetadataSearchResult,
  MetadataSeasonRequest,
  SeasonMetadata,
} from '@streamora/plugin-sdk';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivePlugin, PluginManager } from '../manager.js';
import {
  cleanArtworkRef,
  cleanExternalIds,
  cleanNumber,
  cleanString,
  mergeMetadata,
  mergeSeason,
  sanitizeMetadata,
  sanitizeSeason,
} from './sanitize.js';

export type MatchInput = Omit<MetadataMatchRequest, 'current' | 'externalIds'> & { externalIds?: ExternalIds };
export type SeasonInput = MetadataSeasonRequest;

export interface ProviderError {
  provider: string;
  error: string;
}

export interface MatchOutcome {
  /** Merged metadata, or `null` when no provider recognised the title. */
  metadata: MediaMetadata | null;
  /** Providers that contributed, highest priority first. */
  sources: string[];
  errors: ProviderError[];
}

export interface SeasonOutcome {
  season: SeasonMetadata | null;
  sources: string[];
  errors: ProviderError[];
}

export interface CallScope {
  /** Ordered plugin ids configured on the library; `null`/empty → all by priority. */
  agents?: string[] | null;
  signal?: AbortSignal;
}

/**
 * Runs metadata providers in priority order. Each provider sees the external
 * ids found by earlier ones (so an NFO's TMDB id lets the TMDB agent skip
 * searching), and fills only the fields that are still empty.
 */
export class MetadataService {
  constructor(
    private readonly plugins: PluginManager,
    private readonly log: Logger,
  ) {}

  providers(agents?: string[] | null): ActivePlugin<'metadata'>[] {
    const active = this.plugins.getActive('metadata');
    if (!agents || agents.length === 0) return active;
    return agents.map((id) => active.find((p) => p.id === id)).filter((p): p is ActivePlugin<'metadata'> => !!p);
  }

  async match(input: MatchInput, scope: CallScope = {}): Promise<MatchOutcome> {
    let merged: MediaMetadata = { kind: input.kind, externalIds: { ...input.externalIds } };
    const sources: string[] = [];
    const errors: ProviderError[] = [];

    for (const provider of this.providers(scope.agents)) {
      try {
        const request: MetadataMatchRequest = {
          ...input,
          filePaths: [...input.filePaths],
          externalIds: { ...merged.externalIds },
          current: structuredClone(merged),
        };
        const result = await this.plugins.invoke(provider.id, 'metadata.match', (o) => provider.impl.match(request, o), {
          signal: scope.signal,
        });
        if (!result) continue;
        merged = mergeMetadata(merged, sanitizeMetadata(result, input.kind));
        sources.push(provider.id);
      } catch (err) {
        if (scope.signal?.aborted) throw err;
        errors.push({ provider: provider.id, error: errorMessage(err) });
        this.log.warn({ plugin: provider.id, title: input.title, err }, 'Metadata provider failed');
      }
    }

    return { metadata: sources.length ? merged : null, sources, errors };
  }

  async getSeason(input: SeasonInput, scope: CallScope = {}): Promise<SeasonOutcome> {
    let merged: SeasonMetadata = { seasonNumber: input.seasonNumber };
    const sources: string[] = [];
    const errors: ProviderError[] = [];

    for (const provider of this.providers(scope.agents)) {
      const getSeason = provider.impl.getSeason;
      if (!getSeason) continue;
      try {
        const request: MetadataSeasonRequest = structuredClone(input);
        const result = await this.plugins.invoke(
          provider.id,
          'metadata.getSeason',
          (o) => getSeason.call(provider.impl, request, o),
          { signal: scope.signal },
        );
        if (!result) continue;
        merged = mergeSeason(merged, sanitizeSeason(result, input.seasonNumber));
        sources.push(provider.id);
      } catch (err) {
        if (scope.signal?.aborted) throw err;
        errors.push({ provider: provider.id, error: errorMessage(err) });
        this.log.warn({ plugin: provider.id, season: input.seasonNumber, err }, 'Season metadata provider failed');
      }
    }

    return { season: sources.length ? merged : null, sources, errors };
  }

  /** Candidates from every provider implementing `search` (for the "Fix match" dialog). */
  async search(
    query: MetadataSearchQuery,
    scope: CallScope = {},
  ): Promise<{ results: Array<MetadataSearchResult & { provider: string }>; errors: ProviderError[] }> {
    const providers = this.providers(scope.agents).filter((p) => typeof p.impl.search === 'function');
    const settled = await Promise.allSettled(
      providers.map((p) =>
        this.plugins.invoke(p.id, 'metadata.search', (o) => p.impl.search!.call(p.impl, query, o), { signal: scope.signal }),
      ),
    );

    const results: Array<MetadataSearchResult & { provider: string }> = [];
    const errors: ProviderError[] = [];
    settled.forEach((outcome, i) => {
      const provider = providers[i]!.id;
      if (outcome.status === 'rejected') {
        errors.push({ provider, error: errorMessage(outcome.reason) });
        return;
      }
      for (const raw of Array.isArray(outcome.value) ? outcome.value.slice(0, 50) : []) {
        const title = cleanString(raw?.title, 500);
        if (!title) continue;
        results.push({
          provider,
          kind: raw.kind === 'show' ? 'show' : 'movie',
          title,
          year: cleanNumber(raw.year, 1870, 2200),
          overview: cleanString(raw.overview, 2000),
          poster: cleanArtworkRef(raw.poster),
          externalIds: cleanExternalIds(raw.externalIds) ?? {},
        });
      }
    });
    return { results, errors };
  }
}
