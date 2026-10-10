import { execFile } from 'node:child_process';
import type { Spec } from '../core/config';
import { channelArgs } from './remote-sessions';

/** Whether an address of `/proc/net/tcp` or `tcp6`, as a little-endian host prints it, is a loopback or wildcard one. */
const local = (address: string) =>
  address.length === 8 ? address === '00000000' || address.endsWith('7F')
    : /^0{24}(00000000|01000000)$/.test(address) || /^0{16}FFFF0000([0-9A-F]{6}7F|0{8})$/.test(address);

/** The ports listening on a loopback or wildcard address in the text of `/proc/net/tcp` and `/proc/net/tcp6`, in order. */
export function listeningPorts(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split('\n')) {
    const [, endpoint, , state] = line.trim().split(/\s+/);
    const [address, port] = endpoint?.toUpperCase().split(':') ?? [];
    if (state !== '0A' || !address || !port || !/^[0-9A-F]+$/.test(address) || !/^[0-9A-F]{4}$/.test(port) || !local(address)) continue;
    const number = parseInt(port, 16);
    if (number) ports.add(number);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Reads the ports listening on a Linux host over the connection's control socket, which sends only the listening rows; anywhere else, or on failure, there are none. */
export function remotePorts(socket: string, spec: Spec): Promise<number[]> {
  return new Promise(resolve => {
    execFile('ssh', [...channelArgs(socket, spec), '-n', '-T', '--', spec.host!, `awk '$4 == "0A"' /proc/net/tcp /proc/net/tcp6`], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (_error, stdout) => resolve(listeningPorts(String(stdout ?? ''))));
  });
}
