import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

/** A deliberately small history-API router: enough for a dozen routes and a modal query param. */

interface Location {
  path: string;
  search: string;
}

interface RouterValue extends Location {
  query: URLSearchParams;
  navigate(to: string, options?: { replace?: boolean; keepScroll?: boolean }): void;
  /** Sets or removes query parameters on the current path. */
  setQuery(update: Record<string, string | null>, options?: { replace?: boolean }): void;
}

const RouterContext = createContext<RouterValue | null>(null);
const read = (): Location => ({ path: window.location.pathname, search: window.location.search });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(read);

  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback<RouterValue['navigate']>((to, options = {}) => {
    const before = window.location.pathname;
    window.history[options.replace ? 'replaceState' : 'pushState'](null, '', to);
    setLocation(read());
    if (!options.keepScroll && window.location.pathname !== before) window.scrollTo(0, 0);
  }, []);

  const setQuery = useCallback<RouterValue['setQuery']>(
    (update, options) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(update)) {
        if (v === null) params.delete(k);
        else params.set(k, v);
      }
      const search = params.toString();
      navigate(`${window.location.pathname}${search ? `?${search}` : ''}`, { ...options, keepScroll: true });
    },
    [navigate],
  );

  const value = useMemo(
    () => ({ ...location, query: new URLSearchParams(location.search), navigate, setQuery }),
    [location, navigate, setQuery],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter outside RouterProvider');
  return value;
}

/** `/watch/:id` against `/watch/12` → `{ id: '12' }`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}
