import { useCallback, useState } from 'react';
import { api, errorText } from '../lib/api';
import { setModalOrigin } from '../lib/motion';
import { useRouter } from '../lib/router';
import type { PlayTarget } from '../lib/types';
import { useToast } from './ui';

export const watchUrl = (target: PlayTarget) => `/watch/${target.fileId}?t=${Math.floor(target.resume ? target.positionSeconds : 0)}`;

/** Whether the open `?title=` was pushed by the app (so closing can go Back). */
export let titleOpenedInApp = false;
export const resetTitleOpened = () => {
  titleOpenedInApp = false;
};

/** Opens the detail modal for a title (via `?title=` so Back closes it). Pass the element
 *  that was clicked and the modal zooms out of it. */
export function useOpenTitle() {
  const { setQuery } = useRouter();
  return useCallback(
    (id: number, from?: Element | DOMRect | null) => {
      titleOpenedInApp = true;
      setModalOrigin(from instanceof Element ? from.getBoundingClientRect() : (from ?? null));
      setQuery({ title: String(id) });
    },
    [setQuery],
  );
}

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

/** TMDB rating (0–10) shown Netflix-style as a green percentage. */
export const ratingPercent = (rating: number | null | undefined) => (rating ? `${Math.round(rating * 10)}% Rating` : null);
