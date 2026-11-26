import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, Menu, nativeImage, nativeTheme, Notification, shell, Tray, type MenuItemConstructorOptions } from 'electron';
// First: sets the app's folders before anything reads them.
import { ASSETS_DIR, DATABASE_FILE, HOME_DIR, LOG_FILE } from './paths.js';
import { activateDatabase, copyDatabase, findImportSource } from './import.js';
import { shareAddresses } from './network.js';
import { StreamoraServer } from './server.js';
import { settings, updateSettings } from './settings.js';
import { getWindow, secureWebContents, setAppUrl, showWindow } from './window.js';

/** Started by Windows at sign-in: tray only, no window. */
const startHidden = process.argv.includes('--hidden');

const server = new StreamoraServer();
let tray: Tray | null = null;
let quitting = false;
/** Start, restart and import run one at a time. */
let busy = false;

function messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

/** Runs one server operation at a time. Returns false when another one is in progress. */
async function exclusive(operation: () => Promise<void>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try {
    await operation();
  } finally {
    busy = false;
  }
  return true;
}

/** Starts the server; on failure offers to try again until it works or the user quits. */
async function startServer(): Promise<void> {
  for (;;) {
    try {
      await server.start();
      setAppUrl(server.url);
      refreshMenus();
      return;
    } catch (err) {
      if (quitting) return;
      const { response } = await messageBox({
        type: 'error',
        title: 'Streamora',
        message: 'The Streamora server could not start.',
        detail: `${(err as Error).message}\n\nThe log may say why: ${LOG_FILE}`,
        buttons: ['Try again', 'Show log', 'Quit'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 1) shell.showItemInFolder(LOG_FILE);
      if (response !== 0) {
        app.quit();
        return;
      }
    }
  }
}

/** Runs `change` while the server is down, then starts it again even if that failed. */
async function restartServer(change?: () => void): Promise<void> {
  setAppUrl(null);
  await server.stop();
  try {
    change?.();
  } finally {
    if (!quitting) await startServer();
  }
}

server.on('crashed', (code) => {
  if (quitting) return;
  void exclusive(async () => {
    setAppUrl(null);
    const { response } = await messageBox({
      type: 'error',
      title: 'Streamora',
      message: 'The Streamora server stopped unexpectedly.',
      detail: `Exit code ${code}. The log may say why: ${LOG_FILE}`,
      buttons: ['Restart', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await startServer();
    else app.quit();
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

async function toggleSharing(): Promise<void> {
  await exclusive(async () => {
    updateSettings({ shareOnNetwork: !settings.shareOnNetwork });
    await restartServer();
  });
  // Also puts the checkmark back when the change was not possible right now.
  refreshMenus();
  const address = shareAddresses().home[0];
  if (settings.shareOnNetwork && address && server.port && Notification.isSupported()) {
    new Notification({
      title: 'Phones and tablets can connect now',
      body: `Address: http://${address}:${server.port}\nYou can find it again in Streamora under your profile menu → Connect a device.`,
      icon: path.join(ASSETS_DIR, 'icon.png'),
    }).show();
  }
}

async function importData(): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: 'Choose the Streamora folder to import from',
    buttonLabel: 'Import',
    properties: ['openDirectory'],
  });
  const dir = picked.filePaths[0];
  if (picked.canceled || !dir) return;

  const source = findImportSource(dir);
  if (!source || path.resolve(source.database) === path.resolve(DATABASE_FILE)) {
    await messageBox({
      type: 'warning',
      title: 'Streamora',
      message: source ? 'That is the folder this app already uses.' : 'There is no Streamora database in that folder.',
      detail: source ? '' : 'Choose the Streamora folder, or the "data" folder inside it.',
    });
    return;
  }

  const { response } = await messageBox({
    type: 'question',
    title: 'Streamora',
    message: 'Replace the data in this app?',
    detail:
      `Profiles, libraries, watch history and plugin settings are copied from:\n${source.database}\n\n` +
      'That folder is not changed. A backup of the data in this app is kept.',
    buttons: ['Import', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;

  try {
    const done = await exclusive(async () => {
      // Copied before the server stops, so a bad source changes nothing.
      const staged = await copyDatabase(source);
      await restartServer(() => {
        activateDatabase(staged, source);
      });
    });
    if (!done) throw new Error('Streamora is still starting. Try again in a moment.');
  } catch (err) {
    await messageBox({ type: 'error', title: 'Streamora', message: 'The import failed.', detail: (err as Error).message });
  }
}

/** Opens the log, or its folder when nothing has been logged yet. */
function showLog(): void {
  if (fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE);
  else void shell.openPath(HOME_DIR);
}

// ── Menus ────────────────────────────────────────────────────────────────────

const AWAY_FROM_HOME_HELP = 'https://github.com/santoshban/streamora#watching-away-from-home';

function appItems(): MenuItemConstructorOptions[] {
  const { home, vpn } = settings.shareOnNetwork ? shareAddresses() : { home: [], vpn: [] };
  const copy = (label: string, address: string): MenuItemConstructorOptions => {
    const url = `http://${address}:${server.port}`;
    return { label: `${label}: ${url}`, click: () => clipboard.writeText(url) };
  };
  return [
    {
      label: 'Let other devices on my network connect',
      type: 'checkbox',
      checked: settings.shareOnNetwork,
      click: () => void toggleSharing(),
    },
    ...home.map((address) => copy('Copy address for other devices', address)),
    ...vpn.map((address) => copy('Copy address for away from home (VPN)', address)),
    { label: 'Watching away from home…', click: () => void shell.openExternal(AWAY_FROM_HOME_HELP) },
    { type: 'separator' },
    {
      label: 'Keep running when the window is closed',
      type: 'checkbox',
      checked: settings.runInBackground,
      click: () => {
        updateSettings({ runInBackground: !settings.runInBackground });
        refreshMenus();
      },
    },
    {
      label: 'Start when I sign in to Windows',
      type: 'checkbox',
      // In development this would register electron.exe.
      visible: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Import from another Streamora folder…', click: () => void importData() },
    { label: 'Open data folder', click: () => void shell.openPath(HOME_DIR) },
    { label: 'Show log', click: showLog },
    { type: 'separator' },
    { label: 'Quit Streamora', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ];
}

function refreshMenus(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([{ label: 'Open Streamora', click: () => showWindow() }, { type: 'separator' }, ...appItems()]),
  );
  // Hidden until Alt is pressed.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Streamora', submenu: appItems() },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
    ]),
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.streamora.desktop');
  nativeTheme.themeSource = 'dark';

  app.on('second-instance', () => {
    if (app.isReady()) showWindow();
  });

  app.on('window-all-closed', () => {
    if (!settings.runInBackground) {
      app.quit();
      return;
    }
    if (!settings.backgroundHintShown && Notification.isSupported()) {
      updateSettings({ backgroundHintShown: true });
      new Notification({
        title: 'Streamora is still running',
        body: 'Open or quit it from the icon in the notification area.',
        icon: path.join(ASSETS_DIR, 'icon.png'),
      }).show();
    }
  });

  let stopped = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    void server.stop().finally(() => {
      stopped = true;
      tray?.destroy();
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    secureWebContents();
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.ico')));
    tray.setToolTip('Streamora');
    tray.on('click', () => showWindow());
    refreshMenus();
    // The addresses in the menu change when Wi-Fi or a VPN (Tailscale) connects.
    let shownAddresses = JSON.stringify(shareAddresses());
    setInterval(() => {
      const now = JSON.stringify(shareAddresses());
      if (now === shownAddresses) return;
      shownAddresses = now;
      refreshMenus();
    }, 30_000);
    if (!startHidden) showWindow();
    await exclusive(startServer);
  });
}
