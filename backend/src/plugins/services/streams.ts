import path from 'node:path';
import type { StreamResolveRequest, StreamSource } from '@streamora/plugin-sdk';
import type { Logger } from '../../lib/logger.js';
import type { PluginManager } from '../manager.js';
import { cleanNumber, cleanString } from './sanitize.js';

export type ResolvedStream = StreamSource & { providerId: string };

function sanitizeSource(raw: unknown): StreamSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const id = cleanString(s.id, 200);
  const name = cleanString(s.name, 200);
  const url = cleanString(s.url, 8192);
  const protocol = s.protocol;
  if (!id || !name || !url) return undefined;
  if (protocol === 'file') {
    if (!path.isAbsolute(url)) return undefined;
  } else if (protocol === 'http' || protocol === 'hls') {
    if (!/^https?:\/\//i.test(url)) return undefined;
  } else {
    return undefined;
  }

  let headers: Record<string, string> | undefined;
  if (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) {
    headers = Object.fromEntries(
      Object.entries(s.headers)
        .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string')
        .map(([k, v]) => [k, v as string]),
    );
  }

  return {
    id,
    name,
    protocol,
    url,
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    container: cleanString(s.container, 32),
    videoCodec: cleanString(s.videoCodec, 32),
    audioCodec: cleanString(s.audioCodec, 32),
    resolution: cleanString(s.resolution, 16),
    hdr: cleanString(s.hdr, 16),
    sizeBytes: cleanNumber(s.sizeBytes, 0, Number.MAX_SAFE_INTEGER),
    bitrate: cleanNumber(s.bitrate, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Collects extra playable sources from every active `stream_resolver` plugin. */
export class StreamResolverService {
  constructor(
    private readonly plugins: PluginManager,
    private readonly log: Logger,
  ) {}

  async resolve(request: StreamResolveRequest, signal?: AbortSignal): Promise<ResolvedStream[]> {
    const providers = this.plugins.getActive('stream_resolver');
    const settled = await Promise.allSettled(
      providers.map((p) =>
        this.plugins.invoke(p.id, 'streamResolver.resolve', (o) => p.impl.resolve(structuredClone(request), o), {
          signal,
        }),
      ),
    );

    const out: ResolvedStream[] = [];
    settled.forEach((outcome, i) => {
      const providerId = providers[i]!.id;
      if (outcome.status === 'rejected') {
        this.log.warn({ plugin: providerId, err: outcome.reason }, 'Stream resolver failed');
        return;
      }
      const seen = new Set<string>();
      for (const raw of Array.isArray(outcome.value) ? outcome.value.slice(0, 50) : []) {
        const source = sanitizeSource(raw);
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        out.push({ ...source, providerId });
      }
    });
    return out;
  }
}
