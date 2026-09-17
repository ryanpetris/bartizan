import { execFile } from 'node:child_process';

export type ConnectionInfo = {
  status: 'connecting' | 'connected' | 'closed'; exitCode?: number; username: string;
  duration?: string; endpoints?: string;
  kex?: string; hostKey?: string; cipher?: string; mac?: string; compression?: string;
  received?: string; sent?: string;
};

export function parseConnectionInfo(output: string): Partial<ConnectionInfo> {
  const values: Partial<ConnectionInfo> = {};
  const fields = { tcp: 'endpoints', duration: 'duration', kexalgorithm: 'kex', hostkeyalgorithm: 'hostKey', cipher: 'cipher', mac: 'mac', compression: 'compression' } as const;
  for (const line of output.split(/\r?\n/)) {
    const field = /^  (\w+) (.+)$/.exec(line);
    if (!field) continue;
    const key = fields[field[1] as keyof typeof fields];
    if (key) values[key] = field[2];
    if (field[1] === 'traffic') {
      const traffic = /^\d+ pkts \d+ blks (\S+) in, \d+ pkts \d+ blks (\S+) out$/.exec(field[2]);
      if (traffic) { values.received = traffic[1]; values.sent = traffic[2]; }
    }
  }
  return values;
}

/** Reads the master's connection information; clients without `-O conninfo` report nothing. */
export function connectionInfo(socket: string, host: string): Promise<Partial<ConnectionInfo>> {
  return new Promise(resolve => {
    execFile('ssh', ['-F', 'none', '-S', socket, '-O', 'conninfo', '--', host], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => resolve(error ? {} : parseConnectionInfo(stdout + stderr)));
  });
}
