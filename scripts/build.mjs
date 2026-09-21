import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pythonArchive } from './python-archive.mjs';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await build({ entryPoints: { main: 'src/main/main.ts', server: 'src/web/entry.ts', preload: 'src/main/preload.ts', askpass: 'src/main/askpass-helper.ts', 'host-key': 'src/main/host-key-helper.ts' }, bundle: true, platform: 'node', format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' }, external: ['electron', 'node-pty'], sourcemap: true, loader: { '.py': 'text' }, plugins: [{
  name: 'python-archive',
  setup(build) {
    build.onResolve({ filter: /\.pyz$/ }, args => ({ path: resolve(args.resolveDir, args.path), namespace: 'python-archive' }));
    build.onLoad({ filter: /.*/, namespace: 'python-archive' }, args => ({ contents: pythonArchive(args.path.slice(0, -4)).toString('base64'), loader: 'text' }));
  },
}] });
await build({ entryPoints: ['src/renderer/app.tsx', 'src/renderer/font-worker.ts'], bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, outdir: 'dist', sourcemap: true });
await copyFile('src/renderer/index.html', 'dist/index.html');
await copyFile('src/renderer/style.css', 'dist/style.css');
await cp('assets/fonts', 'dist/fonts', { recursive: true, filter: source => !source.endsWith('.md') });
