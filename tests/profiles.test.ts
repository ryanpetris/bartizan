import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify as yaml } from 'yaml';
import { loadCatalog, parseConfiguration, resolveSpec } from '../src/core/config';
import { profileDraft, prepareProfile, saveProfile, resolveDraft } from '../src/core/profiles';

const changes = { token: '00000000-0000-4000-8000-000000000000', values: {}, reset: [] };
test('edits preserve other profiles, defaults, comments, raw paths and secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-profiles-'));
  try {
    const file = join(dir, 'profiles.yaml');
    const document = { version: 1, defaults: { port: 2222 }, profiles: {
      edited: { host: 'example.invalid', port: 22, tags: [' Team '], auth: { identity_files: ['keys/key'], password: { source: 'literal', value: 'secret' } } },
      other: { host: 'other.invalid', username: 'other' },
    } };
    writeFileSync(file, `# team profiles\n${yaml(document)}`.replace('  other:', '  # kept beside other\n  other:'));
    chmodSync(file, 0o640);
    const catalog = loadCatalog(file), draft = profileDraft(catalog, 'edited');
    const edit = { ...changes, values: { username: '' }, reset: ['port' as const] };
    const prepared = prepareProfile(catalog, draft, edit);
    const resolved = resolveDraft(catalog, draft, edit);
    assert.equal(resolved.username, '');
    assert.equal(resolved.auth?.identity_files?.[0], join(dir, 'keys/key'));
    saveProfile(draft, prepared);
    const raw = parseConfiguration(file).toJS() as typeof document;
    assert.match(readFileSync(file, 'utf8'), /^# team profiles\n[^]*  # kept beside other\n  other:/);
    assert.deepEqual(raw.defaults, document.defaults);
    assert.deepEqual(raw.profiles.other, document.profiles.other);
    assert.deepEqual(raw.profiles.edited.auth, document.profiles.edited.auth);
    assert.deepEqual(raw.profiles.edited.tags, document.profiles.edited.tags);
    assert.equal(Object.hasOwn(raw.profiles.edited, 'port'), false);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.equal(resolveSpec(loadCatalog(file), 'edited', {}).port, 2222);
    assert.equal(resolveSpec(loadCatalog(file), 'edited', {}).username, '');
    const next = prepareProfile(prepared.catalog, draft, { ...changes, values: { auth: { password: { source: 'prompt' } } }, tags: [] });
    saveProfile(draft, next);
    assert.deepEqual((parseConfiguration(file).toJS() as typeof document).profiles.edited.auth.password, { source: 'prompt' });
    if (process.getuid?.() !== 0) {
      const before = readFileSync(file, 'utf8');
      chmodSync(file, 0o400);
      assert.throws(() => saveProfile(draft, prepareProfile(next.catalog, draft, { ...changes, values: { label: 'Read only' } })), /EACCES/);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new profiles can be incomplete, IDs stay unique, and source changes never get overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-profiles-'));
  try {
    const file = join(dir, 'profiles.yaml'), catalog = loadCatalog(file, 'version: 1'), draft = profileDraft(catalog);
    const prepared = prepareProfile(catalog, draft, changes, 'new');
    assert.throws(() => resolveSpec(prepared.catalog, 'new', {}));
    saveProfile(draft, prepared);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => prepareProfile(prepared.catalog, profileDraft(prepared.catalog), changes, 'new'), /already exists/);
    const second = profileDraft(prepared.catalog);
    saveProfile(second, prepareProfile(prepared.catalog, second, { ...changes, values: { label: 'Second' }, tags: ['team'] }, 'second'));
    assert.deepEqual(loadCatalog(file).profiles.map(profile => [profile.id, profile.spec.label, profile.tags]), [['new', undefined, []], ['second', 'Second', ['team']]]);
    const editing = profileDraft(loadCatalog(file), 'new');
    const edit = prepareProfile(loadCatalog(file), editing, { ...changes, values: { host: 'example.invalid' } });
    const external = readFileSync(file, 'utf8') + '\n# external edit\n';
    writeFileSync(file, external);
    assert.throws(() => saveProfile(editing, edit), /changed on disk/);
    assert.equal(readFileSync(file, 'utf8'), external);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new draft paths agree across connection actions and a bad destination only prevents saving', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-profiles-'));
  try {
    const file = join(dir, 'profiles.yaml'), catalog = loadCatalog(file, 'version: 1');
    const edit = { ...changes, values: { host: 'example.invalid', auth: { identity_files: ['key'] } } };
    const draft = profileDraft(catalog);
    const prepared = prepareProfile(catalog, draft, edit, 'test');
    assert.deepEqual(resolveDraft(catalog, draft, edit).auth?.identity_files, resolveSpec(prepared.catalog, 'test', {}).auth?.identity_files);
    writeFileSync(file, 'version: [');
    const bad = profileDraft(catalog);
    assert.equal(resolveDraft(catalog, bad, edit).host, 'example.invalid');
    assert.throws(() => prepareProfile(catalog, bad, edit, 'test'));
    assert.equal(readFileSync(file, 'utf8'), 'version: [');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saving through a symlink retains the link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bartizan-profiles-'));
  try {
    const target = join(dir, 'target.yaml'), link = join(dir, 'link.yaml');
    writeFileSync(target, 'version: 1\nprofiles:\n  test:\n    host: example.invalid\n');
    symlinkSync(target, link);
    const catalog = loadCatalog(link), draft = profileDraft(catalog, 'test');
    saveProfile(draft, prepareProfile(catalog, draft, { ...changes, values: { port: 2222 } }));
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(loadCatalog(target).profiles[0].spec.port, 2222);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edits change only the edited profile when keys are numeric or nodes are shared', () => {
  const file = join(tmpdir(), 'bartizan-shared.yaml');
  const edit = (source: string, id: string, values: object) => {
    const catalog = loadCatalog(file, source);
    const draft = { file, id, source, target: file, mode: 0o600 };
    const prepared = prepareProfile(catalog, draft, { ...changes, values });
    return { source: prepared.source, specs: Object.fromEntries(prepared.catalog.profiles.map(profile => [profile.id, profile.spec])) };
  };
  assert.deepEqual(edit('version: 1\nprofiles:\n  1:\n    host: one.invalid\n', '1', { username: 'new' }).specs['1'], { host: 'one.invalid', username: 'new' });
  assert.throws(() => loadCatalog(file, 'version: 1\nprofiles:\n  1:\n    host: one.invalid\n  "1":\n    host: two.invalid\n'), /Invalid YAML/);
  const shared = 'version: 1\nprofiles:\n  first: &shared\n    host: first.invalid\n    auth: &auth\n      method: key\n  second: *shared\n  third:\n    host: third.invalid\n    auth: *auth\n';
  let result = edit(shared, 'second', { username: 'new' });
  assert.deepEqual(result.specs.first, { host: 'first.invalid', auth: { method: 'key' } });
  assert.deepEqual(result.specs.second, { host: 'first.invalid', username: 'new', auth: { method: 'key' } });
  result = edit(shared, 'first', { host: 'changed.invalid', auth: { method: 'agent' } });
  assert.deepEqual(result.specs.second, { host: 'first.invalid', auth: { method: 'key' } });
  assert.deepEqual(result.specs.third, { host: 'third.invalid', auth: { method: 'key' } });
  assert.match(result.source, /first: &shared/);
  const within = 'version: 1\nprofiles:\n  a:\n    host: a.invalid\n    auth:\n      password: &s {source: prompt}\n      passphrase: *s\n';
  const draft = { file, id: 'a', source: within, target: file, mode: 0o600, profile: parse(within).profiles.a };
  assert.deepEqual(resolveDraft(loadCatalog(file, within), draft, { ...changes, values: { auth: { password: { source: 'literal', value: 'new' } } } }).auth?.passphrase, { source: 'prompt' });
  const commented = 'version: 1\nprofiles:\n  a:\n    host: a.invalid\n    auth:\n      password: # production\n        source: literal # source\n        value: old # rotate\n';
  result = edit(commented, 'a', { auth: { password: { source: 'literal', value: 'new' } } });
  assert.match(result.source, /password:\n *# production\n *source: literal # source\n *value: new # rotate\n/);
  result = edit(commented, 'a', { auth: { password: { source: 'file', path: 'secret' } } });
  assert.match(result.source, /password:\n *# production\n *source: file # source\n *path: secret\n/);
});
