// Assembles a self-contained server in build/server. It mirrors the repository
// layout (backend/, frontend/dist, plugins/, node_modules/), because the backend
// finds its migrations, web UI and package.json relative to its own files.
//
// Nothing outside desktop/ is written, so a running `npm run dev` is not disturbed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const out = path.join(desktop, 'build', 'server');
const repoRequire = createRequire(path.join(repo, 'package.json'));

const step = (text) => console.log(`\n── ${text}`);
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
/** Runs a package's command line tool with this Node, without a shell. */
const runBin = (pkg, args, cwd, resolver = repoRequire) => {
  const manifestFile = findManifest(pkg, resolver);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin[pkg] ?? manifest.bin.tsc);
  execFileSync(process.execPath, [path.join(path.dirname(manifestFile), bin), ...args], { cwd, stdio: 'inherit' });
};
/** Finds a package's manifest even when its `exports` hide it. */
function findManifest(pkg, resolver) {
  for (const dir of resolver.resolve.paths(pkg) ?? []) {
    const file = path.join(dir, pkg, 'package.json');
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`"${pkg}" is not installed. Run npm install in the repository root first.`);
}

step('Cleaning build/server');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

step('Installing the backend dependencies from package-lock.json');
// npm needs every workspace manifest to accept the lockfile.
const rootManifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const workspaces = rootManifest.workspaces.flatMap((glob) =>
  glob.endsWith('/*')
    ? fs.readdirSync(path.join(repo, glob.slice(0, -2))).map((name) => path.join(glob.slice(0, -2), name))
    : [glob],
);
for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, file), path.join(out, file));
for (const dir of workspaces) {
  const manifest = path.join(repo, dir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  fs.mkdirSync(path.join(out, dir), { recursive: true });
  fs.copyFileSync(manifest, path.join(out, dir, 'package.json'));
}
// npm 9 crashes on workspace installs, so always use npm 11. Install scripts are
// not needed: esbuild's binary is its own package and better-sqlite3 is replaced below.
// The command is a fixed string, so running it through a shell (npx is a .cmd) is safe.
execFileSync(
  'npx --yes npm@11 ci --omit=dev --workspace=@streamora/backend --ignore-scripts --no-audit --no-fund',
  { cwd: out, stdio: 'inherit', shell: true },
);

step('Swapping in better-sqlite3 for Electron');
// The server pins a version with Node 20 binaries. Electron needs better-sqlite3 13+,
// whose Node-API binary does not depend on the Node/Electron version.
const sqliteFrom = path.join(desktop, 'node_modules', 'better-sqlite3');
const sqliteTo = path.join(out, 'node_modules', 'better-sqlite3');
fs.rmSync(sqliteTo, { recursive: true, force: true });
copy(path.join(sqliteFrom, 'lib'), path.join(sqliteTo, 'lib'));
for (const file of ['package.json', 'LICENSE', path.join('prebuilds', 'win32-x64.node')]) {
  fs.mkdirSync(path.dirname(path.join(sqliteTo, file)), { recursive: true });
  fs.copyFileSync(path.join(sqliteFrom, file), path.join(sqliteTo, file));
}

step('Removing files the server does not need');
// Links to the workspaces, and the manifests that were only there for npm.
fs.rmSync(path.join(out, 'node_modules', '@streamora'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'node_modules', '@streamora-plugin'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'node_modules', '.bin'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'package-lock.json'));
for (const dir of ['packages', 'plugins', 'frontend']) fs.rmSync(path.join(out, dir), { recursive: true, force: true });
// Keeps backend/node_modules, where npm puts versions that differ from the hoisted ones (esbuild).
fs.rmSync(path.join(out, 'backend', 'package.json'));
fs.rmSync(path.join(out, 'backend', 'node_modules', '.bin'), { recursive: true, force: true });
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({ name: 'streamora-server', private: true, type: 'module' }, null, 2)}\n`);
let pruned = 0;
(function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) prune(file);
    else if (/\.(map|d\.ts|d\.cts|d\.mts)$/.test(entry.name)) {
      fs.rmSync(file);
      pruned += 1;
    }
  }
})(out);
console.log(`${pruned} source maps and type declarations removed`);

step('Compiling the backend');
const backend = path.join(out, 'backend');
runBin('typescript', ['-p', 'tsconfig.build.json', '--outDir', path.join(backend, 'dist'), '--sourceMap', 'false'], path.join(repo, 'backend'));
copy(path.join(repo, 'backend', 'drizzle'), path.join(backend, 'drizzle'));
fs.copyFileSync(path.join(repo, 'backend', 'package.json'), path.join(backend, 'package.json'));

step('Building the web UI');
const frontendRequire = createRequire(path.join(repo, 'frontend', 'package.json'));
runBin(
  'vite',
  ['build', '--outDir', path.join(out, 'frontend', 'dist'), '--emptyOutDir', '--sourcemap', 'false', '--logLevel', 'warn'],
  path.join(repo, 'frontend'),
  frontendRequire,
);

step('Bundling the plugins');
// Each becomes one JavaScript file, so it also works after being copied to the
// user's plugins folder, where it has no node_modules.
const esbuild = await import(`file://${createRequire(path.join(repo, 'backend', 'package.json')).resolve('esbuild').replaceAll('\\', '/')}`).then((m) => m.default ?? m);
const digest = crypto.createHash('sha256');
for (const name of fs.readdirSync(path.join(repo, 'plugins')).sort()) {
  const dir = path.join(repo, 'plugins', name);
  const manifestFile = path.join(dir, 'manifest.json');
  if (name.startsWith('_') || name.startsWith('.') || !fs.existsSync(manifestFile)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const result = await esbuild.build({
    entryPoints: [path.join(dir, manifest.main)],
    absWorkingDir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['@streamora/plugin-sdk'],
    outfile: path.join(out, 'plugins', name, 'index.js'),
    metafile: true,
    write: true,
  });
  const json = `${JSON.stringify({ ...manifest, main: 'index.js' }, null, 2)}\n`;
  fs.writeFileSync(path.join(out, 'plugins', name, 'manifest.json'), json);
  digest.update(name).update(json).update(fs.readFileSync(path.join(out, 'plugins', name, 'index.js')));
  console.log(`${manifest.id} (${Object.keys(result.metafile.inputs).length} files)`);
}
fs.writeFileSync(path.join(out, 'plugins', '.bundle-id'), digest.digest('hex').slice(0, 16));

step('Adding the desktop entry points');
for (const file of fs.readdirSync(path.join(desktop, 'server'))) {
  fs.copyFileSync(path.join(desktop, 'server', file), path.join(out, file));
}

step('Checking that every import resolves inside build/server');
// Node would otherwise find missing packages in the repository's own node_modules,
// and only an installed copy would fail.
const graph = await esbuild.build({
  entryPoints: fs.readdirSync(path.join(desktop, 'server')).map((file) => path.join(out, file)),
  absWorkingDir: out,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outdir: path.join(out, '.unused'),
  write: false,
  metafile: true,
});
const missing = new Set();
let checked = 0;
for (const [input, { imports }] of Object.entries(graph.metafile.inputs)) {
  for (const { path: specifier, external } of imports) {
    if (!external || isBuiltin(specifier)) continue;
    checked += 1;
    const pkg = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    const staged = createRequire(path.join(out, input))
      .resolve.paths(pkg)
      .filter((p) => p.startsWith(out + path.sep));
    if (!staged.some((p) => fs.existsSync(path.join(p, pkg, 'package.json')))) missing.add(`${pkg} (${input})`);
  }
}
const platformPackages = ['backend/node_modules', 'node_modules'].map((p) => path.join(out, p, '@esbuild', 'win32-x64', 'esbuild.exe'));
if (!platformPackages.some((file) => fs.existsSync(file))) missing.add('@esbuild/win32-x64');
if (checked === 0 || missing.size) throw new Error(`Not staged: ${[...missing].join(', ') || 'no imports found'}`);
console.log(`${checked} imports are fine`);

console.log('\nServer staged in build/server');
