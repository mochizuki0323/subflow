import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    rollupOptions: {
      input: {
        'control-panel': resolve(__dirname, 'src/frontend/renderer/control-panel/index.html'),
        overlay: resolve(__dirname, 'src/frontend/renderer/overlay/index.html'),
        history: resolve(__dirname, 'src/frontend/renderer/overlay/history.html'),
      },
    },
  },
});
