import type { PluginFfmpeg } from '@streamora/plugin-sdk';
import { ffprobe } from '../../lib/ffmpeg.js';
import { runProcess } from '../../lib/process.js';

export interface PluginFfmpegOptions {
  pluginId: string;
  allowed: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  /** Plugin lifetime signal: running processes are killed when the plugin unloads. */
  signal: AbortSignal;
}

export function createPluginFfmpeg(options: PluginFfmpegOptions): PluginFfmpeg {
  const assertAllowed = () => {
    if (!options.allowed) {
      throw new Error(`Plugin "${options.pluginId}" must declare "permissions.ffmpeg": true to run ffmpeg`);
    }
  };
  const combine = (signal?: AbortSignal) => (signal ? AbortSignal.any([options.signal, signal]) : options.signal);

  return {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,

    async run(args, opts = {}) {
      assertAllowed();
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new TypeError('ffmpeg arguments must be an array of strings');
      }
      const result = await runProcess(options.ffmpegPath, ['-hide_banner', '-nostdin', ...args], {
        timeoutMs: opts.timeoutMs ?? 10 * 60_000,
        maxOutputBytes: opts.maxOutputBytes ?? 64 * 1024 * 1024,
        signal: combine(opts.signal),
      });
      return { code: result.code, stdout: new Uint8Array(result.stdout), stderr: result.stderr };
    },

    async probe(file, opts = {}) {
      assertAllowed();
      return ffprobe(options.ffprobePath, file, { timeoutMs: opts.timeoutMs, signal: combine(opts.signal) });
    },
  };
}
