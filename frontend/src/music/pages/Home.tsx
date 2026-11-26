import { useState } from 'react';
import { Avatar } from '../../components/Brand';
import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { useServerEvents } from '../../lib/events';
import { useAsync } from '../../lib/hooks';
import { Link } from '../../lib/router';
import { useSession } from '../../state/session';
import type { Album, HomeData, Track } from '../types';
import { AlbumCard, ArtistCard, Chips, Empty, MixCard, PlaylistCard, QuickPicks, Shelf, Skeleton } from '../ui';

export default function Home() {
  const { profile } = useSession();
  const [genre, setGenre] = useState<string | null>(null);
  const home = useAsync((signal) => api.get<HomeData>('/api/music/home', { signal }), []);
  useServerEvents(['scan.completed'], () => home.reload());

  if (home.error) return <div className="mt-24"><ErrorNote error={home.error} onRetry={home.reload} /></div>;
  if (!home.data) return <Skeleton rows={3} />;
  const data = home.data;

  if (data.empty) {
    return (
      <Empty title="Your music library is empty">
        {profile?.isAdmin ? (
          <>
            <p>Add a library of type <b className="text-white">Music</b> pointing at your music folder. Streamora reads the songs’ tags, or works them out from <code>Artist/Album/01 - Title.mp3</code> folders.</p>
            <Link to="/admin/libraries" className="mt-6 inline-flex h-10 items-center rounded-full bg-white px-5 font-medium text-black hover:bg-white/85">
              Add a music library
            </Link>
          </>
        ) : (
          <p>Ask the owner of this server to add a music library.</p>
        )}
      </Empty>
    );
  }

  return (
    <div className="pt-4">
      {data.genres.length > 0 && <Chips options={data.genres.map((g) => ({ value: g, label: g }))} value={genre} onChange={setGenre} className="mb-2" />}
      {genre ? (
        <GenreShelves key={genre} genre={genre} />
      ) : (
        <>
          {data.quickPicks.length > 0 && <QuickPicks tracks={data.quickPicks} strapline="Start radio from a song" />}
          {data.listenAgain.length > 0 && profile && (
            <Shelf
              title="Listen again"
              strapline={profile.name}
              thumb={<Avatar profile={profile} size={48} className="!rounded-full" />}
            >
              {data.listenAgain.map((item) =>
                item.type === 'album' ? (
                  <AlbumCard key={`a${item.album.id}`} album={item.album} />
                ) : item.type === 'artist' ? (
                  <ArtistCard key={`r${item.artist.id}`} artist={item.artist} />
                ) : (
                  <PlaylistCard key={`p${item.playlist.id}`} playlist={item.playlist} />
                ),
              )}
            </Shelf>
          )}
          {data.mixes.length > 0 && (
            <Shelf title="Mixed for you">
              {data.mixes.map((m) => (
                <MixCard key={m.id} mix={m} />
              ))}
            </Shelf>
          )}
          {data.recentlyAdded.length > 0 && (
            <Shelf title="Recently added" more="/music/library?tab=albums">
              {data.recentlyAdded.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </Shelf>
          )}
          {data.favoriteArtists.length > 0 && (
            <Shelf title={data.listenAgain.length ? 'Your favorites' : 'Artists in your library'} more="/music/library?tab=artists">
              {data.favoriteArtists.map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
            </Shelf>
          )}
          {data.albumsForYou.length > 0 && (
            <Shelf title="Albums for you">
              {data.albumsForYou.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </Shelf>
          )}
        </>
      )}
    </div>
  );
}

/** A mood chip selected: songs and albums of that genre. */
function GenreShelves({ genre }: { genre: string }) {
  const res = useAsync(
    (signal) => api.get<{ name: string; albums: Album[]; tracks: Track[] }>(`/api/music/genres/${encodeURIComponent(genre)}`, { signal }),
    [genre],
  );
  if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Skeleton rows={2} />;
  return (
    <>
      {res.data.tracks.length > 0 && <QuickPicks tracks={res.data.tracks} title={`${genre} songs`} strapline="Start radio from a song" />}
      {res.data.albums.length > 0 && (
        <Shelf title={`${genre} albums`} more={`/music/genre/${encodeURIComponent(genre)}`}>
          {res.data.albums.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </Shelf>
      )}
    </>
  );
}
