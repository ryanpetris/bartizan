import { createClient } from '../client';
import type { API, Event } from '../shared';
import type { Message, Response } from '../transport';

export function createWebAPI(): API {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/socket`);
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  const listeners = new Set<(event: Event) => void>();
  const queued: Event[] = [];
  const emit = (event: Event) => { if (!listeners.size) queued.push(event); else for (const listener of listeners) listener(event); };
  const ready = new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Cannot reach Bartizan server')), { once: true }); });
  void ready.catch(() => {});
  socket.addEventListener('message', message => {
    const value: Message = JSON.parse(message.data);
    if ('event' in value) emit(value.event);
    else { pending.get(value.id)?.resolve(value); pending.delete(value.id); }
  });
  socket.addEventListener('close', () => {
    const error = new Error('Connection to Bartizan server closed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    emit({ type: 'transport-error', message: error.message });
  });
  const api = createClient({
    async request(request) {
      await ready;
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Bartizan server is disconnected');
      return new Promise<Response>((resolve, reject) => { pending.set(request.id, { resolve, reject }); socket.send(JSON.stringify(request)); });
    },
    onEvent(callback) {
      listeners.add(callback);
      queueMicrotask(() => { for (const event of queued.splice(0)) emit(event); });
      return () => { listeners.delete(callback); };
    },
  });
  const openLink = (value: string) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) throw new Error('Unsupported link');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  };
  return { ...api,
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
    chooseFile: async () => { throw new Error('Native file selection is unavailable'); },
    openLink: async (_id, url) => openLink(url),
    linkMenu: async (_id, urls) => {
      const links = (Array.isArray(urls) ? urls : [urls]).filter(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } });
      showMenu(links.map(url => ({ label: url, enabled: true })), 20, 60, index => openLink(links[index]));
    },
    menu: (items, x, y) => showMenu(items, x, y, index => emit({ type: 'menu', index })),
    showBrowser: () => {},
    overlay: () => {},
  };
}
let closeMenu: (() => void) | undefined;
function showMenu(items: Parameters<API['menu']>[0], x: number, y: number, choose: (index: number) => void) {
  closeMenu?.();
  const menu = document.createElement('div');
  menu.className = 'web-menu'; menu.setAttribute('role', 'menu');
  const previous = document.activeElement as HTMLElement | null;
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); previous?.focus(); closeMenu = undefined; };
  const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) close(); };
  closeMenu = close;
  items.forEach((item, index) => {
    if ('separator' in item) { const separator = document.createElement('hr'); separator.setAttribute('role', 'separator'); menu.append(separator); return; }
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = item.label; button.disabled = !item.enabled;
    button.onclick = () => { close(); choose(index); }; menu.append(button);
  });
  menu.onkeydown = event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return; }
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  };
  (document.querySelector('dialog[open]') ?? document.body).append(menu);
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight))}px`;
  document.addEventListener('pointerdown', outside, true);
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
