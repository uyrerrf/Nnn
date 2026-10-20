import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      // FIX: was proxying /socket.io (Socket.IO) — this app uses raw ws on /panel
      '/panel': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
