import { randomUUID } from 'node:crypto';
import { applications, formatBytes, type ApplicationId, type RemoteProcess } from '../shared';
import type { ApplicationMessage, ApplicationState, ApplicationSpawned } from '../helper-messages';
import type { ConnectionController } from './connection';
import type { BrowserSession } from './browser-session';

/**
 * One remote launch and the browser session displaying it, whose tab opens the launch's address. A `relaunches` launch
 * launches again when the server it uses goes away, three times in a row at most without signing in or a retry.
 */
export class ApplicationSession {
  id: string;
  private closing = false;
  private process!: RemoteProcess;
  private relaunching = false;
  private restarts = 0;
  /** Whether the tab has opened this launch's sign-in page. */
  private arrived = false;
  /** Whether the user declined this launch's consent request, which ends it as cancelled whatever ends it first. */
  private declined = false;
  static initial(application: ApplicationId, launchId: string = randomUUID()): ApplicationState {
    return { application, launchId, event: { type: 'applications.progress', launchId, phase: applications[application].updates ? 'checking' : 'starting' } };
  }
  constructor(readonly connection: ConnectionController, readonly browser: BrowserSession, readonly application: ApplicationId) { this.id = browser.info.application!.launchId; }
  get relaunches() { return !!applications[this.application].relaunches; }
  start() {
    this.relaunching = false; this.arrived = false; this.declined = false;
    this.process = { id: this.id, name: `${applications[this.application].name} Launcher`, status: 'starting' };
    this.connection.processes.report(this.process);
    this.browser.info.application = ApplicationSession.initial(this.application, this.id);
    this.connection.applications.set(this.id, this);
    if (this.connection.info.status !== 'connected') { this.fail('Connection disconnected'); return; }
    this.connection.setHelperNeeded(this, true);
    this.connection.changed();
    const id = this.id;
    void this.connection.sendHelperMessage({ type: 'applications.launch', launchId: id, application: this.application }).catch(error => {
      if (this.id === id) this.fail(error instanceof Error ? error.message : 'Application launch failed');
    });
  }
  receive(message: ApplicationMessage) {
    const state = this.browser.info.application!;
    state.event = message;
    if (message.type === 'applications.progress' && !this.closing) {
      const verbs = { checking: 'Checking for updates', downloading: 'Downloading', extracting: 'Unpacking', starting: 'Starting', loading: 'Loading' };
      const transfer = message.transfer;
      this.process.message = `${verbs[message.phase]}${message.phase !== 'checking' && message.component ? ` ${message.component}` : ''}${transfer ? ` · ${formatBytes(transfer.receivedBytes)}${transfer.totalBytes ? ` of ${formatBytes(transfer.totalBytes)}` : ''}` : ''}`;
    } else if (message.type === 'applications.consent' && !this.closing) this.process.message = 'Awaiting Approval';
    else if (message.type === 'applications.ready') {
      this.process.message = undefined;
      if (!this.closing) this.process.status = 'running';
    }
    if (message.type === 'applications.ready' && !this.closing) {
      const tab = this.browser.info.tabs[0];
      if (tab) {
        tab.error = undefined; tab.url = '';
        void this.browser.action('navigate', tab.id, message.view.url).catch(() => { if (!this.closing) this.fail('Could not open application'); });
      }
    }
    if (message.type === 'applications.ended') {
      this.process.pid = undefined;
      if (message.reason === 'failed' && !this.closing) {
        this.process.status = 'failed'; this.process.message = message.error?.message ?? `Exit code ${message.exitCode ?? 'unknown'}`;
        this.connection.processes.report(this.process);
      } else this.connection.processes.report({ id: this.id, status: 'stopped' });
      this.release();
      if (this.relaunches && message.reason === 'exited' && !this.closing && this.restarts < 3) { this.restarts++; this.relaunching = true; }
      if (this.relaunching && !this.closing && !this.browser.closed && this.connection.info.status === 'connected') { this.retry(true); return; }
    } else this.connection.processes.report(this.process);
    this.browserChanged();
    this.connection.changed();
  }
  receiveSpawned(message: ApplicationSpawned) {
    this.process.pid = message.pid;
    this.process.status = this.closing ? 'stopping' : 'running';
    this.connection.processes.report(this.process);
  }
  /** The address of the page a tab has committed to, which a navigation that has only started leaves as it was. */
  private committed(id: string) {
    const contents = this.browser.tabs.get(id)?.view?.webContents;
    return contents && !contents.isDestroyed() ? contents.getURL() : '';
  }
  /** Whether the tab has opened the launch's sign-in page and left it for another page of its server. */
  private signedIn() {
    const event = this.browser.info.application?.event, tab = this.browser.info.tabs[0], url = tab ? this.committed(tab.id) : '';
    return this.arrived && event?.type === 'applications.ready' && !!url && sameOrigin(url, event.view.url) && !page(url, event.view.url);
  }
  private release() { this.connection.applications.delete(this.id); this.connection.setHelperNeeded(this, false); }
  fail(message: string) {
    const state = this.browser.info.application;
    if (!state || state.event.type === 'applications.ended') return;
    state.event = this.declined ? { type: 'applications.ended', launchId: this.id, reason: 'cancelled' }
      : { type: 'applications.ended', launchId: this.id, reason: 'failed', error: { code: 'connection_failed', message } };
    this.process.pid = undefined; this.process.status = 'failed'; this.process.message = message;
    this.connection.processes.report(this.closing || this.declined ? { id: this.id, status: 'stopped' } : this.process);
    this.release(); this.connection.changed();
  }
  /** Launches again; before a `relaunches` launch has signed in, its address may be spent, so a retry then launches again too. */
  retry(automatic = false) {
    if (this.browser.closed) throw new Error('Application is closed');
    if (!automatic) this.restarts = 0;
    const event = this.browser.info.application?.event;
    if (this.relaunches && event?.type === 'applications.ready') {
      // A stop already under way launches again, or ends the launch, when it finishes.
      if (this.relaunching || this.closing) return;
      if (this.signedIn()) return this.browser.action('reload', undefined, undefined, true);
      this.relaunching = true; this.stop(); return;
    }
    if (event?.type !== 'applications.ended') throw new Error('Application is not stopped');
    this.connection.processes.report({ id: this.id, status: 'stopped' });
    this.id = randomUUID(); this.start();
  }
  async respond(consentId: string, accepted: boolean) {
    const state = this.browser.info.application!;
    if (state.event.type !== 'applications.consent' || state.event.consentId !== consentId) throw new Error('Consent request expired');
    if (!accepted) this.declined = true;
    await this.connection.sendHelperMessage({ type: 'applications.respond', launchId: this.id, consentId, accepted });
    if (accepted && state.event.type === 'applications.consent') {
      state.event = { type: 'applications.progress', launchId: this.id, phase: 'starting' };
      this.process.message = undefined; this.connection.processes.report(this.process);
      this.connection.changed();
    }
  }
  browserChanged() {
    if (this.browser.closed) return;
    if (!this.browser.tabs.size) { void this.browser.close(true); return; }
    const launch = this.browser.info.application!;
    if (launch.event.type !== 'applications.ready') return;
    const tab = this.browser.info.tabs[0];
    if (tab && page(this.committed(tab.id), launch.event.view.url)) this.arrived = true;
    if (this.signedIn()) this.restarts = 0;
    if (launch.page !== 'open') {
      if (tab?.loading) launch.page = 'loading';
      else if (launch.page === 'loading' && tab?.url && !tab.error) launch.page = 'open';
    }
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    if (this.browser.info.application?.event.type === 'applications.ended') {
      this.connection.processes.report({ id: this.id, status: 'stopped' });
      this.release(); return;
    }
    this.process.status = 'stopping'; this.process.message = undefined;
    this.connection.processes.report(this.process);
    this.stop();
  }
  private stop() {
    void this.connection.sendHelperMessage({ type: 'applications.stop', launchId: this.id }).catch(error => this.fail(error instanceof Error ? error.message : 'Application stop failed'));
  }
}

const sameOrigin = (url: string, address: string) => { try { return new URL(url).origin === new URL(address).origin; } catch { return false; } };
/** Whether a page is the one at a launch address, whatever its fragment. */
const page = (url: string, address: string) => { try { const a = new URL(url), b = new URL(address); return a.origin === b.origin && a.pathname === b.pathname; } catch { return false; } };
