import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSshd, waitFor } from './harness.mjs';

const fixture = fileURLToPath(new URL('../fixtures/vnc.py', import.meta.url));
export const password = 'rig-pass';

/** Only SSH crosses the Unix bridge; both VNC listeners stay inside the host's network namespace. */
export async function startVncHost(directory, cleanup) {
  const commandLog = join(directory, 'commands');
  const shell = join(directory, 'shell.sh');
  await writeFile(shell, `#!/bin/sh\nprintf '%s\\n' "$SSH_ORIGINAL_COMMAND" >> '${commandLog}'\nexec /bin/sh\n`);
  await chmod(shell, 0o755);
  const sshd = await startSshd(directory, { config: `ForceCommand ${shell}\nPermitTTY no\n` });
  sshd.stop();
  await waitFor(() => !alive(sshd.pid), 'the setup SSH server to stop');
  await writeFile(join(directory, 'password'), execFileSync('tigervncpasswd', ['-f'], { input: `${password}\n` }));
  const child = spawn('unshare', ['--user', '--map-current-user', '--keep-caps', '--net', '--mount', 'python3', fixture, directory, String(sshd.port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let lines = '', diagnostic = '', responses = 0;
  child.stdout.on('data', chunk => { lines += chunk; responses = lines.split('\n').length - 1; });
  child.stderr.on('data', chunk => diagnostic += chunk);
  cleanup(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      await exited;
    }
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`VNC host exited: ${diagnostic}\n${lines}`);
    return responses > 0;
  }, 'the isolated VNC host');
  const sockets = new Set();
  const bridge = createServer(client => {
    const upstream = connect(join(directory, 'ssh.sock'));
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(sshd.port, sshd.host, resolve); });
  cleanup(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => bridge.close(resolve));
  });
  return {
    sshd,
    command: async (action, index, text) => {
      const before = responses;
      child.stdin.write(JSON.stringify({ action, index, text }) + '\n');
      await waitFor(() => {
        if (child.exitCode !== null) throw new Error(diagnostic);
        return responses > before;
      }, `VNC host ${action}`);
    },
    inputs: index => records(join(directory, `input-${index}.jsonl`)),
    /** Each text a desktop's clipboard has taken, in order. */
    clipboard: index => records(join(directory, `clipboard-${index}.jsonl`)),
    assertNoHelper: async () => {
      const commands = await readFile(commandLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.ok(commands.split('\n').every(command => !command || command.includes('if command -v t3') && !command.includes('python3')), 'Only shells and application detection run on the SSH host');
    },
    log: async () => ({ diagnostic, ssh: await readFile(join(directory, 'sshd.log'), 'utf8'), vncs: await Promise.all([0, 1].map(index => readFile(join(directory, `vnc-${index}.log`), 'utf8'))) }),
  };
}

async function records(file) {
  return (await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function vncProcesses(application) {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').filter(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === application.process().pid && /\bssh\b.* -W /.test(match[3]);
  }).map(line => Number(line.trim().split(/\s+/)[0]));
}
