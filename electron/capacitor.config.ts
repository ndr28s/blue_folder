import type { CapacitorElectronConfig } from '@capacitor-community/electron';

const config: CapacitorElectronConfig = {
  appId: 'com.ndr28s.bluefolder',
  appName: 'Blue Folder',
  webDir: 'dist',
  electron: {
    trayIconAndMenuEnabled: true,
    hideMainWindowOnLaunch: false,
  },
};

export default config;
