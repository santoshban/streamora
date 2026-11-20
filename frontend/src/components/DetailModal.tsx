import { useEffect, useState } from 'react';
import { api, errorText, qs } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { formatBytes, formatRuntime } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import type { EpisodeEntry, ItemDetail, SearchCandidate } from '../lib/types';
import { useSession } from '../state/session';
import { TmdbCredit } from './Brand';
import { resetTitleOpened, titleOpenedInApp, useListToggle, useOpenTitle, watchUrl } from './Cards';
import { CheckIcon, LockIcon, PlayIcon, PlusIcon, RefreshIcon, SearchIcon } from './Icons';
import { Badge, Button, ErrorNote, IconButton, inputBase, inputClass, Modal, Spinner, useToast } from './ui';

/** Renders the detail modal when the URL has `?title=<id>`. */
export function TitleModalHost() {
  const { query, setQuery } = useRouter();
  const id = Number(query.get('title'));
  if (!id) return null;
  const close = () => {
    if (titleOpenedInApp) {
      resetTitleOpened();
      window.history.back();
    } else {
      setQuery({ title: null }, { replace: true });
    }
  };
  return <DetailModal key={id} id={id} onClose={close} />;
}

function DetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useAsync((signal) => api.get<{ item: ItemDetail }>(`/api/catalog/items/${id}`, { signal }), [id]);
  useServerEvents(['metadata.updated'], (_t, data) => {
    if (data.mediaItemId === id) detail.reload();
  });
  const item = detail.data?.item;

  return (
    <Modal onClose={onClose} label={item?.title ?? 'Title details'} className="max-w-5xl">
      {detail.loading && !item && (
        <div className="grid h-96 place-items-center">
          <Spinner />
        </div>
      )}
      {detail.error ? (
        <div className="p-8">
          <ErrorNote error={detail.error} onRetry={detail.reload} />
        </div>
      ) : null}
      {item && <DetailBody item={item} reload={detail.reload} />}
    </Modal>
  );
}

function DetailBody({ item, reload }: { item: ItemDetail; reload: () => void }) {
  const { navigate } = useRouter();
  const { profile } = useSession();
  const toast = useToast();
  const [inList, toggleList] = useListToggle(item.inList, item.id);
  const [versionId, setVersionId] = useState<number | null>(item.target?.fileId ?? item.versions[0]?.id ?? null);
  const [fixing, setFixing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
  const writers = item.crew.filter((c) => ['Writer', 'Screenplay', 'Novel'].includes(c.job));
  const seasonCount = item.seasons.filter((s) => s.seasonNumber > 0).length;

  return (
    <>
      <div className="relative aspect-video max-h-[60vh] w-full overflow-hidden bg-neutral-800">
        {item.backdrop && <img src={item.backdrop} alt="" className="size-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-neutral-900 via-neutral-900/20 to-transparent" />
        <div className="absolute bottom-6 left-6 right-6 space-y-4 sm:bottom-10 sm:left-12">
          {item.logo ? (
            <img src={item.logo} alt={item.title} className="max-h-28 max-w-[60%] object-contain object-left drop-shadow-2xl" />
          ) : (
            <h2 className="text-3xl font-black drop-shadow-lg sm:text-5xl">{item.title}</h2>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {target && (
              <Button variant="primary" size="lg" onClick={() => play()}>
                <PlayIcon size={22} />
                {target.resume ? 'Resume' : 'Play'}
                {target.episodeLabel && <span className="font-normal">{target.episodeLabel}</span>}
              </Button>
            )}
            {target?.resume && (
              <Button variant="secondary" size="lg" onClick={() => play(true)}>
                Start over
              </Button>
            )}
            <IconButton label={inList ? 'Remove from My List' : 'Add to My List'} onClick={() => void toggleList()}>
              {inList ? <CheckIcon /> : <PlusIcon />}
            </IconButton>
            <IconButton
              label={item.watched ? 'Mark as unwatched' : 'Mark as watched'}
              onClick={() => void setWatched(!item.watched)}
              className={item.watched ? 'border-emerald-400 text-emerald-300' : ''}
            >
              <CheckIcon />
            </IconButton>
          </div>
          {target?.resume && target.durationSeconds ? (
            <div className="flex max-w-sm items-center gap-3 text-xs text-neutral-300">
              <div className="h-1 flex-1 overflow-hidden rounded bg-neutral-600">
                <div className="h-full bg-brand" style={{ width: `${(target.positionSeconds / target.durationSeconds) * 100}%` }} />
              </div>
              {Math.max(1, Math.round((target.durationSeconds - target.positionSeconds) / 60))} min left
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-8 px-6 pt-2 pb-8 sm:px-12 md:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-300">
            {item.rating ? <span className="font-semibold text-emerald-400">{Math.round(item.rating * 10)}% rating</span> : null}
            {item.year && <span>{item.year}</span>}
            {item.contentRating && <Badge>{item.contentRating}</Badge>}
            {item.kind === 'movie' ? (
              formatRuntime(item.runtimeMinutes) && <span>{formatRuntime(item.runtimeMinutes)}</span>
            ) : (
              <span>{seasonCount === 1 ? '1 Season' : `${seasonCount} Seasons`}</span>
            )}
            {item.resolution && <Badge>{item.resolution === '4K' ? 'UHD' : item.resolution}</Badge>}
            {item.hdr && <Badge>{item.hdr}</Badge>}
          </div>
          {item.tagline && <p className="font-medium text-neutral-200 italic">{item.tagline}</p>}
          <p className="leading-relaxed text-neutral-100">{item.overview ?? 'No description available yet.'}</p>

          {item.kind === 'movie' && item.versions.length > 1 && (
            <label className="flex items-center gap-3 text-sm">
              <span className="text-neutral-400">Version</span>
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
        <dl className="space-y-3 text-sm">
          {item.cast.length > 0 && (
            <div>
              <dt className="inline text-neutral-500">Cast: </dt>
              <dd className="inline text-neutral-200">{item.cast.slice(0, 6).map((c) => c.name).join(', ')}</dd>
            </div>
          )}
          {item.genres.length > 0 && (
            <div>
              <dt className="inline text-neutral-500">Genres: </dt>
              <dd className="inline text-neutral-200">{item.genres.join(', ')}</dd>
            </div>
          )}
          {directors.length > 0 && (
            <div>
              <dt className="inline text-neutral-500">{item.kind === 'show' ? 'Created by' : 'Director'}: </dt>
              <dd className="inline text-neutral-200">{directors.map((d) => d.name).join(', ')}</dd>
            </div>
          )}
          {writers.length > 0 && (
            <div>
              <dt className="inline text-neutral-500">Writers: </dt>
              <dd className="inline text-neutral-200">{[...new Set(writers.map((d) => d.name))].join(', ')}</dd>
            </div>
          )}
          {item.studios.length > 0 && (
            <div>
              <dt className="inline text-neutral-500">{item.kind === 'show' ? 'Network' : 'Studio'}: </dt>
              <dd className="inline text-neutral-200">{item.studios.slice(0, 3).join(', ')}</dd>
            </div>
          )}
        </dl>
      </div>

      {item.kind === 'show' && item.seasons.length > 0 && <Episodes item={item} onChanged={reload} />}

      {item.cast.some((c) => c.photo) && (
        <section className="px-6 pb-8 sm:px-12">
          <h3 className="mb-4 text-xl font-bold">Cast</h3>
          <ul className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
            {item.cast.slice(0, 15).map((c, i) => (
              <li key={`${c.name}-${i}`} className="w-24 shrink-0 text-center">
                <div className="mx-auto mb-2 size-20 overflow-hidden rounded-full bg-neutral-800">
                  {c.photo && <img src={c.photo} alt="" loading="lazy" className="size-full object-cover" />}
                </div>
                <p className="text-xs font-semibold">{c.name}</p>
                {c.character && <p className="text-xs text-neutral-500">{c.character}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {item.similar.length > 0 && <MoreLikeThis items={item.similar} />}

      <footer className="space-y-3 border-t border-white/10 px-6 py-6 sm:px-12">
        {profile?.isAdmin && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mr-2 text-neutral-400">
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

  const toggleWatched = async (e: EpisodeEntry) => {
    try {
      await api.put(`/api/catalog/items/${item.id}/watched`, { watched: !e.watched, episodeId: e.id });
      episodes.reload();
      onChanged();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <section className="px-6 pb-8 sm:px-12">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-xl font-bold">Episodes</h3>
        {item.seasons.length > 1 ? (
          <select className={`${inputBase} w-auto font-semibold`} value={season} onChange={(e) => setSeason(Number(e.target.value))}>
            {item.seasons.map((s) => (
              <option key={s.seasonNumber} value={s.seasonNumber}>
                {s.title} ({s.episodeCount})
              </option>
            ))}
          </select>
        ) : (
          <span className="text-neutral-300">{item.seasons[0]!.title}</span>
        )}
      </div>
      {episodes.loading && !episodes.data && <Spinner />}
      {episodes.error ? <ErrorNote error={episodes.error} onRetry={episodes.reload} /> : null}
      <ol className="divide-y divide-white/10 border-y border-white/10">
        {episodes.data?.episodes.map((e) => (
          <li key={e.id} className="group flex items-start gap-4 py-4">
            <span className="hidden w-6 shrink-0 pt-6 text-center text-xl text-neutral-400 sm:block">{e.episodeNumber}</span>
            <button
              type="button"
              onClick={() => navigate(`/watch/${e.fileId}?t=${Math.floor(e.positionSeconds)}`)}
              className="relative aspect-video w-32 shrink-0 overflow-hidden rounded bg-neutral-800 sm:w-40"
              aria-label={`Play ${e.label} ${e.title}`}
            >
              {e.still && <img src={e.still} alt="" loading="lazy" className="size-full object-cover" />}
              <span className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 transition group-hover:opacity-100">
                <span className="grid size-10 place-items-center rounded-full border-2 border-white bg-black/50">
                  <PlayIcon size={18} />
                </span>
              </span>
              {e.progress > 0 && (
                <span className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded bg-neutral-600">
                  <span className="block h-full bg-brand" style={{ width: `${e.progress * 100}%` }} />
                </span>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">
                  <span className="text-neutral-400 sm:hidden">{e.episodeNumber}. </span>
                  {e.title}
                </p>
                <span className="shrink-0 text-sm text-neutral-400">{formatRuntime(e.runtimeMinutes)}</span>
              </div>
              {e.overview && <p className="mt-1 line-clamp-3 text-sm text-neutral-400">{e.overview}</p>}
            </div>
            <button
              type="button"
              onClick={() => void toggleWatched(e)}
              title={e.watched ? 'Mark as unwatched' : 'Mark as watched'}
              aria-label={e.watched ? 'Mark as unwatched' : 'Mark as watched'}
              className={`mt-5 grid size-7 shrink-0 place-items-center rounded-full border ${e.watched ? 'border-emerald-400 text-emerald-300' : 'border-neutral-600 text-neutral-600 hover:text-neutral-300'}`}
            >
              <CheckIcon size={14} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MoreLikeThis({ items }: { items: ItemDetail['similar'] }) {
  const openTitle = useOpenTitle();
  return (
    <section className="px-6 pb-8 sm:px-12">
      <h3 className="mb-4 text-xl font-bold">More Like This</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((c) => (
          <button key={c.id} type="button" onClick={() => openTitle(c.id)} className="overflow-hidden rounded-md bg-neutral-800 text-left transition hover:bg-neutral-700">
            <div className="relative aspect-video bg-neutral-700">
              {(c.backdrop ?? c.poster) && <img src={c.backdrop ?? c.poster!} alt="" loading="lazy" className="size-full object-cover" />}
            </div>
            <div className="space-y-1 p-3">
              <p className="truncate font-semibold">{c.title}</p>
              <p className="flex items-center gap-2 text-xs text-neutral-400">
                {c.contentRating && <Badge>{c.contentRating}</Badge>}
                {c.year}
              </p>
              {c.overview && <p className="line-clamp-3 text-xs text-neutral-400">{c.overview}</p>}
            </div>
          </button>
        ))}
      </div>
    </section>
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
