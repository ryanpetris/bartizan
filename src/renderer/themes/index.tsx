import type { ComponentType } from 'react';
import type { ITheme } from '@xterm/xterm';
import type { ThemeId } from '../../themes';
import { store } from '../store';
import { rail } from './rail';
import { tabs } from './tabs';
import { consoleTheme } from './console';

/**
 * What the renderer adds to a theme's manifest. `Chrome` draws the window around the selected view: its elements are
 * children of the application root beside the view. Each theme overrides shared styles with rules scoped to the
 * root's `data-theme`. `terminal` colours terminals by appearance, and `Preview` is a diagram of the layout for Settings.
 */
export type Theme = { Chrome: ComponentType; terminal: Record<'dark' | 'light', ITheme>; Preview: ComponentType };
export const registry: Record<ThemeId, Theme> = { rail, tabs, console: consoleTheme };
export const activeTheme = () => registry[store.state.settings.theme];
