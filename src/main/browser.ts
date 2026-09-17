import { BrowserWindow, WebContentsView, session, type Session, type DownloadItem, type Event } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Relay } from '../core/relay';
import { shortcutKey, type Workspace, type BrowserChallenge, type BrowserTab } from '../shared';
import type { LiveConnection } from './sessions';
import { Certificates } from './certificates';

const rejectDownload = (event: Event) => event.preventDefault();

type BrowserWorkspace = { port?: number; network: Promise<void>; info: Workspace; session: Session; relay: Relay; certificates: Certificates; views: Map<string, WebContentsView>; stopDownloads: () => void; cancelDownloads: () => void; hasDownloadDialog: () => boolean };
type PendingLogin = { info: BrowserChallenge; callbacks: ((username?: string, password?: string) => void)[] };
const credentialField = z.string().max(4096).regex(/^[^\0\r\n]*$/, 'Credentials must be a single line');
const browserCredentials = z.strictObject({ username: credentialField, password: credentialField });

export class Browsers {
  linkMenu?: (workspaceId: string, url: string) => void;
  entries = new Map<string, BrowserWorkspace>();
  private retiring = new Map<string, BrowserWorkspace>();
  private cleanup = new Map<string, Promise<void>>();
  private logins = new Map<string, PendingLogin>();
  /** Tabs where the user cancelled a sign-in, certificate warning or save dialog; they show no new prompts until the user acts in them. */
  private muted = new Set<string>();
  get challenges(): BrowserChallenge[] { return [...this.logins.values()].map(login => login.info); }
  private finishLogins(ids: string[], credentials?: { username: string; password: string }) {
    const callbacks: PendingLogin['callbacks'] = [];
    for (const id of ids) {
      const login = this.logins.get(id);
      if (!login) continue;
      this.logins.delete(id); callbacks.push(...login.callbacks);
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
  private visible?: string;
  private bounds = { x: 250, y: 140, width: 700, height: 500 };
  constructor(private window: BrowserWindow, private changed: () => void, private shortcut: (id: string, action: 'focus-address' | 'new-connection') => void) {}
  /**
   * Opens a tab in the connection's `session`, or in a new session for 'new'. Otherwise the tab opens in the connection's
   * earliest session, or a new one; a named session that is gone is an error unless `fallback` is set.
   */
  async open(connection: LiveConnection, url?: string, session?: string, fallback = false) {
    const ours = [...this.entries.values()].filter(e => e.info.connectionId === connection.info.id);
    const named = ours.find(e => e.info.id === session);
    if (session && session !== 'new' && !named && !fallback) throw new Error('Browser session is closed');
    const existing = session === 'new' ? undefined : named ?? ours[0];
    const id = existing?.info.id ?? await this.create(connection);
    try { await this.action(id, 'new', undefined, url, true); }
    catch (error) { if (!existing) await this.close(id, true); throw error; }
    return id;
  }
  /** Creates a browser session whose storage lives in memory until the session closes. */
  private async create(connection: LiveConnection): Promise<string> {
    if (connection.info.status !== 'connected') throw new Error('Connection is not connected');
    await Promise.all([...this.retiring.values()].filter(e => e.info.connectionId === connection.info.id).map(e => this.close(e.info.id, true)));
    const siblings = [...this.entries.values()].filter(e => e.info.connectionId === connection.info.id);
    const ordinal = Math.max(0, ...siblings.map(e => e.info.ordinal)) + 1;
    const id = randomUUID();
    const used = new Set(siblings.map(e => e.info.color));
    const color = Array.from({ length: 9 }, (_, i) => i).find(i => !used.has(i)) ?? siblings.length % 9;
    const relay = new Relay();
    const port = await relay.start();
    relay.route(connection.port);
    const ses = session.fromPartition(`browser-${id}`, { cache: false });
    try {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
      await ses.closeAllConnections();
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      let download: DownloadItem | undefined;
      const downloads = new Set<DownloadItem>();
      const onDownload = (event: Event, item: DownloadItem, contents: Electron.WebContents) => {
        const tab = [...(this.entries.get(id)?.views ?? [])].find(([, view]) => view.webContents === contents)?.[0];
        if ((tab && this.muted.has(tab)) || (download && !download.getSavePath())) { event.preventDefault(); return; }
        download = item; downloads.add(item);
        item.once('done', (_event, state) => {
          downloads.delete(item);
          if (download === item) download = undefined;
          if (state === 'cancelled' && !item.getSavePath() && tab) this.muted.add(tab);
        });
        item.on('updated', (_event, state) => { if (state === 'interrupted' && item.getSavePath()) item.cancel(); });
        item.setSaveDialogOptions({ title: 'Save Download', defaultPath: item.getFilename() });
      };
      ses.off('will-download', rejectDownload);
      ses.on('will-download', onDownload);
      const cancelDownloads = () => { for (const item of downloads) { try { item.cancel(); } catch {} } downloads.clear(); };
      const stopDownloads = () => { ses.off('will-download', rejectDownload); ses.on('will-download', rejectDownload); ses.off('will-download', onDownload); cancelDownloads(); };
      this.entries.set(id, { port: connection.port, network: Promise.resolve(), info: { id, connectionId: connection.info.id, color, ordinal, tabs: [] }, session: ses, relay, certificates: new Certificates(this.changed, this.muted), views: new Map(), stopDownloads, cancelDownloads, hasDownloadDialog: () => Boolean(download && !download.getSavePath()) });
    } catch (error) { relay.close(); throw error; }
    this.changed(); return id;
  }
  sync(connections: Iterable<LiveConnection>) {
    const live = new Map([...connections].filter(c => c.info.status === 'connected').map(c => [c.info.id, c.port]));
    for (const entry of this.entries.values()) {
      const port = live.get(entry.info.connectionId);
      if (entry.port === port) continue;
      entry.port = port;
      if (port === undefined) {
        entry.relay.route(undefined);
        entry.session.enableNetworkEmulation({ offline: true });
        entry.certificates.close(); entry.cancelDownloads();
        this.finishLogins(this.challenges.filter(c => c.workspaceId === entry.info.id).map(c => c.id));
        entry.network = entry.network.then(async () => { await entry.session.closeAllConnections(); await entry.session.clearAuthCache(); });
      } else {
        entry.network = entry.network.then(async () => {
          if (entry.port !== port || this.entries.get(entry.info.id) !== entry) return;
          entry.relay.route(port);
          entry.session.disableNetworkEmulation();
        });
      }
      entry.network = entry.network.catch(error => console.error('Could not update browser connection', error));
    }
  }

  answerCertificate(id: string, allow: boolean): boolean {
    for (const entry of this.entries.values()) if (entry.certificates.answer(id, allow)) return true;
    return false;
  }
  async closeConnection(connectionId: string) {
    await Promise.all([...this.entries.values(), ...this.retiring.values()].filter(e => e.info.connectionId === connectionId).map(e => this.close(e.info.id, true)));
  }
  private url(input: string): string {
    const value = input.trim();
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL');
    return url.href;
  }
  async action(id: string, action: string, tabId?: string, input?: string, userInitiated = false) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Browser workspace is closed');
    if (['new', 'navigate', 'reload', 'back', 'forward'].includes(action)) await entry.network;
    if (this.entries.get(id) !== entry) throw new Error('Browser workspace is closed');
    if (action === 'close-workspace') { await this.close(id); return; }
    if (action === 'new') {
      if (entry.views.size >= 32) throw new Error('Tab limit reached');
      const url = input ? this.url(input) : undefined;
      const tab: BrowserTab = { id: randomUUID(), title: 'New Tab', url: url ?? '', loading: false, canBack: false, canForward: false };
      const view = new WebContentsView({ webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
      view.setVisible(false);
      this.window.contentView.addChildView(view);
      view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      entry.certificates.attach(tab, view.webContents);
      const clearAuthentication = () => this.finishLogins(this.challenges.filter(challenge => challenge.tabId === tab.id).map(challenge => challenge.id));
      view.webContents.on('destroyed', () => {
        if (this.visible === id && entry.info.activeTab === tab.id && !this.window.isDestroyed()) this.window.webContents.focus();
        this.forgetTab(entry, tab.id);
        clearAuthentication();
        if (this.entries.get(id) !== entry) return;
        this.render(); this.changed();
      });
      view.webContents.on('render-process-gone', () => { this.muted.add(tab.id); clearAuthentication(); });
      view.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) clearAuthentication(); });
      view.webContents.on('login', (event, details, auth, callback) => {
        event.preventDefault();
        const scheme = auth.scheme.toLowerCase();
        if (this.entries.get(id) !== entry || this.muted.has(tab.id) || auth.realm.length > 4096 || auth.isProxy || !['basic', 'digest'].includes(scheme) || [...this.logins.values()].reduce((count, login) => count + login.callbacks.length, 0) >= 128) { callback(); return; }
        const origin = new URL(details.url).origin;
        const realm = auth.realm;
        const pending = [...this.logins.values()].find(login => login.info.tabId === tab.id && login.info.origin === origin && login.info.realm === realm && login.info.scheme === scheme);
        if (pending) { pending.callbacks.push(callback); return; }
        const challengeId = randomUUID();
        const info = { id: challengeId, workspaceId: id, tabId: tab.id, origin, realm, scheme };
        this.logins.set(challengeId, { info, callbacks: [callback] });
        this.changed();
      });

      view.webContents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown' && input.button !== 'right') this.muted.delete(tab.id); });
      view.webContents.on('before-input-event', (event, input) => {
        const toolsShortcut = input.key === 'F12' && !input.control && !input.meta && !input.alt && !input.shift
          || shortcutKey(input) === 'i' && (input.meta && input.alt && !input.control && !input.shift
            || input.control && input.shift && !input.meta && !input.alt);
        if (input.type === 'keyDown' && toolsShortcut) { event.preventDefault(); void this.action(id, 'devtools', tab.id); return; }
        if (input.type === 'keyDown' && !input.control && !input.meta && !input.alt && ['Enter', ' '].includes(input.key)) this.muted.delete(tab.id);
        if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
        const key = shortcutKey(input);
        const action = key === 'l' && !input.shift ? 'focus-address' : key === 'n' && input.shift ? 'new-connection' : undefined;
        if (action) { event.preventDefault(); this.window.webContents.focus(); this.shortcut(id, action); }
      });
      const refresh = () => {
        if (!view.webContents || view.webContents.isDestroyed()) return;
        const contents = view.webContents;
        tab.title = contents.getTitle() || 'New Tab';
        const current = contents.getURL();
        if (current && current !== 'about:blank') tab.url = current;
        tab.loading = contents.isLoading();
        tab.canBack = contents.navigationHistory.canGoBack(); tab.canForward = contents.navigationHistory.canGoForward(); this.changed();
      };
      view.webContents.on('page-title-updated', refresh);
      view.webContents.on('did-navigate', refresh);
      view.webContents.on('did-navigate-in-page', refresh);
      view.webContents.on('did-start-loading', () => { tab.error = undefined; refresh(); });
      view.webContents.on('did-stop-loading', refresh);
      view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = description; this.changed(); } });
      view.webContents.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
      view.webContents.on('will-redirect', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
      view.webContents.on('context-menu', (_event, params) => {
        if (/^https?:\/\//i.test(params.linkURL)) this.linkMenu?.(id, params.linkURL);
      });
      let lastPopup = -Infinity;
      view.webContents.setWindowOpenHandler(({ url }) => {
        const now = performance.now();
        if (/^https?:\/\//i.test(url) && !this.muted.has(tab.id) && now - lastPopup >= 1000) {
          lastPopup = now;
          void this.action(id, 'new', undefined, url).catch(() => {});
        }
        return { action: 'deny' };
      });
      entry.views.set(tab.id, view); entry.info.tabs.push(tab); entry.info.activeTab = tab.id;
      if (url) void view.webContents.loadURL(url).catch(() => {});
      this.render(); this.changed(); return;
    }
    const view = entry.views.get(tabId ?? entry.info.activeTab ?? '');
    if (!view) return;
    const key = tabId ?? entry.info.activeTab!;
    const tab = entry.info.tabs.find(t => t.id === key)!;
    if (['navigate', 'reload', 'back', 'forward', 'stop', 'close'].includes(action)) entry.certificates.cancel(tab);
    if (userInitiated && ['navigate', 'reload', 'back', 'forward'].includes(action)) this.muted.delete(key);
    switch (action) {
      case 'devtools':
        if (view.webContents.isDevToolsOpened()) view.webContents.devToolsWebContents?.focus();
        else view.webContents.openDevTools({ mode: 'detach' });
        return;
      case 'select': entry.info.activeTab = key; break;
      case 'close':
        if (entry.hasDownloadDialog()) throw new Error('Close the download dialog first');
        this.forgetTab(entry, key); await this.disposeView(view);
        break;
      case 'navigate': tab.error = undefined; tab.url = this.url(input ?? ''); void view.webContents.loadURL(tab.url).catch(() => {}); break;
      case 'back': if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); break;
      case 'reload': tab.error = undefined; view.webContents.reload(); break;
      case 'stop': view.webContents.stop(); break;
    }
    this.render(); this.changed();
  }
  show(id: string | null, bounds?: typeof this.bounds) { this.visible = id ?? undefined; if (bounds) this.bounds = bounds; this.render(); }
  private render() {
    const zoom = this.window.webContents.getZoomFactor();
    const bounds = { x: Math.round(this.bounds.x * zoom), y: Math.round(this.bounds.y * zoom), width: Math.round(this.bounds.width * zoom), height: Math.round(this.bounds.height * zoom) };
    for (const entry of this.entries.values()) for (const [id, view] of entry.views) {
      if (!view.webContents || view.webContents.isDestroyed()) continue;
      if (entry.info.id === this.visible && id === entry.info.activeTab) {
        view.setBounds(bounds); view.setVisible(true);
      } else {
        if (view.webContents.isFocused()) this.window.webContents.focus();
        view.setVisible(false);
      }
    }
  }
  private forgetTab(entry: BrowserWorkspace, id: string) {
    entry.views.delete(id); this.muted.delete(id);
    entry.info.tabs = entry.info.tabs.filter(tab => tab.id !== id);
    if (entry.info.activeTab === id) entry.info.activeTab = entry.info.tabs.at(-1)?.id;
  }
  private disposeView(view: WebContentsView) {
    const contents = view.webContents;
    if (contents && !contents.isDestroyed() && contents.isFocused()) this.window.webContents.focus();
    this.window.contentView.removeChildView(view);
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    const destroyed = new Promise<void>(resolve => contents.once('destroyed', () => resolve()));
    contents.close({ waitForBeforeUnload: false });
    return destroyed;
  }
  async close(id: string, force = false) {
    const pending = this.cleanup.get(id);
    if (pending) return pending;
    const entry = this.entries.get(id) ?? this.retiring.get(id);
    if (!entry) return;
    if (!force && entry.hasDownloadDialog()) throw new Error('Close the download dialog first');
    this.entries.delete(id); this.retiring.set(id, entry);
    entry.certificates.close();
    const done = Promise.resolve().then(async () => {
      this.finishLogins(this.challenges.filter(challenge => challenge.workspaceId === id).map(challenge => challenge.id));
      entry.port = undefined;
      await entry.network;
      entry.stopDownloads(); entry.relay.close();
      const destroyed: Promise<void>[] = [];
      for (const [tab, view] of entry.views) { destroyed.push(this.disposeView(view)); this.forgetTab(entry, tab); }
      await Promise.all(destroyed);
      await entry.session.closeAllConnections();
      await entry.session.clearAuthCache();
      await entry.session.clearStorageData();
      await entry.session.clearCache();
      this.retiring.delete(id);
    }).finally(() => { this.cleanup.delete(id); this.changed(); });
    this.cleanup.set(id, done);
    this.changed();
    return done;
  }
  rename(id: string, name: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Browser session is closed');
    entry.info.name = name.trim() || undefined;
    this.changed();
  }
  shutdown() {
    this.finishLogins([...this.logins.keys()]);
    for (const entry of [...this.entries.values(), ...this.retiring.values()]) {
      entry.certificates.close();
      entry.port = undefined;
      entry.stopDownloads(); entry.relay.close();
      for (const view of entry.views.values()) this.disposeView(view);
    }
    this.entries.clear(); this.retiring.clear();
  }
}
