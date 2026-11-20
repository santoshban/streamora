import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../lib/events.js';
import { HttpError } from '../lib/errors.js';
import { ffprobe } from '../lib/ffmpeg.js';
import type { Logger } from '../lib/logger.js';
import { readKeyframes } from '../media/keyframes.js';
import { normalizeProbe, type MediaProbe } from '../media/probe.js';
import { avcCodecString, fitWithin, type PlaybackDecision } from './decision.js';
import type { EncoderSelector } from './encoders.js';
import type { VideoOutput } from './ffmpeg-args.js';
import { HlsSession } from './hls-session.js';
import { gridPlan, keyframePlan, SEGMENT_SECONDS, type SegmentPlan } from './segments.js';

const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REAP_INTERVAL_MS = 15_000;
/** Stop ffmpeg for players that stopped asking for segments (paused, closed tab). */
const IDLE_STOP_MS = 2 * 60_000;
/** Forget sessions entirely after this long without a request. */
const IDLE_DESTROY_MS = 30 * 60_000;
/** A session idle this long may be evicted to make room for a new one. */
const EVICTABLE_AFTER_MS = 30_000;

export interface TranscodeManagerOptions {
  config: AppConfig;
  log: Logger;
  events: EventBus;
  encoders: EncoderSelector;
  /** Injected in tests. */
  probe?: (file: string) => Promise<MediaProbe>;
}

export interface CreateSessionInput {
  profileId: number;
  fileId: number;
  path: string;
  decision: PlaybackDecision;
}

/** Keyframe-aligned plan for stream copy, or `null` when the container has no usable index. */
export async function copyPlan(file: string, probe: MediaProbe): Promise<SegmentPlan | null> {
  if (!probe.durationSeconds) return null;
  const keyframes = await readKeyframes(file, probe.container);
  if (!keyframes) return null;
  const shifted = keyframes.map((k) => k - probe.startTimeSeconds).filter((k) => k >= -0.001);
  return keyframePlan(shifted, probe.durationSeconds, SEGMENT_SECONDS);
}

/** Owns every HLS session: creation, limits, idle clean-up. */
export class TranscodeManager {
  private readonly sessions = new Map<string, HlsSession>();
  private readonly reaper: NodeJS.Timeout;
  private readonly root: string;

  constructor(private readonly opts: TranscodeManagerOptions) {
    this.root = opts.config.media.transcodeDir;
    fs.mkdirSync(this.root, { recursive: true });
    this.cleanLeftovers();
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  async probe(file: string): Promise<MediaProbe> {
    if (this.opts.probe) return this.opts.probe(file);
    return normalizeProbe(await ffprobe(this.opts.config.media.ffprobePath, file, { timeoutMs: 30_000 }), file);
  }

  get(id: string): HlsSession | undefined {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /**
   * Creates a session for a `remux`/`transcode` decision. `plan` must be the
   * keyframe plan for remuxing (see {@link copyPlan}).
   */
  async create(input: CreateSessionInput, probe: MediaProbe, plan?: SegmentPlan): Promise<HlsSession> {
    const { decision } = input;
    if (decision.method === 'direct' || decision.videoStreamIndex === null) throw new Error('Direct play needs no session');
    if (!probe.durationSeconds) throw new HttpError(422, 'Cannot stream this file: its duration is unknown', 'UNPLAYABLE');
    const copy = decision.video.copy;
    if (copy && !plan) throw new Error('Remux sessions need a keyframe plan');

    // A player reloading the same file replaces its old session.
    for (const s of [...this.sessions.values()]) {
      if (s.profileId === input.profileId && s.fileId === input.fileId) await this.destroy(s.id);
    }
    await this.makeRoom(!copy);

    const features = await this.opts.encoders.features();
    const videoStream = probe.streams.find((s) => s.index === decision.videoStreamIndex);
    const { config } = this.opts;

    let video: VideoOutput;
    let codecs: string;
    let resolution: { width: number; height: number } | undefined;
    if (copy) {
      video = { copy: true };
      codecs = avcCodecString(videoStream?.profile, videoStream?.level);
      if (videoStream?.width && videoStream.height) resolution = { width: videoStream.width, height: videoStream.height };
    } else {
      resolution = fitWithin(videoStream?.width ?? 0, videoStream?.height ?? 0, decision.video.maxWidth, decision.video.maxHeight);
      const level = resolution.width > 1920 || resolution.height > 1088 ? '5.1' : '4.1';
      video = {
        copy: false,
        encoder: features.encoder,
        maxWidth: decision.video.maxWidth,
        maxHeight: decision.video.maxHeight,
        bitrate: decision.video.bitrate,
        tonemap: decision.video.tonemap && features.tonemap,
        deinterlace: decision.video.deinterlace,
        level,
      };
      codecs = avcCodecString('high', level === '5.1' ? 51 : 41);
    }
    if (decision.audioStreamIndex !== null) codecs += ',mp4a.40.2';

    const id = randomUUID();
    const audioBitrate = decision.audioStreamIndex === null ? 0 : decision.audio.copy ? 256_000 : decision.audio.bitrate;
    const session = new HlsSession({
      id,
      profileId: input.profileId,
      fileId: input.fileId,
      input: input.path,
      dir: path.join(this.root, id),
      plan: plan ?? gridPlan(probe.durationSeconds, SEGMENT_SECONDS),
      videoStreamIndex: decision.videoStreamIndex,
      audioStreamIndex: decision.audioStreamIndex,
      video,
      audio: decision.audio,
      codecs,
      bandwidth: Math.max(500_000, (decision.video.bitrate || probe.bitrate || 8_000_000) * 1.1 + audioBitrate),
      resolution,
      ffmpegPath: config.media.ffmpegPath,
      vaapiDevice: config.media.vaapiDevice,
      segmentSeconds: SEGMENT_SECONDS,
      log: this.opts.log,
      onEncoderFailure: (encoder) => {
        this.opts.encoders.markBroken(encoder);
        return { kind: 'software', name: 'libx264' };
      },
      onFirstSegment: () => this.opts.events.emit('transcode.ready', { sessionId: id }),
    });
    this.sessions.set(id, session);
    this.opts.log.info(
      { session: id, file: input.path, method: decision.method, encoder: copy ? 'copy' : features.encoder.name, reasons: decision.reasons },
      'Started streaming session',
    );
    return session;
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.destroy();
    return true;
  }

  async destroyForFile(fileId: number): Promise<void> {
    for (const s of [...this.sessions.values()]) if (s.fileId === fileId) await this.destroy(s.id);
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }

  private async makeRoom(transcoding: boolean): Promise<void> {
    const max = this.opts.config.media.maxTranscodeSessions;
    const limit = transcoding ? max : max * 4;
    const competing = () => [...this.sessions.values()].filter((s) => s.isTranscoding === transcoding);
    while (competing().length >= limit) {
      const idle = competing()
        .filter((s) => Date.now() - s.lastAccess > EVICTABLE_AFTER_MS)
        .sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!idle) {
        throw new HttpError(
          503,
          `The server is already running ${limit} ${transcoding ? 'transcodes' : 'streams'}. Try again when one finishes.`,
          'TRANSCODE_LIMIT',
        );
      }
      this.opts.log.info({ session: idle.id }, 'Evicting idle streaming session');
      await this.destroy(idle.id);
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      const idle = now - session.lastAccess;
      if (idle > IDLE_DESTROY_MS) await this.destroy(session.id);
      else if (idle > IDLE_STOP_MS && session.isRunning) await session.stop();
    }
  }

  /** Removes session folders left behind by a crash. Only our own UUID-named folders are touched. */
  private cleanLeftovers(): void {
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && SESSION_DIR.test(entry.name)) {
        fs.rmSync(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }
  }
}
