import { useState } from 'react';
import { ConfirmDialog, ErrorNote, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { useRouter } from '../../lib/router';
import { useSession } from '../../state/session';
import { PlaylistDialog, useMusic, usePlayerState } from '../context';
import { longDuration, plural } from '../format';
import { DeleteIcon, EditIcon, LikedIcon, PlaylistAddIcon, ShuffleIcon } from '../icons';
import type { Mix, Playlist as PlaylistDto, Track } from '../types';
import { BigPlayButton, Collage, Empty, MoreMenu, PillButton, removeEntry, Skeleton, TrackTable, useCollectionMenu } from '../ui';
import { CollectionHeader } from './Header';

type Props = { kind: 'playlist'; id: string } | { kind: 'mix'; id: string } | { kind: 'liked'; id?: undefined };

interface Loaded {
  title: string;
  description: string | null;
  meta: string;
  arts: string[];
  entries: Array<{ key: string | number; entryId?: number; track: Track }>;
  playlist?: PlaylistDto;
  mix?: Mix;
}

/** One page for user playlists, "Liked music" and generated mixes. */
export default function Playlist(props: Props) {
  const { player, saveToPlaylist, newPlaylist, reloadPlaylists, likesVersion, isLiked } = useMusic();
  const { profile } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = usePlayerState();
  const collectionMenu = useCollectionMenu();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const res = useAsync(async (signal): Promise<Loaded> => {
    if (props.kind === 'liked') {
      const r = await api.get<{ tracks: Track[] }>('/api/music/likes', { signal });
      return { title: 'Liked music', description: null, meta: 'Auto playlist', arts: [], entries: r.tracks.map((t) => ({ key: t.id, track: t })) };
    }
    if (props.kind === 'mix') {
      const r = await api.get<{ mix: Mix; tracks: Track[] }>(`/api/music/mixes/${encodeURIComponent(props.id)}`, { signal });
      return { title: r.mix.title, description: r.mix.subtitle, meta: 'Mix • Streamora', arts: r.mix.arts, entries: r.tracks.map((t) => ({ key: t.id, track: t })), mix: r.mix };
    }
    const r = await api.get<{ playlist: PlaylistDto; entries: Array<{ entryId: number; track: Track }> }>(`/api/music/playlists/${props.id}`, { signal });
    return {
      title: r.playlist.name,
      description: r.playlist.description,
      meta: `Playlist • ${profile?.name ?? ''} • ${new Date(r.playlist.createdAt).getFullYear()}`,
      arts: r.playlist.arts,
      entries: r.entries.map((e) => ({ key: e.entryId, entryId: e.entryId, track: e.track })),
      playlist: r.playlist,
    };
  }, [props.kind, props.id]);

  if (res.error) return <Empty title="Playlist not found"><ErrorNote error={res.error} /></Empty>;
  if (!res.data) return <Skeleton rows={1} />;
  const data = res.data;
  // Liked music drops songs unliked on this page (likesVersion re-renders it when that happens).
  const entries = props.kind === 'liked' && likesVersion >= 0 ? data.entries.filter((e) => isLiked(e.track)) : data.entries;
  const tracks = entries.map((e) => e.track);
  const href = props.kind === 'liked' ? '/music/liked' : props.kind === 'mix' ? `/music/mix/${encodeURIComponent(props.id)}` : `/music/playlist/${props.id}`;
  const source = { label: data.title, href };
  const playingHere = state.source?.href === href;
  const duration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

  const art =
    props.kind === 'liked' ? (
      <span className="grid aspect-square place-items-center rounded-[4px] bg-[linear-gradient(135deg,#6b3df5,#c22f8f_55%,#ff5e3a)]">
        <LikedIcon size={96} className="h-[40%] w-[40%] text-white drop-shadow-lg" />
      </span>
    ) : (
      <Collage arts={data.arts} seed={data.title} />
    );

  const move = async (from: number, to: number) => {
    if (!data.playlist) return;
    const order = [...entries];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    res.setData({ ...data, entries: order });
    try {
      await api.put(`/api/music/playlists/${data.playlist.id}/order`, { entryIds: order.map((e) => e.entryId!) });
    } catch (err) {
      toast(errorText(err), 'error');
      res.reload();
    }
  };

  const removeAt = async (i: number) => {
    const entry = entries[i]!;
    res.setData({ ...data, entries: data.entries.filter((e) => e.key !== entry.key) });
    try {
      await api.del(`/api/music/playlists/${data.playlist!.id}/entries/${entry.entryId}`);
      reloadPlaylists();
      toast(`Removed from ${data.title}`);
    } catch (err) {
      toast(errorText(err), 'error');
      res.reload();
    }
  };

  const extraMenu = [
    ...(data.playlist
      ? [
          { label: 'Edit playlist', icon: <EditIcon size={22} />, onSelect: () => setEditing(true) },
          { label: 'Delete playlist', icon: <DeleteIcon size={22} />, onSelect: () => setDeleting(true) },
        ]
      : []),
    ...(data.mix ? [{ label: 'Save as a playlist', icon: <PlaylistAddIcon size={22} />, onSelect: () => newPlaylist(tracks) }] : []),
  ];

  return (
    <div>
      <CollectionHeader
        art={art}
        title={data.title}
        meta={data.meta}
        facts={tracks.length ? `${plural(tracks.length, 'song')} • ${longDuration(duration)}` : 'No songs yet'}
        description={data.description}
        actions={
          <>
            <PillButton icon={<ShuffleIcon size={20} />} onClick={() => tracks.length && player.playTracks(tracks, 0, source, { shuffle: true })}>
              Shuffle
            </PillButton>
            <BigPlayButton
              playing={playingHere && state.playing}
              onClick={() => (playingHere ? player.toggle() : tracks.length && player.playTracks(tracks, 0, source, { shuffle: false }))}
            />
            {data.playlist ? (
              <PillButton icon={<EditIcon size={20} />} onClick={() => setEditing(true)}>
                Edit
              </PillButton>
            ) : (
              <PillButton icon={<PlaylistAddIcon size={20} />} onClick={() => tracks.length && saveToPlaylist(tracks)}>
                Save
              </PillButton>
            )}
            {tracks.length > 0 && <MoreMenu entries={[...collectionMenu(async () => tracks, source), ...extraMenu]} />}
          </>
        }
      />
      {entries.length ? (
        <TrackTable
          tracks={entries}
          numbered={false}
          showArtist
          showAlbum
          draggable={!!data.playlist}
          onMove={(from, to) => void move(from, to)}
          onPlay={(i) => player.playTracks(tracks, i, source, { shuffle: false })}
          menuExtra={data.playlist ? (i) => [removeEntry('Remove from playlist', () => void removeAt(i))] : undefined}
        />
      ) : (
        <p className="py-10 text-center text-white/60">
          {props.kind === 'liked' ? 'Songs you like show up here. Press 👍 on any song.' : 'Add songs with “Save to playlist” from any song’s ⋮ menu.'}
        </p>
      )}

      {editing && data.playlist && (
        <PlaylistDialog
          playlist={data.playlist}
          onClose={() => setEditing(false)}
          onSaved={(p) => res.setData({ ...data, title: p.name, description: p.description, playlist: p })}
        />
      )}
      {deleting && data.playlist && (
        <ConfirmDialog
          title="Delete playlist?"
          message={`“${data.title}” will be deleted. The songs stay in your library.`}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.del(`/api/music/playlists/${data.playlist!.id}`);
            reloadPlaylists();
            toast('Playlist deleted');
            navigate('/music/library');
          }}
        />
      )}
    </div>
  );
}
