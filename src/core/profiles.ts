import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Document, isMap, isNode, isScalar, visit } from 'yaml';
import { z } from 'zod';
import { loadCatalog, locate, parseConfiguration, profileIdSchema, profileSchema, readConfiguration, resolveSpec, specSchema, tagsSchema, type Catalog, type Spec } from './config';
import { writeAtomic } from './files';
import { settingsSchema } from './settings';
import type { Settings } from '../shared';

const fields = ['remote_sessions', 'label', 'host', 'username', 'port', 'auth.method', 'auth.identity_files', 'auth.agent', 'auth.password', 'auth.passphrase', 'host_keys.policy', 'host_keys.fingerprints', 'host_keys.public_keys', 'terminal.scrollback', 'terminal.font', 'terminal.font_size', 'terminal.ligatures', 'terminal.webgl', 'ssh.ConnectTimeout', 'ssh.ServerAliveInterval', 'ssh.ServerAliveCountMax', 'ssh.ForwardAgent', 'ssh.Compression', 'ssh.TCPKeepAlive', 'ssh.AddressFamily', 'ssh.LogLevel', 'ssh.KexAlgorithms', 'ssh.Ciphers', 'ssh.MACs', 'ssh.HostKeyAlgorithms', 'ssh.PubkeyAcceptedAlgorithms'] as const;
export const profileChangesSchema = z.strictObject({ token: z.string().uuid(), values: specSchema, reset: z.array(z.enum(fields)).max(fields.length), tags: tagsSchema.optional() });
export const profileSaveSchema = profileChangesSchema.extend({ id: profileIdSchema.optional(), connect: z.boolean() });
type Changes = z.infer<typeof profileChangesSchema>;
type RawProfile = z.infer<typeof profileSchema>;
/** A configuration snapshot taken when a form opens; `profile` holds the edited profile as written in the file. */
export type Draft = { file: string; id?: string; source?: string; target: string; mode: number; profile?: RawProfile; error?: unknown };

const emptyConfiguration = 'version: 1\n';

function snapshot(file: string): { source?: string; target: string; mode: number } {
  try { return { source: readConfiguration(file), target: realpathSync(file), mode: statSync(file).mode & 0o777 }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || lstatSync(file, { throwIfNoEntry: false })) throw error;
    return { target: resolve(realpathSync(dirname(file)), basename(file)), mode: 0o600 };
  }
}

/** Captures the source document before editing; values remain relative to that source. */
export function profileDraft(catalog: Catalog, id?: string): Draft {
  const file = catalog.file;
  if (id && !catalog.profiles.some(profile => profile.id === id)) throw new Error('Unknown profile');
  try {
    const saved = snapshot(file);
    const source = saved.source ?? emptyConfiguration;
    loadCatalog(file, source);
    const profile = id ? parseConfiguration(file, source).toJS().profiles?.[id] as RawProfile | undefined : undefined;
    if (id && !profile) throw new Error('Profile no longer exists');
    return { file, id, ...saved, profile };
  } catch (error) {
    if (id) throw error;
    return { file, target: file, mode: 0o600, error };
  }
}

/** The document path of a profile; an unquoted numeric ID is keyed by its number. */
function profilePath(document: Document, id: string): unknown[] {
  const profiles = document.get('profiles', true);
  return ['profiles', (isMap(profiles) && profiles.items.find(pair => isScalar(pair.key) && String(pair.key.value) === id)?.key) || id];
}

/** Replaces aliases inside the node at path, or pointing into it, with copies, so editing it changes nothing else. */
function unshare(document: Document, path: unknown[]) {
  for (let copied = true; copied;) {
    copied = false;
    const inside = new Set<unknown>();
    const target = document.getIn(path, true);
    if (isNode(target)) visit(target, (_, node) => { inside.add(node); });
    visit(document, {
      Alias(_, alias) {
        const source = alias.resolve(document);
        if (!source || !inside.has(alias) && !inside.has(source)) return;
        const copy = source.clone() as typeof source;
        visit(copy, { Value(_, node) { node.anchor = undefined; } });
        copied = true;
        return copy;
      },
    });
  }
}

/** Applies explicit field edits to one profile, leaving the rest of the document, including comments, in place. */
function applyChanges(document: Document, id: string, changes: Changes) {
  const root = profilePath(document, id);
  if (!document.hasIn(root)) document.setIn(root, document.createNode({}));
  unshare(document, root);
  for (const path of changes.reset) {
    const keys = path.split('.');
    document.deleteIn([...root, ...keys]);
    for (let length = keys.length - 1; length > 0; length--) {
      const table = document.getIn([...root, ...keys.slice(0, length)], true);
      if (!isMap(table) || table.items.length) break;
      document.deleteIn([...root, ...keys.slice(0, length)]);
    }
  }
  const set = (path: unknown[], value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (value !== undefined) document.setIn(path, value);
      return;
    }
    // A credential replaces the whole mapping; the keys it keeps retain their comments.
    const node = document.getIn(path, true);
    if ('source' in value && isMap(node)) node.items = node.items.filter(pair => isScalar(pair.key) && Object.hasOwn(value, String(pair.key.value)));
    for (const [key, child] of Object.entries(value)) set([...path, key], child);
  };
  set(root, changes.values);
  if (changes.tags !== undefined) document.setIn([...root, 'tags'], changes.tags);
  return profileSchema.parse(document.toJS().profiles[id]);
}

export function prepareProfile(catalog: Catalog, draft: Draft, changes: Changes, id?: string) {
  if (draft.error) throw draft.error;
  id = profileIdSchema.parse(id ?? draft.id);
  if (draft.id && id !== draft.id) throw new Error('Profile ID cannot be changed');
  const document = parseConfiguration(draft.file, draft.source ?? emptyConfiguration);
  if (!draft.id && (catalog.profiles.some(profile => profile.id === id) || document.hasIn(profilePath(document, id)))) throw new Error('Profile ID already exists');
  const profile = applyChanges(document, id, changes);
  const source = document.toString({ lineWidth: 0 });
  return { id, source, profile, catalog: loadCatalog(catalog.file, source) };
}

/** Refuses a changed source or target before the atomic replacement. */
function saveDocument(draft: Draft, source: string) {
  const current = snapshot(draft.file);
  if (current.source !== draft.source || current.target !== draft.target) throw new Error('Configuration changed on disk; reopen the profile');
  if (current.source !== undefined) accessSync(draft.file, constants.W_OK);
  writeAtomic(current.target, source, current.mode);
}

export function saveProfile(draft: Draft, prepared: ReturnType<typeof prepareProfile>) {
  saveDocument(draft, prepared.source);
  Object.assign(draft, { source: prepared.source, id: prepared.id, profile: prepared.profile });
}

/** Resolves an unsaved draft as a connection without a profile. */
export function resolveDraft(catalog: Catalog, draft: Draft, changes: Changes): Spec {
  const { tags: _tags, ...spec } = applyChanges(new Document({ profiles: { draft: draft.profile ?? {} } }), 'draft', changes);
  return resolveSpec(catalog, undefined, locate(spec, draft.file));
}

/** Saves application preferences, leaving the rest of the document in place. */
export function saveSettings(catalog: Catalog, patch: Partial<Settings>): Catalog {
  const draft = profileDraft(catalog);
  if (draft.error) throw draft.error;
  const document = parseConfiguration(draft.file, draft.source ?? emptyConfiguration);
  for (const [key, value] of Object.entries(settingsSchema.partial().parse(patch))) document.setIn(['settings', key], value);
  const source = document.toString({ lineWidth: 0 });
  const next = loadCatalog(catalog.file, source);
  saveDocument(draft, source);
  return next;
}
