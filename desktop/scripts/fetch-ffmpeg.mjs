// Downloads the pinned FFmpeg build that ships inside the desktop app and
// unpacks ffmpeg, ffprobe and their DLLs into build/ffmpeg.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(desktop, '.cache');
const outDir = path.join(desktop, 'build', 'ffmpeg');

// Shared (DLL) build: ffmpeg and ffprobe share their libraries, so it is about
// half the size of two static executables. GPL, because transcodes fall back to x264.
// BtbN keeps month-end builds for two years, so this link stays valid for a while.
const BUILD = {
  name: 'ffmpeg-n9.0.2-39-g7adfbe40dc-win64-gpl-shared-9.0',
  tag: 'autobuild-2026-10-31-12-59',
  commit: '7adfbe40dc',
  sha256: '1d9823c35c7a7e2f54d1438cf61030d6efabe3278de01c191309d1e828bb74df',
};
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BUILD.tag}/${BUILD.name}.zip`;
const stamp = path.join(outDir, '.build');

if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === BUILD.sha256) {
  console.log(`FFmpeg: ${BUILD.name} already unpacked`);
  process.exit(0);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const zip = path.join(cacheDir, `${BUILD.name}.zip`);
fs.mkdirSync(cacheDir, { recursive: true });

if (!fs.existsSync(zip) || sha256(zip) !== BUILD.sha256) {
  console.log(`FFmpeg: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FFmpeg download failed: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const actual = sha256(zip);
  if (actual !== BUILD.sha256) {
    fs.rmSync(zip);
    throw new Error(`FFmpeg download has checksum ${actual}, expected ${BUILD.sha256}`);
  }
}

// Windows ships bsdtar, which reads zip files. Use it by full path: a GNU tar
// earlier on the PATH (Git Bash) cannot.
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const unpackDir = path.join(cacheDir, 'ffmpeg');
fs.rmSync(unpackDir, { recursive: true, force: true });
fs.mkdirSync(unpackDir, { recursive: true });
execFileSync(tar, ['-xf', zip, '-C', unpackDir], { stdio: 'inherit' });

const root = path.join(unpackDir, BUILD.name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'bin'))) {
  if (file !== 'ffplay.exe') fs.copyFileSync(path.join(root, 'bin', file), path.join(outDir, file));
}
fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(outDir, 'LICENSE.txt'));
fs.writeFileSync(
  path.join(outDir, 'README.txt'),
  [
    'Streamora runs FFmpeg (https://ffmpeg.org) as a separate program. The files in this',
    'folder are an unmodified build and are licensed under the GNU GPL (see LICENSE.txt).',
    '',
    `Build:         ${BUILD.name}`,
    `Downloaded:    ${url}`,
    `FFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/${BUILD.commit}`,
    `Build scripts: https://github.com/BtbN/FFmpeg-Builds/tree/${BUILD.tag}`,
    '',
  ].join('\r\n'),
);
fs.rmSync(unpackDir, { recursive: true, force: true });
fs.writeFileSync(stamp, BUILD.sha256);
console.log(`FFmpeg: ${BUILD.name} ready`);
