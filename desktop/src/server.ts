import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { utilityProcess, type UtilityProcess } from 'electron';
import { findFreePort } from './network.js';
import { DATA_DIR, DATABASE_FILE, ENV_FILE, FFMPEG_DIR, LOG_FILE, LOGS_DIR, PLUGINS_DIR, SERVER_DIR } from './paths.js';
import { settings } from './settings.js';

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 8_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Settings from streamora.env, without the ones the app decides itself. */
function userEnv(): Record<string, string> {
  let parsed: NodeJS.Dict<string> = {};
  try {
    parsed = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    // The file is optional.
  }
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => !!e[1]));
}

/**
 * Copies the bundled plugins into the user's plugins folder when they changed
 * with an update. Other folders there are the user's own and are left alone.
 */
function syncBundledPlugins(): void {
  const source = path.join(SERVER_DIR, 'plugins');
  const bundleId = fs.readFileSync(path.join(source, '.bundle-id'), 'utf8');
  const marker = path.join(PLUGINS_DIR, '.bundle-id');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === bundleId) return;

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(PLUGINS_DIR, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(source, entry.name), target, { recursive: true });
  }
  fs.writeFileSync(marker, bundleId);
}

function openLog(): fs.WriteStream {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
  } catch {
    // No log yet.
  }
  return fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

/** The Streamora server, running in an Electron utility process. */
export class StreamoraServer extends EventEmitter<{ crashed: [code: number] }> {
  private child: UtilityProcess | null = null;
  private stopping = false;
  /** Where the app and other devices reach the server. Set while it runs. */
  port = 0;

  /** 127.0.0.1 rather than localhost, which may resolve to another program on ::1. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.child) return;
    syncBundledPlugins();
    this.port = await findFreePort(settings.port);
    this.stopping = false;

    const exe = process.platform === 'win32' ? '.exe' : '';
    const child = utilityProcess.fork(path.join(SERVER_DIR, 'desktop-entry.mjs'), [], {
      serviceName: 'Streamora Server',
      cwd: SERVER_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        FFMPEG_PATH: path.join(FFMPEG_DIR, `ffmpeg${exe}`),
        FFPROBE_PATH: path.join(FFMPEG_DIR, `ffprobe${exe}`),
        ...userEnv(),
        NODE_ENV: 'production',
        HOST: settings.shareOnNetwork ? '0.0.0.0' : '127.0.0.1',
        PORT: String(this.port),
        DATA_DIR,
        DATABASE_PATH: DATABASE_FILE,
        PLUGINS_DIR,
        CORS_ORIGINS: this.url,
      },
    });
    this.child = child;

    const log = openLog();
    log.write(`\n--- ${new Date().toISOString()} starting on port ${this.port} ---\n`);
    child.stdout?.on('data', (chunk: Buffer) => log.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));

    let exitCode: number | null = null;
    let ready = false;
    child.once('exit', (code) => {
      exitCode = code;
      log.end(`--- exited with code ${code} ---\n`);
      if (this.child === child) this.child = null;
      if (ready && !this.stopping) this.emit('crashed', code);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (exitCode === null && !this.stopping) {
      if (await this.isHealthy()) {
        ready = true;
        return;
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('The server did not answer within a minute.');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(this.stopping ? 'The server was stopped while starting.' : `The server exited with code ${exitCode}.`);
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok && ((await res.json()) as { name?: string }).name === 'Streamora';
    } catch {
      return false;
    }
  }

  /** Lets the server end transcodes and close the database; kills it if that hangs. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage('shutdown');
    });
  }
}
