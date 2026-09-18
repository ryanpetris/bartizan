import { WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WindowOpenHandlerResponse } from 'electron';
import { overlayNames, type Bounds, type OverlayName } from '../shared';

const frameName = (name: OverlayName) => `overlay-${name}`;

/**
 * Transparent views inside the application window, above the page views, for interface that floats over a page. The
 * application renderer opens each one as a named blank child window, which shares its process, and draws into that
 * document itself; an overlay has no preload and takes no part in IPC.
 */
export class Overlays {
  private views = new Map<OverlayName, WebContentsView>();
  constructor(private window: BrowserWindow) {}

  /** Answers the application renderer's `window.open`: a blank overlay that is not open yet becomes a view, and anything else is denied. */
  open = ({ url, frameName: frame }: { url: string; frameName: string }): WindowOpenHandlerResponse => {
    const name = overlayNames.find(candidate => frameName(candidate) === frame);
    if (!name || url !== 'about:blank' || this.views.has(name)) return { action: 'deny' };
    return {
      action: 'allow',
      createWindow: options => {
        // The child window's preferences follow its opener's, apart from the preload, which an overlay does without.
        const { webContents, webPreferences } = options as BrowserWindowConstructorOptions & { webContents?: Electron.WebContents };
        const view = new WebContentsView({ webContents, webPreferences: { ...webPreferences, preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        view.setBackgroundColor('#00000000');
        view.setVisible(false);
        view.webContents.on('will-navigate', event => event.preventDefault());
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.once('destroyed', () => { if (this.views.get(name) === view) this.views.delete(name); });
        this.views.set(name, view);
        this.window.contentView.addChildView(view);
        return view.webContents;
      },
    };
  };
  /** Shows an overlay at a place in the application page, above every other view, or hides it; focus inside a hidden overlay returns to the application. */
  show(name: OverlayName, bounds: Bounds | null) {
    const view = this.views.get(name);
    if (!view || view.webContents.isDestroyed()) return;
    if (!bounds || !bounds.width || !bounds.height) {
      if (view.webContents.isFocused()) this.window.webContents.focus();
      view.setVisible(false);
      return;
    }
    const zoom = this.window.webContents.getZoomFactor();
    view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
    view.setVisible(true);
    this.raise();
  }
  /** Keeps the visible overlays above a view added after them. */
  raise() {
    for (const view of this.views.values()) if (view.getVisible()) this.window.contentView.addChildView(view);
  }
  /** Closes every overlay; a reloaded application page opens its own. */
  close() {
    for (const view of this.views.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    this.views.clear();
  }
}
