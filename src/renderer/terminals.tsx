import { useLayoutEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalSession } from '../shared';
import { api, store, run, connectionOf, dialogOpen, onFocusRequest, setTerminalTitle, firstSession } from './store';
import { terminalFontFamily, loadFontStyles } from './fonts';
import { operatorJoiner } from './ligatures';
import { activeTheme } from './themes';

/**
 * `link` is the web link under the pointer; `recentLinks` holds recent OSC 8 hyperlink targets, oldest first. `font` is the
 * latest requested font, applied once `fontRequest` still matches after its styles load; a terminal opens only once
 * `fontReady`. `focusPending` records where focus was when focus was requested before the terminal opened; the terminal
 * takes focus when it opens only if focus is still there.
 */
type Entry = {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLElement;
  opened: boolean;
  session: TerminalSession;
  graphics?: Graphics;
  rendererAttempted?: boolean;
  link?: string;
  recentLinks: string[];
  font?: string;
  fontRequest: number;
  fontReady: boolean;
  focusPending?: { from: Element | null };
  /** The registered ligature joiner while ligatures are on for an opened terminal. */
  joiner?: number;
  repaint?: boolean;
};
const entries = new Map<string, Entry>();
const retired = new Set<string>();
const pending = new Map<string, string[]>();
/** The pattern the web links addon underlines. */
const urlPattern = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;
/** A link the browser can open: an HTTP or HTTPS URL of at most 8192 characters with a host, and no whitespace, control characters or credentials. */
function webLink(value: string | undefined): value is string {
  if (!value || value.length > 8192 || /[\s\x00-\x1f\x7f-\x9f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
const linkLimit = 64;

/** Links offered from the keyboard: the hovered link, web links in the visible rows, then recent hyperlinks, newest first. */
function keyboardLinks(entry: Entry): string[] {
  const { terminal } = entry,
    buffer = terminal.buffer.active;
  const found: string[] = [];
  const add = (url: string | undefined) => {
    if (webLink(url) && !found.includes(url) && found.length < linkLimit) found.push(url);
  };
  add(entry.link);
  // Wrapped rows join into one logical line so a link that wraps is found whole.
  let y = buffer.viewportY;
  while (y > 0 && buffer.getLine(y)?.isWrapped) y--;
  let text = '';
  for (
    let line = buffer.getLine(y);
    line && (y < buffer.viewportY + terminal.rows || line.isWrapped);
    line = buffer.getLine(++y)
  ) {
    if (!line.isWrapped && text) {
      for (const match of text.matchAll(urlPattern)) add(match[0]);
      text = '';
    }
    text += line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
  }
  for (const match of text.matchAll(urlPattern)) add(match[0]);
  for (const url of [...entry.recentLinks].reverse()) add(url);
  return found;
}
let webglFailed = false;

/**
 * A terminal's WebGL renderer with the canvas and context the renderer itself created, kept so that disposing it can
 * free that context: a disposed renderer's context stays alive until it is lost, and the browser drops the oldest
 * context once too many are live. `detach` removes the loss reporting for a renderer being taken down deliberately.
 */
type Graphics = {
  addon: WebglAddon;
  canvas?: HTMLCanvasElement;
  context?: WebGL2RenderingContext;
  detach?: () => void;
};
/** The canvases a terminal's renderers draw on, which excludes the overview ruler outside the screen. */
const screenCanvases = (element: HTMLElement) =>
  element.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas');
/**
 * The canvas and context a renderer added to a terminal's screen. The renderer's own canvas carries no class, unlike
 * the layer canvases it draws on in 2D, so no canvas the renderer did not add is inspected.
 */
function ownedGraphics(addon: WebglAddon, element: HTMLElement, before: Set<Element>): Graphics {
  for (const canvas of screenCanvases(element)) {
    if (before.has(canvas) || canvas.className.includes('-layer')) continue;
    const context = canvas.getContext('webgl2');
    if (context) return { addon, canvas, context };
  }
  return { addon };
}
/** The graphics backend drawing a context, as the driver names it. */
function backendOf(context: WebGL2RenderingContext | undefined): string | undefined {
  try {
    const info = context?.getExtension('WEBGL_debug_renderer_info');
    const name = context?.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER);
    return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}
/** Disposes a renderer and frees the context it owns. Its own loss follows from this teardown, so it is not reported. */
function releaseGraphics(graphics: Graphics) {
  graphics.detach?.();
  graphics.addon.dispose();
  graphics.context?.getExtension('WEBGL_lose_context')?.loseContext();
}
function stopGraphics(entry: Entry) {
  if (entry.graphics) releaseGraphics(entry.graphics);
  entry.graphics = undefined;
}
/**
 * Draws a terminal with the WebGL renderer, reporting what the renderer does so the main process can record it. A
 * renderer that cannot load, or whose context is lost for good, leaves the terminal drawing through the DOM renderer.
 */
function startGraphics(entry: Entry) {
  entry.rendererAttempted = true;
  const before = new Set<Element>(screenCanvases(entry.element));
  let addon: WebglAddon | undefined;
  try {
    addon = new WebglAddon();
    entry.terminal.loadAddon(addon);
  } catch {
    // ponytail: bound retained addon listeners to one failed constructor; full cleanup needs an upstream fix.
    webglFailed = true;
    if (addon) releaseGraphics(ownedGraphics(addon, entry.element, before));
    for (const canvas of screenCanvases(entry.element)) if (!before.has(canvas)) canvas.remove();
    api.graphics({ event: 'fallback' });
    return;
  }
  const graphics = ownedGraphics(addon, entry.element, before);
  entry.graphics = graphics;
  const { canvas } = graphics;
  // A context the browser takes away, such as when too many are live, is lost without the terminal asking for it.
  const lost = () => api.graphics({ event: 'lost' });
  const restored = () => api.graphics({ event: 'restored' });
  canvas?.addEventListener('webglcontextlost', lost);
  canvas?.addEventListener('webglcontextrestored', restored);
  graphics.detach = () => {
    canvas?.removeEventListener('webglcontextlost', lost);
    canvas?.removeEventListener('webglcontextrestored', restored);
  };
  // The renderer reports a loss it could not restore; the terminal then draws through the DOM renderer.
  addon.onContextLoss(() => {
    if (entry.graphics !== graphics) return;
    stopGraphics(entry);
    api.graphics({ event: 'fallback' });
    fitVisible();
  });
  api.graphics({ event: 'started', backend: backendOf(graphics.context) });
}

const dark = matchMedia('(prefers-color-scheme: dark)');
/** Terminal colours come from the chosen theme and follow the appearance. */
const theme = () => activeTheme().terminal[store.state.settings.appearance === 'system' ? (dark.matches ? 'dark' : 'light') : store.state.settings.appearance];
export function applyTheme() {
  host.style.backgroundColor = theme().background!;
  for (const entry of entries.values()) entry.terminal.options.theme = theme();
}
dark.addEventListener('change', applyTheme);

/** A terminal's font: its connection's override, taken when it connected, or the global setting. */
function effectiveFont(session: TerminalSession) {
  const settings = store.state.settings,
    terminal = connectionOf(session.connectionId)?.terminal;
  return {
    family: terminalFontFamily(terminal?.font ?? settings.terminalFont),
    size: terminal?.font_size ?? settings.terminalFontSize,
  };
}
/** Whether a terminal draws ligatures: its connection's override, taken when it connected, or the global setting. */
const effectiveLigatures = (session: TerminalSession) =>
  connectionOf(session.connectionId)?.terminal.ligatures ?? store.state.settings.terminalLigatures;
/** Registers or removes an opened terminal's ligature joiner to match its setting, redrawing the visible rows. */
function syncLigatures(entry: Entry) {
  if (!entry.opened || effectiveLigatures(entry.session) === (entry.joiner !== undefined)) return;
  if (entry.joiner === undefined) entry.joiner = entry.terminal.registerCharacterJoiner(operatorJoiner(entry.terminal));
  else {
    entry.terminal.deregisterCharacterJoiner(entry.joiner);
    entry.joiner = undefined;
  }
  entry.terminal.refresh(0, entry.terminal.rows - 1);
}
/** Applies a terminal's effective font once all four of its styles have loaded; only the terminal's latest request applies. */
function syncFont(entry: Entry) {
  const { family, size } = effectiveFont(entry.session);
  const font = `${size}px ${family}`;
  if (font === entry.font) return;
  entry.font = font;
  const request = ++entry.fontRequest;
  void loadFontStyles(family, size).then(() => {
    if (request !== entry.fontRequest || entries.get(entry.session.id) !== entry) return;
    entry.terminal.options.fontFamily = family;
    entry.terminal.options.fontSize = size;
    entry.fontReady = true;
    requestAnimationFrame(fitVisible);
  });
}

function create(session: TerminalSession): Entry {
  const element = document.createElement('div');
  element.className = 'terminal-surface';
  element.hidden = true;
  host.append(element);
  // A press and release on a link opens it, unless they selected text to copy.
  const openLink = (_event: MouseEvent, uri: string) => {
    if (webLink(uri) && !terminal.hasSelection())
      void run('browser', api.openLink(session.id, uri, firstSession(session.connectionId)?.id), session.connectionId);
  };
  const hover = (_event: MouseEvent, url: string) => {
    entry.link = webLink(url) ? url : undefined;
  };
  const leave = () => {
    entry.link = undefined;
    pressedLink = undefined;
  };
  const terminal = new Terminal({
    scrollback: connectionOf(session.connectionId)?.terminal.scrollback ?? 5000,
    fontSize: effectiveFont(session).size,
    lineHeight: 1.2,
    fontFamily: effectiveFont(session).family,
    theme: theme(),
    allowProposedApi: true,
    linkHandler: { activate: openLink, hover, leave },
    windowOptions: { pushTitle: true, popTitle: true },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  // A fresh view needs a full frame even when the remote terminal already has its fitted size.
  const entry: Entry = {
    terminal,
    fit,
    element,
    opened: false,
    session,
    recentLinks: [],
    fontRequest: 0,
    fontReady: false,
    repaint: true,
  };
  /** The link a right press landed on, until its context menu opens or output or scrolling moves it. */
  let pressedLink: string | undefined;
  terminal.loadAddon(new WebLinksAddon(openLink, { hover, leave }));
  // Output or scrolling can move text away from the pointer, so the hovered link no longer applies.
  terminal.onWriteParsed(leave);
  terminal.onScroll(leave);
  // Recent hyperlink targets let the keyboard offer OSC 8 links; the built-in handler still handles each sequence.
  terminal.parser.registerOscHandler(8, (data) => {
    const url = data.slice(data.indexOf(';') + 1);
    if (webLink(url)) {
      const index = entry.recentLinks.indexOf(url);
      if (index >= 0) entry.recentLinks.splice(index, 1);
      entry.recentLinks.push(url);
      if (entry.recentLinks.length > linkLimit) entry.recentLinks.shift();
    }
    return false;
  });
  // A right press on a link opens its menu; neither the press nor its release reaches the application's mouse reporting.
  let rightTaken = false;
  element.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 0 && event.shiftKey && event.isTrusted && terminal.modes.mouseTrackingMode === 'none') {
        // Without mouse reporting, Shift+drag selects like a plain drag instead of extending from the last click.
        event.preventDefault();
        event.stopPropagation();
        const { view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, metaKey, buttons } = event;
        const init = { view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, metaKey, buttons };
        event.target?.dispatchEvent(new MouseEvent('mousedown', { ...init, bubbles: true, cancelable: true, composed: true }));
        return;
      }
      if (event.button !== 2) return;
      pressedLink = entry.link;
      rightTaken = Boolean(pressedLink);
      if (rightTaken) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  element.addEventListener(
    'mouseup',
    (event) => {
      if (event.button !== 2 || !rightTaken) return;
      rightTaken = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  element.addEventListener(
    'contextmenu',
    (event) => {
      const url = event.button === 2 ? (pressedLink ?? entry.link) : undefined;
      pressedLink = undefined;
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      void run('browser', api.linkMenu(session.id, url, firstSession(session.connectionId)?.id), session.connectionId);
    },
    true,
  );
  const copy = (text: string) => run('clipboard', api.copy(text), session.connectionId);
  terminal.parser.registerOscHandler(52, async (data) => {
    const separator = data.indexOf(';');
    const selection = data.slice(0, separator);
    const payload = data.slice(separator + 1);
    // OSC 52 is write-only; primary selections and clipboard queries are ignored.
    if (
      separator < 0 ||
      !/^[cpqs0-7]*$/.test(selection) ||
      (selection !== '' && !/[cs]/.test(selection)) ||
      payload === '?' ||
      payload.length > 1398104
    )
      return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
      if (bytes.length > 1024 * 1024) return true;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await copy(text);
    } catch {
      /* Invalid clipboard data is ignored. */
    }
    return true;
  });
  // Shift+F10 or the context menu key offers the terminal's links; with none, the key goes to the application.
  let menuKey = false;
  terminal.attachCustomKeyEventHandler((event) => {
    if (
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)
    ) {
      if (event.type === 'keydown') {
        const links = keyboardLinks(entry);
        menuKey = links.length > 0;
        if (menuKey) {
          event.preventDefault();
          void run(
            'browser',
            api.linkMenu(session.id, links.length === 1 ? links[0] : links, firstSession(session.connectionId)?.id),
            session.connectionId,
          );
        }
      }
      return !menuKey;
    }
    return true;
  });
  terminal.onData((data) => api.input(session.id, data));
  terminal.onResize(({ cols, rows }) => api.resize(session.id, cols, rows));
  terminal.onTitleChange((title) => setTerminalTitle(session.id, title));
  for (const chunk of pending.get(session.id) ?? []) terminal.write(chunk);
  pending.delete(session.id);
  entries.set(session.id, entry);
  return entry;
}

export function write(id: string, data: string) {
  const entry = entries.get(id);
  if (entry) {
    entry.terminal.write(data);
    return;
  }
  if (retired.has(id)) return;
  const chunks = pending.get(id) ?? [];
  chunks.push(data);
  if (chunks.length > 512) chunks.shift();
  pending.set(id, chunks);
}

function fitVisible() {
  const entry = visibleEntry();
  // Cell metrics come from the font, so a terminal opens only once its font has loaded.
  if (!entry || !entry.fontReady || host.clientWidth === 0 || host.clientHeight === 0) return;
  if (!entry.opened) {
    entry.terminal.open(entry.element);
    entry.opened = true;
    syncLigatures(entry);
    if (entry.focusPending && entry.focusPending.from === document.activeElement && !dialogOpen())
      entry.terminal.focus();
    entry.focusPending = undefined;
  }
  const before = [entry.terminal.cols, entry.terminal.rows];
  if (!entry.rendererAttempted && !webglFailed) startGraphics(entry);
  entry.fit.fit();
  if (!entry.element.dataset.sized || before[0] !== entry.terminal.cols || before[1] !== entry.terminal.rows) {
    entry.element.dataset.sized = 'true';
    api.resize(entry.session.id, entry.terminal.cols, entry.terminal.rows, entry.repaint);
    entry.repaint = false;
  }
}
function visibleEntry() {
  return store.selection?.kind === 'terminal' ? entries.get(store.selection.id) : undefined;
}

const host = document.createElement('div');
host.className = 'terminal-host';
applyTheme();
export function Terminals() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current!.append(host);
    return () => {
      host.remove();
    };
  }, []);
  useLayoutEffect(update);
  const session = current();
  return (
    <section className="view terminal-view" hidden={!session} aria-labelledby="view-title">
      <div ref={ref} style={{ display: 'contents' }} />
    </section>
  );
}

const current = () => {
  const s = store.selection;
  return s?.kind === 'terminal' ? store.state.terminals.find((t) => t.id === s.id) : undefined;
};

new ResizeObserver(() => requestAnimationFrame(fitVisible)).observe(host);
onFocusRequest(() => {
  const entry = visibleEntry();
  if (!entry || dialogOpen()) return;
  fitVisible();
  if (entry.opened) entry.terminal.focus();
  else entry.focusPending = { from: document.activeElement };
});

// Selecting text copies it, unless it is blank, and clears the selection. xterm finishes a selection in its document
// mouseup listener, which runs before this one.
window.addEventListener('mouseup', (event) => {
  if (event.button !== 0) return;
  for (const { terminal, session } of entries.values()) {
    if (!terminal.hasSelection()) continue;
    const text = terminal.getSelection();
    terminal.clearSelection();
    if (text.trim()) void run('clipboard', api.copy(text), session.connectionId);
  }
});

function update() {
  const live = new Set(store.state.terminals.map((t) => t.id));
  for (const [id, entry] of entries)
    if (!live.has(id)) {
      // Disposing the terminal takes the renderer down with it; the context it owns is freed after that.
      entry.terminal.dispose();
      stopGraphics(entry);
      entry.element.remove();
      entries.delete(id);
      retired.add(id);
      pending.delete(id);
    }
  for (const id of pending.keys()) if (retired.has(id)) pending.delete(id);
  for (const session of store.state.terminals) {
    const entry = entries.get(session.id) ?? create(session);
    entry.session = session;
    syncFont(entry);
    syncLigatures(entry);
  }
  const session = current();
  for (const [id, entry] of entries) {
    const shown = id === session?.id;
    entry.element.hidden = !shown;
    if (!shown) {
      stopGraphics(entry);
      entry.rendererAttempted = false;
      entry.link = undefined;
      entry.focusPending = undefined;
    }
  }
  if (session) requestAnimationFrame(fitVisible);
}
