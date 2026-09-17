import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 is required for this release build');
// Native modules are built on the rig image's base, where the packaged application is also checked.
const image = /^FROM (\S+)/m.exec(readFileSync('packaging/rig.Dockerfile', 'utf8'))[1];
execFileSync('docker', ['run', '--rm', '-v', `${process.cwd()}:/work`, '-w', '/work', '-e', `BARTIZAN_UID=${process.getuid()}`, '-e', `BARTIZAN_GID=${process.getgid()}`, image, 'sh', '-c', 'node node_modules/@electron/rebuild/lib/cli.js --force --which-module node-pty; rebuild_exit=$?; chown -R "$BARTIZAN_UID:$BARTIZAN_GID" node_modules/node-pty; exit "$rebuild_exit"'], { stdio: 'inherit' });
