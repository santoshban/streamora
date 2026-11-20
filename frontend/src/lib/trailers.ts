import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSession } from '../state/session';
import { api } from './api';
import { reducedMotion } from './motion';

export interface Trailer {
  site: 'youtube';
  key: string;
  name: string | null;
}

/** One lookup per title per page load; failures are forgotten so a later hover retries. */
const cache = new Map<number, Promise<Trailer | null>>();

export function fetchTrailer(id: number): Promise<Trailer | null> {
  let pending = cache.get(id);
  if (!pending) {
    pending = api
      .get<{ trailer: Trailer | null }>(`/api/catalog/items/${id}/trailer`)
      .then((r) => r.trailer)
      .catch(() => {
        cache.delete(id);
        return null;
      });
    cache.set(id, pending);
  }
  return pending;
}

/** The trailer for a title once known (`undefined` while loading or when disabled). */
export function useTrailer(id: number, enabled: boolean): Trailer | null | undefined {
  const [trailer, setTrailer] = useState<Trailer | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchTrailer(id).then((t) => {
      if (alive) setTrailer(t);
    });
    return () => {
      alive = false;
    };
  }, [id, enabled]);
  return enabled ? trailer : undefined;
}

/** Netflix's "Autoplay previews while browsing": the profile setting, unless the device
 *  asks for less motion or to save data. */
export function useAutoplayPreviews(): boolean {
  const { profile } = useSession();
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  return profile?.preferences?.autoplayPreviews !== false && !saveData && !reducedMotion();
}

// ── shared mute state ────────────────────────────────────────────────────────

/** Previews start muted; unmuting one unmutes the next too (until the page reloads). */
let muted = true;
const listeners = new Set<() => void>();

export function setTrailersMuted(value: boolean) {
  muted = value;
  listeners.forEach((l) => l());
}

export function useTrailersMuted(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => muted,
  );
}
