import { lazy, Suspense, useEffect } from 'react';
import { Logo } from './components/Brand';
import { TitleModalHost } from './components/DetailModal';
import { Nav } from './components/Nav';
import { PreviewProvider } from './components/Preview';
import { Button, Spinner, ToastProvider } from './components/ui';
import { ServerEventsProvider } from './lib/events';
import { MusicProvider, useOptionalPlayer } from './music/context';
import { MiniPlayer } from './music/MiniPlayer';
import { postToApp } from './lib/native';
import { matchPath, RouterProvider, useRouter } from './lib/router';
import { AdminLayout } from './pages/admin/Admin';
import { HomePage, KindPage, MyListPage, NotFound, SearchPage } from './pages/Browse';
import { ProfileGate, Setup } from './pages/ProfileGate';
import { SessionProvider, useSession } from './state/session';

// hls.js is large: load the player only when someone presses Play.
const PlayerPage = lazy(() => import('./pages/Player'));
// The music section (its player engine lives in MusicProvider, so music plays on everywhere).
const MusicApp = lazy(() => import('./music/MusicApp'));

function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">{children}</div>;
}

function Routes() {
  const { path } = useRouter();
  const music = useOptionalPlayer();

  const watch = matchPath('/watch/:id', path);
  // A film or episode starting stops the music.
  useEffect(() => {
    if (watch) music?.pause();
  }, [!!watch, music]); // eslint-disable-line react-hooks/exhaustive-deps

  if (path === '/music' || path.startsWith('/music/')) {
    return (
      <Suspense
        fallback={
          <div className="fixed inset-0 grid place-items-center bg-[#030303]">
            <Spinner size={48} className="text-white/60" />
          </div>
        }
      >
        <MusicApp />
      </Suspense>
    );
  }
  if (watch) {
    return (
      <Suspense
        fallback={
          <div className="fixed inset-0 grid place-items-center bg-black">
            <Spinner size={64} className="text-brand" />
          </div>
        }
      >
        <PlayerPage fileId={Number(watch.id)} />
      </Suspense>
    );
  }
  if (path === '/admin' || path.startsWith('/admin/')) return <AdminLayout />;

  let page: React.ReactNode;
  if (path === '/') page = <HomePage />;
  else if (path === '/movies') page = <KindPage key="movie" kind="movie" />;
  else if (path === '/shows') page = <KindPage key="show" kind="show" />;
  else if (path === '/my-list') page = <MyListPage />;
  else if (path === '/search') page = <SearchPage />;
  else page = <NotFound />;

  return (
    <PreviewProvider>
      <Nav />
      {/* Keyed by path so every page change fades in. */}
      <main key={path} className="min-h-screen animate-fade-in">
        {page}
      </main>
      <TitleModalHost />
      <MiniPlayer />
    </PreviewProvider>
  );
}

function Shell() {
  const { status, refresh, profile } = useSession();

  useEffect(() => {
    if (status === 'ready' && profile) postToApp({ type: 'signedIn' });
  }, [status, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading') {
    return (
      <FullScreenMessage>
        <Logo className="text-4xl" />
        <Spinner className="text-brand" />
      </FullScreenMessage>
    );
  }
  if (status === 'offline') {
    return (
      <FullScreenMessage>
        <Logo className="text-4xl" />
        <p className="max-w-md text-neutral-300">Can&rsquo;t reach the Streamora server. Check that it is running, then try again.</p>
        <Button variant="brand" onClick={() => void refresh()}>
          Try again
        </Button>
      </FullScreenMessage>
    );
  }
  if (status === 'setup') return <Setup />;
  if (status === 'gate') return <ProfileGate />;

  return (
    // Remount everything when the profile changes so no state leaks between profiles.
    <ServerEventsProvider key={profile?.id} enabled>
      <MusicProvider profileId={profile?.id ?? 0}>
        <Routes />
      </MusicProvider>
    </ServerEventsProvider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <RouterProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </RouterProvider>
    </ToastProvider>
  );
}
