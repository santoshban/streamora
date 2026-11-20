import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type { PluginFactory } from '@streamora/plugin-sdk';
import { isPathInside } from '../lib/paths.js';
import { validateManifest, type NormalizedManifest } from './manifest.js';

export interface DiscoveredPlugin {
  /** Folder name inside the plugins directory (unique on disk). */
  folder: string;
  dir: string;
  manifest?: NormalizedManifest;
  errors: string[];
  warnings: string[];
}

/** Folders starting with `_` or `.` (e.g. `_template-plugin`) are never loaded. */
export function isIgnoredPluginFolder(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.') || name === 'node_modules';
}

export async function readPluginFolder(dir: string): Promise<DiscoveredPlugin> {
  const folder = path.basename(dir);
  const result: DiscoveredPlugin = { folder, dir, errors: [], warnings: [] };
  const manifestPath = path.join(dir, 'manifest.json');

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    result.errors.push('manifest.json not found');
    return result;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    result.errors.push(`manifest.json is not valid JSON: ${(err as Error).message}`);
    return result;
  }

  const validation = validateManifest(json);
  result.warnings.push(...validation.warnings);
  if (!validation.ok) {
    result.errors.push(...validation.errors);
    return result;
  }

  const entry = path.resolve(dir, validation.manifest.main);
  if (!isPathInside(entry, dir)) {
    result.errors.push(`main: "${validation.manifest.main}" resolves outside the plugin folder`);
    return result;
  }
  try {
    await fs.access(entry);
  } catch {
    result.errors.push(`main: entry file "${validation.manifest.main}" does not exist`);
    return result;
  }

  result.manifest = validation.manifest;
  return result;
}

/** Scans the plugins directory. Duplicate ids are reported as errors on the later folder. */
export async function discoverPlugins(pluginsDir: string): Promise<DiscoveredPlugin[]> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const folders = dirents
    .filter((d) => d.isDirectory() && !isIgnoredPluginFolder(d.name))
    .map((d) => d.name)
    .sort();

  const found = await Promise.all(folders.map((name) => readPluginFolder(path.join(pluginsDir, name))));

  const owners = new Map<string, string>();
  for (const plugin of found) {
    if (!plugin.manifest) continue;
    const owner = owners.get(plugin.manifest.id);
    if (owner) {
      plugin.errors.push(`duplicate plugin id "${plugin.manifest.id}" (already used by folder "${owner}")`);
      delete plugin.manifest;
    } else {
      owners.set(plugin.manifest.id, plugin.folder);
    }
  }
  return found;
}

export interface PluginBundle {
  file: string;
  hash: string;
}

// Lets CommonJS dependencies that call `require()` work inside the ESM bundle.
const REQUIRE_SHIM =
  "import { createRequire as __streamoraCreateRequire } from 'node:module';\n" +
  'const require = __streamoraCreateRequire(import.meta.url);';

/**
 * Bundles a plugin (TypeScript or JavaScript, plus its npm dependencies) into a
 * single content-addressed ESM file. A new hash means a new module URL, which
 * is what makes hot reloading possible despite Node's ESM module cache.
 */
export async function bundlePlugin(
  plugin: { dir: string; manifest: NormalizedManifest },
  outDir: string,
): Promise<PluginBundle> {
  const entry = path.resolve(plugin.dir, plugin.manifest.main);
  let result: esbuild.BuildResult<{ write: false }>;
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: plugin.dir,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      write: false,
      sourcemap: 'inline',
      logLevel: 'silent',
      banner: { js: REQUIRE_SHIM },
      // Type-only package; nothing to bundle at runtime.
      external: ['@streamora/plugin-sdk'],
    });
  } catch (err) {
    const failure = err as esbuild.BuildFailure;
    if (Array.isArray(failure.errors) && failure.errors.length) {
      const formatted = await esbuild.formatMessages(failure.errors, { kind: 'error', color: false });
      throw new Error(`Failed to compile plugin "${plugin.manifest.id}":\n${formatted.join('\n').trim()}`);
    }
    throw err;
  }

  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for plugin "${plugin.manifest.id}"`);

  const hash = crypto.createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${plugin.manifest.id}.${hash}.mjs`);
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, output.contents);
  }
  return { file, hash };
}

/**
 * Empties the bundle cache. Only call this before any bundle has been
 * imported (server start): bundles are immutable while the process runs, so
 * file watchers such as `tsx watch` never see an imported module change or
 * disappear and restart the whole server mid hot-reload.
 */
export async function resetBundleCache(outDir: string): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
}

/**
 * Imports a bundle. `generation` makes the module URL unique per activation,
 * so module-level state never leaks from a previous instance even when the
 * code (and therefore the file) is unchanged, e.g. after a settings change.
 */
export async function importPluginFactory(bundle: PluginBundle, generation: number): Promise<PluginFactory> {
  const url = `${pathToFileURL(bundle.file).href}?v=${generation}`;
  const mod = (await import(url)) as { default?: unknown };
  const factory = mod.default;
  if (typeof factory !== 'function') {
    throw new Error('The entry module must `export default` a factory function: (ctx) => PluginInstance');
  }
  return factory as PluginFactory;
}
