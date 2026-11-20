/** Small helpers shared by the animated parts of the UI. */

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Mouse/trackpad: hover previews and hover-to-open menus only make sense here. */
export const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

/** The page gutter in px (mirrors `--gutter: max(1rem, 3vw)` in index.css). */
export const gutterPx = () => Math.max(16, document.documentElement.clientWidth * 0.03);

export const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// ── modal origin ─────────────────────────────────────────────────────────────

/** Where the next detail modal should zoom out from: the tile or preview that opened it.
 *  It expires quickly so a modal opened later (Back/Forward, a pasted link) just pops. */
let origin: { rect: DOMRect; at: number } | null = null;

export function setModalOrigin(rect: DOMRect | null) {
  origin = rect ? { rect, at: performance.now() } : null;
}

export function getModalOrigin(): DOMRect | null {
  return origin && performance.now() - origin.at < 800 ? origin.rect : null;
}
