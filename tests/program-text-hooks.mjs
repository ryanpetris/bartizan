import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, next) {
  if (!url.endsWith('.py')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};` };
}
