import type { CallOptions } from '@streamora/plugin-sdk';

export class PluginTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'PluginTimeoutError';
  }
}

/**
 * Runs `fn` with an AbortSignal that fires on timeout or when any parent
 * signal aborts. Resolves/rejects as soon as the signal fires, even if the
 * plugin ignores it.
 */
export async function callWithTimeout<T>(
  label: string,
  fn: (options: CallOptions) => Promise<T> | T,
  timeoutMs: number,
  parents: Array<AbortSignal | undefined> = [],
): Promise<T> {
  const controller = new AbortController();
  const live = parents.filter((s): s is AbortSignal => !!s);
  const forward = (s: AbortSignal) => () => controller.abort(s.reason);
  const listeners = live.map((s) => {
    const listener = forward(s);
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener('abort', listener, { once: true });
    return [s, listener] as const;
  });
  const timer = setTimeout(() => controller.abort(new PluginTimeoutError(label, timeoutMs)), timeoutMs);

  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error(`${label} aborted`));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });

  try {
    return await Promise.race([Promise.resolve().then(() => fn({ signal: controller.signal })), aborted]);
  } finally {
    clearTimeout(timer);
    for (const [s, listener] of listeners) s.removeEventListener('abort', listener);
    // Swallow the race loser's rejection.
    aborted.catch(() => undefined);
  }
}
