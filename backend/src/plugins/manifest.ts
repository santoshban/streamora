import path from 'node:path';
import { z } from 'zod';
import type { PluginCapability, PluginManifest } from '@streamora/plugin-sdk';

export const PLUGIN_API_VERSION = 1;
export const PLUGIN_CAPABILITIES = ['metadata', 'subtitles', 'stream_resolver', 'post_scan'] as const satisfies readonly PluginCapability[];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_PATTERN = /^(\*|\*\.[a-z0-9-]+(\.[a-z0-9-]+)*|[a-z0-9-]+(\.[a-z0-9-]+)*|setting:[A-Za-z][A-Za-z0-9_]*)$/i;

const isValidRegex = (value: string) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const httpUrl = z.string().refine(isHttpUrl, 'must be an http(s) URL');

const settingBase = {
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must start with a letter and contain only letters, digits and _'),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE environment variable name')
    .optional(),
};

const settingFieldSchema = z
  .discriminatedUnion('type', [
    z.object({
      ...settingBase,
      type: z.literal('string'),
      default: z.string().optional(),
      placeholder: z.string().optional(),
      pattern: z.string().refine(isValidRegex, 'is not a valid regular expression').optional(),
    }),
    z.object({ ...settingBase, type: z.literal('secret'), placeholder: z.string().optional() }),
    z.object({ ...settingBase, type: z.literal('url'), default: httpUrl.optional(), placeholder: z.string().optional() }),
    z.object({
      ...settingBase,
      type: z.literal('number'),
      default: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
    }),
    z.object({ ...settingBase, type: z.literal('boolean'), default: z.boolean().optional() }),
    z.object({
      ...settingBase,
      type: z.literal('select'),
      options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
      default: z.string().optional(),
    }),
    z.object({
      ...settingBase,
      type: z.literal('list'),
      default: z.array(z.string()).optional(),
      placeholder: z.string().optional(),
    }),
    z.object({ ...settingBase, type: z.literal('headers'), default: z.record(z.string(), z.string()).optional() }),
  ])
  .superRefine((field, ctx) => {
    if (field.type === 'select' && field.default !== undefined && !field.options.some((o) => o.value === field.default)) {
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'must be one of the option values' });
    }
    if (field.type === 'number' && field.default !== undefined) {
      if (field.min !== undefined && field.default < field.min) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: `must be >= ${field.min}` });
      }
      if (field.max !== undefined && field.default > field.max) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: `must be <= ${field.max}` });
      }
    }
  });

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'must be 2–64 chars of lowercase letters, digits and dashes'),
    name: z.string().min(1).max(80),
    version: z.string().regex(SEMVER, 'must be a semantic version such as 1.0.0'),
    description: z.string().max(500).optional(),
    author: z.string().optional(),
    homepage: httpUrl.optional(),
    license: z.string().optional(),
    apiVersion: z.literal(PLUGIN_API_VERSION, {
      error: `unsupported apiVersion; this server implements apiVersion ${PLUGIN_API_VERSION}`,
    }),
    main: z
      .string()
      .default('index.ts')
      .refine(
        (p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'),
        'must be a relative path inside the plugin folder',
      )
      .refine((p) => /\.(m?[jt]s|[jt]sx)$/.test(p), 'must point to a .ts, .mts, .js or .mjs file'),
    capabilities: z
      .array(z.enum(PLUGIN_CAPABILITIES))
      .min(1, 'declare at least one capability')
      .refine((caps) => new Set(caps).size === caps.length, 'must not contain duplicates'),
    priority: z.number().int().min(0).max(1000).default(100),
    enabledByDefault: z.boolean().default(true),
    permissions: z
      .object({
        network: z.array(z.string().regex(HOST_PATTERN, 'must be a host name, *.domain, * or setting:<key>')).default([]),
        filesystem: z.enum(['none', 'library-read']).default('none'),
        ffmpeg: z.boolean().default(false),
      })
      .prefault({}),
    rateLimit: z
      .object({
        requests: z.number().int().min(1).max(1000),
        intervalMs: z.number().int().min(100).max(3_600_000),
      })
      .optional(),
    settings: z.array(settingFieldSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.settings.forEach((field, i) => {
      if (seen.has(field.key)) {
        ctx.addIssue({ code: 'custom', path: ['settings', i, 'key'], message: `duplicate setting key "${field.key}"` });
      }
      seen.add(field.key);
    });
    manifest.permissions.network.forEach((entry, i) => {
      if (!entry.startsWith('setting:')) return;
      const key = entry.slice('setting:'.length);
      const field = manifest.settings.find((f) => f.key === key);
      if (!field || field.type !== 'url') {
        ctx.addIssue({
          code: 'custom',
          path: ['permissions', 'network', i],
          message: `"${entry}" must reference a setting of type "url"`,
        });
      }
    });
  });

/** Manifest with defaults applied. */
export type NormalizedManifest = z.output<typeof manifestSchema>;
export type NormalizedSettingField = NormalizedManifest['settings'][number];

// Compile-time guard: the validator's output must satisfy the public SDK type.
const _manifestMatchesSdk = (m: NormalizedManifest): PluginManifest => m;
void _manifestMatchesSdk;

export type ManifestValidation =
  | { ok: true; manifest: NormalizedManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const KNOWN_KEYS = new Set(Object.keys(manifestSchema.shape));

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

export function validateManifest(raw: unknown): ManifestValidation {
  const warnings: string[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(key)) warnings.push(`unknown manifest property "${key}" was ignored`);
    }
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error), warnings };
  return { ok: true, manifest: parsed.data, warnings };
}
