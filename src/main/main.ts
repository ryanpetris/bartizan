import { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, clipboard, type IpcMainInvokeEvent, type IpcMainEvent, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { configurationFile } from '../core/config';
import { createBackend } from '../backend/app';
import { dispatch, type Request } from '../transport';
import { graphicsLog, observeGraphics } from './graphics';
import { applications as applicationNames } from './application-session';
import { Browsers } from './browser';
import { BrowserWindowController } from './browser-window';
import { LinkMenus } from './link-menu';
import { Overlays } from './overlays';
import { themes } from '../themes';
import { defaultSettings, browserActions, overlayNames, pageShortcuts, type PageShortcut, type Event } from '../shared';

const args = process.argv.slice(app.isPackaged ? 1 : 2);
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
  const window = new BrowserWindow({ width: 1250, height: 820, minWidth: 800, minHeight: 500, title: 'Bartizan', titleBarStyle: 'hidden', titleBarOverlay: process.platform === 'darwin' ? true : titleBarOverlay(), webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const updateTitleBar = () => { if (process.platform !== 'darwin' && !window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay()); };
  nativeTheme.on('updated', updateTitleBar);
  window.once('closed', () => nativeTheme.off('updated', updateTitleBar));
  window.setMenuBarVisibility(false);
  const html = join(__dirname, 'index.html');
  const developmentURL = !app.isPackaged && process.env.ELECTRON_RENDERER_URL;
  const origin = developmentURL ? new URL(developmentURL).href : pathToFileURL(html).href;
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin));
  const send = (event: Event) => { if (!window.isDestroyed()) window.webContents.send('event', event); };
  const reveal = () => { if (window.isMinimized()) window.restore(); window.focus(); };
  let activatedAt = -Infinity;
  window.on('focus', () => { activatedAt = performance.now(); });
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === origin;
  const backend = await createBackend({
    file, directory: app.getPath('userData'), helper: join(__dirname, 'askpass.cjs'),
    capabilities: { embeddedBrowser: true, nativeFilePicker: true }, send,
    appearance(value) { settings = value; nativeTheme.themeSource = settings.appearance; updateTitleBar(); },
    extend({ sessions, changed, send, handle, serialize, terminalConnection, reportError }) {
  const browsers = new BrowserWindowController();
  const applicationOwner = (id: string) => {
    const application = browsers.owner(id).application;
    if (!application) throw new Error('Application is closed');
    return application;
  };
  handle('new-application', (id: unknown, application: unknown) => serialize(() => sessions.get(z.string().parse(id)).openApplication(z.enum(Object.keys(applicationNames) as (keyof typeof applicationNames)[]).parse(application))));
  handle('retry-application', (id: unknown) => applicationOwner(z.string().parse(id)).retry());
  handle('respond-application', (id: unknown, consentId: unknown, accepted: unknown) => applicationOwner(z.string().parse(id)).respond(z.string().parse(consentId), z.boolean().parse(accepted)));
  const overlays = new Overlays(window);
  sessions.added = connection => {
    const owned = connection.browsers = new Browsers(connection, browsers, window, (id, action) => send({ type: 'browser-shortcut', id, action }), send);
    owned.added = () => overlays.raise();
    owned.openPopup = (id, url) => linkMenus.open(id, url, undefined, true);
    owned.pageMenu = (id, tabId, params) => { try { linkMenus.page(id, tabId, params); } catch {} };
  };
  // A menu's accelerators receive only the keys that a page, or the application's own page, leaves alone.
  const pageShortcut = (name: PageShortcut) => {
    // A dialog open over the page keeps the page's keys from it.
    if (overlays.holdsModal()) return;
    const target = browsers.target();
    if (target) browsers.pageShortcut(name, target).catch(error => reportError('browser', String(error), target.connectionId));
  };
  const menu: MenuItemConstructorOptions[] = process.platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }] : [];
  menu.push({ label: 'Page', submenu: (Object.keys(pageShortcuts) as PageShortcut[]).flatMap(name => pageShortcuts[name].map(accelerator => ({ label: name, accelerator, click: () => pageShortcut(name) }))) });
  if (process.platform === 'darwin') menu.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  const linkMenus = new LinkMenus(window, sessions, browsers, serialize, id => send({ type: 'select-browser', id }), (message, id, label) => reportError('link', message, id, label));
  handle('link-menu', (id: unknown, url: unknown, session: unknown) => linkMenus.show(terminalConnection(id), z.union([z.string().max(8192), z.array(z.string().max(8192)).max(64)]).parse(url), { first: z.string().optional().parse(session) }));
  handle('open-link', (id: unknown, url: unknown, session: unknown) => linkMenus.open(terminalConnection(id), z.string().max(8192).parse(url), z.string().optional().parse(session), true));
  handle('certificate-answer', (id: unknown, allow: unknown) => browsers.answerCertificate(z.string().uuid().parse(id), z.boolean().parse(allow)));
  handle('choose-file', async () => { const result = await dialog.showOpenDialog(window, { properties: ['openFile'] }); return result.filePaths[0]; });
  handle('copy', (text: unknown) => clipboard.writeText(z.string().parse(text)));
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
    // Developer tools, sound, zoom and printing leave connections and sessions as they are, so they do not wait their turn.
    if (['devtools', 'mute', 'zoom-in', 'zoom-out', 'zoom-reset', 'print', 'pdf'].includes(operation)) return browsers.action(workspaceId, operation, z.string().optional().parse(tab));
    return serialize(async () => {
      const entry = browsers.entries.get(workspaceId);
      if (!entry && (operation === 'close' || operation === 'close-workspace')) return;
      if (!entry) throw new Error('Browser session is closed');
      await browsers.action(workspaceId, operation, z.string().optional().parse(tab), z.string().max(8192).optional().parse(url), true);
    });
  });
  const findSchema = z.strictObject({ text: z.string().max(4096), forward: z.boolean(), next: z.boolean() }).nullable();
  handle('find', (id: unknown, tab: unknown, request: unknown) => browsers.find(z.string().parse(id), z.string().parse(tab), findSchema.parse(request)));
  handle('download', (id: unknown, action: unknown, download: unknown) => browsers.download(z.string().parse(id), z.enum(['cancel', 'show', 'clear']).parse(action), z.string().optional().parse(download)));
  const menuItems = z.array(z.union([z.strictObject({ label: z.string().max(256), enabled: z.boolean() }), z.strictObject({ separator: z.literal(true) })])).max(24);
  handle('menu', (items, x, y) => {
    const parsed = menuItems.safeParse(items);
    if (!parsed.success || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const zoom = window.webContents.getZoomFactor();
    Menu.buildFromTemplate(parsed.data.map((item, index) => 'separator' in item ? { type: 'separator' as const } : { label: item.label, enabled: item.enabled, click: () => send({ type: 'menu', index }) }))
      .popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) });
  });
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
  window.webContents.on('did-navigate', () => { browsers.show(null); overlays.close(); });
  window.webContents.on('render-process-gone', (_event, details) => {
    graphicsLog('renderer-process-gone', { reason: details.reason, exitCode: details.exitCode });
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
    clearTimeout(recoveryTimer); void backend.close();
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
  window.webContents.on('did-finish-load', () => { for (const event of backend.snapshot()) send(event); backend.replay(); });
  onInstance = () => {
    if (!window.isDestroyed()) reveal();
  };
  if (developmentURL) await window.loadURL(origin);
  else await window.loadFile(html);
});
app.on('window-all-closed', () => app.quit());
app.on('select-client-certificate', (event, _contents, _url, _certificates, callback) => { event.preventDefault(); callback(); });
}
