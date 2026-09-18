import { BrowserWindow, WebContentsView, dialog, session, shell, type ContextMenuParams, type Session, type DownloadItem, type Event } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { Relay } from '../core/relay';
import { browserShortcut, stepZoom, type Bounds, type PageShortcut, type Workspace, type BrowserChallenge, type BrowserTab, type Download, type Event as AppEvent } from '../shared';
import type { LiveConnection } from './sessions';
import { Certificates } from './certificates';

const rejectDownload = (event: Event) => event.preventDefault();

/** `tools` holds the developer tools views of tabs that have them open, `items` the running downloads and `saved` where each listed download was saved. */
type BrowserWorkspace = { port?: number; network: Promise<void>; info: Workspace; session: Session; relay: Relay; certificates: Certificates; views: Map<string, WebContentsView>; tools: Map<string, WebContentsView>; items: Map<string, DownloadItem>; saved: Map<string, string>; stopDownloads: () => void; cancelDownloads: () => void; hasDownloadDialog: () => boolean };
const faviconLimit = 64 * 1024;
/** Icons the application draws are bitmaps; an SVG is a document, and one from a page could cost its renderer far more than its size. */
const faviconTypes = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp']);
const downloadLimit = 100;
/** A page title as a file name. */
const fileName = (title: string) => title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'page';
type PendingLogin = { info: BrowserChallenge; callbacks: ((username?: string, password?: string) => void)[] };
const credentialField = z.string().max(4096).regex(/^[^\0\r\n]*$/, 'Credentials must be a single line');
const browserCredentials = z.strictObject({ username: credentialField, password: credentialField });

export class Browsers {
  pageMenu?: (workspaceId: string, tabId: string, params: ContextMenuParams) => void;
  /** Called after a view is added above the views already in the window. */
  added?: () => void;
  /** Each tab's icon as a data URL, with the origin of the page it belongs to. */
  private favicons = new Map<string, { data: string; origin: string }>();
  private faviconRequests = new Map<string, number>();
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
  private toolsBounds?: Bounds;
  /** Tabs whose developer tools this class is closing, until the page reports them closed. */
  private closingTools = new Set<string>();
  /** Tabs with a print or PDF dialog on the way or open. */
  private printing = new Set<string>();
  /** Tabs waiting for their developer tools to open on an element. */
  private inspecting = new Map<string, () => void>();
  constructor(private window: BrowserWindow, private changed: () => void, private shortcut: (id: string, action: 'focus-address' | 'new-connection' | 'find') => void, private send: (event: AppEvent) => void) {}
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
      // Progress reaches the application at most four times a second.
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const progress = () => { progressTimer ??= setTimeout(() => { progressTimer = undefined; this.changed(); }, 250); };
      const onDownload = (event: Event, item: DownloadItem, contents: Electron.WebContents) => {
        const tab = [...(this.entries.get(id)?.views ?? [])].find(([, view]) => view.webContents === contents)?.[0];
        if ((tab && this.muted.has(tab)) || (download && !download.getSavePath())) { event.preventDefault(); return; }
        download = item; downloads.add(item);
        // A download is listed once its save location is chosen.
        const info: Download = { id: randomUUID(), name: item.getFilename(), state: 'progressing', received: 0, total: item.getTotalBytes() };
        let interrupted = false;
        const list = () => {
          const entry = this.entries.get(id), path = item.getSavePath();
          if (!entry || !path) return false;
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
          this.entries.get(id)?.items.delete(info.id);
          info.state = state === 'completed' ? 'completed' : interrupted || state === 'interrupted' ? 'failed' : 'cancelled';
          this.changed();
        });
        item.on('updated', (_event, state) => {
          if (state === 'interrupted' && item.getSavePath()) { interrupted = true; item.cancel(); return; }
          if (list()) progress();
        });
        item.setSaveDialogOptions({ title: 'Save Download', defaultPath: item.getFilename() });
      };
      ses.off('will-download', rejectDownload);
      ses.on('will-download', onDownload);
      const cancelDownloads = () => { for (const item of downloads) { try { item.cancel(); } catch {} } downloads.clear(); };
      const stopDownloads = () => { ses.off('will-download', rejectDownload); ses.on('will-download', rejectDownload); ses.off('will-download', onDownload); cancelDownloads(); };
      this.entries.set(id, { port: connection.port, network: Promise.resolve(), info: { id, connectionId: connection.info.id, color, ordinal, tabs: [], downloads: [] }, session: ses, relay, certificates: new Certificates(this.changed, this.muted), views: new Map(), tools: new Map(), items: new Map(), saved: new Map(), stopDownloads, cancelDownloads, hasDownloadDialog: () => Boolean(download && !download.getSavePath()) });
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
    if (['new', 'navigate', 'reload', 'hard-reload', 'back', 'forward'].includes(action)) await entry.network;
    if (this.entries.get(id) !== entry) throw new Error('Browser workspace is closed');
    if (action === 'close-workspace') { await this.close(id); return; }
    if (action === 'new') {
      if (entry.views.size >= 32) throw new Error('Tab limit reached');
      const url = input ? this.url(input) : undefined;
      const tab: BrowserTab = { id: randomUUID(), title: 'New Tab', url: url ?? '', loading: false, canBack: false, canForward: false, audible: false, muted: false, zoom: 100, devtools: false };
      const view = new WebContentsView({ webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
      view.setVisible(false);
      this.window.contentView.addChildView(view); this.added?.();
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
      view.webContents.on('render-process-gone', () => { this.muted.add(tab.id); clearAuthentication(); this.send({ type: 'target-url', tabId: tab.id, url: '' }); });
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
        if (input.type !== 'keyDown') return;
        if (!input.control && !input.meta && !input.alt && ['Enter', ' '].includes(input.key)) this.muted.delete(tab.id);
        const shortcut = browserShortcut(input);
        if (!shortcut) return;
        event.preventDefault();
        if (input.isAutoRepeat) return;
        // The address and the connection form belong to the application.
        if (shortcut === 'devtools') void this.action(id, shortcut, tab.id, undefined, true).catch(() => {});
        else { this.window.webContents.focus(); this.shortcut(id, shortcut); }
      });
      view.webContents.on('audio-state-changed', event => { tab.audible = event.audible; this.changed(); });
      view.webContents.on('page-favicon-updated', (_event, icons) => void this.loadFavicon(entry, tab.id, view, icons));
      view.webContents.on('found-in-page', (_event, result) => this.send({ type: 'found', tabId: tab.id, active: result.activeMatchOrdinal, matches: result.matches }));
      view.webContents.on('update-target-url', (_event, target) => this.send({ type: 'target-url', tabId: tab.id, url: target.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 2048) }));
      view.webContents.on('zoom-changed', (_event, direction) => this.zoom(entry, view, direction));
      // Closing the tools here reports it too, once, and by then the tab may have opened them again.
      view.webContents.on('devtools-closed', () => { if (!this.closingTools.delete(tab.id)) this.closeTools(entry, tab); });
      const refresh = () => {
        if (!view.webContents || view.webContents.isDestroyed()) return;
        const contents = view.webContents;
        tab.title = contents.getTitle() || 'New Tab';
        const current = contents.getURL();
        if (current && current !== 'about:blank') tab.url = current;
        tab.loading = contents.isLoading();
        tab.zoom = Math.round(contents.getZoomFactor() * 100);
        tab.canBack = contents.navigationHistory.canGoBack(); tab.canForward = contents.navigationHistory.canGoForward(); this.changed();
      };
      view.webContents.on('page-title-updated', refresh);
      view.webContents.on('did-navigate', (_event, target) => {
        // A page on another origin starts without an icon, and a new page has no matches yet.
        let origin = ''; try { origin = new URL(target).origin; } catch {}
        if (this.favicons.get(tab.id)?.origin !== origin) this.setFavicon(tab.id);
        // An icon still on its way belongs to the page before.
        this.faviconRequests.set(tab.id, (this.faviconRequests.get(tab.id) ?? 0) + 1);
        this.send({ type: 'found', tabId: tab.id, active: 0, matches: 0 });
      });
      view.webContents.on('did-navigate', refresh);
      view.webContents.on('did-navigate-in-page', refresh);
      view.webContents.on('did-start-loading', () => { tab.error = undefined; refresh(); });
      view.webContents.on('did-stop-loading', refresh);
      view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = description; this.changed(); } });
      view.webContents.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
      view.webContents.on('will-redirect', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
      view.webContents.on('context-menu', (_event, params) => this.pageMenu?.(id, tab.id, params));
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
    if (['navigate', 'reload', 'hard-reload', 'back', 'forward', 'stop', 'close'].includes(action)) entry.certificates.cancel(tab);
    if (userInitiated && ['navigate', 'reload', 'hard-reload', 'back', 'forward'].includes(action)) this.muted.delete(key);
    switch (action) {
      case 'devtools':
        if (entry.tools.has(key)) this.closeTools(entry, tab); else this.openTools(entry, tab, view);
        return;
      case 'zoom-in': this.zoom(entry, view, 'in'); return;
      case 'zoom-out': this.zoom(entry, view, 'out'); return;
      case 'zoom-reset': this.zoom(entry, view, 'reset'); return;
      case 'print':
        // A held key asks again while the dialog is open.
        if (this.printing.has(key)) return;
        this.printing.add(key);
        try { await new Promise<void>((resolve, reject) => view.webContents.print({}, (success, reason) => { if (success || !reason || /cancel/i.test(reason)) resolve(); else reject(new Error(reason)); })); }
        finally { this.printing.delete(key); }
        return;
      case 'pdf': {
        if (this.printing.has(key)) return;
        this.printing.add(key);
        try {
          const data = await view.webContents.printToPDF({ printBackground: true });
          const { filePath } = await dialog.showSaveDialog(this.window, { title: 'Save as PDF', defaultPath: `${fileName(tab.title)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (filePath) await writeFile(filePath, data);
        } finally { this.printing.delete(key); }
        return;
      }
      case 'mute': view.webContents.setAudioMuted(!view.webContents.isAudioMuted()); tab.muted = view.webContents.isAudioMuted(); break;
      case 'select': entry.info.activeTab = key; break;
      case 'close':
        if (entry.hasDownloadDialog()) throw new Error('Close the download dialog first');
        this.forgetTab(entry, key); await this.disposeView(view);
        break;
      case 'navigate': tab.error = undefined; tab.url = this.url(input ?? ''); void view.webContents.loadURL(tab.url).catch(() => {}); break;
      case 'back': if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); break;
      case 'reload': tab.error = undefined; view.webContents.reload(); break;
      case 'hard-reload': tab.error = undefined; view.webContents.reloadIgnoringCache(); break;
      case 'stop': view.webContents.stop(); break;
    }
    this.render(); this.changed();
  }
  /** Shows a session's active tab at `bounds`, and its open developer tools at `tools`. */
  show(id: string | null, bounds?: Bounds, tools?: Bounds) { this.visible = id ?? undefined; if (bounds) this.bounds = bounds; this.toolsBounds = tools; this.render(); }
  private render() {
    const zoom = this.window.webContents.getZoomFactor();
    const scaled = (bounds: Bounds) => ({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
    const place = (view: WebContentsView, bounds: Bounds | undefined) => {
      if (!view.webContents || view.webContents.isDestroyed()) return;
      if (bounds) { view.setBounds(scaled(bounds)); view.setVisible(true); return; }
      if (view.webContents.isFocused()) this.window.webContents.focus();
      view.setVisible(false);
    };
    for (const entry of this.entries.values()) {
      const shown = (id: string) => entry.info.id === this.visible && id === entry.info.activeTab;
      for (const [id, view] of entry.views) place(view, shown(id) ? this.bounds : undefined);
      for (const [id, view] of entry.tools) place(view, shown(id) ? this.toolsBounds : undefined);
    }
  }
  /** Sends every tab's icon, for an application page that has just loaded. */
  replay() { for (const [tabId, { data }] of this.favicons) this.send({ type: 'favicon', tabId, data }); }
  /** Forgets every tab's icon, so an application page that failed starts again without them. */
  forgetFavicons() { this.favicons.clear(); }
  /** Lets a tab prompt again, for a command the user chose in it. */
  allowPrompts(tabId: string) { this.muted.delete(tabId); }
  private setFavicon(tabId: string, icon?: { data: string; origin: string }) {
    if (!icon && !this.favicons.has(tabId)) return;
    if (icon) this.favicons.set(tabId, icon); else this.favicons.delete(tabId);
    this.send({ type: 'favicon', tabId, data: icon?.data });
  }
  /** Fetches a page's icon through its session, so the request takes the same route as the page, and keeps it only if it is a small image. */
  private async loadFavicon(entry: BrowserWorkspace, tabId: string, view: WebContentsView, icons: string[]) {
    const request = (this.faviconRequests.get(tabId) ?? 0) + 1;
    this.faviconRequests.set(tabId, request);
    const address = icons.find(icon => /^https?:\/\//i.test(icon) && icon.length <= 8192);
    let data: string | undefined;
    if (address) try {
      const response = await entry.session.fetch(address, { signal: AbortSignal.timeout(15000) });
      const type = response.headers.get('content-type')?.split(';')[0]!.trim().toLowerCase() ?? '';
      if (response.ok && faviconTypes.has(type) && Number(response.headers.get('content-length') ?? 0) <= faviconLimit) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body ?? []) { size += chunk.length; if (size > faviconLimit) break; chunks.push(chunk); }
        if (size && size <= faviconLimit) data = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
      } else void response.body?.cancel().catch(() => {});
    } catch { /* A page whose icon cannot be fetched has none. */ }
    if (this.faviconRequests.get(tabId) !== request || !entry.views.has(tabId) || view.webContents.isDestroyed()) return;
    let origin = ''; try { origin = new URL(view.webContents.getURL()).origin; } catch {}
    this.setFavicon(tabId, data ? { data, origin } : undefined);
  }
  /** Zoom belongs to a site within its session, so every tab of the session reports its zoom again. */
  private zoom(entry: BrowserWorkspace, view: WebContentsView, direction: 'in' | 'out' | 'reset') {
    const current = Math.round(view.webContents.getZoomFactor() * 100);
    view.webContents.setZoomFactor((direction === 'reset' ? 100 : stepZoom(current, direction)) / 100);
    for (const tab of entry.info.tabs) { const contents = entry.views.get(tab.id)?.webContents; if (contents && !contents.isDestroyed()) tab.zoom = Math.round(contents.getZoomFactor() * 100); }
    this.changed();
  }
  /**
   * Opens a tab's developer tools in a view of its own, docked inside the window by the application. The view uses the
   * tab's session, so requests the tools make take the same route as the page.
   */
  private openTools(entry: BrowserWorkspace, tab: BrowserTab, view: WebContentsView) {
    if (entry.tools.has(tab.id)) return;
    const tools = new WebContentsView({ webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    tools.setVisible(false);
    tools.webContents.once('destroyed', () => { if (entry.tools.get(tab.id) === tools) this.closeTools(entry, tab); });
    this.window.contentView.addChildView(tools); this.added?.();
    tools.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void this.action(entry.info.id, 'new', undefined, url).catch(() => {});
      return { action: 'deny' };
    });
    tools.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && browserShortcut(input) === 'devtools') { event.preventDefault(); this.closeTools(entry, tab); }
    });
    entry.tools.set(tab.id, tools);
    view.webContents.setDevToolsWebContents(tools.webContents);
    view.webContents.openDevTools({ mode: 'detach' });
    tab.devtools = true;
    this.render(); this.changed();
  }
  private closeTools(entry: BrowserWorkspace, tab: BrowserTab) {
    const tools = entry.tools.get(tab.id);
    if (!tools) return;
    entry.tools.delete(tab.id); tab.devtools = false;
    const contents = entry.views.get(tab.id)?.webContents;
    const inspecting = this.inspecting.get(tab.id);
    this.inspecting.delete(tab.id);
    if (contents && !contents.isDestroyed()) {
      if (inspecting) contents.removeListener('devtools-opened', inspecting);
      this.closingTools.add(tab.id);
      contents.closeDevTools();
    }
    void this.disposeView(tools);
    if (this.entries.get(entry.info.id) === entry) { this.render(); this.changed(); }
  }
  /** Opens a tab's developer tools on the element at a point of its page. */
  inspect(id: string, tabId: string, x: number, y: number) {
    const entry = this.entries.get(id), view = entry?.views.get(tabId), tab = entry?.info.tabs.find(t => t.id === tabId);
    if (!entry || !view || !tab) return;
    // Inspecting before the tools have opened would open them again, docked to a window they do not have.
    if (entry.tools.has(tabId)) { view.webContents.inspectElement(x, y); return; }
    const opened = () => { this.inspecting.delete(tabId); view.webContents.inspectElement(x, y); };
    this.inspecting.set(tabId, opened);
    view.webContents.once('devtools-opened', opened);
    this.openTools(entry, tab, view);
  }
  /** The tab a page shortcut applies to: the one whose page has focus, or else the one on show. */
  target(): { id: string; tabId: string; connectionId: string } | undefined {
    for (const entry of this.entries.values()) for (const [tabId, view] of entry.views)
      if (!view.webContents.isDestroyed() && view.webContents.isFocused()) return { id: entry.info.id, tabId, connectionId: entry.info.connectionId };
    const entry = this.entries.get(this.visible ?? '');
    return entry?.info.activeTab ? { id: entry.info.id, tabId: entry.info.activeTab, connectionId: entry.info.connectionId } : undefined;
  }
  /** Runs a shortcut that a page left alone on a tab that shows a page; the find bar belongs to the application. */
  async pageShortcut(name: PageShortcut, { id, tabId }: { id: string; tabId: string }) {
    if (!this.entries.get(id)?.info.tabs.find(tab => tab.id === tabId)?.url) return;
    if (name === 'find') { this.window.webContents.focus(); this.shortcut(id, 'find'); }
    else await this.action(id, name, tabId, undefined, true);
  }
  /** A tab's page, for actions on what it shows. */
  contents(id: string, tabId: string) {
    const contents = this.entries.get(id)?.views.get(tabId)?.webContents;
    return contents && !contents.isDestroyed() ? contents : undefined;
  }
  /** Finds text in a tab, or the next or previous match of the same text; without a request the search ends and the page takes focus. */
  find(id: string, tabId: string, request: { text: string; forward: boolean; next: boolean } | null) {
    const entry = this.entries.get(id), contents = this.contents(id, tabId);
    if (!entry || !contents) return;
    if (request?.text) { contents.findInPage(request.text, { forward: request.forward, findNext: !request.next }); return; }
    contents.stopFindInPage('clearSelection');
    this.send({ type: 'found', tabId, active: 0, matches: 0 });
    if (!request && this.visible === id && entry.info.activeTab === tabId) contents.focus();
  }
  download(id: string, action: 'cancel' | 'show' | 'clear', downloadId?: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Browser session is closed');
    if (action === 'clear') {
      for (const item of entry.info.downloads) if (item.state !== 'progressing') entry.saved.delete(item.id);
      entry.info.downloads = entry.info.downloads.filter(item => item.state === 'progressing');
      this.changed();
    } else if (action === 'cancel') { try { entry.items.get(downloadId ?? '')?.cancel(); } catch {} }
    else { const path = entry.saved.get(downloadId ?? ''); if (path) shell.showItemInFolder(path); }
  }
  private forgetTab(entry: BrowserWorkspace, id: string) {
    const tools = entry.tools.get(id);
    if (tools) { entry.tools.delete(id); void this.disposeView(tools); }
    this.favicons.delete(id); this.faviconRequests.delete(id); this.closingTools.delete(id); this.inspecting.delete(id);
    entry.views.delete(id); this.muted.delete(id);
    entry.info.tabs = entry.info.tabs.filter(tab => tab.id !== id);
    if (entry.info.activeTab === id) entry.info.activeTab = entry.info.tabs.at(-1)?.id;
  }
  private disposeView(view: WebContentsView) {
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
      for (const tools of entry.tools.values()) destroyed.push(this.disposeView(tools));
      entry.tools.clear();
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
      for (const view of [...entry.views.values(), ...entry.tools.values()]) this.disposeView(view);
      entry.tools.clear();
    }
    this.entries.clear(); this.retiring.clear();
  }
}
