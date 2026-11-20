import type { FfprobeResult } from '@streamora/plugin-sdk';
import { ProcessError, runProcess } from './process.js';

export interface FfmpegAvailability {
  ffmpeg: string | null;
  ffprobe: string | null;
}

async function versionOf(binary: string): Promise<string | null> {
  try {
    const { code, stdout } = await runProcess(binary, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    if (code !== 0) return null;
    const firstLine = stdout.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    return firstLine.match(/version\s+(\S+)/)?.[1] ?? firstLine.trim();
  } catch {
    return null;
  }
}

/** Detects ffmpeg/ffprobe versions; `null` means the binary could not be run. */
export async function detectFfmpeg(paths: { ffmpegPath: string; ffprobePath: string }): Promise<FfmpegAvailability> {
  const [ffmpeg, ffprobe] = await Promise.all([versionOf(paths.ffmpegPath), versionOf(paths.ffprobePath)]);
  return { ffmpeg, ffprobe };
}

export async function ffprobe(
  ffprobePath: string,
  file: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FfprobeResult> {
  const result = await runProcess(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
    { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal, maxOutputBytes: 16 * 1024 * 1024 },
  );
  if (result.code !== 0) {
    throw new ProcessError(`ffprobe failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`, result);
  }
  return JSON.parse(result.stdout.toString('utf8')) as FfprobeResult;
}
