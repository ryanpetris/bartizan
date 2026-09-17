export type SectionId = 'connection' | 'authentication' | 'host-keys' | 'terminal' | 'ssh' | 'algorithms';
export const sections: [SectionId, string][] = [
  ['connection', 'Connection'], ['authentication', 'Authentication'], ['host-keys', 'Host Keys'],
  ['terminal', 'Terminal'], ['ssh', 'SSH Options'], ['algorithms', 'Algorithms'],
];
export const algorithmKeys = ['KexAlgorithms', 'Ciphers', 'MACs', 'HostKeyAlgorithms', 'PubkeyAcceptedAlgorithms'] as const;
/** Every connection setting in display order. */
export const settings: [path: string, label: string, section: SectionId][] = [
  ['label', 'Label', 'connection'], ['host', 'Host', 'connection'], ['username', 'Username', 'connection'], ['port', 'Port', 'connection'],
  ['auth.method', 'Method', 'authentication'], ['auth.identity_files', 'Identity Files', 'authentication'],
  ['auth.agent', 'Agent', 'authentication'], ['auth.password', 'Password', 'authentication'], ['auth.passphrase', 'Key Passphrase', 'authentication'],
  ['host_keys.policy', 'Policy', 'host-keys'], ['host_keys.fingerprints', 'Fingerprints', 'host-keys'],
  ['terminal.font', 'Font', 'terminal'], ['terminal.font_size', 'Font Size', 'terminal'], ['terminal.ligatures', 'Ligatures', 'terminal'], ['terminal.scrollback', 'Scrollback', 'terminal'],
  ['ssh.ConnectTimeout', 'ConnectTimeout', 'ssh'], ['ssh.ServerAliveInterval', 'ServerAliveInterval', 'ssh'], ['ssh.ServerAliveCountMax', 'ServerAliveCountMax', 'ssh'],
  ['ssh.ForwardAgent', 'ForwardAgent', 'ssh'], ['ssh.Compression', 'Compression', 'ssh'], ['ssh.TCPKeepAlive', 'TCPKeepAlive', 'ssh'], ['ssh.AddressFamily', 'AddressFamily', 'ssh'], ['ssh.LogLevel', 'LogLevel', 'ssh'],
  ...algorithmKeys.map(key => [`ssh.${key}`, key, 'algorithms'] as [string, string, SectionId]),
];
export const setting = (path: string) => settings.find(([p]) => p === path)!;

export const labels: Record<string, Record<string, string>> = {
  'auth.method': { auto: 'Automatic', agent: 'SSH Agent', key: 'Identity File', password: 'Password', 'keyboard-interactive': 'Keyboard-Interactive' },
  'host_keys.policy': { ask: 'Ask', strict: 'Strict', 'accept-new': 'Accept New', off: 'Off' },
  'terminal.ligatures': { true: 'Enabled', false: 'Disabled' },
  'ssh.AddressFamily': { any: 'Any', inet: 'IPv4', inet6: 'IPv6' },
  'ssh.LogLevel': { QUIET: 'Quiet', FATAL: 'Fatal', ERROR: 'Error', INFO: 'Info', VERBOSE: 'Verbose' },
  secret: { prompt: 'Prompt', literal: 'Literal', file: 'File' },
  boolean: { true: 'Yes', false: 'No' },
};

export const get = (object: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], object);
export function set(object: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.'); const last = keys.pop()!;
  let target = object;
  for (const key of keys) target = (target[key] ??= {}) as Record<string, unknown>;
  target[last] = value;
}

/** Formats a setting value; `method` is the effective authentication method, under which automatic authentication without identity files uses OpenSSH's default keys. */
export function format(path: string, value: unknown, method?: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return (labels[path] ?? labels.boolean)[String(value)];
  if (Array.isArray(value)) return value.length ? value.join(', ') : path === 'auth.identity_files' && method === 'auto' ? 'OpenSSH Default' : 'None';
  if (value && typeof value === 'object') {
    const secret = value as { source: string; path?: string };
    return secret.source === 'file' ? `${labels.secret.file} ${secret.path}` : labels.secret[secret.source];
  }
  if (path === 'auth.agent') return value === 'none' ? 'None' : String(value);
  if (path === 'terminal.font') return value === '' ? 'System Default' : String(value);
  return labels[path]?.[String(value)] ?? String(value);
}

export function formatCommand(args: string[]): string {
  const quote = (arg = '') => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  const lines: string[][] = [['ssh']];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['-o', '-i', '-D', '-p'].includes(arg)) lines.push([arg, quote(args[++i])]);
    else if (['-F', '-e', '-l'].includes(arg)) lines.at(-1)!.push(arg, quote(args[++i]));
    else lines.at(-1)!.push(quote(arg));
  }
  return lines.map((line, i) => (i ? '  ' : '') + line.join(' ')).join(' \\\n');
}


