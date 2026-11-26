import { useState } from 'react';
import { Dropdown, ErrorNote, Spinner } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { useServerEvents } from '../../lib/events';
import { useAsync } from '../../lib/hooks';
import { Link, useRouter } from '../../lib/router';
import { useSession } from '../../state/session';
import { useMusic } from '../context';
import { AddIcon, LikedIcon } from '../icons';
import type { Album, Artist, Track } from '../types';
import { AlbumCard, ArtistCard, Chips, Empty, PlaylistCard, SongRow, TrackTable } from '../ui';

type Tab = 'playlists' | 'songs' | 'albums' | 'artists' | 'history';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'playlists', label: 'Playlists' },
  { value: 'songs', label: 'Songs' },
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
  { value: 'history', label: 'History' },
];
const SORTS: Record<'songs' | 'albums' | 'artists', Array<{ value: string; label: string }>> = {
  songs: [
    { value: 'added', label: 'Recently added' },
    { value: 'title', label: 'A to Z' },
    { value: 'artist', label: 'Artist' },
    { value: 'album', label: 'Album' },
    { value: 'plays', label: 'Most played' },
  ],
  albums: [
    { value: 'added', label: 'Recently added' },
    { value: 'recent', label: 'Recently played' },
    { value: 'title', label: 'A to Z' },
    { value: 'artist', label: 'Artist' },
    { value: 'year', label: 'Release year' },
  ],
  artists: [
    { value: 'name', label: 'A to Z' },
    { value: 'tracks', label: 'Most songs' },
    { value: 'added', label: 'Recently added' },
  ],
};
const PAGE = 120;
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[clamp(12px,1.4vw,24px)] gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]';

export default function Library() {
  const { query, setQuery } = useRouter();
  const tab = (TABS.find((t) => t.value === query.get('tab'))?.value ?? 'playlists') as Tab;
  const [sorts, setSorts] = useState<Record<string, string>>({ songs: 'added', albums: 'added', artists: 'name' });
  const sortable = tab === 'songs' || tab === 'albums' || tab === 'artists';

  return (
    <div className="pt-6">
      <h1 className="sr-only">Library</h1>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Chips options={TABS} value={tab} onChange={(v) => setQuery({ tab: v ?? 'playlists' }, { replace: true })} />
        {sortable && (
          <Dropdown
            label="Sort"
            value={sorts[tab]!}
            options={SORTS[tab]}
            onChange={(v) => setSorts((s) => ({ ...s, [tab]: v }))}
            align="right"
            buttonClassName="!rounded-lg !border-white/10 !bg-white/[0.1] !font-medium hover:!bg-white/[0.2]"
            menuClassName="!rounded-lg !bg-[#212121]"
          />
        )}
      </div>
      {tab === 'playlists' && <Playlists />}
      {tab === 'songs' && <Songs key={sorts.songs} sort={sorts.songs!} />}
      {tab === 'albums' && <Albums key={sorts.albums} sort={sorts.albums!} />}
      {tab === 'artists' && <Artists key={sorts.artists} sort={sorts.artists!} />}
      {tab === 'history' && <History />}
    </div>
  );
}

function Playlists() {
  const { playlists, newPlaylist } = useMusic();
  const { profile } = useSession();
  if (!playlists) return <Spinner className="text-white/60" />;
  return (
    <div className={GRID}>
      <button type="button" onClick={() => newPlaylist()} className="group text-left">
        <span className="grid aspect-square place-items-center rounded-[4px] border border-white/15 bg-white/[0.05] transition-colors group-hover:bg-white/[0.1]">
          <AddIcon size={56} className="text-white/70" />
        </span>
        <span className="mt-2.5 block text-[15px] font-medium">New playlist</span>
      </button>
      <Link to="/music/liked" className="group">
        <span className="grid aspect-square place-items-center rounded-[4px] bg-[linear-gradient(135deg,#6b3df5,#c22f8f_55%,#ff5e3a)]">
          <LikedIcon size={56} className="text-white transition-transform group-hover:scale-110" />
        </span>
        <span className="mt-2.5 block text-[15px] font-medium group-hover:underline">Liked music</span>
        <span className="block text-sm text-white/60">Auto playlist</span>
      </Link>
      {playlists.map((p) => (
        <PlaylistCard key={p.id} playlist={p} owner={profile?.name} className="w-full" />
      ))}
    </div>
  );
}

/** Paged list loader: first page from useAsync, more with "Load more". */
function usePaged<T>(url: (offset: number) => string, pick: (r: Record<string, unknown>) => T[]) {
  const [extra, setExtra] = useState<T[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useAsync((signal) => api.get<Record<string, unknown>>(url(0), { signal }), []);
  useServerEvents(['scan.completed'], () => {
    setExtra([]);
    first.reload();
  });
  const items = [...(first.data ? pick(first.data) : []), ...extra];
  const total = Number(first.data?.total ?? 0);
  const more = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<Record<string, unknown>>(url(items.length));
      setExtra((e) => [...e, ...pick(r)]);
    } finally {
      setLoadingMore(false);
    }
  };
  return { items, total, loading: first.loading && !first.data, error: first.error, reload: first.reload, more, loadingMore };
}

function LoadMore({ shown, total, onMore, busy }: { shown: number; total: number; onMore: () => void; busy: boolean }) {
  if (shown >= total) return null;
  return (
    <div className="mt-8 text-center">
      <button type="button" onClick={onMore} disabled={busy} className="h-9 rounded-full border border-white/20 px-5 text-sm font-medium hover:bg-white/10 disabled:opacity-50">
        {busy ? 'Loading…' : `Show more (${total - shown} left)`}
      </button>
    </div>
  );
}

function Songs({ sort }: { sort: string }) {
  const { player } = useMusic();
  const list = usePaged<Track>((offset) => `/api/music/tracks${qs({ sort, offset, limit: PAGE })}`, (r) => r.tracks as Track[]);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (list.loading) return <Spinner className="text-white/60" />;
  if (!list.items.length) return <Empty title="No songs yet" />;
  const source = { label: 'Your library', href: '/music/library?tab=songs' };
  return (
    <>
      <TrackTable
        tracks={list.items.map((t) => ({ key: t.id, track: t }))}
        numbered={false}
        showArtist
        showAlbum
        onPlay={(i) => player.playTracks(list.items, i, source, { shuffle: false })}
      />
      <LoadMore shown={list.items.length} total={list.total} onMore={() => void list.more()} busy={list.loadingMore} />
    </>
  );
}

function Albums({ sort }: { sort: string }) {
  const list = usePaged<Album>((offset) => `/api/music/albums${qs({ sort, offset, limit: PAGE })}`, (r) => r.albums as Album[]);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (list.loading) return <Spinner className="text-white/60" />;
  if (!list.items.length) return <Empty title="No albums yet" />;
  return (
    <>
      <div className={GRID}>
        {list.items.map((a) => (
          <AlbumCard key={a.id} album={a} className="w-full" />
        ))}
      </div>
      <LoadMore shown={list.items.length} total={list.total} onMore={() => void list.more()} busy={list.loadingMore} />
    </>
  );
}

function Artists({ sort }: { sort: string }) {
  const list = usePaged<Artist>((offset) => `/api/music/artists${qs({ sort, offset, limit: PAGE })}`, (r) => r.artists as Artist[]);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (list.loading) return <Spinner className="text-white/60" />;
  if (!list.items.length) return <Empty title="No artists yet" />;
  return (
    <>
      <div className={GRID}>
        {list.items.map((a) => (
          <ArtistCard key={a.id} artist={a} className="w-full" />
        ))}
      </div>
      <LoadMore shown={list.items.length} total={list.total} onMore={() => void list.more()} busy={list.loadingMore} />
    </>
  );
}

function History() {
  const { player } = useMusic();
  const res = useAsync((signal) => api.get<{ tracks: Track[] }>('/api/music/history', { signal }), []);
  if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Spinner className="text-white/60" />;
  if (!res.data.tracks.length) return <Empty title="Nothing played yet">Songs you listen to show up here.</Empty>;
  const tracks = res.data.tracks;
  return (
    <div className="max-w-4xl">
      {tracks.map((t, i) => (
        <SongRow key={t.id} track={t} showDuration onPlay={() => player.playTracks(tracks, i, { label: 'History', href: '/music/library?tab=history' }, { shuffle: false })} />
      ))}
    </div>
  );
}
