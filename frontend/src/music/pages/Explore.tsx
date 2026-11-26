import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link } from '../../lib/router';
import { useMusic } from '../context';
import { hueOf } from '../format';
import { AlbumIcon, LibraryIcon, RadioIcon } from '../icons';
import type { ExploreData } from '../types';
import { AlbumCard, ArtistCard, Shelf, Skeleton, SongRow } from '../ui';

export default function Explore() {
  const { player } = useMusic();
  const res = useAsync((signal) => api.get<ExploreData>('/api/music/explore', { signal }), []);
  if (res.error) return <div className="mt-24"><ErrorNote error={res.error} onRetry={res.reload} /></div>;
  if (!res.data) return <Skeleton rows={3} />;
  const data = res.data;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="pt-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { id: 'new', label: 'New in your library', icon: <AlbumIcon /> },
          { id: 'charts', label: 'Top songs', icon: <LibraryIcon /> },
          { id: 'moods', label: 'Moods & genres', icon: <RadioIcon /> },
        ].map((b) => (
          <button key={b.id} type="button" onClick={() => jump(b.id)} className="flex h-14 items-center gap-4 rounded-lg bg-white/[0.1] px-5 text-left text-base font-medium transition-colors hover:bg-white/[0.2]">
            <span className="text-white/80">{b.icon}</span>
            {b.label}
          </button>
        ))}
      </div>

      {data.newAlbums.length > 0 && (
        <div id="new" className="scroll-mt-20">
          <Shelf title="New albums & singles" more="/music/library?tab=albums">
            {data.newAlbums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </Shelf>
        </div>
      )}

      {data.genres.length > 0 && (
        <div id="moods" className="scroll-mt-20">
          <Shelf title="Moods & genres">
            <div className="grid snap-start auto-cols-[minmax(180px,200px)] grid-flow-col grid-rows-4 gap-x-4 gap-y-3">
              {data.genres.map((g) => (
                <Link
                  key={g.name}
                  to={`/music/genre/${encodeURIComponent(g.name)}`}
                  className="flex h-12 snap-start items-center truncate rounded-lg border-l-[6px] bg-[#292929] px-4 text-[15px] font-medium transition-colors hover:bg-[#3a3a3a]"
                  style={{ borderLeftColor: `hsl(${hueOf(g.name)} 70% 55%)` }}
                >
                  {g.name}
                </Link>
              ))}
            </div>
          </Shelf>
        </div>
      )}

      {data.topSongs.length > 0 && (
        <div id="charts" className="scroll-mt-20">
          <Shelf title="Top songs" strapline="Most played on this server">
            <div className="grid snap-start auto-cols-[min(440px,85vw)] grid-flow-col grid-rows-4 gap-x-6">
              {data.topSongs.map((t, i) => (
                <SongRow key={t.id} index={i + 1} track={t} onPlay={() => player.playTracks(data.topSongs, i, { label: 'Top songs', href: '/music/explore' }, { shuffle: false })} />
              ))}
            </div>
          </Shelf>
        </div>
      )}

      {data.artists.length > 0 && (
        <Shelf title="Artists to explore" more="/music/library?tab=artists">
          {data.artists.map((a) => (
            <ArtistCard key={a.id} artist={a} />
          ))}
        </Shelf>
      )}
    </div>
  );
}
