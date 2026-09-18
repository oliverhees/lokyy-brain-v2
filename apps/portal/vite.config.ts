import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // CSP is script-src 'self': no inline module preload polyfill
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3000' },
    // tokens.css is shared with apps/web
    fs: { allow: ['..'] },
  },
});
