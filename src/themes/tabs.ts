import type { ThemeManifest } from './index';

export const tabs: ThemeManifest = {
  name: 'Tabs',
  axis: 'horizontal',
  controls: { height: 42, dark: { color: '#151312', symbolColor: '#e7e0d8' }, light: { color: '#f1ede6', symbolColor: '#2b2622' } },
  toasts: { overlay: true },
};
