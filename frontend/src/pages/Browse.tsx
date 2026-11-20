import { useEffect, useMemo, useRef, useState } from 'react';
import { TmdbCredit } from '../components/Brand';
import { CardGrid, CardRow, GridSkeleton, RowSkeleton, TitleCard } from '../components/Cards';
import { Hero, HeroSkeleton } from '../components/Hero';
import { Dropdown, ErrorNote, Spinner, useToast } from '../components/ui';
import { api, errorText, qs } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { useAsync, useScrollState } from '../lib/hooks';
import { Link, useRouter } from '../lib/router';
import type { Card, HomeData, MediaKind, Row } from '../lib/types';
import { useSession } from '../state/session';

/** Rows whose "Explore All" has a page to go to. */
const ROW_LINKS: Record<string, string> = { 'my-list': '/my-list', movies: '/movies', shows: '/shows' };
/** "Recently Added" tags go on at most this many of the newest titles, if this recent. */
const RECENT_TAGS = 5;
const RECENT_DAYS = 14;

function PageFooter() {
  const { profile, switchProfile } = useSession();
  const links: Array<[string, string]> = [
    ['/', 'Home'],
    ['/shows', 'TV Shows'],
    ['/movies', 'Movies'],
    ['/my-list', 'My List'],
  ];
  if (profile?.isAdmin) links.push(['/admin/libraries', 'Libraries'], ['/admin/plugins', 'Plugins']);
  return (
    <footer className="mx-auto mt-[clamp(3rem,6vw,6rem)] max-w-[980px] px-[4%] pb-10 text-[13px] text-muted">
      <ul className="mb-6 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {links.map(([to, label]) => (
          <li key={to}>
            <Link to={to} className="hover:underline">
              {label}
            </Link>
          </li>
        ))}
        <li>
          <button type="button" onClick={switchProfile} className="hover:underline">
            Switch profile
          </button>
        </li>
      </ul>
      <TmdbCredit className="mb-4 max-w-xl" />
      <p className="text-[11px]">&copy; {new Date().getFullYear()} Streamora &mdash; your library, your server.</p>
    </footer>
  );
}

function EmptyLibrary() {
  const { profile } = useSession();
  return (
    <div className="mx-auto max-w-lg space-y-4 px-6 pt-[calc(var(--header-h)+8rem)] text-center animate-fade-up">
      <h1 className="text-3xl font-bold">Nothing to watch yet</h1>
      {profile?.isAdmin ? (
        <>
          <p className="text-soft">Add a library pointing at your movie or TV folders. Streamora will scan it and fetch artwork and details.</p>
          <Link to="/admin/libraries" className="inline-block rounded-[4px] bg-brand px-5 py-2.5 font-semibold transition-colors hover:bg-brand-dark">
            Add a library
          </Link>
        </>
      ) : (
        <p className="text-soft">Ask the admin of this server to add a library.</p>
      )}
    </div>
  );
}

/** The newest few titles, if added in the last couple of weeks, get a tile tag. */
function recentIds(rows: Row[]): Set<number> {
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = rows.find((r) => r.id === 'recent')?.items ?? [];
  return new Set(
    recent
      .filter((c) => Date.parse(c.addedAt) >= cutoff)
      .slice(0, RECENT_TAGS)
      .map((c) => c.id),
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
  useEffect(() => () => clearTimeout(timer.current), []);
  const tagged = useMemo(() => recentIds(home.data?.rows ?? []), [home.data]);

  if (home.loading && !home.data) {
    return (
      <div className="pb-8">
        <HeroSkeleton />
        <div className="mt-[clamp(1.5rem,3vw,3rem)] space-y-[clamp(1.75rem,3vw,3.25rem)]">
          <RowSkeleton titleWidth="12rem" />
          <RowSkeleton titleWidth="9rem" />
          <RowSkeleton titleWidth="14rem" />
        </div>
      </div>
    );
  }
  if (home.error) {
    return (
      <div className="gutter-x pt-[calc(var(--header-h)+2rem)]">
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
    <div className="relative pb-8">
      {data.hero ? <Hero hero={data.hero} /> : <div className="h-(--header-h)" />}
      <div className="relative z-[1] mt-[clamp(1.5rem,3vw,3rem)] space-y-[clamp(1.75rem,3vw,3.25rem)]">
        {data.rows.map((row, i) => (
          <div key={row.id} className="animate-fade-up" style={{ animationDelay: `${180 + Math.min(i, 6) * 80}ms` }}>
            <CardRow title={row.title} href={ROW_LINKS[row.id]} count={row.items.length}>
              {row.items.map((card) => (
                <TitleCard
                  key={card.id}
                  card={card}
                  tag={row.kind === 'standard' && row.id !== 'recent' && tagged.has(card.id) ? 'Recently added' : null}
                  onRemove={row.kind === 'continue' ? () => void removeFromContinue(card.id) : undefined}
                />
              ))}
            </CardRow>
          </div>
        ))}
      </div>
      <PageFooter />
    </div>
  );
}

const PAGE = 60;
const SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'A–Z' },
  { value: 'release', label: 'Release date' },
  { value: 'rating', label: 'Rating' },
];

/** Page header like Netflix's category pages: big title and a Genres dropdown, pinned
 *  under the nav (wide screens) with a solid background once the page scrolls. */
function SubHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  const { scrolled } = useScrollState(0);
  return (
    <div
      className={`gutter-x z-30 flex flex-wrap items-center gap-x-[clamp(1rem,2vw,2.25rem)] gap-y-3 py-[clamp(0.75rem,1.3vw,1.4rem)] transition-colors duration-500 min-[950px]:sticky min-[950px]:top-(--nav-h) ${
        scrolled ? 'min-[950px]:bg-surface' : ''
      }`}
    >
      <h1 className="text-[clamp(1.6rem,2.6vw,2.6rem)] leading-tight font-bold animate-fade-up">{title}</h1>
      {children}
    </div>
  );
}

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
  const genreOptions = [{ value: '', label: 'All genres' }, ...(genres.data?.genres.map((g) => ({ value: g.name, label: g.name, detail: g.count })) ?? [])];

  return (
    <div className="pt-(--header-h) pb-8">
      <SubHeader title={title}>
        <Dropdown label="Genres" value={genre} options={genreOptions} placeholder="Genres" onChange={(v) => setQuery({ genre: v || null }, { replace: true })} className="animate-[fade-up_0.6s_var(--ease-out-expo)_80ms_backwards]" />
        <Dropdown label="Sort" value={sort} options={SORTS} onChange={(v) => setQuery({ sort: v }, { replace: true })} align="right" className="ml-auto animate-[fade-up_0.6s_var(--ease-out-expo)_120ms_backwards]" />
      </SubHeader>
      <div className="gutter-x mt-[clamp(0.5rem,1.5vw,1.5rem)]">
        {error ? <ErrorNote error={error} onRetry={() => void load(0)} /> : null}
        {total === 0 && <p className="py-20 text-center text-soft animate-fade-in">No {title.toLowerCase()} {genre ? `in ${genre}` : 'yet'}.</p>}
        {items.length === 0 && total === null && !error ? <GridSkeleton /> : <CardGrid cards={items} pageSize={PAGE} />}
        <div ref={sentinel} className="h-20" />
        {loading && items.length > 0 && <Spinner className="mx-auto text-soft" />}
      </div>
      <PageFooter />
    </div>
  );
}

export function MyListPage() {
  const list = useAsync((signal) => api.get<{ items: Card[] }>('/api/catalog/my-list', { signal }), []);
  return (
    <div className="pt-(--header-h) pb-8">
      <SubHeader title="My List" />
      <div className="gutter-x mt-[clamp(0.5rem,1.5vw,1.5rem)]">
        {list.loading && !list.data && <GridSkeleton count={6} />}
        {list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : null}
        {list.data && list.data.items.length === 0 && (
          <p className="py-20 text-center text-soft animate-fade-in">You haven&rsquo;t added any titles to your list yet. Use the + button on any title.</p>
        )}
        {list.data && <CardGrid cards={list.data.items} />}
      </div>
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
    <div className="gutter-x pt-[calc(var(--header-h)+clamp(1.5rem,3vw,3rem))] pb-8">
      {q && (
        <p className="mb-[clamp(1rem,2vw,2rem)] text-soft">
          Results for <span className="text-white">&ldquo;{q}&rdquo;</span>
        </p>
      )}
      {results.loading && !results.data && <GridSkeleton count={6} />}
      {results.error ? <ErrorNote error={results.error} /> : null}
      {results.data && q && results.data.items.length === 0 && (
        <div className="py-20 text-center text-soft animate-fade-in">
          <p className="text-ink">Your search for &ldquo;{q}&rdquo; did not have any matches.</p>
          <p className="mt-4 text-sm">Suggestions:</p>
          <ul className="mt-2 space-y-1 text-sm">
            <li>Try different keywords</li>
            <li>Try a title, an actor or a genre</li>
          </ul>
        </div>
      )}
      {results.data && <CardGrid key={q} cards={results.data.items} />}
    </div>
  );
}

export function NotFound() {
  return (
    <div className="mx-auto max-w-md space-y-4 px-6 pt-[calc(var(--header-h)+8rem)] text-center animate-fade-up">
      <h1 className="text-4xl font-bold">Lost your way?</h1>
      <p className="text-soft">That page doesn&rsquo;t exist.</p>
      <Link to="/" className="inline-flex h-10 items-center rounded-[4px] bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/75">
        Streamora Home
      </Link>
    </div>
  );
}
