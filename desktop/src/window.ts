import path from 'node:path';
import { app, BrowserWindow, screen, session, shell } from 'electron';
import { ASSETS_DIR } from './paths.js';
import { settings, updateSettings } from './settings.js';

const SPLASH = path.join(ASSETS_DIR, 'loading.html');
const BACKGROUND = '#141414';

let window: BrowserWindow | null = null;
/** The server's origin once it is up; until then the window shows the splash. */
let appUrl: string | null = null;

/** Hands web links to the default browser. Anything else (file:, custom schemes) is dropped. */
function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** The app only ever shows its own server; everything else opens in the browser. */
export function secureWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event) => {
      if (appUrl && new URL(event.url).origin === appUrl) return;
      event.preventDefault();
      openExternal(event.url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
  });

  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/** The saved position, unless it is on a monitor that is no longer there. */
function savedBounds(): Electron.Rectangle | null {
  const saved = settings.window;
  if (!saved) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const overlapY = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return overlapX > 100 && overlapY > 100;
  });
  return visible ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null;
}

export function getWindow(): BrowserWindow | null {
  return window;
}

export function showWindow(): BrowserWindow {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...savedBounds(),
    minWidth: 420,
    minHeight: 480,
    title: 'Streamora',
    icon: path.join(ASSETS_DIR, 'icon.png'),
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  window = win;
  if (settings.window?.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    updateSettings({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  });
  // The window is destroyed, not hidden, so nothing keeps playing in the background.
  win.on('closed', () => {
    if (window === win) window = null;
  });

  load();
  return win;
}

function load(): void {
  if (!window) return;
  // Rejections are navigations that were replaced by a newer one.
  (appUrl ? window.loadURL(appUrl) : window.loadFile(SPLASH)).catch(() => {});
}

/** Points the window at a running server, or back at the splash with `null`. */
export function setAppUrl(url: string | null): void {
  appUrl = url;
  load();
}
