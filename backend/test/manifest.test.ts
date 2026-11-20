import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/plugins/manifest.js';
import { PLUGINS_DIR } from './helpers/harness.js';

const base = {
  id: 'example-plugin',
  name: 'Example',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: ['metadata'],
};

describe('validateManifest', () => {
  it('applies defaults to a minimal manifest', () => {
    const result = validateManifest(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      main: 'index.ts',
      priority: 100,
      enabledByDefault: true,
      permissions: { network: [], filesystem: 'none', ffmpeg: false },
      settings: [],
    });
  });

  it.each([
    [{ id: 'Bad Id' }, 'id'],
    [{ version: 'v1' }, 'version'],
    [{ apiVersion: 2 }, 'apiVersion'],
    [{ capabilities: [] }, 'capabilities'],
    [{ capabilities: ['metadata', 'transcoder'] }, 'capabilities.1'],
    [{ capabilities: ['metadata', 'metadata'] }, 'capabilities'],
    [{ main: '../escape.ts' }, 'main'],
    [{ main: 'index.py' }, 'main'],
    [{ permissions: { network: ['https://api.example.com/path'] } }, 'permissions.network.0'],
  ])('rejects %j', (override, expectedPath) => {
    const result = validateManifest({ ...base, ...override });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.startsWith(`${expectedPath}:`))).toBe(true);
  });

  it('validates the settings schema', () => {
    const result = validateManifest({
      ...base,
      settings: [
        { key: 'apiKey', type: 'secret', label: 'Key' },
        { key: 'apiKey', type: 'string', label: 'Dup' },
        { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'b' },
        { key: 'count', type: 'number', label: 'Count', min: 1, max: 5, default: 9 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate setting key "apiKey"'),
        expect.stringMatching(/^settings\.2\.default: must be one of the option values/),
        expect.stringMatching(/^settings\.3\.default: must be <= 5/),
      ]),
    );
  });

  it('requires setting: network entries to point at url settings', () => {
    const bad = validateManifest({
      ...base,
      permissions: { network: ['setting:server'] },
      settings: [{ key: 'server', type: 'string', label: 'Server' }],
    });
    expect(bad.ok).toBe(false);

    const good = validateManifest({
      ...base,
      permissions: { network: ['setting:server', '*.example.com'] },
      settings: [{ key: 'server', type: 'url', label: 'Server', default: 'https://media.example.com' }],
    });
    expect(good.ok).toBe(true);
  });

  it('warns about unknown properties instead of failing', () => {
    const result = validateManifest({ ...base, capabilites: ['metadata'] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['unknown manifest property "capabilites" was ignored']);
  });

  it('accepts every built-in plugin manifest', () => {
    const folders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_'));
    expect(folders.length).toBeGreaterThanOrEqual(3);
    for (const folder of folders) {
      const raw = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, folder.name, 'manifest.json'), 'utf8'));
      const result = validateManifest(raw);
      expect(result, folder.name).toMatchObject({ ok: true, warnings: [] });
    }
  });
});
