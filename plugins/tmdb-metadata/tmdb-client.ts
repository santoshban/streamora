import type { PluginContext, PluginHttpError } from '@streamora/plugin-sdk';

const HOUR = 60 * 60_000;
export const TTL = {
  details: 7 * 24 * HOUR,
  search: 24 * HOUR,
  find: 7 * 24 * HOUR,
};

export interface TmdbClientConfig {
  apiBaseUrl: string;
  /** v3 API key (32 hex chars) or v4 Read Access Token (JWT). */
  credential: string;
}

export function isNotFound(err: unknown): boolean {
  return (err as PluginHttpError | undefined)?.name === 'PluginHttpError' && (err as PluginHttpError).status === 404;
}

/** Thin TMDB v3 client: auth, persistent caching and request de-duplication via `ctx.cache.wrap`. */
export class TmdbClient {
  private readonly auth: { headers?: Record<string, string>; query?: Record<string, string> };

  constructor(
    private readonly ctx: PluginContext,
    private readonly config: TmdbClientConfig,
  ) {
    const credential = config.credential.trim();
    // v4 tokens are JWTs ("eyJ...") and are sent as a bearer token; v3 keys go in the query string.
    this.auth = credential.includes('.') && credential.length > 40
      ? { headers: { authorization: `Bearer ${credential}` } }
      : { query: { api_key: credential } };
  }

  async get<T>(
    pathname: string,
    query: Record<string, string | number | boolean | undefined>,
    options: { signal?: AbortSignal; ttlMs: number },
  ): Promise<T> {
    const clean = Object.fromEntries(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string | number | boolean>;
    const cacheKey = `GET ${pathname}?${new URLSearchParams(
      Object.entries(clean).map(([k, v]): [string, string] => [k, String(v)]),
    )}`;
    const url = `${this.config.apiBaseUrl.replace(/\/$/, '')}${pathname}`;

    return this.ctx.cache.wrap(cacheKey, options.ttlMs, () =>
      this.ctx.http.getJson<T>(url, {
        query: { ...clean, ...this.auth.query },
        headers: this.auth.headers,
        signal: options.signal,
      }),
    );
  }
}
