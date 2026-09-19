import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist', emptyOutDir: false, sourcemap: true,
      lib: {
        entry: {
          main: resolve('src/main/main.ts'), server: resolve('src/web/entry.ts'),
          askpass: resolve('src/main/askpass-helper.ts'), 'host-key': resolve('src/main/host-key-helper.ts'),
        },
        formats: ['cjs'],
      },
      rollupOptions: { output: { entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' } },
    },
  },
  preload: {
    build: {
      outDir: 'dist', emptyOutDir: false, sourcemap: true,
      lib: { entry: resolve('src/main/preload.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'preload.cjs', inlineDynamicImports: true } },
    },
  },
  renderer: {
    cacheDir: resolve('dist/.vite'),
    publicDir: resolve('assets'),
    server: { host: '127.0.0.1' },
    plugins: [
      // The entry mounts a root and overlays own native child windows; both need a page reload.
      react({ exclude: [/node_modules/, /\/(app|overlay)\.tsx$/] }),
      {
        name: 'bartizan-dev-html',
        transformIndexHtml: {
          order: 'pre',
          handler: html => html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:*")
            .replace('<link rel="stylesheet" href="app.css">', '')
            .replace('<script src="app.js"></script>', '<script type="module" src="/app.tsx"></script>'),
        },
      },
    ],
  },
});
