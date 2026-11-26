import { useRef, useState } from 'react';
import { Spinner } from '../components/ui';
import { Link } from '../lib/router';
import { useMusic, usePlayerState, usePlayerTime } from './context';
import { clock } from './format';
import {
  ExpandDownIcon,
  ExpandUpIcon,
  LikedIcon,
  LikeIcon,
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  VolumeIcon,
  VolumeLowIcon,
} from './icons';
import { Art, IconBtn, MoreMenu, removeEntry, useTrackMenu } from './ui';

/** The thin seek line on top of the player bar: thickens on hover, shows the time under the pointer. */
export function SeekBar({ className = '', thick = false }: { className?: string; thick?: boolean }) {
  const { player } = useMusic();
  const time = usePlayerTime();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const duration = time.duration || 0;
  const fractionAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const played = drag ?? (duration ? time.current / duration : 0);
  const buffered = duration ? Math.min(1, time.buffered / duration) : 0;
  const shown = drag ?? hover;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time.current)}
      aria-valuetext={`${clock(time.current)} of ${clock(duration)}`}
      tabIndex={0}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') player.seekBy(5);
        else if (e.key === 'ArrowLeft') player.seekBy(-5);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') setHover(fractionAt(e.clientX));
        if (drag !== null) setDrag(fractionAt(e.clientX));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (!duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(fractionAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        player.seek(fractionAt(e.clientX) * duration);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      className={`group/seek flex h-4 cursor-pointer touch-none items-center outline-none ${className.includes('absolute') ? '' : 'relative'} ${className}`}
    >
      <div
        className={`relative w-full overflow-hidden bg-white/20 transition-[height] duration-100 ${
          thick ? 'h-1 group-hover/seek:h-1.5' : `h-0.5 group-hover/seek:h-1 ${drag !== null ? '!h-1' : ''}`
        }`}
      >
        <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${buffered * 100}%` }} />
        {shown !== null && <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${shown * 100}%` }} />}
        <div className="absolute inset-y-0 left-0 bg-[#f03]" style={{ width: `${played * 100}%` }} />
      </div>
      <span
        className={`pointer-events-none absolute size-3.5 -translate-x-1/2 rounded-full bg-[#f03] transition-transform duration-100 ${
          drag !== null ? 'scale-100' : 'scale-0 group-hover/seek:scale-100 group-focus-visible/seek:scale-100'
        }`}
        style={{ left: `${played * 100}%` }}
      />
      {shown !== null && duration > 0 && (
        <span
          className="pointer-events-none absolute bottom-5 -translate-x-1/2 rounded bg-[#212121] px-2 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg ring-1 ring-white/10"
          style={{ left: `${Math.min(97, Math.max(3, shown * 100))}%` }}
        >
          {clock(shown * duration)}
        </span>
      )}
    </div>
  );
}

export function PlayPauseButton({
  size = 40,
  iconSize = 40,
  className = '',
  filled = false,
}: {
  size?: number;
  iconSize?: number;
  className?: string;
  /** Black icon on a white circle (phone player page). */
  filled?: boolean;
}) {
  const { player } = useMusic();
  const state = usePlayerState();
  return (
    <IconBtn
      label={state.playing ? 'Pause' : 'Play'}
      size={size}
      onClick={() => player.toggle()}
      className={`${filled ? '!bg-white !text-black hover:!bg-white/85' : '!text-white'} ${className}`}
    >
      {state.buffering && state.playing ? (
        <Spinner size={iconSize * 0.7} />
      ) : state.playing ? (
        <PauseIcon size={iconSize} />
      ) : (
        <PlayIcon size={iconSize} />
      )}
    </IconBtn>
  );
}

export function RepeatButton({ size = 40 }: { size?: number }) {
  const { player } = useMusic();
  const { repeat } = usePlayerState();
  const label = repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one';
  return (
    <IconBtn label={label} size={size} active={repeat !== 'off'} onClick={() => player.cycleRepeat()} className={repeat === 'off' ? '' : '!text-white'}>
      {repeat === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
    </IconBtn>
  );
}

export function ShuffleButton({ size = 40 }: { size?: number }) {
  const { player } = useMusic();
  const { shuffle } = usePlayerState();
  return (
    <IconBtn label={shuffle ? 'Shuffle on' : 'Shuffle off'} size={size} active={shuffle} onClick={() => player.setShuffle(!shuffle)} className={shuffle ? '!text-white' : ''}>
      <ShuffleIcon />
    </IconBtn>
  );
}

function Volume() {
  const { player } = useMusic();
  const { volume, muted } = usePlayerState();
  const level = muted ? 0 : volume;
  const Icon = level === 0 ? MuteIcon : level < 0.5 ? VolumeLowIcon : VolumeIcon;
  return (
    <div className="group/vol flex items-center" onClick={(e) => e.stopPropagation()}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        aria-label="Volume"
        onChange={(e) => player.setVolume(Number(e.target.value))}
        className="range-slim mr-1 w-0 opacity-0 transition-[width,opacity] duration-200 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100"
        style={{ background: `linear-gradient(to right, #fff ${level * 100}%, rgb(255 255 255 / 0.3) ${level * 100}%)` }}
      />
      <IconBtn label={muted ? 'Unmute' : 'Mute'} onClick={() => player.toggleMute()}>
        <Icon />
      </IconBtn>
    </div>
  );
}

function TimeLabel() {
  const time = usePlayerTime();
  return (
    <span className="ml-2 hidden text-xs whitespace-nowrap text-white/70 tabular-nums lg:inline">
      {clock(time.current)} / {clock(time.duration)}
    </span>
  );
}

/** The bar along the bottom of every music page (and the mobile mini player). */
export function PlayerBar() {
  const { player, isLiked, toggleLike } = useMusic();
  const state = usePlayerState();
  const trackMenu = useTrackMenu();
  const item = state.queue[state.index];
  if (!item) return null;
  const { track } = item;
  const liked = isLiked(track);

  return (
    <div
      className={`music-player-bar fixed inset-x-0 z-40 bg-[#212121] select-none ${state.expanded ? 'max-[935px]:hidden' : ''}`}
      onClick={() => player.setExpanded(!state.expanded)}
      data-clickable
    >
      <SeekBar className="absolute inset-x-0 top-0 -translate-y-1/2" />
      <div className="flex h-full items-center gap-2 pr-2 pl-2 sm:pr-4">
        {/* Left: transport controls */}
        <div className="hidden items-center sm:flex">
          <IconBtn label="Previous" onClick={() => player.previous()} className="!text-white">
            <PrevIcon />
          </IconBtn>
          <PlayPauseButton className="mx-1" />
          <IconBtn label="Next" onClick={() => player.next()} className="!text-white">
            <NextIcon />
          </IconBtn>
          <TimeLabel />
        </div>

        {/* Middle: what's playing */}
        <div className="flex min-w-0 flex-1 items-center justify-start gap-3 sm:justify-center sm:px-4">
          <Art src={track.art} seed={track.album.id} className="size-10 sm:size-10" eager />
          <div className="min-w-0 sm:max-w-[min(32rem,36vw)]">
            <p className="truncate text-[15px] font-medium text-white">{track.title}</p>
            <p className="truncate text-sm text-white/60">
              <Link to={`/music/artist/${track.artist.id}`} onClick={(e) => { e.stopPropagation(); player.setExpanded(false); }} className="hover:text-white hover:underline">
                {track.artistName}
              </Link>
              <span className="hidden md:inline">
                {' • '}
                <Link to={`/music/album/${track.album.id}`} onClick={(e) => { e.stopPropagation(); player.setExpanded(false); }} className="hover:text-white hover:underline">
                  {track.album.title}
                </Link>
                {track.year ? ` • ${track.year}` : ''}
              </span>
            </p>
          </div>
          <div className="hidden items-center md:flex">
            <IconBtn label={liked ? 'Unlike' : 'Like'} active={liked} onClick={() => void toggleLike(track)}>
              {liked ? <LikedIcon /> : <LikeIcon />}
            </IconBtn>
            <MoreMenu entries={trackMenu(track, [removeEntry('Remove from queue', () => player.remove(item.key))])} />
          </div>
        </div>

        {/* Right: volume, modes, expand */}
        <div className="hidden items-center sm:flex">
          <Volume />
          <RepeatButton />
          <ShuffleButton />
          <IconBtn label={state.expanded ? 'Close player page' : 'Open player page'} onClick={() => player.setExpanded(!state.expanded)} className="!text-white">
            {state.expanded ? <ExpandDownIcon /> : <ExpandUpIcon />}
          </IconBtn>
        </div>

        {/* Phones: play/pause and next only */}
        <div className="flex items-center sm:hidden">
          <PlayPauseButton size={44} iconSize={32} />
          <IconBtn label="Next" onClick={() => player.next()} className="!text-white">
            <NextIcon />
          </IconBtn>
        </div>
      </div>
      {state.error && (
        <div className="absolute right-4 bottom-full mb-3 rounded-md bg-red-950 px-3 py-2 text-sm text-red-100 shadow-lg ring-1 ring-red-500/40" onClick={(e) => { e.stopPropagation(); player.dismissError(); }}>
          {state.error}
        </div>
      )}
    </div>
  );
}
