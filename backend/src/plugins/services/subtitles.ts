import path from 'node:path';
import type {
  MediaFileInfo,
  SubtitleDownload,
  SubtitleFileContext,
  SubtitleSearchQuery,
  SubtitleSearchResult,
  SubtitleTrack,
} from '@streamora/plugin-sdk';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { PluginManager } from '../manager.js';
import { cleanString } from './sanitize.js';

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const SUBTITLE_FORMATS = new Set(['srt', 'vtt', 'ass', 'ssa']);
const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub', 'vobsub']);

export type DiscoveredTrack = SubtitleTrack & { providerId: string; sourceKey: string };

/** Identity of a track within its media file: `embedded:3` or `file:<path>`. */
export function subtitleSourceKey(track: Pick<SubtitleTrack, 'source' | 'streamIndex' | 'path'>): string {
  if (track.source === 'embedded') return `embedded:${track.streamIndex}`;
  const p = path.resolve(track.path ?? '');
  return `file:${process.platform === 'win32' ? p.toLowerCase() : p}`;
}

export function isBitmapSubtitle(codec: string): boolean {
  return BITMAP_CODECS.has(codec.toLowerCase());
}

function sanitizeTrack(raw: unknown): SubtitleTrack | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const source = t.source;
  if (source !== 'embedded' && source !== 'sidecar' && source !== 'downloaded') return undefined;
  const codec = cleanString(t.codec, 64)?.toLowerCase();
  if (!codec) return undefined;
  const streamIndex = typeof t.streamIndex === 'number' && Number.isInteger(t.streamIndex) ? t.streamIndex : undefined;
  const filePath = cleanString(t.path, 4096);
  if (source === 'embedded' && streamIndex === undefined) return undefined;
  if (source !== 'embedded' && (!filePath || !path.isAbsolute(filePath))) return undefined;
  return {
    source,
    codec,
    ...(streamIndex !== undefined ? { streamIndex } : {}),
    ...(filePath && source !== 'embedded' ? { path: path.resolve(filePath) } : {}),
    language: cleanString(t.language, 16)?.toLowerCase(),
    label: cleanString(t.label, 200),
    forced: t.forced === true,
    hearingImpaired: t.hearingImpaired === true,
    default: t.default === true,
    renderable: typeof t.renderable === 'boolean' ? t.renderable : !isBitmapSubtitle(codec),
  };
}

/** Aggregates every active `subtitles` plugin: discovery, WebVTT rendering and online search. */
export class SubtitleService {
  constructor(
    private readonly plugins: PluginManager,
    private readonly log: Logger,
  ) {}

  /** Tracks found by all providers, de-duplicated (higher priority wins). */
  async discover(file: SubtitleFileContext, signal?: AbortSignal): Promise<DiscoveredTrack[]> {
    const tracks = new Map<string, DiscoveredTrack>();
    for (const provider of this.plugins.getActive('subtitles')) {
      const discover = provider.impl.discover;
      if (!discover) continue;
      try {
        const found = await this.plugins.invoke(
          provider.id,
          'subtitles.discover',
          (o) => discover.call(provider.impl, structuredClone(file), o),
          { signal },
        );
        for (const raw of Array.isArray(found) ? found : []) {
          const track = sanitizeTrack(raw);
          if (!track) continue;
          const sourceKey = subtitleSourceKey(track);
          if (!tracks.has(sourceKey)) tracks.set(sourceKey, { ...track, providerId: provider.id, sourceKey });
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        this.log.warn({ plugin: provider.id, file: file.path, err }, 'Subtitle discovery failed');
      }
    }
    return [...tracks.values()];
  }

  /** WebVTT for a track from the first provider able to render it. */
  async render(
    track: SubtitleTrack,
    file: MediaFileInfo,
    signal?: AbortSignal,
  ): Promise<{ vtt: string; providerId: string } | null> {
    for (const provider of this.plugins.getActive('subtitles')) {
      const render = provider.impl.render;
      if (!render) continue;
      try {
        const vtt = await this.plugins.invoke(
          provider.id,
          'subtitles.render',
          (o) => render.call(provider.impl, structuredClone(track), structuredClone(file), o),
          { signal, timeoutMs: 5 * 60_000 },
        );
        if (typeof vtt === 'string' && vtt.length > 0) {
          if (vtt.length > MAX_SUBTITLE_BYTES) throw new Error('Rendered subtitle is too large');
          return { vtt: vtt.startsWith('WEBVTT') ? vtt : `WEBVTT\n\n${vtt}`, providerId: provider.id };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        this.log.warn({ plugin: provider.id, file: file.path, err }, 'Subtitle render failed');
      }
    }
    return null;
  }

  async search(
    query: SubtitleSearchQuery,
    signal?: AbortSignal,
  ): Promise<{ results: Array<SubtitleSearchResult & { provider: string }>; errors: Array<{ provider: string; error: string }> }> {
    const providers = this.plugins.getActive('subtitles').filter((p) => typeof p.impl.search === 'function');
    const settled = await Promise.allSettled(
      providers.map((p) =>
        this.plugins.invoke(p.id, 'subtitles.search', (o) => p.impl.search!.call(p.impl, structuredClone(query), o), {
          signal,
        }),
      ),
    );
    const results: Array<SubtitleSearchResult & { provider: string }> = [];
    const errors: Array<{ provider: string; error: string }> = [];
    settled.forEach((outcome, i) => {
      const provider = providers[i]!.id;
      if (outcome.status === 'rejected') {
        errors.push({ provider, error: errorMessage(outcome.reason) });
        return;
      }
      for (const r of Array.isArray(outcome.value) ? outcome.value.slice(0, 100) : []) {
        const id = cleanString(r?.id, 500);
        const language = cleanString(r?.language, 16);
        if (!id || !language || !SUBTITLE_FORMATS.has(r.format)) continue;
        results.push({
          provider,
          id,
          language: language.toLowerCase(),
          label: cleanString(r.label, 300) ?? id,
          format: r.format,
          hearingImpaired: r.hearingImpaired === true,
          forced: r.forced === true,
          score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
        });
      }
    });
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { results, errors };
  }

  async download(providerId: string, result: SubtitleSearchResult, signal?: AbortSignal): Promise<SubtitleDownload> {
    const provider = this.plugins.getActive('subtitles').find((p) => p.id === providerId);
    const download = provider?.impl.download;
    if (!provider || !download) throw new Error(`Subtitle provider "${providerId}" is not available`);
    const file = await this.plugins.invoke(
      providerId,
      'subtitles.download',
      (o) => download.call(provider.impl, structuredClone(result), o),
      { signal, timeoutMs: 60_000 },
    );
    if (!file || typeof file.content !== 'string' || !SUBTITLE_FORMATS.has(file.format)) {
      throw new Error(`Subtitle provider "${providerId}" returned an invalid file`);
    }
    if (file.content.length > MAX_SUBTITLE_BYTES) throw new Error('Downloaded subtitle is too large');
    return { format: file.format, content: file.content, language: cleanString(file.language, 16) ?? result.language };
  }
}
