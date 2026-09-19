// Makes docs/images/bartizan.png, an animated PNG of the Rail, Tabs and Console themes over one synthetic workspace:
// `node scripts/screenshots.mjs [--no-build]`. The capture runs in the rig image as a `demo` user, so nothing of the
// machine running it appears in the image.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const image = 'bartizan-rig', container = `bartizan-screenshots-${process.pid}`;
const [width, height] = [1440, 900];
if (!process.argv.includes('--no-build')) {
  execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
  // node-pty loads in the image only when it was built on the image's base.
  execFileSync('node', ['scripts/native-linux.mjs'], { stdio: 'inherit' });
}
execFileSync('docker', ['build', '-t', image, '-'], { input: readFileSync('packaging/rig.Dockerfile'), stdio: ['pipe', 'inherit', 'inherit'] });
const capture = `usermod --login demo --move-home --home /home/demo node && mkdir /out && chown demo /out && runuser -u demo -- xvfb-run -a -s "-screen 0 ${width}x${height}x24" node scripts/screenshots/capture.mjs /out ${width} ${height}`;
// Ctrl+C stops the container through Docker; this script carries on to remove it.
process.on('SIGINT', () => {});
try {
  // The screenshot is copied out of the stopped container, so the capture shares nothing writable with this machine.
  const result = spawnSync('docker', ['run', '--init', '--name', container, '--hostname', 'workstation', '--security-opt', 'seccomp=unconfined', '--cap-add', 'SYS_ADMIN',
    '-e', 'BARTIZAN_RIG_SOFTWARE_GL=1', '-v', `${process.cwd()}:/work:ro`, '-w', '/work', image, 'sh', '-c', capture], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The capture failed');
  execFileSync('docker', ['cp', `${container}:/out/bartizan.png`, 'docs/images/bartizan.png'], { stdio: 'inherit' });
  console.log('Wrote docs/images/bartizan.png.');
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
}
