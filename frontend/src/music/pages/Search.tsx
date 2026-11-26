import { ErrorNote, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, useRouter } from '../../lib/router';
import { useSession } from '../../state/session';
import { useMusic } from '../context';
import { albumKind } from '../format';
import { PlayIcon, RadioIcon, ShuffleIcon } from '../icons';
import type { SearchResults } from '../types';
import { AlbumCard, Art, ArtistCard, Chips, Empty, loadAlbumTracks, loadArtistTracks, PillButton, PlaylistCard, Shelf, SongRow } from '../ui';

type Filter = 'songs' | 'albums' | 'artists' | 'playlists';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'songs', label: 'Songs' },
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
  { value: 'playlists', label: 'Playlists' },
];
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[clamp(12px,1.4vw,24px)] gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]';

export default function Search() {
  const { query, setQuery } = useRouter();
  const { player } = useMusic();
  const { profile } = useSession();
  const toast = useToast();
  const q = query.get('q')?.trim() ?? '';
  const filter = (FILTERS.find((f) => f.value === query.get('type'))?.value ?? null) as Filter | null;
  const res = useAsync((signal) => (q ? api.get<SearchResults>(`/api/music/search?q=${encodeURIComponent(q)}`, { signal }) : Promise.resolve(null)), [q]);

  if (!q) return <Empty title="Search your music">Find songs, albums, artists and playlists.</Empty>;
  if (res.error) return <div className="mt-16"><ErrorNote error={res.error} onRetry={res.reload} /></div>;
  if (!res.data) return <div className="grid h-60 place-items-center"><Spinner className="text-white/60" /></div>;
  const r = res.data;
  const nothing = !r.songs.length && !r.albums.length && !r.artists.length && !r.playlists.length;
  const fail = (e: unknown) => toast(errorText(e), 'error');

  const topCard = (() => {
    const top = r.top;
    if (!top) return null;
    if (top.type === 'artist') {
      const a = top.artist;
      return (
        <TopResult
          to={`/music/artist/${a.id}`}
          art={<Art src={a.art} seed={a.name} round icon="artist" className="size-24 sm:size-28" />}
          title={a.name}
          subtitle={`Artist • ${a.trackCount} songs`}
          actions={
            <>
              <PillButton primary icon={<ShuffleIcon size={20} />} onClick={() => void loadArtistTracks(a.id).then((t) => player.playTracks(t, 0, { label: a.name, href: `/music/artist/${a.id}` }, { shuffle: true })).catch(fail)}>
                Shuffle
              </PillButton>
              <PillButton icon={<RadioIcon size={20} />} onClick={() => void player.startRadio({ artistId: a.id }, a.name).catch(fail)}>
                Radio
              </PillButton>
            </>
          }
        />
      );
    }
    if (top.type === 'album') {
      const a = top.album;
      return (
        <TopResult
          to={`/music/album/${a.id}`}
          art={<Art src={a.art} seed={a.id} icon="album" className="size-24 sm:size-28" />}
          title={a.title}
          subtitle={[albumKind(a), a.artist.name, a.year].filter(Boolean).join(' • ')}
          actions={
            <>
              <PillButton primary icon={<PlayIcon size={20} />} onClick={() => void loadAlbumTracks(a.id).then((t) => player.playTracks(t, 0, { label: a.title, href: `/music/album/${a.id}` }, { shuffle: false })).catch(fail)}>
                Play
              </PillButton>
              <PillButton icon={<ShuffleIcon size={20} />} onClick={() => void loadAlbumTracks(a.id).then((t) => player.playTracks(t, 0, { label: a.title, href: `/music/album/${a.id}` }, { shuffle: true })).catch(fail)}>
                Shuffle
              </PillButton>
            </>
          }
        />
      );
    }
    const t = top.track;
    return (
      <TopResult
        to={`/music/album/${t.album.id}`}
        art={<Art src={t.art} seed={t.album.id} className="size-24 sm:size-28" />}
        title={t.title}
        subtitle={`Song • ${t.artistName} • ${t.album.title}`}
        actions={
          <>
            <PillButton primary icon={<PlayIcon size={20} />} onClick={() => void player.startRadio({ track: t }, t.title).catch(fail)}>
              Play
            </PillButton>
            <PillButton icon={<RadioIcon size={20} />} onClick={() => void player.startRadio({ track: t }, t.title).catch(fail)}>
              Radio
            </PillButton>
          </>
        }
      />
    );
  })();

  const playSong = (i: number) => void player.startRadio({ track: r.songs[i]! }, r.songs[i]!.title).catch(fail);

  return (
    <div className="pt-6">
      <Chips options={FILTERS} value={filter} onChange={(v) => setQuery({ type: v }, { replace: true })} className="mb-6" />
      {nothing && <Empty title={`No results for “${q}”`}>Check the spelling, or try different words.</Empty>}

      {!filter && !nothing && (
        <>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {topCard && <div>{topCard}</div>}
            {r.songs.length > 0 && (
              <div className="min-w-0">
                <h2 className="mb-2 text-xl font-bold lg:sr-only">Songs</h2>
                {r.songs.slice(0, 4).map((t, i) => (
                  <SongRow key={t.id} track={t} onPlay={() => playSong(i)} subtitle={`Song • ${t.artistName} • ${t.album.title}`} />
                ))}
              </div>
            )}
          </div>
          {r.songs.length > 4 && (
            <section className="mt-10">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[clamp(1.35rem,1.8vw,1.8rem)] font-bold">Songs</h2>
                <button type="button" onClick={() => setQuery({ type: 'songs' })} className="h-8 rounded-full border border-white/20 px-3.5 text-sm font-medium hover:bg-white/10">
                  Show all
                </button>
              </div>
              {r.songs.slice(4, 10).map((t, i) => (
                <SongRow key={t.id} track={t} onPlay={() => playSong(i + 4)} subtitle={`Song • ${t.artistName} • ${t.album.title}`} />
              ))}
            </section>
          )}
          {r.albums.length > 0 && (
            <Shelf title="Albums">
              {r.albums.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </Shelf>
          )}
          {r.artists.length > 0 && (
            <Shelf title="Artists">
              {r.artists.map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
            </Shelf>
          )}
          {r.playlists.length > 0 && (
            <Shelf title="Playlists">
              {r.playlists.map((p) => (
                <PlaylistCard key={p.id} playlist={p} owner={profile?.name} />
              ))}
            </Shelf>
          )}
        </>
      )}

      {filter === 'songs' &&
        (r.songs.length ? (
          r.songs.map((t, i) => <SongRow key={t.id} track={t} showDuration onPlay={() => playSong(i)} subtitle={`${t.artistName} • ${t.album.title}`} />)
        ) : (
          <Empty title="No songs found" />
        ))}
      {filter === 'albums' && (r.albums.length ? <div className={GRID}>{r.albums.map((a) => <AlbumCard key={a.id} album={a} className="w-full" />)}</div> : <Empty title="No albums found" />)}
      {filter === 'artists' && (r.artists.length ? <div className={GRID}>{r.artists.map((a) => <ArtistCard key={a.id} artist={a} className="w-full" />)}</div> : <Empty title="No artists found" />)}
      {filter === 'playlists' &&
        (r.playlists.length ? <div className={GRID}>{r.playlists.map((p) => <PlaylistCard key={p.id} playlist={p} owner={profile?.name} className="w-full" />)}</div> : <Empty title="No playlists found" />)}
    </div>
  );
}

function TopResult({ to, art, title, subtitle, actions }: { to: string; art: React.ReactNode; title: string; subtitle: string; actions: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.07] p-5 ring-1 ring-white/5">
      <div className="flex items-center gap-5">
        <Link to={to} className="shrink-0">
          {art}
        </Link>
        <div className="min-w-0">
          <Link to={to} className="line-clamp-2 text-2xl font-bold hover:underline">
            {title}
          </Link>
          <p className="mt-1 truncate text-white/60">{subtitle}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">{actions}</div>
    </div>
  );
}
