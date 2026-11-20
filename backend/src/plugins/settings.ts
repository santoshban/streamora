import { z } from 'zod';
import type { SettingValue } from '@streamora/plugin-sdk';
import type { NormalizedSettingField } from './manifest.js';

/** Returned in place of secret values; sending it back means "unchanged". */
export const SECRET_MASK = '••••••••';

export type SettingSource = 'saved' | 'env' | 'default' | 'unset';

export interface ResolvedSettings {
  values: Record<string, SettingValue | undefined>;
  sources: Record<string, SettingSource>;
  /** Keys of required settings that have no value. */
  missingRequired: string[];
}

export function isEmptySetting(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * "No value given" — falls through to the env seed / default. Unlike
 * {@link isEmptySetting}, an explicitly saved empty list or header map is a
 * real value (e.g. "no preferred languages" ≠ "use the default languages").
 */
export function isUnsetSetting(value: unknown): value is undefined | null | '' {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Converts an environment-variable string into the field's value type. */
export function coerceEnvValue(field: NormalizedSettingField, raw: string): SettingValue | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    case 'list':
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    case 'headers': {
      // JSON object, or "Header-A=value; Header-B=value"
      if (value.startsWith('{')) {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
          }
        } catch {
          return undefined;
        }
      }
      return Object.fromEntries(
        value
          .split(';')
          .map((pair) => pair.split('='))
          .filter((parts): parts is [string, string] => parts.length >= 2 && parts[0]!.trim() !== '')
          .map(([k, ...rest]) => [k.trim(), rest.join('=').trim()]),
      );
    }
    case 'select':
      return field.options.some((o) => o.value === value) ? value : undefined;
    default:
      return value;
  }
}

/** saved value → environment seed → manifest default. */
export function resolveSettings(
  fields: NormalizedSettingField[],
  saved: Record<string, SettingValue | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSettings {
  const values: ResolvedSettings['values'] = {};
  const sources: ResolvedSettings['sources'] = {};
  const missingRequired: string[] = [];

  for (const field of fields) {
    let value: SettingValue | undefined;
    let source: SettingSource = 'unset';

    const savedValue = saved[field.key];
    const envRaw = field.env ? env[field.env] : undefined;
    const envValue = envRaw !== undefined ? coerceEnvValue(field, envRaw) : undefined;
    const defaultValue = 'default' in field ? (field.default as SettingValue | undefined) : undefined;

    if (!isUnsetSetting(savedValue)) {
      value = savedValue;
      source = 'saved';
    } else if (!isUnsetSetting(envValue)) {
      value = envValue;
      source = 'env';
    } else if (defaultValue !== undefined) {
      value = defaultValue;
      source = 'default';
    }

    values[field.key] = value;
    sources[field.key] = source;
    if (field.required && isEmptySetting(value)) missingRequired.push(field.key);
  }

  return { values, sources, missingRequired };
}

function fieldValueSchema(field: NormalizedSettingField): z.ZodType<SettingValue> {
  switch (field.type) {
    case 'string': {
      let s = z.string().max(10_000);
      if (field.pattern) {
        const re = new RegExp(field.pattern);
        s = s.refine((v) => v === '' || re.test(v), `must match ${field.pattern}`) as unknown as typeof s;
      }
      return s;
    }
    case 'secret':
      return z.string().max(10_000);
    case 'url':
      return z.string().refine((v) => {
        if (v === '') return true;
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'must be an http(s) URL');
    case 'number': {
      let n = z.number().finite();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum(field.options.map((o) => o.value) as [string, ...string[]]);
    case 'list':
      return z.array(z.string().max(1000)).max(500);
    case 'headers':
      return z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'invalid header name'), z.string().max(8192));
  }
}

/**
 * Validates a partial settings update. `null` resets a key to its env/default
 * value; for secrets, {@link SECRET_MASK} keeps the stored value.
 */
export function parseSettingsUpdate(
  fields: NormalizedSettingField[],
  update: unknown,
): { ok: true; values: Record<string, SettingValue | null> } | { ok: false; errors: string[] } {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) shape[field.key] = fieldValueSchema(field).nullable().optional();
  const parsed = z.strictObject(shape).safeParse(update);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, values: parsed.data as Record<string, SettingValue | null> };
}

/** Applies a validated update to the saved settings, returning a new object. */
export function applySettingsUpdate(
  fields: NormalizedSettingField[],
  saved: Record<string, SettingValue>,
  update: Record<string, SettingValue | null | undefined>,
): Record<string, SettingValue> {
  const known = new Set(fields.map((f) => f.key));
  const next: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(saved)) if (known.has(key)) next[key] = value;

  for (const field of fields) {
    if (!(field.key in update)) continue;
    const value = update[field.key];
    if (value === undefined) continue;
    if (field.type === 'secret' && value === SECRET_MASK) continue;
    if (isUnsetSetting(value)) delete next[field.key];
    else next[field.key] = value;
  }
  return next;
}

/** Values safe to send to the browser: secrets become {@link SECRET_MASK}. */
export function maskSettings(
  fields: NormalizedSettingField[],
  values: Record<string, SettingValue | undefined>,
): Record<string, SettingValue | null> {
  const out: Record<string, SettingValue | null> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === 'secret') out[field.key] = isEmptySetting(value) ? null : SECRET_MASK;
    else out[field.key] = value ?? null;
  }
  return out;
}
