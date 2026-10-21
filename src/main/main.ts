import { app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog, nativeTheme, clipboard, type IpcMainInvokeEvent, type IpcMainEvent, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { configurationFile } from '../core/config';
import { createBackend } from '../backend/app';
import { dispatch, type Request } from '../transport';
import { graphicsLog, observeGraphics } from './graphics';
import { Browsers } from './browser';
import { BrowserWindowController } from './browser-window';
import { LinkMenus, externalBrowserAvailable } from './link-menu';
import { Overlays } from './overlays';
import { Menus } from './menus';
import { themes } from '../themes';
import { applications, defaultSettings, browserActions, overlayNames, pageShortcuts, type ApplicationId, type PageShortcut, type FullscreenMode, type Event, type Question } from '../shared';

const args = process.argv.slice(process.defaultApp ? 2 : 1);
if (args[0] === 'serve') {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  process.execve!(process.execPath, [process.execPath, join(__dirname, 'server.cjs'), ...args.slice(1)], { ...environment, ELECTRON_RUN_AS_NODE: '1', BARTIZAN_DATA_DIR: process.env.BARTIZAN_DATA_DIR ?? app.getPath('userData') });
} else {
if (process.env.ELECTRON_DISABLE_SANDBOX || ['no-sandbox', 'disable-seccomp-filter-sandbox', 'disable-namespace-sandbox', 'disable-setuid-sandbox', 'single-process', 'no-zygote'].some(flag => app.commandLine.hasSwitch(flag))) {
  console.error('Bartizan requires Chromium sandboxing');
  app.exit(1);
}
app.enableSandbox();
if (process.env.BARTIZAN_DATA_DIR) app.setPath('userData', process.env.BARTIZAN_DATA_DIR);
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
let onInstance = () => {};
let closing: Promise<void> | undefined, exiting = false;
app.on('second-instance', () => onInstance());
if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(async () => {
  observeGraphics();
  Menu.setApplicationMenu(null);
  let file: string;
  try { file = configurationFile(args, process.cwd(), join(app.getPath('userData'), 'config.yaml')); }
  catch (error) { console.error(String(error)); app.exit(1); return; }
  let settings = { ...defaultSettings };
  nativeTheme.themeSource = settings.appearance;
  // The native window controls follow the theme's title bar and the appearance.
  const titleBarOverlay = () => { const { height, dark, light } = themes[settings.theme].controls; return { height, ...(nativeTheme.shouldUseDarkColors ? dark : light) }; };
  // Remote programs wait for terminals to process their output, so the page keeps its pace while the window is hidden.
  const window = new BrowserWindow({ width: 1250, height: 820, minWidth: 800, minHeight: 500, title: 'Bartizan', titleBarStyle: 'hidden', titleBarOverlay: process.platform === 'darwin' ? true : titleBarOverlay(), webPreferences: { preload: join(__dirname, '../preload/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  const updateTitleBar = () => { if (process.platform !== 'darwin' && !window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay()); };
  nativeTheme.on('updated', updateTitleBar);
  window.once('closed', () => nativeTheme.off('updated', updateTitleBar));
  window.setMenuBarVisibility(false);
  const html = join(__dirname, '../renderer/index.html');
  const developmentURL = import.meta.env.DEV && process.env.ELECTRON_RENDERER_URL;
  const origin = developmentURL ? new URL(developmentURL).href : pathToFileURL(html).href;
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin));
  const send = (event: Event) => { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('event', event); };
  let fullscreen: FullscreenMode = false;
  const fullscreenChanged = () => send({ type: 'fullscreen', mode: fullscreen });
  window.on('enter-full-screen', () => { fullscreen ||= 'window'; fullscreenChanged(); });
  window.on('leave-full-screen', () => { fullscreen = false; fullscreenChanged(); });
  const reveal = () => { if (window.isMinimized()) window.restore(); window.focus(); };
  let activatedAt = -Infinity;
  window.on('focus', () => { activatedAt = performance.now(); });
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === origin;
  const backend = await createBackend({
    file, directory: app.getPath('userData'), helper: join(__dirname, 'askpass.cjs'),
    capabilities: { embeddedBrowser: true, nativeFilePicker: true, externalBrowser: externalBrowserAvailable(), vnc: true }, send,
    appearance(value) { settings = value; nativeTheme.themeSource = settings.appearance; updateTitleBar(); },
    extend({ sessions, changed, send, handle, serialize, terminalConnection, reportError }) {
  const browsers = new BrowserWindowController();
  // Questions put to the user in the application's dialogs, by request ID. Each settles once: with the user's answer, or
  // unanswered once it is withdrawn, the page that would show it has gone or the window has closed. A page that loads asks
  // those still open.
  const questions = new Map<string, { question: Question; settle: (proceed?: boolean) => void; forget: () => void }>();
  const settleQuestion = (id: string, proceed?: boolean) => {
    const question = questions.get(id);
    questions.delete(id);
    question?.forget();
    question?.settle(proceed);
    return Boolean(question);
  };
  const declineQuestions = () => { for (const id of [...questions.keys()]) settleQuestion(id); };
  browsers.ask = (question, signal) => new Promise(settle => {
    if (signal.aborted || window.isDestroyed() || window.webContents.isCrashed()) { settle(undefined); return; }
    const id = randomUUID(), withdraw = () => { if (settleQuestion(id)) send({ type: 'question-withdrawn', id }); };
    questions.set(id, { question, settle, forget: () => signal.removeEventListener('abort', withdraw) });
    signal.addEventListener('abort', withdraw, { once: true });
    send({ type: 'question', id, question });
  });
  handle('answer-question', (id: unknown, proceed: unknown) => { settleQuestion(z.string().parse(id), z.boolean().parse(proceed)); });
  window.webContents.on('did-finish-load', () => { for (const [id, { question }] of questions) send({ type: 'question', id, question }); });
  window.once('closed', declineQuestions);
  window.on('resize', () => browsers.entries.get(browsers.display.visible ?? '')?.render());
  window.on('leave-full-screen', () => {
    for (const tab of browsers.tabs.values()) tab.leaveFullscreen();
    browsers.entries.get(browsers.display.visible ?? '')?.render();
  });
  const applicationOwner = (id: string) => {
    const application = browsers.owner(id).application;
    if (!application) throw new Error('Application is closed');
    return application;
  };
  handle('new-application', (id: unknown, application: unknown) => serialize(() => sessions.get(z.string().parse(id)).openApplication(z.enum(Object.keys(applications) as ApplicationId[]).parse(application))));
  handle('retry-application', (id: unknown) => applicationOwner(z.string().parse(id)).retry());
  handle('respond-application', (id: unknown, consentId: unknown, accepted: unknown) => applicationOwner(z.string().parse(id)).respond(z.string().parse(consentId), z.boolean().parse(accepted)));
  const overlays = new Overlays(window, contents => fieldMenu(contents));
  const menus = new Menus(window, overlays, send);
  // Input in the application decides where the keyboard goes ahead of a tab whose selection is still on its way.
  const forgetFocus = () => { for (const entry of browsers.entries.values()) entry.focusing = undefined; };
  window.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') forgetFocus(); });
  window.webContents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown') forgetFocus(); });
  sessions.added = connection => {
    const owned = connection.browsers = new Browsers(connection, browsers, window, (id, action) => send({ type: 'browser-shortcut', id, action }), send);
    owned.added = () => overlays.raise();
    owned.openPopup = (id, url, from) => linkMenus.open(id, url, undefined, `session:${from}`);
    owned.openExternal = (id, url) => linkMenus.external(id, url);
    owned.pageMenu = (id, tabId, params) => { try { linkMenus.page(id, tabId, params); } catch {} };
  };
  // A menu's accelerators receive only the keys that a page, or the application's own page, leaves alone.
  const pageShortcut = (name: PageShortcut) => {
    // A dialog or menu open over the page keeps the page's keys from it.
    if (overlays.holdsModal() || overlays.visible('popup')) return;
    const target = browsers.target();
    if (target) browsers.pageShortcut(name, target).catch(error => reportError('browser', String(error), target.connectionId));
  };
  const setFullscreen = (mode: FullscreenMode) => {
    fullscreen = mode;
    if (fullscreen === 'window') for (const tab of browsers.tabs.values()) tab.leaveFullscreen();
    window.setFullScreen(fullscreen !== false);
    fullscreenChanged();
    if (fullscreen === 'content') {
      const target = browsers.target(), tab = target && browsers.tabs.get(target.tabId);
      if (tab?.view.getVisible()) tab.view.webContents.focus();
    }
  };
  const toggleFullscreen = () => setFullscreen(window.isFullScreen() ? false : 'content');
  const observeFullscreenKey = (contents: Electron.WebContents) => {
    const owns = () => contents === window.webContents || window.contentView.children.some(view => view instanceof WebContentsView && view.webContents === contents);
    const matches = (input: Electron.Input) => input.key === 'F11' && !input.control && !input.alt && !input.meta && !input.shift;
    contents.on('before-input-event', (event, input) => {
      if (!owns() || !matches(input)) return;
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) toggleFullscreen();
    });
    // Keyboard capture can bypass before-input-event and deliver keys directly to the page.
    contents.on('input-event', (_event, event) => {
      if (event.type !== 'rawKeyDown' && event.type !== 'keyDown') return;
      // Electron supplies keyboard fields here, but types this event as InputEvent.
      const input = event as Electron.InputEvent & Omit<Electron.Input, 'type'>;
      if (owns() && matches(input) && !input.isAutoRepeat) toggleFullscreen();
    });
  };
  const created = (_event: Electron.Event, contents: Electron.WebContents) => { observeFullscreenKey(contents); menus.observe(contents); };
  observeFullscreenKey(window.webContents);
  menus.observe(window.webContents);
  app.on('web-contents-created', created);
  window.once('closed', () => app.off('web-contents-created', created));
  const menu: MenuItemConstructorOptions[] = process.platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }] : [];
  menu.push({ label: 'Page', submenu: (Object.keys(pageShortcuts) as PageShortcut[]).flatMap(name => pageShortcuts[name]
    .filter(accelerator => process.platform === 'darwin' || !accelerator.startsWith('Cmd+'))
    .map(accelerator => ({ label: name, accelerator, click: () => pageShortcut(name) }))) });
  menu.push({ label: 'View', submenu: [{ label: 'Toggle Fullscreen', accelerator: 'F11', click: toggleFullscreen }] });
  if (process.platform === 'darwin') menu.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  const linkMenus = new LinkMenus(menus, sessions, browsers, serialize, id => send({ type: 'select-browser', id }), (message, id, label) => reportError('link', message, id, label));
  // Text fields of the application and its dialogs have a menu of their own; the address field's names the page it shows.
  // A terminal's input is a text field too, but the terminal has its own handling of the mouse.
  const fieldMenu = (contents: Electron.WebContents) => contents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const field: Promise<unknown> = contents === window.webContents
      ? contents.executeJavaScript('(() => { const field = document.activeElement; return field?.closest(".xterm") ? "terminal" : field?.matches("input.address") ? { url: field.dataset.url ?? "" } : "field"; })()')
      : Promise.resolve('field');
    void field.then(kind => {
      if (kind === 'terminal') return;
      const address = typeof kind === 'object' && kind && 'url' in kind && typeof kind.url === 'string' ? kind.url : undefined;
      return linkMenus.field(contents, params, address === undefined ? undefined : { url: address, go: text => send({ type: 'paste-and-go', text }) });
    }).catch(() => {});
  });
  fieldMenu(window.webContents);
  const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
  handle('link-menu', (id: unknown, url: unknown, at: unknown) => linkMenus.show(window.webContents, terminalConnection(id), z.union([z.string().max(8192), z.array(z.string().max(8192)).max(64)]).parse(url), point.parse(at)));
  handle('menu-chosen', (id: unknown, item: unknown) => menus.choose(z.number().int().parse(id), z.number().int().nullable().parse(item)));
  handle('open-link', (id: unknown, url: unknown) => linkMenus.open(terminalConnection(id), z.string().max(8192).parse(url), undefined, `terminal:${id}`));
  handle('order-items', (id, keys) => {
    const parsed = z.array(z.string().max(128)).max(2000).safeParse(keys), browsers = typeof id === 'string' ? sessions.entries.get(id)?.browsers : undefined;
    if (parsed.success && browsers) browsers.order = parsed.data;
  });
  handle('certificate-answer', (id: unknown, allow: unknown) => browsers.answerCertificate(z.string().uuid().parse(id), z.boolean().parse(allow)));
  handle('set-fullscreen', (mode: unknown) => setFullscreen(z.union([z.literal(false), z.enum(['window', 'content'])]).parse(mode)));
  handle('choose-file', async () => { const result = await dialog.showOpenDialog(window, { properties: ['openFile'] }); return result.filePaths[0]; });
  handle('copy', (text: unknown) => clipboard.writeText(z.string().parse(text)));
  handle('read-clipboard', () => clipboard.readText());
  // A click that brings the window to the front also reaches the page, which learns of it from here. A window that is not
  // in front yet is taken to be coming there, as where it learns of its activation after the click.
  handle('activated-within', (milliseconds: unknown) => !window.isFocused() || performance.now() - activatedAt <= z.number().nonnegative().parse(milliseconds));
  handle('new-browser', (id: unknown) => serialize(async () => {
    const connection = sessions.entries.get(z.string().parse(id));
    if (!connection) throw new Error('Connection is not connected');
    return browsers.open(connection, undefined, 'new');
  }));
  handle('new-browser-tab', (id: unknown, session: unknown) => serialize(async () => {
    const connection = sessions.entries.get(z.string().parse(id));
    if (!connection) throw new Error('Connection is not connected');
    return browsers.open(connection, undefined, z.string().optional().parse(session), true);
  }));
  handle('rename-browser', (id: unknown, name: unknown) => browsers.rename(z.string().parse(id), z.string().regex(/^[^\x00-\x1f\x7f]*$/, 'Control characters are not allowed').parse(name)));
  handle('browser', async (id: unknown, action: unknown, tab: unknown, url: unknown) => {
    const workspaceId = z.string().parse(id);
    const operation = z.enum(browserActions).parse(action);
    let tabId = z.string().optional().parse(tab);
    // Focus, developer tools, sound, zoom and printing leave connections and sessions as they are, so they do not wait their turn.
    if (['focus', 'devtools', 'mute', 'zoom-in', 'zoom-out', 'zoom-reset', 'print', 'pdf', 'screenshot', 'external'].includes(operation)) return browsers.action(workspaceId, operation, tabId);
    // A page may ask before it is closed, and the user's answer does not hold up other work.
    if (operation === 'close') {
      tabId ??= browsers.entries.get(workspaceId)?.info.activeTab;
      if (!await browsers.leave(workspaceId, tabId)) return;
    }
    return serialize(async () => {
      const entry = browsers.entries.get(workspaceId);
      if (!entry && (operation === 'close' || operation === 'close-workspace')) return;
      if (!entry) throw new Error('Browser is closed');
      await browsers.action(workspaceId, operation, tabId, z.string().max(8192).optional().parse(url), true);
    });
  });
  const findSchema = z.strictObject({ text: z.string().max(4096), forward: z.boolean(), next: z.boolean() }).nullable();
  handle('find', (id: unknown, tab: unknown, request: unknown) => browsers.find(z.string().parse(id), z.string().parse(tab), findSchema.parse(request)));
  handle('download', (id: unknown, action: unknown, download: unknown) => browsers.download(z.string().parse(id), z.enum(['cancel', 'show', 'clear']).parse(action), z.string().optional().parse(download)));
  const boundsSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(0).max(10000), height: z.number().int().min(0).max(10000) });
  handle('show-browser', (id, bounds, tools) => {
    const parsed = boundsSchema.optional().safeParse(bounds), parsedTools = boundsSchema.optional().safeParse(tools);
    if (parsed.success && parsedTools.success && (id === null || typeof id === 'string')) browsers.show(id, parsed.data, parsedTools.data);
  });
  handle('overlay', (name, bounds) => {
    const parsedName = z.enum(overlayNames).safeParse(name), parsed = boundsSchema.nullable().safeParse(bounds);
    if (parsedName.success && parsed.success) overlays.show(parsedName.data, parsed.data);
  });
  window.webContents.on('will-navigate', event => { if (!developmentURL || event.url !== origin) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(overlays.open);
  const recoveries: number[] = [];
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  window.webContents.on('did-navigate', () => { browsers.show(null); overlays.close(); declineQuestions(); });
  window.webContents.on('render-process-gone', (_event, details) => {
    graphicsLog('renderer-process-gone', { reason: details.reason, exitCode: details.exitCode });
    declineQuestions();
    if (window.isDestroyed()) return;
    browsers.show(null); overlays.close(); browsers.forgetFavicons();
    if (!['crashed', 'killed', 'oom', 'abnormal-exit'].includes(details.reason)) return;
    const now = Date.now();
    while (recoveries.length && now - recoveries[0]! >= 30000) recoveries.shift();
    if (recoveries.length >= 3) return;
    const delay = recoveries.length ? 1000 : 0;
    recoveries.push(now);
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); }, delay);
  });
  // Closing the window while a connection is live asks the renderer to confirm, unless the application is quitting. A crashed
  // renderer, or one that has left the question unacknowledged for two seconds, lets the window close.
  let quitting = false, confirmed = false, asked = 0;
  app.once('before-quit', () => { quitting = true; });
  handle('asking-to-quit', () => { asked = 0; });
  handle('quit', () => { confirmed = true; window.close(); });
  window.on('close', event => {
    const unanswered = asked && performance.now() - asked >= 2000;
    if (!quitting && !confirmed && !unanswered && !window.webContents.isCrashed() && [...sessions.entries.values()].some(e => e.info.status !== 'closed')) {
      event.preventDefault();
      asked ||= performance.now();
      reveal();
      send({ type: 'confirm-quit' });
      return;
    }
    clearTimeout(recoveryTimer); closing = backend.close();
  });
  // A page that loads while a question is unacknowledged, as after a crash, asks it.
  window.webContents.on('did-finish-load', () => { if (asked) { asked = performance.now(); send({ type: 'confirm-quit' }); } });
  return {
    state: () => ({ workspaces: [...browsers.entries.values()].map(e => e.info), challenges: browsers.challenges }),
    answer: (id, value) => browsers.answerAuthentication(id, value),
    replay: () => browsers.replay(),
    close: () => overlays.close(),
  };
    },
  });
  const graphicsSchema = z.strictObject({ event: z.enum(['started', 'lost', 'restored', 'fallback']), backend: z.string().max(256).optional() });
  ipcMain.handle('request', (event, request: Request) => {
    if (!trusted(event)) throw new Error('Untrusted caller');
    return dispatch(request, (method, args) => {
      if (method === 'graphics') {
        const value = graphicsSchema.parse(args[0]);
        graphicsLog(`terminal-${value.event}`, value.backend ? { renderer: value.backend } : {});
        return undefined;
      }
      return backend.request(method, args);
    });
  });
  ipcMain.handle('vnc-read', (event, connectionId, id, attempt) => {
    if (!trusted(event)) throw new Error('Untrusted caller');
    return backend.readVnc(connectionId, id, attempt);
  });
  ipcMain.handle('vnc-write', (event, connectionId, id, attempt, data) => {
    if (!trusted(event)) throw new Error('Untrusted caller');
    return backend.writeVnc(connectionId, id, attempt, data);
  });
  // A page that has gone, or been replaced and is still loading, holds no terminal back; once loaded it attaches.
  window.webContents.on('render-process-gone', () => backend.detach('desktop'));
  window.webContents.on('did-navigate', () => backend.detach('desktop'));
  window.webContents.on('did-finish-load', () => { backend.attach('desktop'); for (const event of backend.snapshot()) send(event); fullscreenChanged(); backend.replay(); });
  onInstance = () => {
    if (!window.isDestroyed()) reveal();
  };
  if (developmentURL) await window.loadURL(origin);
  else await window.loadFile(html);
});
app.on('window-all-closed', () => app.quit());
// Quitting waits a few seconds at most for SSH processes to end and their temporary files to go.
app.on('will-quit', event => {
  if (!closing) return;
  event.preventDefault();
  if (exiting) return;
  exiting = true;
  app.releaseSingleInstanceLock();
  void Promise.race([closing.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]).then(() => app.exit());
});
app.on('select-client-certificate', (event, _contents, _url, _certificates, callback) => { event.preventDefault(); callback(); });
}
