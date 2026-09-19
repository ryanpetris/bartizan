import type { ThemeManifest } from './index';

export const rail: ThemeManifest = {
  name: 'Rail',
  axis: 'vertical',
  controls: { height: 44, dark: { color: '#1a1c23', symbolColor: '#dcdee6' }, light: { color: '#fcfcfd', symbolColor: '#23252f' } },
  // Toasts sit above Connect in the panel beside the rail, which a page view never covers; the home page, which has no page view, lies under them.
  toasts: { overlay: false, position: 'bottom-left', offset: { bottom: 64, left: 69 }, width: 'calc(var(--panel-width) - 19px)' },
};
