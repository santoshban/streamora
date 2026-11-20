import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatRuntime } from '../lib/format';
import { useMediaQuery } from '../lib/hooks';
import { EASE_OUT, gutterPx, HOVER_QUERY, reducedMotion } from '../lib/motion';
import { useRouter } from '../lib/router';
import { setTrailersMuted, useAutoplayPreviews, useTrailer, useTrailersMuted } from '../lib/trailers';
import type { Card } from '../lib/types';
import { CheckIcon, ChevronDownIcon, PlayIcon, PlusIcon, XIcon } from './Icons';
import { useListToggle, useOpenTitle, watchUrl } from './titleActions';
import { TrailerButton, TrailerVideo } from './TrailerVideo';
import { Badge, IconButton } from './ui';

/** Netflix waits a beat before expanding, so sweeping the mouse across a row is calm. */
const HOVER_DELAY = 420;
/** The preview is this many times the tile's width. */
const SCALE = 1.5;
/** The trailer starts once the card has finished growing. */
const TRAILER_DELAY = 650;

interface PreviewRequest {
  card: Card;
  /** The tile's artwork box: the preview grows out of it and shrinks back into it. */
  anchor: HTMLElement;
  onRemove?: () => void;
  tag?: string | null;
}
interface OpenPreview extends PreviewRequest {
  key: number;
  rect: DOMRect;
}

interface PreviewApi {
  schedule(request: PreviewRequest): void;
  cancel(): void;
  dismiss(): void;
}

const PreviewContext = createContext<PreviewApi>({ schedule() {}, cancel() {}, dismiss() {} });
export const usePreview = () => useContext(PreviewContext);
/** Whether a preview is open (the billboard pauses its trailer meanwhile). Kept apart
 *  from the API so tiles don't re-render on every open/close. */
const PreviewOpenContext = createContext(false);
export const usePreviewOpen = () => useContext(PreviewOpenContext);

/** Hosts the single hover preview ("mini modal") that tiles open on mouse hover. */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const enabled = useMediaQuery(HOVER_QUERY);
  const [open, setOpen] = useState<OpenPreview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { path, search } = useRouter();

  const cancel = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(null);
  }, []);
  const schedule = useCallback(
    (request: PreviewRequest) => {
      clearTimeout(timer.current);
      if (!enabled) return;
      timer.current = setTimeout(() => {
        const { anchor } = request;
        // Still hovered, still on screen, and no dialog on top.
        if (!anchor.isConnected || !anchor.matches(':hover') || document.body.style.overflow === 'hidden') return;
        setOpen({ ...request, rect: anchor.getBoundingClientRect(), key: performance.now() });
      }, HOVER_DELAY);
    },
    [enabled],
  );

  // A new page or a modal closes the preview at once.
  useEffect(() => dismiss(), [path, search, dismiss]);
  // So does a row scrolling sideways (it would leave the preview behind) or a resize.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (e.target !== document) dismiss();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, dismiss]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo(() => ({ schedule, cancel, dismiss }), [schedule, cancel, dismiss]);
  const key = open?.key;
  const onClosed = useCallback(() => setOpen((current) => (current?.key === key ? null : current)), [key]);

  return (
    <PreviewContext.Provider value={value}>
      <PreviewOpenContext.Provider value={open !== null}>
        {children}
        {open &&
          createPortal(
            <PreviewCard
              key={open.key}
              card={open.card}
              anchor={open.anchor}
              rect={open.rect}
              onRemove={open.onRemove}
              tag={open.tag}
              onClosed={onClosed}
              onDismiss={dismiss}
            />,
            document.body,
          )}
      </PreviewOpenContext.Provider>
    </PreviewContext.Provider>
  );
}

type TrailerPhase = 'waiting' | 'loading' | 'playing' | 'ended' | 'failed';

function PreviewCard({
  card,
  rect,
  onRemove,
  tag,
  onClosed,
  onDismiss,
}: PreviewRequest & { rect: DOMRect; onClosed: () => void; onDismiss: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const { navigate } = useRouter();
  const openTitle = useOpenTitle();
  const [inList, toggleList] = useListToggle(card.inList, card.id);
  const [listTouched, setListTouched] = useState(false);
  const image = card.thumb ?? card.backdrop ?? card.poster;

  // Muted trailer, Netflix style: fetched as the card opens, started once it has grown.
  const autoplay = useAutoplayPreviews();
  const trailer = useTrailer(card.id, autoplay);
  const muted = useTrailersMuted();
  const [phase, setPhase] = useState<TrailerPhase>('waiting');
  useEffect(() => {
    if (!trailer) return;
    const timer = setTimeout(() => setPhase((p) => (p === 'waiting' ? 'loading' : p)), TRAILER_DELAY);
    return () => clearTimeout(timer);
  }, [trailer]);
  const videoShown = phase === 'playing';

  // Final box: 1.5× the tile, centred on it but kept inside the page gutters, so edge
  // tiles grow inwards. transform-origin is the point that makes scale(1/1.5) sit
  // exactly on the tile, so the enter/exit animation is a straight grow/shrink.
  const box = useMemo(() => {
    const width = rect.width * SCALE;
    const height = rect.height * SCALE;
    const viewport = document.documentElement.clientWidth;
    const gutter = gutterPx();
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, gutter), viewport - gutter - width);
    const top = Math.max(8, rect.top - (height - rect.height) / 2);
    const shrink = 1 - 1 / SCALE;
    return {
      width,
      left: left + window.scrollX,
      top: top + window.scrollY,
      origin: `${(rect.left - left) / shrink}px ${(rect.top - top) / shrink}px`,
    };
  }, [rect]);

  useLayoutEffect(() => {
    if (reducedMotion()) return;
    el.current?.animate(
      [
        { transform: `scale(${1 / SCALE})`, boxShadow: '0 0 0 rgb(0 0 0 / 0)' },
        { transform: 'scale(1)', boxShadow: '0 3px 10px rgb(0 0 0 / 0.75)' },
      ],
      { duration: 300, easing: EASE_OUT },
    );
  }, []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const node = el.current;
    if (!node || reducedMotion()) return onClosed();
    const shrink = node.animate(
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: `scale(${1 / SCALE})`, opacity: 0 },
      ],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    );
    shrink.onfinish = onClosed;
  }, [onClosed]);

  // Close once the pointer is anywhere outside the card. (pointerleave alone misses a
  // fast flick out, because the card appears under a pointer that hasn't moved yet.)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !el.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [close]);

  const details = () => {
    const from = el.current?.getBoundingClientRect() ?? null;
    onDismiss();
    openTitle(card.id, from);
  };
  const play = () => {
    onDismiss();
    if (card.target) navigate(watchUrl(card.target));
    else openTitle(card.id);
  };

  const target = card.target;
  const runtime = card.kind === 'show' ? null : formatRuntime(card.runtimeMinutes);
  const progress =
    target?.resume && target.durationSeconds
      ? { fraction: target.positionSeconds / target.durationSeconds, label: `${Math.round(target.positionSeconds / 60)} of ${Math.round(target.durationSeconds / 60)}m` }
      : null;

  return (
    // Like Netflix, the whole card opens the details; its buttons stop the click.
    <div
      ref={el}
      role="group"
      aria-label={`${card.title} preview`}
      data-clickable
      onClick={details}
      className="absolute z-[45] rounded-[var(--tile-radius)] bg-panel shadow-[0_3px_10px_rgb(0_0_0/0.75)]"
      style={{ left: box.left, top: box.top, width: box.width, transformOrigin: box.origin }}
    >
      <div className="relative">
        {/* A div, not a button: it hosts the trailer iframe. */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            details();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              details();
            }
          }}
          aria-label={`More info on ${card.title}`}
          className="relative block aspect-video w-full overflow-hidden rounded-t-[var(--tile-radius)] bg-raised outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {image && <img src={image} alt="" className="size-full object-cover" />}
          {trailer && (phase === 'loading' || phase === 'playing') && (
            <TrailerVideo
              videoKey={trailer.key}
              muted={muted}
              playing
              visible={videoShown}
              onStart={() => setPhase('playing')}
              onEnd={() => setPhase('ended')}
              onFail={() => setPhase('failed')}
              renderScale={3}
            />
          )}
          <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/70 to-transparent" />
          <div
            className={`absolute bottom-0 left-0 px-[0.9em] text-left text-[clamp(11px,0.9vw,15px)] transition-[transform,opacity] duration-700 ease-standard w-3/4 ${tag && !videoShown ? 'pb-[2em]' : 'pb-[0.8em]'}`}
          >
            {card.logo ? (
              <img src={card.logo} alt={card.title} className="max-h-[3em] max-w-[82%] object-contain object-left-bottom drop-shadow-lg" />
            ) : (
              <p className="line-clamp-2 text-[1.15em] font-bold drop-shadow">{card.title}</p>
            )}
          </div>
          {tag && !videoShown && <TileTag>{tag}</TileTag>}
        </div>
        {(phase === 'loading' || phase === 'playing' || phase === 'ended') && (
          <TrailerButton
            size="sm"
            mode={phase === 'ended' ? 'replay' : muted ? 'muted' : 'unmuted'}
            onClick={() => (phase === 'ended' ? setPhase('loading') : setTrailersMuted(!muted))}
            className="absolute right-[0.75em] bottom-[0.75em] text-[clamp(11px,0.85vw,14px)]"
          />
        )}
      </div>

      <div className="space-y-[0.8em] px-[1.15em] pt-[1em] pb-[1.25em] text-[clamp(11px,0.85vw,14px)] animate-[fade-in_0.25s_ease-out_0.08s_backwards]">
        <div className="flex items-center gap-[0.55em]" onClick={(e) => e.stopPropagation()}>
          <IconButton tone="solid" size="sm" label={target?.resume ? 'Resume' : 'Play'} onClick={play}>
            <PlayIcon size={16} />
          </IconButton>
          <IconButton
            size="sm"
            label={inList ? 'Remove from My List' : 'Add to My List'}
            onClick={() => {
              setListTouched(true);
              void toggleList();
            }}
          >
            {inList ? (
              <CheckIcon key="in" size={16} className={listTouched ? 'animate-icon-pop' : ''} />
            ) : (
              <PlusIcon key="out" size={16} className={listTouched ? 'animate-icon-pop' : ''} />
            )}
          </IconButton>
          {onRemove && (
            <IconButton
              size="sm"
              label="Remove from row"
              onClick={() => {
                onRemove();
                close();
              }}
            >
              <XIcon size={16} />
            </IconButton>
          )}
          <IconButton size="sm" label={card.kind === 'show' ? 'Episodes & info' : 'More info'} className="ml-auto" onClick={details}>
            <ChevronDownIcon size={18} />
          </IconButton>
        </div>

        {target?.episodeLabel && (
          <p className="truncate font-semibold text-ink">
            {target.episodeLabel} {target.episodeTitle && <span className="font-normal text-soft">&ldquo;{target.episodeTitle}&rdquo;</span>}
          </p>
        )}
        {progress && (
          <div className="flex items-center gap-[0.75em] text-soft">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[#4d4d4d]">
              <div className="h-full bg-brand" style={{ width: `${Math.max(3, progress.fraction * 100)}%` }} />
            </div>
            <span className="shrink-0 text-[0.92em]">{progress.label}</span>
          </div>
        )}

        {/* "Movie  [M]  1h 59m  [HD]" */}
        <div className="flex flex-wrap items-center gap-x-[0.55em] gap-y-1 text-[1.05em] font-medium text-[#bcbcbc]">
          <span>{card.kind === 'show' ? 'Series' : 'Movie'}</span>
          {card.contentRating && <Badge>{card.contentRating}</Badge>}
          {runtime && <span>{runtime}</span>}
          {card.resolution && <Badge>{card.resolution === '4K' ? 'UHD' : 'HD'}</Badge>}
          {card.hdr && <Badge>{card.hdr}</Badge>}
        </div>

        {card.genres.length > 0 && (
          <ul className="flex flex-wrap items-center text-[1.05em] text-white">
            {card.genres.slice(0, 3).map((g, i) => (
              <li key={g} className="flex items-center">
                {i > 0 && <span className="px-[0.5em] text-[#646464]">&bull;</span>}
                {g}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Netflix's red "Recently added" tab at the bottom of a tile. */
export function TileTag({ children }: { children: ReactNode }) {
  return (
    <span className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t-[4px] bg-brand px-[0.75em] py-[0.32em] text-[clamp(9px,0.7vw,13px)] leading-none font-bold whitespace-nowrap text-white shadow-md">
      {children}
    </span>
  );
}
