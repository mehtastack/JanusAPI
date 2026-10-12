import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { CSP } from './src/shared/csp';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@apijanus/core', '@apijanus/agent'] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'sandbox-worker': resolve(__dirname, 'src/main/sandbox-worker.ts'),
          'import-worker': resolve(__dirname, 'src/main/import-worker.ts'),
          'graphql-worker': resolve(__dirname, 'src/main/graphql-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: { externalizeDeps: { exclude: ['@apijanus/core'] } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // Fonts stay files: the CSP allows font-src 'self', not data: URLs.
      assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    },
    plugins: [
      react(),
      {
        name: 'apijanus-csp',
        transformIndexHtml: {
          order: 'post',
          handler(html, ctx) {
            if (ctx.server) return html;
            return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
          },
        },
      },
    ],
  },
});
