import { parseArgs } from 'node:util';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createInterface } from 'node:readline/promises';

export function serverOptions(args: string[]) {
  const { values } = parseArgs({ args, options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '3000' }, config: { type: 'string' }, 'allow-remote': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (!values.host || !/^\d+$/.test(values.port!) || Number(values.port) > 65535) throw new Error('Expected --host ADDRESS and --port 0–65535');
  return { host: values.host, port: Number(values.port), config: values.config, allowRemote: values['allow-remote'], help: values.help };
}
export const isLoopback = (address: string) => address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
/** Bind the address we checked, rather than resolving a hostname again when listening. */
export async function bindAddress(host: string) {
  if (isIP(host)) return host;
  return (await lookup(host)).address;
}
export async function confirmRemote(host: string, address: string, allowRemote: boolean) {
  if (isLoopback(address)) return;
  console.error(`\n!!! WARNING: BARTIZAN HAS NO AUTHENTICATION !!!\nListening on ${host} (${address}) allows anyone who can reach this server to operate its SSH connections and terminals, and access its configuration and credentials.\nSecure access with an authenticated reverse proxy, VPN, or equivalent protection.\n`);
  if (allowRemote) return;
  if (!process.stdin.isTTY) throw new Error('Remote listening requires confirmation. Use --allow-remote to accept this risk noninteractively.');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await prompt.question('Type yes to allow remote access: ')).trim().toLowerCase() !== 'yes') throw new Error('Remote listening cancelled'); }
  finally { prompt.close(); }
}
