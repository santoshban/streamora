import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { REPO_ROOT, resolveFromRoot } from './lib/paths.js';

// Load `<repo>/.env` without a dotenv dependency. Variables already present in
// the real environment always win over the file.
const envFile = path.join(REPO_ROOT, '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envFile)) {
  const before = { ...process.env };
  process.loadEnvFile(envFile);
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8484),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: optionalString,
  SESSION_SECRET: optionalString,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PLUGINS_DIR: z.string().default('./plugins'),
  PLUGINS_HOT_RELOAD: bool.default(true),
  PLUGIN_CALL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  TRANSCODE_DIR: optionalString,
  HW_ACCEL: z.enum(['auto', 'none', 'nvenc', 'videotoolbox', 'vaapi', 'qsv']).default('auto'),
  VAAPI_DEVICE: z.string().default('/dev/dri/renderD128'),
  MAX_TRANSCODE_SESSIONS: z.coerce.number().int().min(1).default(3),
  SCAN_ON_STARTUP: bool.default(true),
  SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(360),
  SCAN_WATCH_POLLING: bool.default(false),
  SCAN_PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isDev: boolean;
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  dataDir: string;
  databasePath: string;
  cacheDir: string;
  sessionSecret?: string;
  sessionTtlDays: number;
  corsOrigins: string[];
  plugins: {
    dir: string;
    hotReload: boolean;
    callTimeoutMs: number;
  };
  media: {
    ffmpegPath: string;
    ffprobePath: string;
    transcodeDir: string;
    hwAccel: Env['HW_ACCEL'];
    vaapiDevice: string;
    maxTranscodeSessions: number;
  };
  scan: {
    onStartup: boolean;
    intervalMinutes: number;
    watchPolling: boolean;
    probeConcurrency: number;
  };
}

/**
 * `<dataDir>/streamora.db`, unless only a database from before the rename to
 * Streamora exists (`localstream.db`): that one keeps being used, so existing
 * profiles, libraries and watch history carry over without moving files.
 */
function defaultDatabasePath(dataDir: string): string {
  const current = path.join(dataDir, 'streamora.db');
  const legacy = path.join(dataDir, 'localstream.db');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as "unset" so `.env.example` can be copied verbatim.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const dataDir = resolveFromRoot(env.DATA_DIR);

  return {
    env: env.NODE_ENV,
    isDev: env.NODE_ENV === 'development',
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDir,
    databasePath: env.DATABASE_PATH ? resolveFromRoot(env.DATABASE_PATH) : defaultDatabasePath(dataDir),
    cacheDir: path.join(dataDir, 'cache'),
    sessionSecret: env.SESSION_SECRET,
    sessionTtlDays: env.SESSION_TTL_DAYS,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    plugins: {
      dir: resolveFromRoot(env.PLUGINS_DIR),
      hotReload: env.PLUGINS_HOT_RELOAD,
      callTimeoutMs: env.PLUGIN_CALL_TIMEOUT_MS,
    },
    media: {
      ffmpegPath: env.FFMPEG_PATH,
      ffprobePath: env.FFPROBE_PATH,
      transcodeDir: env.TRANSCODE_DIR ? resolveFromRoot(env.TRANSCODE_DIR) : path.join(dataDir, 'transcodes'),
      hwAccel: env.HW_ACCEL,
      vaapiDevice: env.VAAPI_DEVICE,
      maxTranscodeSessions: env.MAX_TRANSCODE_SESSIONS,
    },
    scan: {
      onStartup: env.SCAN_ON_STARTUP,
      intervalMinutes: env.SCAN_INTERVAL_MINUTES,
      watchPolling: env.SCAN_WATCH_POLLING,
      probeConcurrency: env.SCAN_PROBE_CONCURRENCY,
    },
  };
}
