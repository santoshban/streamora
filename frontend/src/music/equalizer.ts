/** Band centres of the 10-band graphic equalizer (ISO octaves). */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
/** Each band and the preamp go this far up and down, in dB. */
export const EQ_RANGE = 12;
const BAND_Q = 1.41;

export interface EqSettings {
  enabled: boolean;
  /** A preset id, or 'custom' once a band was moved by hand. */
  preset: string;
  /** dB per band, in EQ_BANDS order. */
  gains: number[];
  /** dB before the bands, to make room for boosts. */
  preamp: number;
}

export interface EqPreset {
  id: string;
  label: string;
  gains: number[];
}

export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', label: 'Bass boost', gains: [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0] },
  { id: 'bass-reducer', label: 'Bass reducer', gains: [-6, -5, -4, -2.5, -1, 0, 0, 0, 0, 0] },
  { id: 'treble-boost', label: 'Treble boost', gains: [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6] },
  { id: 'treble-reducer', label: 'Treble reducer', gains: [0, 0, 0, 0, 0, -1, -2.5, -4, -5, -6] },
  { id: 'vocal', label: 'Vocal', gains: [-2, -3, -3, 1, 3.5, 3.5, 3, 1.5, 0, -1.5] },
  { id: 'acoustic', label: 'Acoustic', gains: [4.5, 4.5, 3.5, 1, 2, 1.5, 3, 3.5, 3, 2] },
  { id: 'classical', label: 'Classical', gains: [4.5, 3.5, 3, 2.5, -1.5, -1.5, 0, 2, 3, 3.5] },
  { id: 'dance', label: 'Dance', gains: [4.5, 6, 4, 0, 1, 2.5, 4, 4, 3.5, 0] },
  { id: 'hip-hop', label: 'Hip-hop', gains: [5, 4.5, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3] },
  { id: 'jazz', label: 'Jazz', gains: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 4] },
  { id: 'pop', label: 'Pop', gains: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5] },
  { id: 'rock', label: 'Rock', gains: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5] },
  { id: 'loudness', label: 'Loudness', gains: [6, 4, 0, 0, -2, 0, -1, -5, 5, 1] },
  { id: 'small-speakers', label: 'Small speakers', gains: [5.5, 4.5, 4, 2.5, 1, 0, -1, -2, -2.5, -3] },
  { id: 'late-night', label: 'Late night', gains: [3, 2.5, 1.5, 0, -1, 0, 1.5, 2, 1.5, 0.5] },
];

const FLAT: EqSettings = { enabled: false, preset: 'flat', gains: EQ_PRESETS[0]!.gains, preamp: 0 };

const clampDb = (db: number) => Math.round(Math.min(EQ_RANGE, Math.max(-EQ_RANGE, db)) * 2) / 2;

/** The preset these gains are, or 'custom'. */
export const presetFor = (gains: number[]) => EQ_PRESETS.find((p) => p.gains.every((g, i) => g === gains[i]))?.id ?? 'custom';

type Ctx = typeof AudioContext;
const AudioContextClass: Ctx | undefined =
  typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctx }).webkitAudioContext);

/**
 * A 10-band equalizer on the player's `<audio>` element, built with Web Audio:
 * element → preamp → 10 filters → limiter → speakers. Settings are kept per
 * profile on this device (headphones and speakers want different curves).
 *
 * Nothing is built until the equalizer is first turned on. Once an element
 * feeds a Web Audio graph it is only heard through it, and a context the
 * browser hasn't let start yet is silent. So the element is only handed over
 * once the context runs; until then the music plays as it is.
 */
export class Equalizer {
  private settings: EqSettings;
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private input: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private limiter: DynamicsCompressorNode | null = null;
  private routedThroughEq: boolean | null = null;
  private gestureWait: (() => void) | null = null;

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly storageKey: string,
  ) {
    this.settings = this.restore();
  }

  readonly supported = !!AudioContextClass;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.settings;

  /** The equalizer is on and changes the sound. */
  get shaping(): boolean {
    const s = this.settings;
    return s.enabled && (s.preamp !== 0 || s.gains.some((g) => g !== 0));
  }

  setEnabled(enabled: boolean): void {
    this.update({ enabled });
  }

  setPreset(id: string): void {
    const preset = EQ_PRESETS.find((p) => p.id === id);
    if (preset) this.update({ preset: preset.id, gains: [...preset.gains], enabled: true });
  }

  setBand(index: number, db: number): void {
    if (index < 0 || index >= EQ_BANDS.length) return;
    const gains = [...this.settings.gains];
    gains[index] = clampDb(db);
    if (gains[index] === this.settings.gains[index] && this.settings.enabled) return;
    this.update({ gains, preset: presetFor(gains), enabled: true });
  }

  setPreamp(db: number): void {
    this.update({ preamp: clampDb(db) });
  }

  reset(): void {
    this.update({ preset: 'flat', gains: [...FLAT.gains], preamp: 0 });
  }

  /** Called on play (usually a click): builds or wakes the audio graph if the equalizer is on. */
  prepare(): void {
    if (this.settings.enabled || this.source) this.ensureGraph();
  }

  /** Profile switched: let the sound device go (play wakes it again). */
  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private update(patch: Partial<EqSettings>): void {
    this.settings = { ...this.settings, ...patch };
    for (const l of this.listeners) l();
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch {
      // Storage full or blocked: the setting lasts until reload.
    }
    if (this.settings.enabled) this.ensureGraph();
    this.apply();
  }

  private restore(): EqSettings {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const saved = raw ? (JSON.parse(raw) as Partial<EqSettings>) : null;
      if (!saved || !Array.isArray(saved.gains) || saved.gains.length !== EQ_BANDS.length) return { ...FLAT };
      const gains = saved.gains.map((g) => clampDb(Number(g) || 0));
      return { enabled: !!saved.enabled, gains, preset: presetFor(gains), preamp: clampDb(Number(saved.preamp) || 0) };
    } catch {
      return { ...FLAT };
    }
  }

  private ensureGraph(): void {
    if (!AudioContextClass) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContextClass({ latencyHint: 'playback' });
      } catch {
        return;
      }
      const ctx = this.ctx;
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') this.connect();
        // The OS took the sound device away mid-song (a call, another app): ask for it back.
        else if (ctx.state !== 'closed' && !this.audio.paused && this.source) void ctx.resume().catch(() => undefined);
      });
      this.buildChain(ctx);
    }
    if (this.ctx.state === 'running') {
      this.connect();
      return;
    }
    // Resolves once the browser lets audio start (now, if this is a click).
    void this.ctx.resume().then(() => this.connect(), () => undefined);
    this.waitForGesture();
  }

  private buildChain(ctx: AudioContext): void {
    this.input = ctx.createGain();
    this.filters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value = BAND_Q;
      return f;
    });
    // Catches the peaks that boosts push past full scale, instead of letting them clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    let node: AudioNode = this.input;
    for (const f of this.filters) {
      node.connect(f);
      node = f;
    }
    node.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  /** Hands the element to the graph (once the context runs) and routes it through or around the bands. */
  private connect(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.input) return;
    this.stopWaiting();
    if (!this.source) {
      try {
        this.source = ctx.createMediaElementSource(this.audio);
      } catch {
        return;
      }
    }
    const through = this.settings.enabled;
    if (this.routedThroughEq !== through) {
      this.source.disconnect();
      this.source.connect(through ? this.input : ctx.destination);
      this.routedThroughEq = through;
    }
    this.apply();
  }

  private apply(): void {
    const ctx = this.ctx;
    if (!ctx || !this.input || !this.limiter) return;
    if (this.source && this.routedThroughEq !== this.settings.enabled) {
      this.connect();
      return;
    }
    const { gains, preamp } = this.settings;
    // Short ramps, so dragging a band doesn't crackle.
    const at = ctx.currentTime;
    this.input.gain.setTargetAtTime(10 ** (preamp / 20), at, 0.02);
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i] ?? 0, at, 0.02));
    // Flat or cutting only: nothing goes past full scale, so the limiter stays out of the way.
    const boosting = preamp > 0 || gains.some((g) => g > 0);
    this.limiter.threshold.setValueAtTime(boosting ? -1 : 0, at);
  }

  /** Browsers start audio only after the page was touched: try again on the next touch or key. */
  private waitForGesture(): void {
    if (this.gestureWait) return;
    const retry = () => void this.ctx?.resume().then(() => this.connect(), () => undefined);
    const events = ['pointerdown', 'keydown', 'touchend'] as const;
    for (const e of events) window.addEventListener(e, retry, { capture: true, passive: true });
    this.gestureWait = () => {
      for (const e of events) window.removeEventListener(e, retry, { capture: true });
    };
  }

  private stopWaiting(): void {
    this.gestureWait?.();
    this.gestureWait = null;
  }
}
