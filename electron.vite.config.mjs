import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { archiveSources, pythonArchive } from './scripts/python-archive.mjs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  main: {
    build: {
      sourcemap: mode === 'development',
      lib: {
        entry: {
          main: resolve('src/main/main.ts'), server: resolve('src/web/entry.ts'),
          askpass: resolve('src/main/askpass-helper.ts'), 'host-key': resolve('src/main/host-key-helper.ts'),
        },
        formats: ['cjs'],
      },
      rollupOptions: { output: { entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' } },
    },
    plugins: [{
      name: 'bartizan-program-text',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id.endsWith('.pyz')) return resolve(dirname(importer), id);
      },
      load(id) {
        if (id.endsWith('.pyz')) {
          const directory = id.slice(0, -4);
          for (const file of archiveSources(directory)) this.addWatchFile(file);
          return `export default ${JSON.stringify(pythonArchive(directory).toString('base64'))};`;
        }
      },
    }],
  },
  preload: {
    build: {
      sourcemap: mode === 'development',
      lib: { entry: resolve('src/main/preload.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'preload.cjs', inlineDynamicImports: true } },
    },
  },
  renderer: {
    publicDir: resolve('assets'),
    base: './',
    build: { sourcemap: mode === 'development' },
    server: { host: '127.0.0.1' },
    plugins: [
      // The entry mounts a root and overlays own native child windows; both need a page reload.
      react({ exclude: [/node_modules/, /\/(app|overlay)\.tsx$/] }),
      {
        // The renderer bundles noVNC, which is MPL-2.0; its notices and where its source is published ship beside it.
        name: 'bartizan-novnc-notices',
        apply: 'build',
        generateBundle() {
          const root = resolve('node_modules/@novnc/novnc');
          const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
          const files = ['LICENSE.txt', 'AUTHORS', 'docs/LICENSE.MPL-2.0', 'docs/LICENSE.BSD-2-Clause', 'docs/LICENSE.BSD-3-Clause', 'docs/LICENSE.OFL-1.1', 'vendor/pako/LICENSE'];
          for (const file of files)
            this.emitFile({ type: 'asset', fileName: `licenses/novnc/${file}`, source: readFileSync(resolve(root, file)) });
          this.emitFile({ type: 'asset', fileName: 'licenses/novnc/SOURCE', source: `noVNC ${version}\nhttps://github.com/novnc/noVNC/tree/v${version}\n` });
        },
      },
      {
        name: 'bartizan-dev-html',
        apply: 'serve',
        transformIndexHtml: {
          order: 'pre',
          handler: html => html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:*"),
        },
      },
    ],
  },
}));
