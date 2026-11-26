import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, useRouter } from '../../lib/router';
import { useMusic, usePlayerState } from '../context';
import { albumKind, longDuration, plural } from '../format';
import { ArtistIcon, PlaylistAddIcon, ShuffleIcon } from '../icons';
import type { AlbumPage } from '../types';
import { AlbumCard, Art, BigPlayButton, Empty, MoreMenu, PillButton, Shelf, Skeleton, TrackTable, useCollectionMenu } from '../ui';
import { CollectionHeader } from './Header';

export default function Album({ id }: { id: number }) {
  const { player, saveToPlaylist } = useMusic();
  const { navigate } = useRouter();
  const state = usePlayerState();
  const collectionMenu = useCollectionMenu();
  const res = useAsync((signal) => api.get<AlbumPage>(`/api/music/albums/${id}`, { signal }), [id]);

  if (res.error) return <Empty title="Album not found"><ErrorNote error={res.error} /></Empty>;
  if (!res.data) return <Skeleton rows={1} />;
  const { album, tracks, moreByArtist } = res.data;
  const source = { label: album.title, href: `/music/album/${album.id}` };
  const playingHere = state.source?.href === source.href;
  const compilation = tracks.some((t) => t.artist.id !== album.artist.id);
  const discs = new Set(tracks.map((t) => t.discNumber ?? 1));

  return (
    <div>
      <CollectionHeader
        art={<Art src={album.art} seed={album.id} icon="album" eager />}
        title={album.title}
        meta={
          <>
            {albumKind(album)} •{' '}
            <Link to={`/music/artist/${album.artist.id}`} className="text-white hover:underline">
              {album.artist.name}
            </Link>
            {album.year ? ` • ${album.year}` : ''}
          </>
        }
        facts={`${plural(tracks.length, 'song')} • ${longDuration(album.duration)}`}
        actions={
          <>
            <PillButton icon={<ShuffleIcon size={20} />} onClick={() => player.playTracks(tracks, 0, source, { shuffle: true })}>
              Shuffle
            </PillButton>
            <BigPlayButton
              playing={playingHere && state.playing}
              onClick={() => (playingHere ? player.toggle() : player.playTracks(tracks, 0, source, { shuffle: false }))}
            />
            <PillButton icon={<PlaylistAddIcon size={20} />} onClick={() => saveToPlaylist(tracks)}>
              Save
            </PillButton>
            <MoreMenu
              entries={[
                ...collectionMenu(async () => tracks, source, { albumId: album.id }),
                { label: 'Go to artist', icon: <ArtistIcon size={22} />, onSelect: () => navigate(`/music/artist/${album.artist.id}`) },
              ]}
            />
          </>
        }
      />
      {[...discs].sort((a, b) => a - b).map((disc) => {
        const onDisc = tracks.map((t, i) => ({ t, i })).filter(({ t }) => (t.discNumber ?? 1) === disc);
        return (
          <div key={disc} className="mb-6">
            {discs.size > 1 && <h2 className="mb-2 px-2 text-sm font-bold tracking-wider text-white/60 uppercase">Disc {disc}</h2>}
            <TrackTable
              tracks={onDisc.map(({ t }) => ({ key: t.id, track: t }))}
              showArtist={compilation}
              onPlay={(i) => player.playTracks(tracks, onDisc[i]!.i, source, { shuffle: false })}
            />
          </div>
        );
      })}
      {moreByArtist.length > 0 && (
        <Shelf title={`More by ${album.artist.name}`} more={`/music/artist/${album.artist.id}`}>
          {moreByArtist.map((a) => (
            <AlbumCard key={a.id} album={a} showArtist={false} />
          ))}
        </Shelf>
      )}
    </div>
  );
}
