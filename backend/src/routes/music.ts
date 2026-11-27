import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireProfile } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { ffprobe } from '../lib/ffmpeg.js';
import { numericIdParams, parseOrThrow } from '../lib/validation.js';
import { mergedTags } from '../media/probe.js';
import { loadLyrics } from '../music/lyrics.js';
import { contentTypeOf, mimeFor } from '../music/service.js';
import { embeddedLyrics } from '../music/tags.js';
import { sendFileWithRange } from '../streaming/range.js';

const page = {
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
};
const tracksQuery = z.object({
  sort: z.enum(['added', 'title', 'artist', 'album', 'plays']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  ...page,
});
const albumsQuery = z.object({
  sort: z.enum(['added', 'title', 'artist', 'year', 'recent']).optional(),
  genre: z.string().trim().min(1).max(100).optional(),
  ...page,
});
const artistsQuery = z.object({ sort: z.enum(['name', 'added', 'tracks']).optional(), ...page });
const searchQuery = z.object({ q: z.string().trim().min(1).max(200) });
const suggestQuery = z.object({ q: z.string().trim().max(200).default('') });
const nameParams = z.object({ name: z.string().trim().min(1).max(100) });
const mixParams = z.object({ id: z.string().regex(/^(?:supermix|discover|genre:.{1,100}|artist:\d{1,10})$/) });
const idList = z
  .string()
  .regex(/^\d{1,10}(?:,\d{1,10}){0,499}$/)
  .transform((s) => s.split(',').map(Number));
const radioQuery = z
  .object({
    track: z.coerce.number().int().positive().optional(),
    album: z.coerce.number().int().positive().optional(),
    artist: z.coerce.number().int().positive().optional(),
    exclude: idList.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((q) => q.track || q.album || q.artist, 'track, album or artist is required');
const streamQuery = z.object({
  transcode: z.enum(['0', '1']).optional(),
  start: z.coerce.number().min(0).max(86_400).optional(),
});
const playlistBody = z.strictObject({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(5000).nullable().optional(),
  trackIds: z.array(z.number().int().positive()).max(1000).optional(),
});
const playlistPatch = z.strictObject({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});
const addTracksBody = z.strictObject({ trackIds: z.array(z.number().int().positive()).min(1).max(1000) });
const reorderBody = z.strictObject({ entryIds: z.array(z.number().int().positive()).max(10_000) });
const entryParams = z.object({ id: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() });
const likeBody = z.strictObject({ liked: z.boolean() });

/** The music section: browsing, playback, likes, history and playlists for the signed-in profile. */
export const musicRoutes: FastifyPluginAsync = async (app) => {
  const { music, musicArtwork, config, ffmpeg } = app.services;
  app.addHook('preHandler', requireProfile);
  const pid = (request: { profile: { id: number } | null }) => request.profile!.id;

  // ── browsing ───────────────────────────────────────────────────────────────

  app.get('/music/home', async (request) => music.home(pid(request)));
  app.get('/music/explore', async (request) => music.explore(pid(request)));
  app.get('/music/genres', async () => ({ genres: music.genres(200) }));

  app.get('/music/genres/:name', async (request) => {
    const { name } = parseOrThrow(nameParams, request.params, 'genre');
    return music.genre(name, pid(request));
  });

  app.get('/music/mixes/:id', async (request) => {
    const { id } = parseOrThrow(mixParams, request.params, 'mix');
    return music.mix(id, pid(request));
  });

  app.get('/music/tracks', async (request) => {
    const q = parseOrThrow(tracksQuery, request.query, 'tracks query');
    return music.tracks(pid(request), q);
  });

  app.get('/music/albums', async (request) => {
    const q = parseOrThrow(albumsQuery, request.query, 'albums query');
    return music.albums({ ...q, profileId: pid(request) });
  });

  app.get('/music/albums/:id', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'album id');
    return music.album(id, pid(request));
  });

  app.get('/music/artists', async (request) => {
    const q = parseOrThrow(artistsQuery, request.query, 'artists query');
    return music.artists(q);
  });

  app.get('/music/artists/:id', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'artist id');
    return music.artist(id, pid(request));
  });

  app.get('/music/artists/:id/tracks', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'artist id');
    return { tracks: music.artistTracks(id, pid(request)) };
  });

  app.get('/music/search', async (request) => {
    const { q } = parseOrThrow(searchQuery, request.query, 'search');
    return music.search(q, pid(request));
  });

  app.get('/music/suggest', async (request) => {
    const { q } = parseOrThrow(suggestQuery, request.query, 'suggest');
    return { suggestions: music.suggest(q) };
  });

  app.get('/music/radio', async (request) => {
    const q = parseOrThrow(radioQuery, request.query, 'radio');
    return {
      tracks: music.radio({ trackId: q.track, albumId: q.album, artistId: q.artist }, pid(request), q.exclude ?? [], q.limit),
    };
  });

  app.get('/music/tracks/:id/related', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
    return music.related(id, pid(request));
  });

  app.get('/music/history', async (request) => ({ tracks: music.history(pid(request)) }));

  // ── likes & plays ──────────────────────────────────────────────────────────

  app.get('/music/likes', async (request) => music.liked(pid(request)));

  app.put('/music/tracks/:id/like', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
    const { liked } = parseOrThrow(likeBody, request.body, 'like');
    music.setLiked(pid(request), id, liked);
    return reply.status(204).send();
  });

  app.post('/music/tracks/:id/played', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
    music.recordPlay(pid(request), id);
    return reply.status(204).send();
  });

  // ── playlists ──────────────────────────────────────────────────────────────

  app.get('/music/playlists', async (request) => ({ playlists: music.playlists(pid(request)) }));

  app.post('/music/playlists', async (request, reply) => {
    const body = parseOrThrow(playlistBody, request.body, 'playlist');
    reply.status(201);
    return { playlist: music.createPlaylist(pid(request), body) };
  });

  app.get('/music/playlists/:id', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'playlist id');
    return music.playlist(pid(request), id);
  });

  app.patch('/music/playlists/:id', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'playlist id');
    const body = parseOrThrow(playlistPatch, request.body, 'playlist');
    return { playlist: music.updatePlaylist(pid(request), id, body) };
  });

  app.delete('/music/playlists/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'playlist id');
    music.deletePlaylist(pid(request), id);
    return reply.status(204).send();
  });

  app.post('/music/playlists/:id/tracks', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'playlist id');
    const { trackIds } = parseOrThrow(addTracksBody, request.body, 'tracks');
    return music.addToPlaylist(pid(request), id, trackIds);
  });

  app.delete('/music/playlists/:id/entries/:entryId', async (request, reply) => {
    const { id, entryId } = parseOrThrow(entryParams, request.params, 'playlist entry');
    music.removeFromPlaylist(pid(request), id, entryId);
    return reply.status(204).send();
  });

  app.put('/music/playlists/:id/order', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'playlist id');
    const { entryIds } = parseOrThrow(reorderBody, request.body, 'order');
    music.reorderPlaylist(pid(request), id, entryIds);
    return reply.status(204).send();
  });

  // ── playback ───────────────────────────────────────────────────────────────

  const playableTrack = (id: number) => {
    const track = music.track(id);
    if (track.missing || !fs.existsSync(track.path)) throw new HttpError(410, 'This track is no longer on disk', 'FILE_MISSING');
    return track;
  };

  /**
   * Direct: the file itself, with Range support for seeking. `transcode=1`:
   * AAC (ADTS) made on the fly for formats the browser can't play; `start`
   * seeks, because a live transcode can't be seeked with ranges.
   */
  app.route({
    method: ['GET', 'HEAD'],
    url: '/music/tracks/:id/stream',
    handler: async (request, reply) => {
      const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
      const q = parseOrThrow(streamQuery, request.query, 'stream query');
      const track = playableTrack(id);
      if (q.transcode !== '1') return sendFileWithRange(request, reply, track.path, contentTypeOf(mimeFor(track.codec, track.container)));

      if (!ffmpeg.ffmpeg) throw new HttpError(501, 'ffmpeg is needed to play this format', 'FFMPEG_MISSING');
      reply.header('content-type', 'audio/aac').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
      if (request.method === 'HEAD') return reply.send();
      const rate = track.sampleRate && track.sampleRate <= 48_000 ? [] : ['-ar', '48000'];
      const args = [
        '-hide_banner', '-v', 'error', '-nostdin',
        ...(q.start ? ['-ss', q.start.toFixed(3)] : []),
        '-i', track.path,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-c:a', 'aac', '-b:a', '256k', '-ac', '2', ...rate,
        '-f', 'adts', 'pipe:1',
      ];
      const child = spawn(config.media.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const stop = () => {
        if (child.exitCode === null) child.kill('SIGKILL');
      };
      reply.raw.on('close', stop);
      child.on('error', (err) => request.log.warn({ err, track: id }, 'Music transcode failed to start'));
      return reply.send(child.stdout);
    },
  });

  app.get('/music/tracks/:id/lyrics', async (request) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
    const track = playableTrack(id);
    const lyrics = await loadLyrics(track.path, async () => {
      if (!ffmpeg.ffprobe) return null;
      const result = await ffprobe(config.media.ffprobePath, track.path, { timeoutMs: 20_000 }).catch(() => null);
      return result ? embeddedLyrics(mergedTags(result, result.streams?.find((s) => s.codec_type === 'audio')?.index)) : null;
    });
    return { lyrics };
  });

  // ── artwork ────────────────────────────────────────────────────────────────

  const sendArt = async (ref: string | null, reply: import('fastify').FastifyReply) => {
    const art = ref ? await musicArtwork.resolve(ref).catch(() => null) : null;
    if (!art) throw notFound('Artwork not available');
    return reply
      .type(art.contentType)
      .header('cache-control', 'private, max-age=604800')
      .header('x-content-type-options', 'nosniff')
      .send(fs.createReadStream(art.file));
  };

  app.get('/music/art/album/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'album id');
    return sendArt(music.albumCover(id), reply);
  });

  app.get('/music/art/track/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'track id');
    return sendArt(music.trackArt(id), reply);
  });

  app.get('/music/art/artist/:id', async (request, reply) => {
    const { id } = parseOrThrow(numericIdParams, request.params, 'artist id');
    return sendArt(music.artistImage(id), reply);
  });
};
