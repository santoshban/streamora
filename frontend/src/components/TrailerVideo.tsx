import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshIcon } from './Icons';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/**
 * A YouTube trailer that fills its (positioned) parent like `object-fit: cover`,
 * autoplays muted and is driven over the iframe postMessage API (no script tag).
 * It stays invisible until it actually plays, so the parent can cross-fade from
 * the artwork; clicks fall through to the page.
 */
export function TrailerVideo({
  videoKey,
  muted,
  playing,
  visible,
  onStart,
  onEnd,
  onFail,
  renderScale = 1,
  zoom = 1,
  settleMs = 2500,
}: {
  videoKey: string;
  muted: boolean;
  /** Pause while false (e.g. another preview is open or the modal is up). */
  playing: boolean;
  visible: boolean;
  onStart: () => void;
  onEnd: () => void;
  onFail: () => void;
  /** Render the player this many times larger and scale it down: YouTube switches small
   *  players (under ~400px) to a mode with a permanent title bar and centre button. */
  renderScale?: number;
  /** Extra zoom, e.g. to crop the black bars of letterboxed (2.39:1) trailers. */
  zoom?: number;
  /** Keep the artwork up until the video has played this long (after starting or
   *  resuming), so its start-up overlay has cleared: the cross-fade lands on clean video. */
  settleMs?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const captionsOff = useRef(false);
  const [settled, setSettled] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settleRef = useRef(settleMs);
  settleRef.current = settleMs;
  const handlers = useRef({ onStart, onEnd, onFail });
  handlers.current = { onStart, onEnd, onFail };
  const state = useRef({ muted, playing });
  state.current = { muted, playing };

  const src = useMemo(() => {
    const params = new URLSearchParams({
      autoplay: '1',
      mute: '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      playsinline: '1',
      rel: '0',
      enablejsapi: '1',
      origin: window.location.origin,
    });
    return `${YT_ORIGIN}/embed/${encodeURIComponent(videoKey)}?${params}`;
  }, [videoKey]);

  const send = useCallback((func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), YT_ORIGIN);
  }, []);

  /** What the player is doing already: the embed URL starts it muted and playing. Only
   *  changes are sent, because each command makes YouTube flash its play/pause icon. */
  const applied = useRef({ muted: true, playing: true });
  /** Push mute/play changes (commands sent before the player is ready are lost, so this
   *  runs again once it is). */
  const sync = useCallback(() => {
    const want = state.current;
    if (want.muted !== applied.current.muted) send(want.muted ? 'mute' : 'unMute');
    if (want.playing !== applied.current.playing) send(want.playing ? 'playVideo' : 'pauseVideo');
    applied.current = { ...want };
  }, [send]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (data.event === 'onReady' || (data.event === 'initialDelivery' && !ready.current)) {
        ready.current = true;
        sync();
      }
      if (data.event === 'onError') handlers.current.onFail();
      const info = data.info as { playerState?: number } | number | undefined;
      const playerState = data.event === 'onStateChange' ? info : typeof info === 'object' ? info?.playerState : undefined;
      if (playerState === 1 && !captionsOff.current) {
        // YouTube turns captions on for muted autoplay; previews don't want them.
        captionsOff.current = true;
        send('unloadModule', ['captions']);
        send('unloadModule', ['cc']);
      }
      if (playerState === 1) {
        handlers.current.onStart();
        if (!settleTimer.current) settleTimer.current = setTimeout(() => setSettled(true), settleRef.current);
      } else if (playerState === 0) handlers.current.onEnd();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sync, send]);

  useEffect(() => {
    if (ready.current) sync();
    // Paused: back to the artwork; resuming settles again before showing the video.
    if (!playing) {
      clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
      setSettled(false);
    }
  }, [muted, playing, sync]);
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700 ease-out [container-type:size] ${visible && settled ? 'opacity-100' : 'opacity-0'}`}
    >
      <iframe
        ref={frame}
        src={src}
        title="Trailer"
        tabIndex={-1}
        allow="autoplay; encrypted-media; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => {
          // Subscribe to player events.
          frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
          send('addEventListener', ['onStateChange']);
          send('addEventListener', ['onError']);
        }}
        className="absolute top-1/2 left-1/2 max-w-none border-0"
        // Cover the box like object-fit: cover, at renderScale× size, then scale back down.
        style={{
          width: `calc(max(100cqw, 100cqh * 16 / 9) * ${renderScale})`,
          height: `calc(max(100cqh, 100cqw * 9 / 16) * ${renderScale})`,
          transform: `translate(-50%, -50%) scale(${zoom / renderScale})`,
        }}
      />
    </div>
  );
}

/** Round mute / replay toggle shown over a playing (or finished) trailer. */
export function TrailerButton({
  mode,
  onClick,
  className = '',
  size = 'md',
}: {
  mode: 'muted' | 'unmuted' | 'replay';
  onClick: () => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const label = mode === 'replay' ? 'Replay trailer' : mode === 'muted' ? 'Turn sound on' : 'Mute';
  const box = size === 'sm' ? 'size-[clamp(28px,2.1vw,36px)]' : 'size-[clamp(34px,2.4vw,44px)]';
  const icon = size === 'sm' ? 15 : 18;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid shrink-0 place-items-center rounded-full border border-white/50 bg-black/30 text-white backdrop-blur-[2px] transition-[background-color,border-color,transform] duration-200 hover:border-white hover:bg-white/15 active:scale-90 animate-fade-in ${box} ${className}`}
    >
      {mode === 'replay' ? (
        <RefreshIcon key="replay" size={icon} className="animate-icon-pop" />
      ) : mode === 'muted' ? (
        <SpeakerOffIcon key="off" size={icon} />
      ) : (
        <SpeakerOnIcon key="on" size={icon} />
      )}
    </button>
  );
}

function SpeakerOffIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="animate-icon-pop">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
      <path d="m16 9 5 6M21 9l-5 6" />
    </svg>
  );
}

function SpeakerOnIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="animate-icon-pop">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}
