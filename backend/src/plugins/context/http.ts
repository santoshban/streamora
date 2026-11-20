import { setTimeout as sleep } from 'node:timers/promises';
import type {
  HttpRequestOptions,
  HttpResponse,
  PluginHttpClient,
  PluginHttpError as PluginHttpErrorShape,
} from '@streamora/plugin-sdk';
import type { RateLimiter } from './rate-limiter.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class PluginHttpError extends Error implements PluginHttpErrorShape {
  override readonly name = 'PluginHttpError' as const;
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}`);
  }
}

export class HostNotAllowedError extends Error {
  constructor(pluginId: string, host: string) {
    super(
      `Plugin "${pluginId}" is not allowed to contact "${host}". Add it to "permissions.network" in the plugin's manifest.json.`,
    );
    this.name = 'HostNotAllowedError';
  }
}

/** Removes credentials from URLs before they reach logs or error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) u.searchParams.set(key, 'redacted');
    }
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** `api.example.com`, `*.example.com` (matches apex too) or `*`. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      const apex = p.slice(2);
      return h === apex || h.endsWith(`.${apex}`);
    }
    return h === p;
  });
}

export interface HttpClientOptions {
  pluginId: string;
  userAgent: string;
  /** Resolved host patterns (no `setting:` entries). */
  allowedHosts: string[];
  limiter: RateLimiter;
  /** Plugin lifetime signal. */
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  onRequest?: (info: { method: string; url: string; status?: number; ms: number; attempt: number; error?: string }) => void;
}

function buildBody(body: HttpRequestOptions['body'], headers: Record<string, string>): RequestInit['body'] {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  return JSON.stringify(body);
}

function retryDelayMs(res: Response | undefined, attempt: number): number {
  const header = res?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, 8_000);
}

async function readBody(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Response from ${redactUrl(url)} is larger than ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response from ${redactUrl(url)} is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toResponse(url: string, res: Response, bytes: Uint8Array): HttpResponse {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  let textCache: string | undefined;
  const text = () => (textCache ??= new TextDecoder('utf-8').decode(bytes));
  return {
    url,
    status: res.status,
    ok: res.ok,
    headers,
    text,
    json: <T>() => JSON.parse(text()) as T,
    bytes: () => bytes,
  };
}

/** `fetch` wrapper enforcing the plugin's host allow-list, rate limit, timeouts, retries and size caps. */
export class PluginHttpClientImpl implements PluginHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private assertAllowed(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported protocol "${url.protocol}" (only http and https are allowed)`);
    }
    if (!hostMatches(url.hostname, this.options.allowedHosts)) {
      throw new HostNotAllowedError(this.options.pluginId, url.hostname);
    }
  }

  async request(rawUrl: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    let url = new URL(rawUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    this.assertAllowed(url);

    let method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'user-agent': this.options.userAgent,
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...options.headers,
    };
    let body = buildBody(options.body, headers);
    const retries = options.retries ?? DEFAULT_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const callerSignals = [this.options.signal, options.signal].filter((s): s is AbortSignal => !!s);

    let redirects = 0;
    for (let attempt = 0; ; attempt++) {
      const callerSignal = AbortSignal.any(callerSignals);
      await this.options.limiter.acquire(callerSignal);
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
      const started = Date.now();

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal, redirect: 'manual' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.onRequest?.({ method, url: redactUrl(url.href), ms: Date.now() - started, attempt, error: message });
        if (callerSignal.aborted) throw callerSignal.reason ?? err;
        if (attempt < retries) {
          await sleep(retryDelayMs(undefined, attempt), undefined, { signal: callerSignal });
          continue;
        }
        const timedOut = signal.aborted && !callerSignal.aborted;
        throw new Error(
          timedOut
            ? `Request to ${redactUrl(url.href)} timed out after ${timeoutMs} ms`
            : `Request to ${redactUrl(url.href)} failed: ${message}`,
        );
      }

      this.options.onRequest?.({ method, url: redactUrl(url.href), status: res.status, ms: Date.now() - started, attempt });

      // Follow redirects manually so every hop is checked against the allow-list.
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        await res.body?.cancel();
        if (++redirects > MAX_REDIRECTS) throw new Error(`Too many redirects from ${redactUrl(rawUrl)}`);
        url = new URL(res.headers.get('location')!, url);
        this.assertAllowed(url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        attempt--; // a redirect is not a retry
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await res.body?.cancel();
        await sleep(retryDelayMs(res, attempt), undefined, { signal: callerSignal });
        continue;
      }

      const bytes = method === 'HEAD' ? new Uint8Array() : await readBody(res, maxBytes, url.href);
      return toResponse(url.href, res, bytes);
    }
  }

  private async requireOk(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    const res = await this.request(url, options);
    if (!res.ok) throw new PluginHttpError(res.status, res.url, res.text().slice(0, 2048));
    return res;
  }

  async getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
    const res = await this.requireOk(url, options);
    try {
      return res.json<T>();
    } catch {
      throw new Error(`Invalid JSON from ${redactUrl(res.url)}`);
    }
  }

  async getText(url: string, options?: HttpRequestOptions): Promise<string> {
    return (await this.requireOk(url, options)).text();
  }

  async getBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array> {
    return (await this.requireOk(url, options)).bytes();
  }
}
