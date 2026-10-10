import { WebContentsView, app, dialog, shell, type BrowserWindow, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserShortcut, namedByAddress, pageAddress, stepZoom, systemLink, untitledName, type BrowserTab, type Bounds } from '../shared';
import type { BrowserSession } from './browser-session';
import { linkURL, webAddress } from './link-menu';

const faviconLimit = 64 * 1024;
const faviconTypes = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp']);
const fileName = (title: string) => title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'page';
/** Failures of a page's load that mean its session had lost its route through SSH. */
const tunnelFailures = /^ERR_(INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)$/;
const unresponsive = 'Page not responding';
/** Windows showing a question about opening a link in another application, which they ask one at a time. */
const asking = new WeakSet<BrowserWindow>();
/** A tab's address, title and page: a new page, or one the page of another tab opened, shown in front of the session's other tabs unless `background`. */
export type TabOptions = { url?: string; title?: string; contents?: WebContents; background?: boolean };

export class BrowserTabController {
  readonly info: BrowserTab;
  readonly view: WebContentsView;
  private readonly contentsId: number;
  tools?: WebContentsView;
  closed = false;
  favicon?: { data: string; origin: string };
  private faviconRequest = 0;
  private closingTools = false;
  private printing = false;
  private fullscreen = false;
  private fullscreenWindow?: boolean;
  private inspecting?: () => void;
  private closing?: Promise<void>;
  private toolsClosing?: Promise<void>;
  /** The address the tab was sent to, which it shows until the page there replaces the one before. */
  private pending?: string;
  /** Whether the page's load failed because the session was offline, so that it loads again once the session is back. */
  private offline = false;
  /** Whether the page has stopped responding, and whether its process is being ended so that it loads in a new one. */
  private hung = false;
  private leaving?: Promise<boolean>;
  /** Withdraws the tab's questions once it has gone. */
  private readonly questions = new AbortController();
  private restarting = false;
  /** The address the tab was last sent to, which loads again where the tab has no page of its own to reload. */
  private requested?: string;
  /** When the user last clicked in the page or pressed a key it kept, which lets it open background tabs for a moment. */
  private gesture = -Infinity;
  /** Whether a page opened the tab, which shows the blank document it starts with until it is sent somewhere. */
  private readonly adopted: boolean;
  private refresh = () => {};
  private changed = () => this.owner.changed();
  private renderOwner = () => this.owner.render();
  constructor(readonly owner: BrowserSession, { url, title, contents, background }: TabOptions = {}) {
    const entry = owner, id = entry.info.id;
    this.adopted = Boolean(contents);
    const tab: BrowserTab = this.info = { id: randomUUID(), title: title ?? 'New Tab', url: contents ? 'about:blank' : url ?? '', loading: false, canBack: false, canForward: false, audible: false, muted: false, zoom: 100, devtools: false };
    const view = this.view = new WebContentsView(contents ? { webContents: contents } : { webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, focusOnNavigation: false } });
    this.contentsId = view.webContents.id;
    // A page's popup shows the address it holds, which its opener can write into before it leaves.
    this.requested = url || undefined;
    this.pending = contents ? undefined : this.requested;
    view.setVisible(false);
    this.owner.window.contentView.addChildView(view); this.owner.added?.();
    view.webContents.on('enter-html-full-screen', () => { this.fullscreen = true; this.renderOwner(); });
    view.webContents.on('leave-html-full-screen', () => { this.leaveFullscreen(); this.fullscreenWindow = undefined; this.renderOwner(); });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    entry.certificates.attach(tab, view.webContents, () => void this.action('reload', undefined, true).catch(() => {}));
    const clearAuthentication = () => entry.finishLogins(entry.challenges.filter(challenge => challenge.tabId === tab.id).map(challenge => challenge.id));
    view.webContents.on('destroyed', () => {
      if (this.owner.display.visible === id && entry.info.activeTab === tab.id && !this.owner.window.isDestroyed()) this.owner.window.webContents.focus();
      this.forget();
      clearAuthentication();
      if (entry.closed) return;
      this.renderOwner(); this.changed();
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      const restarting = this.restarting;
      this.restarting = this.hung = false;
      this.owner.send({ type: 'target-url', tabId: tab.id, url: '' });
      if (restarting) return;
      entry.muted.add(tab.id); clearAuthentication();
      if (details.reason === 'clean-exit' || entry.closed) return;
      this.pending = undefined; tab.error = 'Page crashed'; this.refresh(); tab.loading = false; this.changed();
    });
    // An application's page is left in view while it does not respond.
    view.webContents.on('unresponsive', () => { if (entry.info.application) return; this.hung = true; tab.loading = false; tab.error ??= unresponsive; this.changed(); });
    view.webContents.on('responsive', () => { this.hung = false; if (tab.error === unresponsive) { tab.error = undefined; this.refresh(); } });
    view.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) clearAuthentication(); });
    view.webContents.on('login', (event, details, auth, callback) => {
      event.preventDefault();
      const scheme = auth.scheme.toLowerCase();
      if (entry.closed || entry.muted.has(tab.id) || auth.realm.length > 4096 || auth.isProxy || !['basic', 'digest'].includes(scheme) || [...entry.logins.values()].reduce((count, login) => count + login.callbacks.length, 0) >= 128) { callback(); return; }
      const origin = new URL(details.url).origin;
      const realm = auth.realm;
      const pending = [...entry.logins.values()].find(login => login.info.tabId === tab.id && login.info.origin === origin && login.info.realm === realm && login.info.scheme === scheme);
      if (pending) { pending.callbacks.push(callback); return; }
      const challengeId = randomUUID();
      const info = { id: challengeId, workspaceId: id, tabId: tab.id, origin, realm, scheme };
      entry.logins.set(challengeId, { info, callbacks: [callback] });
      entry.owner.host.authentication.set(challengeId, entry);
      this.changed();
    });

    view.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown' && input.button !== 'right') this.gesture = performance.now();
      if (input.type === 'mouseDown' && input.button !== 'right') entry.muted.delete(tab.id);
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (!input.control && !input.meta && !input.alt && ['Enter', ' '].includes(input.key)) entry.muted.delete(tab.id);
      const shortcut = browserShortcut(input);
      // An application's page keeps every key but the one for a new connection.
      if (!shortcut || entry.info.application && shortcut !== 'new-connection') { this.gesture = performance.now(); return; }
      event.preventDefault();
      // With no other tab to move to, the page keeps the keyboard.
      if ((shortcut === 'next-tab' || shortcut === 'previous-tab') && entry.tabs.size < 2) return;
      if (input.isAutoRepeat && shortcut !== 'next-tab' && shortcut !== 'previous-tab') return;
      // The address and the connection form belong to the application.
      if (shortcut === 'devtools') void this.action(shortcut, undefined, true).catch(() => {});
      else {
        // The tab a page's keys move to takes the keyboard from it.
        if (shortcut === 'next-tab' || shortcut === 'previous-tab') entry.focusing = true;
        this.owner.window.webContents.focus(); this.owner.shortcut(id, shortcut);
      }
    });
    view.webContents.on('audio-state-changed', event => { tab.audible = event.audible; this.changed(); });
    view.webContents.on('page-favicon-updated', (_event, icons) => void this.loadFavicon(icons));
    view.webContents.on('found-in-page', (_event, result) => this.owner.send({ type: 'found', tabId: tab.id, active: result.activeMatchOrdinal, matches: result.matches }));
    view.webContents.on('update-target-url', (_event, target) => this.owner.send({ type: 'target-url', tabId: tab.id, url: target.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 2048) }));
    view.webContents.on('zoom-changed', (_event, direction) => this.zoom(direction));
    // Closing the tools here reports it too, once, and by then the tab may have opened them again.
    view.webContents.on('devtools-closed', () => { if (this.closingTools) this.closingTools = false; else this.closeTools(); });
    const refresh = this.refresh = () => {
      if (!view.webContents || view.webContents.isDestroyed()) return;
      const contents = view.webContents;
      const current = contents.getURL(), loading = contents.isLoading();
      const committed = current && (current !== 'about:blank' || this.adopted) ? current : '';
      if (committed) {
        const page = contents.getTitle();
        tab.title = (page && !namedByAddress(page, committed) ? page : '') || title || untitledName(committed) || (committed === 'about:blank' ? committed : 'New Tab');
      }
      tab.url = this.pending ?? (committed || (this.adopted ? 'about:blank' : ''));
      tab.loading = loading;
      tab.zoom = Math.round(contents.getZoomFactor() * 100);
      tab.canBack = contents.navigationHistory.canGoBack(); tab.canForward = contents.navigationHistory.canGoForward(); this.changed();
    };
    view.webContents.on('page-title-updated', refresh);
    view.webContents.on('did-navigate', (_event, target) => {
      // A page on another origin starts without an icon, and a new page has no matches yet.
      let origin = ''; try { origin = new URL(target).origin; } catch {}
      if (this.favicon?.origin !== origin) this.setFavicon();
      // An icon still on its way belongs to the page before.
      this.faviconRequest++;
      this.owner.send({ type: 'found', tabId: tab.id, active: 0, matches: 0 });
    });
    // A page in a process of its own has nothing left of one that stopped responding.
    view.webContents.on('did-navigate', () => { this.pending = undefined; this.hung = this.restarting = false; refresh(); });
    view.webContents.on('did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame) this.pending = undefined; refresh(); });
    view.webContents.on('did-start-loading', () => { tab.error = undefined; this.offline = false; refresh(); });
    view.webContents.on('did-stop-loading', () => { this.pending = undefined; refresh(); });
    view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.error = description;
      this.offline = tunnelFailures.test(description) || entry.port === undefined && /^ERR_CONNECTION_/.test(description);
      this.changed();
    });
    view.webContents.on('will-navigate', (event, target) => { if (!pageAddress(target)) { event.preventDefault(); this.handOff(target); } });
    view.webContents.on('will-redirect', (event, target) => { if (!pageAddress(target)) { event.preventDefault(); this.handOff(target); } });
    view.webContents.on('will-frame-navigate', details => { if (!details.isMainFrame && systemLink(details.url)) { details.preventDefault(); this.handOff(details.url); } });
    view.webContents.on('context-menu', (_event, params) => this.owner.pageMenu?.(id, tab.id, params));
    // A page's popup becomes a tab of its session, where it keeps its opener. An application's session holds no other
    // tabs, so its popups open in an ordinary session, a blank one once its opener sends it to an address. Links opened
    // in the background are the user's own, within a second of a click or key; anything else opens at most once a second.
    let lastPopup = -Infinity;
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      const now = performance.now(), background = disposition === 'background-tab' && now - this.gesture < 1000, web = webAddress(url), system = systemLink(url);
      if (entry.closed || entry.muted.has(tab.id) || !web && !system && url !== 'about:blank' || !background && now - lastPopup < 1000) return { action: 'deny' };
      // Each click or key opens one background tab.
      if (background) this.gesture = -Infinity;
      else lastPopup = now;
      if (system) { this.handOff(url); return { action: 'deny' }; }
      if (entry.info.application && web) { this.owner.openPopup?.(entry.info.connectionId, url, entry.info.id); return { action: 'deny' }; }
      return {
        action: 'allow', outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: { spellcheck: false, focusOnNavigation: false } },
        createWindow: options => {
          const created = (options as { webContents?: WebContents }).webContents;
          if (entry.info.application) { if (created) entry.handOff(created); return created!; }
          // A popup in front of the page that had the keyboard takes it.
          const focused = !view.webContents.isDestroyed() && view.webContents.isFocused();
          const opened = new BrowserTabController(entry, { url: web ? url : undefined, contents: created, background: disposition === 'background-tab' });
          if (focused && disposition !== 'background-tab') opened.focus();
          return created!;
        },
      };
    });
    entry.tabs.set(tab.id, this); entry.info.tabs.push(tab);
    if (!background || !entry.info.activeTab) entry.info.activeTab = tab.id;
    entry.owner.host.tabs.set(tab.id, this); entry.contents.set(view.webContents.id, this);
    if (url && !contents) void view.webContents.loadURL(url).catch(() => {});
    this.renderOwner(); this.changed();
  }
  async action(action: string, input?: string, userInitiated = false) {
    if (this.closed) return;
    const entry = this.owner, tab = this.info, view = this.view, key = tab.id;
    if (['navigate', 'reload', 'hard-reload', 'back', 'forward', 'stop', 'close'].includes(action)) entry.certificates.cancel(tab);
    if (['navigate', 'reload', 'hard-reload', 'close'].includes(action) || action === 'back' && view.webContents.navigationHistory.canGoBack() || action === 'forward' && view.webContents.navigationHistory.canGoForward()) entry.certificates.forget(tab);
    if (userInitiated && ['navigate', 'reload', 'hard-reload', 'back', 'forward'].includes(action)) entry.muted.delete(key);
    if (entry.info.application && ['screenshot', 'clear-site-data', 'external'].includes(action)) throw new Error('Applications do not offer this command');
    switch (action) {
      case 'focus':
        // A tab whose selection is still on its way takes the keyboard once it is selected.
        if (entry.info.activeTab !== key) entry.focusing = key;
        else this.focus();
        return;
      case 'devtools':
        if (this.tools) this.closeTools(); else this.openTools();
        return;
      case 'zoom-in': this.zoom('in'); return;
      case 'zoom-out': this.zoom('out'); return;
      case 'zoom-reset': this.zoom('reset'); return;
      case 'print':
        // A held key asks again while the dialog is open.
        if (this.printing) return;
        this.printing = true;
        try { await new Promise<void>((resolve, reject) => view.webContents.print({}, (success, reason) => { if (success || !reason || /cancel/i.test(reason)) resolve(); else reject(new Error(reason)); })); }
        finally { this.printing = false; }
        return;
      case 'pdf': {
        if (this.printing) return;
        this.printing = true;
        try {
          const data = await view.webContents.printToPDF({ printBackground: true });
          const { filePath } = await dialog.showSaveDialog(this.owner.window, { title: 'Save as PDF', defaultPath: join(app.getPath('downloads'), `${fileName(tab.title)}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (filePath) await writeFile(filePath, data);
        } finally { this.printing = false; }
        return;
      }
      case 'screenshot': {
        if (this.printing || !tab.url) return;
        this.printing = true;
        try {
          const image = await view.webContents.capturePage();
          const { filePath } = await dialog.showSaveDialog(this.owner.window, { title: 'Save Screenshot', defaultPath: join(app.getPath('downloads'), `${fileName(tab.title)}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] });
          if (filePath) await writeFile(filePath, image.toPNG());
        } finally { this.printing = false; }
        return;
      }
      case 'external': await shell.openExternal(linkURL(tab.url)); return;
      case 'clear-site-data': {
        const current = view.webContents.getURL();
        if (!/^https?:\/\//i.test(current)) return;
        // Storage and cache go for the page's origin, and cookies only where the page's address would send them.
        await entry.session.clearData({ dataTypes: ['backgroundFetch', 'cache', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'], origins: [new URL(current).origin] });
        for (const cookie of await entry.session.cookies.get({ url: current })) await entry.session.cookies.remove(current, cookie.name);
        if (this.closed) return;
        view.webContents.reload();
        break;
      }
      case 'mute': view.webContents.setAudioMuted(!view.webContents.isAudioMuted()); tab.muted = view.webContents.isAudioMuted(); break;
      case 'select': entry.info.activeTab = key; break;
      case 'close':
        if (entry.hasDownloadDialog()) throw new Error('Close the download dialog first');
        await this.close();
        break;
      case 'navigate': {
        const url = tab.url = this.pending = this.requested = entry.url(input ?? '');
        tab.error = undefined;
        // A load the page refuses, as from its unload handler, leaves the page as it was.
        void view.webContents.loadURL(url).catch(() => {
          if (this.pending !== url || this.closed || view.webContents.isDestroyed() || view.webContents.isLoading()) return;
          this.pending = undefined; this.refresh();
        });
        break;
      }
      case 'back': if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); break;
      case 'reload': case 'hard-reload':
        // A page that has stopped responding is ended first, so that it loads in a new process.
        if (this.hung) { this.hung = false; this.restarting = true; view.webContents.forcefullyCrashRenderer(); }
        // A tab whose first page never arrived has nothing to reload, so it is sent there again.
        if (!view.webContents.getURL() && this.requested) void view.webContents.loadURL(this.requested).catch(() => {});
        else if (action === 'reload') view.webContents.reload();
        else view.webContents.reloadIgnoringCache();
        break;
      // Stopping leaves the page that was there, or else an empty tab.
      case 'stop': this.pending = undefined; view.webContents.stop(); break;
    }
    this.renderOwner(); this.changed();
    if (action === 'select') {
      if (entry.focusing === key || entry.focusing === true) this.focus();
      entry.focusing = undefined;
    }
  }
  /**
   * Asks before a mailto:, tel: or sms: link leaves for the system's default application. Only the tab on show asks, the
   * window one question at a time, and a tab asks none once the user has said no, until they act in it again.
   */
  handOff(url: string) {
    const target = systemLink(url), entry = this.owner, window = entry.window;
    if (!target || this.closed || entry.closed || entry.muted.has(this.info.id) || window.isDestroyed() || asking.has(window)) return;
    if (!window.isFocused() || !this.view.getVisible() || entry.display.visible !== entry.info.id || entry.info.activeTab !== this.info.id) return;
    // Every recipient shows; a long subject or body is cut short.
    const detail = target.replace(/[\u202a-\u202e\u2066-\u2069]/g, ''), cut = detail.search(/[?&](?:subject|body)=/);
    const recipients = cut < 0 ? detail : detail.slice(0, cut);
    asking.add(window);
    void entry.owner.host.ask({ kind: 'hand-off', detail: detail.length <= 300 || cut < 0 ? detail : recipients.length >= 299 ? `${recipients}…` : `${detail.slice(0, 299)}…`, page: this.view.webContents.isFocused() }, this.questions.signal).then(open => {
      if (open && !this.closed) entry.owner.openExternal?.(entry.info.connectionId, target);
      else if (open === false) entry.muted.add(this.info.id);
    }).finally(() => asking.delete(window));
  }
  focus() {
    if (this.view.getVisible() && this.owner.display.visible === this.owner.info.id && this.owner.info.activeTab === this.info.id) this.view.webContents.focus();
  }
  private setFavicon(icon?: { data: string; origin: string }) {
    if (!icon && !this.favicon) return;
    this.favicon = icon;
    const tabId = this.info.id;
    this.owner.send({ type: 'favicon', tabId, data: icon?.data });
  }
  /** Fetches a page's icon through its session, so the request takes the same route as the page, and keeps it only if it is a small image. */
  private async loadFavicon(icons: string[]) {
    const entry = this.owner, view = this.view, tabId = this.info.id;
    const request = ++this.faviconRequest;
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
    if (this.faviconRequest !== request || this.closed || view.webContents.isDestroyed()) return;
    let origin = ''; try { origin = new URL(view.webContents.getURL()).origin; } catch {}
    this.setFavicon(data ? { data, origin } : undefined);
  }
  /** Zoom belongs to a site within its session, so every tab of the session reports its zoom again. */
  private zoom(direction: 'in' | 'out' | 'reset') {
    const entry = this.owner, view = this.view;
    const current = Math.round(view.webContents.getZoomFactor() * 100);
    view.webContents.setZoomFactor((direction === 'reset' ? 100 : stepZoom(current, direction)) / 100);
    for (const tab of entry.tabs.values()) { const contents = tab.view.webContents; if (!contents.isDestroyed()) tab.info.zoom = Math.round(contents.getZoomFactor() * 100); }
    this.changed();
  }
  /**
   * Opens a tab's developer tools in a view of its own, docked inside the window by the application. The view uses the
   * tab's session, so requests the tools make take the same route as the page.
   */
  private openTools() {
    const entry = this.owner, tab = this.info, view = this.view;
    if (this.tools) return;
    const tools = new WebContentsView({ webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    tools.setVisible(false);
    tools.webContents.once('destroyed', () => { if (this.tools === tools) this.closeTools(); });
    this.owner.window.contentView.addChildView(tools); this.owner.added?.();
    tools.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void entry.action('new', undefined, url).catch(() => {});
      return { action: 'deny' };
    });
    tools.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && browserShortcut(input) === 'devtools') { event.preventDefault(); this.closeTools(); }
    });
    this.tools = tools;
    view.webContents.setDevToolsWebContents(tools.webContents);
    view.webContents.openDevTools({ mode: 'detach' });
    tab.devtools = true;
    this.renderOwner(); this.changed();
  }
  private closeTools() {
    const entry = this.owner, tab = this.info;
    const tools = this.tools;
    if (!tools) return;
    this.tools = undefined; tab.devtools = false;
    const contents = this.view.webContents;
    const inspecting = this.inspecting;
    this.inspecting = undefined;
    if (contents && !contents.isDestroyed()) {
      if (inspecting) contents.removeListener('devtools-opened', inspecting);
      this.closingTools = true;
      contents.closeDevTools();
    }
    this.toolsClosing = this.owner.disposeView(tools);
    if (!entry.closed) { this.renderOwner(); this.changed(); }
  }
  /** Opens a tab's developer tools on the element at a point of its page. */
  inspect(x: number, y: number) {
    const view = this.view;
    if (this.tools) { view.webContents.inspectElement(x, y); return; }
    const opened = () => { this.inspecting = undefined; view.webContents.inspectElement(x, y); };
    this.inspecting = opened;
    view.webContents.once('devtools-opened', opened);
    this.openTools();
  }
  replay() { if (this.favicon) this.owner.send({ type: 'favicon', tabId: this.info.id, data: this.favicon.data }); }
  /** Loads a page again whose load failed while its session was offline. */
  reconnected() {
    if (!this.offline || this.closed) return;
    this.offline = false;
    this.view.webContents.reload();
  }
  allowPrompts() { this.owner.muted.delete(this.info.id); }
  render(bounds?: Bounds, toolsBounds?: Bounds) {
    const window = this.owner.window;
    if (window.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor();
    const place = (view: WebContentsView, bounds?: Bounds) => {
      if (!view.webContents || view.webContents.isDestroyed()) return;
      if (bounds) {
        view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
        view.setVisible(true); return;
      }
      if (view.webContents.isFocused()) window.webContents.focus();
      if (!view.getVisible()) return;
      view.setVisible(false);
      this.owner.send({ type: 'target-url', tabId: this.info.id, url: '' });
    };
    if (this.fullscreen && !bounds) this.leaveFullscreen();
    if (this.fullscreen && bounds) {
      const [width, height] = window.getContentSize();
      this.view.setBounds({ x: 0, y: 0, width, height });
      this.view.setVisible(true);
      if (this.tools) place(this.tools);
    } else {
      place(this.view, bounds);
      if (this.tools) place(this.tools, toolsBounds);
    }
  }
  prepareFullscreen() {
    if (!this.fullscreen) this.fullscreenWindow = this.owner.window.isFullScreen();
  }
  leaveFullscreen() {
    if (!this.fullscreen) return;
    this.fullscreen = false;
    // A view whose page is gone, as one that closed itself, no longer holds it.
    const contents = this.view.webContents as Electron.WebContents | undefined;
    if (contents && !contents.isDestroyed()) void contents.executeJavaScript('document.exitPointerLock(); navigator.keyboard?.unlock(); if (document.fullscreenElement) document.exitFullscreen();').catch(() => {});
  }
  private forget() {
    if (this.closed) return;
    this.closed = true;
    this.questions.abort();
    this.leaveFullscreen();
    this.faviconRequest++;
    this.closeTools();
    const entry = this.owner;
    entry.muted.delete(this.info.id);
    entry.tabs.delete(this.info.id);
    entry.contents.delete(this.contentsId);
    entry.owner.host.tabs.delete(this.info.id);
    if (!entry.closed && !entry.info.application && pageAddress(this.info.url)) entry.reopenable(this.info.url);
    // The tab beside a closed active tab takes its place; the application chooses again by the order it shows.
    const index = entry.info.tabs.findIndex(tab => tab.id === this.info.id);
    entry.info.tabs = entry.info.tabs.filter(tab => tab.id !== this.info.id);
    if (entry.info.activeTab === this.info.id) entry.info.activeTab = (entry.info.tabs[index] ?? entry.info.tabs[index - 1])?.id;
    // A destroyed page cannot finish its asynchronous fullscreen exit. The window shows the session without this tab as
    // it leaves fullscreen.
    if (this.fullscreenWindow !== undefined && !this.owner.window.isDestroyed()) this.owner.window.setFullScreen(this.fullscreenWindow);
  }
  /**
   * Lets the page ask before the user closes it, settling to whether the tab may close: a page that asks keeps its tab
   * unless the user chooses to leave it, and one that does not answer within a few seconds is closed anyway.
   */
  leave() {
    const contents = this.view.webContents;
    if (this.closing || contents.isDestroyed() || this.owner.hasDownloadDialog()) return Promise.resolve(true);
    return this.leaving ??= new Promise<boolean>(resolve => {
      const done = (leave: boolean | Promise<boolean>) => { clearTimeout(timer); contents.off('will-prevent-unload', ask); contents.off('destroyed', gone); resolve(leave); };
      // The page's objection cancels the close, and the user decides; leaving closes the tab without asking the page again.
      const ask = () => done(this.owner.owner.host.ask({ kind: 'leave', detail: (this.info.title || this.info.url).replace(/[\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160) }, this.questions.signal).then(leave => leave === true));
      // A page that does not object is gone by now; its view still leaves the window.
      const gone = () => { void this.close(); done(true); };
      const timer = setTimeout(() => done(true), 5000);
      contents.once('will-prevent-unload', ask);
      contents.once('destroyed', gone);
      contents.close({ waitForBeforeUnload: true });
    }).finally(() => { this.leaving = undefined; });
  }
  close() {
    if (this.closing) return this.closing;
    this.owner.certificates.cancel(this.info);
    this.forget();
    return this.closing = Promise.all([this.owner.disposeView(this.view), this.toolsClosing]).then(() => {});
  }
  find(request: { text: string; forward: boolean; next: boolean } | null) {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    if (request?.text) { contents.findInPage(request.text, { forward: request.forward, findNext: !request.next }); return; }
    contents.stopFindInPage('clearSelection');
    this.owner.send({ type: 'found', tabId: this.info.id, active: 0, matches: 0 });
    if (!request && this.owner.display.visible === this.owner.info.id && this.owner.info.activeTab === this.info.id) contents.focus();
  }
}
