import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { Link, useRouter } from '../lib/router';
import { useMusic, usePlayerState } from './context';
import { albumKind, clock, hueOf } from './format';
import {
  AlbumIcon,
  ArtistIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DeleteIcon,
  LikedIcon,
  LikeIcon,
  MoreIcon,
  NoteIcon,
  PauseIcon,
  PlayIcon,
  PlayNextIcon,
  PlaylistAddIcon,
  QueueIcon,
  RadioIcon,
  ShuffleIcon,
} from './icons';
import type { PlaySource } from './player';
import type { Album, Artist, Mix, Playlist, Track } from './types';

// ── artwork ──────────────────────────────────────────────────────────────────

/** Square artwork with a tinted placeholder when there is none (or it fails). */
export function Art({
  src,
  seed,
  round = false,
  className = '',
  icon = 'note',
  eager = false,
}: {
  src: string | null | undefined;
  seed: string | number;
  round?: boolean;
  className?: string;
  icon?: 'note' | 'artist' | 'album';
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const hue = hueOf(seed);
  const Icon = icon === 'artist' ? ArtistIcon : icon === 'album' ? AlbumIcon : NoteIcon;
  return (
    <span
      className={`relative block aspect-square shrink-0 overflow-hidden bg-[#2a2a2a] ${round ? 'rounded-full' : 'rounded-[4px]'} ${className}`}
      style={!src || failed ? { background: `linear-gradient(135deg, hsl(${hue} 45% 28%), hsl(${(hue + 40) % 360} 50% 14%))` } : undefined}
    >
      {src && !failed ? (
        <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-white/40">
          <Icon size={40} className="h-[38%] w-[38%]" />
        </span>
      )}
    </span>
  );
}

/** 2×2 collage of album covers (playlists and mixes), or one cover. */
export function Collage({ arts, seed, className = '' }: { arts: string[]; seed: string | number; className?: string }) {
  if (arts.length < 4) return <Art src={arts[0]} seed={seed} className={className} />;
  return (
    <span className={`grid aspect-square shrink-0 grid-cols-2 overflow-hidden rounded-[4px] ${className}`}>
      {arts.slice(0, 4).map((a, i) => (
        <img key={i} src={a} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
      ))}
    </span>
  );
}

/** The animated bars next to the track that is playing. */
export function PlayingBars({ paused = false, className = '' }: { paused?: boolean; className?: string }) {
  return (
    <span className={`music-bars ${paused ? 'music-bars-paused' : ''} ${className}`} aria-label={paused ? 'Paused' : 'Now playing'}>
      <span />
      <span />
      <span />
    </span>
  );
}

// ── buttons ──────────────────────────────────────────────────────────────────

/** Round transparent icon button that lights up on hover. */
export function IconBtn({
  label,
  onClick,
  children,
  active = false,
  size = 40,
  className = '',
  disabled,
}: {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  active?: boolean;
  size?: number;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-150 hover:bg-white/10 active:scale-90 active:bg-white/20 disabled:opacity-30 disabled:hover:bg-transparent ${active ? 'text-white' : 'text-white/70 hover:text-white'} ${className}`}
    >
      {children}
    </button>
  );
}

export function PillButton({
  children,
  onClick,
  primary = false,
  className = '',
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-[background-color,transform] duration-150 active:scale-95 ${
        primary ? 'bg-white text-black hover:bg-white/85' : 'border border-white/20 bg-transparent text-white hover:bg-white/10'
      } ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** The big white circle "Play" of album/playlist headers. */
export function BigPlayButton({ onClick, playing, label = 'Play' }: { onClick: () => void; playing?: boolean; label?: string }) {
  return (
    <button
      type="button"
      aria-label={playing ? 'Pause' : label}
      onClick={onClick}
      className="grid size-14 shrink-0 place-items-center rounded-full bg-white text-black shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95"
    >
      {playing ? <PauseIcon size={32} /> : <PlayIcon size={32} className="translate-x-px" />}
    </button>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (v: T | null) => void;
  className?: string;
}) {
  return (
    <div className={`no-scrollbar flex gap-3 overflow-x-auto py-1 ${className}`} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(active ? null : o.value)}
            className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
              active ? 'bg-white text-black' : 'border border-white/10 bg-white/[0.1] text-white hover:bg-white/[0.2]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── popup menus ──────────────────────────────────────────────────────────────

export interface MenuEntry {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

/** A ⋮ button with a dark popup menu, placed in a portal so scrollers can't clip it. */
export function MoreMenu({ entries, label = 'Action menu', size = 40, className = '' }: { entries: MenuEntry[]; label?: string; size?: number; className?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <IconBtn
        label={label}
        size={size}
        className={className}
        onClick={(e) => {
          // Read the rect now: React clears currentTarget before a state updater runs.
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a ? null : rect));
        }}
      >
        <MoreIcon size={size >= 40 ? 24 : 20} />
      </IconBtn>
      {anchor && <PopupMenu anchor={anchor} entries={entries} onClose={() => setAnchor(null)} />}
    </>
  );
}

export function PopupMenu({ anchor, entries, onClose }: { anchor: DOMRect | { left: number; top: number; bottom: number; right: number }; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.right - w;
    if (left < 8) left = Math.min(anchor.left, vw - w - 8);
    let top = anchor.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4);
    setPos({ left: Math.max(8, left), top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Next tick, so the click that opened the menu doesn't close it.
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-56 rounded-xl bg-[#212121] py-2 text-sm shadow-[0_4px_32px_rgb(0_0_0/0.6)] ring-1 ring-white/10 animate-menu"
      style={pos ?? { left: -9999, top: -9999 }}
    >
      {entries.map((e) => (
        <button
          key={e.label}
          type="button"
          role="menuitem"
          onClick={(ev) => {
            ev.stopPropagation();
            onClose();
            e.onSelect();
          }}
          className="flex w-full items-center gap-4 px-4 py-2.5 text-left text-white/90 transition-colors hover:bg-white/10"
        >
          <span className="text-white/70">{e.icon}</span>
          {e.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Track ⋮ menu entries, plus any context-specific ones (remove from playlist/queue). */
export function useTrackMenu() {
  const { player, isLiked, toggleLike, saveToPlaylist } = useMusic();
  const { navigate } = useRouter();
  const toast = useToast();
  return useCallback(
    (track: Track, extra: MenuEntry[] = []): MenuEntry[] => [
      {
        label: 'Start radio',
        icon: <RadioIcon size={22} />,
        onSelect: () => void player.startRadio({ track }, track.title).catch((e: unknown) => toast(errorText(e), 'error')),
      },
      {
        label: 'Play next',
        icon: <PlayNextIcon size={22} />,
        onSelect: () => {
          player.playNext([track]);
          toast('Song will play next');
        },
      },
      {
        label: 'Add to queue',
        icon: <QueueIcon size={22} />,
        onSelect: () => {
          player.addToQueue([track]);
          toast('Song added to queue');
        },
      },
      { label: 'Save to playlist', icon: <PlaylistAddIcon size={22} />, onSelect: () => saveToPlaylist([track]) },
      ...extra,
      {
        label: isLiked(track) ? 'Remove from Liked music' : 'Add to Liked music',
        icon: isLiked(track) ? <LikedIcon size={22} /> : <LikeIcon size={22} />,
        onSelect: () => void toggleLike(track),
      },
      { label: 'Go to album', icon: <AlbumIcon size={22} />, onSelect: () => navigate(`/music/album/${track.album.id}`) },
      { label: 'Go to artist', icon: <ArtistIcon size={22} />, onSelect: () => navigate(`/music/artist/${track.artist.id}`) },
    ],
    [player, isLiked, toggleLike, saveToPlaylist, navigate, toast],
  );
}

/** ⋮ entries for a whole collection (album, playlist, mix, artist). */
export function useCollectionMenu() {
  const { player, saveToPlaylist } = useMusic();
  const toast = useToast();
  return useCallback(
    (load: () => Promise<Track[]>, source: PlaySource, radio?: { albumId?: number; artistId?: number }): MenuEntry[] => {
      const run = (fn: (tracks: Track[]) => void) => () =>
        void load()
          .then(fn)
          .catch((e: unknown) => toast(errorText(e), 'error'));
      return [
        { label: 'Shuffle play', icon: <ShuffleIcon size={22} />, onSelect: run((t) => player.playTracks(t, 0, source, { shuffle: true })) },
        ...(radio
          ? [
              {
                label: 'Start radio',
                icon: <RadioIcon size={22} />,
                onSelect: () => void player.startRadio(radio, source.label).catch((e: unknown) => toast(errorText(e), 'error')),
              },
            ]
          : []),
        {
          label: 'Play next',
          icon: <PlayNextIcon size={22} />,
          onSelect: run((t) => {
            player.playNext(t);
            toast(`${t.length} songs will play next`);
          }),
        },
        {
          label: 'Add to queue',
          icon: <QueueIcon size={22} />,
          onSelect: run((t) => {
            player.addToQueue(t);
            toast(`${t.length} songs added to queue`);
          }),
        },
        { label: 'Save to playlist', icon: <PlaylistAddIcon size={22} />, onSelect: run((t) => saveToPlaylist(t)) },
      ];
    },
    [player, saveToPlaylist, toast],
  );
}

export const loadAlbumTracks = (id: number) => api.get<{ tracks: Track[] }>(`/api/music/albums/${id}`).then((r) => r.tracks);
export const loadPlaylistTracks = (id: number) =>
  api.get<{ entries: Array<{ track: Track }> }>(`/api/music/playlists/${id}`).then((r) => r.entries.map((e) => e.track));
export const loadMixTracks = (id: string) => api.get<{ tracks: Track[] }>(`/api/music/mixes/${encodeURIComponent(id)}`).then((r) => r.tracks);
export const loadArtistTracks = (id: number) => api.get<{ tracks: Track[] }>(`/api/music/artists/${id}/tracks`).then((r) => r.tracks);

// ── shelves & cards ──────────────────────────────────────────────────────────

/** A titled, horizontally scrolling row with ‹ › buttons (and an optional "More"). */
export function Shelf({
  title,
  strapline,
  more,
  children,
  className = '',
  thumb,
}: {
  title: ReactNode;
  strapline?: ReactNode;
  more?: string;
  children: ReactNode;
  className?: string;
  thumb?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useLayoutEffect(() => {
    update();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, children]);
  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section className={`mt-10 ${className}`}>
      <header className="mb-4 flex items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {thumb}
          <div className="min-w-0">
            {strapline && <p className="truncate text-sm tracking-wide text-white/60 uppercase">{strapline}</p>}
            <h2 className="truncate text-[clamp(1.35rem,1.8vw,1.8rem)] leading-tight font-bold">{title}</h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {more && (
            <Link to={more} className="hidden h-8 items-center rounded-full border border-white/20 px-3.5 text-sm font-medium transition-colors hover:bg-white/10 sm:inline-flex">
              More
            </Link>
          )}
          {!(edges.start && edges.end) && (
            <>
              <button type="button" aria-label="Previous" disabled={edges.start} onClick={() => page(-1)} className="hidden size-9 place-items-center rounded-full border border-white/20 transition-colors hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent sm:grid">
                <ChevronLeftIcon />
              </button>
              <button type="button" aria-label="Next" disabled={edges.end} onClick={() => page(1)} className="hidden size-9 place-items-center rounded-full border border-white/20 transition-colors hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent sm:grid">
                <ChevronRightIcon />
              </button>
            </>
          )}
        </div>
      </header>
      <div ref={scroller} onScroll={update} className="no-scrollbar -mx-2 flex snap-x snap-mandatory scroll-px-2 gap-x-[clamp(12px,1.4vw,24px)] overflow-x-auto px-2 pb-2">
        {children}
      </div>
    </section>
  );
}

const CARD_W = 'w-[clamp(140px,15vw,226px)]';

/** Square card with a hover play button and ⋮ menu (YouTube Music's two-row item). */
function Card({
  to,
  art,
  title,
  subtitle,
  onPlay,
  menu,
  round = false,
  className = CARD_W,
  playingNow = false,
}: {
  to: string;
  art: ReactNode;
  title: string;
  subtitle: ReactNode;
  onPlay?: () => void;
  menu?: MenuEntry[];
  round?: boolean;
  className?: string;
  playingNow?: boolean;
}) {
  const { navigate } = useRouter();
  return (
    <div className={`group/card shrink-0 snap-start ${className}`}>
      <div
        className={`relative cursor-pointer overflow-hidden ${round ? 'rounded-full' : 'rounded-[4px]'}`}
        onClick={() => navigate(to)}
        data-clickable
      >
        {art}
        <div className={`absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/40 transition-opacity duration-200 ${playingNow ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100'}`} />
        {menu && !round && (
          <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
            <MoreMenu entries={menu} size={36} className="!text-white" />
          </div>
        )}
        {onPlay && (
          <button
            type="button"
            aria-label={`Play ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            className={`absolute grid size-12 place-items-center rounded-full bg-black/70 text-white transition-[opacity,transform,background-color] duration-200 hover:scale-110 hover:bg-black/90 ${
              round ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2' : 'right-3 bottom-3'
            } ${playingNow ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100'}`}
          >
            {playingNow ? <PlayingBars /> : <PlayIcon size={28} />}
          </button>
        )}
      </div>
      <div className={`mt-2.5 ${round ? 'text-center' : ''}`}>
        <Link to={to} className="line-clamp-2 text-[15px] leading-snug font-medium text-white hover:underline">
          {title}
        </Link>
        <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-white/60">{subtitle}</p>
      </div>
    </div>
  );
}

export function AlbumCard({ album, className, showArtist = true, showYear = true }: { album: Album; className?: string; showArtist?: boolean; showYear?: boolean }) {
  const { player } = useMusic();
  const { navigate } = useRouter();
  const state = usePlayerState();
  const collectionMenu = useCollectionMenu();
  const source = { label: album.title, href: `/music/album/${album.id}` };
  const playingNow = state.playing && state.source?.href === source.href;
  const sub = [albumKind(album), showArtist ? album.artist.name : null, showYear ? album.year : null].filter(Boolean).join(' • ');
  return (
    <Card
      to={source.href}
      className={className}
      art={<Art src={album.art} seed={album.id} icon="album" />}
      title={album.title}
      subtitle={sub}
      playingNow={playingNow}
      onPlay={() => (playingNow ? player.pause() : void loadAlbumTracks(album.id).then((t) => player.playTracks(t, 0, source, { shuffle: false })))}
      menu={[
        ...collectionMenu(() => loadAlbumTracks(album.id), source, { albumId: album.id }),
        { label: 'Go to artist', icon: <ArtistIcon size={22} />, onSelect: () => navigate(`/music/artist/${album.artist.id}`) },
      ]}
    />
  );
}

export function ArtistCard({ artist, className }: { artist: Artist; className?: string }) {
  const { player } = useMusic();
  return (
    <Card
      to={`/music/artist/${artist.id}`}
      className={className}
      round
      art={<Art src={artist.art} seed={artist.name} round icon="artist" />}
      title={artist.name}
      subtitle={artist.trackCount ? `${artist.trackCount} song${artist.trackCount === 1 ? '' : 's'}` : 'Artist'}
      onPlay={() => void loadArtistTracks(artist.id).then((t) => player.playTracks(t, 0, { label: artist.name, href: `/music/artist/${artist.id}` }, { shuffle: false }))}
    />
  );
}

export function PlaylistCard({ playlist, owner, className }: { playlist: Playlist; owner?: string; className?: string }) {
  const { player } = useMusic();
  const collectionMenu = useCollectionMenu();
  const source = { label: playlist.name, href: `/music/playlist/${playlist.id}` };
  return (
    <Card
      to={source.href}
      className={className}
      art={<Collage arts={playlist.arts} seed={playlist.name} />}
      title={playlist.name}
      subtitle={['Playlist', owner, `${playlist.trackCount} songs`].filter(Boolean).join(' • ')}
      onPlay={playlist.trackCount ? () => void loadPlaylistTracks(playlist.id).then((t) => player.playTracks(t, 0, source, { shuffle: false })) : undefined}
      menu={collectionMenu(() => loadPlaylistTracks(playlist.id), source)}
    />
  );
}

export function MixCard({ mix, className }: { mix: Mix; className?: string }) {
  const { player } = useMusic();
  const collectionMenu = useCollectionMenu();
  const source = { label: mix.title, href: `/music/mix/${encodeURIComponent(mix.id)}` };
  return (
    <Card
      to={source.href}
      className={className}
      art={
        <span className="relative block">
          <Collage arts={mix.arts} seed={mix.id} />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-2.5 text-[clamp(0.95rem,1.2vw,1.3rem)] leading-tight font-bold">{mix.title}</span>
        </span>
      }
      title={mix.title}
      subtitle={mix.subtitle}
      onPlay={() => void loadMixTracks(mix.id).then((t) => player.playTracks(t, 0, source, { shuffle: false }))}
      menu={collectionMenu(() => loadMixTracks(mix.id), source)}
    />
  );
}

// ── song rows ────────────────────────────────────────────────────────────────

/** Is this track the one loaded in the player (and is it playing)? */
export function useNowPlaying(trackId: number, key?: string): { current: boolean; playing: boolean } {
  const state = usePlayerState();
  const item = state.queue[state.index];
  const current = !!item && (key ? item.key === key : item.track.id === trackId);
  return { current, playing: current && state.playing };
}

/** Compact song row: thumbnail, title, "Artist • Album", like and ⋮ on hover. */
export function SongRow({
  track,
  onPlay,
  subtitle,
  menuExtra,
  className = '',
  showDuration = false,
  index,
}: {
  track: Track;
  onPlay: () => void;
  subtitle?: ReactNode;
  menuExtra?: MenuEntry[];
  className?: string;
  showDuration?: boolean;
  index?: number;
}) {
  const { player, isLiked, toggleLike } = useMusic();
  const trackMenu = useTrackMenu();
  const { current, playing } = useNowPlaying(track.id);
  const liked = isLiked(track);
  return (
    <div
      className={`group/row flex h-14 items-center gap-3 rounded-md px-2 transition-colors hover:bg-white/[0.08] ${current ? 'bg-white/[0.06]' : ''} ${className}`}
      onDoubleClick={onPlay}
    >
      {index !== undefined && <span className="w-6 shrink-0 text-center text-base font-bold text-white/90">{index}</span>}
      <button type="button" onClick={() => (current ? player.toggle() : onPlay())} aria-label={playing ? 'Pause' : `Play ${track.title}`} className="relative size-12 shrink-0">
        <Art src={track.art} seed={track.album.id} className="size-12" />
        <span className={`absolute inset-0 grid place-items-center rounded-[4px] bg-black/60 transition-opacity ${current ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}>
          {playing ? (
            <>
              <PlayingBars className="group-hover/row:hidden" />
              <PauseIcon size={24} className="hidden group-hover/row:block" />
            </>
          ) : (
            <PlayIcon size={26} />
          )}
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[15px] font-medium ${current ? 'text-white' : 'text-white'}`}>{track.title}</p>
        <p className="truncate text-sm text-white/60">
          {subtitle ?? (
            <>
              <Link to={`/music/artist/${track.artist.id}`} className="hover:text-white hover:underline" onClick={(e) => e.stopPropagation()}>
                {track.artistName}
              </Link>
              {' • '}
              <Link to={`/music/album/${track.album.id}`} className="hover:text-white hover:underline" onClick={(e) => e.stopPropagation()}>
                {track.album.title}
              </Link>
            </>
          )}
        </p>
      </div>
      <IconBtn label={liked ? 'Unlike' : 'Like'} active={liked} onClick={() => void toggleLike(track)} className={liked ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}>
        {liked ? <LikedIcon size={22} /> : <LikeIcon size={22} />}
      </IconBtn>
      {showDuration && <span className="hidden w-12 shrink-0 text-right text-sm text-white/60 tabular-nums sm:block">{clock(track.duration)}</span>}
      <MoreMenu entries={trackMenu(track, menuExtra)} className="opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100" />
    </div>
  );
}

/** The quick picks grid: four rows that scroll sideways in columns. */
export function QuickPicks({ tracks, title = 'Quick picks', strapline }: { tracks: Track[]; title?: string; strapline?: string }) {
  const { player } = useMusic();
  return (
    <Shelf title={title} strapline={strapline}>
      <div className="grid snap-start auto-cols-[min(420px,82vw)] grid-flow-col grid-rows-4 gap-x-6">
        {tracks.map((t) => (
          <SongRow key={t.id} track={t} onPlay={() => void player.startRadio({ track: t }, t.title)} className="snap-start" />
        ))}
      </div>
    </Shelf>
  );
}

/** Album/playlist track table: number (play on hover), title, artist, duration, actions. */
export function TrackTable({
  tracks,
  onPlay,
  numbered = true,
  showArtist = false,
  showAlbum = false,
  menuExtra,
  draggable,
  onMove,
}: {
  tracks: Array<{ key: string | number; track: Track }>;
  onPlay: (index: number) => void;
  numbered?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  menuExtra?: (index: number) => MenuEntry[];
  draggable?: boolean;
  onMove?: (from: number, to: number) => void;
}) {
  const { player, isLiked, toggleLike } = useMusic();
  const trackMenu = useTrackMenu();
  const state = usePlayerState();
  const current = state.queue[state.index]?.track.id;
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  return (
    <div role="list" className="divide-y divide-white/10 border-y border-white/10">
      {tracks.map(({ key, track }, i) => {
        const isCurrent = current === track.id;
        const playing = isCurrent && state.playing;
        const liked = isLiked(track);
        return (
          <div
            key={key}
            role="listitem"
            draggable={draggable}
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              setOver(i);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null && dragging !== i) onMove?.(dragging, i);
              setDragging(null);
              setOver(null);
            }}
            onDoubleClick={() => onPlay(i)}
            className={`group/row flex h-14 items-center gap-3 px-2 transition-colors hover:bg-white/[0.06] ${isCurrent ? 'bg-white/[0.05]' : ''} ${
              over === i && dragging !== null ? (dragging < i ? 'shadow-[inset_0_-2px_0_#fff]' : 'shadow-[inset_0_2px_0_#fff]') : ''
            } ${dragging === i ? 'opacity-40' : ''}`}
          >
            <button
              type="button"
              aria-label={playing ? 'Pause' : `Play ${track.title}`}
              onClick={() => (isCurrent ? player.toggle() : onPlay(i))}
              className={`grid shrink-0 place-items-center text-white/60 ${numbered ? 'w-8' : 'w-10'}`}
            >
              {numbered && !isCurrent && <span className="text-sm tabular-nums group-hover/row:hidden">{track.trackNumber ?? i + 1}</span>}
              {!numbered && !isCurrent && <Art src={track.art} seed={track.album.id} className="size-10 group-hover/row:hidden" />}
              {isCurrent && playing && <PlayingBars className="group-hover/row:hidden" />}
              {isCurrent && !playing && <PlayingBars paused className="group-hover/row:hidden" />}
              <span className="hidden text-white group-hover/row:block">{playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}</span>
            </button>
            <div className="min-w-0 flex-[2]">
              <p className={`truncate text-[15px] font-medium ${isCurrent ? 'text-white' : 'text-white/90'}`}>{track.title}</p>
              {(showArtist || track.artistName !== track.artist.name) && (
                <Link to={`/music/artist/${track.artist.id}`} className="block truncate text-sm text-white/60 hover:text-white hover:underline md:hidden">
                  {track.artistName}
                </Link>
              )}
            </div>
            {(showArtist || showAlbum) && (
              <div className="hidden min-w-0 flex-1 truncate text-sm text-white/60 md:block">
                <Link to={`/music/artist/${track.artist.id}`} className="hover:text-white hover:underline">
                  {track.artistName}
                </Link>
              </div>
            )}
            {showAlbum && (
              <div className="hidden min-w-0 flex-1 truncate text-sm text-white/60 lg:block">
                <Link to={`/music/album/${track.album.id}`} className="hover:text-white hover:underline">
                  {track.album.title}
                </Link>
              </div>
            )}
            <IconBtn label={liked ? 'Unlike' : 'Like'} active={liked} onClick={() => void toggleLike(track)} className={liked ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}>
              {liked ? <LikedIcon size={20} /> : <LikeIcon size={20} />}
            </IconBtn>
            <span className="w-12 shrink-0 text-right text-sm text-white/60 tabular-nums">{clock(track.duration)}</span>
            <MoreMenu entries={trackMenu(track, menuExtra?.(i))} className="opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100" />
          </div>
        );
      })}
    </div>
  );
}

export const removeEntry = (label: string, onSelect: () => void): MenuEntry => ({ label, icon: <DeleteIcon size={22} />, onSelect });

/** Empty / error states inside music pages. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto mt-24 max-w-lg text-center">
      <NoteIcon size={56} className="mx-auto mb-4 text-white/30" />
      <h2 className="text-2xl font-bold">{title}</h2>
      {children && <div className="mt-3 text-white/60">{children}</div>}
    </div>
  );
}

/** Grey placeholder blocks while a page loads. */
export function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="mt-8 space-y-12" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r}>
          <div className="mb-5 h-7 w-56 rounded bg-white/10 animate-pulse" />
          <div className="flex gap-6 overflow-hidden">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className={`${CARD_W} shrink-0`}>
                <div className="aspect-square rounded bg-white/10 animate-pulse" />
                <div className="mt-3 h-4 w-3/4 rounded bg-white/10 animate-pulse" />
                <div className="mt-2 h-3 w-1/2 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Adds a song to the queue and tells the user (used by drag-free "Add" buttons). */
export function usePlayActions() {
  const { player } = useMusic();
  return {
    playAll: (tracks: Track[], source: PlaySource, start = 0) => player.playTracks(tracks, start, source, { shuffle: false }),
    shuffleAll: (tracks: Track[], source: PlaySource) => player.playTracks(tracks, 0, source, { shuffle: true }),
  };
}
