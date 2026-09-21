import { WebContentsView, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { browserShortcut, namedByAddress, stepZoom, type BrowserTab, type Bounds } from '../shared';
import type { BrowserSession } from './browser-session';

const faviconLimit = 64 * 1024;
const faviconTypes = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp']);
const fileName = (title: string) => title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'page';

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
  private inspecting?: () => void;
  private closing?: Promise<void>;
  private toolsClosing?: Promise<void>;
  private changed = () => this.owner.changed();
  private renderOwner = () => this.owner.render();
  constructor(readonly owner: BrowserSession, url?: string, title?: string) {
    const entry = owner, id = entry.info.id;
    const tab: BrowserTab = this.info = { id: randomUUID(), title: title ?? 'New Tab', url: url ?? '', loading: false, canBack: false, canForward: false, audible: false, muted: false, zoom: 100, devtools: false };
    const view = this.view = new WebContentsView({ webPreferences: { session: entry.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
    this.contentsId = view.webContents.id;
    view.setVisible(false);
    this.owner.window.contentView.addChildView(view); this.owner.added?.();
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    entry.certificates.attach(tab, view.webContents);
    const clearAuthentication = () => entry.finishLogins(entry.challenges.filter(challenge => challenge.tabId === tab.id).map(challenge => challenge.id));
    view.webContents.on('destroyed', () => {
      if (this.owner.display.visible === id && entry.info.activeTab === tab.id && !this.owner.window.isDestroyed()) this.owner.window.webContents.focus();
      this.forget();
      clearAuthentication();
      if (entry.closed) return;
      this.renderOwner(); this.changed();
    });
    view.webContents.on('render-process-gone', () => { entry.muted.add(tab.id); clearAuthentication(); this.owner.send({ type: 'target-url', tabId: tab.id, url: '' }); });
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

    view.webContents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown' && input.button !== 'right') entry.muted.delete(tab.id); });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (!input.control && !input.meta && !input.alt && ['Enter', ' '].includes(input.key)) entry.muted.delete(tab.id);
      const shortcut = browserShortcut(input);
      if (!shortcut || entry.info.application && shortcut !== 'new-connection') return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      // The address and the connection form belong to the application.
      if (shortcut === 'devtools') void this.action(shortcut, undefined, true).catch(() => {});
      else { this.owner.window.webContents.focus(); this.owner.shortcut(id, shortcut); }
    });
    view.webContents.on('audio-state-changed', event => { tab.audible = event.audible; this.changed(); });
    view.webContents.on('page-favicon-updated', (_event, icons) => void this.loadFavicon(icons));
    view.webContents.on('found-in-page', (_event, result) => this.owner.send({ type: 'found', tabId: tab.id, active: result.activeMatchOrdinal, matches: result.matches }));
    view.webContents.on('update-target-url', (_event, target) => this.owner.send({ type: 'target-url', tabId: tab.id, url: target.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 2048) }));
    view.webContents.on('zoom-changed', (_event, direction) => this.zoom(direction));
    // Closing the tools here reports it too, once, and by then the tab may have opened them again.
    view.webContents.on('devtools-closed', () => { if (this.closingTools) this.closingTools = false; else this.closeTools(); });
    const refresh = () => {
      if (!view.webContents || view.webContents.isDestroyed()) return;
      const contents = view.webContents;
      const current = contents.getURL();
      if (current && current !== 'about:blank') {
        const page = contents.getTitle();
        tab.title = (page && !namedByAddress(page, current) ? page : '') || title || 'New Tab';
        tab.url = current;
      }
      tab.loading = contents.isLoading();
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
    view.webContents.on('did-navigate', refresh);
    view.webContents.on('did-navigate-in-page', refresh);
    view.webContents.on('did-start-loading', () => { tab.error = undefined; refresh(); });
    view.webContents.on('did-stop-loading', refresh);
    view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = description; this.changed(); } });
    view.webContents.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
    view.webContents.on('will-redirect', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
    view.webContents.on('context-menu', (_event, params) => this.owner.pageMenu?.(id, tab.id, params));
    let lastPopup = -Infinity;
    view.webContents.setWindowOpenHandler(({ url }) => {
      const now = performance.now();
      if (/^https?:\/\//i.test(url) && !entry.muted.has(tab.id) && now - lastPopup >= 1000) {
        lastPopup = now;
        if (entry.info.application) this.owner.openPopup?.(entry.info.connectionId, url);
        else void entry.action('new', undefined, url).catch(() => {});
      }
      return { action: 'deny' };
    });
    entry.tabs.set(tab.id, this); entry.info.tabs.push(tab); entry.info.activeTab = tab.id;
    entry.owner.host.tabs.set(tab.id, this); entry.contents.set(view.webContents.id, this);
    if (url) void view.webContents.loadURL(url).catch(() => {});
    this.renderOwner(); this.changed();
  }
  async action(action: string, input?: string, userInitiated = false) {
    if (this.closed) return;
    const entry = this.owner, tab = this.info, view = this.view, key = tab.id;
    if (['navigate', 'reload', 'hard-reload', 'back', 'forward', 'stop', 'close'].includes(action)) entry.certificates.cancel(tab);
    if (userInitiated && ['navigate', 'reload', 'hard-reload', 'back', 'forward'].includes(action)) entry.muted.delete(key);
    switch (action) {
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
          const { filePath } = await dialog.showSaveDialog(this.owner.window, { title: 'Save as PDF', defaultPath: `${fileName(tab.title)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (filePath) await writeFile(filePath, data);
        } finally { this.printing = false; }
        return;
      }
      case 'mute': view.webContents.setAudioMuted(!view.webContents.isAudioMuted()); tab.muted = view.webContents.isAudioMuted(); break;
      case 'select': entry.info.activeTab = key; break;
      case 'close':
        if (entry.hasDownloadDialog()) throw new Error('Close the download dialog first');
        await this.close();
        break;
      case 'navigate': tab.error = undefined; tab.url = entry.url(input ?? ''); void view.webContents.loadURL(tab.url).catch(() => {}); break;
      case 'back': if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); break;
      case 'reload': tab.error = undefined; view.webContents.reload(); break;
      case 'hard-reload': tab.error = undefined; view.webContents.reloadIgnoringCache(); break;
      case 'stop': view.webContents.stop(); break;
    }
    this.renderOwner(); this.changed();
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
  allowPrompts() { this.owner.muted.delete(this.info.id); }
  render(bounds?: Bounds, toolsBounds?: Bounds) {
    const window = this.owner.window;
    if (window.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor();
    const place = (view: WebContentsView, bounds?: Bounds) => {
      if (view.webContents.isDestroyed()) return;
      if (bounds) {
        view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
        view.setVisible(true); return;
      }
      if (view.webContents.isFocused()) window.webContents.focus();
      if (!view.getVisible()) return;
      view.setVisible(false);
      this.owner.send({ type: 'target-url', tabId: this.info.id, url: '' });
    };
    place(this.view, bounds);
    if (this.tools) place(this.tools, toolsBounds);
  }
  private forget() {
    if (this.closed) return;
    this.closed = true;
    this.faviconRequest++;
    this.closeTools();
    this.owner.muted.delete(this.info.id);
    this.owner.tabs.delete(this.info.id);
    this.owner.contents.delete(this.contentsId);
    this.owner.owner.host.tabs.delete(this.info.id);
    this.owner.info.tabs = this.owner.info.tabs.filter(tab => tab.id !== this.info.id);
    if (this.owner.info.activeTab === this.info.id) this.owner.info.activeTab = this.owner.info.tabs.at(-1)?.id;
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
