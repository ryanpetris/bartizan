import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withDirectory, launch, modalOf } from './lib/harness.mjs';

async function openProfiles(page) {
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  const dialog = (await modalOf(page)).locator('#profiles-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
async function closeProfiles(page) {
  const dialog = (await modalOf(page)).locator('#profiles-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

await withDirectory('config', async (directory, cleanup) => {
  const data = join(directory, 'state');
  const file = join(data, 'config.yaml');
  let app;
  cleanup(() => app?.close());
  const start = async config => {
    const previous = app;
    app = undefined;
    await previous?.close();
    app = await launch(directory, config);
    return app;
  };
  /** Saves a profile through the profile form's API and waits until the application lists it. */
  const saveProfile = async (id, expectedFile) => {
    const draft = await app.api('profileDraft');
    assert.equal(draft.file, expectedFile);
    await app.api('profileSave', { token: draft.token, id, values: { host: 'example.invalid' }, reset: [], connect: false });
    await app.waitState(s => s.profiles.some(p => p.id === id), `profile ${id}`);
  };

  let { page, state, waitState } = await start();
  assert.equal((await state()).file, file);
  assert.equal(await readFile(file, 'utf8'), 'version: 1\n');
  let dialog = await openProfiles(page);
  await expect(dialog).toContainText('No Profiles');
  assert.doesNotMatch(await dialog.innerText(), /config\.yaml/);
  await closeProfiles(page);
  await saveProfile('fixture', file);
  assert.equal(parse(await readFile(file, 'utf8')).profiles.fixture.host, 'example.invalid');
  console.log('The first launch creates the default configuration, and profiles save to it.');

  const source = 'version: 1\ndefaults:\n  port: 2201\nprofiles:\n  fixture:\n    host: example.invalid\n';
  await writeFile(file, source);
  dialog = await openProfiles(page);
  const reload = dialog.getByRole('button', { name: 'Reload Configuration', exact: true });
  await reload.click();
  await waitState(s => s.defaults.port === 2201, 'reloaded defaults');
  await writeFile(file, 'version: [\n');
  await reload.click();
  await expect(dialog.getByRole('alert')).toContainText('Invalid YAML');
  const failed = await waitState(s => s.configError, 'configuration error');
  assert.equal(failed.defaults.port, 2201);
  assert.deepEqual(failed.profiles.map(p => p.id), ['fixture']);
  await writeFile(file, source);
  await reload.click();
  await expect(dialog.getByRole('alert')).toBeHidden();
  await waitState(s => !s.configError, 'recovered configuration');
  await closeProfiles(page);
  console.log('Reloading applies a changed configuration and keeps the last valid one when the file is malformed.');

  const executable = await app.application.evaluate(({ app }) => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }));
  const other = join(directory, 'other.yaml');
  const child = spawn(executable.path, [...executable.args, '--config', other], { cwd: directory, env: { ...process.env, BARTIZAN_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
  } finally { clearTimeout(timer); }
  const after = await state();
  assert.equal(after.file, file);
  assert.equal(after.defaults.port, 2201);
  await assert.rejects(access(other), { code: 'ENOENT' });
  console.log('A second instance exits without creating or opening its configuration.');

  ({ state } = await start());
  assert.deepEqual((await state()).profiles.map(p => p.id), ['fixture']);
  const custom = join(directory, 'nested', 'custom.yml');
  ({ state } = await start(custom));
  const fresh = await state();
  assert.equal(fresh.file, custom);
  assert.equal(fresh.configError, undefined);
  assert.deepEqual(fresh.profiles, []);
  await saveProfile('custom', custom);
  assert.equal(parse(await readFile(custom, 'utf8')).profiles.custom.host, 'example.invalid');
  ({ state } = await start());
  const restored = await state();
  assert.equal(restored.file, file);
  assert.deepEqual(restored.profiles.map(p => p.id), ['fixture']);
  assert.deepEqual(app.errors, []);
  console.log('An explicit --config path is created and used for that launch only; the default configuration is kept.');
});
