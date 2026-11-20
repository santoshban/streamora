import path from 'node:path';
import type {
  MediaFileInfo,
  PluginContext,
  PluginFactory,
  SubtitleTrack,
} from '@streamora/plugin-sdk';
import { normalizeVtt, toWebVtt, type TextSubtitleFormat } from './convert.js';
import { normalizeLanguage } from './languages.js';
import { findSidecars, SUBTITLE_EXTENSIONS } from './sidecar.js';

/** Codecs ffmpeg can turn into WebVTT. */
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'tx3g', 'subviewer', 'microdvd']);
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const DAY = 24 * 60 * 60_000;

const CODEC_TO_FORMAT: Record<string, TextSubtitleFormat> = {
  subrip: 'srt',
  srt: 'srt',
  ass: 'ass',
  ssa: 'ssa',
  webvtt: 'vtt',
  vtt: 'vtt',
};

export const isTextCodec = (codec: string) => TEXT_CODECS.has(codec.toLowerCase());

function settingList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : fallback;
}

const createPlugin: PluginFactory = (ctx: PluginContext) => {
  const folders = settingList(ctx.settings.sidecarFolders, ['Subs', 'Subtitles']);
  const preferred = settingList(ctx.settings.preferredLanguages, ['eng'])
    .map((l) => normalizeLanguage(l))
    .filter((l): l is string => !!l);
  const preExtract = ctx.settings.preExtract === true;
  const cacheTtl = (typeof ctx.settings.cacheDays === 'number' ? ctx.settings.cacheDays : 90) * DAY;
  const extractTimeoutMs = (typeof ctx.settings.extractTimeoutSeconds === 'number' ? ctx.settings.extractTimeoutSeconds : 300) * 1000;

  const cacheKey = (file: MediaFileInfo, streamIndex: number) =>
    `embedded:${file.path}:${file.sizeBytes ?? 0}:${streamIndex}`;

  /** One ffmpeg pass for one embedded stream, piped to stdout. */
  async function extractOne(file: MediaFileInfo, streamIndex: number, signal: AbortSignal): Promise<string> {
    const result = await ctx.ffmpeg.run(
      ['-loglevel', 'error', '-i', file.path, '-map', `0:${streamIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'],
      { signal, timeoutMs: extractTimeoutMs, maxOutputBytes: MAX_SUBTITLE_BYTES },
    );
    if (result.code !== 0) {
      throw new Error(`ffmpeg could not extract stream ${streamIndex}: ${result.stderr.trim().slice(0, 300)}`);
    }
    return normalizeVtt(new TextDecoder('utf-8').decode(result.stdout));
  }

  /** One ffmpeg pass for several streams (demuxing a large MKV once instead of N times). */
  async function extractMany(file: MediaFileInfo, indexes: number[], signal: AbortSignal): Promise<void> {
    const missing: number[] = [];
    for (const index of indexes) if ((await ctx.cache.get(cacheKey(file, index))) === undefined) missing.push(index);
    if (!missing.length) return;

    const scratch = `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputs = missing.map((index) => ({ index, rel: `${scratch}/${index}.vtt` }));
    await ctx.fs.writeData(`${scratch}/.keep`, '');
    try {
      const args = ['-loglevel', 'error', '-y', '-i', file.path];
      for (const o of outputs) {
        args.push('-map', `0:${o.index}`, '-c:s', 'webvtt', '-f', 'webvtt', path.join(ctx.plugin.dataDir, o.rel));
      }
      const result = await ctx.ffmpeg.run(args, { signal, timeoutMs: extractTimeoutMs * outputs.length });
      if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().slice(0, 300)}`);
      for (const o of outputs) {
        const data = await ctx.fs.readData(o.rel);
        if (data) await ctx.cache.set(cacheKey(file, o.index), normalizeVtt(new TextDecoder('utf-8').decode(data)), cacheTtl);
      }
    } finally {
      await ctx.fs.removeData(scratch);
    }
  }

  const wantsLanguage = (language?: string) =>
    preferred.length === 0 || (language !== undefined && preferred.includes(normalizeLanguage(language) ?? language));

  return {
    subtitles: {
      async discover(file) {
        const embedded: SubtitleTrack[] = file.streams
          .filter((s) => s.type === 'subtitle')
          .map((s) => ({
            source: 'embedded',
            streamIndex: s.index,
            codec: s.codec.toLowerCase(),
            language: normalizeLanguage(s.language) ?? s.language,
            label: s.title,
            forced: s.forced === true,
            hearingImpaired: s.hearingImpaired === true,
            default: s.default === true,
            renderable: isTextCodec(s.codec),
          }));
        const sidecars = await findSidecars(ctx.fs, file, folders);
        return [...embedded, ...sidecars];
      },

      async render(track, file, { signal }) {
        if (track.renderable === false) return null;

        if (track.source === 'embedded') {
          if (track.streamIndex === undefined || !isTextCodec(track.codec)) return null;
          return ctx.cache.wrap(cacheKey(file, track.streamIndex), cacheTtl, () =>
            extractOne(file, track.streamIndex!, signal),
          );
        }

        if (!track.path) return null;
        const format =
          CODEC_TO_FORMAT[track.codec.toLowerCase()] ?? SUBTITLE_EXTENSIONS[path.extname(track.path).toLowerCase()];
        if (!format) return null;
        const content = await ctx.fs.readText(track.path, { maxBytes: MAX_SUBTITLE_BYTES, encoding: 'auto' });
        return toWebVtt(content, format);
      },
    },

    postScan: {
      async onScanComplete(event, { signal }) {
        if (!preExtract) return;
        let extracted = 0;
        for (const item of [...event.added, ...event.updated]) {
          for (const file of item.files) {
            signal.throwIfAborted();
            const indexes = file.streams
              .filter((s) => s.type === 'subtitle' && isTextCodec(s.codec) && wantsLanguage(s.language))
              .map((s) => s.index);
            if (!indexes.length) continue;
            try {
              await extractMany(file, indexes, signal);
              extracted += indexes.length;
            } catch (err) {
              if (signal.aborted) throw err;
              ctx.log.warn('Pre-extraction failed', { file: file.path, error: (err as Error).message });
            }
          }
        }
        if (extracted) ctx.log.info('Pre-extracted embedded subtitles', { library: event.library.name, tracks: extracted });
      },
    },
  };
};

export default createPlugin;
