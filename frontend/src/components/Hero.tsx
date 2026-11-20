import { useState } from 'react';
import { formatRuntime } from '../lib/format';
import { useRouter } from '../lib/router';
import type { HomeData } from '../lib/types';
import { useOpenTitle, watchUrl } from './Cards';
import { InfoIcon, PlayIcon } from './Icons';
import { Badge, Button } from './ui';

export function Hero({ hero }: { hero: NonNullable<HomeData['hero']> }) {
  const { navigate } = useRouter();
  const openTitle = useOpenTitle();
  const [logoFailed, setLogoFailed] = useState(false);
  const target = hero.target;

  return (
    // The text sits in normal flow at the bottom of a flex column (not absolutely
    // positioned), padded by the same --hero-overlap the rows below slide up by, plus
    // --hero-gap. If the text is taller than the banner, the banner grows (pt-24 keeps
    // it clear of the nav bar) instead of the rows or the nav covering it.
    <section className="relative flex min-h-[max(26rem,min(68vw,86vh))] w-full flex-col justify-end overflow-hidden pt-24">
      {hero.backdrop && <img src={hero.backdrop} alt="" className="absolute inset-0 size-full object-cover object-top" />}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/35 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-surface to-transparent" />

      <div className="relative mx-4 max-w-xl space-y-4 pb-[calc(var(--hero-overlap)+var(--hero-gap))] short:space-y-3 sm:mx-12 lg:max-w-2xl">
        {hero.logo && !logoFailed ? (
          <img
            src={hero.logo}
            alt={hero.title}
            onError={() => setLogoFailed(true)}
            className="max-h-[min(8rem,18vh)] max-w-[80%] object-contain object-left drop-shadow-2xl sm:max-h-[min(10rem,18vh)]"
          />
        ) : (
          <h1 className="text-4xl font-black drop-shadow-2xl sm:text-6xl short:sm:text-5xl">{hero.title}</h1>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-200">
          {hero.year && <span>{hero.year}</span>}
          {hero.contentRating && <Badge>{hero.contentRating}</Badge>}
          {hero.kind === 'movie' && formatRuntime(hero.runtimeMinutes) && <span>{formatRuntime(hero.runtimeMinutes)}</span>}
          {hero.resolution && <Badge>{hero.resolution === '4K' ? 'UHD' : 'HD'}</Badge>}
          {hero.genres.length > 0 && <span className="text-neutral-300">{hero.genres.slice(0, 3).join(' • ')}</span>}
        </div>
        {hero.overview && (
          <p className="line-clamp-3 text-sm text-neutral-100 drop-shadow short:line-clamp-2 sm:text-lg short:sm:text-base">{hero.overview}</p>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          {target && (
            <Button variant="primary" size="lg" onClick={() => navigate(watchUrl(target))}>
              <PlayIcon size={22} />
              {target.resume ? 'Resume' : 'Play'}
              {target.episodeLabel && <span className="font-normal">{target.episodeLabel}</span>}
            </Button>
          )}
          <Button variant="secondary" size="lg" onClick={() => openTitle(hero.id)}>
            <InfoIcon size={22} /> More Info
          </Button>
        </div>
      </div>
    </section>
  );
}
