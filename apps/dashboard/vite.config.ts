import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const envDir = resolve(__dirname, '../..');
  const env = loadEnv(mode, envDir, '');
  // Allow contributors to run the API on a non-default port (Docker mapping,
  // port collision) without editing this file. Falls back to the common dev
  // default so a fresh checkout works without extra env setup.
  const apiTarget = env.VITE_API_PROXY_URL ?? 'http://localhost:3000';

  return {
    plugins: [react()],
    envDir,
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/v1': apiTarget,
      },
    },
  };
});
