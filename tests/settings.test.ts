import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsSchema } from '../src/core/settings';
import { defaultSettings } from '../src/shared';
import { ensureConfiguration, loadCatalog, parseConfiguration } from '../src/core/config';
import { profileDraft, prepareProfile, saveProfile, saveSettings } from '../src/core/profiles';

test('settings and profiles persist together without losing unrelated values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-settings-'));
  const file = join(directory, 'config.yaml');
  try {
    ensureConfiguration(file);
    let catalog = loadCatalog(file);
    assert.deepEqual(catalog.settings, defaultSettings);
    const draft = profileDraft(catalog);
    const prepared = prepareProfile(catalog, draft, { token: '00000000-0000-4000-8000-000000000000', values: { host: 'example.invalid' }, reset: [] }, 'fixture');
    saveProfile(draft, prepared);
    const settings = { ...defaultSettings, interfaceFont: '', remoteSessionIntegration: false, terminalLigatures: false, terminalWebgl: true, appearance: 'system' as const, terminalFont: 'DejaVu Sans Mono', terminalFontSize: 18 };
    catalog = saveSettings(prepared.catalog, settings);
    assert.deepEqual(loadCatalog(file).settings, settings);
    assert.equal(catalog.profiles[0].spec.host, 'example.invalid');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = readFileSync(file, 'utf8');
    for (const patch of [{ terminalFontSize: 0 }, { terminalFontSize: 33 }, { terminalFontSize: 12.5 }, { terminalFont: 'bad\nfont' }, { terminalFont: 'x'.repeat(257) }, { appearance: 'automatic' }, { terminalWebgl: 'false' }, { unknown: true }]) {
      assert.equal(settingsSchema.safeParse({ ...settings, ...patch }).success, false);
    }
    assert.throws(() => saveSettings(catalog, { terminalFontSize: NaN }));
    assert.equal(readFileSync(file, 'utf8'), before);
    const edited = profileDraft(catalog, 'fixture');
    const changed = prepareProfile(catalog, edited, { token: '00000000-0000-4000-8000-000000000000', values: { port: 2222, remote_sessions: true, terminal: { font: '', font_size: 20, ligatures: true, webgl: true } }, reset: [] });
    saveProfile(edited, changed);
    assert.deepEqual(loadCatalog(file).settings, settings);
    assert.equal(loadCatalog(file).profiles[0].spec.port, 2222);
    assert.equal(loadCatalog(file).profiles[0].spec.remote_sessions, true);
    assert.deepEqual(loadCatalog(file).profiles[0].spec.terminal, { font: '', font_size: 20, ligatures: true, webgl: true });
    saveSettings(catalog, { appearance: 'light' });
    assert.equal(loadCatalog(file).profiles[0].spec.port, 2222);
    assert.equal(loadCatalog(file).profiles[0].spec.remote_sessions, true);
    assert.deepEqual(loadCatalog(file).profiles[0].spec.terminal, { font: '', font_size: 20, ligatures: true, webgl: true });
    assert.deepEqual(loadCatalog(file).settings, { ...settings, appearance: 'light' });
    const resetDraft = profileDraft(loadCatalog(file), 'fixture');
    const reset = prepareProfile(loadCatalog(file), resetDraft, { token: '00000000-0000-4000-8000-000000000000', values: {}, reset: ['remote_sessions', 'terminal.font', 'terminal.font_size', 'terminal.ligatures', 'terminal.webgl'] });
    saveProfile(resetDraft, reset);
    assert.equal(loadCatalog(file).profiles[0].spec.terminal, undefined);
    assert.equal(loadCatalog(file).profiles[0].spec.remote_sessions, undefined);
    assert.ok(parseConfiguration(file).toJS().settings);
    writeFileSync(file, 'invalid source');
    assert.throws(() => saveSettings(catalog, { appearance: 'dark' }));
    assert.equal(readFileSync(file, 'utf8'), 'invalid source');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
