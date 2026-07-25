import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.codexmobile.remote',
  appName: 'Codex Remote',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    backgroundColor: '#080b10',
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#080b10',
      overlaysWebView: true,
    },
  },
};

export default config;
