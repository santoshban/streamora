import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '../lib/router';
import type { Card } from '../lib/types';
import { ChevronLeftIcon, ChevronRightIcon, FilmIcon, TvIcon } from './Icons';
import { TileTag, usePreview } from './Preview';
import { useOpenTitle } from './titleActions';

function Artwork({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={`transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'} ${className ?? ''}`}
    />
  );
}

/** A 16:9 tile ("boxart"). Hovering with a mouse opens the preview card; clicking opens
 *  the detail modal, zooming out of the tile. */
export function TitleCard({ card, onRemove, tag }: { card: Card; onRemove?: () => void; tag?: string | null }) {
  const openTitle = useOpenTitle();
  const preview = usePreview();
  const art = useRef<HTMLDivElement>(null);
  const image = card.thumb ?? card.backdrop ?? card.poster;

  const open = () => {
    preview.dismiss();
    openTitle(card.id, art.current);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={card.title}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse' && art.current) preview.schedule({ card, anchor: art.current, onRemove, tag });
      }}
      onPointerLeave={preview.cancel}
      className="group/tile block w-full cursor-pointer outline-none"
    >
      <div
        ref={art}
        className="relative aspect-video overflow-hidden rounded-[var(--tile-radius)] bg-raised ring-white ring-offset-2 ring-offset-surface transition-[filter] duration-300 group-focus-visible/tile:ring-2 can-hover:group-hover/tile:brightness-110"
      >
        <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#2f2f2f] to-[#1c1c1c] text-neutral-600">
          {card.kind === 'show' ? <TvIcon size={32} /> : <FilmIcon size={32} />}
        </div>
        <Artwork src={image} alt="" className={`absolute inset-0 size-full object-cover ${image === card.poster ? 'object-top' : ''}`} />
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
        <div className={`absolute inset-x-0 bottom-0 px-[0.65em] text-[clamp(11px,0.9vw,15px)] ${tag ? 'pb-[1.8em]' : 'pb-[0.6em]'}`}>
          {card.logo ? (
            <Artwork src={card.logo} alt={card.title} className="max-h-[2.6em] max-w-[68%] object-contain object-left-bottom drop-shadow-lg" />
          ) : (
            <p className="line-clamp-2 leading-tight font-bold drop-shadow">{card.title}</p>
          )}
        </div>
        {tag && <TileTag>{tag}</TileTag>}
      </div>
      {card.progress !== undefined && card.progress > 0 && (
        <div className="mt-[0.45em] h-[3px] overflow-hidden rounded-full bg-[#4d4d4d]">
          <div className="h-full bg-brand" style={{ width: `${Math.max(3, card.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** One horizontally paged row, Netflix style: N tiles per page with the next one peeking
 *  into the gutter, arrow handles in the gutters, and page bars at the top right. */
export function CardRow({ title, href, children, count }: { title: ReactNode; href?: string; children: ReactNode; count: number }) {
  const track = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ page: 0, pages: 1, atStart: true, atEnd: true });

  const pageWidth = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + (parseFloat(style.columnGap) || 0);
  };

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const perPage = Number(getComputedStyle(el).getPropertyValue('--row-items')) || 1;
    const pages = Math.max(1, Math.ceil(count / perPage));
    const max = el.scrollWidth - el.clientWidth;
    const atStart = el.scrollLeft <= 2;
    const atEnd = el.scrollLeft >= max - 2;
    const page = atEnd ? pages - 1 : Math.min(pages - 1, Math.round(el.scrollLeft / pageWidth(el)));
    setState((s) => (s.page === page && s.pages === pages && s.atStart === atStart && s.atEnd === atEnd ? s : { page, pages, atStart, atEnd }));
  }, [count]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measure]);

  const go = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * pageWidth(el), behavior: 'smooth' });
  };

  const arrow = 'absolute inset-y-[6px] z-10 hidden w-(--gutter) items-center justify-center bg-[rgb(20_20_20/0.5)] text-white transition-[opacity,background-color] duration-300 hover:bg-[rgb(20_20_20/0.75)] can-hover:flex group/arrow';

  return (
    <section className="group/row relative" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="gutter-x mb-[0.55em] flex items-end justify-between gap-4">
        <h2 className="row-title font-bold text-ink">
          {href ? (
            <Link to={href} className="group/hdr inline-flex items-baseline">
              {title}
              <span className="ml-[0.6em] inline-flex items-center self-center text-[0.62em] font-semibold whitespace-nowrap text-explore">
                <span className="max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-700 ease-standard group-hover/hdr:max-w-[7em] group-hover/hdr:opacity-100 group-focus-visible/hdr:max-w-[7em] group-focus-visible/hdr:opacity-100">
                  Explore All&nbsp;
                </span>
                <ChevronRightIcon size={16} className="opacity-0 transition-[opacity,transform] duration-300 group-hover/row:opacity-100 group-hover/hdr:translate-x-0.5 group-focus-visible/hdr:opacity-100" />
              </span>
            </Link>
          ) : (
            title
          )}
        </h2>
        {state.pages > 1 && (
          <ol aria-hidden="true" className="mb-[0.35em] hidden gap-[2px] opacity-0 transition-opacity duration-300 group-hover/row:opacity-100 can-hover:flex">
            {Array.from({ length: state.pages }, (_, i) => (
              <li key={i} className={`h-[2px] w-[12px] transition-colors duration-300 ${i === state.page ? 'bg-[#aaa]' : 'bg-[#4d4d4d]'}`} />
            ))}
          </ol>
        )}
      </div>
      <div className="relative">
        <div ref={track} className="tile-track no-scrollbar snap-x snap-mandatory overflow-x-auto overscroll-x-contain py-[6px] [&>*]:snap-start">
          {children}
        </div>
        {state.pages > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous titles"
              onClick={() => go(-1)}
              className={`${arrow} left-0 rounded-r-[var(--tile-radius)] ${state.atStart ? 'pointer-events-none opacity-0' : ''}`}
            >
              <ChevronLeftIcon size={36} className="opacity-0 transition-[opacity,transform] duration-200 group-hover/row:opacity-100 group-hover/arrow:scale-125" />
            </button>
            <button
              type="button"
              aria-label="More titles"
              onClick={() => go(1)}
              className={`${arrow} right-0 rounded-l-[var(--tile-radius)] ${state.atEnd ? 'pointer-events-none opacity-0' : ''}`}
            >
              <ChevronRightIcon size={36} className="opacity-0 transition-[opacity,transform] duration-200 group-hover/row:opacity-100 group-hover/arrow:scale-125" />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Gallery grid (Movies, TV Shows, My List, Search): same tile sizes as the rows.
 *  Tiles fade up in a short stagger as each page of results arrives. */
export function CardGrid({ cards, pageSize = 60 }: { cards: Card[]; pageSize?: number }) {
  return (
    <div className="tile-grid">
      {cards.map((c, i) => (
        <div key={c.id} className="animate-fade-up" style={{ animationDelay: `${Math.min(i % pageSize, 24) * 28}ms` }}>
          <TitleCard card={c} />
        </div>
      ))}
    </div>
  );
}

// ── loading skeletons ────────────────────────────────────────────────────────

function SkeletonTile({ index }: { index: number }) {
  return <div className="aspect-video rounded-[var(--tile-radius)] animate-skeleton" style={{ animationDelay: `${index * 140}ms` }} />;
}

export function RowSkeleton({ titleWidth = '11rem' }: { titleWidth?: string }) {
  return (
    <div aria-hidden="true">
      <div className="gutter-x mb-[0.55em]">
        <div className="row-title h-[1.1em] rounded animate-skeleton" style={{ width: titleWidth }} />
      </div>
      <div className="tile-track overflow-hidden py-[6px]">
        {Array.from({ length: 7 }, (_, i) => (
          <SkeletonTile key={i} index={i} />
        ))}
      </div>
    </div>
  );
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="tile-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonTile key={i} index={i % 6} />
      ))}
    </div>
  );
}
