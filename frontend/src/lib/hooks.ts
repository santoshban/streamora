import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally (optimistic updates). */
  setData: (update: T | ((current: T | undefined) => T)) => void;
}

/** Runs `load` whenever `deps` change; stale responses are ignored. */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    loadRef
      .current(controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setDataState(d);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((update: T | ((current: T | undefined) => T)) => {
    setDataState((current) => (typeof update === 'function' ? (update as (c: T | undefined) => T)(current) : update));
  }, []);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useInterval(callback: () => void, ms: number | null) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Closes popovers on outside click / Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}
