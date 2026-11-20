import { describe, expect, it } from 'vitest';
import type { SettingValue } from '@streamora/plugin-sdk';
import { validateManifest, type NormalizedSettingField } from '../src/plugins/manifest.js';
import {
  applySettingsUpdate,
  maskSettings,
  parseSettingsUpdate,
  resolveSettings,
  SECRET_MASK,
} from '../src/plugins/settings.js';

function fields(settings: unknown[]): NormalizedSettingField[] {
  const result = validateManifest({
    id: 'settings-test',
    name: 'Settings',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['metadata'],
    settings,
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest.settings;
}

const schema = fields([
  { key: 'apiKey', type: 'secret', label: 'Key', required: true, env: 'TEST_API_KEY' },
  { key: 'baseUrl', type: 'url', label: 'URL', default: 'https://api.example.com' },
  { key: 'limit', type: 'number', label: 'Limit', min: 1, max: 50, default: 10, env: 'TEST_LIMIT' },
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
  { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }] },
  { key: 'langs', type: 'list', label: 'Languages', env: 'TEST_LANGS' },
  { key: 'headers', type: 'headers', label: 'Headers', env: 'TEST_HEADERS' },
]);

describe('resolveSettings', () => {
  it('prefers saved values, then env seeds, then defaults', () => {
    const resolved = resolveSettings(
      schema,
      { limit: 25 },
      { TEST_API_KEY: 'from-env', TEST_LIMIT: '40', TEST_LANGS: 'en, fr ,de', TEST_HEADERS: 'X-A=1; X-B=two=2' },
    );
    expect(resolved.values).toEqual({
      apiKey: 'from-env',
      baseUrl: 'https://api.example.com',
      limit: 25,
      enabled: true,
      mode: undefined,
      langs: ['en', 'fr', 'de'],
      headers: { 'X-A': '1', 'X-B': 'two=2' },
    });
    expect(resolved.sources).toMatchObject({ apiKey: 'env', limit: 'saved', baseUrl: 'default', mode: 'unset' });
    expect(resolved.missingRequired).toEqual([]);
  });

  it('treats an explicitly saved empty list as a value, not as "unset"', () => {
    const listSchema = fields([{ key: 'langs', type: 'list', label: 'Languages', default: ['eng'] }]);
    expect(resolveSettings(listSchema, {}, {}).values.langs).toEqual(['eng']);
    expect(resolveSettings(listSchema, { langs: [] }, {})).toMatchObject({ values: { langs: [] }, sources: { langs: 'saved' } });

    const parsed = parseSettingsUpdate(listSchema, { langs: [] });
    expect(parsed.ok && applySettingsUpdate(listSchema, {}, parsed.values)).toEqual({ langs: [] });
    const reset = parseSettingsUpdate(listSchema, { langs: null });
    expect(reset.ok && applySettingsUpdate(listSchema, { langs: [] }, reset.values)).toEqual({});
  });

  it('reports missing required settings', () => {
    expect(resolveSettings(schema, {}, {}).missingRequired).toEqual(['apiKey']);
    expect(resolveSettings(schema, { apiKey: '   ' }, {}).missingRequired).toEqual(['apiKey']);
  });
});

describe('settings updates', () => {
  it('validates types, ranges, options and unknown keys', () => {
    const result = parseSettingsUpdate(schema, {
      limit: 99,
      mode: 'turbo',
      baseUrl: 'ftp://nope',
      enabled: 'yes',
      bogus: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toMatch(/limit/);
    expect(result.errors.join('\n')).toMatch(/mode/);
    expect(result.errors.join('\n')).toMatch(/baseUrl: must be an http\(s\) URL/);
    expect(result.errors.join('\n')).toMatch(/enabled/);
    expect(result.errors.join('\n')).toMatch(/bogus/);
  });

  it('keeps a stored secret when the mask is sent back and resets keys set to null', () => {
    const saved: Record<string, SettingValue> = { apiKey: 'secret-1', limit: 20, stale: 'x' };
    const parsed = parseSettingsUpdate(schema, { apiKey: SECRET_MASK, limit: null, mode: 'slow' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applySettingsUpdate(schema, saved, parsed.values)).toEqual({ apiKey: 'secret-1', mode: 'slow' });
  });

  it('never exposes secret values', () => {
    const masked = maskSettings(schema, { apiKey: 'secret-1', limit: 5 });
    expect(masked.apiKey).toBe(SECRET_MASK);
    expect(masked.limit).toBe(5);
    expect(maskSettings(schema, {}).apiKey).toBeNull();
  });
});
