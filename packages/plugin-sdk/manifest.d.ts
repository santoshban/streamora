/** Contract version implemented by this SDK. Manifests must declare `"apiVersion": 1`. */
export type PluginApiVersion = 1;

/** What a plugin can contribute. Each capability maps to a property on {@link PluginInstance}. */
export type PluginCapability = 'metadata' | 'subtitles' | 'stream_resolver' | 'post_scan';

// ── Settings schema ──────────────────────────────────────────────────────────

interface SettingFieldBase {
  /** Key under which the value appears in `ctx.settings`. `[A-Za-z][A-Za-z0-9_]*` */
  key: string;
  label: string;
  description?: string;
  /** When true the plugin stays in `needs_config` state until a value is provided. */
  required?: boolean;
  /**
   * Name of an environment variable whose value seeds this setting when the
   * admin has not saved one (e.g. `"TMDB_API_KEY"`).
   */
  env?: string;
}

export interface StringSettingField extends SettingFieldBase {
  type: 'string';
  default?: string;
  placeholder?: string;
  /** Optional regular expression the value must match. */
  pattern?: string;
}

/** Like `string`, but never returned to the browser in plain text. */
export interface SecretSettingField extends SettingFieldBase {
  type: 'secret';
  placeholder?: string;
}

export interface UrlSettingField extends SettingFieldBase {
  type: 'url';
  default?: string;
  placeholder?: string;
}

export interface NumberSettingField extends SettingFieldBase {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface BooleanSettingField extends SettingFieldBase {
  type: 'boolean';
  default?: boolean;
}

export interface SelectSettingField extends SettingFieldBase {
  type: 'select';
  options: Array<{ value: string; label: string }>;
  default?: string;
}

/** An ordered list of strings (e.g. preferred languages). */
export interface ListSettingField extends SettingFieldBase {
  type: 'list';
  default?: string[];
  placeholder?: string;
}

/** Free-form header map, e.g. custom HTTP headers sent to a self-hosted service. */
export interface HeadersSettingField extends SettingFieldBase {
  type: 'headers';
  default?: Record<string, string>;
}

export type SettingField =
  | StringSettingField
  | SecretSettingField
  | UrlSettingField
  | NumberSettingField
  | BooleanSettingField
  | SelectSettingField
  | ListSettingField
  | HeadersSettingField;

export type SettingFieldType = SettingField['type'];

export type SettingValue = string | number | boolean | string[] | Record<string, string>;

/** Resolved settings handed to the plugin (saved value → env seed → manifest default). */
export type PluginSettings = Readonly<Record<string, SettingValue | undefined>>;

// ── Permissions ──────────────────────────────────────────────────────────────

export interface PluginPermissions {
  /**
   * Hosts the plugin may contact through `ctx.http`.
   * - `"api.example.com"` exact host
   * - `"*.example.com"` any subdomain (and the apex)
   * - `"setting:<key>"` the host of the URL stored in a `url` setting
   * - `"*"` any host (discouraged)
   */
  network?: string[];
  /** `library-read` grants read-only `ctx.fs` access to configured library folders. */
  filesystem?: 'none' | 'library-read';
  /** Grants `ctx.ffmpeg.run()` / `ctx.ffmpeg.probe()`. */
  ffmpeg?: boolean;
}

export interface PluginRateLimit {
  /** Maximum requests started within any `intervalMs` window. */
  requests: number;
  intervalMs: number;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/** Shape of `plugins/<plugin>/manifest.json`. */
export interface PluginManifest {
  $schema?: string;
  /** Unique, URL-safe id: `[a-z0-9][a-z0-9-]*` */
  id: string;
  name: string;
  /** Semantic version, e.g. `1.2.0` */
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  apiVersion: PluginApiVersion;
  /** Entry module relative to the plugin folder. Defaults to `index.ts`. TS and JS are both supported. */
  main?: string;
  capabilities: PluginCapability[];
  /** Lower runs first. Metadata from a lower-priority-number plugin wins field conflicts. Default 100. */
  priority?: number;
  /** Whether the plugin starts enabled the first time it is discovered. Default true. */
  enabledByDefault?: boolean;
  permissions?: PluginPermissions;
  /** Throttle applied to `ctx.http`. Default: 10 requests / 1000 ms. */
  rateLimit?: PluginRateLimit;
  settings?: SettingField[];
}
