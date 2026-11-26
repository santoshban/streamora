import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { useMusic } from '../context';
import { hueOf } from '../format';
import { RadioIcon } from '../icons';
import type { Album, Track } from '../types';
import { AlbumCard, Empty, loadMixTracks, PillButton, QuickPicks, Skeleton } from '../ui';

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[clamp(12px,1.4vw,24px)] gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]';

export default function Genre({ name }: { name: string }) {
  const { player } = useMusic();
  const res = useAsync((signal) => api.get<{ name: string; albums: Album[]; tracks: Track[] }>(`/api/music/genres/${encodeURIComponent(name)}`, { signal }), [name]);
  if (res.error) return <Empty title={`Nothing in “${name}”`}><ErrorNote error={res.error} /></Empty>;
  if (!res.data) return <Skeleton rows={2} />;
  const mixId = `genre:${name}`;
  return (
    <div>
      <header className="-mx-[clamp(16px,3vw,48px)] -mt-16 px-[clamp(16px,3vw,48px)] pt-28 pb-6" style={{ background: `linear-gradient(180deg, hsl(${hueOf(name)} 55% 28%) 0%, #030303 100%)` }}>
        <h1 className="text-[clamp(2.2rem,5vw,4rem)] font-bold">{name}</h1>
        <PillButton
          primary
          className="mt-5"
          icon={<RadioIcon size={20} />}
          onClick={() => void loadMixTracks(mixId).then((t) => player.playTracks(t, 0, { label: `${name} Mix`, href: `/music/mix/${encodeURIComponent(mixId)}` }, { shuffle: false }))}
        >
          Play {name} Mix
        </PillButton>
      </header>
      {res.data.tracks.length > 0 && <QuickPicks tracks={res.data.tracks} title="Songs" strapline="Start radio from a song" />}
      {res.data.albums.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-[clamp(1.35rem,1.8vw,1.8rem)] font-bold">Albums</h2>
          <div className={GRID}>
            {res.data.albums.map((a) => (
              <AlbumCard key={a.id} album={a} className="w-full" />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
