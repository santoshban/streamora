import { useEffect, useMemo, useRef, useState } from 'react';
import { Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { useMusic, usePlayerState, usePlayerTime } from './context';
import { clock } from './format';
import { DragIcon, ExpandDownIcon, LikedIcon, LikeIcon, NextIcon, PrevIcon, RadioIcon } from './icons';
import { PlayPauseButton, RepeatButton, SeekBar, ShuffleButton } from './PlayerBar';
import type { QueueItem } from './player';
import type { Lyrics, RelatedData } from './types';
import { Art, ArtistCard, IconBtn, MoreMenu, PlayingBars, removeEntry, SongRow, useTrackMenu } from './ui';

type Tab = 'next' | 'lyrics' | 'related';

/** Average colour of an image (same-origin artwork), for the page's backdrop. */
function useArtColor(src: string | null | undefined): string {
  const [color, setColor] = useState('rgb(40 40 40)');
  useEffect(() => {
    if (!src) {
      setColor('rgb(40 40 40)');
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 12;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 12, 12);
        const data = ctx.getImageData(0, 0, 12, 12).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
        }
        const n = data.length / 4;
        // Darken so white text always reads.
        const k = 0.55;
        setColor(`rgb(${Math.round((r / n) * k)} ${Math.round((g / n) * k)} ${Math.round((b / n) * k)})`);
      } catch {
        setColor('rgb(40 40 40)');
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return color;
}

/** The full player page: artwork on the left, Up next / Lyrics / Related on the right. */
export function NowPlaying() {
  const { player, isLiked, toggleLike } = useMusic();
  const state = usePlayerState();
  const trackMenu = useTrackMenu();
  const item = state.queue[state.index];
  const [tab, setTab] = useState<Tab>('next');
  const color = useArtColor(item?.track.art);
  const open = state.expanded && !!item;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"],[role="menu"]')) player.setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, player]);

  const track = item?.track;
  const liked = track ? isLiked(track) : false;

  return (
    <div
      aria-hidden={!open}
      className={`music-now-playing fixed inset-x-0 z-30 flex flex-col overflow-hidden transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0'
      }`}
      style={{ background: `linear-gradient(180deg, ${color} 0%, #030303 75%)` }}
    >
      {track && (
        <>
          {/* Phones: a header with the collapse chevron. */}
          <div className="flex h-14 shrink-0 items-center justify-between px-2 min-[936px]:hidden">
            <IconBtn label="Close player page" onClick={() => player.setExpanded(false)} className="!text-white">
              <ExpandDownIcon size={30} />
            </IconBtn>
            <span className="truncate px-2 text-xs font-medium tracking-wider text-white/70 uppercase">{state.source?.label ?? 'Now playing'}</span>
            <MoreMenu entries={trackMenu(track)} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[max(16px,4vw)] pb-6 min-[936px]:grid min-[936px]:grid-cols-[minmax(0,1fr)_minmax(340px,38%)] min-[936px]:gap-[4vw] min-[936px]:overflow-hidden min-[936px]:py-10">
            {/* Artwork */}
            <div className="flex shrink-0 items-center justify-center min-[936px]:min-h-0 min-[936px]:shrink">
              <div className="aspect-square w-full max-w-[min(100%,52vh)] min-[936px]:h-full min-[936px]:max-h-full min-[936px]:w-auto min-[936px]:max-w-full">
                <Art key={track.album.id} src={track.art} seed={track.album.id} eager className="size-full shadow-[0_8px_48px_rgb(0_0_0/0.55)] animate-[pop_0.35s_var(--ease-out-expo)_backwards]" />
              </div>
            </div>

            {/* Phones: title + full controls under the art. */}
            <div className="min-[936px]:hidden">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold">{track.title}</h2>
                  <Link to={`/music/artist/${track.artist.id}`} onClick={() => player.setExpanded(false)} className="block truncate text-white/70 hover:underline">
                    {track.artistName}
                  </Link>
                </div>
                <IconBtn label={liked ? 'Unlike' : 'Like'} active={liked} onClick={() => void toggleLike(track)}>
                  {liked ? <LikedIcon /> : <LikeIcon />}
                </IconBtn>
              </div>
              <MobileTransport />
            </div>

            {/* Tabs */}
            <div className="flex min-h-[60vh] flex-col min-[936px]:min-h-0">
              <div role="tablist" className="flex shrink-0 border-b border-white/10">
                {(
                  [
                    ['next', 'Up next'],
                    ['lyrics', 'Lyrics'],
                    ['related', 'Related'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={`relative flex-1 py-3.5 text-sm font-medium tracking-wider uppercase transition-colors ${tab === id ? 'text-white' : 'text-white/50 hover:text-white/80'}`}
                  >
                    {label}
                    <span className={`absolute inset-x-0 bottom-0 h-0.5 bg-white transition-transform duration-200 ${tab === id ? 'scale-x-100' : 'scale-x-0'}`} />
                  </button>
                ))}
              </div>
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pt-2">
                {tab === 'next' && <UpNext />}
                {tab === 'lyrics' && <LyricsPanel trackId={track.id} />}
                {tab === 'related' && <RelatedPanel trackId={track.id} />}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MobileTransport() {
  const { player } = useMusic();
  const time = usePlayerTime();
  return (
    <div className="mt-4">
      <SeekBar thick />
      <div className="flex justify-between text-xs text-white/60 tabular-nums">
        <span>{clock(time.current)}</span>
        <span>{clock(time.duration)}</span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <ShuffleButton size={48} />
        <IconBtn label="Previous" size={56} onClick={() => player.previous()} className="!text-white">
          <PrevIcon size={36} />
        </IconBtn>
        <PlayPauseButton size={72} iconSize={48} filled />
        <IconBtn label="Next" size={56} onClick={() => player.next()} className="!text-white">
          <NextIcon size={36} />
        </IconBtn>
        <RepeatButton size={48} />
      </div>
    </div>
  );
}

// ── Up next ──────────────────────────────────────────────────────────────────

function QueueRow({
  item,
  index,
  current,
  playing,
  onDragStart,
  onDrop,
  dropMark,
}: {
  item: QueueItem;
  index: number;
  current: boolean;
  playing: boolean;
  onDragStart: (i: number) => void;
  onDrop: (i: number) => void;
  dropMark: 'above' | 'below' | null;
}) {
  const { player } = useMusic();
  const trackMenu = useTrackMenu();
  const { track } = item;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <div
      ref={ref}
      draggable={!current}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      onClick={() => (current ? player.toggle() : player.jump(index))}
      data-clickable
      className={`group/q flex h-16 items-center gap-3 rounded-md px-2 transition-colors ${current ? 'bg-white/[0.12]' : 'hover:bg-white/[0.07]'} ${
        dropMark === 'above' ? 'shadow-[inset_0_2px_0_#fff]' : dropMark === 'below' ? 'shadow-[inset_0_-2px_0_#fff]' : ''
      }`}
    >
      <span className="relative size-10 shrink-0">
        <Art src={track.art} seed={track.album.id} className="size-10" />
        {current && (
          <span className="absolute inset-0 grid place-items-center rounded-[4px] bg-black/60">
            <PlayingBars paused={!playing} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{track.title}</span>
        <span className="block truncate text-sm text-white/60">{track.artistName}</span>
      </span>
      <span className="text-sm text-white/60 tabular-nums group-hover/q:hidden">{clock(track.duration)}</span>
      <span className="hidden items-center group-hover/q:flex">
        {!current && (
          <span className="cursor-grab px-1 text-white/60 active:cursor-grabbing" aria-hidden="true">
            <DragIcon size={20} />
          </span>
        )}
        <MoreMenu size={36} entries={trackMenu(track, current ? [] : [removeEntry('Remove from queue', () => player.remove(item.key))])} />
      </span>
    </div>
  );
}

function UpNext() {
  const { player, saveToPlaylist } = useMusic();
  const state = usePlayerState();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const firstAuto = state.queue.findIndex((q, i) => i > state.index && q.auto);
  const manual = firstAuto === -1 ? state.queue : state.queue.slice(0, firstAuto);
  const auto = firstAuto === -1 ? [] : state.queue.slice(firstAuto);

  const row = (item: QueueItem, i: number) => (
    <div key={item.key} onDragEnter={() => setHoverAt(i)}>
      <QueueRow
        item={item}
        index={i}
        current={i === state.index}
        playing={state.playing}
        onDragStart={setDragFrom}
        onDrop={(to) => {
          if (dragFrom !== null) player.move(dragFrom, to);
          setDragFrom(null);
          setHoverAt(null);
        }}
        dropMark={dragFrom !== null && hoverAt === i && dragFrom !== i ? (dragFrom < i ? 'below' : 'above') : null}
      />
    </div>
  );

  return (
    <div onDragEnd={() => { setDragFrom(null); setHoverAt(null); }}>
      <div className="flex items-center justify-between gap-3 px-2 py-2">
        <div className="min-w-0">
          <p className="text-xs tracking-wider text-white/60 uppercase">Playing from</p>
          {state.source?.href ? (
            <Link to={state.source.href} onClick={() => player.setExpanded(false)} className="block truncate font-bold hover:underline">
              {state.source.label}
            </Link>
          ) : (
            <p className="truncate font-bold">{state.source?.label ?? 'Your queue'}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => saveToPlaylist(state.queue.map((q) => q.track))}
          className="h-9 shrink-0 rounded-full border border-white/20 px-4 text-sm font-medium transition-colors hover:bg-white/10"
        >
          Save
        </button>
      </div>
      {manual.map((item, i) => row(item, i))}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 px-2 pt-4 pb-2">
        <div className="flex min-w-0 items-center gap-3">
          <RadioIcon size={22} className="shrink-0 text-white/70" />
          <div className="min-w-0">
            <p className="font-bold">Autoplay</p>
            <p className="text-sm text-white/60">Similar music keeps playing when your queue ends</p>
          </div>
        </div>
        <Toggle checked={state.autoplay} onChange={(v) => player.setAutoplay(v)} label="Autoplay" />
      </div>
      {state.autoplay && auto.map((item, i) => row(item, i + manual.length))}
    </div>
  );
}

// ── Lyrics ───────────────────────────────────────────────────────────────────

function LyricsPanel({ trackId }: { trackId: number }) {
  const { player } = useMusic();
  const time = usePlayerTime();
  const res = useAsync((signal) => api.get<{ lyrics: Lyrics | null }>(`/api/music/tracks/${trackId}/lyrics`, { signal }), [trackId]);
  const lyrics = res.data?.lyrics;
  const active = useMemo(() => {
    if (!lyrics?.synced) return -1;
    let at = -1;
    for (let i = 0; i < lyrics.synced.length; i++) if (lyrics.synced[i]!.time <= time.current + 0.25) at = i;
    return at;
  }, [lyrics, time.current]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active]);

  if (res.loading) return <p className="p-6 text-white/60">Loading lyrics…</p>;
  if (!lyrics) {
    return (
      <div className="p-6 text-white/60">
        <p className="font-medium text-white">Lyrics aren’t available</p>
        <p className="mt-2 text-sm">Put an .lrc file with the same name next to the song, or add lyrics to its tags.</p>
      </div>
    );
  }
  return (
    <div ref={list} className="px-2 py-4">
      {lyrics.synced ? (
        <div className="space-y-3 pb-[30vh]">
          {lyrics.synced.map((line, i) => (
            <button
              key={i}
              type="button"
              data-line={i}
              onClick={() => player.seek(line.time)}
              className={`block w-full text-left text-[clamp(1.2rem,1.6vw,1.6rem)] leading-snug font-bold transition-[color,opacity] duration-300 ${
                i === active ? 'text-white' : i < active ? 'text-white/45 hover:text-white/70' : 'text-white/30 hover:text-white/60'
              }`}
            >
              {line.text || '♪'}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-lg leading-relaxed whitespace-pre-line text-white/90">{lyrics.plain}</p>
      )}
      <p className="mt-8 text-xs text-white/40">Source: {lyrics.source === 'lrc' ? 'synced .lrc file' : 'file tags'}</p>
    </div>
  );
}

// ── Related ──────────────────────────────────────────────────────────────────

function RelatedPanel({ trackId }: { trackId: number }) {
  const { player } = useMusic();
  const res = useAsync((signal) => api.get<RelatedData>(`/api/music/tracks/${trackId}/related`, { signal }), [trackId]);
  if (res.loading) return <p className="p-6 text-white/60">Loading…</p>;
  const data = res.data;
  if (!data || (!data.tracks.length && !data.artists.length)) return <p className="p-6 text-white/60">Nothing related yet.</p>;
  return (
    <div className="pb-8">
      {data.tracks.length > 0 && (
        <>
          <h3 className="px-2 pt-3 pb-2 text-lg font-bold">You might also like</h3>
          {data.tracks.map((t) => (
            <SongRow key={t.id} track={t} onPlay={() => void player.startRadio({ track: t }, t.title)} />
          ))}
        </>
      )}
      {data.artists.length > 0 && (
        <>
          <h3 className="px-2 pt-6 pb-3 text-lg font-bold">Similar artists</h3>
          <div className="no-scrollbar flex gap-4 overflow-x-auto px-2">
            {data.artists.map((a) => (
              <div key={a.id} onClickCapture={() => player.setExpanded(false)}>
                <ArtistCard artist={a} className="w-32" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
