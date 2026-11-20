import { useRef, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { formatRuntime } from '../lib/format';
import { useRouter } from '../lib/router';
import type { Card, PlayTarget } from '../lib/types';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, FilmIcon, PlayIcon, PlusIcon, TvIcon, XIcon } from './Icons';
import { Badge, useToast } from './ui';

export const watchUrl = (target: PlayTarget) => `/watch/${target.fileId}?t=${Math.floor(target.resume ? target.positionSeconds : 0)}`;

/** Opens the detail modal for a title (via `?title=` so Back closes it). */
export function useOpenTitle() {
  const { setQuery } = useRouter();
  return (id: number) => {
    titleOpenedInApp = true;
    setQuery({ title: String(id) });
  };
}
export let titleOpenedInApp = false;
export const resetTitleOpened = () => {
  titleOpenedInApp = false;
};

/** Add/remove from My List with optimistic state and a toast on failure. */
export function useListToggle(initial: boolean, id: number, onChange?: (inList: boolean) => void) {
  const [inList, setInList] = useState(initial);
  const toast = useToast();
  const toggle = async () => {
    const next = !inList;
    setInList(next);
    try {
      await (next ? api.put(`/api/catalog/my-list/${id}`) : api.del(`/api/catalog/my-list/${id}`));
      onChange?.(next);
      toast(next ? 'Added to My List' : 'Removed from My List');
    } catch (err) {
      setInList(!next);
      toast(errorText(err), 'error');
    }
  };
  return [inList, toggle] as const;
}

function Artwork({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={className} />;
}

/** Card used in rows and grids: 16:9 artwork with title, hover actions and progress. */
export function TitleCard({ card, onRemove }: { card: Card; onRemove?: () => void }) {
  const openTitle = useOpenTitle();
  const { navigate } = useRouter();
  const [inList, toggleList] = useListToggle(card.inList, card.id);
  const image = card.thumb ?? card.backdrop ?? card.poster;
  const meta = [card.year, card.kind === 'show' ? 'Series' : formatRuntime(card.runtimeMinutes)].filter(Boolean).join(' · ');

  const play = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (card.target) navigate(watchUrl(card.target));
    else openTitle(card.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openTitle(card.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openTitle(card.id);
      }}
      className="group/card relative w-full cursor-pointer rounded-md bg-neutral-800 shadow-lg outline-none transition duration-200 hover:z-10 hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-white"
    >
      <div className="relative aspect-video overflow-hidden rounded-md">
        <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-neutral-700 to-neutral-900 text-neutral-500">
          {card.kind === 'show' ? <TvIcon size={36} /> : <FilmIcon size={36} />}
        </div>
        <Artwork src={image} alt="" className={`absolute inset-0 size-full object-cover ${image === card.poster ? 'object-top' : ''}`} />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          {card.logo ? (
            <Artwork src={card.logo} alt={card.title} className="max-h-10 max-w-[70%] object-contain object-left drop-shadow-lg" />
          ) : (
            <p className="line-clamp-2 text-sm font-bold drop-shadow">{card.title}</p>
          )}
          {card.target?.episodeLabel && (
            <p className="mt-0.5 truncate text-xs text-neutral-300">
              {card.target.episodeLabel} {card.target.episodeTitle && `· ${card.target.episodeTitle}`}
            </p>
          )}
        </div>
        {card.progress !== undefined && card.progress > 0 && (
          <div className="absolute inset-x-2.5 bottom-1 h-1 overflow-hidden rounded-full bg-neutral-600/80">
            <div className="h-full bg-brand" style={{ width: `${Math.max(3, card.progress * 100)}%` }} />
          </div>
        )}
        {card.resolution === '4K' && (
          <span className="absolute top-2 right-2">
            <Badge tone="solid">4K</Badge>
          </span>
        )}
      </div>

      {/* Hover panel */}
      <div className="pointer-events-none absolute inset-x-0 top-full -mt-1 hidden rounded-b-md bg-neutral-900 p-3 opacity-0 shadow-2xl ring-1 ring-white/5 transition group-hover/card:pointer-events-auto group-hover/card:opacity-100 md:block">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Play" onClick={play} className="grid size-8 place-items-center rounded-full bg-white text-black hover:bg-white/80">
            <PlayIcon size={14} />
          </button>
          <button
            type="button"
            aria-label={inList ? 'Remove from My List' : 'Add to My List'}
            onClick={(e) => {
              e.stopPropagation();
              void toggleList();
            }}
            className="grid size-8 place-items-center rounded-full border-2 border-neutral-500 hover:border-white"
          >
            {inList ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
          </button>
          {onRemove && (
            <button
              type="button"
              aria-label="Remove from Continue Watching"
              title="Remove from Continue Watching"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="grid size-8 place-items-center rounded-full border-2 border-neutral-500 hover:border-white"
            >
              <XIcon size={14} />
            </button>
          )}
          <button
            type="button"
            aria-label="More info"
            onClick={(e) => {
              e.stopPropagation();
              openTitle(card.id);
            }}
            className="ml-auto grid size-8 place-items-center rounded-full border-2 border-neutral-500 hover:border-white"
          >
            <ChevronDownIcon size={16} />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-neutral-300">
          {card.rating ? <span className="font-semibold text-emerald-400">{Math.round(card.rating * 10)}% rating</span> : null}
          {card.contentRating && <Badge>{card.contentRating}</Badge>}
          <span>{meta}</span>
          {card.resolution && <Badge>{card.resolution === '4K' ? 'UHD' : 'HD'}</Badge>}
          {card.hdr && <Badge>{card.hdr}</Badge>}
        </div>
        {card.genres.length > 0 && <p className="mt-1.5 truncate text-xs text-neutral-400">{card.genres.slice(0, 3).join(' • ')}</p>}
      </div>
    </div>
  );
}

/** Horizontally scrolling row with arrow buttons. */
export function CardRow({ title, children, count }: { title: ReactNode; children: ReactNode; count: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };
  return (
    <section className="group/row relative">
      <h2 className="mb-2 px-4 text-lg font-bold text-neutral-100 sm:px-12 sm:text-xl">{title}</h2>
      <div className="relative">
        <div ref={scroller} className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-px-4 px-4 pt-2 pb-28 -mb-24 sm:scroll-px-12 sm:px-12">
          {children}
        </div>
        {count > 3 && (
          <>
            <button
              type="button"
              aria-label="Scroll left"
              onClick={() => scroll(-1)}
              className="absolute top-2 bottom-4 left-0 z-20 hidden w-10 place-items-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 hover:bg-black/70 sm:grid"
            >
              <ChevronLeftIcon size={32} />
            </button>
            <button
              type="button"
              aria-label="Scroll right"
              onClick={() => scroll(1)}
              className="absolute top-2 right-0 bottom-4 z-20 hidden w-10 place-items-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 hover:bg-black/70 sm:grid"
            >
              <ChevronRightIcon size={32} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export const rowItemClass = 'w-[44vw] shrink-0 snap-start sm:w-[30vw] md:w-[23vw] lg:w-[18.5vw] xl:w-[15.5vw]';

export function CardGrid({ cards }: { cards: Card[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-10 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {cards.map((c) => (
        <TitleCard key={c.id} card={c} />
      ))}
    </div>
  );
}
