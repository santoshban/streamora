import fs from 'node:fs';
import path from 'node:path';
import type { Rectangle } from 'electron';
import { SETTINGS_FILE } from './paths.js';

export interface Settings {
  /** First choice; the next free port is used when it is taken. */
  port: number;
  /** Listen on all interfaces instead of only this computer. */
  shareOnNetwork: boolean;
  /** Keep the server and tray icon running after the window is closed. */
  runInBackground: boolean;
  /** The "still running in the tray" hint is shown once. */
  backgroundHintShown: boolean;
  window?: Rectangle & { maximized: boolean };
}

const DEFAULTS: Settings = {
  port: 8484,
  // Off until asked for: it opens a port to the network and makes Windows Firewall ask.
  shareOnNetwork: false,
  runInBackground: true,
  backgroundHintShown: false,
};

function load(): Settings {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
    const merged = { ...DEFAULTS, ...saved };
    if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) merged.port = DEFAULTS.port;
    return merged;
  } catch {
    // First run, or a damaged file.
    return { ...DEFAULTS };
  }
}

export const settings: Readonly<Settings> = load();

export function updateSettings(changes: Partial<Settings>): void {
  Object.assign(settings, changes);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temp, SETTINGS_FILE);
}
