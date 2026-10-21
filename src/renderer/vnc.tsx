import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import type { Credentials } from '@novnc/novnc';
import { normalizeHost, type VncSession } from '../shared';
import { api, store, render, run, report, connectionOf, describeError, dialogOpen, onFocusRequest, openVnc, vncName } from './store';
import { Button, Icon, IconButton, NumberField, useUnsavedNotice } from './ui';
import { openModal } from './dialogs';
import { openMenu } from './menu';
import { Select } from './select';
import { VncChannel } from './vnc-channel';
import { changesVncClipboard, fitsVncClipboard } from './vnc-clipboard';
import { parseZoom, stepZoom, zoomRange } from './vnc-zoom';

/**
 * The viewer of a VNC tab's current attempt. `state` is the RFB session's, which connects only after the SSH channel has.
 * `reason` is the server's account of a failed authentication, `failure` a protocol failure noVNC ended the stream for,
 * `cancelled` whether the user declined to sign in or to trust the server or disconnected, `latched` the modifiers held
 * down for the keys that follow, and `scroll` where the view was scrolled to while the desktop showed.
 */
type Viewer = {
  attempt: string;
  element: HTMLElement;
  channel: VncChannel;
  rfb: RFB;
  state: 'connecting' | 'connected' | 'closed';
  credentials?: (keyof Credentials)[];
  submitted?: Credentials;
  verification?: { type: string; fingerprint: string };
  reason?: string;
  failure?: string;
  cancelled?: boolean;
  latched: Set<Modifier>;
  scroll?: [number, number];
};
const viewers = new Map<string, Viewer>();
type Modifier = 'Ctrl' | 'Alt' | 'Super';
/** The X keysym and key code of each modifier a desktop can hold down. */
const modifiers: Record<Modifier, [number, string]> = { Ctrl: [0xffe3, 'ControlLeft'], Alt: [0xffe9, 'AltLeft'], Super: [0xffeb, 'MetaLeft'] };

/**
 * A VNC tab's display and input choices, which each new attempt takes on until the tab closes. `scaling` fits the desktop
 * to the view, shows it at `zoom` percent, or asks the server to resize the desktop to the view and fits what it sends.
 * `pan` makes the pointer, touch and the wheel move the view over a zoomed desktop. `quality` and `compression` are
 * noVNC's levels, from 0 to 9. `clipboard` is the text in the tab's clipboard panel.
 */
type Controls = {
  scaling: 'fit' | 'zoom' | 'remote';
  zoom: number;
  pan: boolean;
  viewOnly: boolean;
  dotCursor: boolean;
  quality: number;
  compression: number;
  clipboard: string;
};
const controls = new Map<string, Controls>();
function controlsOf(id: string) {
  let found = controls.get(id);
  if (!found) controls.set(id, (found = { scaling: 'fit', zoom: 100, pan: false, viewOnly: false, dotCursor: false, quality: 6, compression: 2, clipboard: '' }));
  return found;
}
// noVNC waits at load for a hardware decoder probe, so it loads apart from the page, once the app offers VNC.
let loading: Promise<void> | undefined, loaded: typeof RFB | undefined, loadFailed = false;
const load = () =>
  (loading ??= import('@novnc/novnc').then(
    (module) => {
      loaded = module.default;
      render();
    },
    (error: unknown) => {
      loadFailed = true;
      report('vnc', error);
      render();
    },
  ));

const viewerOf = (vnc: VncSession) => {
  const viewer = viewers.get(vnc.id);
  return viewer?.attempt === vnc.attempt ? viewer : undefined;
};
/** A VNC tab's status: connected once the server has accepted the viewer. */
export function vncStatus(vnc: VncSession): VncSession['status'] {
  const viewer = viewerOf(vnc);
  if (vnc.status === 'closed' || viewer?.state === 'closed' || (!viewer && loadFailed)) return 'closed';
  return viewer?.state === 'connected' ? 'connected' : 'connecting';
}
/** Why a VNC tab's attempt ended: the server's reason before the channel's diagnostic. */
export function vncError(vnc: VncSession) {
  const viewer = viewerOf(vnc);
  if (viewer?.cancelled) return undefined;
  const channel = viewer?.channel.error;
  if (!viewer && loadFailed) return vnc.error ?? 'VNC viewer failed to load';
  return viewer?.reason ?? vnc.error ?? (channel && describeError(channel).message) ?? viewer?.failure;
}
export const reconnectVnc = (vnc: VncSession) => void run('vnc', api.reconnectVnc(vnc.connectionId, vnc.id), vnc.connectionId);
/** Closes a VNC tab, first sending the key up for each modifier it holds. */
export function closeVnc(vnc: VncSession) {
  const viewer = viewerOf(vnc);
  if (viewer) release(viewer);
  void run('vnc', api.closeVnc(vnc.connectionId, vnc.id), vnc.connectionId);
}
const current = () => {
  const s = store.selection;
  return s?.kind === 'vnc' ? store.state.vncs.find((v) => v.id === s.id) : undefined;
};

async function fingerprint(key: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(key)));
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, '')}`;
}
export function clearVncCredentials(viewer: Pick<Viewer, 'submitted'>) {
  if (!viewer.submitted) return;
  for (const key of Object.keys(viewer.submitted)) Reflect.deleteProperty(viewer.submitted, key);
  viewer.submitted = undefined;
}
function create(RFBViewer: typeof RFB, vnc: VncSession): Viewer {
  const element = document.createElement('div');
  element.className = 'vnc-surface';
  element.hidden = true;
  host.append(element);
  const channel = new VncChannel(api, vnc.connectionId, vnc.id, vnc.attempt);
  const rfb = new RFBViewer(element, channel);
  rfb.scaleViewport = true;
  rfb.background = 'var(--bg-main)';
  const viewer: Viewer = { attempt: vnc.attempt, element, channel, rfb, state: 'connecting', latched: new Set() };
  // noVNC sizes its canvas to the remote desktop and scales it with CSS. The toolbar shows that scale, and a zoomed desktop
  // takes its size from the remote one.
  const scaled = new ResizeObserver(render);
  new MutationObserver(() => {
    const canvas = element.querySelector('canvas');
    if (canvas) scaled.observe(canvas);
    render();
  }).observe(element, { subtree: true, childList: true, attributeFilter: ['width', 'height'] });
  // While panning, a mouse or touch drag over the desktop scrolls the view and the wheel scrolls it natively. These
  // listeners run before noVNC's on its canvas and keep the pointer and touches from reaching it, so the desktop sees no
  // presses or moves.
  let drag: { x: number; y: number } | undefined;
  const panning = () => current()?.id === vnc.id && controlsOf(vnc.id).pan;
  const block = (event: Event) => {
    if (drag || panning()) event.stopPropagation();
  };
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'])
    element.addEventListener(type, block, true);
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !panning()) return;
    drag = { x: event.clientX, y: event.clientY };
    element.setPointerCapture(event.pointerId);
    element.classList.add('dragging');
  });
  element.addEventListener('pointermove', (event) => {
    if (!drag) return;
    host.scrollBy(drag.x - event.clientX, drag.y - event.clientY);
    drag = { x: event.clientX, y: event.clientY };
  });
  element.addEventListener('lostpointercapture', () => {
    // The click that ends a drag follows its pointerup, so the drag ends after it.
    setTimeout(() => (drag = undefined));
    element.classList.remove('dragging');
  });
  // noVNC releases held keys when the window loses focus. Keys held as the desktop loses focus within the window, as when
  // another control takes it or the desktop is hidden, are released through its keyup listener, so that the server sees
  // them released and noVNC no longer counts them down. On macOS and iOS, CapsLock keydown and keyup mark the lock turning
  // on and off, and noVNC sends each as a full toggle, so CapsLock is never held there.
  // Ctrl, Alt or Meta pressed on the keyboard releases the modifiers held from the toolbar before noVNC sends the key, and
  // from then on the keyboard's own modifiers apply. noVNC rewrites some modifier keys by platform, so the held ones are
  // all released whichever modifier is pressed.
  const held = new Set<string>();
  element.addEventListener(
    'keydown',
    ({ code, key }) => {
      if (code !== 'CapsLock' || !/mac|ip(ad|hone|od)/i.test(navigator.platform)) held.add(code);
      if (viewer.latched.size && ['Control', 'Alt', 'Meta'].includes(key)) {
        release(viewer);
        render();
      }
    },
    true,
  );
  element.addEventListener('keyup', ({ code }) => held.delete(code), true);
  element.addEventListener(
    'blur',
    ({ target }) => {
      for (const code of held) target!.dispatchEvent(new KeyboardEvent('keyup', { code }));
      held.clear();
    },
    true,
  );
  rfb.addEventListener('connect', () => {
    clearVncCredentials(viewer);
    viewer.state = 'connected';
    render();
    const focused = document.activeElement;
    if (current()?.id === vnc.id && !dialogOpen() && (focused === document.body || element.closest('.vnc-view')?.contains(focused)))
      requestAnimationFrame(() => rfb.focus({ preventScroll: true }));
  });
  rfb.addEventListener('disconnect', ({ detail }) => {
    clearVncCredentials(viewer);
    viewer.state = 'closed';
    viewer.latched.clear();
    viewer.credentials = viewer.verification = undefined;
    if (!detail.clean && channel.closedByViewer && !viewer.cancelled) viewer.failure = 'VNC protocol error';
    render();
  });
  rfb.addEventListener('credentialsrequired', ({ detail }) => {
    clearVncCredentials(viewer);
    viewer.credentials = detail.types;
    render();
  });
  rfb.addEventListener('securityfailure', ({ detail }) => {
    clearVncCredentials(viewer);
    viewer.reason = detail.reason || 'Authentication failed';
  });
  rfb.addEventListener('clipboard', ({ detail }) => {
    const settings = controlsOf(vnc.id);
    if (!changesVncClipboard(settings.clipboard, detail.text)) return;
    settings.clipboard = detail.text;
    render();
  });
  rfb.addEventListener('serververification', ({ detail }) => {
    void fingerprint(detail.publickey).then((text) => {
      if (viewer.state === 'closed') return;
      viewer.verification = { type: detail.type, fingerprint: text };
      render();
    });
  });
  return viewer;
}
function dispose(id: string, viewer: Viewer) {
  viewer.channel.dispose();
  if (viewer.state !== 'closed') viewer.rfb.disconnect();
  clearVncCredentials(viewer);
  viewer.element.remove();
  viewers.delete(id);
}
/** The tab whose desktop showed at the last update. */
let shownBefore: string | undefined;
/**
 * Gives each attempt whose SSH channel is open one viewer, which stays until the tab closes or another attempt starts.
 * When noVNC fails to load, open attempts are stopped instead, which releases their channels.
 */
function update() {
  if (store.state.capabilities.vnc) void load();
  for (const [id, viewer] of viewers)
    if (store.state.vncs.find((v) => v.id === id)?.attempt !== viewer.attempt) dispose(id, viewer);
  for (const vnc of store.state.vncs) {
    if (vnc.status !== 'connected' || viewers.has(vnc.id)) continue;
    if (loaded) viewers.set(vnc.id, create(loaded, vnc));
    else if (loadFailed) void api.stopVnc(vnc.connectionId, vnc.id, vnc.attempt).catch(() => {});
  }
  for (const id of controls.keys()) if (!store.state.vncs.some((v) => v.id === id)) controls.delete(id);
  const shown = current()?.id;
  for (const [id, viewer] of viewers) apply(viewer, controlsOf(id), id === shown);
  // The view is shared, so each desktop scrolls back to where it was as it shows again.
  if (shown !== shownBefore) {
    shownBefore = shown;
    host.scrollTo(...((shown && viewers.get(shown)?.scroll) || [0, 0]));
  }
}
/**
 * Applies a tab's controls to its viewer. Only the desktop in view asks the server to resize: a hidden one measures 0 by 0,
 * which noVNC would ask for. noVNC drops requests while the desktop is view-only, so it asks again as input returns. A
 * hidden desktop, like one that turns view-only or shows without the toolbar, releases the modifiers it holds.
 */
function apply(viewer: Viewer, settings: Controls, shown: boolean) {
  const { rfb, element } = viewer;
  const resize = shown && settings.scaling === 'remote' && !settings.viewOnly;
  if (!resize) rfb.resizeSession = false;
  if (!shown || settings.viewOnly || store.fullscreen === 'content') release(viewer);
  element.hidden = !shown;
  if (rfb.viewOnly !== settings.viewOnly) rfb.viewOnly = settings.viewOnly;
  if (rfb.showDotCursor !== settings.dotCursor) rfb.showDotCursor = settings.dotCursor;
  rfb.qualityLevel = settings.quality;
  rfb.compressionLevel = settings.compression;
  // A zoomed desktop's element takes the zoomed size of the remote desktop, which noVNC fits it to, so that noVNC maps the
  // pointer at that scale. The view scrolls it where it is larger, and centres it where it is smaller.
  const canvas = element.querySelector('canvas'),
    zoom = settings.scaling === 'zoom' && canvas?.width ? settings.zoom / 100 : 0;
  element.classList.toggle('zoomed', zoom > 0);
  element.style.width = zoom ? `${canvas!.width * zoom}px` : '';
  element.style.height = zoom ? `${canvas!.height * zoom}px` : '';
  if (resize && !rfb.resizeSession) rfb.resizeSession = true;
  element.classList.toggle('panning', shown && settings.pan);
}
function release(viewer: Viewer) {
  for (const key of viewer.latched) viewer.rfb.sendKey(...modifiers[key], false);
  viewer.latched.clear();
}
function latch(viewer: Viewer, key: Modifier) {
  const down = !viewer.latched.has(key);
  if (down) viewer.latched.add(key);
  else viewer.latched.delete(key);
  viewer.rfb.sendKey(...modifiers[key], down);
}
/** The scale the desktop shows at, as a whole percentage, while it shows. */
function shownScale(viewer: Viewer | undefined) {
  const canvas = viewer?.element.querySelector('canvas'),
    width = canvas?.getBoundingClientRect().width;
  return canvas?.width && width ? Math.round((width / canvas.width) * 100) : undefined;
}
function setControls(vnc: VncSession, change: Partial<Controls>) {
  Object.assign(controlsOf(vnc.id), change);
  render();
}
/** Zooms the desktop in view, keeping the point at the centre of the view in place. */
function zoomTo(vnc: VncSession, percent: number) {
  const x = (host.scrollLeft + host.clientWidth / 2) / host.scrollWidth,
    y = (host.scrollTop + host.clientHeight / 2) / host.scrollHeight;
  Object.assign(controlsOf(vnc.id), { scaling: 'zoom', zoom: Math.min(zoomRange.max, Math.max(zoomRange.min, percent)) });
  update();
  host.scrollLeft = x * host.scrollWidth - host.clientWidth / 2;
  host.scrollTop = y * host.scrollHeight - host.clientHeight / 2;
  render();
}
/** Ends an attempt the user declined to sign in to, or disconnected, which stays closed until reconnected. */
function cancel(viewer: Viewer) {
  release(viewer);
  viewer.cancelled = true;
  viewer.credentials = viewer.verification = undefined;
  viewer.rfb.disconnect();
  clearVncCredentials(viewer);
  render();
}

const host = document.createElement('div');
host.className = 'vnc-host';
host.addEventListener('scroll', () => {
  const vnc = current(),
    viewer = vnc && viewerOf(vnc);
  if (viewer) viewer.scroll = [host.scrollLeft, host.scrollTop];
});
onFocusRequest(() => {
  const vnc = current(),
    viewer = vnc && viewerOf(vnc);
  if (viewer?.state === 'connected' && !dialogOpen()) viewer.rfb.focus({ preventScroll: true });
});
export function Vncs() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current!.append(host);
    return () => host.remove();
  }, []);
  useLayoutEffect(update);
  const vnc = current(),
    status = vnc && vncStatus(vnc),
    error = vnc && status === 'closed' ? vncError(vnc) : undefined;
  return (
    <section className="view vnc-view" aria-labelledby="view-title" hidden={!vnc}>
      {vnc && status === 'connected' && <Toolbar key={vnc.id} vnc={vnc} viewer={viewerOf(vnc)!} />}
      <div className="vnc-body">
        <div ref={ref} className="vnc-frame" />
        {vnc && status !== 'connected' && (
          <div className="vnc-status empty-view">
            <span className="empty-mark">
              <Icon name="display" />
            </span>
            <p role="status">{status === 'closed' ? 'Closed' : 'Connecting'}</p>
            {error && <p className="vnc-error">{error}</p>}
            {vnc.status === 'closed' && connectionOf(vnc.connectionId)?.status === 'connected' && (
              <Button icon="reload" onClick={() => reconnectVnc(vnc)}>
                Reconnect
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const scalings = [
  { value: 'fit', label: 'Scale to Fit' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'remote', label: 'Resize Remote' },
];
/** The tab whose clipboard panel is open. */
let clipboardShown: string | undefined;
let clipboardButton: HTMLButtonElement | null = null;
function closeClipboard(refocus = false) {
  clipboardShown = undefined;
  render();
  if (refocus) clipboardButton?.focus();
}
/**
 * The controls over a connected VNC tab's desktop. The zoom field shows the scale the desktop shows at in every mode;
 * zooming from another mode starts from that scale. Keys and the clipboard reach the desktop only while it takes input.
 * The clipboard panel closes with the toolbar.
 */
function Toolbar({ vnc, viewer }: { vnc: VncSession; viewer: Viewer }) {
  const settings = controlsOf(vnc.id),
    input = settings.viewOnly ? undefined : viewer,
    percent = settings.scaling === 'zoom' ? settings.zoom : shownScale(viewer);
  const [draft, setDraft] = useState<string>();
  useEffect(
    () => () => {
      if (clipboardShown === vnc.id) clipboardShown = undefined;
    },
    [],
  );
  const commit = () => {
    const value = draft === undefined ? undefined : parseZoom(draft);
    setDraft(undefined);
    if (value !== undefined) zoomTo(vnc, value);
  };
  const step = (direction: 1 | -1) => percent !== undefined && zoomTo(vnc, stepZoom(percent, direction));
  /** Runs a key action on the desktop, which then takes the keyboard for the keys that follow. */
  const act = (viewer: Viewer, action: () => void) => () => {
    action();
    viewer.rfb.focus({ preventScroll: true });
    render();
  };
  return (
    <div className="vnc-toolbar" hidden={store.fullscreen === 'content'}>
      <Select
        className="vnc-scaling"
        aria-label="Scaling"
        value={settings.scaling}
        options={scalings}
        onChange={(value) =>
          value === 'zoom' ? zoomTo(vnc, shownScale(viewer) ?? settings.zoom) : setControls(vnc, { scaling: value as Controls['scaling'], pan: false })
        }
      />
      <div className="vnc-zoom" role="group" aria-label="Zoom">
        <IconButton icon="minus" label="Zoom Out" disabled={percent === undefined || percent <= zoomRange.min} onClick={() => step(-1)} />
        <input
          className="input vnc-zoom-level"
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label="Zoom Level"
          aria-valuemin={zoomRange.min}
          aria-valuemax={zoomRange.max}
          aria-valuenow={percent}
          aria-valuetext={percent === undefined ? undefined : `${percent}%`}
          autoComplete="off"
          spellCheck={false}
          value={draft ?? (percent === undefined ? '' : `${percent}%`)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            const field = event.currentTarget;
            if (event.key === 'Enter') commit();
            else if (event.key === 'Escape' && draft !== undefined) setDraft(undefined);
            else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              setDraft(undefined);
              step(event.key === 'ArrowUp' ? 1 : -1);
            } else return;
            requestAnimationFrame(() => field.select());
          }}
        />
        <IconButton icon="plus" label="Zoom In" disabled={percent === undefined || percent >= zoomRange.max} onClick={() => step(1)} />
      </div>
      {settings.scaling === 'zoom' && (
        <IconButton icon="move" label="Pan" aria-pressed={settings.pan} onClick={() => setControls(vnc, { pan: !settings.pan })} />
      )}
      {[...viewer.latched].map((key) => (
        <button key={key} type="button" className="button vnc-held" aria-pressed="true" onClick={act(viewer, () => latch(viewer, key))}>
          {key}
        </button>
      ))}
      <div className="vnc-tools">
        <IconButton icon="eye" label="View Only" aria-pressed={settings.viewOnly} onClick={() => setControls(vnc, { viewOnly: !settings.viewOnly })} />
        <IconButton
          icon="keyboard"
          label="Send Keys"
          aria-haspopup="menu"
          disabled={!input}
          onClick={(event) => {
            if (!input) return;
            const tap = (keysym: number, code: string) => act(input, () => input.rfb.sendKey(keysym, code));
            openMenu(
              event.currentTarget,
              [
                {
                  label: 'Ctrl+Alt+Del',
                  // noVNC sends Ctrl and Alt up after Delete, which releases them where they were held.
                  action: act(input, () => {
                    input.rfb.sendCtrlAltDel();
                    input.latched.delete('Ctrl');
                    input.latched.delete('Alt');
                  }),
                },
                { separator: true },
                ...(Object.keys(modifiers) as Modifier[]).map((key) => ({
                  label: `Hold ${key}`,
                  checked: input.latched.has(key),
                  action: act(input, () => latch(input, key)),
                })),
                { separator: true },
                { label: 'Tab', action: tap(0xff09, 'Tab') },
                { label: 'Esc', action: tap(0xff1b, 'Escape') },
              ],
              { stale: () => viewerOf(vnc) !== input || input.state !== 'connected' || controlsOf(vnc.id).viewOnly },
            );
          }}
        />
        <IconButton
          ref={(node) => {
            clipboardButton = node;
          }}
          icon="clipboard"
          label="Clipboard"
          aria-haspopup="dialog"
          aria-expanded={clipboardShown === vnc.id}
          onClick={() => {
            if (clipboardShown === vnc.id) closeClipboard();
            else {
              clipboardShown = vnc.id;
              render();
            }
          }}
        />
        <IconButton
          icon="more"
          label="VNC Menu"
          aria-haspopup="menu"
          onClick={(event) => {
            const levels = (key: 'quality' | 'compression') =>
              Array.from({ length: 10 }, (_, level) => ({
                label: String(level),
                checked: settings[key] === level,
                action: () => setControls(vnc, { [key]: level }),
              }));
            openMenu(event.currentTarget, [
              { label: 'Quality', submenu: levels('quality') },
              { label: 'Compression', submenu: levels('compression') },
              { label: 'Show Dot Cursor', checked: settings.dotCursor, action: () => setControls(vnc, { dotCursor: !settings.dotCursor }) },
              { separator: true },
              { label: 'Disconnect', action: () => cancel(viewer) },
            ]);
          }}
        />
      </div>
      {clipboardShown === vnc.id && <ClipboardPanel vnc={vnc} settings={settings} input={input} />}
    </div>
  );
}
/** The tab's clipboard text: what the desktop last copied, or text to send it. */
function ClipboardPanel({ vnc, settings, input }: { vnc: VncSession; settings: Controls; input?: Viewer }) {
  const panel = useRef<HTMLElement>(null),
    field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(settings.clipboard);
  useEffect(() => setText(settings.clipboard), [settings.clipboard]);
  useLayoutEffect(() => field.current?.focus(), []);
  // A press anywhere else in this window closes the panel. Below the title bar it lands on the backdrop, so, as with a
  // menu, it reaches nothing else.
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) closeClipboard();
    };
    addEventListener('pointerdown', press, true);
    return () => removeEventListener('pointerdown', press, true);
  }, []);
  return (
    <>
      <div className="vnc-clipboard-backdrop" />
      <section
        ref={panel}
        className="popover vnc-clipboard"
        role="dialog"
        aria-label="Clipboard"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeClipboard(true);
        }}
      >
        <textarea
          ref={field}
          className="input vnc-clipboard-text"
          aria-label="Clipboard Text"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            const value = event.target.value;
            if (!fitsVncClipboard(value)) return;
            setText(value);
            settings.clipboard = value;
          }}
        />
        <footer className="popover-actions">
          <Button disabled={!text} onClick={() => void run('clipboard', api.copy(text), vnc.connectionId)}>
            Copy
          </Button>
          <Button
            className="primary"
            disabled={!input}
            onClick={() => {
              if (!input || !fitsVncClipboard(text)) return;
              input.rfb.clipboardPasteFrom(text);
              closeClipboard();
              input.rfb.focus({ preventScroll: true });
            }}
          >
            Send
          </Button>
        </footer>
      </section>
    </>
  );
}

/** The connection a new VNC tab is being asked for. */
let asking: string | undefined;
export function openNewVnc(connectionId: string) {
  if (asking) return;
  asking = connectionId;
  render();
}
export function NewVnc() {
  return asking ? <NewVncDialog connectionId={asking} /> : <dialog id="vnc-dialog" className="prompt-dialog" />;
}
function NewVncDialog({ connectionId }: { connectionId: string }) {
  const dialog = useRef<HTMLDialogElement>(null),
    hostInput = useRef<HTMLInputElement>(null),
    portInput = useRef<HTMLInputElement>(null);
  const [hostname, setHostname] = useState('localhost'),
    [port, setPort] = useState('5900');
  const [errors, setErrors] = useState<{ hostname?: string; port?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [unsavedNotice, hold] = useUnsavedNotice();
  const latest = useRef({ hostname, port });
  latest.current = { hostname, port };
  const connection = connectionOf(connectionId);
  useLayoutEffect(() => {
    openModal(dialog.current!, hostInput.current!, () => {
      if (latest.current.hostname !== 'localhost' || latest.current.port !== '5900') hold();
      else dialog.current?.close();
    });
    hostInput.current!.select();
  }, []);
  // The destination is reached through the connection, so the question ends with it.
  useLayoutEffect(() => {
    if (connection?.status !== 'connected') dialog.current?.close();
  });
  async function submit() {
    const name = normalizeHost(hostname.trim()),
      number = /^\s*\d+\s*$/.test(port) ? Number(port) : NaN;
    const found = { hostname: name ? undefined : 'Invalid hostname', port: number >= 1 && number <= 65535 ? undefined : 'Invalid port' };
    setErrors(found);
    if (!name || found.port) {
      (name ? portInput : hostInput).current?.focus();
      return;
    }
    setBusy(true);
    try {
      await openVnc(connectionId, { host: name, port: number });
      dialog.current?.close();
    } catch (error) {
      setErrors({ form: describeError(error).message });
      setBusy(false);
    }
  }
  const validity = (field: 'hostname' | 'port') => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? `vnc-${field}-error` : undefined,
  });
  return (
    <dialog
      ref={dialog}
      id="vnc-dialog"
      className="prompt-dialog"
      aria-labelledby="vnc-title"
      onClose={() => {
        asking = undefined;
        render();
      }}
    >
      <form
        className="dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="display" />
          </span>
          <div className="dialog-titles">
            <h2 id="vnc-title">New VNC</h2>
            <p className="dialog-context">{connection?.label}</p>
          </div>
        </header>
        <div className="stack-field">
          <label htmlFor="vnc-hostname">Hostname</label>
          <input
            ref={hostInput}
            id="vnc-hostname"
            className="input mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            disabled={busy}
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            {...validity('hostname')}
          />
          <p className="dialog-error" id="vnc-hostname-error" hidden={!errors.hostname}>
            {errors.hostname}
          </p>
        </div>
        <div className="stack-field">
          <label htmlFor="vnc-port">Port</label>
          <NumberField
            inputRef={portInput}
            id="vnc-port"
            min={1}
            max={65535}
            disabled={busy}
            value={port}
            onValue={setPort}
            {...validity('port')}
          />
          <p className="dialog-error" id="vnc-port-error" hidden={!errors.port}>
            {errors.port}
          </p>
        </div>
        <p className="dialog-error" role="alert" hidden={!errors.form}>
          {errors.form}
        </p>
        <footer className="dialog-actions">
          {unsavedNotice}
          <Button disabled={busy} onClick={() => dialog.current!.close()}>
            Cancel
          </Button>
          <button type="submit" className="button primary" disabled={busy}>
            Connect
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** Asks for the sign-in or server approval a VNC attempt is waiting for, one attempt at a time. */
export function VncPrompts() {
  const vnc = store.state.vncs.find((v) => {
    const viewer = viewerOf(v);
    return viewer && (viewer.credentials || viewer.verification);
  });
  const viewer = vnc && viewerOf(vnc);
  return vnc && viewer ? (
    <PromptDialog key={`${viewer.attempt}:${viewer.verification ? 'verify' : 'sign-in'}`} vnc={vnc} viewer={viewer} />
  ) : (
    <dialog id="vnc-auth-dialog" className="prompt-dialog" />
  );
}
function PromptDialog({ vnc, viewer }: { vnc: VncSession; viewer: Viewer }) {
  const dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null);
  const [unsavedNotice, hold] = useUnsavedNotice();
  const verification = viewer.verification,
    types = verification ? [] : (viewer.credentials ?? []);
  const fields = { username: 'Username', password: 'Password', target: 'Target' } as const;
  const inputs = () => [...form.current!.querySelectorAll('input')];
  useLayoutEffect(() => {
    const node = dialog.current!;
    openModal(node, inputs()[0] ?? node.querySelector('button')!, () => {
      if (inputs().some((input) => input.value)) hold();
      else cancel(viewer);
    });
    return () => {
      if (node.open) node.close();
    };
  }, []);
  const context = `${connectionOf(vnc.connectionId)?.label ?? ''} · ${vncName(vnc)}`;
  return (
    <dialog
      ref={dialog}
      id="vnc-auth-dialog"
      className="prompt-dialog"
      aria-labelledby="vnc-auth-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel(viewer);
      }}
    >
      <form
        ref={form}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (verification) {
            viewer.verification = undefined;
            viewer.rfb.approveServer();
          } else {
            viewer.credentials = undefined;
            clearVncCredentials(viewer);
            const credentials = Object.fromEntries(inputs().map((input) => [input.name, input.value]));
            viewer.submitted = credentials;
            viewer.rfb.sendCredentials(credentials);
          }
          render();
        }}
      >
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name={verification ? 'shield' : 'lock'} />
          </span>
          <div className="dialog-titles">
            <h2 id="vnc-auth-title">{verification ? 'Trust server?' : types.includes('username') ? 'VNC Sign-In' : 'VNC Password'}</h2>
            <p className="dialog-context">{context}</p>
          </div>
        </header>
        {verification && (
          <dl className="facts">
            {[
              ['Server', vncName(vnc)],
              ['Key Type', verification.type],
              ['Fingerprint', verification.fingerprint],
            ].map(([term, value]) => (
              <Fragment key={term}>
                <dt>{term}</dt>
                <dd className="mono">{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {types.map((type) => (
          <div key={type} className="stack-field">
            <label htmlFor={`vnc-auth-${type}`}>{fields[type]}</label>
            <input
              id={`vnc-auth-${type}`}
              name={type}
              type={type === 'password' ? 'password' : 'text'}
              className="input"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
            />
          </div>
        ))}
        <footer className="dialog-actions">
          {unsavedNotice}
          <Button onClick={() => cancel(viewer)}>Cancel</Button>
          <button type="submit" className="button primary">
            {verification ? 'Trust Server' : 'Sign In'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
