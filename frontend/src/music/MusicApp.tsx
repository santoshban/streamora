import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { profileRole, useAccountActions } from '../components/AccountActions';
import { Avatar, Logo } from '../components/Brand';
import { LogOutIcon } from '../components/Icons';
import { Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useDebounced, useMediaQuery, useScrollState } from '../lib/hooks';
import { Link, matchPath, useRouter } from '../lib/router';
import { useSession } from '../state/session';
import { useMusic, usePlayerState } from './context';
import { AddIcon, CloseIcon, EqualizerIcon, ExploreIcon, HomeIcon, HomeOutlineIcon, LibraryIcon, MenuIcon, MovieIcon, PinIcon, PlayIcon, SearchIcon, BackIcon } from './icons';
import { NowPlaying } from './NowPlaying';
import { PlayerBar } from './PlayerBar';
import { IconBtn, loadPlaylistTracks, PopupMenu } from './ui';

const HomePage = lazy(() => import('./pages/Home'));
const ExplorePage = lazy(() => import('./pages/Explore'));
const LibraryPage = lazy(() => import('./pages/Library'));
const AlbumPage = lazy(() => import('./pages/Album'));
const ArtistPage = lazy(() => import('./pages/Artist'));
const PlaylistPage = lazy(() => import('./pages/Playlist'));
const SearchPage = lazy(() => import('./pages/Search'));
const GenrePage = lazy(() => import('./pages/Genre'));

const WIDE = '(min-width: 1300px)';
const DESKTOP = '(min-width: 936px)';

function MusicRoutes({ path }: { path: string }) {
  let m: Record<string, string> | null;
  if (path === '/music' || path === '/music/') return <HomePage />;
  if (path === '/music/explore') return <ExplorePage />;
  if (path === '/music/library') return <LibraryPage />;
  if (path === '/music/search') return <SearchPage />;
  if (path === '/music/liked') return <PlaylistPage kind="liked" />;
  if ((m = matchPath('/music/album/:id', path))) return <AlbumPage key={m.id} id={Number(m.id)} />;
  if ((m = matchPath('/music/artist/:id', path))) return <ArtistPage key={m.id} id={Number(m.id)} />;
  if ((m = matchPath('/music/playlist/:id', path))) return <PlaylistPage key={m.id} kind="playlist" id={m.id!} />;
  if ((m = matchPath('/music/mix/:id', path))) return <PlaylistPage key={m.id} kind="mix" id={m.id!} />;
  if ((m = matchPath('/music/genre/:name', path))) return <GenrePage key={m.name} name={m.name!} />;
  return (
    <div className="mt-24 text-center">
      <h1 className="text-2xl font-bold">This page isn’t available</h1>
      <Link to="/music" className="mt-4 inline-block text-white/70 underline">
        Back to Home
      </Link>
    </div>
  );
}

/** A page that throws shows a message instead of taking the player down with it. */
class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error('Music page crashed', error);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mt-24 text-center">
        <h1 className="text-2xl font-bold">Something went wrong on this page</h1>
        <p className="mt-2 text-white/60">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })} className="mt-6 h-10 rounded-full bg-white px-5 font-medium text-black hover:bg-white/85">
          Try again
        </button>
      </div>
    );
  }
}

/** The music section: YouTube Music-style top bar, guide, pages and player. */
export default function MusicApp() {
  const { path } = useRouter();
  const { player } = useMusic();
  const state = usePlayerState();
  const wide = useMediaQuery(WIDE);
  const desktop = useMediaQuery(DESKTOP);
  // Desktop: full guide on wide screens, mini guide otherwise (the menu button toggles).
  const [guidePref, setGuidePref] = useState<boolean | null>(null);
  const [drawer, setDrawer] = useState(false);
  const guideOpen = desktop && (guidePref ?? wide);
  const hasPlayer = state.index >= 0;

  // Any navigation closes the player page and the drawer.
  useEffect(() => {
    player.setExpanded(false);
    setDrawer(false);
  }, [path, player]);

  useEffect(() => {
    document.title = 'Streamora Music';
    document.documentElement.classList.add('music-root');
    return () => {
      document.documentElement.classList.remove('music-root');
      document.title = 'Streamora';
    };
  }, []);

  useKeyboardShortcuts();

  return (
    <div className={`music-app min-h-screen bg-[#030303] text-white ${hasPlayer ? 'has-player' : ''}`} data-guide={desktop ? (guideOpen ? 'full' : 'mini') : 'none'}>
      <TopBar onMenu={() => (desktop ? setGuidePref(!guideOpen) : setDrawer((d) => !d))} />
      {desktop && <Guide mini={!guideOpen} path={path} />}
      {!desktop && drawer && (
        <div className="fixed inset-0 z-50" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60 animate-fade-in" />
          <div className="absolute inset-y-0 left-0 w-64 bg-[#0f0f0f] shadow-2xl animate-[slide-in-left_0.25s_var(--ease-out-expo)_backwards]" onClick={(e) => e.stopPropagation()}>
            <div className="flex h-16 items-center gap-2 px-4">
              <IconBtn label="Close menu" onClick={() => setDrawer(false)} className="!text-white">
                <MenuIcon />
              </IconBtn>
              <MusicLogo />
            </div>
            <Guide mini={false} path={path} drawer />
          </div>
        </div>
      )}
      <main className="music-main">
        <div className="mx-auto max-w-[1478px] px-[clamp(16px,3vw,48px)] pb-16">
          <Suspense
            fallback={
              <div className="grid h-[50vh] place-items-center">
                <Spinner className="text-white/60" />
              </div>
            }
          >
            <div key={path} className="animate-fade-in">
              <PageErrorBoundary>
                <MusicRoutes path={path} />
              </PageErrorBoundary>
            </div>
          </Suspense>
        </div>
      </main>
      <NowPlaying />
      <PlayerBar />
      {!desktop && <BottomTabs path={path} />}
    </div>
  );
}

export function MusicLogo() {
  return (
    <Link to="/music" aria-label="Streamora Music home" className="flex items-baseline gap-1.5 whitespace-nowrap select-none">
      <Logo className="text-[1.2rem]" />
      <span className="text-[0.95rem] font-semibold tracking-tight text-white/80">Music</span>
    </Link>
  );
}

// ── top bar ──────────────────────────────────────────────────────────────────

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { scrolled } = useScrollState(4);
  const { path, query, navigate } = useRouter();
  const { profile } = useSession();
  const { openEqualizer } = useMusic();
  const account = useAccountActions();
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const phone = !useMediaQuery('(min-width: 640px)');

  return (
    <header className={`fixed inset-x-0 top-0 z-40 h-16 transition-[background-color,border-color] duration-200 ${scrolled ? 'border-b border-white/10 bg-[#030303]' : 'border-b border-transparent bg-[#030303]/0'}`}>
      <div className="flex h-full items-center gap-2 px-2 sm:px-4">
        {phone && searchOpen ? (
          <>
            <IconBtn label="Back" onClick={() => setSearchOpen(false)} className="!text-white">
              <BackIcon />
            </IconBtn>
            <SearchBox autoFocus initial={path === '/music/search' ? (query.get('q') ?? '') : ''} onDone={() => setSearchOpen(false)} />
          </>
        ) : (
          <>
            <div className="music-topbar-left flex shrink-0 items-center gap-2">
              <IconBtn label="Guide" onClick={onMenu} className="!text-white">
                <MenuIcon />
              </IconBtn>
              <MusicLogo />
            </div>
            <div className="min-w-0 flex-1">{!phone && <SearchBox initial={path === '/music/search' ? (query.get('q') ?? '') : ''} />}</div>
            {phone && (
              <IconBtn label="Search" onClick={() => setSearchOpen(true)} className="!text-white">
                <SearchIcon />
              </IconBtn>
            )}
            <Link to="/" className="hidden h-9 items-center gap-2 rounded-full px-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white md:flex" title="Back to movies and shows">
              <MovieIcon size={20} /> Movies &amp; TV
            </Link>
            {profile && (
              <button
                type="button"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={!!menu}
                onClick={(e) => {
                  // Read the rect now: React clears currentTarget before a state updater runs.
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu((m) => (m ? null : rect));
                }}
                className="ml-1 rounded-full"
              >
                <Avatar profile={profile} size={32} className="!rounded-full" />
              </button>
            )}
          </>
        )}
      </div>
      {menu && profile && (
        <PopupMenu
          anchor={menu}
          label="Account menu"
          onClose={() => setMenu(null)}
          header={
            <div className="mb-2 flex items-center gap-3 border-b border-white/10 px-4 pt-2 pb-4">
              <Avatar profile={profile} size={40} className="!rounded-full" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium text-white">{profile.name}</p>
                <p className="text-[13px] text-white/60">{profileRole(profile)}</p>
              </div>
            </div>
          }
          entries={[
            { label: 'Movies & TV', icon: <MovieIcon size={22} />, onSelect: () => navigate('/') },
            { label: 'Equalizer', icon: <EqualizerIcon size={22} />, onSelect: openEqualizer },
            ...account.actions.map(({ label, Icon, onSelect }, i) => ({ label, icon: <Icon size={20} />, onSelect, separated: i === 0 })),
            { label: 'Sign out of Streamora', icon: <LogOutIcon size={20} />, onSelect: account.signOut, separated: true },
          ]}
        />
      )}
      {/* Above the player bar and guide, not inside the header's layer. */}
      {createPortal(account.dialogs, document.body)}
    </header>
  );
}

/** Search field with suggestions, like the real one: Enter searches, ↑/↓ pick a suggestion. */
function SearchBox({ initial, autoFocus, onDone }: { initial: string; autoFocus?: boolean; onDone?: () => void }) {
  const { navigate } = useRouter();
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const q = useDebounced(value.trim(), 150);

  useEffect(() => setValue(initial), [initial]);
  useEffect(() => {
    if (!focused || !q) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    api
      .get<{ suggestions: string[] }>(`/api/music/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then((r) => {
        setSuggestions(r.suggestions);
        setActive(-1);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [q, focused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setValue(t);
    setSuggestions([]);
    input.current?.blur();
    navigate(`/music/search?q=${encodeURIComponent(t)}`);
    onDone?.();
  };

  const open = focused && suggestions.length > 0;
  return (
    <div className="music-search relative w-full max-w-[480px]">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          go(active >= 0 ? suggestions[active]! : value);
        }}
        className={`flex h-10 items-center border bg-white/[0.1] transition-colors ${open ? 'rounded-t-lg border-white/20 bg-[#212121]' : 'rounded-lg border-white/10 focus-within:border-white/30 focus-within:bg-[#212121]'}`}
      >
        <span className="grid w-12 place-items-center text-white/60">
          <SearchIcon />
        </span>
        <input
          ref={input}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
            } else if (e.key === 'Escape') {
              input.current?.blur();
            }
          }}
          placeholder="Search songs, albums, artists, playlists"
          aria-label="Search music"
          className="h-full min-w-0 flex-1 bg-transparent pr-2 text-[15px] text-white outline-none placeholder:text-white/50"
        />
        {value && (
          <button type="button" aria-label="Clear search" onClick={() => { setValue(''); input.current?.focus(); }} className="grid w-10 place-items-center text-white/60 hover:text-white">
            <CloseIcon size={20} />
          </button>
        )}
      </form>
      {open && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-50 overflow-hidden rounded-b-lg border border-t-0 border-white/20 bg-[#212121] py-2 shadow-2xl">
          {suggestions.map((s, i) => (
            <li key={s} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(s)} className={`flex w-full items-center gap-4 px-4 py-2 text-left text-[15px] ${i === active ? 'bg-white/10' : 'hover:bg-white/10'}`}>
                <SearchIcon size={20} className="shrink-0 text-white/50" />
                <span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── guide (sidebar) ──────────────────────────────────────────────────────────

const NAV = [
  { to: '/music', label: 'Home', icon: HomeOutlineIcon, activeIcon: HomeIcon },
  { to: '/music/explore', label: 'Explore', icon: ExploreIcon, activeIcon: ExploreIcon },
  { to: '/music/library', label: 'Library', icon: LibraryIcon, activeIcon: LibraryIcon },
];

const isActive = (to: string, path: string) => (to === '/music' ? path === '/music' || path === '/music/' : path === to);

function Guide({ mini, path, drawer = false }: { mini: boolean; path: string; drawer?: boolean }) {
  const { playlists, newPlaylist, player } = useMusic();
  const { profile } = useSession();

  if (mini) {
    return (
      <nav aria-label="Guide" className="music-guide fixed left-0 z-30 flex w-[72px] flex-col items-center gap-1 pt-1">
        {NAV.map((n) => {
          const active = isActive(n.to, path);
          const Icon = active ? n.activeIcon : n.icon;
          return (
            <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} className={`flex w-16 flex-col items-center gap-1 rounded-lg py-3.5 text-[10px] transition-colors hover:bg-white/10 ${active ? 'bg-white/10 text-white' : 'text-white/80'}`}>
              <Icon size={24} />
              {n.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Guide" className={`${drawer ? 'h-[calc(100%-64px)]' : 'music-guide fixed left-0 z-30 w-60 border-r border-white/10'} flex flex-col bg-[#030303] pt-1`}>
      <div className="space-y-1 px-2">
        {NAV.map((n) => {
          const active = isActive(n.to, path);
          const Icon = active ? n.activeIcon : n.icon;
          return (
            <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} className={`flex h-12 items-center gap-6 rounded-lg px-4 text-[15px] font-medium transition-colors hover:bg-white/10 ${active ? 'bg-white/10 text-white' : 'text-white/90'}`}>
              <Icon size={24} />
              {n.label}
            </Link>
          );
        })}
      </div>
      <div className="mx-6 my-4 border-t border-white/15" />
      <div className="px-4">
        <button type="button" onClick={() => newPlaylist()} className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-white/10 text-sm font-medium transition-colors hover:bg-white/20">
          <AddIcon size={22} /> New playlist
        </button>
      </div>
      <div className="no-scrollbar mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        <GuidePlaylist to="/music/liked" title="Liked music" subtitle={<><PinIcon size={13} className="inline -translate-y-px" /> Auto playlist</>} active={path === '/music/liked'} />
        {(playlists ?? []).map((p) => (
          <GuidePlaylist
            key={p.id}
            to={`/music/playlist/${p.id}`}
            title={p.name}
            subtitle={profile?.name ?? 'Playlist'}
            active={path === `/music/playlist/${p.id}`}
            onPlay={p.trackCount ? () => void loadPlaylistTracks(p.id).then((t) => player.playTracks(t, 0, { label: p.name, href: `/music/playlist/${p.id}` }, { shuffle: false })) : undefined}
          />
        ))}
      </div>
    </nav>
  );
}

function GuidePlaylist({ to, title, subtitle, active, onPlay }: { to: string; title: string; subtitle: ReactNode; active: boolean; onPlay?: () => void }) {
  return (
    <div className={`group/pl relative flex items-center rounded-lg transition-colors hover:bg-white/10 ${active ? 'bg-white/10' : ''}`}>
      <Link to={to} className="min-w-0 flex-1 px-4 py-2">
        <span className="block truncate text-[15px] font-medium">{title}</span>
        <span className="block truncate text-[13px] text-white/60">{subtitle}</span>
      </Link>
      {onPlay && (
        <button type="button" aria-label={`Play ${title}`} onClick={onPlay} className="mr-2 grid size-9 place-items-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover/pl:opacity-100 hover:bg-black/70 focus-visible:opacity-100">
          <PlayIcon size={22} />
        </button>
      )}
    </div>
  );
}

function BottomTabs({ path }: { path: string }) {
  return (
    <nav aria-label="Music sections" className="music-tabs fixed inset-x-0 bottom-0 z-40 flex h-14 border-t border-white/10 bg-[#0f0f0f] sm:hidden">
      {NAV.map((n) => {
        const active = isActive(n.to, path);
        const Icon = active ? n.activeIcon : n.icon;
        return (
          <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? 'text-white' : 'text-white/60'}`}>
            <Icon size={24} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

// ── keyboard ─────────────────────────────────────────────────────────────────

/**
 * Space play/pause · Shift+N / Shift+P next/previous · ←/→ seek 10 s ·
 * M mute · S shuffle · R repeat · =/− volume · / search · Esc close player page.
 */
function useKeyboardShortcuts() {
  const { player } = useMusic();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const s = player.getState();
      if (s.index < 0) return;
      const k = e.key;
      if (k === ' ' && !(t instanceof HTMLButtonElement)) player.toggle();
      else if (e.shiftKey && (k === 'N' || k === 'n')) player.next();
      else if (e.shiftKey && (k === 'P' || k === 'p')) player.previous();
      else if (k === 'ArrowRight' && !(t?.getAttribute('role') === 'slider')) player.seekBy(10);
      else if (k === 'ArrowLeft' && !(t?.getAttribute('role') === 'slider')) player.seekBy(-10);
      else if (k === 'm' || k === 'M') player.toggleMute();
      else if (k === 's' || k === 'S') player.setShuffle(!s.shuffle);
      else if (k === 'r' || k === 'R') player.cycleRepeat();
      else if (k === '=' || k === '+') player.setVolume(s.volume + 0.1);
      else if (k === '-') player.setVolume(s.volume - 0.1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);
}
