import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import { createServices, type Services } from '../src/services.js';
import { SECRET_MASK } from '../src/plugins/settings.js';
import { silentLogger, tempDir, writeFiles } from './helpers/harness.js';

let root: string;
let mediaDir: string;
let services: Services;
let app: FastifyInstance;

beforeAll(async () => {
  root = tempDir();
  mediaDir = path.join(root, 'media', 'Movies');
  fs.mkdirSync(mediaDir, { recursive: true });
  writeFiles(path.join(root, 'plugins'), {
    'echo/manifest.json': JSON.stringify({
      id: 'echo',
      name: 'Echo',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: ['metadata'],
      settings: [
        { key: 'token', type: 'secret', label: 'Token', required: true },
        { key: 'region', type: 'select', label: 'Region', options: [{ value: 'US', label: 'US' }, { value: 'GB', label: 'GB' }], default: 'US' },
      ],
    }),
    'echo/index.ts': `
      export default (ctx) => ({
        metadata: { async match(req) { return { kind: req.kind, title: req.title.toUpperCase(), contentRating: String(ctx.settings.region) }; } },
        async healthCheck() { return { ok: ctx.settings.token === 'good', message: 'token checked' }; },
      });`,
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: path.join(root, 'data'),
    PLUGINS_DIR: path.join(root, 'plugins'),
    PLUGINS_HOT_RELOAD: 'false',
  });
  services = await createServices(config, silentLogger(), { ffmpeg: { ffmpeg: null, ffprobe: null } });
  app = await buildApp(services);
  await services.plugins.init();
});

afterAll(async () => {
  await app.close();
  await services.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('no session cookie');
  return cookie.value;
}

const as = (session?: string) => (session ? { cookies: { [SESSION_COOKIE]: session } } : {});

describe('API', () => {
  let owner = '';
  let kid = '';

  it('reports health and first-run setup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', name: 'Streamora', setupRequired: true, plugins: { total: 1, active: 0 } });
  });

  it('creates the first profile as admin and signs it in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner', pin: '1234' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().profile).toMatchObject({ name: 'Owner', isAdmin: true, isKids: false, hasPin: true });
    owner = sessionOf(res);

    const me = await app.inject({ method: 'GET', url: '/api/session', ...as(owner) });
    expect(me.json().profile.name).toBe('Owner');
  });

  it("tells signed-in devices the server's ID and addresses", async () => {
    const { serverId } = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(serverId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await app.inject({ method: 'GET', url: '/api/server/addresses' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/server/addresses', ...as(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json().serverId).toBe(serverId);
    // The test config keeps the default HOST=0.0.0.0.
    expect(res.json().listening).toBe('network');
    expect(Array.isArray(res.json().addresses)).toBe(true);
  });

  it('only lets admins create further profiles', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Sneaky' } });
    expect(anonymous.statusCode).toBe(401);

    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Kid', isKids: true }, ...as(owner) });
    expect(res.statusCode).toBe(201);
    expect(res.json().profile).toMatchObject({ isKids: true, isAdmin: false, hasPin: false });

    const invalid = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'X', isKids: true, isAdmin: true }, ...as(owner) });
    expect(invalid.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(list.json()).toMatchObject({ setupRequired: false });
    expect(list.json().profiles.map((p: { name: string }) => p.name)).toEqual(['Owner', 'Kid']);
    expect(JSON.stringify(list.json())).not.toContain('pinHash');
  });

  it('keeps kids profiles out of admin APIs and their own restrictions', async () => {
    const select = await app.inject({ method: 'POST', url: '/api/profiles/2/session', payload: {} });
    expect(select.statusCode).toBe(200);
    kid = sessionOf(select);

    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins', ...as(kid) })).statusCode).toBe(403);
    const escalate = await app.inject({ method: 'PATCH', url: '/api/profiles/2', payload: { isKids: false }, ...as(kid) });
    expect(escalate.statusCode).toBe(403);
    const prefs = await app.inject({
      method: 'PATCH',
      url: '/api/profiles/2',
      payload: { preferences: { subtitleStyle: { size: 'large' } } },
      ...as(kid),
    });
    expect(prefs.json().profile.preferences).toEqual({ subtitleStyle: { size: 'large' } });
  });

  it('verifies PINs and locks out repeated failures', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/profiles/1/session', payload: { pin: '0000' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().message).toBe('Incorrect PIN');

    const right = await app.inject({ method: 'POST', url: '/api/profiles/1/session', payload: { pin: '1234' } });
    expect(right.statusCode).toBe(200);

    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/profiles/1/session', payload: { pin: '9999' } });
    const locked = await app.inject({ method: 'POST', url: '/api/profiles/1/session', payload: { pin: '1234' } });
    expect(locked.statusCode).toBe(429);
  });

  it('refuses to delete the last admin', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/profiles/1', ...as(owner) });
    expect(res.statusCode).toBe(409);
  });

  it('rejects requests without a valid session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins', ...as(`${owner}x`) })).statusCode).toBe(401);
  });

  it('manages plugins: list, configure, test, disable', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/admin/plugins', ...as(owner) });
    expect(list.statusCode).toBe(200);
    expect(list.json().plugins).toMatchObject([{ id: 'echo', status: 'needs_config', missingSettings: ['token'] }]);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/admin/plugins/echo/settings',
      payload: { values: { region: 'FR' } },
      ...as(owner),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.join(' ')).toMatch(/region/);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/plugins/echo/settings',
      payload: { values: { token: 'good', region: 'GB' } },
      ...as(owner),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().plugin).toMatchObject({
      status: 'active',
      settings: { values: { token: SECRET_MASK, region: 'GB' }, sources: { token: 'saved', region: 'saved' } },
    });

    const test = await app.inject({ method: 'POST', url: '/api/admin/plugins/echo/test', ...as(owner) });
    expect(test.json()).toEqual({ result: { ok: true, message: 'token checked' } });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/admin/metadata/match',
      payload: { kind: 'movie', title: 'Alien', year: 1979 },
      ...as(owner),
    });
    expect(preview.json()).toMatchObject({ sources: ['echo'], metadata: { title: 'ALIEN', contentRating: 'GB' } });

    const disabled = await app.inject({ method: 'PATCH', url: '/api/admin/plugins/echo', payload: { enabled: false }, ...as(owner) });
    expect(disabled.json().plugin).toMatchObject({ status: 'disabled', enabled: false });

    const missing = await app.inject({ method: 'GET', url: '/api/admin/plugins/nope', ...as(owner) });
    expect(missing.statusCode).toBe(404);
  });

  it('creates libraries only for existing absolute folders', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: 'Movies', type: 'movies', paths: [path.join(root, 'does-not-exist'), 'relative/path'] },
      ...as(owner),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toHaveLength(2);

    const created = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: 'Movies', type: 'movies', paths: [mediaDir, `${mediaDir}${path.sep}`] },
      ...as(owner),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().library).toMatchObject({ name: 'Movies', type: 'movies', paths: [mediaDir], language: 'en-US', watch: true });

    const forKids = await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'X', type: 'movies', paths: [mediaDir] }, ...as(kid) });
    expect(forKids.statusCode).toBe(403);

    const list = await app.inject({ method: 'GET', url: '/api/libraries', ...as(kid) });
    expect(list.json().libraries).toHaveLength(1);
  });

  it('returns JSON 404s for unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });
});
