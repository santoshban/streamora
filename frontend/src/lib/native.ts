/**
 * The Android app shows this web UI in a WebView and plays videos in its own
 * player. It injects `window.StreamoraAndroid` (a WebView message listener,
 * only for the server's own origin) and calls back through window events.
 */
interface AndroidBridge {
  postMessage(message: string): void;
}

export type AppMessage =
  /** `startSeconds: null` resumes from the saved position. */
  | { type: 'play'; fileId: number; startSeconds: number | null }
  | { type: 'changeServer' }
  /** A profile is signed in: the app can now ask for the server's other addresses. */
  | { type: 'signedIn' };

const bridge = (window as unknown as { StreamoraAndroid?: AndroidBridge }).StreamoraAndroid;

/** True inside the Android app. */
export const inAndroidApp = typeof bridge?.postMessage === 'function';

export function postToApp(message: AppMessage): void {
  bridge?.postMessage(JSON.stringify(message));
}

/** Dispatched by the app when its player closes, so pages reload progress. */
export const APP_RESUMED_EVENT = 'streamora:app-resumed';

/** Hands a `/watch/:id?t=` URL to the app's player. Returns whether it did. */
export function playInApp(url: string): boolean {
  if (!inAndroidApp) return false;
  const parsed = new URL(url, window.location.origin);
  const match = /^\/watch\/(\d+)$/.exec(parsed.pathname);
  if (!match) return false;
  const t = parsed.searchParams.get('t');
  postToApp({ type: 'play', fileId: Number(match[1]), startSeconds: t === null ? null : Number(t) || 0 });
  return true;
}
