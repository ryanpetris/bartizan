import { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, clipboard, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { configurationFile, ensureConfiguration, loadCatalog, resolveSpec, redactSpec, type Spec, type Catalog } from '../core/config';
import { masterArgs } from '../core/ssh';
import { Askpass } from './askpass';
import { Sessions } from './sessions';
import { Errors } from './errors';
import { graphicsLog, observeGraphics } from './graphics';
import { Browsers } from './browser';
import { LinkMenus } from './link-menu';
import { defaultSettings, type State, type Event } from '../shared';
import { profileDraft, profileChangesSchema, profileSaveSchema, prepareProfile, saveProfile, saveSettings, resolveDraft, type Draft } from '../core/profiles';

if (process.env.ELECTRON_DISABLE_SANDBOX || ['no-sandbox', 'disable-seccomp-filter-sandbox', 'disable-namespace-sandbox', 'disable-setuid-sandbox', 'single-process', 'no-zygote'].some(flag => app.commandLine.hasSwitch(flag))) {
  console.error('Bartizan requires Chromium sandboxing');
  app.exit(1);
}
app.enableSandbox();
const args = process.argv.slice(app.isPackaged ? 1 : 2);
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
  let catalog: Catalog = { settings, defaults: {}, profiles: [], file };
  let configError: string | undefined;
  try {
    ensureConfiguration(file);
    catalog = loadCatalog(file);
  } catch (error) { configError = String(error); }
  settings = catalog.settings;
  nativeTheme.themeSource = settings.appearance;
  const titleBarOverlay = () => ({ height: 48, color: nativeTheme.shouldUseDarkColors ? '#171a1f' : '#f7f8fa', symbolColor: nativeTheme.shouldUseDarkColors ? '#dde1e6' : '#1d2329' });
  const window = new BrowserWindow({ width: 1250, height: 820, minWidth: 800, minHeight: 500, title: 'Bartizan', titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(), webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const updateTitleBar = () => { if (!window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay()); };
  nativeTheme.on('updated', updateTitleBar);
  window.once('closed', () => nativeTheme.off('updated', updateTitleBar));
  window.setMenuBarVisibility(false);
  const html = join(__dirname, 'index.html');
  const origin = pathToFileURL(html).href;
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window.webContents && permission === 'local-fonts' && details.isMainFrame && details.requestingUrl === origin));
  const send = (event: Event) => { if (!window.isDestroyed()) window.webContents.send('event', event); };
  const errors = new Errors(log => send({ type: 'errors', log }));
  const reportError = (source: string, message: string, connectionId?: string, label?: string) => errors.report({ source, message, connectionId, label: connectionId ? label ?? sessions.entries.get(connectionId)?.info.label : 'App' });
  const state = (): State => {
    errors.sync(configError);
    return { ...catalog, settings, configError, defaults: redactSpec(catalog.defaults), profiles: catalog.profiles.map(p => ({ ...p, spec: redactSpec(p.spec) })), connections: [...sessions.entries.values()].map(e => e.info), terminals: [...sessions.terminals.values()].map(e => e.info), workspaces: [...browsers.entries.values()].map(e => e.info), challenges: [...askpass.challenges, ...browsers.challenges] };
  };
  const changed = () => {
    browsers.sync(sessions.entries.values());
    send({ type: 'state', state: state() });
  };
  const askpass = new Askpass(changed, changed, (message, id) => reportError('credentials', message, id));
  await askpass.start();
  const sessions = new Sessions(join(app.getPath('userData'), 'ssh'), askpass, join(__dirname, 'askpass.cjs'), changed, (id, data) => send({ type: 'data', id, data }), (message, id, label) => reportError('ssh', message, id, label));
  const browsers = new Browsers(window, changed, (id, action) => send({ type: 'browser-shortcut', id, action }));
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === origin;
  const graphicsSchema = z.strictObject({ event: z.enum(['started', 'lost', 'restored', 'fallback']), backend: z.string().max(256).optional() });
  ipcMain.on('graphics', (event, value) => {
    const parsed = graphicsSchema.safeParse(value);
    if (trusted(event) && parsed.success) graphicsLog(`terminal-${parsed.data.event}`, parsed.data.backend ? { renderer: parsed.data.backend } : {});
  });
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...values) => { if (!trusted(event)) throw new Error('Untrusted caller'); return fn(...values); });
  let connecting = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const result = connecting.then(work); connecting = result.then(() => {}, () => {}); return result;
  };
  const linkMenus = new LinkMenus(window, sessions, browsers, serialize, id => send({ type: 'select-browser', id }), (message, id, label) => reportError('link', message, id, label));
  browsers.linkMenu = (id, url) => {
    const entry = browsers.entries.get(id);
    if (entry) { try { linkMenus.show(entry.info.connectionId, url, { current: id }); } catch {} }
  };
  const terminalConnection = (id: unknown) => {
    const terminal = sessions.terminals.get(z.string().parse(id));
    if (!terminal) throw new Error('Terminal is closed');
    return terminal.info.connectionId;
  };
  handle('link-menu', (id: unknown, url: unknown, session: unknown) => linkMenus.show(terminalConnection(id), z.union([z.string().max(8192), z.array(z.string().max(8192)).max(64)]).parse(url), { first: z.string().optional().parse(session) }));
  handle('open-link', (id: unknown, url: unknown, session: unknown) => linkMenus.open(terminalConnection(id), z.string().max(8192).parse(url), z.string().optional().parse(session), true));
  const removeConnection = async (id: string) => {
    const entry = sessions.entries.get(id);
    if (!entry) return;
    if (entry.info.status !== 'closed') throw new Error('Disconnect before removing a connection');
    await entry.ended; await browsers.closeConnection(id);
    sessions.remove(id);
  };
  /** Connects a profile in its existing sidebar entry, if it has one. */
  const createConnection = (spec: Spec, profileId?: string) =>
    sessions.create(spec, profileId, [...sessions.entries.values()].find(e => profileId && e.info.profileId === profileId)?.info.id);

  const errorSchema = z.strictObject({ source: z.string().min(1).max(64), message: z.string().min(1).max(16384), connectionId: z.string().max(256).optional(), label: z.string().max(4096).optional() });
  handle('report-error', (input: unknown) => {
    const entry = errorSchema.parse(input);
    reportError(entry.source, entry.message, entry.connectionId, entry.label);
  });
  handle('clear-errors', () => errors.clear());
  handle('certificate-answer', (id: unknown, allow: unknown) => browsers.answerCertificate(z.string().uuid().parse(id), z.boolean().parse(allow)));
  handle('reload-config', () => serialize(async () => {
    try {
      catalog = loadCatalog(file); configError = undefined;
      settings = catalog.settings; nativeTheme.themeSource = settings.appearance;
    } catch (error) { configError = String(error); throw error; }
    finally { changed(); }
  }));
  handle('choose-file', async () => { const result = await dialog.showOpenDialog(window, { properties: ['openFile'] }); return result.filePaths[0]; });
  handle('copy', (text: unknown) => clipboard.writeText(z.string().parse(text)));
  handle('settings', (patch: unknown) => serialize(async () => {
    catalog = saveSettings(catalog, patch as Partial<typeof settings>);
    configError = undefined;
    settings = catalog.settings;
    nativeTheme.themeSource = settings.appearance;
    changed();
  }));
  const commandPreview = (spec: Spec, port?: number) => {
    const command = masterArgs(spec, '<application trust store>', port ?? 0, '<control socket>');
    if (port === undefined) command[command.indexOf('-D') + 1] = '127.0.0.1:<allocated port>';
    return command;
  };
  // One form is open at a time, so only the latest draft is kept.
  let current: { token: string; draft: Draft } | undefined;
  const draftInput = (input: unknown) => {
    const changes = profileChangesSchema.parse(input);
    if (current?.token !== changes.token) throw new Error('Profile draft expired; reopen the profile');
    return { changes, draft: current.draft };
  };
  handle('profile-draft', (profileId: unknown) => {
    const id = z.string().min(1).optional().parse(profileId);
    const draft = profileDraft(catalog, id);
    current = { token: randomUUID(), draft };
    const { tags = [], ...spec } = draft.profile ?? {};
    return { token: current.token, id, file, spec: redactSpec(spec), tags };
  });
  handle('profile-preview', (input: unknown) => {
    const { changes, draft } = draftInput(input);
    return commandPreview(resolveDraft(catalog, draft, changes));
  });
  handle('profile-connect', (input: unknown) => serialize(async () => {
    const { changes, draft } = draftInput(input);
    if (draft.id) throw new Error('Save the profile before connecting');
    return createConnection(resolveDraft(catalog, draft, changes));
  }));
  handle('profile-save', (input: unknown) => serialize(async () => {
    const { id, connect, ...fields } = profileSaveSchema.parse(input);
    const { changes, draft } = draftInput(fields);
    if (draft.id && connect) throw new Error('Save the profile before connecting');
    const prepared = prepareProfile(catalog, draft, changes, id);
    const spec = connect ? resolveSpec(prepared.catalog, prepared.id, {}) : undefined;
    saveProfile(draft, prepared);
    catalog = prepared.catalog; configError = undefined;
    settings = catalog.settings; nativeTheme.themeSource = settings.appearance;
    const result: import('../shared').ProfileSaveResult = { profileId: prepared.id };
    changed();
    if (spec) {
      try { result.connectionId = await createConnection(spec, prepared.id); }
      catch (error) { result.connectionError = String(error); }
    }
    return result;
  }));
  handle('details', (id: unknown) => sessions.details(z.string().parse(id)));
  const targetSchema = z.union([z.strictObject({ profileId: z.string() }), z.strictObject({ host: z.string(), username: z.string().optional() })]);
  handle('connect', (input: unknown) => serialize(async () => {
    const target = targetSchema.parse(input);
    if (!('profileId' in target)) return createConnection(resolveSpec(catalog, undefined, target));
    return createConnection(resolveSpec(catalog, target.profileId, {}), target.profileId);
  }));
  const disconnect = (id: string) => sessions.disconnect(id);
  handle('disconnect', (id: unknown) => serialize(() => disconnect(z.string().parse(id))));
  handle('remove-connection', (id: unknown) => serialize(() => removeConnection(z.string().parse(id))));
  handle('reconnect', (id: unknown) => serialize(async () => {
    const entry = sessions.entries.get(z.string().parse(id)); if (!entry) throw new Error('Unknown connection');
    if (entry.info.status !== 'closed') throw new Error('Disconnect before reconnecting');
    const spec = entry.info.profileId ? resolveSpec(catalog, entry.info.profileId, {}) : entry.spec;
    return sessions.create(spec, entry.info.profileId, entry.info.id, false);
  }));
  handle('new-terminal', (id: unknown) => serialize(async () => sessions.newTerminal(z.string().parse(id))));
  handle('close-terminal', (id: unknown) => serialize(async () => sessions.closeTerminal(z.string().parse(id))));
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
  handle('answer', (id: unknown, value: unknown) => {
    const challengeId = z.string().parse(id);
    if (browsers.answerAuthentication(challengeId, value)) return;
    const connectionId = askpass.answer(challengeId, value);
    if (value === null && connectionId) void serialize(() => disconnect(connectionId));
  });
  handle('browser', async (id: unknown, action: unknown, tab: unknown, url: unknown) => {
    const workspaceId = z.string().parse(id);
    const operation = z.enum(['new', 'close', 'select', 'navigate', 'back', 'forward', 'reload', 'stop', 'close-workspace', 'devtools']).parse(action);
    if (operation === 'devtools') return browsers.action(workspaceId, operation, z.string().optional().parse(tab));
    return serialize(async () => {
      const entry = browsers.entries.get(workspaceId);
      if (!entry) throw new Error('Browser session is closed');
      await browsers.action(workspaceId, operation, z.string().optional().parse(tab), z.string().max(8192).optional().parse(url), true);
    });
  });
  ipcMain.on('input', (event, id, data) => { if (trusted(event) && typeof id === 'string' && typeof data === 'string' && data.length <= 1024 * 1024) sessions.input(id, data); });
  ipcMain.on('resize', (event, id, cols, rows, repaint) => { if (trusted(event) && typeof id === 'string' && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) sessions.resize(id, cols, rows, repaint === true); });
  const menuItems = z.array(z.strictObject({ label: z.string().max(256), enabled: z.boolean() })).max(16);
  ipcMain.on('menu', (event, items, x, y) => {
    const parsed = menuItems.safeParse(items);
    if (!trusted(event) || !parsed.success || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const zoom = window.webContents.getZoomFactor();
    Menu.buildFromTemplate(parsed.data.map(({ label, enabled }, index) => ({ label, enabled, click: () => send({ type: 'menu', index }) })))
      .popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) });
  });
  ipcMain.on('show-browser', (event, id, bounds) => {
    if (!trusted(event)) return;
    const parsed = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(0).max(10000), height: z.number().int().min(0).max(10000) }).optional().safeParse(bounds);
    if (parsed.success && (id === null || typeof id === 'string')) browsers.show(id, parsed.data);
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const recoveries: number[] = [];
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  window.webContents.on('did-navigate', () => browsers.show(null));
  window.webContents.on('render-process-gone', (_event, details) => {
    graphicsLog('renderer-process-gone', { reason: details.reason, exitCode: details.exitCode });
    if (window.isDestroyed()) return;
    browsers.show(null);
    if (!['crashed', 'killed', 'oom', 'abnormal-exit'].includes(details.reason)) return;
    const now = Date.now();
    while (recoveries.length && now - recoveries[0]! >= 30000) recoveries.shift();
    if (recoveries.length >= 3) return;
    const delay = recoveries.length ? 1000 : 0;
    recoveries.push(now);
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); }, delay);
  });
  window.webContents.on('did-finish-load', () => { changed(); send({ type: 'errors', log: errors.snapshot(), initial: true }); });
  window.on('close', () => { clearTimeout(recoveryTimer); void sessions.close(); askpass.close(); browsers.shutdown(); });
  onInstance = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  };
  await window.loadFile(html);
});
app.on('window-all-closed', () => app.quit());
app.on('select-client-certificate', (event, _contents, _url, _certificates, callback) => { event.preventDefault(); callback(); });
