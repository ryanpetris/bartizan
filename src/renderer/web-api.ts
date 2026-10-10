import { createClient } from '../client';
import type { API, Event, FullscreenMode } from '../shared';
import type { Message, Response } from '../transport';

export function createWebAPI(): API {
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  const listeners = new Set<(event: Event) => void>();
  const queued: Event[] = [];
  const emit = (event: Event) => { if (!listeners.size) queued.push(event); else for (const listener of listeners) listener(event); };
  // A lost socket reconnects with growing delays. The server then sends fresh state, and terminals continue from live
  // output, keeping what they already show; output from while the page was away is not replayed.
  let socket: WebSocket, failures = 0, lost = false, opened = false;
  const client = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const connect = () => {
    const current = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/socket?client=${client}`);
    current.addEventListener('open', () => {
      failures = 0; opened = true;
      if (lost) { lost = false; emit({ type: 'transport' }); }
    });
    current.addEventListener('message', message => {
      const value: Message = JSON.parse(message.data);
      if ('event' in value) emit(value.event);
      else { pending.get(value.id)?.resolve(value); pending.delete(value.id); }
    });
    current.addEventListener('close', () => {
      const error = new Error('Connection to Bartizan server closed.');
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!lost) { lost = true; emit({ type: 'transport', error: error.message }); }
      setTimeout(connect, Math.min(250 * 2 ** failures++, 10000));
    });
  };
  connect();
  const api = createClient({
    async request(request) {
      // Requests wait for the first socket; once the page has been connected, calls made while it is away fail at once.
      const current = socket;
      if (current.readyState === WebSocket.CONNECTING && !opened) await new Promise(resolve => { current.addEventListener('open', resolve, { once: true }); current.addEventListener('close', resolve, { once: true }); });
      if (current.readyState !== WebSocket.OPEN) throw new Error('Bartizan server is disconnected');
      return new Promise<Response>((resolve, reject) => { pending.set(request.id, { resolve, reject }); current.send(JSON.stringify(request)); });
    },
    onEvent(callback) {
      listeners.add(callback);
      queueMicrotask(() => { for (const event of queued.splice(0)) emit(event); });
      return () => { listeners.delete(callback); };
    },
  });
  let fullscreen: FullscreenMode = false;
  const fullscreenChanged = () => emit({ type: 'fullscreen', mode: fullscreen });
  document.addEventListener('fullscreenchange', () => {
    fullscreen = document.fullscreenElement ? fullscreen || 'window' : false;
    fullscreenChanged();
  });
  let activatedAt = -Infinity;
  /** The open link menu's links. */
  let linkMenu: { id: number; links: string[] } | undefined, menus = 0;
  addEventListener('focus', () => { activatedAt = performance.now(); });
  const openLink = (value: string) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) throw new Error('Unsupported link');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  };
  const setFullscreen = async (mode: FullscreenMode) => {
    const previous = fullscreen;
    fullscreen = mode;
    try {
      if (!mode && document.fullscreenElement) await document.exitFullscreen();
      else if (mode && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch (error) { fullscreen = previous; fullscreenChanged(); throw error; }
    fullscreen = document.fullscreenElement ? mode : false;
    fullscreenChanged();
  };
  addEventListener('keydown', event => {
    if (event.key !== 'F11' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (!event.repeat) void setFullscreen(document.fullscreenElement ? false : 'content').catch(() => {});
  }, true);
  return { ...api,
    setFullscreen,
    copy: async text => {
      if (navigator.clipboard) { await navigator.clipboard.writeText(text); return; }
      const previous = document.activeElement as HTMLElement | null;
      const input = document.createElement('textarea');
      input.value = text; input.style.cssText = 'position:fixed;left:-10000px;top:0';
      (document.querySelector('dialog[open]') ?? document.body).append(input);
      input.select();
      try { if (!document.execCommand('copy')) throw new Error('Clipboard access was denied'); }
      finally { input.remove(); previous?.focus(); }
    },
    readClipboard: async () => {
      if (!navigator.clipboard) throw new Error('Clipboard access was denied');
      return navigator.clipboard.readText();
    },
    chooseFile: async () => { throw new Error('Native file selection is unavailable'); },
    activatedWithin: async milliseconds => performance.now() - activatedAt <= milliseconds,
    openLink: async (_id, url) => openLink(url),
    linkMenu: async (_id, urls, at) => {
      const links = (Array.isArray(urls) ? urls : [urls]).filter(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } });
      if (!links.length) return;
      linkMenu = { id: ++menus, links };
      emit({ type: 'menu', id: linkMenu.id, items: links.map((url, index) => ({ id: index, label: url, icon: 'external' })), ...at });
    },
    // A link opens from the click that chose it, which lets the page open a window.
    menuChosen: (id, item) => {
      if (id !== linkMenu?.id) return;
      const { links } = linkMenu;
      linkMenu = undefined;
      if (item !== null && links[item]) openLink(links[item]);
    },
    showBrowser: () => {},
    overlay: () => {},
  };
}
