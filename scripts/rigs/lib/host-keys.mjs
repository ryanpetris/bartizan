import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { openProfiles } from './profile-launch.mjs';

export async function testHostKeyPins(app, config, publicKey) {
  const { application, page, state, api } = app;
  const original = await readFile(config, 'utf8');
  const fingerprint = execFileSync('ssh-keygen', ['-lf', publicKey, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1];
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
    for (const policy of ['ask', 'strict', 'accept-new', 'off']) {
      await page.evaluate(() => { window.rigPinOutput = ''; window.rigPinPrompts = []; });
      await pinned({ policy, fingerprints: [wrong] }, { passphrase: { source: 'prompt' } });
      const id = await api('connect', { profileId: 'pinned' });
      await wait(id, 'closed');
      assert.match(await page.evaluate(() => window.rigPinOutput), /fingerprint does not match configured pins/);
      assert.equal(await page.evaluate(() => window.rigPinPrompts.length), 0);
      await api('removeConnection', id);
    }
    await pinned({ policy: 'off', fingerprints: [wrong, fingerprint] });
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
    const document = parse(original);
    document.defaults = { host_keys: { fingerprints: [fingerprint] } };
    await writeFile(config, stringify(document));
    await api('reloadConfig');
    const edit = async () => (await openProfiles(page)).locator('.profile-row[data-id="rig"] .profile-edit').click();
    await edit();
    await page.locator('#tab-host-keys').click();
    const field = page.locator('[data-path="host_keys.fingerprints"]');
    const mode = field.locator('select');
    await expect(mode).toHaveValue('');
    await expect(mode.locator('option:checked')).toContainText(fingerprint);
    await mode.selectOption('custom');
    await page.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field.locator('.field-error')).toHaveText('Add at least one fingerprint');
    await field.getByRole('textbox').fill('SHA256:invalid');
    await page.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field.locator('.field-error')).toBeVisible();
    assert.equal((await state()).connections.length, 0);
    await field.getByRole('textbox').fill(fingerprint);
    await page.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    const custom = await api('connect', { profileId: 'rig' });
    await wait(custom, 'connected');
    assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').spec.host_keys.fingerprints, [fingerprint]);
    await close(custom);
    await edit();
    await page.locator('#tab-host-keys').click();
    await mode.selectOption('none');
    await field.getByRole('button', { name: 'Reset Fingerprints' }).click();
    await expect(mode).toHaveValue('');
    await mode.selectOption('none');
    await page.locator('#connection-dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    const cleared = await api('connect', { profileId: 'rig' });
    await wait(cleared, 'connected');
    assert.deepEqual((await state()).profiles.find(p => p.id === 'rig').spec.host_keys.fingerprints, []);
    await close(cleared);
    console.log('Host key pins reject cached mismatches before authentication under every policy, accept matching keys in multiplexed terminals, preserve trust files, and support form inheritance, validation and explicit clearing.');
  } finally {
    await page.evaluate(() => window.rigPinOff());
    await writeFile(config, original);
    await api('reloadConfig');
  }
}
