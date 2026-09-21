import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Processes } from '../src/main/processes';
import { ApplicationSession } from '../src/main/application-session';
import type { ConnectionController } from '../src/main/connection';
import type { BrowserSession } from '../src/main/browser-session';
import type { RemoteProcess } from '../src/shared';
import type { ApplicationState, HelperRequest } from '../src/helper-messages';

test('process reports replace UUID records, clear absent fields and publish isolated snapshots', () => {
  const published: RemoteProcess[][] = [];
  const processes = new Processes(snapshot => published.push(snapshot));
  processes.report({ id: 'one', name: 'Helper', status: 'starting' });
  processes.report({ id: 'one', name: 'Helper', status: 'running', pid: 123 });
  processes.report({ id: 'one', name: 'Helper', status: 'retrying', message: 'Disconnected' });
  assert.equal(published[1][0].pid, 123);
  assert.equal(processes.snapshot()[0].pid, undefined);
  published[2][0].name = 'Modified consumer';
  assert.equal(processes.snapshot()[0].name, 'Helper');
  processes.report({ id: 'one', status: 'stopped' });
  processes.report({ id: 'unknown', status: 'stopped' });
  assert.deepEqual(processes.snapshot(), []);
});

test('application records precede commands and survive tab closure until remote cleanup', async () => {
  const processes = new Processes(() => {});
  const applications = new Map<string, ApplicationSession>();
  const sent: HelperRequest[] = [];
  const connection = {
    processes, applications, info: { status: 'connected' }, changed() {}, setHelperNeeded() {},
    async sendHelperMessage(message: HelperRequest) {
      assert.ok(processes.snapshot().some(record => record.id === ('launchId' in message ? message.launchId : undefined)), 'record is published before command');
      sent.push(message);
    },
  } as unknown as ConnectionController;
  const state: ApplicationState = ApplicationSession.initial('vscode');
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<void>((resolve, reject) => { rejectNavigation = reject; });
  const browser = { info: { application: state, tabs: [{ id: 'tab' }] }, tabs: new Map([['tab', {}]]), closed: false, action: () => navigation } as unknown as BrowserSession;
  const application = new ApplicationSession(connection, browser, 'vscode');
  application.start();
  assert.match(application.id, /^[0-9a-f-]{36}$/);
  assert.equal(processes.snapshot()[0].status, 'starting');
  assert.equal(processes.snapshot()[0].pid, undefined);
  application.receiveSpawned({ type: 'applications.spawned', launchId: application.id, pid: 10 });
  assert.equal(processes.snapshot()[0].pid, 10);
  application.receive({ type: 'applications.progress', launchId: application.id, phase: 'downloading', transfer: { receivedBytes: 50, totalBytes: 100 } });
  assert.equal(processes.snapshot()[0].status, 'running');
  assert.match(processes.snapshot()[0].message!, /Downloading.*50 B of 100 B/);
  application.receive({ type: 'applications.ready', launchId: application.id, view: { kind: 'browser', url: 'http://127.0.0.1:1234' } });
  browser.closed = true;
  application.close();
  application.receive({ type: 'applications.progress', launchId: application.id, phase: 'downloading' });
  assert.equal(processes.snapshot()[0].message, undefined);
  rejectNavigation(new Error('Browser tab is closed'));
  await Promise.resolve();
  assert.equal(applications.get(application.id), application);
  assert.ok(processes.snapshot().every(record => record.status === 'stopping'));
  assert.equal(sent.at(-1)!.type, 'applications.stop');
  application.receive({ type: 'applications.ended', launchId: application.id, reason: 'stopped' });
  assert.deepEqual(processes.snapshot(), []);
  assert.equal(applications.size, 0);
});
