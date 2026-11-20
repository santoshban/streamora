import type { MediaStreamInfo } from '@streamora/plugin-sdk';
import { describe, expect, it } from 'vitest';
import {
  avcCodecString,
  chooseAudioStream,
  decidePlayback,
  DEFAULT_CAPABILITIES,
  fitWithin,
  type SourceInfo,
} from '../src/streaming/decision.js';
import { buildRunArgs, type RunSpec } from '../src/streaming/ffmpeg-args.js';
import { parseRange } from '../src/streaming/range.js';
import { gridPlan, keyframePlan, mediaPlaylist, segmentAt, segmentDuration } from '../src/streaming/segments.js';

const h264: MediaStreamInfo = { index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, profile: 'High', level: 41, pixFmt: 'yuv420p', bitDepth: 8 };
const aac: MediaStreamInfo = { index: 1, type: 'audio', codec: 'aac', channels: 2, language: 'eng', default: true };

const source = (over: Partial<SourceInfo> & { streams?: MediaStreamInfo[] } = {}): SourceInfo => ({
  container: 'mp4',
  bitrate: 5_000_000,
  durationSeconds: 600,
  hdr: null,
  streams: [h264, aac],
  ...over,
});

const decide = (src: SourceInfo, extra: Partial<Parameters<typeof decidePlayback>[1]> = {}) =>
  decidePlayback(src, { caps: DEFAULT_CAPABILITIES, quality: 'original', ...extra });

describe('parseRange', () => {
  it.each([
    [undefined, 1000, null],
    ['bytes=0-99', 1000, { start: 0, end: 99 }],
    ['bytes=500-', 1000, { start: 500, end: 999 }],
    ['bytes=-100', 1000, { start: 900, end: 999 }],
    ['bytes=900-5000', 1000, { start: 900, end: 999 }],
    ['bytes=-5000', 1000, { start: 0, end: 999 }],
    ['bytes=1000-', 1000, 'unsatisfiable'],
    ['bytes=50-10', 1000, 'unsatisfiable'],
    ['bytes=-0', 1000, 'unsatisfiable'],
    ['bytes=0-1,5-9', 1000, null],
    ['items=0-1', 1000, null],
  ] as const)('%s of %d', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe('decidePlayback', () => {
  it('direct-plays browser-friendly MP4', () => {
    const d = decide(source());
    expect(d).toMatchObject({ method: 'direct', reasons: [], videoStreamIndex: 0, audioStreamIndex: 1 });
  });

  it('remuxes H.264 in MKV with AC3 audio, encoding audio to AAC stereo', () => {
    const d = decide(source({ container: 'mkv', streams: [h264, { ...aac, codec: 'ac3', channels: 6 }] }));
    expect(d.method).toBe('remux');
    expect(d.reasons).toEqual(['container mkv is not supported by this browser', 'audio codec ac3 is not supported by this browser']);
    expect(d.video.copy).toBe(true);
    expect(d.audio).toEqual({ copy: false, channels: 2, bitrate: 192_000 });
  });

  it('copies AAC audio into HLS when it fits the channel budget', () => {
    const d = decide(source({ container: 'mkv' }));
    expect(d).toMatchObject({ method: 'remux', audio: { copy: true } });
    const surround = decide(source({ container: 'mkv', streams: [h264, { ...aac, channels: 6 }] }), {
      caps: { ...DEFAULT_CAPABILITIES, maxAudioChannels: 6 },
    });
    expect(surround.audio).toEqual({ copy: true, channels: 6, bitrate: 384_000 });
  });

  it('transcodes HEVC for browsers without HEVC, but direct-plays it when supported', () => {
    const hevc = { ...h264, codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', bitDepth: 10, bitRate: 4_000_000 };
    const d = decide(source({ streams: [hevc, aac] }));
    expect(d.method).toBe('transcode');
    expect(d.reasons).toContain('video codec hevc is not supported by this browser');
    expect(d.video).toMatchObject({ copy: false, maxWidth: 1920, maxHeight: 1080, bitrate: 8_000_000 });

    const safari = decide(source({ streams: [hevc, aac] }), { caps: { ...DEFAULT_CAPABILITIES, videoCodecs: ['h264', 'hevc'] } });
    expect(safari.method).toBe('direct');
  });

  it('never copies 10-bit H.264', () => {
    const d = decide(source({ container: 'mkv', streams: [{ ...h264, profile: 'High 10', pixFmt: 'yuv420p10le', bitDepth: 10 }, aac] }));
    expect(d.method).toBe('transcode');
    expect(d.reasons).toContain('10-bit H.264 is not supported by browsers');
  });

  it('tone-maps HDR for SDR displays', () => {
    const d = decide(source({ hdr: 'HDR10', streams: [{ ...h264, codec: 'hevc', colorTransfer: 'smpte2084' }, aac] }));
    expect(d.method).toBe('transcode');
    expect(d.video.tonemap).toBe(true);
    const hdrDisplay = decide(source({ hdr: 'HDR10' }), { caps: { ...DEFAULT_CAPABILITIES, hdr: true } });
    expect(hdrDisplay.method).toBe('direct');
  });

  it('downscales for a lower quality and deinterlaces interlaced sources', () => {
    const d = decide(source({ streams: [{ ...h264, interlaced: true }, aac] }), { quality: '720p' });
    expect(d.method).toBe('transcode');
    expect(d.video).toMatchObject({ maxWidth: 1280, maxHeight: 720, bitrate: 4_000_000, deinterlace: true });
  });

  it('remuxes when a non-default audio track is chosen', () => {
    const french = { index: 2, type: 'audio' as const, codec: 'aac', channels: 2, language: 'fre' };
    const d = decide(source({ streams: [h264, aac, french] }), { audioStreamIndex: 2 });
    expect(d).toMatchObject({ method: 'remux', audioStreamIndex: 2 });
    expect(d.reasons).toEqual(['selected audio track is not the default track']);
  });

  it('falls back to transcoding when the container has no keyframe index', () => {
    const d = decide(source({ container: 'ts' }), { disallowCopy: true });
    expect(d.method).toBe('transcode');
    expect(d.reasons).toContain('no keyframe index for stream copy');
  });

  it('picks the audio track in the profile language', () => {
    const streams: MediaStreamInfo[] = [
      h264,
      { ...aac, language: 'eng' },
      { index: 2, type: 'audio', codec: 'aac', language: 'fre', hearingImpaired: true },
      { index: 3, type: 'audio', codec: 'aac', language: 'fre' },
    ];
    expect(chooseAudioStream(streams, undefined, 'fr-FR')?.index).toBe(3);
    expect(chooseAudioStream(streams, undefined, 'de')?.index).toBe(1);
    expect(chooseAudioStream(streams, 2, 'en')?.index).toBe(2);
  });
});

describe('helpers', () => {
  it('fits sizes and builds codec strings', () => {
    expect(fitWithin(3840, 1600, 1920, 1080)).toEqual({ width: 1920, height: 800 });
    expect(fitWithin(1280, 720, 1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(720, 480, 1280, 720)).toEqual({ width: 720, height: 480 });
    expect(avcCodecString('High', 41)).toBe('avc1.640029');
    expect(avcCodecString('Main', 31)).toBe('avc1.4D401F');
    expect(avcCodecString('Constrained Baseline', 30)).toBe('avc1.42E01E');
  });
});

describe('segment plans', () => {
  it('builds fixed-length plans', () => {
    const plan = gridPlan(10, 4);
    expect(plan.starts).toEqual([0, 4, 8]);
    expect(segmentDuration(plan, 2)).toBe(2);
    expect(segmentAt(plan, 0)).toBe(0);
    expect(segmentAt(plan, 7.9)).toBe(1);
    expect(segmentAt(plan, 100)).toBe(2);
  });

  it('groups keyframes into segments of at least the target length', () => {
    const keyframes = [0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5];
    const plan = keyframePlan(keyframes, 19, 4)!;
    expect(plan.starts).toEqual([0, 5, 10, 15]);
    expect(segmentDuration(plan, 3)).toBe(4);
  });

  it('rejects sparse keyframe indexes', () => {
    expect(keyframePlan([0, 30, 60], 90, 4)).toBeNull();
  });

  it('writes a VOD playlist', () => {
    const text = mediaPlaylist(keyframePlan([0, 4.2, 8.4], 10, 4)!, (i) => `${i}.ts`);
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:5',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXTINF:4.200,',
        '0.ts',
        '#EXTINF:4.200,',
        '1.ts',
        '#EXTINF:1.600,',
        '2.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });
});

describe('buildRunArgs', () => {
  const base: Omit<RunSpec, 'plan' | 'start' | 'end' | 'video'> = {
    input: '/media/movie.mkv',
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    audio: { copy: false, channels: 2, bitrate: 192_000 },
    outputPattern: '/tmp/s/r1-%d.ts',
    listFile: '/tmp/s/r1.csv',
    vaapiDevice: '/dev/dri/renderD128',
    segmentSeconds: 4,
  };
  const opt = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it('stream-copies from a keyframe with a nudged, non-accurate seek', () => {
    const plan = keyframePlan([0, 4.2, 8.4, 12.6, 16.8], 20, 4)!;
    const args = buildRunArgs({ ...base, plan, start: 2, end: 4, video: { copy: true } });
    expect(args.slice(args.indexOf('-noaccurate_seek'), args.indexOf('-i') + 2)).toEqual([
      '-noaccurate_seek', '-ss', '8.550', '-i', '/media/movie.mkv',
    ]);
    expect(opt(args, '-c:v')).toBe('copy');
    expect(opt(args, '-segment_times')).toBe('4.020,8.220');
    expect(opt(args, '-t')).toBe('9.250');
    expect(opt(args, '-output_ts_offset')).toBe('8.550');
    expect(opt(args, '-segment_start_number')).toBe('2');
    expect(opt(args, '-avoid_negative_ts')).toBe('disabled');
    expect(opt(args, '-segment_format_options')).toBe('avoid_negative_ts=disabled');
  });

  it('transcodes with forced keyframes on the segment grid', () => {
    const plan = gridPlan(30, 4);
    const args = buildRunArgs({
      ...base,
      plan,
      start: 3,
      end: 8,
      video: {
        copy: false,
        encoder: { kind: 'software', name: 'libx264' },
        maxWidth: 1280,
        maxHeight: 720,
        bitrate: 4_000_000,
        tonemap: true,
        deinterlace: false,
        level: '4.1',
      },
    });
    expect(args).not.toContain('-noaccurate_seek');
    expect(opt(args, '-ss')).toBe('12.000');
    expect(opt(args, '-c:v')).toBe('libx264');
    expect(opt(args, '-maxrate')).toBe('4000000');
    expect(opt(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*4)');
    expect(opt(args, '-vf')).toMatch(/^scale=w='min\(iw,1280\)'.*tonemap=tonemap=hable.*format=yuv420p$/);
    // Last run of the file: no -t, no closing split.
    const last = buildRunArgs({ ...base, plan, start: 6, end: 60, video: { copy: true } });
    expect(last).not.toContain('-t');
    expect(opt(last, '-segment_times')).toBe('3.820');
  });

  it('starts at the beginning without seeking', () => {
    const args = buildRunArgs({ ...base, plan: gridPlan(8, 4), start: 0, end: 2, video: { copy: true } });
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-output_ts_offset');
  });
});
