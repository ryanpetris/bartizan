import { randomUUID } from 'node:crypto';
import type { ApplicationMessage, ApplicationState } from '../helper-messages';
import type { ConnectionController } from './connection';
import type { BrowserSession } from './browser-session';

export const applications = { vscode: 'Visual Studio Code' };

/** One remote launch and the browser session displaying it. */
export class ApplicationSession {
  id: string;
  static initial(application: string, launchId: string = randomUUID()): ApplicationState {
    return { application, launchId, event: { type: 'applications.progress', launchId, phase: 'checking' } };
  }
  constructor(readonly connection: ConnectionController, readonly browser: BrowserSession, readonly application: string) { this.id = browser.info.application!.launchId; }
  start() {
    this.browser.info.application = ApplicationSession.initial(this.application, this.id);
    this.connection.applications.set(this.id, this);
    if (this.connection.info.status !== 'connected') { this.fail('Connection disconnected'); return; }
    this.connection.updateApplications();
    this.connection.changed();
    const id = this.id;
    void this.connection.sendHelperMessage({ type: 'applications.launch', launchId: id, application: this.application }).catch(error => {
      if (this.id === id) this.fail(error instanceof Error ? error.message : 'Application launch failed');
    });
  }
  receive(message: ApplicationMessage) {
    const state = this.browser.info.application!;
    state.event = message;
    if (message.type === 'applications.ready') {
      const tab = this.browser.info.tabs[0];
      if (tab) {
        tab.error = undefined; tab.url = '';
        void this.browser.action('navigate', tab.id, message.view.url).catch(() => this.fail('Could not open application'));
      }
    }
    if (message.type === 'applications.ended') this.release();
    this.browserChanged();
    this.connection.changed();
  }
  private release() { this.connection.applications.delete(this.id); this.connection.updateApplications(); }
  fail(message: string) {
    const state = this.browser.info.application;
    if (!state || state.event.type === 'applications.ended') return;
    state.event = { type: 'applications.ended', launchId: this.id, reason: 'failed', error: { code: 'connection_failed', message } };
    this.release(); this.connection.changed();
  }
  retry() {
    if (this.browser.closed || this.browser.info.application?.event.type !== 'applications.ended') throw new Error('Application is not stopped');
    this.id = randomUUID(); this.start();
  }
  async respond(consentId: string, accepted: boolean) {
    const state = this.browser.info.application!;
    if (state.event.type !== 'applications.consent' || state.event.consentId !== consentId) throw new Error('Consent request expired');
    await this.connection.sendHelperMessage({ type: 'applications.respond', launchId: this.id, consentId, accepted });
    if (accepted && state.event.type === 'applications.consent') {
      state.event = { type: 'applications.progress', launchId: this.id, phase: 'starting' };
      this.connection.changed();
    }
  }
  browserChanged() {
    if (this.browser.closed) return;
    if (!this.browser.tabs.size) { void this.browser.close(true); return; }
    const launch = this.browser.info.application!;
    if (launch.event.type === 'applications.ready' && launch.page !== 'open') {
      const tab = this.browser.info.tabs[0];
      if (tab?.loading) launch.page = 'loading';
      else if (launch.page === 'loading' && tab?.url && !tab.error) launch.page = 'open';
    }
  }
  close() {
    void this.connection.sendHelperMessage({ type: 'applications.stop', launchId: this.id }).catch(() => {});
    this.release();
  }
}
