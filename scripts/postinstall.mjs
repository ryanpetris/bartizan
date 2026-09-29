import { chmodSync, globSync } from 'node:fs';

if (process.platform === 'darwin') {
  for (const helper of globSync('node_modules/node-pty/prebuilds/darwin-*/spawn-helper')) chmodSync(helper, 0o755);
}
