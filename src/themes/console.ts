import type { ThemeManifest } from './index';

export const consoleTheme: ThemeManifest = {
  name: 'Console',
  axis: 'horizontal',
  // The title line is one text row; its rule runs on under the controls.
  controls: { height: 29, dark: { color: '#0b0f0d', symbolColor: '#b9c9be' }, light: { color: '#f3efe3', symbolColor: '#2b2a24' } },
  toasts: { overlay: true },
  // The status line shows a hovered link's address.
  linkStatus: 'inline',
  // Every line is set in the terminal font.
  interfaceFont: false,
};
