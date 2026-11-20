import Hls, { type ErrorData } from 'hls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { watchUrl } from '../components/Cards';
import {
  ArrowLeftIcon,
  Back10Icon,
  CheckIcon,
  ExitFullscreenIcon,
  Forward10Icon,
  FullscreenIcon,
  GearIcon,
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  SubtitlesIcon,
  VolumeIcon,
} from '../components/Icons';
import { Button, Spinner } from '../components/ui';
import { api, errorText } from '../lib/api';
import { detectCapabilities } from '../lib/capabilities';
import { channelLabel, formatClock, languageName, sameLanguage } from '../lib/format';
import { useInterval } from '../lib/hooks';
import { useRouter } from '../lib/router';
import type { PlaybackPlan, PlayerContext, ProfilePreferences, Quality, SubtitleTrack } from '../lib/types';

const QUALITIES: Array<[Quality, string]> = [
  ['original', 'Original'],
  ['2160p', '4K'],
  ['1080p', '1080p'],
  ['720p', '720p'],
  ['480p', '480p'],
];
const SAVE_EVERY_MS = 10_000;
const UP_NEXT_SECONDS = 30;
const AUTOPLAY_COUNTDOWN = 10;

const METHOD_LABEL: Record<PlaybackPlan['method'], string> = {
  direct: 'Direct play',
  remux: 'Direct stream (remux)',
  transcode: 'Transcoding',
};

function cueStyle(prefs: ProfilePreferences): string {
  const size = { small: 'clamp(14px,1.8vw,30px)', medium: 'clamp(16px,2.5vw,40px)', large: 'clamp(20px,3.3vw,54px)' }[prefs.subtitleStyle?.size ?? 'medium'];
  const bg = prefs.subtitleStyle?.background ?? 'shadow';
  return `video::cue{font-size:${size};font-family:inherit;color:#fff;line-height:1.25;${
    bg === 'box' ? 'background:rgba(0,0,0,.78);' : 'background:transparent;'
  }${bg === 'shadow' ? 'text-shadow:0 0 4px #000,0 0 4px #000,0 2px 2px #000;' : ''}}`;
}

function pickSubtitle(tracks: SubtitleTrack[], prefs: ProfilePreferences, audioLanguage: string | null): number | null {
  const usable = tracks.filter((t) => t.renderable && t.url);
  if (prefs.subtitleLanguage) {
    const matches = usable.filter((t) => sameLanguage(t.language, prefs.subtitleLanguage));
    const pick = matches.find((t) => !t.forced && !t.hearingImpaired) ?? matches.find((t) => !t.forced) ?? matches[0];
    if (pick) return pick.id;
  }
  // Forced subtitles (foreign-language parts) in the language being heard.
  return usable.find((t) => t.forced && (!audioLanguage || sameLanguage(t.language, audioLanguage)))?.id ?? null;
}

function subtitleLabel(t: SubtitleTrack): string {
  const parts = [t.language ? languageName(t.language) : (t.label ?? 'Unknown')];
  if (t.forced) parts.push('Forced');
  if (t.hearingImpaired) parts.push('SDH');
  if (t.label && t.language && !/^(forced|sdh)$/i.test(t.label) && t.label.toLowerCase() !== languageName(t.language).toLowerCase()) parts.push(t.label);
  return parts.join(' · ');
}

export default function PlayerPage({ fileId }: { fileId: number }) {
  const { query, navigate } = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
  const sessionId = useRef<string | null>(null);
  const expiredRetries = useRef(0);
  const options = useRef<{ quality: Quality; audioStreamIndex?: number }>({ quality: 'original' });

  const [ctx, setCtx] = useState<PlayerContext | null>(null);
  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('ls.volume') ?? 1));
  const [muted, setMuted] = useState(false);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<'none' | 'tracks' | 'settings'>('none');
  const [fullscreen, setFullscreen] = useState(false);
  const [subtitleId, setSubtitleId] = useState<number | null>(null);
  const [quality, setQuality] = useState<Quality>('original');
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);

  const prefs = ctx?.preferences ?? {};

  // ── session management ─────────────────────────────────────────────────────

  const releaseSession = useCallback(() => {
    hls.current?.destroy();
    hls.current = null;
    if (sessionId.current) {
      void fetch(`/api/hls/${sessionId.current}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => undefined);
      sessionId.current = null;
    }
  }, []);

  const start = useCallback(
    async (at: number) => {
      const el = video.current;
      if (!el) return;
      setStarting(true);
      setError(null);
      try {
        const next = await api.post<PlaybackPlan>(`/api/files/${fileId}/playback`, {
          capabilities: detectCapabilities(),
          quality: options.current.quality,
          ...(options.current.audioStreamIndex !== undefined ? { audioStreamIndex: options.current.audioStreamIndex } : {}),
        });
        releaseSession();
        sessionId.current = next.sessionId;
        setPlan(next);
        setDuration(next.durationSeconds ?? 0);

        if (next.method === 'direct' || !Hls.isSupported()) {
          if (next.method !== 'direct' && !el.canPlayType('application/vnd.apple.mpegurl')) {
            throw new Error('This browser cannot play streaming video (HLS).');
          }
          el.src = next.url;
          el.addEventListener(
            'loadedmetadata',
            () => {
              if (at > 0) el.currentTime = at;
              void el.play().catch(() => undefined);
            },
            { once: true },
          );
          el.load();
        } else {
          const instance = new Hls({
            startPosition: at,
            maxBufferLength: 30,
            maxMaxBufferLength: 120,
            backBufferLength: 90,
            // The server may need a few seconds to transcode a segment after a seek.
            fragLoadPolicy: {
              default: {
                maxTimeToFirstByteMs: 90_000,
                maxLoadTimeMs: 180_000,
                timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
                errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 6000 },
              },
            },
          });
          hls.current = instance;
          instance.on(Hls.Events.MANIFEST_PARSED, () => void el.play().catch(() => undefined));
          instance.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
            if (!data.fatal) return;
            const status = data.response?.code;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && status === 404 && expiredRetries.current < 2) {
              // The server forgot this session (idle too long): start a new one where we are.
              expiredRetries.current++;
              void start(el.currentTime || at);
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              instance.recoverMediaError();
            } else {
              setError(`Playback failed (${data.details}${status ? `, HTTP ${status}` : ''}).`);
            }
          });
          instance.loadSource(next.url);
          instance.attachMedia(el);
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setStarting(false);
      }
    },
    [fileId, releaseSession],
  );

  // Load the title context, then start at ?t= or the saved position.
  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    setPlan(null);
    setEnded(false);
    setUpNextDismissed(false);
    setCountdown(null);
    expiredRetries.current = 0;
    // Another file (next episode, other version): keep the quality, let the server pick its audio track.
    options.current = { quality: options.current.quality };
    api
      .get<PlayerContext>(`/api/catalog/files/${fileId}/context`)
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        const t = query.get('t');
        void start(t !== null ? Number(t) || 0 : c.resumeSeconds);
      })
      .catch((err: unknown) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // ── progress ───────────────────────────────────────────────────────────────

  const saveProgress = useCallback(
    (beacon = false) => {
      const el = video.current;
      if (!el || !ctx || !Number.isFinite(el.currentTime) || el.currentTime < 1) return;
      const body = JSON.stringify({ positionSeconds: el.currentTime, durationSeconds: duration || el.duration || undefined });
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(`/api/progress/${fileId}`, new Blob([body], { type: 'application/json' }));
      else void fetch(`/api/progress/${fileId}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
    },
    [ctx, duration, fileId],
  );

  useInterval(() => saveProgress(), playing ? SAVE_EVERY_MS : null);
  useInterval(() => {
    if (sessionId.current) void fetch(`/api/hls/${sessionId.current}/keepalive`, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  }, !playing && plan?.sessionId ? 60_000 : null);

  useEffect(() => {
    const onHide = () => saveProgress(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      saveProgress(true);
    };
  }, [saveProgress]);

  useEffect(() => () => releaseSession(), [releaseSession]);

  // ── media element wiring ───────────────────────────────────────────────────

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    localStorage.setItem('ls.volume', String(volume));
  }, [volume, muted]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    for (const trackEl of el.querySelectorAll('track')) {
      trackEl.track.mode = Number(trackEl.dataset.id) === subtitleId ? 'showing' : 'disabled';
    }
  }, [subtitleId, plan]);

  useEffect(() => {
    if (!plan || !ctx) return;
    const audioLanguage = plan.audioTracks.find((a) => a.index === plan.audioStreamIndex)?.language ?? null;
    setSubtitleId((current) => (current !== null && plan.subtitles.some((s) => s.id === current) ? current : pickSubtitle(plan.subtitles, ctx.preferences, audioLanguage)));
  }, [plan, ctx]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Auto-hide controls while playing.
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 3000);
  }, []);
  const showControls = controls || !playing || panel !== 'none' || !!error;

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);
  const seekTo = useCallback((t: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(t, (el.duration || duration) - 0.5));
    setEnded(false);
  }, [duration]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  const goBack = useCallback(() => {
    saveProgress();
    if (window.history.length > 1) window.history.back();
    else navigate(ctx ? `/?title=${ctx.item.id}` : '/');
  }, [ctx, navigate, saveProgress]);

  const playNext = useCallback(() => {
    if (!ctx?.next) return;
    saveProgress();
    navigate(watchUrl(ctx.next), { replace: true });
  }, [ctx, navigate, saveProgress]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = video.current;
      if (!el) return;
      const handled = true;
      switch (e.key) {
        case ' ':
        case 'k':
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
          seekTo(el.currentTime - 10);
          break;
        case 'ArrowRight':
        case 'l':
          seekTo(el.currentTime + 10);
          break;
        case 'ArrowUp':
          setVolume((v) => Math.min(1, Math.round((v + 0.1) * 10) / 10));
          setMuted(false);
          break;
        case 'ArrowDown':
          setVolume((v) => Math.max(0, Math.round((v - 0.1) * 10) / 10));
          break;
        case 'm':
          setMuted((m) => !m);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'Escape':
          if (panel !== 'none') setPanel('none');
          else if (!document.fullscreenElement) goBack();
          break;
        default:
          return;
      }
      if (handled) {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, toggleFullscreen, goBack, panel, poke]);

  // ── up next ────────────────────────────────────────────────────────────────

  const remaining = duration - time;
  const showUpNext = !!ctx?.next && !upNextDismissed && duration > 0 && (ended || remaining <= UP_NEXT_SECONDS);
  useEffect(() => {
    if (!showUpNext || prefs.autoplayNext === false) {
      setCountdown(null);
      return;
    }
    setCountdown((c) => c ?? AUTOPLAY_COUNTDOWN);
  }, [showUpNext, prefs.autoplayNext]);
  useInterval(
    () => setCountdown((c) => (c === null ? null : c - 1)),
    countdown !== null && countdown > 0 && (playing || ended) ? 1000 : null,
  );
  useEffect(() => {
    if (countdown === 0) playNext();
  }, [countdown, playNext]);

  // ── track switching (keeps the position) ───────────────────────────────────

  const restartWith = (change: Partial<typeof options.current>) => {
    options.current = { ...options.current, ...change };
    setPanel('none');
    void start(video.current?.currentTime ?? 0);
  };

  const title = ctx ? (ctx.episode ? `${ctx.item.title}` : ctx.item.title) : '';
  const subtitle = ctx?.episode ? `${ctx.episode.label} “${ctx.episode.title}”` : ctx?.item.year ? String(ctx.item.year) : '';
  const renderableSubs = useMemo(() => plan?.subtitles.filter((s) => s.renderable && s.url) ?? [], [plan]);

  return (
    <div
      ref={shell}
      className={`fixed inset-0 z-50 bg-black select-none ${showControls ? '' : 'cursor-none'}`}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <style>{cueStyle(prefs)}</style>
      <video
        ref={video}
        className="size-full"
        playsInline
        onClick={() => {
          if (panel !== 'none') setPanel('none');
          else togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          poke();
        }}
        onPause={() => {
          setPlaying(false);
          saveProgress();
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onSeeking={() => setWaiting(true)}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setTime(el.currentTime);
          if (Number.isFinite(el.duration) && el.duration > 0 && !duration) setDuration(el.duration);
          const b = el.buffered;
          for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= el.currentTime + 0.5 && b.end(i) >= el.currentTime) setBuffered(b.end(i));
          }
        }}
        onDurationChange={(e) => {
          if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setDuration(e.currentTarget.duration);
        }}
        onEnded={() => {
          setEnded(true);
          setPlaying(false);
          saveProgress();
        }}
        onError={() => {
          if (!hls.current && plan) setError('This video could not be played in your browser.');
        }}
      >
        {renderableSubs.map((s) => (
          <track key={s.id} data-id={s.id} kind="subtitles" src={s.url!} srcLang={s.language ?? undefined} label={subtitleLabel(s)} />
        ))}
      </video>

      {(starting || waiting) && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Spinner size={64} className="text-brand" />
        </div>
      )}

      {/* Top bar */}
      <div className={`absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent p-4 transition-opacity duration-300 sm:p-6 ${showControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        <button type="button" onClick={goBack} aria-label="Back" className="rounded-full p-2 hover:bg-white/10">
          <ArrowLeftIcon size={28} />
        </button>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold">{title}</p>
          {subtitle && <p className="truncate text-sm text-neutral-300">{subtitle}</p>}
        </div>
      </div>

      {error && (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-6">
          <div className="max-w-md space-y-4 text-center">
            <p className="text-xl font-semibold">Something went wrong</p>
            <p className="text-sm whitespace-pre-line text-neutral-300">{error}</p>
            <div className="flex justify-center gap-3">
              <Button variant="primary" onClick={() => void start(video.current?.currentTime ?? 0)}>
                Try again
              </Button>
              <Button variant="secondary" onClick={goBack}>
                Back
              </Button>
            </div>
          </div>
        </div>
      )}

      {ended && !ctx?.next && !error && (
        <div className="absolute inset-0 grid place-items-center bg-black/70">
          <div className="space-y-4 text-center">
            <p className="text-2xl font-bold">{title}</p>
            <div className="flex justify-center gap-3">
              <Button variant="primary" onClick={() => seekTo(0)}>
                <PlayIcon /> Watch again
              </Button>
              <Button variant="secondary" onClick={goBack}>
                Back to browse
              </Button>
            </div>
          </div>
        </div>
      )}

      {showUpNext && ctx?.next && !error && (
        <div className="absolute right-4 bottom-28 w-80 overflow-hidden rounded-lg bg-neutral-900/95 shadow-2xl ring-1 ring-white/15 sm:right-10">
          <div className="space-y-1 p-4">
            <p className="text-xs font-semibold tracking-wider text-neutral-400 uppercase">Next episode</p>
            <p className="font-semibold">
              {ctx.next.episodeLabel} {ctx.next.episodeTitle && `· ${ctx.next.episodeTitle}`}
            </p>
          </div>
          <div className="flex gap-2 px-4 pb-4">
            <Button variant="primary" className="flex-1" onClick={playNext}>
              <NextIcon size={16} /> {countdown !== null && countdown > 0 ? `Play in ${countdown}` : 'Play now'}
            </Button>
            <Button variant="ghost" onClick={() => setUpNextDismissed(true)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className={`absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pt-16 pb-4 transition-opacity duration-300 sm:px-8 sm:pb-6 ${
          showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <SeekBar time={time} duration={duration} buffered={buffered} onSeek={seekTo} />
        <div className="flex items-center gap-1 sm:gap-3">
          <ControlButton label={playing ? 'Pause (space)' : 'Play (space)'} onClick={togglePlay}>
            {playing ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
          </ControlButton>
          <ControlButton label="Back 10 seconds (←)" onClick={() => seekTo(time - 10)}>
            <Back10Icon size={28} />
          </ControlButton>
          <ControlButton label="Forward 10 seconds (→)" onClick={() => seekTo(time + 10)}>
            <Forward10Icon size={28} />
          </ControlButton>
          <div className="group/vol flex items-center">
            <ControlButton label={muted ? 'Unmute (m)' : 'Mute (m)'} onClick={() => setMuted((m) => !m)}>
              {muted || volume === 0 ? <MuteIcon size={28} /> : <VolumeIcon size={28} />}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
              aria-label="Volume"
              className="range-slim w-0 opacity-0 transition-all duration-200 group-hover/vol:w-24 group-hover/vol:opacity-100 focus:w-24 focus:opacity-100"
            />
          </div>
          <span className="ml-1 text-sm text-neutral-200 tabular-nums">
            {formatClock(time)} <span className="text-neutral-500">/ {formatClock(duration)}</span>
          </span>
          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            {ctx?.next && (
              <ControlButton label="Next episode" onClick={playNext}>
                <NextIcon size={26} />
              </ControlButton>
            )}
            <div className="relative">
              <ControlButton label="Audio & subtitles" onClick={() => setPanel((p) => (p === 'tracks' ? 'none' : 'tracks'))}>
                <SubtitlesIcon size={28} />
              </ControlButton>
              {panel === 'tracks' && plan && (
                <div className="absolute right-0 bottom-14 grid w-[min(90vw,34rem)] grid-cols-2 gap-6 rounded-md bg-neutral-900/95 p-5 shadow-2xl ring-1 ring-white/10">
                  <div>
                    <p className="mb-3 text-lg font-bold">Audio</p>
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                      {plan.audioTracks.map((a) => (
                        <OptionRow
                          key={a.index}
                          selected={a.index === plan.audioStreamIndex}
                          onClick={() => restartWith({ audioStreamIndex: a.index })}
                          label={[languageName(a.language), a.title && a.title !== languageName(a.language) ? a.title : null, channelLabel(a.channels)].filter(Boolean).join(' · ')}
                        />
                      ))}
                      {plan.audioTracks.length === 0 && <li className="text-sm text-neutral-500">No audio</li>}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-3 text-lg font-bold">Subtitles</p>
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                      <OptionRow selected={subtitleId === null} onClick={() => setSubtitleId(null)} label="Off" />
                      {renderableSubs.map((s) => (
                        <OptionRow key={s.id} selected={subtitleId === s.id} onClick={() => setSubtitleId(s.id)} label={subtitleLabel(s)} />
                      ))}
                      {plan.subtitles.some((s) => !s.renderable) && (
                        <li className="pt-2 text-xs text-neutral-500">Image-based subtitles (PGS/VobSub) can&rsquo;t be shown in the browser.</li>
                      )}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <div className="relative">
              <ControlButton label="Quality & version" onClick={() => setPanel((p) => (p === 'settings' ? 'none' : 'settings'))}>
                <GearIcon size={26} />
              </ControlButton>
              {panel === 'settings' && plan && (
                <div className="absolute right-0 bottom-14 w-72 space-y-4 rounded-md bg-neutral-900/95 p-5 shadow-2xl ring-1 ring-white/10">
                  <div>
                    <p className="mb-2 font-bold">Quality</p>
                    <ul className="space-y-1">
                      {QUALITIES.map(([q, label]) => (
                        <OptionRow
                          key={q}
                          selected={quality === q}
                          label={label}
                          onClick={() => {
                            setQuality(q);
                            restartWith({ quality: q });
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                  {ctx && ctx.versions.length > 1 && (
                    <div>
                      <p className="mb-2 font-bold">Version</p>
                      <ul className="space-y-1">
                        {ctx.versions.map((v) => (
                          <OptionRow
                            key={v.id}
                            selected={v.id === fileId}
                            label={v.label}
                            onClick={() => {
                              saveProgress();
                              navigate(`/watch/${v.id}?t=${Math.floor(time)}`, { replace: true });
                            }}
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="border-t border-white/10 pt-3 text-xs text-neutral-400">
                    <span className="font-semibold text-neutral-200">{METHOD_LABEL[plan.method]}</span>
                    {plan.reasons.length > 0 && <span className="block pt-1">{plan.reasons.join('; ')}</span>}
                  </p>
                </div>
              )}
            </div>
            <ControlButton label={fullscreen ? 'Exit full screen (f)' : 'Full screen (f)'} onClick={toggleFullscreen}>
              {fullscreen ? <ExitFullscreenIcon size={28} /> : <FullscreenIcon size={28} />}
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded-full p-2 text-white transition hover:scale-110 hover:bg-white/10">
      {children}
    </button>
  );
}

function OptionRow({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/10 ${selected ? 'font-semibold text-white' : 'text-neutral-400'}`}
      >
        <span className="w-4">{selected && <CheckIcon size={16} />}</span>
        {label}
      </button>
    </li>
  );
}

function SeekBar({ time, duration, buffered, onSeek }: { time: number; duration: number; buffered: number; onSeek: (t: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };
  const shown = drag ?? time;
  const pct = (v: number) => (duration > 0 ? `${Math.min(100, (v / duration) * 100)}%` : '0%');

  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={-1}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      className="group/seek relative flex h-5 cursor-pointer items-center"
      onPointerDown={(e) => {
        if (!duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!duration) return;
        const t = at(e.clientX);
        setHover(t);
        if (drag !== null) setDrag(t);
      }}
      onPointerUp={(e) => {
        if (drag !== null) onSeek(at(e.clientX));
        setDrag(null);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="relative h-1 w-full rounded-full bg-white/25 transition-all group-hover/seek:h-1.5">
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/40" style={{ width: pct(buffered) }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: pct(shown) }} />
        <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-brand transition group-hover/seek:scale-100" style={{ left: pct(shown) }} />
      </div>
      {hover !== null && (
        <span className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded bg-black/80 px-2 py-1 text-xs tabular-nums" style={{ left: pct(hover) }}>
          {formatClock(hover)}
        </span>
      )}
    </div>
  );
}
