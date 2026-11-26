import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mediaFiles, mediaItems, subtitleTracks, type MediaFile, type SubtitleTrackRow } from '../db/schema.js';
import { requireAdmin, requireProfile } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { numericIdParams, parseOrThrow, stringIdParams } from '../lib/validation.js';
import { DEFAULT_CAPABILITIES, decidePlayback, type ClientCapabilities } from '../streaming/decision.js';
import { SegmentUnavailableError, type HlsSession } from '../streaming/hls-session.js';
import { contentTypeFor, sendFileWithRange } from '../streaming/range.js';
import { copyPlan } from '../streaming/transcoder.js';

const codecList = z.array(z.string().trim().toLowerCase().max(32)).max(30);

const playbackSchema = z.strictObject({
  capabilities: z
    .strictObject({
      containers: codecList.optional(),
      videoCodecs: codecList.optional(),
      audioCodecs: codecList.optional(),
      maxAudioChannels: z.number().int().min(1).max(8).optional(),
      hdr: z.boolean().optional(),
      maxWidth: z.number().int().min(160).max(8192).optional(),
      maxHeight: z.number().int().min(120).max(8192).optional(),
      selectsAudioTrack: z.boolean().optional(),
    })
    .optional(),
  quality: z.enum(['original', '2160p', '1080p', '720p', '480p']).default('original'),
  audioStreamIndex: z.number().int().min(0).optional(),
  forceTranscode: z.boolean().optional(),
});

const sessionParams = z.object({ sid: z.string().uuid() });
const segmentParams = z.object({ sid: z.string().uuid(), segment: z.string().regex(/^\d{1,6}\.ts$/) });
const subtitleParams = z.object({ track: z.string().regex(/^\d{1,10}(?:\.vtt)?$/) });

function subtitleDto(t: SubtitleTrackRow) {
  return {
    id: t.id,
    source: t.source,
    codec: t.codec,
    language: t.language,
    label: t.label,
    forced: t.forced,
    hearingImpaired: t.hearingImpaired,
    default: t.isDefault,
    renderable: t.renderable,
    url: t.renderable ? `/api/subtitles/${t.id}.vtt` : null,
  };
}

function audioTracks(file: MediaFile) {
  return file.streams
    .filter((s) => s.type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec,
      language: s.language ?? null,
      title: s.title ?? null,
      channels: s.channels ?? null,
      default: s.default === true,
    }));
}

export const playbackRoutes: FastifyPluginAsync = async (app) => {
  const { db, transcoder, subtitles, ffmpeg, catalog } = app.services;

  const findFile = (id: number) => db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get();
  const tracksOf = (fileId: number) =>
    db.select().from(subtitleTracks).where(eq(subtitleTracks.mediaFileId, fileId)).orderBy(subtitleTracks.id).all();

  /** The file, if it exists, is on disk and the signed-in profile may watch it (kids ratings). */
  const requireFile = (request: FastifyRequest, id: number): MediaFile => {
    const file = findFile(id);
    if (!file || !catalog.findVisible(request.profile!, file.mediaItemId)) throw notFound('Media file not found');
    if (file.missing || !fs.existsSync(file.path)) throw new HttpError(410, 'This file is no longer on disk', 'FILE_MISSING');
    return file;
  };

  /** Sessions are private to the profile that started them (admins can see all). */
  const requireSession = (request: FastifyRequest, sid: string): HlsSession => {
    const session = transcoder.get(sid);
    const profile = request.profile!;
    if (!session || (session.profileId !== profile.id && !profile.isAdmin)) {
      throw new HttpError(404, 'Streaming session not found or expired', 'SESSION_NOT_FOUND');
    }
    return session;
  };

  // ── playback decision ──────────────────────────────────────────────────────

  app.post('/files/:id/playback', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'file id');
    const body = parseOrThrow(playbackSchema, request.body ?? {}, 'playback request');
    const file = requireFile(request, id);
    const caps: ClientCapabilities = { ...DEFAULT_CAPABILITIES, ...body.capabilities };
    const decisionRequest = {
      caps,
      quality: body.quality,
      audioStreamIndex: body.audioStreamIndex,
      preferredAudioLanguage: request.profile!.preferences.audioLanguage,
      forceTranscode: body.forceTranscode,
    };
    let decision = decidePlayback(file, decisionRequest);

    const common = {
      fileId: file.id,
      audioStreamIndex: decision.audioStreamIndex,
      audioTracks: audioTracks(file),
      subtitles: tracksOf(file.id).map(subtitleDto),
    };

    if (decision.method === 'direct') {
      return {
        ...common,
        method: decision.method,
        reasons: decision.reasons,
        url: `/api/files/${file.id}/stream`,
        mimeType: contentTypeFor(file.container),
        durationSeconds: file.durationSeconds,
        sessionId: null,
      };
    }

    if (!ffmpeg.ffmpeg) {
      throw new HttpError(503, 'This file needs converting for your browser, but ffmpeg is not installed on the server', 'NO_FFMPEG');
    }
    const probe = await transcoder.probe(file.path);
    let plan;
    if (decision.method === 'remux') {
      plan = (await copyPlan(file.path, probe)) ?? undefined;
      if (!plan) decision = decidePlayback(file, { ...decisionRequest, disallowCopy: true });
    }
    const session = await transcoder.create({ profileId: request.profile!.id, fileId: file.id, path: file.path, decision }, probe, plan);
    return {
      ...common,
      method: decision.method,
      reasons: decision.reasons,
      audioStreamIndex: decision.audioStreamIndex,
      url: `/api/hls/${session.id}/master.m3u8`,
      mimeType: 'application/vnd.apple.mpegurl',
      durationSeconds: probe.durationSeconds,
      sessionId: session.id,
    };
  });

  // ── direct play ────────────────────────────────────────────────────────────

  // Explicit HEAD: Fastify's automatic HEAD route would reset Content-Length to 0.
  app.route({
    method: ['GET', 'HEAD'],
    url: '/files/:id/stream',
    exposeHeadRoute: false,
    preHandler: requireProfile,
    handler: async (request, reply) => {
      const { id } = parseOrThrow(numericIdParams, request.params, 'file id');
      const file = requireFile(request, id);
      return sendFileWithRange(request, reply, file.path, contentTypeFor(file.container));
    },
  });

  // ── HLS ────────────────────────────────────────────────────────────────────

  app.get('/hls/:sid/master.m3u8', { preHandler: requireProfile }, async (request, reply) => {
    const { sid } = parseOrThrow(sessionParams, request.params, 'session');
    const session = requireSession(request, sid);
    session.touch();
    return reply.type('application/vnd.apple.mpegurl').header('cache-control', 'no-cache').send(session.masterPlaylist());
  });

  app.get('/hls/:sid/index.m3u8', { preHandler: requireProfile }, async (request, reply) => {
    const { sid } = parseOrThrow(sessionParams, request.params, 'session');
    const session = requireSession(request, sid);
    session.touch();
    return reply.type('application/vnd.apple.mpegurl').header('cache-control', 'no-cache').send(session.mediaPlaylist());
  });

  app.get('/hls/:sid/:segment', { preHandler: requireProfile }, async (request, reply) => {
    const { sid, segment } = parseOrThrow(segmentParams, request.params, 'segment');
    const session = requireSession(request, sid);
    let file: string;
    try {
      file = await session.segment(Number.parseInt(segment, 10));
    } catch (err) {
      if (err instanceof SegmentUnavailableError) {
        const missing = /does not exist|ended/.test(err.message);
        throw new HttpError(missing ? 404 : 503, err.message, missing ? 'SEGMENT_NOT_FOUND' : 'SEGMENT_UNAVAILABLE');
      }
      throw err;
    }
    const stream = fs.createReadStream(file);
    return reply.type('video/mp2t').header('cache-control', 'private, max-age=3600').send(stream);
  });

  app.post('/hls/:sid/keepalive', { preHandler: requireProfile }, async (request, reply) => {
    const { sid } = parseOrThrow(sessionParams, request.params, 'session');
    requireSession(request, sid).touch();
    return reply.status(204).send();
  });

  app.delete('/hls/:sid', { preHandler: requireProfile }, async (request, reply) => {
    const { sid } = parseOrThrow(sessionParams, request.params, 'session');
    requireSession(request, sid);
    await transcoder.destroy(sid);
    return reply.status(204).send();
  });

  // ── subtitles ──────────────────────────────────────────────────────────────

  app.get('/files/:id/subtitles', { preHandler: requireProfile }, async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'file id');
    requireFile(request, id);
    return { subtitles: tracksOf(id).map(subtitleDto) };
  });

  app.get('/subtitles/:track', { preHandler: requireProfile }, async (request, reply) => {
    const { track: raw } = parseOrThrow(subtitleParams, request.params, 'subtitle id');
    const track = db
      .select()
      .from(subtitleTracks)
      .where(eq(subtitleTracks.id, Number.parseInt(raw, 10)))
      .get();
    if (!track) throw notFound('Subtitle track not found');
    const file = requireFile(request, track.mediaFileId);
    if (!track.renderable) throw new HttpError(422, 'Image-based subtitles cannot be shown in the browser', 'NOT_RENDERABLE');

    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort(new Error('Client disconnected'));
    });
    const rendered = await subtitles.render(
      {
        source: track.source,
        streamIndex: track.streamIndex ?? undefined,
        path: track.path ?? undefined,
        codec: track.codec,
        language: track.language ?? undefined,
        label: track.label ?? undefined,
        forced: track.forced,
        hearingImpaired: track.hearingImpaired,
        default: track.isDefault,
        renderable: track.renderable,
      },
      {
        path: file.path,
        container: file.container ?? undefined,
        sizeBytes: file.sizeBytes,
        durationSeconds: file.durationSeconds ?? undefined,
        streams: file.streams,
      },
      controller.signal,
    );
    if (!rendered) throw new HttpError(422, 'No subtitle plugin could convert this track', 'NOT_RENDERABLE');
    return reply.type('text/vtt; charset=utf-8').header('cache-control', 'private, max-age=3600').send(rendered.vtt);
  });

  // ── admin ──────────────────────────────────────────────────────────────────

  app.get('/admin/transcodes', { preHandler: requireAdmin }, async () => {
    const features = ffmpeg.ffmpeg ? await app.services.encoders.features() : null;
    return {
      encoder: features?.encoder.name ?? null,
      tonemap: features?.tonemap ?? false,
      limit: app.services.config.media.maxTranscodeSessions,
      sessions: transcoder.list().map((s) => ({
        ...s,
        title:
          db
            .select({ title: mediaItems.title })
            .from(mediaFiles)
            .innerJoin(mediaItems, eq(mediaItems.id, mediaFiles.mediaItemId))
            .where(eq(mediaFiles.id, s.fileId))
            .get()?.title ?? null,
      })),
    };
  });

  app.delete('/admin/transcodes/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseOrThrow(stringIdParams, request.params, 'session id');
    if (!(await transcoder.destroy(id))) throw notFound('Streaming session not found');
    return reply.status(204).send();
  });
};
