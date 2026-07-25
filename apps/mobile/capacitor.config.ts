import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.codexmobile.remote',
  appName: 'Codex Remote',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    backgroundColor: '#f7f7f5',
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'css',
      style: 'LIGHT',
    },
  },
};

export default config;
