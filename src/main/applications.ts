import { randomUUID } from 'node:crypto';
import type { Workspace } from '../shared';
import type { Sessions } from './sessions';
import type { Browsers } from './browser';

export const applications = { vscode: 'Visual Studio Code' };

/** Associates remote launches with browser sessions; only Electron creates this controller. */
export class Applications {
  private launches = new Map<string, Workspace>();
  constructor(private sessions: Sessions, private browsers: Browsers, private changed: () => void) {
    sessions.messages.listen(({ connectionId, message }) => {
      if (message.type === 'helper.error') {
        for (const workspace of this.launches.values()) if (workspace.connectionId === connectionId) this.failed(workspace, message.message);
      } else if ('launchId' in message) {
        const workspace = this.launches.get(message.launchId);
        if (!workspace || workspace.connectionId !== connectionId || !workspace.application) return;
        workspace.application.event = message;
        if (message.type === 'applications.ready') {
          const tab = workspace.tabs[0];
          // The navigation settles after this state reaches the page, so the page a previous launch left goes with it.
          if (tab) {
            tab.error = undefined; tab.url = '';
            void browsers.action(workspace.id, 'navigate', tab.id, message.view.url).catch(() => this.failed(workspace, 'Could not open application'));
          }
        }
        this.changed();
      }
    });
  }
  async open(connectionId: string, application: keyof typeof applications) {
    const connection = this.sessions.entries.get(connectionId);
    if (!connection || connection.info.status !== 'connected') throw new Error('Connection is not connected');
    const launchId = randomUUID();
    const id = await this.browsers.open(connection, undefined, 'new', false, { name: applications[application], application: { application, launchId, event: { type: 'applications.progress', launchId, phase: 'checking' } } });
    const workspace = this.browsers.entries.get(id)!.info;
    this.start(workspace, application, launchId);
    return id;
  }
  private start(workspace: Workspace, application: string, launchId = randomUUID()) {
    const connection = this.sessions.entries.get(workspace.connectionId);
    workspace.application = { application, launchId, event: { type: 'applications.progress', launchId, phase: 'checking' } };
    this.launches.set(launchId, workspace);
    if (!connection || connection.info.status !== 'connected') { this.failed(workspace, 'Connection disconnected'); return; }
    connection.applications = true;
    this.sessions.syncIntegration(connection);
    this.changed();
    void this.sessions.messages.send(workspace.connectionId, { type: 'applications.launch', launchId, application }).catch(error => {
      if (workspace.application?.launchId === launchId) this.failed(workspace, error instanceof Error ? error.message : 'Application launch failed');
    });
  }
  private failed(workspace: Workspace, message: string) {
    if (!workspace.application || workspace.application.event.type === 'applications.ended') return;
    workspace.application.event = { type: 'applications.ended', launchId: workspace.application.launchId, reason: 'failed', error: { code: 'connection_failed', message } };
    this.changed();
  }
  retry(id: string) {
    const workspace = this.browsers.entries.get(id)?.info;
    if (!workspace?.application || workspace.application.event.type !== 'applications.ended') throw new Error('Application is not stopped');
    this.launches.delete(workspace.application.launchId);
    this.start(workspace, workspace.application.application);
  }
  async respond(id: string, consentId: string, accepted: boolean) {
    const workspace = this.browsers.entries.get(id)?.info, state = workspace?.application;
    if (!workspace || state?.event.type !== 'applications.consent' || state.event.consentId !== consentId) throw new Error('Consent request expired');
    await this.sessions.messages.send(workspace.connectionId, { type: 'applications.respond', launchId: state.launchId, consentId, accepted });
    if (accepted && state.event.type === 'applications.consent') {
      state.event = { type: 'applications.progress', launchId: state.launchId, phase: 'starting' };
      this.changed();
    }
  }
  sync() {
    for (const [id, workspace] of this.launches) {
      if (!this.browsers.entries.has(workspace.id) || !workspace.tabs.length) {
        this.launches.delete(id);
        void this.sessions.messages.send(workspace.connectionId, { type: 'applications.stop', launchId: id }).catch(() => {});
        if (this.browsers.entries.has(workspace.id)) void this.browsers.close(workspace.id, true);
      } else if (this.sessions.entries.get(workspace.connectionId)?.info.status !== 'connected' && workspace.application?.event.type !== 'applications.ended') {
        // State publication is already in progress; avoid reentering changed().
        workspace.application!.event = { type: 'applications.ended', launchId: id, reason: 'failed', error: { code: 'disconnected', message: 'Connection disconnected' } };
      } else if (workspace.application?.event.type === 'applications.ready' && workspace.application.page !== 'open') {
        const tab = workspace.tabs[0], launch = workspace.application;
        // The view belongs to the application once a page it loaded has settled, after which it navigates itself.
        if (tab?.loading) launch.page = 'loading';
        else if (launch.page === 'loading' && tab?.url && !tab.error) launch.page = 'open';
      }
    }
    for (const connection of this.sessions.entries.values()) {
      connection.applications = [...this.launches.values()].some(workspace => workspace.connectionId === connection.info.id && workspace.application?.event.type !== 'applications.ended');
    }
    this.sessions.syncIntegration();
  }
}
