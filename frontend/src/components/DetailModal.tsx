import { useEffect, useRef, useState } from 'react';
import { api, errorText, qs } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { formatBytes, formatRuntime } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { getModalOrigin } from '../lib/motion';
import { setTrailersMuted, useAutoplayPreviews, useTrailer, useTrailersMuted } from '../lib/trailers';
import { useRouter } from '../lib/router';
import type { Card, EpisodeEntry, ItemDetail, SearchCandidate } from '../lib/types';
import { useSession } from '../state/session';
import { TmdbCredit } from './Brand';
import { CheckIcon, ChevronDownIcon, LockIcon, PlayIcon, PlusIcon, RefreshIcon, SearchIcon } from './Icons';
import { ratingPercent, resetTitleOpened, titleOpenedInApp, useListToggle, useOpenTitle } from './titleActions';
import { TrailerButton, TrailerVideo } from './TrailerVideo';
import { Badge, Button, Dropdown, ErrorNote, IconButton, inputBase, inputClass, Modal, Spinner, useToast } from './ui';

/** Horizontal padding inside the modal (Netflix uses 3em). */
const PAD = 'px-[clamp(1.25rem,5.5%,3rem)]';
/** "More Like This" shows this many until expanded. */
const SIMILAR_COLLAPSED = 6;

/** Renders the detail modal when the URL has `?title=<id>`, and keeps it mounted while
 *  it animates out after the parameter goes away (close button, Escape or Back). */
export function TitleModalHost() {
  const { query, setQuery } = useRouter();
  const id = Number(query.get('title')) || 0;
  const [shown, setShown] = useState(id);
  if (id && id !== shown) setShown(id);
  if (!shown) return null;

  const close = () => {
    if (titleOpenedInApp) {
      resetTitleOpened();
      window.history.back();
    } else {
      setQuery({ title: null }, { replace: true });
    }
  };
  return <DetailModal key={shown} id={shown} onClose={close} exiting={!id} onExited={() => setShown(0)} />;
}

function DetailModal({ id, onClose, exiting, onExited }: { id: number; onClose: () => void; exiting: boolean; onExited: () => void }) {
  const detail = useAsync((signal) => api.get<{ item: ItemDetail }>(`/api/catalog/items/${id}`, { signal }), [id]);
  useServerEvents(['metadata.updated'], (_t, data) => {
    if (data.mediaItemId === id) detail.reload();
  });
  // Read once: the tile/preview this modal zooms out of.
  const [origin] = useState(getModalOrigin);
  const item = detail.data?.item;

  return (
    <Modal
      onClose={onClose}
      label={item?.title ?? 'Title details'}
      className="max-w-[min(58rem,calc(100vw-1.5rem))]"
      origin={origin}
      exiting={exiting}
      onExited={onExited}
    >
      {detail.loading && !item && <DetailSkeleton />}
      {detail.error ? (
        <div className="p-8">
          <ErrorNote error={detail.error} onRetry={detail.reload} />
        </div>
      ) : null}
      {item && <DetailBody item={item} reload={detail.reload} />}
    </Modal>
  );
}

function DetailSkeleton() {
  return (
    <div aria-label="Loading">
      <div className="aspect-video w-full animate-skeleton" />
      <div className={`${PAD} space-y-3 py-8`}>
        <div className="h-4 w-1/3 rounded animate-skeleton" />
        <div className="h-4 w-2/3 rounded animate-skeleton" style={{ animationDelay: '150ms' }} />
        <div className="h-4 w-1/2 rounded animate-skeleton" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-[#777]">{label}: </dt>
      <dd className="inline text-ink">{children}</dd>
    </div>
  );
}

function DetailBody({ item, reload }: { item: ItemDetail; reload: () => void }) {
  const { navigate } = useRouter();
  const { profile } = useSession();
  const toast = useToast();
  const [inList, toggleList] = useListToggle(item.inList, item.id);
  const [listTouched, setListTouched] = useState(false);
  const [versionId, setVersionId] = useState<number | null>(item.target?.fileId ?? item.versions[0]?.id ?? null);
  const [fixing, setFixing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Netflix plays the trailer in the modal header too (muted, after a moment).
  const trailer = useTrailer(item.id, useAutoplayPreviews());
  const muted = useTrailersMuted();
  const [phase, setPhase] = useState<'waiting' | 'loading' | 'playing' | 'ended' | 'failed'>('waiting');
  useEffect(() => {
    if (!trailer) return;
    const timer = setTimeout(() => setPhase((p) => (p === 'waiting' ? 'loading' : p)), 1200);
    return () => clearTimeout(timer);
  }, [trailer]);
  const about = useRef<HTMLElement>(null);
  const target = item.target;

  const play = (fromStart = false) => {
    if (!target) return;
    const fileId = item.kind === 'movie' && versionId ? versionId : target.fileId;
    const t = !fromStart && target.resume && fileId === target.fileId ? Math.floor(target.positionSeconds) : 0;
    navigate(`/watch/${fileId}?t=${t}`);
  };

  const setWatched = async (watched: boolean) => {
    try {
      await api.put(`/api/catalog/items/${item.id}/watched`, { watched });
      reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const directors = item.crew.filter((c) => c.job === 'Director' || c.job === 'Creator');
  const writers = [...new Set(item.crew.filter((c) => ['Writer', 'Screenplay', 'Novel'].includes(c.job)).map((c) => c.name))];
  const seasonCount = item.seasons.filter((s) => s.seasonNumber > 0).length;
  const castNames = item.cast.map((c) => c.name);

  return (
    <>
      {/* Artwork with the title, buttons and progress over its lower edge. */}
      <div className="relative">
        <div className="relative aspect-video w-full overflow-hidden bg-raised">
          {item.backdrop && (
            <img
              src={item.backdrop}
              alt=""
              onLoad={() => setLoaded(true)}
              className={`size-full object-cover transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />
          )}
          {trailer && (phase === 'loading' || phase === 'playing') && (
            <TrailerVideo
              videoKey={trailer.key}
              muted={muted}
              playing
              visible={phase === 'playing'}
              onStart={() => setPhase('playing')}
              onEnd={() => setPhase('ended')}
              onFail={() => setPhase('failed')}
            />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(0deg,#181818_0%,rgb(24_24_24/0.6)_22%,transparent_55%)]" />
        </div>
        <div className={`absolute inset-x-0 bottom-[6%] ${PAD} space-y-[clamp(0.75rem,2vw,1.4rem)]`}>
          <div className="w-[min(46%,24rem)] animate-[fade-up_0.6s_var(--ease-out-expo)_80ms_backwards]">
            {item.logo ? (
              <img src={item.logo} alt={item.title} className="max-h-[clamp(3rem,13vw,8rem)] max-w-full object-contain object-left-bottom drop-shadow-2xl" />
            ) : (
              <h2 className="text-[clamp(1.6rem,4.4vw,3rem)] leading-none font-black drop-shadow-lg">{item.title}</h2>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 animate-[fade-up_0.6s_var(--ease-out-expo)_160ms_backwards]">
            {target && (
              <Button variant="primary" size="lg" onClick={() => play()} className="pr-7 pl-5">
                <PlayIcon size={24} />
                {target.resume ? 'Resume' : 'Play'}
                {target.episodeLabel && <span className="font-normal opacity-80">{target.episodeLabel}</span>}
              </Button>
            )}
            {target?.resume && (
              <Button variant="secondary" size="lg" onClick={() => play(true)}>
                Start over
              </Button>
            )}
            <IconButton
              size="lg"
              label={inList ? 'Remove from My List' : 'Add to My List'}
              onClick={() => {
                setListTouched(true);
                void toggleList();
              }}
            >
              {inList ? (
                <CheckIcon key="in" className={listTouched ? 'animate-icon-pop' : ''} />
              ) : (
                <PlusIcon key="out" className={listTouched ? 'animate-icon-pop' : ''} />
              )}
            </IconButton>
            <IconButton
              size="lg"
              label={item.watched ? 'Mark as unwatched' : 'Mark as watched'}
              onClick={() => void setWatched(!item.watched)}
              className={item.watched ? 'border-match! text-match' : ''}
            >
              <CheckIcon key={String(item.watched)} className="animate-icon-pop" />
            </IconButton>
            {(phase === 'loading' || phase === 'playing' || phase === 'ended') && (
              <TrailerButton
                mode={phase === 'ended' ? 'replay' : muted ? 'muted' : 'unmuted'}
                onClick={() => (phase === 'ended' ? setPhase('loading') : setTrailersMuted(!muted))}
                className="ml-auto"
              />
            )}
          </div>
          {target?.resume && target.durationSeconds ? (
            <div className="flex max-w-sm items-center gap-3 text-sm text-soft animate-[fade-in_0.4s_ease-out_240ms_backwards]">
              <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[#4d4d4d]">
                <div className="h-full bg-brand" style={{ width: `${(target.positionSeconds / target.durationSeconds) * 100}%` }} />
              </div>
              {Math.max(1, Math.round((target.durationSeconds - target.positionSeconds) / 60))}m left
            </div>
          ) : null}
        </div>
      </div>

      {/* Overview and quick credits. */}
      <div className={`grid gap-x-8 gap-y-4 ${PAD} pt-1 pb-8 text-[14px] md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] animate-fade-in`}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-medium text-soft">
            {ratingPercent(item.rating) && <span className="font-semibold text-match">{ratingPercent(item.rating)}</span>}
            {item.year && <span>{item.year}</span>}
            {item.kind === 'movie' ? (
              formatRuntime(item.runtimeMinutes) && <span>{formatRuntime(item.runtimeMinutes)}</span>
            ) : (
              <span>{seasonCount === 1 ? '1 Season' : `${seasonCount} Seasons`}</span>
            )}
            {item.resolution && <Badge>{item.resolution === '4K' ? 'UHD' : item.resolution}</Badge>}
            {item.hdr && <Badge>{item.hdr}</Badge>}
          </div>
          {item.contentRating && (
            <div className="flex items-center gap-2 text-ink">
              <Badge>{item.contentRating}</Badge>
              {item.genres.length > 0 && <span className="text-soft">{item.genres.slice(0, 3).join(', ')}</span>}
            </div>
          )}
          {item.tagline && <p className="font-medium text-ink italic">{item.tagline}</p>}
          <p className="text-[clamp(14px,1.1vw,16px)] leading-relaxed text-white">{item.overview ?? 'No description available yet.'}</p>

          {item.kind === 'movie' && item.versions.length > 1 && (
            <label className="flex items-center gap-3 text-sm">
              <span className="text-[#777]">Version</span>
              <select className={`${inputBase} w-auto`} value={versionId ?? ''} onChange={(e) => setVersionId(Number(e.target.value))}>
                {item.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} — {formatBytes(v.sizeBytes)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <dl className="space-y-2.5 leading-snug">
          {castNames.length > 0 && (
            <Meta label="Cast">
              {castNames.slice(0, 3).join(', ')}
              {castNames.length > 3 && (
                <>
                  ,{' '}
                  <button type="button" onClick={() => about.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="italic hover:underline">
                    more
                  </button>
                </>
              )}
            </Meta>
          )}
          {item.genres.length > 0 && <Meta label="Genres">{item.genres.join(', ')}</Meta>}
          {directors.length > 0 && <Meta label={item.kind === 'show' ? 'Created by' : 'Director'}>{directors.map((d) => d.name).join(', ')}</Meta>}
        </dl>
      </div>

      {item.kind === 'show' && item.seasons.length > 0 && <Episodes item={item} onChanged={reload} />}
      {item.similar.length > 0 && <MoreLikeThis items={item.similar} />}

      {/* About: the full credits, like the bottom of Netflix's modal. */}
      <section ref={about} className={`${PAD} scroll-mt-6 pb-8`}>
        <h3 className="mb-4 text-[clamp(1.25rem,2vw,1.6rem)]">
          About <strong className="font-bold">{item.title}</strong>
        </h3>
        <dl className="space-y-2 text-[14px] leading-snug">
          {directors.length > 0 && <Meta label={item.kind === 'show' ? 'Creators' : 'Director'}>{directors.map((d) => d.name).join(', ')}</Meta>}
          {castNames.length > 0 && <Meta label="Cast">{castNames.slice(0, 15).join(', ')}</Meta>}
          {writers.length > 0 && <Meta label="Writers">{writers.join(', ')}</Meta>}
          {item.genres.length > 0 && <Meta label="Genres">{item.genres.join(', ')}</Meta>}
          {item.studios.length > 0 && <Meta label={item.kind === 'show' ? 'Network' : 'Studio'}>{item.studios.slice(0, 3).join(', ')}</Meta>}
          {item.contentRating && (
            <Meta label="Maturity rating">
              <Badge>{item.contentRating}</Badge>
            </Meta>
          )}
        </dl>
        {item.cast.some((c) => c.photo) && (
          <ul className="no-scrollbar mt-6 flex gap-4 overflow-x-auto pb-2">
            {item.cast.slice(0, 15).map((c, i) => (
              <li key={`${c.name}-${i}`} className="w-20 shrink-0 text-center">
                <div className="mx-auto mb-2 size-16 overflow-hidden rounded-full bg-raised ring-1 ring-white/10">
                  {c.photo && <img src={c.photo} alt="" loading="lazy" className="size-full object-cover" />}
                </div>
                <p className="text-xs leading-tight font-semibold">{c.name}</p>
                {c.character && <p className="mt-0.5 text-[11px] leading-tight text-muted">{c.character}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className={`space-y-3 border-t border-white/10 ${PAD} py-6`}>
        {profile?.isAdmin && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mr-2 text-muted">
              {item.library?.name} · matched by {item.metadataSources.length ? item.metadataSources.join(', ') : 'nobody yet'}
              {item.externalIds.tmdb && ` · TMDB ${item.externalIds.tmdb}`}
            </span>
            {item.locked && (
              <Badge tone="amber">
                <LockIcon size={11} className="mr-1" /> Match locked
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              busy={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await api.post(`/api/items/${item.id}/refresh`, {});
                  toast('Metadata refreshed');
                  reload();
                } catch (err) {
                  toast(errorText(err), 'error');
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshIcon size={14} /> Refresh metadata
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFixing(true)}>
              <SearchIcon size={14} /> Fix match
            </Button>
            {item.locked && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api.patch(`/api/items/${item.id}`, { locked: false }).catch((err: unknown) => toast(errorText(err), 'error'));
                  reload();
                }}
              >
                Unlock
              </Button>
            )}
          </div>
        )}
        {item.metadataSources.includes('tmdb-metadata') && <TmdbCredit />}
      </footer>
      {fixing && <FixMatchDialog item={item} onClose={() => setFixing(false)} onMatched={reload} />}
    </>
  );
}

function Episodes({ item, onChanged }: { item: ItemDetail; onChanged: () => void }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const initial =
    item.target?.episodeLabel ? Number(/^S(\d+)/.exec(item.target.episodeLabel)?.[1] ?? item.seasons[0]!.seasonNumber) : item.seasons[0]!.seasonNumber;
  const [season, setSeason] = useState(initial);
  const episodes = useAsync(
    (signal) => api.get<{ episodes: EpisodeEntry[] }>(`/api/catalog/items/${item.id}/seasons/${season}`, { signal }),
    [item.id, season],
  );
  const current = item.target?.episodeId ?? null;

  const toggleWatched = async (e: EpisodeEntry) => {
    try {
      await api.put(`/api/catalog/items/${item.id}/watched`, { watched: !e.watched, episodeId: e.id });
      episodes.reload();
      onChanged();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const seasonLabel = (s: ItemDetail['seasons'][number]) => s.title ?? (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`);

  return (
    <section className={`${PAD} pb-10`}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-[clamp(1.25rem,2vw,1.6rem)] font-bold">Episodes</h3>
        {item.seasons.length > 1 ? (
          <Dropdown
            label="Season"
            value={season}
            onChange={setSeason}
            align="right"
            buttonClassName="border-[#4d4d4d]! bg-[#242424]! px-4! py-2! text-base! sm:text-lg!"
            options={item.seasons.map((s) => ({ value: s.seasonNumber, label: seasonLabel(s), detail: `${s.episodeCount} Episodes` }))}
          />
        ) : (
          <span className="text-lg font-semibold text-ink">{seasonLabel(item.seasons[0]!)}</span>
        )}
      </div>
      {episodes.loading && !episodes.data && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded animate-skeleton" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
      )}
      {episodes.error ? <ErrorNote error={episodes.error} onRetry={episodes.reload} /> : null}
      <ol>
        {episodes.data?.episodes.map((e, i) => (
          <li
            key={e.id}
            onClick={() => navigate(`/watch/${e.fileId}?t=${Math.floor(e.positionSeconds)}`)}
            className={`group/ep flex cursor-pointer items-center gap-3 rounded-[0.25em] border-b border-[#404040] px-2 py-4 transition-colors duration-200 hover:bg-hover sm:gap-4 sm:px-6 sm:py-6 animate-fade-up ${
              e.id === current ? 'bg-hover' : ''
            }`}
            style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
          >
            <span className="hidden w-[7%] shrink-0 text-center text-2xl text-[#d2d2d2] sm:block">{e.episodeNumber}</span>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                navigate(`/watch/${e.fileId}?t=${Math.floor(e.positionSeconds)}`);
              }}
              className="relative aspect-video w-[34%] shrink-0 overflow-hidden rounded-[0.25em] bg-raised sm:w-[22%]"
              aria-label={`Play ${e.label} ${e.title}`}
            >
              {e.still && <img src={e.still} alt="" loading="lazy" className="size-full object-cover" />}
              <span className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 transition-opacity duration-300 group-hover/ep:opacity-100 group-focus-within/ep:opacity-100">
                <span className="grid size-10 scale-75 place-items-center rounded-full border border-white bg-black/50 transition-transform duration-300 ease-out-expo group-hover/ep:scale-100">
                  <PlayIcon size={18} />
                </span>
              </span>
              {e.progress > 0 && (
                <span className="absolute inset-x-0 bottom-0 h-1 bg-[#4d4d4d]">
                  <span className="block h-full bg-brand" style={{ width: `${e.progress * 100}%` }} />
                </span>
              )}
            </button>
            <div className="min-w-0 flex-1 self-start pt-1 sm:self-center sm:pt-0">
              <div className="flex items-start justify-between gap-3">
                <p className="font-bold text-ink">
                  <span className="text-soft sm:hidden">{e.episodeNumber}. </span>
                  {e.title}
                </p>
                <span className="shrink-0 text-sm text-ink">{formatRuntime(e.runtimeMinutes)}</span>
              </div>
              {e.overview && <p className="mt-1.5 line-clamp-3 text-sm leading-snug text-[#d2d2d2]">{e.overview}</p>}
            </div>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                void toggleWatched(e);
              }}
              data-tip={e.watched ? 'Mark as unwatched' : 'Mark as watched'}
              aria-label={e.watched ? 'Mark as unwatched' : 'Mark as watched'}
              className={`tip grid size-8 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                e.watched ? 'border-match text-match' : 'border-white/30 text-white/40 hover:border-white hover:text-white'
              }`}
            >
              <CheckIcon size={14} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MoreLikeThis({ items }: { items: Card[] }) {
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  const shown = expanded ? items : items.slice(0, SIMILAR_COLLAPSED);
  const canExpand = items.length > SIMILAR_COLLAPSED;
  return (
    <section ref={section} className={`${PAD} pb-10`}>
      <h3 className="mb-4 text-[clamp(1.25rem,2vw,1.6rem)] font-bold">More Like This</h3>
      <div className="relative">
        <div className="grid grid-cols-2 gap-[clamp(0.6rem,1.4vw,1rem)] sm:grid-cols-3">
          {shown.map((c, i) => (
            <SimilarCard key={c.id} card={c} delay={i >= SIMILAR_COLLAPSED ? (i - SIMILAR_COLLAPSED) * 50 : null} />
          ))}
        </div>
        {canExpand && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-panel to-transparent" />}
      </div>
      {canExpand && (
        <div className="relative mt-6 flex h-0.5 justify-center bg-[#404040]">
          <IconButton
            label={expanded ? 'Show less' : 'Show more'}
            onClick={() => {
              setExpanded((v) => !v);
              if (expanded) section.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="-translate-y-1/2"
          >
            <ChevronDownIcon className={`transition-transform duration-300 ease-standard ${expanded ? 'rotate-180' : ''}`} />
          </IconButton>
        </div>
      )}
    </section>
  );
}

function SimilarCard({ card, delay }: { card: Card; delay: number | null }) {
  const openTitle = useOpenTitle();
  const [inList, toggleList] = useListToggle(card.inList, card.id);
  const [touched, setTouched] = useState(false);
  const image = card.backdrop ?? card.thumb ?? card.poster;
  const runtime = card.kind === 'show' ? null : formatRuntime(card.runtimeMinutes);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={card.title}
      onClick={(e) => openTitle(card.id, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openTitle(card.id, e.currentTarget);
      }}
      className={`group/sim flex cursor-pointer flex-col overflow-hidden rounded-[0.25em] bg-raised outline-none transition-colors duration-200 hover:bg-[#3a3a3a] focus-visible:ring-2 focus-visible:ring-white ${delay !== null ? 'animate-fade-up' : ''}`}
      style={delay !== null ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div className="relative aspect-video overflow-hidden bg-[#232323]">
        {image && <img src={image} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 ease-out-expo group-hover/sim:scale-105" />}
        {runtime && <span className="absolute top-2 right-2 text-[clamp(12px,1vw,14px)] font-semibold drop-shadow-[0_1px_3px_rgb(0_0_0/0.9)]">{runtime}</span>}
        <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover/sim:opacity-100">
          <span className="grid size-11 scale-75 place-items-center rounded-full border border-white bg-black/50 transition-transform duration-300 ease-out-expo group-hover/sim:scale-100">
            <PlayIcon size={20} />
          </span>
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-[clamp(0.6rem,1.2vw,1rem)]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-sm font-semibold">{card.title}</p>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-soft">
              {ratingPercent(card.rating) && <span className="font-semibold text-match">{ratingPercent(card.rating)}</span>}
              {card.contentRating && <Badge>{card.contentRating}</Badge>}
              {card.year && <span>{card.year}</span>}
            </div>
          </div>
          <IconButton
            label={inList ? 'Remove from My List' : 'Add to My List'}
            onClick={(e) => {
              e.stopPropagation();
              setTouched(true);
              void toggleList();
            }}
            className="size-9!"
          >
            {inList ? <CheckIcon key="in" size={16} className={touched ? 'animate-icon-pop' : ''} /> : <PlusIcon key="out" size={16} className={touched ? 'animate-icon-pop' : ''} />}
          </IconButton>
        </div>
        {card.overview && <p className="line-clamp-4 text-xs leading-snug text-[#d2d2d2] sm:text-[13px]">{card.overview}</p>}
      </div>
    </div>
  );
}

/** Admin: search the metadata providers and pin the item to the chosen result. */
function FixMatchDialog({ item, onClose, onMatched }: { item: ItemDetail; onClose: () => void; onMatched: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(item.title);
  const [year, setYear] = useState(item.year ? String(item.year) : '');
  const [submitted, setSubmitted] = useState({ q: item.title, year: item.year ? String(item.year) : '' });
  const [choosing, setChoosing] = useState<string | null>(null);
  const results = useAsync(
    (signal) =>
      api.get<{ results: SearchCandidate[]; errors: Array<{ provider: string; error: string }> }>(
        `/api/admin/metadata/search${qs({ kind: item.kind, q: submitted.q, year: submitted.year || undefined })}`,
        { signal },
      ),
    [submitted.q, submitted.year],
  );
  useEffect(() => setChoosing(null), [submitted]);

  const choose = async (c: SearchCandidate, key: string) => {
    setChoosing(key);
    try {
      await api.post(`/api/items/${item.id}/match`, { externalIds: c.externalIds });
      toast(`Matched to ${c.title}${c.year ? ` (${c.year})` : ''}`);
      onMatched();
      onClose();
    } catch (err) {
      toast(errorText(err), 'error');
      setChoosing(null);
    }
  };

  return (
    <Modal onClose={onClose} label="Fix match" className="max-w-2xl">
      <div className="space-y-4 p-6">
        <h2 className="text-xl font-bold">Fix match</h2>
        <p className="text-sm text-neutral-400">Search for the right title. The choice is locked so future scans keep it.</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted({ q: q.trim(), year: year.trim() });
          }}
        >
          <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Title" required />
          <input className={`${inputBase} w-24`} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Year" aria-label="Year" />
          <Button type="submit" variant="brand">
            Search
          </Button>
        </form>
        {results.loading && <Spinner />}
        {results.error ? <ErrorNote error={results.error} /> : null}
        {results.data?.errors.map((e) => (
          <p key={e.provider} className="text-sm text-amber-300">
            {e.provider}: {e.error}
          </p>
        ))}
        {results.data && results.data.results.length === 0 && <p className="text-sm text-neutral-400">No results. Try another title or remove the year.</p>}
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
          {results.data?.results.map((c, i) => {
            const key = `${c.provider}:${i}`;
            return (
              <li key={key}>
                <button
                  type="button"
                  disabled={choosing !== null}
                  onClick={() => void choose(c, key)}
                  className="flex w-full gap-3 rounded-md bg-neutral-800 p-2 text-left transition hover:bg-neutral-700 disabled:opacity-60"
                >
                  <div className="aspect-[2/3] w-14 shrink-0 overflow-hidden rounded bg-neutral-700">
                    {c.poster && /^https?:/.test(c.poster) && <img src={c.poster} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {c.title} {c.year && <span className="font-normal text-neutral-400">({c.year})</span>}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {c.provider} · {Object.entries(c.externalIds).map(([k, v]) => `${k}:${v}`).join(' ')}
                    </p>
                    {c.overview && <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{c.overview}</p>}
                  </div>
                  {choosing === key && <Spinner size={20} />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
