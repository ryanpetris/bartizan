// Runs application rigs: `node scripts/rigs.mjs [--docker] [--no-build] [name...]`.
// Without names every rig runs. A rig whose commands are missing is skipped. `--docker` runs the rigs inside the rig
// image, which has every command the rigs use apart from docker.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Each rig and the commands it needs besides node and xvfb-run. */
const rigs = {
  smoke: [],
  web: ['sshd', 'chromium'],
  sandbox: [],
  integration: ['sshd', 'vim', 'python3'],
  appearance: [],
  themes: ['sshd', 'openbox', 'xprop'],
  config: [],
  connect: ['sshd'],
  errors: [],
  fonts: ['sshd'],
  graphics: ['sshd'],
  ligatures: ['sshd'],
  links: ['sshd'],
  browsing: ['sshd', 'openbox', 'xdotool', 'xprop'],
  order: ['sshd'],
  profiles: ['sshd'],
  tls: ['sshd', 'openssl'],
  downloads: ['dbus-run-session', 'xdotool', 'xwininfo'],
  titlebar: ['openbox', 'xdotool', 'xprop'],
  network: ['docker'],
};
const flags = new Set(process.argv.slice(2).filter(arg => arg.startsWith('--')));
const names = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
for (const name of names) if (!(name in rigs)) throw new Error(`Unknown rig: ${name}`);
const selected = names.length ? names : Object.keys(rigs);
const image = 'bartizan-rig';
// Xvfb has no GPU, so the rigs draw WebGL with SwiftShader.
process.env.BARTIZAN_RIG_SOFTWARE_GL ??= '1';

const available = command => spawnSync('sh', ['-c', `command -v "$1" || test -x "/usr/sbin/$1"`, 'sh', command], { stdio: 'ignore' }).status === 0;

if (!flags.has('--no-build') && !process.env.BARTIZAN_EXECUTABLE) execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
if (flags.has('--docker') || selected.includes('network') && available('docker')) {
  execFileSync('docker', ['build', '-t', image, '-'], { input: readFileSync('packaging/rig.Dockerfile'), stdio: ['pipe', 'inherit', 'inherit'] });
}
if (flags.has('--docker')) {
  const inside = selected.filter(name => !rigs[name].includes('docker'));
  if (inside.length) {
    const environment = ['RELEASE_TAG', 'BARTIZAN_EXECUTABLE', 'BARTIZAN_RIG_SOFTWARE_GL'].filter(key => process.env[key]).flatMap(key => ['-e', key]);
    const result = spawnSync('docker', ['run', '--rm', '--security-opt', 'seccomp=unconfined', '--cap-add', 'SYS_ADMIN', ...environment, '-v', `${process.cwd()}:/work:ro`, '-w', '/work', image,
      'runuser', '-u', 'node', '--', 'node', 'scripts/rigs.mjs', '--no-build', ...inside], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
  selected.splice(0, selected.length, ...selected.filter(name => rigs[name].includes('docker')));
}

const failed = [];
for (const name of selected) {
  const missing = rigs[name].filter(command => !available(command));
  if (missing.length) { console.log(`- ${name}: skipped, needs ${missing.join(', ')}`); continue; }
  console.log(`- ${name}`);
  const result = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'node', `scripts/rigs/${name}.mjs`], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`Failed rigs: ${failed.join(', ')}`);
  process.exit(1);
}
