import type { Spec, PublicSpec, PublicProfile } from './core/config';
import type { ConnectionInfo } from './main/connection-info';
import type { Challenge } from './main/askpass';
export function shortcutKey({ key, code }: { key: string; code: string }): string {
  return !/^[a-z]$/i.test(key) && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : key.toLowerCase();
}
/** A key press, as a page's input event or the application's keyboard event describes it. */
export type KeyPress = { key: string; code: string; control: boolean; meta: boolean; alt: boolean; shift: boolean };
export type BrowserShortcut = 'devtools' | 'focus-address' | 'new-connection';
/** The shortcut the application takes from a key press before a page sees it; it is the same in a page and in the application around it. */
export function browserShortcut(input: KeyPress): BrowserShortcut | undefined {
  const { control, meta, alt, shift } = input, key = shortcutKey(input);
  if (key === 'f12' && !control && !meta && !alt && !shift) return 'devtools';
  if (key === 'i' && (control && shift && !meta && !alt || meta && alt && !control && !shift)) return 'devtools';
  if (!(control || meta) || alt) return;
  return key === 'l' && !shift ? 'focus-address' : key === 'n' && shift ? 'new-connection' : undefined;
}
/** Shortcuts a page sees first, with their accelerators: the application acts on one only when the page leaves the key alone. */
export const pageShortcuts = {
  find: ['CmdOrCtrl+F'],
  reload: ['CmdOrCtrl+R', 'F5'],
  'hard-reload': ['CmdOrCtrl+Shift+R', 'CmdOrCtrl+F5', 'Shift+F5'],
  print: ['CmdOrCtrl+P'],
  'zoom-in': ['CmdOrCtrl+=', 'CmdOrCtrl+Plus', 'CmdOrCtrl+numadd'],
  'zoom-out': ['CmdOrCtrl+-', 'CmdOrCtrl+numsub'],
  'zoom-reset': ['CmdOrCtrl+0', 'CmdOrCtrl+num0'],
} as const;
export type PageShortcut = keyof typeof pageShortcuts;
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
/** Parses the Connect field without DNS lookup or shell interpretation. */
export function parseDestination(input: string): { host: string; username?: string } | undefined {
  if (input.length > 8193 || /[\x00-\x1f\x7f-\x9f]/.test(input)) return;
  const value = input.trim();
  const at = value.indexOf('@');
  const host = normalizeHost(value.slice(at + 1));
  if (!host) return;
  if (at < 0) return { host };
  const username = value.slice(0, at);
  if (username && usernamePattern.test(username)) return { host, username };
}
export type Connection = { id: string; profileId?: string; label: string; host: string; username?: string; status: 'connecting' | 'connected' | 'closed'; exitCode?: number; terminal: NonNullable<Spec['terminal']> };
export type TerminalSession = { id: string; connectionId: string; status: 'connecting' | 'connected' | 'closed'; exitCode?: number };
export type CertificateChallenge = { id: string; url: string; origin: string; error: string; fingerprint: string; subject: string; issuer: string; validFrom: string; validTo: string };
/** A browser tab; `zoom` is in percent, and `devtools` is whether its developer tools are open. */
export type BrowserTab = { id: string; title: string; url: string; loading: boolean; canBack: boolean; canForward: boolean; error?: string; certificate?: CertificateChallenge; audible: boolean; muted: boolean; zoom: number; devtools: boolean };
/** A download whose save location has been chosen; sizes are in bytes, and `total` is 0 when unknown. */
export type Download = { id: string; name: string; state: 'progressing' | 'completed' | 'cancelled' | 'failed'; received: number; total: number };
/** A browser session; `name` is the name the user gave it. */
export type Workspace = { id: string; connectionId: string; color: number; ordinal: number; name?: string; tabs: BrowserTab[]; activeTab?: string; downloads: Download[] };
export const browserSessionName = (workspace: Workspace) => workspace.name || `Browser ${workspace.ordinal}`;
export type BrowserChallenge = { id: string; workspaceId: string; tabId: string; origin: string; realm: string; scheme: string };
export type AuthChallenge = Challenge | BrowserChallenge;
export type AuthAnswer = string | null | { username: string; password: string };
export type Capabilities = { embeddedBrowser: boolean; nativeFilePicker: boolean };
export type State = {
  capabilities: Capabilities; settings: Settings; configError?: string; profiles: PublicProfile[]; defaults: PublicSpec; file: string; connections: Connection[]; terminals: TerminalSession[]; workspaces: Workspace[]; challenges: AuthChallenge[] };
export type Event = { type: 'transport-error'; message: string } | { type: 'menu'; index: number } | { type: 'select-browser'; id: string } | { type: 'state'; state: State } | { type: 'data'; id: string; data: string } | { type: 'errors'; log: ErrorLog; initial?: boolean } | { type: 'browser-shortcut'; id: string; action: 'focus-address' | 'new-connection' | 'find' }
  /** A tab's icon as a data URL, its find-in-page result, and the address of the link under the pointer. */
  | { type: 'favicon'; tabId: string; data?: string } | { type: 'found'; tabId: string; active: number; matches: number } | { type: 'target-url'; tabId: string; url: string };
export type ErrorEntry = { id: number; source: string; kind: 'current' | 'event'; message: string; connectionId?: string; label: string; time: number; lastTime: number; count: number; resolvedAt?: number };
export type ErrorLog = { current: ErrorEntry[]; history: ErrorEntry[] };
export type ErrorReport = { source: string; message: string; connectionId?: string; label?: string };
export type Appearance = 'dark' | 'light' | 'system';
export type Settings = { appearance: Appearance; interfaceFont: string; terminalFont: string; terminalFontSize: number; terminalLigatures: boolean };
export const defaultSettings: Settings = { appearance: 'dark', interfaceFont: 'Inter', terminalFont: 'JetBrains Mono', terminalFontSize: 13, terminalLigatures: true };
export type ConnectTarget = { profileId: string } | { host: string; username?: string };
export type ProfileDraft = { token: string; id?: string; file: string; spec: PublicSpec; tags: string[] };
export type ProfileChanges = { token: string; values: Spec; reset: string[]; tags?: string[] };
export type ProfileSaveResult = { profileId: string; connectionId?: string; connectionError?: string };
export type Bounds = { x: number; y: number; width: number; height: number };
export const overlayNames = ['status', 'popover'] as const;
export type OverlayName = (typeof overlayNames)[number];
export const browserActions = ['new', 'close', 'select', 'navigate', 'back', 'forward', 'reload', 'hard-reload', 'stop', 'close-workspace', 'devtools', 'mute', 'zoom-in', 'zoom-out', 'zoom-reset', 'print', 'pdf'] as const;
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
  settings(patch: Partial<Settings>): Promise<void>;
  details(id: string): Promise<ConnectionInfo>;
  connect(target: ConnectTarget): Promise<string>;
  disconnect(id: string): Promise<void>;
  removeConnection(id: string): Promise<void>;
  reconnect(id: string): Promise<string>;
  newTerminal(connectionId: string): Promise<string>;
  closeTerminal(id: string): Promise<void>;
  newBrowser(connectionId: string): Promise<string>;
  /** Opens a tab in the session, or else in the connection's earliest session or a new one, and returns the session. */
  newBrowserTab(connectionId: string, sessionId?: string): Promise<string>;
  /** An empty name restores the default name. */
  renameBrowser(workspaceId: string, name: string): Promise<void>;
  /** `sessionId` is the browser session that comes first in the sidebar. */
  openLink(terminalId: string, url: string, sessionId?: string): Promise<void>;
  linkMenu(terminalId: string, url: string | string[], sessionId?: string): Promise<void>;
  copy(text: string): Promise<void>;
  /** Shows a native menu at a page position; choosing an item sends a `menu` event with its index. */
  menu(items: ({ label: string; enabled: boolean } | { separator: true })[], x: number, y: number): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number, repaint?: boolean): void;
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
