import path from 'node:path';
import { app } from 'electron';

/**
 * Everything Streamora writes lives in one folder. On Windows that is
 * %LOCALAPPDATA%, not the roaming profile: the artwork cache and transcodes get large.
 * STREAMORA_HOME overrides it (used for testing).
 */
function homeDir(): string {
  if (process.env.STREAMORA_HOME) return path.resolve(process.env.STREAMORA_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Streamora');
  return path.join(app.getPath('appData'), 'Streamora');
}

export const HOME_DIR = homeDir();
// Before the app is ready, and before anything asks for these paths.
app.setPath('userData', HOME_DIR);
app.setPath('sessionData', path.join(HOME_DIR, 'browser'));

/** Database, artwork cache, transcodes (the server's DATA_DIR). */
export const DATA_DIR = path.join(HOME_DIR, 'data');
export const DATABASE_FILE = path.join(DATA_DIR, 'streamora.db');
/** Bundled plugins are copied here on start; users can add their own next to them. */
export const PLUGINS_DIR = path.join(HOME_DIR, 'plugins');
export const LOGS_DIR = path.join(HOME_DIR, 'logs');
export const LOG_FILE = path.join(LOGS_DIR, 'server.log');
export const SETTINGS_FILE = path.join(HOME_DIR, 'settings.json');
/** Optional server settings in `.env` format (see .env.example). */
export const ENV_FILE = path.join(HOME_DIR, 'streamora.env');

const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build');
export const SERVER_DIR = path.join(resources, 'server');
export const FFMPEG_DIR = path.join(resources, 'ffmpeg');
export const ASSETS_DIR = path.join(app.getAppPath(), 'assets');
