import { useEffect, useRef, useState } from 'react';
import { TmdbCredit } from '../components/Brand';
import { CardGrid, CardRow, rowItemClass, TitleCard } from '../components/Cards';
import { Hero } from '../components/Hero';
import { ErrorNote, inputBase, inputClass, Spinner, useToast } from '../components/ui';
import { api, errorText, qs } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { useAsync } from '../lib/hooks';
import { Link, useRouter } from '../lib/router';
import type { Card, HomeData, MediaKind } from '../lib/types';
import { useSession } from '../state/session';

function PageFooter() {
  return (
    <footer className="mt-16 space-y-2 border-t border-white/5 px-4 py-10 sm:px-12">
      <TmdbCredit />
      <p className="text-xs text-neutral-600">Streamora — your library, your server.</p>
    </footer>
  );
}

function EmptyLibrary() {
  const { profile } = useSession();
  return (
    <div className="mx-auto mt-40 max-w-lg space-y-4 px-6 text-center">
      <h1 className="text-3xl font-bold">Nothing to watch yet</h1>
      {profile?.isAdmin ? (
        <>
          <p className="text-neutral-400">Add a library pointing at your movie or TV folders. Streamora will scan it and fetch artwork and details.</p>
          <Link to="/admin/libraries" className="inline-block rounded-md bg-brand px-5 py-2.5 font-semibold hover:bg-brand-dark">
            Add a library
          </Link>
        </>
      ) : (
        <p className="text-neutral-400">Ask the admin of this server to add a library.</p>
      )}
    </div>
  );
}

export function HomePage() {
  const home = useAsync((signal) => api.get<HomeData>('/api/catalog/home', { signal }), []);
  const toast = useToast();
  // New titles from a scan appear without a reload (debounced: scans emit many events).
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents(['scan.completed'], () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(home.reload, 1500);
  });

  if (home.loading && !home.data) {
    return (
      <div className="grid h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (home.error) {
    return (
      <div className="px-4 pt-28 sm:px-12">
        <ErrorNote error={home.error} onRetry={home.reload} />
      </div>
    );
  }
  const data = home.data!;
  if (!data.rows.length) return <EmptyLibrary />;

  const removeFromContinue = async (id: number) => {
    home.setData((d) => ({ ...d!, rows: d!.rows.map((r) => (r.kind === 'continue' ? { ...r, items: r.items.filter((i) => i.id !== id) } : r)) }));
    await api.del(`/api/catalog/continue/${id}`).catch((err: unknown) => toast(errorText(err), 'error'));
  };

  return (
    <div className="pb-8">
      {data.hero ? <Hero hero={data.hero} /> : <div className="h-24" />}
      <div className={`relative z-10 space-y-8 sm:space-y-10 ${data.hero ? '-mt-(--hero-overlap)' : ''}`}>
        {data.rows.map((row) => (
          <CardRow key={row.id} title={row.title} count={row.items.length}>
            {row.items.map((card) => (
              <div key={card.id} className={rowItemClass}>
                <TitleCard card={card} onRemove={row.kind === 'continue' ? () => void removeFromContinue(card.id) : undefined} />
              </div>
            ))}
          </CardRow>
        ))}
      </div>
      <PageFooter />
    </div>
  );
}

const PAGE = 60;

/** Movies / TV Shows: genre filter + sort, loads more as you scroll. */
export function KindPage({ kind }: { kind: MediaKind }) {
  const { query, setQuery } = useRouter();
  const genre = query.get('genre') ?? '';
  const sort = query.get('sort') ?? 'added';
  const genres = useAsync((signal) => api.get<{ genres: Array<{ name: string; count: number }> }>(`/api/catalog/genres?kind=${kind}`, { signal }), [kind]);
  const [items, setItems] = useState<Card[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const sentinel = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const load = async (offset: number) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.get<{ total: number; items: Card[] }>(
        `/api/catalog/browse${qs({ kind, genre: genre || undefined, sort, offset, limit: PAGE })}`,
      );
      if (id !== requestId.current) return;
      setItems((current) => (offset === 0 ? res.items : [...current, ...res.items]));
      setTotal(res.total);
    } catch (err) {
      if (id === requestId.current) setError(err);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setTotal(null);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, genre, sort]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && total !== null && items.length < total) void load(items.length);
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const title = kind === 'movie' ? 'Movies' : 'TV Shows';
  return (
    <div className="px-4 pt-24 sm:px-12">
      <div className="mb-8 flex flex-wrap items-center gap-4">
        <h1 className="text-3xl font-bold sm:text-4xl">{genre ? `${title}: ${genre}` : title}</h1>
        <select className={`${inputBase} w-auto`} value={genre} onChange={(e) => setQuery({ genre: e.target.value || null }, { replace: true })} aria-label="Genre">
          <option value="">All genres</option>
          {genres.data?.genres.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.count})
            </option>
          ))}
        </select>
        <select className={`${inputBase} ml-auto w-auto`} value={sort} onChange={(e) => setQuery({ sort: e.target.value }, { replace: true })} aria-label="Sort">
          <option value="added">Recently added</option>
          <option value="title">A–Z</option>
          <option value="release">Release date</option>
          <option value="rating">Rating</option>
        </select>
      </div>
      {error ? <ErrorNote error={error} onRetry={() => void load(0)} /> : null}
      {total === 0 && <p className="py-20 text-center text-neutral-400">No {title.toLowerCase()} {genre ? `in ${genre}` : 'yet'}.</p>}
      <CardGrid cards={items} />
      <div ref={sentinel} className="h-20" />
      {loading && <Spinner className="mx-auto" />}
      <PageFooter />
    </div>
  );
}

export function MyListPage() {
  const list = useAsync((signal) => api.get<{ items: Card[] }>('/api/catalog/my-list', { signal }), []);
  return (
    <div className="px-4 pt-24 sm:px-12">
      <h1 className="mb-8 text-3xl font-bold sm:text-4xl">My List</h1>
      {list.loading && !list.data && <Spinner />}
      {list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : null}
      {list.data && list.data.items.length === 0 && (
        <p className="py-20 text-center text-neutral-400">Add titles with the + button to watch them later.</p>
      )}
      {list.data && <CardGrid cards={list.data.items} />}
      <PageFooter />
    </div>
  );
}

export function SearchPage() {
  const { query } = useRouter();
  const q = query.get('q') ?? '';
  const results = useAsync(
    (signal) => (q ? api.get<{ items: Card[] }>(`/api/catalog/search?q=${encodeURIComponent(q)}`, { signal }) : Promise.resolve({ items: [] })),
    [q],
  );
  return (
    <div className="px-4 pt-24 sm:px-12">
      {q && <p className="mb-6 text-neutral-400">Results for &ldquo;{q}&rdquo;</p>}
      {results.loading && !results.data && <Spinner />}
      {results.error ? <ErrorNote error={results.error} /> : null}
      {results.data && q && results.data.items.length === 0 && (
        <div className="py-20 text-center text-neutral-400">
          <p>Your search for &ldquo;{q}&rdquo; did not have any matches.</p>
          <p className="mt-2 text-sm">Try a title, an actor or a genre.</p>
        </div>
      )}
      {results.data && <CardGrid cards={results.data.items} />}
    </div>
  );
}

export function NotFound() {
  return (
    <div className="mx-auto mt-40 max-w-md space-y-4 text-center">
      <h1 className="text-4xl font-bold">Lost your way?</h1>
      <p className="text-neutral-400">That page doesn&rsquo;t exist.</p>
      <Link to="/" className="inline-flex h-10 items-center rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-white/80">
        Streamora Home
      </Link>
    </div>
  );
}
