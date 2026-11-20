import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../lib/logger.js';
import type { VideoEncoder } from './encoders.js';
import { buildRunArgs, type AudioOutput, type VideoOutput } from './ffmpeg-args.js';
import { mediaPlaylist, segmentCount, type SegmentPlan } from './segments.js';

/** Segments per ffmpeg run (~4 min). Bounds the encoder lead and the command length. */
const RUN_SEGMENTS = 60;
/** Start the next run when the player is this close to the end of what exists. */
const PREFETCH_SEGMENTS = 12;
/** Wait for a running encoder rather than restarting it when the request is this close. */
const WAIT_AHEAD_TRANSCODE = 2;
const WAIT_AHEAD_COPY = 8;
/** Segments kept on disk around the play position. */
const KEEP_WINDOW = 150;
const SEGMENT_WAIT_MS = 90_000;
const LIST_POLL_MS = 150;

export interface HlsSessionInit {
  id: string;
  profileId: number;
  fileId: number;
  input: string;
  dir: string;
  plan: SegmentPlan;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  video: VideoOutput;
  audio: AudioOutput;
  /** Master playlist attributes. */
  codecs: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  ffmpegPath: string;
  vaapiDevice: string;
  segmentSeconds: number;
  log: Logger;
  /** A hardware encoder failed: report it and get the software encoder to retry with. */
  onEncoderFailure?: (encoder: VideoEncoder) => VideoEncoder;
  onFirstSegment?: () => void;
}

interface Run {
  seq: number;
  start: number;
  end: number;
  child: ChildProcess;
  listFile: string;
  listOffset: number;
  /** Highest segment index completed by this run (start - 1 before the first). */
  produced: number;
  stderr: string;
  killed: boolean;
  exited: Promise<void>;
  poll: NodeJS.Timeout;
}

interface Waiter {
  resolve: (file: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SegmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentUnavailableError';
  }
}

/**
 * One HLS transcode/remux of one file for one player. The full VOD playlist
 * is known up front; ffmpeg runs are started on demand, restarted on seeks
 * and chained ahead of the play position.
 */
export class HlsSession {
  readonly id: string;
  readonly profileId: number;
  readonly fileId: number;
  readonly createdAt = Date.now();
  lastAccess = Date.now();

  private readonly ready = new Map<number, string>();
  private readonly waiters = new Map<number, Waiter[]>();
  private run: Run | null = null;
  private runSeq = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private lastRequested = -1;
  private destroyed = false;
  private firstSegmentSeen = false;
  private video: VideoOutput;
  private consecutiveFailures = 0;

  constructor(private readonly init: HlsSessionInit) {
    this.id = init.id;
    this.profileId = init.profileId;
    this.fileId = init.fileId;
    this.video = init.video;
    fs.mkdirSync(init.dir, { recursive: true });
  }

  get segmentCount(): number {
    return segmentCount(this.init.plan);
  }

  get isTranscoding(): boolean {
    return !this.video.copy;
  }

  get isRunning(): boolean {
    return this.run !== null;
  }

  touch(): void {
    this.lastAccess = Date.now();
  }

  masterPlaylist(): string {
    const attrs = [`BANDWIDTH=${Math.round(this.init.bandwidth)}`, `CODECS="${this.init.codecs}"`];
    if (this.init.resolution) attrs.push(`RESOLUTION=${this.init.resolution.width}x${this.init.resolution.height}`);
    return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-STREAM-INF:${attrs.join(',')}`, 'index.m3u8', ''].join(
      '\n',
    );
  }

  mediaPlaylist(): string {
    return mediaPlaylist(this.init.plan, (i) => `${i}.ts`);
  }

  info() {
    return {
      id: this.id,
      profileId: this.profileId,
      fileId: this.fileId,
      mode: this.video.copy ? 'remux' : 'transcode',
      encoder: this.video.copy ? 'copy' : this.video.encoder.name,
      segments: this.segmentCount,
      ready: this.ready.size,
      position: this.lastRequested,
      running: this.run ? { start: this.run.start, end: this.run.end, produced: this.run.produced } : null,
      createdAt: new Date(this.createdAt).toISOString(),
      lastAccess: new Date(this.lastAccess).toISOString(),
    };
  }

  /** Resolves with the path of a completed segment, starting/restarting ffmpeg as needed. */
  async segment(index: number): Promise<string> {
    if (this.destroyed) throw new SegmentUnavailableError('Session has ended');
    if (!Number.isInteger(index) || index < 0 || index >= this.segmentCount) {
      throw new SegmentUnavailableError(`Segment ${index} does not exist`);
    }
    this.touch();

    let file = this.ready.get(index);
    if (!file) {
      // Register before deciding, so a run finishing in between cannot strand the request.
      const pending = this.waitFor(index);
      pending.catch(() => undefined);
      await this.exclusive(async () => {
        if (this.ready.has(index) || this.destroyed) return;
        const run = this.run;
        const waitAhead = this.video.copy ? WAIT_AHEAD_COPY : WAIT_AHEAD_TRANSCODE;
        const covered = run && index >= run.start && index < run.end && index <= run.produced + 1 + waitAhead;
        if (!covered) await this.startRun(index);
      });
      file = await pending;
    }

    this.lastRequested = index;
    this.prune(index);
    this.prefetch(index);
    return file;
  }

  /** Stops ffmpeg (e.g. idle player); segments on disk are kept. */
  async stop(): Promise<void> {
    await this.exclusive(() => this.stopRun());
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.exclusive(() => this.stopRun());
    this.rejectWaiters(() => true, new SegmentUnavailableError('Session has ended'));
    await fs.promises.rm(this.init.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private waitFor(index: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const existing = this.ready.get(index);
      if (existing) return resolve(existing);
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(index, waiter);
          reject(new SegmentUnavailableError(`Timed out waiting for segment ${index}`));
        }, SEGMENT_WAIT_MS),
      };
      const list = this.waiters.get(index) ?? [];
      list.push(waiter);
      this.waiters.set(index, list);
    });
  }

  private removeWaiter(index: number, waiter: Waiter): void {
    const list = this.waiters.get(index)?.filter((w) => w !== waiter);
    if (list?.length) this.waiters.set(index, list);
    else this.waiters.delete(index);
  }

  private rejectWaiters(predicate: (index: number) => boolean, error: Error): void {
    for (const [index, list] of [...this.waiters]) {
      if (!predicate(index)) continue;
      this.waiters.delete(index);
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(error);
      }
    }
  }

  private markReady(index: number, file: string): void {
    this.ready.set(index, file);
    if (!this.firstSegmentSeen) {
      this.firstSegmentSeen = true;
      this.init.onFirstSegment?.();
    }
    const list = this.waiters.get(index);
    if (!list) return;
    this.waiters.delete(index);
    for (const w of list) {
      clearTimeout(w.timer);
      w.resolve(file);
    }
  }

  private pollList(run: Run): void {
    let text: string;
    try {
      const fd = fs.openSync(run.listFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= run.listOffset) return;
        const buf = Buffer.alloc(size - run.listOffset);
        fs.readSync(fd, buf, 0, buf.length, run.listOffset);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // list not created yet
    }
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return;
    run.listOffset += Buffer.byteLength(text.slice(0, lastNewline + 1));
    for (const line of text.slice(0, lastNewline).split(/\r?\n/)) {
      const name = line.split(',')[0]?.trim();
      const m = name ? /-(\d+)\.ts$/.exec(name) : null;
      if (!m) continue;
      const index = Number(m[1]);
      if (index < run.start || index >= run.end) continue; // overshoot segment closing the run
      run.produced = Math.max(run.produced, index);
      this.markReady(index, path.join(this.init.dir, name!));
    }
  }

  private async startRun(start: number): Promise<void> {
    await this.stopRun();
    if (this.destroyed) return;

    const seq = ++this.runSeq;
    const end = Math.min(this.segmentCount, start + RUN_SEGMENTS);
    const listFile = path.join(this.init.dir, `r${seq}.csv`);
    const args = buildRunArgs({
      input: this.init.input,
      plan: this.init.plan,
      start,
      end,
      videoStreamIndex: this.init.videoStreamIndex,
      audioStreamIndex: this.init.audioStreamIndex,
      video: this.video,
      audio: this.init.audio,
      outputPattern: path.join(this.init.dir, `r${seq}-%d.ts`),
      listFile,
      vaapiDevice: this.init.vaapiDevice,
      segmentSeconds: this.init.segmentSeconds,
    });
    this.init.log.debug({ session: this.id, start, end, args }, 'Starting ffmpeg run');

    const child = spawn(this.init.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let resolveExit!: () => void;
    const run: Run = {
      seq,
      start,
      end,
      child,
      listFile,
      listOffset: 0,
      produced: start - 1,
      stderr: '',
      killed: false,
      exited: new Promise<void>((r) => (resolveExit = r)),
      poll: setInterval(() => this.pollList(run), LIST_POLL_MS),
    };
    this.run = run;

    // Anything waiting outside the new run's range will not be produced.
    this.rejectWaiters((i) => i < start || i >= end, new SegmentUnavailableError('Superseded by a seek'));

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-4000);
    });
    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      clearInterval(run.poll);
      this.pollList(run);
      if (this.run === run) this.run = null;
      resolveExit();
      if (!run.killed) this.onRunExit(run, code, spawnError);
    });
  }

  private async stopRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.killed = true;
    this.run = null;
    clearInterval(run.poll);
    run.child.kill('SIGKILL');
    await run.exited;
  }

  private onRunExit(run: Run, code: number | null, spawnError?: Error): void {
    if (code === 0 && !spawnError) {
      this.consecutiveFailures = 0;
      this.rejectWaiters((i) => i >= run.start && i < run.end, new SegmentUnavailableError('Segment was not produced'));
      if (this.lastRequested >= 0) this.prefetch(this.lastRequested);
      return;
    }

    const detail = spawnError?.message ?? run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
    this.init.log.warn({ session: this.id, code, start: run.start, error: detail }, 'ffmpeg run failed');
    this.consecutiveFailures++;

    // A hardware encoder that fails before producing anything: retry once in software.
    const video = this.video;
    if (!video.copy && video.encoder.kind !== 'software' && run.produced < run.start && this.init.onEncoderFailure) {
      this.video = { ...video, encoder: this.init.onEncoderFailure(video.encoder) };
      if (this.waiters.size > 0 && !this.destroyed) {
        const restart = Math.min(...this.waiters.keys());
        void this.exclusive(() => this.startRun(restart)).catch(() => undefined);
        return;
      }
    }
    this.rejectWaiters(
      (i) => i >= run.start && i < run.end,
      new SegmentUnavailableError(`Transcoder failed: ${detail || `exit code ${code}`}`),
    );
  }

  /** Chains the next run when the player nears the end of the produced range. */
  private prefetch(position: number): void {
    if (this.destroyed || this.run || this.consecutiveFailures > 2) return;
    const limit = Math.min(this.segmentCount, position + 1 + PREFETCH_SEGMENTS);
    for (let i = position + 1; i < limit; i++) {
      if (this.ready.has(i)) continue;
      void this.exclusive(async () => {
        if (!this.run && !this.ready.has(i) && !this.destroyed) await this.startRun(i);
      }).catch((err: unknown) => this.init.log.warn({ session: this.id, err }, 'Prefetch failed'));
      return;
    }
  }

  /** Deletes segments far from the play position to bound disk usage. */
  private prune(position: number): void {
    for (const [index, file] of this.ready) {
      if (Math.abs(index - position) <= KEEP_WINDOW) continue;
      this.ready.delete(index);
      fs.promises.rm(file, { force: true }).catch(() => undefined);
    }
  }
}
