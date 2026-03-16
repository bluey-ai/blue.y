import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/admin/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/admin/logout': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
