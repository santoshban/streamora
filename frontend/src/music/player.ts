import { api } from '../lib/api';
import type { Track } from './types';

/** One queue entry; `key` keeps duplicates of the same track apart. */
export interface QueueItem {
  key: string;
  track: Track;
  /** Added by autoplay once the queue ran out ("Autoplay" section of Up next). */
  auto?: boolean;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface PlaySource {
  /** "Playing from" label: an album, playlist, mix or radio name. */
  label: string;
  href?: string;
}

export interface PlayerState {
  queue: QueueItem[];
  /** Index of the current item, -1 when the queue is empty. */
  index: number;
  playing: boolean;
  buffering: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  source: PlaySource | null;
  /** The full player page is open. */
  expanded: boolean;
  error: string | null;
  /** Something was played (or restored) in this tab: video pages show the mini player. */
  active: boolean;
}

export interface PlayerTime {
  current: number;
  duration: number;
  buffered: number;
}

interface Saved {
  queue: QueueItem[];
  index: number;
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  source: PlaySource | null;
}

const MAX_SAVED = 300;
/** A play counts after 30 s, or half of a short track. */
const PLAY_THRESHOLD = 30;

let keySeq = 0;
const newKey = () => `${Date.now().toString(36)}-${(keySeq++).toString(36)}`;
export const toItems = (tracks: Track[], auto = false): QueueItem[] => tracks.map((track) => ({ key: newKey(), track, auto }));

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * The music player: one `<audio>` element, a queue and the state the UI
 * renders. Lives for the signed-in profile's whole session, so music keeps
 * playing while you browse (and resumes, paused, after a reload).
 */
export class MusicPlayer {
  private readonly audio = new Audio();
  private state: PlayerState;
  private time: PlayerTime = { current: 0, duration: 0, buffered: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly timeListeners = new Set<() => void>();
  /** Order before shuffling, to restore it. */
  private unshuffled: string[] | null = null;
  /** Transcoded streams restart at `offset` to seek; currentTime is relative to it. */
  private offset = 0;
  private transcoding = false;
  private triedTranscode = false;
  private pendingSeek: number | null = null;
  private listened = 0;
  private lastTick = 0;
  private reported = false;
  private extending = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPositionSave = 0;
  private disposed = false;

  constructor(private readonly storageKey: string) {
    this.audio.preload = 'auto';
    const saved = this.restore();
    this.state = {
      queue: saved?.queue ?? [],
      index: saved && saved.queue.length ? Math.min(Math.max(0, saved.index), saved.queue.length - 1) : -1,
      playing: false,
      buffering: false,
      shuffle: saved?.shuffle ?? false,
      repeat: saved?.repeat ?? 'off',
      autoplay: saved?.autoplay ?? true,
      volume: saved?.volume ?? 1,
      muted: saved?.muted ?? false,
      source: saved?.source ?? null,
      expanded: false,
      error: null,
      active: false,
    };
    this.audio.volume = this.state.volume;
    this.audio.muted = this.state.muted;
    this.bindAudio();
    // Restored paused; the stream is only opened when play is pressed.
    const restored = this.current;
    if (restored) {
      this.time = { current: saved?.position ?? 0, duration: restored.track.duration ?? 0, buffered: 0 };
    }
  }

  /** Called on mount (and again after React StrictMode's test unmount). */
  attach(): void {
    this.disposed = false;
    window.addEventListener('pagehide', this.saveNow);
    this.bindMediaSession();
    this.updateMetadata();
  }

  /** Profile switched or signed out: stop and remember where we were. */
  detach(): void {
    this.disposed = true;
    this.saveNow();
    window.removeEventListener('pagehide', this.saveNow);
    this.audio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  // ── store ──────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;
  subscribeTime = (listener: () => void) => {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  };
  getTime = () => this.time;

  private set(patch: Partial<PlayerState>, persist = true): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    if (persist) this.scheduleSave();
  }

  private setTime(patch: Partial<PlayerTime>): void {
    const next = { ...this.time, ...patch };
    if (next.current === this.time.current && next.duration === this.time.duration && next.buffered === this.time.buffered) return;
    this.time = next;
    for (const l of this.timeListeners) l();
  }

  get current(): QueueItem | null {
    return this.state.queue[this.state.index] ?? null;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private restore(): Saved | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const saved = raw ? (JSON.parse(raw) as Saved) : null;
      return saved && Array.isArray(saved.queue) ? saved : null;
    } catch {
      return null;
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(this.saveNow, 400);
  }

  private saveNow = (): void => {
    clearTimeout(this.saveTimer);
    const { queue, index } = this.state;
    // Keep the part of a huge queue around the current track.
    const start = Math.max(0, Math.min(index - 50, queue.length - MAX_SAVED));
    const saved: Saved = {
      queue: queue.slice(start, start + MAX_SAVED),
      index: index - start,
      position: this.time.current,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      autoplay: this.state.autoplay,
      volume: this.state.volume,
      muted: this.state.muted,
      source: this.state.source,
    };
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(saved));
    } catch {
      // Storage full or blocked: resuming is a nicety.
    }
  };

  // ── audio element ──────────────────────────────────────────────────────────

  private bindAudio(): void {
    const a = this.audio;
    a.addEventListener('play', () => this.set({ playing: true, error: null }, false));
    a.addEventListener('pause', () => {
      this.set({ playing: false }, false);
      this.saveNow();
    });
    a.addEventListener('waiting', () => this.set({ buffering: true }, false));
    a.addEventListener('playing', () => this.set({ buffering: false }, false));
    a.addEventListener('canplay', () => this.set({ buffering: false }, false));
    a.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek !== null && !this.transcoding) {
        a.currentTime = Math.min(this.pendingSeek, Math.max(0, a.duration - 1));
      }
      this.pendingSeek = null;
      this.tick();
    });
    a.addEventListener('timeupdate', () => this.tick());
    a.addEventListener('progress', () => this.tick());
    a.addEventListener('durationchange', () => this.tick());
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => this.onError());
  }

  private tick(): void {
    const a = this.audio;
    const track = this.current?.track;
    const current = this.offset + (a.currentTime || 0);
    const duration = this.transcoding ? (track?.duration ?? 0) : Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (track?.duration ?? 0);
    let buffered = 0;
    for (let i = 0; i < a.buffered.length; i++) {
      if (a.buffered.start(i) <= a.currentTime + 0.5) buffered = Math.max(buffered, a.buffered.end(i));
    }
    this.setTime({ current, duration, buffered: this.offset + buffered });

    // Count listening time, not seeking, towards a "play".
    const now = performance.now();
    if (this.state.playing && this.lastTick) this.listened += Math.min(1.5, (now - this.lastTick) / 1000);
    this.lastTick = this.state.playing ? now : 0;
    if (!this.reported && track && this.listened >= Math.min(PLAY_THRESHOLD, (duration || 60) / 2)) {
      this.reported = true;
      void api.post(`/api/music/tracks/${track.id}/played`).catch(() => undefined);
    }
    if (this.state.playing && now - this.lastPositionSave > 5000) {
      this.lastPositionSave = now;
      this.saveNow();
    }
    this.updatePositionState();
  }

  private streamUrl(track: Track, transcode: boolean, start: number): string {
    const base = `/api/music/tracks/${track.id}/stream`;
    if (!transcode) return base;
    return `${base}?transcode=1${start > 0 ? `&start=${start.toFixed(2)}` : ''}`;
  }

  /** Points the audio element at the current item. */
  private load(autoplay: boolean, startAt = 0, forceTranscode = false): void {
    const item = this.current;
    this.listened = 0;
    this.lastTick = 0;
    this.reported = false;
    if (!item) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.setTime({ current: 0, duration: 0, buffered: 0 });
      this.updateMetadata();
      return;
    }
    const { track } = item;
    const direct = !forceTranscode && !!track.mime && this.audio.canPlayType(track.mime) !== '';
    if (!forceTranscode) this.triedTranscode = false;
    this.transcoding = !direct;
    this.offset = this.transcoding ? startAt : 0;
    this.pendingSeek = this.transcoding || !startAt ? null : startAt;
    this.audio.src = this.streamUrl(track, this.transcoding, startAt);
    this.setTime({ current: startAt, duration: track.duration ?? 0, buffered: startAt });
    this.updateMetadata();
    if (autoplay) this.playAudio();
    else this.set({ buffering: false }, false);
    if (autoplay) this.maybeExtend();
  }

  private playAudio(): void {
    this.set({ active: true, buffering: true }, false);
    this.audio.play().catch((err: unknown) => {
      // Autoplay blocked (no user gesture yet): stay paused, ready to go.
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.set({ playing: false, buffering: false }, false);
    });
  }

  private onError(): void {
    const item = this.current;
    if (!item || !this.audio.getAttribute('src')) return;
    // The browser said it could play the file but couldn't: try a transcode once.
    if (!this.transcoding && !this.triedTranscode) {
      this.triedTranscode = true;
      this.load(true, this.time.current, true);
      return;
    }
    this.set({ error: `Couldn't play "${item.track.title}"`, playing: false, buffering: false }, false);
    if (this.state.index < this.state.queue.length - 1) setTimeout(() => !this.disposed && this.next(), 1500);
  }

  private onEnded(): void {
    if (this.state.repeat === 'one') {
      this.seek(0);
      this.playAudio();
      return;
    }
    const { index, queue, repeat } = this.state;
    if (index < queue.length - 1) this.jump(index + 1);
    else if (repeat === 'all' && queue.length) this.jump(0);
    else if (this.state.autoplay) void this.maybeExtend(true);
    else {
      this.set({ playing: false });
      this.seek(0);
    }
  }

  /** Autoplay: keep a few radio tracks after the last queued one. */
  private async maybeExtend(advance = false): Promise<void> {
    const { autoplay, queue, index, repeat } = this.state;
    if (!autoplay || repeat !== 'off' || this.extending || !queue.length) return;
    if (queue.length - 1 - index > 1 && !advance) return;
    const seed = queue[queue.length - 1]!.track;
    this.extending = true;
    try {
      const exclude = [...new Set(queue.slice(-200).map((q) => q.track.id))].join(',');
      const { tracks } = await api.get<{ tracks: Track[] }>(`/api/music/radio?track=${seed.id}&exclude=${exclude}&limit=20`);
      if (this.disposed) return;
      const fresh = tracks.filter((t) => t.id !== seed.id);
      if (fresh.length) {
        const wasLast = this.state.index === this.state.queue.length - 1;
        this.set({ queue: [...this.state.queue, ...toItems(fresh, true)] });
        if (advance && wasLast) this.jump(this.state.index + 1);
      } else if (advance) {
        this.set({ playing: false });
      }
    } catch {
      if (advance) this.set({ playing: false });
    } finally {
      this.extending = false;
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /** Replaces the queue and starts playing. */
  playTracks(tracks: Track[], start = 0, source: PlaySource | null = null, options: { shuffle?: boolean } = {}): void {
    if (!tracks.length) return;
    let items = toItems(tracks);
    let index = Math.min(Math.max(0, start), items.length - 1);
    const shuffle = options.shuffle ?? this.state.shuffle;
    this.unshuffled = null;
    if (shuffle) {
      this.unshuffled = items.map((i) => i.key);
      const first = options.shuffle ? items[Math.floor(Math.random() * items.length)]! : items[index]!;
      items = [first, ...shuffled(items.filter((i) => i !== first))];
      index = 0;
    }
    this.set({ queue: items, index, source, shuffle, error: null, active: true });
    this.load(true);
  }

  /** A station seeded by a track/album/artist: the seed first, then similar music. */
  async startRadio(seed: { track?: Track; albumId?: number; artistId?: number }, label: string): Promise<void> {
    if (seed.track) this.playTracks([seed.track], 0, { label: `${label} radio` }, { shuffle: false });
    const q = seed.track ? `track=${seed.track.id}` : seed.albumId ? `album=${seed.albumId}` : `artist=${seed.artistId}`;
    const { tracks } = await api.get<{ tracks: Track[] }>(`/api/music/radio?${q}&limit=30`);
    if (seed.track) {
      const rest = tracks.filter((t) => t.id !== seed.track!.id);
      if (this.current?.track.id === seed.track.id) this.set({ queue: [...this.state.queue.slice(0, this.state.index + 1), ...toItems(rest)] });
    } else {
      this.playTracks(tracks, 0, { label: `${label} radio` }, { shuffle: false });
    }
  }

  playNext(tracks: Track[]): void {
    if (!tracks.length) return;
    if (this.state.index < 0) return this.playTracks(tracks);
    const queue = [...this.state.queue];
    queue.splice(this.state.index + 1, 0, ...toItems(tracks));
    this.set({ queue });
  }

  addToQueue(tracks: Track[]): void {
    if (!tracks.length) return;
    if (this.state.index < 0) return this.playTracks(tracks);
    // Before the autoplay section, like the real queue.
    const firstAuto = this.state.queue.findIndex((q, i) => i > this.state.index && q.auto);
    const queue = [...this.state.queue];
    queue.splice(firstAuto === -1 ? queue.length : firstAuto, 0, ...toItems(tracks));
    this.set({ queue });
  }

  play(): void {
    if (this.state.index < 0) return;
    if (!this.audio.getAttribute('src')) this.load(true, this.time.current);
    else this.playAudio();
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  next(): void {
    const { index, queue, repeat } = this.state;
    if (index < queue.length - 1) this.jump(index + 1);
    else if (repeat === 'all' && queue.length) this.jump(0);
    else if (this.state.autoplay) void this.maybeExtend(true);
  }

  previous(): void {
    if (this.time.current > 3 || this.state.index <= 0) {
      this.seek(0);
      if (!this.state.playing) this.play();
      return;
    }
    this.jump(this.state.index - 1);
  }

  jump(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return;
    // Playing an autoplay item makes the items before it part of the queue proper.
    const queue = this.state.queue.map((q, i) => (i <= index && q.auto ? { ...q, auto: false } : q));
    this.set({ queue, index, error: null });
    this.load(true);
  }

  seek(seconds: number): void {
    const track = this.current?.track;
    if (!track) return;
    const max = this.time.duration || track.duration || 0;
    const t = Math.max(0, max ? Math.min(seconds, max - 0.25) : seconds);
    if (this.transcoding && this.audio.getAttribute('src')) {
      this.load(this.state.playing, t);
    } else if (this.audio.readyState >= 1) {
      this.audio.currentTime = t;
    } else {
      this.pendingSeek = t;
    }
    this.setTime({ current: t });
  }

  seekBy(delta: number): void {
    this.seek(this.time.current + delta);
  }

  remove(key: string): void {
    const at = this.state.queue.findIndex((q) => q.key === key);
    if (at < 0) return;
    const queue = this.state.queue.filter((q) => q.key !== key);
    if (at === this.state.index) {
      const index = Math.min(at, queue.length - 1);
      this.set({ queue, index });
      this.load(this.state.playing);
    } else {
      this.set({ queue, index: at < this.state.index ? this.state.index - 1 : this.state.index });
    }
  }

  /** Drag and drop in Up next. */
  move(from: number, to: number): void {
    const { queue, index } = this.state;
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
    const next = [...queue];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, { ...item!, auto: false });
    let current = index;
    if (from === index) current = to;
    else if (from < index && to >= index) current--;
    else if (from > index && to <= index) current++;
    this.set({ queue: next, index: current });
  }

  clearUpcoming(): void {
    this.set({ queue: this.state.queue.slice(0, this.state.index + 1) });
  }

  setShuffle(on: boolean): void {
    const { queue, index } = this.state;
    const current = queue[index];
    if (on) {
      this.unshuffled = queue.map((q) => q.key);
      const rest = shuffled(queue.filter((_, i) => i !== index));
      this.set({ shuffle: true, queue: current ? [current, ...rest] : rest, index: current ? 0 : -1 });
    } else {
      let next = queue;
      if (this.unshuffled) {
        const order = new Map(this.unshuffled.map((k, i) => [k, i]));
        // Known items back in their old order; anything added since stays at the end.
        next = [...queue].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
      }
      this.unshuffled = null;
      this.set({ shuffle: false, queue: next, index: current ? next.indexOf(current) : -1 });
    }
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    this.set({ repeat: order[(order.indexOf(this.state.repeat) + 1) % order.length]! });
  }

  setAutoplay(on: boolean): void {
    this.set({ autoplay: on });
    if (on) void this.maybeExtend();
    // Turning autoplay off drops the suggestions that haven't played yet.
    else this.set({ queue: this.state.queue.filter((q, i) => i <= this.state.index || !q.auto) });
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.audio.volume = v;
    this.audio.muted = v === 0 ? true : false;
    this.set({ volume: v, muted: v === 0 });
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    this.audio.muted = muted;
    if (!muted && this.state.volume === 0) this.setVolume(0.5);
    else this.set({ muted });
  }

  setExpanded(expanded: boolean): void {
    if (expanded && this.state.index < 0) return;
    this.set({ expanded }, false);
  }

  /** Hides the mini player on video pages until something is played again. */
  hide(): void {
    this.pause();
    this.set({ active: false }, false);
  }

  dismissError(): void {
    this.set({ error: null }, false);
  }

  /** Keeps queue copies of a track in step (likes made elsewhere). */
  patchTrack(id: number, patch: Partial<Track>): void {
    if (!this.state.queue.some((q) => q.track.id === id)) return;
    this.set({ queue: this.state.queue.map((q) => (q.track.id === id ? { ...q, track: { ...q.track, ...patch } } : q)) });
    if (this.current?.track.id === id) this.updateMetadata();
  }

  // ── OS media controls ──────────────────────────────────────────────────────

  private bindMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const on = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Not supported by this browser.
      }
    };
    on('play', () => this.play());
    on('pause', () => this.pause());
    on('previoustrack', () => this.previous());
    on('nexttrack', () => this.next());
    on('seekbackward', (d) => this.seekBy(-(d.seekOffset ?? 10)));
    on('seekforward', (d) => this.seekBy(d.seekOffset ?? 10));
    on('seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime));
    on('stop', () => this.pause());
  }

  private updateMetadata(): void {
    if (!('mediaSession' in navigator)) return;
    const track = this.current?.track;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const art = track.art ? new URL(track.art, window.location.origin).href : null;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artistName,
      album: track.album.title,
      artwork: art ? [{ src: art, sizes: '900x900', type: 'image/jpeg' }] : [],
    });
  }

  private updatePositionState(): void {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const { current, duration } = this.time;
    if (!duration || current > duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position: current, playbackRate: 1 });
    } catch {
      // Inconsistent values while a new track loads.
    }
  }
}
