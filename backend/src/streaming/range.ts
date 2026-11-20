import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from '../lib/errors.js';

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  // Browsers play H.264 .mov files when they are labelled as MP4.
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  ogv: 'video/ogg',
};

export const contentTypeFor = (container: string | null | undefined) =>
  (container && CONTENT_TYPES[container]) ?? 'application/octet-stream';

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Parses a single `Range: bytes=…` header against a file size. `null` means
 * "send the whole file" (no header, multiple ranges or a unit we don't serve).
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Streams a file with HTTP Range support (seeking in `<video>`), ETag and HEAD. */
export async function sendFileWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
): Promise<FastifyReply> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw notFound('Media file is not available on disk');
  }
  const size = stat.size;
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  reply.header('last-modified', lastModified);
  reply.header('cache-control', 'private, max-age=3600');
  reply.type(contentType);

  // If-Range: only honour the range when the client's copy is still current.
  const ifRange = request.headers['if-range'];
  const rangeAllowed = !ifRange || ifRange === etag || ifRange === lastModified;
  const range = rangeAllowed ? parseRange(request.headers.range, size) : null;

  if (range === 'unsatisfiable') {
    reply.header('content-range', `bytes */${size}`);
    return reply.status(416).send();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  if (range) {
    reply.status(206);
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('content-length', String(length));

  if (request.method === 'HEAD' || length === 0) return reply.send();
  return reply.send(fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 }));
}
