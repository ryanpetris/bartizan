import { app, session, shell, type WebContents, type WebContentsView, type DownloadItem, type Event } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { Relay } from '../core/relay';
import { pagePermitted, type Workspace, type BrowserChallenge, type Download, type PageShortcut } from '../shared';
import { Certificates } from './certificates';
import { BrowserTabController, type TabOptions } from './browser-tab';
import { webAddress } from './link-menu';
import type { Browsers } from './browser';
import type { ApplicationSession } from './application-session';

const rejectDownload = (event: Event) => event.preventDefault();
const downloadLimit = 100;
/** How many closed tabs a session can reopen. */
const reopenLimit = 25;
type PendingLogin = { info: BrowserChallenge; callbacks: ((username?: string, password?: string) => void)[] };
const credentialField = z.string().max(4096).regex(/^[^\0\r\n]*$/, 'Credentials must be a single line');
const browserCredentials = z.strictObject({ username: credentialField, password: credentialField });

export class BrowserSession {
  readonly tabs = new Map<string, BrowserTabController>();
  readonly contents = new Map<number, BrowserTabController>();
  readonly relay = new Relay();
  readonly session;
  readonly certificates;
  readonly items = new Map<string, DownloadItem>();
  readonly saved = new Map<string, string>();
  application?: ApplicationSession;
  /** The tab to give the keyboard once it is selected, or `true` for the next tab selected. */
  focusing?: string | true;
  port?: number;
  network = Promise.resolve();
  closed = false;
  private closing?: Promise<void>;
  /** An application's blank popups that wait for an address. */
  private readonly held = new Set<WebContents>();
  /** Addresses of closed tabs, the most recent last. */
  private closedTabs: string[] = [];
  private stopDownloads = () => {};
  private cancelDownloads = () => {};
  hasDownloadDialog = () => false;
  get window() { return this.owner.window; }
  get display() { return this.owner.host.display; }
  get send() { return this.owner.send; }
  get shortcut() { return this.owner.shortcut; }
  get added() { return this.owner.added; }
  get pageMenu() { return this.owner.pageMenu; }
  get openPopup() { return this.owner.openPopup; }
  readonly changed = () => { this.application?.browserChanged(); this.owner.connection.changed(); };
  constructor(readonly owner: Browsers, readonly info: Workspace) {
    this.session = session.fromPartition(`browser-${info.id}`, { cache: false });
    this.certificates = new Certificates(this.changed, this.muted, (id, pending) => { if (pending) owner.host.certificates.set(id, this); else owner.host.certificates.delete(id); });
    this.port = owner.connection.port;
  }
  readonly logins = new Map<string, PendingLogin>();
  /** Tabs where the user cancelled a sign-in, certificate warning or save dialog; they show no new prompts until the user acts in them. */
  readonly muted = new Set<string>();
  get challenges(): BrowserChallenge[] { return [...this.logins.values()].map(login => login.info); }
  finishLogins(ids: string[], credentials?: { username: string; password: string }) {
    const callbacks: PendingLogin['callbacks'] = [];
    for (const id of ids) {
      const login = this.logins.get(id);
      if (!login) continue;
      this.logins.delete(id); this.owner.host.authentication.delete(id); callbacks.push(...login.callbacks);
    }
    for (const callback of callbacks) { try { if (credentials) callback(credentials.username, credentials.password); else callback(); } catch {} }
    if (callbacks.length) this.changed();
  }
  answerAuthentication(id: string, value: unknown): boolean {
    const login = this.logins.get(id);
    if (!login) return false;
    if (value === null) {
      this.muted.add(login.info.tabId);
      this.finishLogins(this.challenges.filter(challenge => challenge.tabId === login.info.tabId).map(challenge => challenge.id));
    } else this.finishLogins(this.challenges.filter(challenge => challenge.workspaceId === login.info.workspaceId && challenge.origin === login.info.origin && challenge.realm === login.info.realm && challenge.scheme === login.info.scheme).map(challenge => challenge.id), browserCredentials.parse(value));
    return true;
  }
  async start() {
    const relay = this.relay;
    const port = await relay.start();
    relay.route(this.owner.connection.port);
    const ses = this.session;
    try {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
      await ses.closeAllConnections();
      const allowCapture = (contents: Electron.WebContents | null, permission: string) => {
        const tab = contents && this.contents.get(contents.id);
        return Boolean(tab && this.display.visible === this.info.id && this.info.activeTab === tab.info.id
          && this.window.isFocused() && tab.view.getVisible() && pagePermitted(permission, Boolean(this.info.application)));
      };
      ses.setPermissionRequestHandler((contents, permission, callback) => {
        const allowed = allowCapture(contents, permission);
        if (allowed && permission === 'fullscreen') this.contents.get(contents.id)!.prepareFullscreen();
        callback(allowed);
      });
      ses.setPermissionCheckHandler((contents, permission) => allowCapture(contents, permission));
      let download: DownloadItem | undefined;
      const downloads = new Set<DownloadItem>();
      // Progress reaches the application at most four times a second.
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const progress = () => { progressTimer ??= setTimeout(() => { progressTimer = undefined; this.changed(); }, 250); };
      // A download the session starts itself has no page.
      const onDownload = (event: Event, item: DownloadItem, contents: Electron.WebContents | null) => {
        const tab = contents ? this.contents.get(contents.id)?.info.id : undefined;
        if ((tab && this.muted.has(tab)) || (download && !download.getSavePath())) { event.preventDefault(); return; }
        download = item; downloads.add(item);
        // A download is listed once its save location is chosen.
        const info: Download = { id: randomUUID(), name: item.getFilename(), state: 'progressing', received: 0, total: item.getTotalBytes() };
        let interrupted = false;
        const list = () => {
          const entry = this, path = item.getSavePath();
          if (this.closed || !path) return false;
          if (!entry.saved.has(info.id)) {
            info.name = basename(path);
            entry.saved.set(info.id, path); entry.items.set(info.id, item);
            entry.info.downloads.unshift(info);
            for (const old of entry.info.downloads.filter(d => d.state !== 'progressing').slice(downloadLimit)) { entry.saved.delete(old.id); entry.info.downloads.splice(entry.info.downloads.indexOf(old), 1); }
          }
          info.received = item.getReceivedBytes(); info.total = item.getTotalBytes();
          return true;
        };
        item.once('done', (_event, state) => {
          downloads.delete(item);
          if (download === item) download = undefined;
          if (state === 'cancelled' && !item.getSavePath() && tab) this.muted.add(tab);
          if (!list()) return;
          this.items.delete(info.id);
          info.state = state === 'completed' ? 'completed' : interrupted || state === 'interrupted' ? 'failed' : 'cancelled';
          this.changed();
        });
        item.on('updated', (_event, state) => {
          if (state === 'interrupted' && item.getSavePath()) { interrupted = true; item.cancel(); return; }
          if (list()) progress();
        });
        item.setSaveDialogOptions({ title: 'Save Download', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
      };
      ses.off('will-download', rejectDownload);
      ses.on('will-download', onDownload);
      const cancelDownloads = () => { for (const item of downloads) { try { item.cancel(); } catch {} } downloads.clear(); };
      const stopDownloads = () => { ses.off('will-download', rejectDownload); ses.on('will-download', rejectDownload); ses.off('will-download', onDownload); cancelDownloads(); };
      this.stopDownloads = () => { clearTimeout(progressTimer); stopDownloads(); };
      this.cancelDownloads = cancelDownloads;
      this.hasDownloadDialog = () => Boolean(download && !download.getSavePath());
    } catch (error) { relay.close(); throw error; }
  }
  sync() {
    const port = this.owner.connection.info.status === 'connected' ? this.owner.connection.port : undefined;
    if (this.port === port) return;
    this.port = port;
    if (port === undefined) {
      this.relay.route(undefined);
      this.session.enableNetworkEmulation({ offline: true });
      this.certificates.close(); this.cancelDownloads();
      this.finishLogins([...this.logins.keys()]);
      this.network = this.network.then(async () => { await this.session.closeAllConnections(); await this.session.clearAuthCache(); });
    } else {
      this.network = this.network.then(async () => {
        if (this.port !== port || this.closed) return;
        this.relay.route(port);
        this.session.disableNetworkEmulation();
        // An application's launch loads its own tabs again.
        if (!this.info.application) for (const tab of this.tabs.values()) tab.reconnected();
      });
    }
    this.network = this.network.catch(error => console.error('Could not update browser connection', error));
  }

  download(action: 'cancel' | 'show' | 'clear', downloadId?: string) {
    const entry = this;
    if (this.closed) throw new Error('Browser session is closed');
    if (action === 'clear') {
      for (const item of entry.info.downloads) if (item.state !== 'progressing') entry.saved.delete(item.id);
      entry.info.downloads = entry.info.downloads.filter(item => item.state === 'progressing');
      this.changed();
    } else if (action === 'cancel') { try { entry.items.get(downloadId ?? '')?.cancel(); } catch {} }
    else { const path = entry.saved.get(downloadId ?? ''); if (path) shell.showItemInFolder(path); }
  }
  disposeView(view: WebContentsView) {
    const contents = view.webContents;
    if (!this.window.isDestroyed()) {
      if (contents && !contents.isDestroyed() && contents.isFocused()) this.window.webContents.focus();
      this.window.contentView.removeChildView(view);
    }
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    const destroyed = new Promise<void>(resolve => contents.once('destroyed', () => resolve()));
    contents.close({ waitForBeforeUnload: false });
    return destroyed;
  }
  /** The address a tab is sent to for what the user entered: an HTTP or HTTPS address, or the source of one. */
  url(input: string): string {
    const value = input.trim(), source = /^view-source:/i.test(value);
    const address = source ? value.slice(12) : value;
    const url = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL');
    return `${source ? 'view-source:' : ''}${url.href}`;
  }
  /** Opens a tab once the session's network is settled. */
  async open(options: TabOptions) {
    await this.network;
    if (this.closed) throw new Error('Browser session is closed');
    if (this.info.application && this.tabs.size) throw new Error('Application tabs cannot contain browser tabs');
    new BrowserTabController(this, options);
  }
  reopenable(url: string) {
    this.closedTabs = [...this.closedTabs.filter(item => item !== url), url].slice(-reopenLimit);
    this.info.closedTabs = this.closedTabs.length;
  }
  /**
   * Keeps an application's blank popup out of sight until its opener sends it to a web address, which opens in an
   * ordinary session of the connection instead; it closes then, or after a while without one.
   */
  handOff(contents: WebContents) {
    const finish = (url?: string) => {
      clearTimeout(timer);
      if (url && !this.closed) this.openPopup?.(this.info.connectionId, url, this.info.id);
      if (!contents.isDestroyed()) contents.close();
    };
    const timer = setTimeout(finish, 30000);
    this.held.add(contents);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => {
      event.preventDefault();
      if (webAddress(target)) finish(target);
    });
    contents.once('destroyed', () => { clearTimeout(timer); this.held.delete(contents); });
  }
  async action(action: string, tabId?: string, input?: string, userInitiated = false, title?: string) {
    if (this.closed) {
      if (action === 'close' || action === 'close-workspace') return this.closing;
      throw new Error('Browser session is closed');
    }
    if (['navigate', 'reload', 'hard-reload', 'back', 'forward'].includes(action)) await this.network;
    if (this.closed) throw new Error('Browser session is closed');
    if (action === 'close-workspace') return this.close();
    if (action === 'new') return this.open({ url: input ? this.url(input) : undefined, title });
    if (action === 'reopen') {
      const url = this.closedTabs.pop();
      this.info.closedTabs = this.closedTabs.length;
      if (url) await this.open({ url });
      return;
    }
    await this.tabs.get(tabId ?? this.info.activeTab ?? '')?.action(action, input, userInitiated);
  }
  render() {
    for (const tab of this.tabs.values()) {
      const shown = this.display.visible === this.info.id && this.info.activeTab === tab.info.id;
      tab.render(shown ? this.display.bounds : undefined, shown ? this.display.toolsBounds : undefined);
    }
  }
  async pageShortcut(name: PageShortcut, tabId: string) {
    if (this.info.application || !this.tabs.get(tabId)?.info.url) return;
    if (name === 'find') { this.window.webContents.focus(); this.shortcut(this.info.id, 'find'); }
    else await this.action(name, tabId, undefined, true);
  }
  close(force = false): Promise<void> {
    if (this.closing) return this.closing;
    if (!force && this.hasDownloadDialog()) return Promise.reject(new Error('Close the download dialog first'));
    this.closed = true;
    this.owner.entries.delete(this.info.id);
    this.owner.host.entries.delete(this.info.id);
    this.application?.close();
    this.certificates.close();
    for (const contents of this.held) if (!contents.isDestroyed()) contents.close();
    const done = this.closing = Promise.resolve().then(async () => {
      this.finishLogins([...this.logins.keys()]);
      this.port = undefined;
      await this.network;
      this.stopDownloads(); this.relay.close();
      await Promise.all([...this.tabs.values()].map(tab => tab.close()));
      await this.session.closeAllConnections();
      await this.session.clearAuthCache();
      await this.session.clearStorageData();
      await this.session.clearCache();
    }).finally(() => { this.owner.retiring.delete(done); this.changed(); });
    this.owner.retiring.add(done);
    this.changed();
    return done;
  }
}
