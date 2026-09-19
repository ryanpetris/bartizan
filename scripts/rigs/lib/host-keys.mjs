import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { openConnect } from './profile-launch.mjs';

export async function testHostKeyPins(app, config, publicKey, otherPublicKey) {
  const { application, page, state, api } = app;
  const original = await readFile(config, 'utf8');
  const fingerprint = execFileSync('ssh-keygen', ['-lf', publicKey, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1];
  const key = (await readFile(publicKey, 'utf8')).trim();
  const wrongKey = (await readFile(otherPublicKey, 'utf8')).trim();
  const wrong = `SHA256:${'A'.repeat(43)}`;
  const wait = (id, status) => expect.poll(async () => (await state()).connections.find(c => c.id === id)?.status).toBe(status);
  const close = async id => { await api('disconnect', id); await api('removeConnection', id); };
  /** Writes the configuration with a `pinned` copy of the rig profile and reloads it. */
  const pinned = async (host_keys, auth = {}) => {
    const document = parse(original);
    document.profiles.pinned = { ...document.profiles.rig, host_keys, auth: { ...document.profiles.rig.auth, ...auth } };
    await writeFile(config, stringify(document));
    await api('reloadConfig');
  };
  const trustFile = join(await application.evaluate(({ app }) => app.getPath('userData')), 'ssh', 'known_hosts');
  const trust = await readFile(trustFile, 'utf8');
  await page.evaluate(() => {
    window.rigPinOutput = '';
    window.rigPinPrompts = [];
    window.rigPinOff = window.bartizan.onEvent(event => {
      if (event.type === 'data') window.rigPinOutput += event.data;
      if (event.type === 'state') window.rigPinPrompts.push(...event.state.challenges);
    });
  });
  try {
    for (const policy of ['ask', 'strict', 'accept-new', 'off']) for (const pins of [{ fingerprints: [wrong] }, { public_keys: [wrongKey] }]) {
      await page.evaluate(() => { window.rigPinOutput = ''; window.rigPinPrompts = []; });
      await pinned({ policy, ...pins }, { passphrase: { source: 'prompt' } });
      const id = await api('connect', { profileId: 'pinned' });
      await wait(id, 'closed');
      assert.match(await page.evaluate(() => window.rigPinOutput), /fingerprint does not match configured pins/);
      assert.equal(await page.evaluate(() => window.rigPinPrompts.length), 0);
      await api('removeConnection', id);
    }
    for (const pins of [{ fingerprints: [wrong, fingerprint] }, { public_keys: [key] }, { fingerprints: [wrong], public_keys: [key] }, { fingerprints: [fingerprint], public_keys: [wrongKey] }]) {
      await pinned({ policy: 'off', ...pins });
      const id = await api('connect', { profileId: 'pinned' });
      await wait(id, 'connected');
      const terminal = await api('newTerminal', id);
      await expect.poll(async () => (await state()).terminals.find(t => t.id === terminal)?.status).toBe('connected');
      const draft = await api('profileDraft', 'pinned');
      const preview = await api('profilePreview', { token: draft.token, values: {}, reset: [] });
      assert.ok(preview.includes('StrictHostKeyChecking=yes'));
      assert.ok(preview.includes('UserKnownHostsFile=none'));
      await close(id);
      assert.equal(await readFile(trustFile, 'utf8'), trust);
    }
    for (const [path, value, label, emptyError] of [['fingerprints', fingerprint, 'Fingerprints', 'Add at least one fingerprint'], ['public_keys', key, 'Public Keys', 'Add at least one public key']]) {
      const document = parse(original);
      document.defaults = { host_keys: { [path]: [value] } };
      await writeFile(config, stringify(document));
      await api('reloadConfig');
      const edit = async () => (await openConnect(page)).locator('.profile-row[data-id="rig"] .profile-edit').click();
      const dialogs = await app.modal();
      await edit();
      await dialogs.locator('#tab-host-keys').click();
      const field = dialogs.locator(`[data-path="host_keys.${path}"]`);
      const mode = field.locator('select');
      await expect(mode).toHaveValue('');
      await expect(mode.locator('option:checked')).toContainText(value);
      await mode.selectOption('custom');
      await dialogs.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(field.locator('.field-error')).toHaveText(emptyError);
      await field.getByRole('textbox').fill('SHA256:invalid');
      await dialogs.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(field.locator('.field-error')).toBeVisible();
      assert.equal((await state()).connections.length, 0);
      await field.getByRole('textbox').fill(value);
      await dialogs.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialogs.locator('#connection-dialog')).not.toBeVisible();
      const custom = await api('connect', { profileId: 'rig' });
      await wait(custom, 'connected');
      assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').spec.host_keys[path], [value]);
      await close(custom);
      await edit();
      await dialogs.locator('#tab-host-keys').click();
      await mode.selectOption('none');
      await field.getByRole('button', { name: `Reset ${label}` }).click();
      await expect(mode).toHaveValue('');
      await mode.selectOption('none');
      await dialogs.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialogs.locator('#connection-dialog')).not.toBeVisible();
      const cleared = await api('connect', { profileId: 'rig' });
      await wait(cleared, 'connected');
      assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').spec.host_keys[path], []);
      await close(cleared);
    }
    console.log('Host key pins reject cached mismatches before authentication under every policy, accept matching keys in multiplexed terminals, preserve trust files, and support form inheritance, validation and explicit clearing.');
  } finally {
    await page.evaluate(() => window.rigPinOff());
    await writeFile(config, original);
    await api('reloadConfig');
  }
}
