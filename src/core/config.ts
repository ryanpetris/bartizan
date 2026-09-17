import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isScalar, parseDocument, type Document } from 'yaml';
import { z } from 'zod';
import { defaultSettings, normalizeHost, usernamePattern, type Settings } from '../shared';
import { settingsSchema, fontSchema, fontSizeSchema } from './settings';
import { fingerprintPattern } from './host-keys';

const text = z.string().max(4096).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Control characters are not allowed');
export const secretValue = z.string().refine(s => Buffer.byteLength(s, 'utf8') <= 1023, 'Credential must be at most 1023 UTF-8 bytes').refine(s => !/[\0\r\n]/.test(s), 'Credential must be a single line');
const name = text.min(1);
const pathValue = name.refine(s => !s.includes('${') && !s.startsWith('$'), 'Use a literal path');
export const secretSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('prompt') }),
  z.strictObject({ source: z.literal('literal'), value: secretValue }),
  z.strictObject({ source: z.literal('file'), path: pathValue }),
]);
/** An OpenSSH algorithm list, optionally starting with `+`, `^` or `-`; an empty list uses OpenSSH's defaults. */
const algorithms = z.string().regex(/^(?:[+^-]?[\w*?][\w@.+*?-]*(?:,[\w*?][\w@.+*?-]*)*)?$/, 'Expected an OpenSSH algorithm list');
const yesNo = z.boolean();
const seconds = z.number().int().min(0).max(86400);
export const sshSchema = z.strictObject({
  ConnectTimeout: seconds.optional(), ServerAliveInterval: seconds.optional(),
  ServerAliveCountMax: z.number().int().min(0).max(1000).optional(),
  ForwardAgent: yesNo.optional(), Compression: yesNo.optional(),
  TCPKeepAlive: yesNo.optional(), AddressFamily: z.enum(['any', 'inet', 'inet6']).optional(),
  LogLevel: z.enum(['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE']).optional(),
  KexAlgorithms: algorithms.optional(), Ciphers: algorithms.optional(), MACs: algorithms.optional(),
  HostKeyAlgorithms: algorithms.optional(), PubkeyAcceptedAlgorithms: algorithms.optional(),
});
export const specSchema = z.strictObject({
  label: name.optional(),
  host: name.transform((value, ctx) => {
    const host = normalizeHost(value);
    if (host === undefined) { ctx.addIssue({ code: 'custom', message: 'Invalid host' }); return z.NEVER; }
    return host;
  }).optional(),
  username: text.regex(usernamePattern, 'Invalid username').optional(),
  port: z.number().int().min(1).max(65535).optional(),
  auth: z.strictObject({
    method: z.enum(['auto', 'agent', 'key', 'password', 'keyboard-interactive']).optional(),
    identity_files: z.array(pathValue).optional(),
    agent: pathValue.optional(),
    password: secretSchema.optional(), passphrase: secretSchema.optional(),
  }).optional(),
  host_keys: z.strictObject({ policy: z.enum(['ask', 'strict', 'accept-new', 'off']).optional(), fingerprints: z.array(z.string().regex(fingerprintPattern, 'Expected a SHA256 host key fingerprint')).optional() }).optional(),
  terminal: z.strictObject({ ligatures: z.boolean().optional(), font: fontSchema.optional(), font_size: fontSizeSchema.optional(), scrollback: z.number().int().min(0).max(100000).optional() }).optional(),
  ssh: sshSchema.optional(),
});
export type Spec = z.infer<typeof specSchema>;
export type Secret = z.infer<typeof secretSchema>;
export type PublicSecret = Exclude<Secret, { source: 'literal' }> | { source: 'literal' };
export type PublicSpec = Omit<Spec, 'auth'> & { auth?: Omit<NonNullable<Spec['auth']>, 'password' | 'passphrase'> & { password?: PublicSecret; passphrase?: PublicSecret } };
export type Profile = { id: string; tags: string[]; spec: Spec };
export type PublicProfile = Omit<Profile, 'spec'> & { spec: PublicSpec };
export type Catalog = { settings: Settings; defaults: Spec; profiles: Profile[]; file: string };
export const tagsSchema = z.array(text.refine(value => !/[\u0080-\u009f]/.test(value), 'Control characters are not allowed').transform(value => value.trim()).pipe(z.string().min(1))).transform(values => {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
export const profileIdSchema = name.regex(/^[A-Za-z0-9_-]+$/).refine(value => value !== '__proto__', 'Invalid profile ID');
export const profileSchema = specSchema.extend({ tags: tagsSchema.optional() });
export const fileSchema = z.strictObject({ version: z.literal(1), settings: settingsSchema.partial().optional(), defaults: specSchema.optional(), profiles: z.record(profileIdSchema, profileSchema).optional() });
export const builtins: Spec = { port: 22, auth: { method: 'auto', identity_files: [], password: { source: 'prompt' }, passphrase: { source: 'prompt' } }, host_keys: { policy: 'ask' }, terminal: { scrollback: 5000 }, ssh: { ConnectTimeout: 15, ServerAliveInterval: 30, ServerAliveCountMax: 3, ForwardAgent: false } };

export function merge<T>(base: T, patch: Partial<T>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && !('source' in value)
      ? merge((result[key] && typeof result[key] === 'object' ? result[key] : {}) as object, value)
      : structuredClone(value);
  }
  return result as T;
}

function expandPath(path: string, base: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(base, path);
}
export function locate(spec: Spec, file: string): Spec {
  const out = structuredClone(spec);
  if (out.auth?.identity_files) out.auth.identity_files = out.auth.identity_files.map(p => expandPath(p, dirname(file)));
  if (out.auth?.agent && out.auth.agent !== 'SSH_AUTH_SOCK' && out.auth.agent !== 'none') out.auth.agent = expandPath(out.auth.agent, dirname(file));
  for (const s of [out.auth?.password, out.auth?.passphrase]) if (s?.source === 'file') s.path = expandPath(s.path, dirname(file));
  return out;
}
/** Reads a configuration as UTF-8 text. */
export function readConfiguration(file: string): string {
  if (!statSync(file).isFile()) throw new Error(`${file}: Configuration must be a regular file`);
  const bytes = readFileSync(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${file}: Configuration is not valid UTF-8`); }
}
/** Parses a YAML configuration; errors report a position without quoting the source. */
export function parseConfiguration(file: string, source = readConfiguration(file)): Document {
  // Keys that become the same object key, such as 1 and "1", are duplicates.
  const document = parseDocument(source, { uniqueKeys: (a, b) => isScalar(a) && isScalar(b) ? String(a.value) === String(b.value) : a === b });
  const problem = document.errors[0] ?? document.warnings[0];
  const position = problem?.linePos?.[0];
  if (problem) throw new Error(`${file}:${position ? `${position.line}:${position.col}:` : ''} Invalid YAML`);
  return document;
}

export function loadCatalog(file: string, source?: string): Catalog {
  file = resolve(file);
  try {
    const parsed: unknown = parseConfiguration(file, source).toJS();
    const rawProfiles = parsed && typeof parsed === 'object' && 'profiles' in parsed ? parsed.profiles : undefined;
    if (rawProfiles && typeof rawProfiles === 'object' && Object.hasOwn(rawProfiles, '__proto__')) throw new Error(`${file}: Invalid profile ID`);
    const config = fileSchema.parse(parsed);
    const defaults = locate(config.defaults ?? {}, file);
    const profiles = Object.entries(config.profiles ?? {}).map(([id, raw]) => {
      const { tags = [], ...settings } = raw;
      return { id, tags, spec: locate(settings, file) };
    });
    return { settings: { ...defaultSettings, ...config.settings }, defaults, profiles, file };
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`${file}: ${error.issues.map(i => `${i.path.join('.')}: ${i.code}`).join('; ')}`);
    throw error;
  }
}
export function resolveSpec(catalog: Catalog, profileId: string | undefined, overrides: unknown): Spec {
  const patch = locate(specSchema.parse(overrides), resolve(process.cwd(), 'overrides.yaml'));
  const profile = profileId ? catalog.profiles.find(p => p.id === profileId) : undefined;
  if (profileId && !profile) throw new Error('Unknown profile');
  const spec = specSchema.parse(merge(merge(merge(builtins, catalog.defaults), profile?.spec ?? {}), patch));
  const invalid = (path: string, message: string) => new z.ZodError([{ code: 'custom', path: path.split('.'), message, input: undefined }]);
  if (!spec.host) throw invalid('host', 'Host is required');
  if (spec.auth?.method === 'agent' && spec.auth.agent === 'none') throw invalid('auth.agent', 'Agent authentication requires an agent');
  if (spec.auth?.method === 'key' && !spec.auth.identity_files?.length) throw invalid('auth.identity_files', 'Select an identity file');
  return spec;
}
export function redactSpec(spec: Spec): PublicSpec {
  const out: PublicSpec = structuredClone(spec);
  for (const key of ['password', 'passphrase'] as const) {
    if (out.auth?.[key]?.source === 'literal') out.auth[key] = { source: 'literal' };
  }
  return out;
}
export class CredentialError extends Error {}
export function readSecret(secret?: Secret): string | undefined {
  if (!secret || secret.source === 'prompt') return undefined;
  if (secret.source === 'literal') return secretValue.parse(secret.value);
  try {
    const stat = statSync(secret.path);
    if (!stat.isFile()) throw new CredentialError('Credential source must be a regular file');
    if (stat.size > 1025) throw new CredentialError('Credential must be at most 1023 UTF-8 bytes');
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(secret.path));
    return secretValue.parse(value.replace(/\r?\n$/, ''));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw new CredentialError('Credential file could not be read');
    throw error;
  }
}

export function configurationFile(args: string[], cwd: string, defaultFile: string): string {
  const [path, ...extra] = parseArgs({ args, options: { config: { type: 'string', multiple: true } }, strict: false, allowPositionals: true }).values.config ?? [];
  if (extra.length) throw new Error('--config may only be specified once');
  if (path === undefined) return resolve(defaultFile);
  if (typeof path !== 'string' || !path || path.startsWith('--')) throw new Error('--config requires a file path');
  return expandPath(path, cwd);
}

/** Creates a private, valid configuration without overwriting an existing file. */
export function ensureConfiguration(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, 'version: 1\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
