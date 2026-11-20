import { describe, expect, it } from 'vitest';
import { hostMatches, PluginHttpClientImpl, redactUrl } from '../src/plugins/context/http.js';
import { RateLimiter } from '../src/plugins/context/rate-limiter.js';
import { json, mockFetch } from './helpers/harness.js';

function client(fetchImpl: typeof fetch, allowedHosts = ['api.example.com']) {
  return new PluginHttpClientImpl({
    pluginId: 'test',
    userAgent: 'Streamora/test',
    allowedHosts,
    limiter: new RateLimiter(100, 1000),
    signal: new AbortController().signal,
    fetchImpl,
  });
}

describe('host allow-list', () => {
  it('matches exact hosts, wildcards and apexes', () => {
    expect(hostMatches('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostMatches('API.Example.com', ['api.example.com'])).toBe(true);
    expect(hostMatches('evil-example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('cdn.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('anything.net', ['*'])).toBe(true);
    expect(hostMatches('other.com', [])).toBe(false);
  });

  it('blocks requests to hosts outside permissions.network', async () => {
    const { fetchImpl, calls } = mockFetch({});
    await expect(client(fetchImpl).request('https://other.com/x')).rejects.toThrow(/not allowed to contact "other.com"/);
    expect(calls).toHaveLength(0);
  });

  it('re-checks every redirect hop', async () => {
    const { fetchImpl } = mockFetch({
      '/start': () => new Response(null, { status: 302, headers: { location: 'https://evil.com/steal' } }),
    });
    await expect(client(fetchImpl).request('https://api.example.com/start')).rejects.toThrow(/evil.com/);
  });

  it('follows allowed redirects', async () => {
    const { fetchImpl } = mockFetch({
      '/old': () => new Response(null, { status: 301, headers: { location: '/new' } }),
      '/new': () => json({ moved: true }),
    });
    expect(await client(fetchImpl).getJson('https://api.example.com/old')).toEqual({ moved: true });
  });
});

describe('PluginHttpClient', () => {
  it('adds query parameters and default headers', async () => {
    const { fetchImpl, calls } = mockFetch({ '/search': () => json({ ok: 1 }) });
    await client(fetchImpl).getJson('https://api.example.com/search?a=1', { query: { q: 'the matrix', year: 1999, skip: undefined } });
    const call = calls[0]!;
    expect(call.url.searchParams.get('a')).toBe('1');
    expect(call.url.searchParams.get('q')).toBe('the matrix');
    expect(call.url.searchParams.get('year')).toBe('1999');
    expect(call.url.searchParams.has('skip')).toBe(false);
    expect((call.init?.headers as Record<string, string>)['user-agent']).toBe('Streamora/test');
  });

  it('retries 503 and 429 responses, honouring Retry-After', async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch({
      '/flaky': () => {
        attempts++;
        if (attempts === 1) return json({}, 503);
        if (attempts === 2) return json({}, 429, { 'retry-after': '0' });
        return json({ attempts });
      },
    });
    expect(await client(fetchImpl).getJson('https://api.example.com/flaky')).toEqual({ attempts: 3 });
  });

  it('throws PluginHttpError with status for non-2xx responses', async () => {
    const { fetchImpl } = mockFetch({ '/missing': () => json({ message: 'nope' }, 404) });
    await expect(client(fetchImpl).getJson('https://api.example.com/missing?api_key=SECRET')).rejects.toMatchObject({
      name: 'PluginHttpError',
      status: 404,
    });
    const res = await client(fetchImpl).request('https://api.example.com/missing');
    expect(res.status).toBe(404);
  });

  it('enforces the response size limit', async () => {
    const { fetchImpl } = mockFetch({ '/big': () => new Response('x'.repeat(5000)) });
    await expect(client(fetchImpl).getText('https://api.example.com/big', { maxBytes: 1000 })).rejects.toThrow(/larger than 1000/);
  });

  it('redacts credentials in URLs', () => {
    expect(redactUrl('https://u:p@api.example.com/x?api_key=abc&q=1')).toBe('https://api.example.com/x?api_key=redacted&q=1');
  });
});

describe('RateLimiter', () => {
  it('spaces requests to stay within the window', async () => {
    const limiter = new RateLimiter(2, 150);
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all([0, 1, 2, 3].map(async () => {
      await limiter.acquire();
      started.push(Date.now() - t0);
    }));
    started.sort((a, b) => a - b);
    expect(started[1]!).toBeLessThan(100);
    expect(started[2]!).toBeGreaterThanOrEqual(140);
    expect(started[3]!).toBeGreaterThanOrEqual(140);
  });

  it('rejects waiters whose signal aborts without blocking the queue', async () => {
    const limiter = new RateLimiter(1, 10_000);
    await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});
