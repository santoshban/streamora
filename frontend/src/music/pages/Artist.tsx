import { useState } from 'react';
import { ErrorNote, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { useMusic } from '../context';
import { plural } from '../format';
import { RadioIcon, ShuffleIcon } from '../icons';
import type { ArtistPage } from '../types';
import { AlbumCard, Art, ArtistCard, Empty, loadArtistTracks, PillButton, Shelf, Skeleton, SongRow } from '../ui';

export default function Artist({ id }: { id: number }) {
  const { player } = useMusic();
  const toast = useToast();
  const [allSongs, setAllSongs] = useState(false);
  const res = useAsync((signal) => api.get<ArtistPage>(`/api/music/artists/${id}`, { signal }), [id]);

  if (res.error) return <Empty title="Artist not found"><ErrorNote error={res.error} /></Empty>;
  if (!res.data) return <Skeleton rows={2} />;
  const { artist, topSongs, albums, singles, appearsOn, related } = res.data;
  const source = { label: artist.name, href: `/music/artist/${artist.id}` };
  const shuffle = () =>
    void loadArtistTracks(artist.id)
      .then((tracks) => player.playTracks(tracks, 0, source, { shuffle: true }))
      .catch((e: unknown) => toast(errorText(e), 'error'));

  return (
    <div>
      {/* Banner: the artist's picture, blown up behind a fade to the page colour. */}
      <section className="relative -mx-[clamp(16px,3vw,48px)] -mt-16 flex min-h-[min(56vh,520px)] items-end overflow-hidden">
        <div className="absolute inset-0">
          {artist.art ? (
            <img src={artist.art} alt="" className="size-full scale-110 object-cover object-[50%_30%] opacity-70 blur-[2px]" />
          ) : (
            <Art src={null} seed={artist.name} icon="artist" className="!aspect-auto size-full" />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(3_3_3/0.4)_0%,rgb(3_3_3/0.1)_35%,rgb(3_3_3/0.85)_80%,#030303_100%)]" />
        </div>
        <div className="relative flex w-full items-end gap-6 px-[clamp(16px,3vw,48px)] pb-6">
          <Art src={artist.art} seed={artist.name} round icon="artist" className="hidden size-40 shadow-2xl ring-4 ring-black/30 md:block" eager />
          <div className="min-w-0">
            <h1 className="text-[clamp(2.4rem,6vw,4.5rem)] leading-none font-bold break-words drop-shadow-lg">{artist.name}</h1>
            <p className="mt-3 text-white/70">
              {plural(artist.trackCount, 'song')}
              {artist.albumCount ? ` • ${plural(artist.albumCount, 'release')}` : ''}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <PillButton primary icon={<ShuffleIcon size={20} />} onClick={shuffle}>
                Shuffle
              </PillButton>
              <PillButton
                icon={<RadioIcon size={20} />}
                onClick={() => void player.startRadio({ artistId: artist.id }, artist.name).catch((e: unknown) => toast(errorText(e), 'error'))}
              >
                Radio
              </PillButton>
            </div>
          </div>
        </div>
      </section>

      {topSongs.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-[clamp(1.35rem,1.8vw,1.8rem)] font-bold">Top songs</h2>
          {(allSongs ? topSongs : topSongs.slice(0, 5)).map((t, i) => (
            <SongRow key={t.id} track={t} onPlay={() => player.playTracks(topSongs, i, source, { shuffle: false })} />
          ))}
          {topSongs.length > 5 && (
            <button type="button" onClick={() => setAllSongs((v) => !v)} className="mt-3 h-9 rounded-full border border-white/20 px-4 text-sm font-medium hover:bg-white/10">
              {allSongs ? 'Show less' : 'Show all'}
            </button>
          )}
        </section>
      )}
      {albums.length > 0 && (
        <Shelf title="Albums">
          {albums.map((a) => (
            <AlbumCard key={a.id} album={a} showArtist={false} />
          ))}
        </Shelf>
      )}
      {singles.length > 0 && (
        <Shelf title="Singles & EPs">
          {singles.map((a) => (
            <AlbumCard key={a.id} album={a} showArtist={false} />
          ))}
        </Shelf>
      )}
      {appearsOn.length > 0 && (
        <Shelf title="Appears on">
          {appearsOn.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </Shelf>
      )}
      {related.length > 0 && (
        <Shelf title="Fans might also like">
          {related.map((a) => (
            <ArtistCard key={a.id} artist={a} />
          ))}
        </Shelf>
      )}
    </div>
  );
}
