import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pythonArchive } from '../scripts/python-archive.mjs';

export function resolve(specifier, context, next) {
  if (specifier.endsWith('.pyz')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url.endsWith('.pyz')) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(pythonArchive(fileURLToPath(url).slice(0, -4)).toString('base64'))};` };
  if (!url.endsWith('.py')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};` };
}
