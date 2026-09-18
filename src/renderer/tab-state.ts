import type { BrowserTab, Event, State, Workspace } from '../shared';
import { store, render, activeTab } from './store';

/** What the main process reports about a tab outside state: its icon, its find result and the link under the pointer. */
const favicons = new Map<string, string>();
const found = new Map<string, { active: number; matches: number }>();
const targets = new Map<string, string>();
/** The text in each tab's open find bar. */
const finds = new Map<string, string>();

export const faviconOf = (tabId: string) => favicons.get(tabId);
export const foundIn = (tabId: string) => found.get(tabId) ?? { active: 0, matches: 0 };
export const targetOf = (tabId: string) => targets.get(tabId) ?? '';
export const findText = (tabId: string) => finds.get(tabId);
export function setFindText(tabId: string, text: string | undefined) {
  if (text === undefined) finds.delete(tabId);
  else finds.set(tabId, text);
  render();
}
/** Forgets the link under the pointer in a tab that is no longer showing. */
export function clearTarget(tabId: string) {
  if (targets.delete(tabId)) render();
}
/** Forgets an icon that does not decode. */
export function dropFavicon(tabId: string) {
  if (favicons.delete(tabId)) render();
}
export function receive(event: Extract<Event, { type: 'favicon' | 'found' | 'target-url' }>) {
  if (event.type === 'favicon') {
    if (event.data) favicons.set(event.tabId, event.data);
    else favicons.delete(event.tabId);
  } else if (event.type === 'found') found.set(event.tabId, { active: event.active, matches: event.matches });
  else if (event.url) targets.set(event.tabId, event.url);
  else targets.delete(event.tabId);
  render();
}
/** Forgets tabs that no longer exist. */
export function prune(state: State) {
  const live = new Set(state.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => tab.id)));
  for (const map of [favicons, found, targets, finds]) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
}
/** The selected browser session and the tab it shows. */
export function currentTab(): { workspace?: Workspace; tab?: BrowserTab } {
  const selection = store.selection;
  const workspace =
    selection?.kind === 'browser' ? store.state.workspaces.find((w) => w.id === selection.id) : undefined;
  return { workspace, tab: workspace && activeTab(workspace) };
}
