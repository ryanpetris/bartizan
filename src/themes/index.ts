import { rail } from './rail';
import { tabs } from './tabs';
import { consoleTheme } from './console';

type Controls = { color: string; symbolColor: string };
/**
 * What both processes know of a theme. `controls` is the strip the native window controls take: its height, and by
 * appearance the colour behind them and of their symbols, which match the title bar the theme draws around them.
 * `axis` is the way lists of connections and items run, for arrow keys, dragging and the Move commands. `toasts` places
 * error notifications inside the application page, beside a corner where no page view lies, or in an overlay over the
 * view's top right corner. A theme with `linkStatus` shows a hovered link's address itself instead of over the page, and
 * one with `interfaceFont` false sets its whole interface in the terminal font, so Settings offers no interface font.
 */
export type ThemeManifest = {
  name: string;
  axis: 'vertical' | 'horizontal';
  controls: { height: number; dark: Controls; light: Controls };
  toasts: { overlay: false; position: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'; offset: { top?: number; right?: number; bottom?: number; left?: number }; width: string } | { overlay: true };
  linkStatus?: 'inline';
  interfaceFont?: false;
};
export const themeIds = ['rail', 'tabs', 'console'] as const;
export type ThemeId = (typeof themeIds)[number];
export const themes: Record<ThemeId, ThemeManifest> = { rail, tabs, console: consoleTheme };
