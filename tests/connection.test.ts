import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Askpass } from '../src/main/askpass';
import type { RemoteHelper } from '../src/main/remote-helper';
import { ConnectionController } from '../src/main/connection';
import { Sessions } from '../src/main/sessions';
import { SshConnection } from '../src/main/ssh-connection';
import { TerminalController } from '../src/main/terminal';
import { Configuration } from '../src/core/configuration';
import { defaultSettings } from '../src/shared';

function catalog() {
  return { file: '', defaults: { host: 'example.invalid' }, settings: { ...defaultSettings, remoteSessionIntegration: false },
    profiles: [{ id: 'inherit', tags: [], spec: {} }, { id: 'override', tags: [], spec: { remote_sessions: false, terminal: { font_size: 18 } } }] };
}

test('configuration broadcasts resolve overrides per connection and unsubscribe on disposal', async () => {
  const config = new Configuration(catalog());
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-configuration-'));
  const inherited = new ConnectionController('a', {}, 'inherit', config, directory, {} as Askpass, '', () => {}, () => {}, () => {}, () => {}, new Map());
  const overridden = new ConnectionController('b', {}, 'override', config, directory, {} as Askpass, '', () => {}, () => {}, () => {}, () => {}, new Map());
  const commands: boolean[] = [];
  let stopped = 0;
  inherited.info.status = overridden.info.status = 'connected';
  inherited.helper = { reconfigure: () => commands.push(Boolean(inherited.info.remoteSessions)), stop: () => { stopped++; } } as unknown as RemoteHelper;
  try {
    config.publish({ ...catalog(), settings: { ...defaultSettings, remoteSessionIntegration: true, terminalFontSize: 22 } });
    assert.ok(inherited.info.remoteSessions);
    assert.equal(overridden.info.remoteSessions, undefined);
    assert.equal(overridden.helper, undefined);
    assert.deepEqual(commands, [true]);
    assert.equal(inherited.info.terminal.font_size, 22);
    assert.equal(overridden.info.terminal.font_size, 18);
    config.publish({ ...config.catalog, settings: { ...config.catalog.settings, appearance: 'light' } });
    assert.deepEqual(commands, [true]);
    config.publish({ ...config.catalog, settings: { ...config.catalog.settings, remoteSessionIntegration: false } });
    assert.equal(inherited.info.remoteSessions, undefined);
    assert.equal(stopped, 1);
    await inherited.disconnect();
    assert.equal(config.listenerCount('changed'), 2);
    config.publish({ ...config.catalog, profiles: [{ id: 'inherit', tags: [], spec: { terminal: { font_size: 24 } } }, ...config.catalog.profiles.slice(1)] });
    assert.equal(inherited.info.terminal.font_size, 24);
    await inherited.dispose();
    assert.equal(config.listenerCount('changed'), 1);
    config.publish({ ...config.catalog, profiles: [{ id: 'inherit', tags: [], spec: { terminal: { font_size: 30 } } }] });
    assert.equal(inherited.info.terminal.font_size, 24);
    assert.equal(overridden.info.terminal.font_size, 22);
    assert.equal(overridden.spec.remote_sessions, undefined);
    await overridden.disconnect();
    await assert.rejects(overridden.connect(), /Unknown profile/);
  } finally { await inherited.dispose(); await overridden.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('a connection retains its controller and terminal ownership across transport replacements', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bartizan-lifecycle-'));
  const config = new Configuration(catalog());
  const attempts: SshConnection[] = [];
  t.mock.method(SshConnection.prototype, 'start', async function (this: SshConnection) { attempts.push(this); });
  t.mock.method(SshConnection.prototype, 'stop', async function (this: SshConnection) { (this as unknown as { finish(): void }).finish(); });
  const sessions = new Sessions(directory, {} as Askpass, '', () => {}, () => {}, () => {}, config);
  try {
    const id = await sessions.create({}, 'inherit', undefined, false);
    const controller = sessions.get(id);
    const terminal = new TerminalController(controller, () => {});
    controller.terminals.set(terminal.info.id, terminal); sessions.terminals.set(terminal.info.id, terminal);
    await controller.disconnect();
    assert.equal(sessions.get(id), controller);
    assert.equal(controller.terminals.get(terminal.info.id), terminal);
    assert.equal(terminal.info.status, 'closed');
    await controller.connect(false);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1]);
    assert.equal(sessions.get(id), controller);
    assert.equal(sessions.terminalOwner(terminal.info.id), controller);
    await controller.disconnect(); await sessions.remove(id);
    assert.equal(sessions.entries.size, 0);
    assert.equal(sessions.terminals.size, 0);
    assert.equal(config.listenerCount('changed'), 0);
  } finally { await sessions.close(); rmSync(directory, { recursive: true, force: true }); }
});
