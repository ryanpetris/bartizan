import type { ApplicationState } from './helper-messages';
import type { RemoteSession, SessionFailure, HelperMessage, HelperRequest, HelperListener } from './helper-messages';
export type { RemoteSession } from './helper-messages';
import type { Spec, PublicSpec, PublicProfile } from './core/config';
import type { ConnectionInfo } from './main/connection-info';
import type { Challenge } from './main/askpass';
import type { ThemeId } from './themes';
export function shortcutKey({ key, code }: { key: string; code: string }): string {
  return !/^[a-z]$/i.test(key) && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : key.toLowerCase();
}
/** A key press, as a page's input event or the application's keyboard event describes it. */
export type KeyPress = { key: string; code: string; control: boolean; meta: boolean; alt: boolean; shift: boolean };
export type BrowserShortcut = 'devtools' | 'focus-address' | 'new-connection' | 'new-tab' | 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab';
/** The shortcut the application takes from a key press before a page sees it; it is the same in a page and in the application around it. */
export function browserShortcut(input: KeyPress): BrowserShortcut | undefined {
  const { control, meta, alt, shift } = input, key = shortcutKey(input);
  if (key === 'f12' && !control && !meta && !alt && !shift) return 'devtools';
  if (key === 'i' && (control && shift && !meta && !alt || meta && alt && !control && !shift)) return 'devtools';
  if (control && !meta && !alt && (key === 'tab' || !shift && (key === 'pagedown' || key === 'pageup')))
    return key === 'pagedown' || key === 'tab' && !shift ? 'next-tab' : 'previous-tab';
  if (!(control || meta) || alt) return;
  if (key === 't') return shift ? 'reopen-tab' : 'new-tab';
  return key === 'l' && !shift ? 'focus-address' : key === 'n' && shift ? 'new-connection' : key === 'w' && !shift ? 'close-tab' : undefined;
}
/**
 * Shortcuts a page sees first, with their accelerators: the application acts on one only when the page leaves the key
 * alone. Accelerators with Cmd apply on macOS only.
 */
export const pageShortcuts = {
  back: ['Alt+Left', 'Cmd+['],
  forward: ['Alt+Right', 'Cmd+]'],
  find: ['CmdOrCtrl+F'],
  reload: ['CmdOrCtrl+R', 'F5'],
  'hard-reload': ['CmdOrCtrl+Shift+R', 'CmdOrCtrl+F5', 'Shift+F5'],
  print: ['CmdOrCtrl+P'],
  'zoom-in': ['CmdOrCtrl+=', 'CmdOrCtrl+Plus', 'CmdOrCtrl+numadd'],
  'zoom-out': ['CmdOrCtrl+-', 'CmdOrCtrl+numsub'],
  'zoom-reset': ['CmdOrCtrl+0', 'CmdOrCtrl+num0'],
} as const;
export type PageShortcut = keyof typeof pageShortcuts;
/** A page shortcut's accelerator as a menu shows it: the platform's first, in its notation. */
export function shortcutLabel(name: PageShortcut, mac: boolean): string {
  const accelerators: readonly string[] = pageShortcuts[name];
  const accelerator = (mac ? accelerators.find(value => value.startsWith('Cmd')) : accelerators.find(value => !value.startsWith('Cmd+'))) ?? accelerators[0]!;
  if (!mac) return accelerator.replace('CmdOrCtrl+', 'Ctrl+');
  const symbols: Record<string, string> = { CmdOrCtrl: '⌘', Cmd: '⌘', Shift: '⇧', Alt: '⌥', Left: '←', Right: '→' };
  return accelerator.split('+').map(part => symbols[part] ?? part).join('');
}
/** A size in bytes in the largest unit that keeps it at least 1, to one decimal place below 10. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/** The zoom levels a page steps through, in percent. */
export const zoomLevels = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
/** The zoom level one step in or out from a page's current zoom. */
export const stepZoom = (zoom: number, direction: 'in' | 'out') =>
  direction === 'in' ? zoomLevels.find(level => level > zoom + 0.5) ?? zoom : [...zoomLevels].reverse().find(level => level < zoom - 0.5) ?? zoom;
const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** An SSH username that OpenSSH cannot read as an option or a destination. */
export const usernamePattern = /^(?!-)[^\s@]*$/;
/** Returns an SSH hostname, with brackets removed from IPv6 literals. */
export function normalizeHost(input: string): string | undefined {
  const bracketed = input.startsWith('[') || input.endsWith(']');
  if (bracketed && !(input.startsWith('[') && input.endsWith(']'))) return;
  const host = bracketed ? input.slice(1, -1) : input;
  if (host.includes(':')) {
    const [address, scope, ...extra] = host.split('%');
    if (extra.length || (scope !== undefined && !/^[A-Za-z0-9_.-]+$/.test(scope)) || !/^[0-9A-Fa-f:.]+$/.test(address!)) return;
    try { new URL(`http://[${address}]`); return host; } catch { return; }
  }
  if (bracketed) return;
  if (ipv4.test(host)) return host;
  if (/^[0-9.]+$/.test(host) && host.includes('.')) return;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name.length > 253 || !name.split('.').every(label => /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/.test(label))) return;
  return host;
}
/** Parses Connect's search as a destination, without DNS lookup or shell interpretation. */
export function parseDestination(input: string): { host: string; username?: string; port?: number } | undefined {
  if (input.length > 8193 || /[\x00-\x1f\x7f-\x9f]/.test(input)) return;
  const value = input.trim();
  const at = value.indexOf('@');
  const endpoint = value.slice(at + 1);
  const withPort = /^(\[[^\]]+\]|[^:]+):([0-9]+)$/.exec(endpoint);
  const port = withPort ? Number(withPort[2]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return;
  const host = normalizeHost(withPort ? withPort[1]! : endpoint);
  if (!host) return;
  const destination = { host, ...(port !== undefined && { port }) };
  if (at < 0) return destination;
  const username = value.slice(0, at);
  if (username && usernamePattern.test(username)) return { ...destination, username };
}
/**
 * Remote applications, which launch again when the connection reconnects unless their launch was cancelled. `updates`
 * launches begin by checking for a release. A `relaunches` application also launches again when the server it uses goes
 * away, and signs in through a single-use address.
 */
export const applications: Record<'vscode' | 't3', { name: string; updates?: boolean; relaunches?: boolean }> = {
  vscode: { name: 'Visual Studio Code', updates: true },
  t3: { name: 'T3 Code', relaunches: true },
};
export type ApplicationId = keyof typeof applications;
export type RemoteProcess = {
  id: string; name: string; status: 'starting' | 'running' | 'retrying' | 'stopping' | 'failed';
  pid?: number; message?: string;
};
export type ProcessReport = RemoteProcess | { id: string; status: 'stopped' };
export type RemoteSessions = { sessions: RemoteSession[]; loading: boolean; errors: SessionFailure[] };
/** `installed` lists the optional applications found on the host since it connected; it is absent until they have been looked for. */
export type Connection = { id: string; profileId?: string; label: string; host: string; username?: string; status: 'connecting' | 'connected' | 'closed'; exitCode?: number; terminal: NonNullable<Spec['terminal']>; processes: RemoteProcess[]; remoteSessions?: RemoteSessions; installed?: ApplicationId[] };
export type TerminalSession = { remoteSession?: RemoteSession; id: string; connectionId: string; status: 'connecting' | 'connected' | 'closed'; exitCode?: number };
export type VncDestination = { host: string; port: number };
/**
 * A VNC tab keeps its destination and ID across attempts. Connected means the SSH channel has spawned, before RFB
 * authentication. Natural closure is published when a read reaches EOF, after all preceding bytes have been delivered.
 */
export type VncSession = VncDestination & { id: string; connectionId: string; attempt: string; status: 'connecting' | 'connected' | 'closed'; exitCode?: number; error?: string };
/** Bytes per read and maximum outstanding input per attempt, including IPC and the SSH pipe. */
export const vncLimits = { chunk: 64 * 1024, input: 1024 * 1024 };
export type CertificateChallenge = { id: string; url: string; origin: string; error: string; fingerprint: string; subject: string; issuer: string; validFrom: string; validTo: string };
/**
 * A browser tab; `zoom` is in percent, and `devtools` is whether its developer tools are open. `certificate` holds the
 * page's own request until answered, and `blockedCertificate` is one a resource of the page on show was refused for.
 */
export type BrowserTab = { id: string; title: string; url: string; loading: boolean; canBack: boolean; canForward: boolean; error?: string; certificate?: CertificateChallenge; blockedCertificate?: CertificateChallenge; audible: boolean; muted: boolean; zoom: number; devtools: boolean };
/** A download whose save location has been chosen; sizes are in bytes, and `total` is 0 when unknown. */
export type Download = { id: string; name: string; state: 'progressing' | 'completed' | 'cancelled' | 'failed'; received: number; total: number };
/** A browser session; `name` is the name the user gave it, and `closedTabs` how many closed tabs it can reopen. */
export type Workspace = { application?: ApplicationState; id: string; connectionId: string; color?: number; name?: string; tabs: BrowserTab[]; activeTab?: string; downloads: Download[]; closedTabs: number };
/** An address as a page is named after it: without its scheme, without a trailing slash, and with its escapes read. */
const bareAddress = (text: string) => {
  try { text = decodeURI(text); } catch { /* A malformed escape stands as it is. */ }
  return text.replace(/^https?:\/\//, '').replace(/\/+$/, '');
};
/** Whether a page is named after its address, as a page with no title of its own is; an address can carry credentials. */
export const namedByAddress = (title: string, url: string) => bareAddress(title) === bareAddress(url);
/** What a page without a title of its own is called: its host and path, without credentials, query or fragment. */
export function untitledName(url: string): string {
  const source = url.replace(/^view-source:/i, '');
  try {
    const { host, pathname } = new URL(source);
    if (!host) return '';
    let path = pathname.replace(/\/+$/, '');
    try { path = decodeURI(path); } catch { /* A malformed escape stands as it is. */ }
    return `${source === url ? '' : 'view-source:'}${host}${path}`;
  } catch { return ''; }
}
/**
 * Whether a page may use a permission while it is on show in the focused window: every page may take the pointer and
 * keyboard, go fullscreen and write to the clipboard, and an application's page may also read the clipboard.
 */
export const pagePermitted = (permission: string, application: boolean) =>
  ['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write'].includes(permission) || application && permission === 'clipboard-read';
/** Whether an address is one a tab can show: HTTP or HTTPS, or the source of such a page. */
export const pageAddress = (url: string) => /^(view-source:)?https?:\/\//i.test(url);
const mailFields = ['to', 'cc', 'bcc', 'subject', 'body'];
/** Percent-encodes text, leaving `keep` as it is. */
const encodeText = (text: string, keep = '') => [...text].map(character => keep.includes(character) || /[A-Za-z0-9._~-]/.test(character)
  ? character : encodeURIComponent(character).replace(/[!'()*]/, mark => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`)).join('');
/** Addresses that a mail application cannot read as anything else. */
const plainAddresses = (text: string) => !/[?&'"\\<>\s]/.test(text);
/**
 * The address the system's default application opens for a mailto:, tel: or sms: link, of at most 8192 characters; any
 * other link has none. A mailto: link keeps only its recipients, then its subject and body, each percent-encoded in one
 * way, and one with recipients that could be read as more fields has none.
 */
export function systemLink(input: string): string | undefined {
  if (input.length > 8192 || /[\u0000-\u001f\u007f]/.test(input)) return;
  let url: URL;
  try { url = new URL(input); } catch { return; }
  if (['tel:', 'sms:'].includes(url.protocol)) return url.href.length > 8192 ? undefined : url.href;
  if (url.protocol !== 'mailto:' || url.pathname.includes('&')) return;
  try {
    const recipients = decodeURIComponent(url.pathname);
    if (!plainAddresses(recipients)) return;
    const fields: [number, string][] = [];
    for (const pair of url.search.slice(1).split('&')) {
      const [name = '', ...rest] = pair.split('='), key = decodeURIComponent(name).toLowerCase(), value = decodeURIComponent(rest.join('='));
      const order = mailFields.indexOf(key), address = order < 3;
      if (order < 0) continue;
      if (address && !plainAddresses(value)) return;
      fields.push([order, `${key}=${encodeText(value, address ? '@,' : '')}`]);
    }
    const query = fields.sort(([a], [b]) => a - b).map(([, field]) => field).join('&');
    const link = `mailto:${encodeText(recipients, '@,')}${query ? `?${query}` : ''}`;
    return link.length > 8192 ? undefined : link;
  } catch { return; }
}
/** Whether an application's session shows the application's own page rather than its launch. */
export const applicationShowsPage = (application: ApplicationState, tab: BrowserTab | undefined) =>
  application.event.type === 'applications.ready' && application.page === 'open' && !!tab?.url && !tab.error;
export const browserSessionName = (workspace: Workspace) => workspace.name || 'Browser';
export type BrowserChallenge = { id: string; workspaceId: string; tabId: string; origin: string; realm: string; scheme: string };
export type AuthChallenge = Challenge | BrowserChallenge;
export type AuthAnswer = string | null | { username: string; password: string };
/** `externalBrowser` is whether links can open in the system browser. */
export type Capabilities = { embeddedBrowser: boolean; nativeFilePicker: boolean; externalBrowser: boolean; vnc: boolean };
export type State = {
  capabilities: Capabilities; settings: Settings; configError?: string; profiles: PublicProfile[]; defaults: PublicSpec; file: string; connections: Connection[]; terminals: TerminalSession[]; vncs: VncSession[]; workspaces: Workspace[]; challenges: AuthChallenge[] };
export type FullscreenMode = false | 'window' | 'content';
/** `transport` reports the page losing its link to the backend, with `error`, and regaining it, without. */
export type Event = { type: 'fullscreen'; mode: FullscreenMode } | { type: 'helper'; connectionId: string; message: HelperMessage } | { type: 'transport'; error?: string } | { type: 'select-browser'; id: string } | { type: 'state'; state: State } | { type: 'data'; id: string; data: string } | { type: 'errors'; log: ErrorLog; initial?: boolean } | { type: 'browser-shortcut'; id: string; action: Exclude<BrowserShortcut, 'devtools'> | 'find' }
  /**
   * A menu to show at a point of the application page, drawn for the main process or the web client; it closes once
   * connection `connectionId` connects or disconnects. Choosing an item, or closing the menu, is reported with
   * `menuChosen`.
   */
  | { type: 'menu'; id: number; items: MenuEntry[]; x: number; y: number; connectionId?: string }
  /** Closes the open menu or popup, as a press in a page does. */
  | { type: 'close-popup' }
  /** Paste and Go in the address field's menu, with the clipboard's text. */
  | { type: 'paste-and-go'; text: string }
  /** Closing the window waits for the user to confirm quitting while a connection is live. */
  | { type: 'confirm-quit' }
  /** A question for the user, answered with `answerQuestion`. */
  | { type: 'question'; id: string; question: Question }
  /** A question that no longer needs an answer, as one about a tab that has closed. */
  | { type: 'question-withdrawn'; id: string }
  /** A tab's icon as a data URL, its find-in-page result, and the address of the link under the pointer. */
  | { type: 'favicon'; tabId: string; data?: string } | { type: 'found'; tabId: string; active: number; matches: number } | { type: 'target-url'; tabId: string; url: string };
/** An item of a menu in a `menu` event; `id` names its action, and `icon` one of the application's icons. */
export type MenuEntry = { id: number; label: string; icon?: string; color?: number; shortcut?: string; disabled?: boolean; checked?: boolean; submenu?: MenuEntry[] } | { separator: true };
/**
 * Whether to leave a page that asks before it is left, named by `detail`, or to open the link in `detail` in another
 * application; `page` is whether the page had the keyboard when it asked.
 */
export type Question = { kind: 'leave' | 'hand-off'; detail: string; page?: boolean };
export type ErrorEntry = { id: number; source: string; kind: 'current' | 'event'; message: string; connectionId?: string; terminalId?: string; label: string; time: number; lastTime: number; count: number; resolvedAt?: number };
export type ErrorLog = { current: ErrorEntry[]; history: ErrorEntry[] };
export type ErrorReport = { source: string; message: string; connectionId?: string; terminalId?: string; label?: string };
export type Appearance = 'dark' | 'light' | 'system';
export type Settings = { appearance: Appearance; theme: ThemeId; interfaceFont: string; terminalFont: string; terminalFontSize: number; terminalLigatures: boolean; terminalWebgl: boolean; remoteSessionIntegration: boolean };
export const defaultSettings: Settings = { appearance: 'dark', theme: 'rail', interfaceFont: 'Inter', terminalFont: 'JetBrains Mono', terminalFontSize: 13, terminalLigatures: true, terminalWebgl: false, remoteSessionIntegration: true };
export type ConnectTarget = { profileId: string } | { host: string; username?: string; port?: number };
export type ProfileDraft = { token: string; id?: string; file: string; spec: PublicSpec; tags: string[] };
export type ProfileChanges = { token: string; values: Spec; reset: string[]; tags?: string[] };
export type ProfileSaveResult = { profileId: string; connectionId?: string; connectionError?: string };
export type Bounds = { x: number; y: number; width: number; height: number };
/** Overlays from the bottom up. */
export const overlayNames = ['status', 'popover', 'suggestions', 'toasts', 'fullscreen', 'modal', 'popup', 'tooltip'] as const;
export type OverlayName = (typeof overlayNames)[number];
export const browserActions = ['new', 'close', 'select', 'focus', 'navigate', 'back', 'forward', 'reload', 'hard-reload', 'stop', 'close-workspace', 'reopen', 'devtools', 'mute', 'zoom-in', 'zoom-out', 'zoom-reset', 'print', 'pdf', 'screenshot', 'clear-site-data', 'external'] as const;
export type BrowserAction = (typeof browserActions)[number];
export interface API {
  capabilities(): Promise<Capabilities>;
  graphics(event: { event: 'started' | 'lost' | 'restored' | 'fallback'; backend?: string }): void;
  reportError(input: ErrorReport): Promise<void>;
  clearErrors(): Promise<void>;
  answerCertificate(id: string, allow: boolean): Promise<boolean>;
  profileDraft(profileId?: string): Promise<ProfileDraft>;
  profilePreview(input: ProfileChanges): Promise<string[]>;
  profileConnect(input: ProfileChanges): Promise<string>;
  profileSave(input: ProfileChanges & { id?: string; connect: boolean }): Promise<ProfileSaveResult>;
  reloadConfig(): Promise<void>;
  chooseFile(): Promise<string | undefined>;
  /** Whether the application window came to the front within the last `milliseconds`. */
  activatedWithin(milliseconds: number): Promise<boolean>;
  /** Acknowledges a `confirm-quit` event: the user is being asked. */
  askingToQuit(): void;
  /** Closes the application window after the user has confirmed quitting. */
  quit(): void;
  /** Answers a `question` event: whether the user chose to leave the page or open the link. */
  answerQuestion(id: string, proceed: boolean): void;
  setFullscreen(mode: FullscreenMode): Promise<void>;
  settings(patch: Partial<Settings>): Promise<void>;
  details(id: string): Promise<ConnectionInfo>;
  connect(target: ConnectTarget): Promise<string>;
  disconnect(id: string): Promise<void>;
  removeConnection(id: string): Promise<void>;
  reconnect(id: string): Promise<string>;
  sendHelperMessage(connectionId: string, message: HelperRequest): Promise<void>;
  onHelperMessage<T extends HelperMessage['type']>(type: T, callback: HelperListener<T>): () => void;
  resumeRemoteSessions(connectionId: string, keys: string[], takeover: boolean): Promise<string[]>;
  killRemoteSession(connectionId: string, key: string): Promise<void>;
  newTerminal(connectionId: string): Promise<string>;
  reconnectTerminal(id: string): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  newVnc(connectionId: string, destination?: Partial<VncDestination>): Promise<string>;
  reconnectVnc(connectionId: string, id: string): Promise<void>;
  closeVnc(connectionId: string, id: string): Promise<void>;
  /** Ends only the named attempt and keeps its tab. */
  stopVnc(connectionId: string, id: string, attempt: string): Promise<void>;
  /** One outstanding read per attempt. Null ends the stream; bytes never appear in state or events. */
  readVnc(connectionId: string, id: string, attempt: string): Promise<Uint8Array | null>;
  /** Copies the input before returning. Await rejection and end the viewer if delivery fails. */
  writeVnc(connectionId: string, id: string, attempt: string, data: Uint8Array): Promise<void>;
  newApplication(connectionId: string, application: string): Promise<string>;
  retryApplication(workspaceId: string): Promise<void>;
  respondApplication(workspaceId: string, consentId: string, accepted: boolean): Promise<void>;
  newBrowser(connectionId: string): Promise<string>;
  /** Opens a tab in the session, or else in the connection's first session in navigation order or a new one, and returns the session. */
  newBrowserTab(connectionId: string, sessionId?: string): Promise<string>;
  /** An empty name restores the default name. */
  renameBrowser(workspaceId: string, name: string): Promise<void>;
  /** Opens a terminal's link in the browser session nearest after the terminal in navigation, or else before it. */
  openLink(terminalId: string, url: string): Promise<void>;
  /** Shows the menu of a terminal's links at a point of the page. */
  linkMenu(terminalId: string, url: string | string[], at: { x: number; y: number }): Promise<void>;
  /** Gives the order navigation shows a connection's items in, by their `terminal:<id>`, `session:<id>` and `vnc:<id>` keys. */
  orderItems(connectionId: string, keys: string[]): void;
  copy(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  /** Reports the item chosen from the menu of a `menu` event, or `null` when it closes without one. */
  menuChosen(id: number, item: number | null): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number, repaint?: boolean): void;
  /** Reports that the page has processed `size` more of a terminal's output, in string length. */
  acknowledge(id: string, size: number): void;
  answer(id: string, value: AuthAnswer): Promise<void>;
  browser(workspaceId: string, action: BrowserAction, tabId?: string, url?: string): Promise<void>;
  /** Finds text in a tab, or the next or previous match of the same text; `null` ends the search. */
  find(workspaceId: string, tabId: string, request: { text: string; forward: boolean; next: boolean } | null): Promise<void>;
  download(workspaceId: string, action: 'cancel' | 'show' | 'clear', downloadId?: string): Promise<void>;
  /** Places the selected tab's page, and its developer tools when they are open. */
  showBrowser(workspaceId: string | null, bounds?: Bounds, tools?: Bounds): void;
  /** Places a view for floating interface above the pages, or hides it. */
  overlay(name: OverlayName, bounds: Bounds | null): void;
  onEvent(callback: (event: Event) => void): () => void;
}
declare global { interface Window { bartizan: API } }
