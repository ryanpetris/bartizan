import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await build({ entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', askpass: 'src/main/askpass-helper.ts', 'host-key': 'src/main/host-key-helper.ts' }, bundle: true, platform: 'node', format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' }, external: ['electron', 'node-pty'], sourcemap: true });
await build({ entryPoints: ['src/renderer/app.tsx'], bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, outdir: 'dist', sourcemap: true });
await copyFile('src/renderer/index.html', 'dist/index.html');
await copyFile('src/renderer/style.css', 'dist/style.css');
await cp('assets/fonts', 'dist/fonts', { recursive: true, filter: source => !source.endsWith('.md') });
