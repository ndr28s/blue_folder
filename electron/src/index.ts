import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import { getCapacitorElectronConfig, setupElectronDeepLinking } from '@capacitor-community/electron';
import type { MenuItemConstructorOptions } from 'electron';
import { app, MenuItem } from 'electron';
import electronIsDev from 'electron-is-dev';
import unhandled from 'electron-unhandled';
import { autoUpdater } from 'electron-updater';

import { ElectronCapacitorApp, setupContentSecurityPolicy, setupReloadWatcher } from './setup';
import { PORT, spawnServer, stopServer, pollReady } from './server';

// Graceful handling of unhandled errors.
unhandled();

const appMenuBarMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
  { role: 'viewMenu' },
];

// Get Config options from capacitor.config
const capacitorFileConfig: CapacitorElectronConfig = getCapacitorElectronConfig();

// Initialize our app. You can pass menu templates into the app here.
const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig, [], appMenuBarMenuTemplate);

// Tray menu built after init so it can reference the window.
const trayMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  new MenuItem({
    label: 'Show Blue Folder',
    click: () => {
      const win = myCapacitorApp.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    },
  }),
  { type: 'separator' },
  new MenuItem({ label: 'Quit', role: 'quit' }),
];
myCapacitorApp.setTrayMenu(trayMenuTemplate);

// If deeplinking is enabled then we will set it up here.
if (capacitorFileConfig.electron?.deepLinkingEnabled) {
  setupElectronDeepLinking(myCapacitorApp, {
    customProtocol: capacitorFileConfig.electron.deepLinkingCustomProtocol ?? 'mycapacitorapp',
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // Wait for electron app to be ready.
  await app.whenReady();
  // Security - Set Content-Security-Policy based on whether or not we are in dev mode.
  setupContentSecurityPolicy(myCapacitorApp.getCustomURLScheme());

  // Start the embedded paperclip server, then load its URL in the window.
  const serverStarted = spawnServer();
  if (serverStarted) {
    pollReady(
      async () => {
        myCapacitorApp.setServerUrl(`http://localhost:${PORT}`);
        await myCapacitorApp.init();
        autoUpdater.checkForUpdatesAndNotify();
      },
      async () => {
        console.error('[blue-folder] Server did not start within 60s — falling back to local app');
        await myCapacitorApp.init();
        autoUpdater.checkForUpdatesAndNotify();
      },
    );
  } else {
    // No server available (e.g. dev mode without repo root) — load static app
    await myCapacitorApp.init();
    autoUpdater.checkForUpdatesAndNotify();
  }
})();

// When the last window is closed, minimize to tray instead of quitting.
app.on('window-all-closed', function () {
  if (process.platform === 'darwin') {
    app.quit();
  }
  // On Windows/Linux the tray keeps the app alive — do nothing here.
});

// Gracefully stop the embedded server before quitting.
app.on('before-quit', async (event) => {
  event.preventDefault();
  (app as any).isQuiting = true;
  await stopServer();
  app.exit(0);
});

// When the dock icon is clicked.
app.on('activate', async function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (myCapacitorApp.getMainWindow().isDestroyed()) {
    await myCapacitorApp.init();
  }
});

// Place all ipc or other electron api calls and custom functionality under this line
