import type { State } from '../shared';
import { Icon } from './ui';
import { api, render } from './store';
import { Overlay } from './overlay';

/** An address the address field offers: one the connection's tabs have been to, or a port listening on its host. */
export type Suggestion = { url: string; kind: 'history' | 'port' };
const historyLimit = 100;
/** How many suggestions show at most. */
export const suggestionLimit = 10;

/** Each connection's typed and visited addresses, most recent first; they last for the application launch. */
const histories: Record<string, string[]> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('address-history') ?? '{}');
  } catch {
    return {};
  }
})();
/** Records an address a connection's tab was sent to or showed. */
export function remember(connectionId: string, url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  histories[connectionId] = [url, ...(histories[connectionId] ?? []).filter((item) => item !== url)].slice(0, historyLimit);
  try {
    sessionStorage.setItem('address-history', JSON.stringify(histories));
  } catch {
    /* The history still lasts until the page reloads. */
  }
}
/** The address each tab last showed once loaded. */
const visited = new Map<string, string>();
/** Records the pages tabs of ordinary sessions have finished loading. */
export function recordVisits(state: State) {
  const live = new Set<string>();
  for (const workspace of state.workspaces) {
    if (workspace.application) continue;
    for (const tab of workspace.tabs) {
      live.add(tab.id);
      if (tab.loading || tab.error || !tab.url || visited.get(tab.id) === tab.url) continue;
      visited.set(tab.id, tab.url);
      remember(workspace.connectionId, tab.url);
    }
  }
  for (const id of visited.keys()) if (!live.has(id)) visited.delete(id);
}

const ports = new Map<string, number[]>();
/** Reads the connection's listening ports again; the main process reads them at most every few seconds. */
export function refreshPorts(connectionId: string) {
  void api.remotePorts(connectionId).then(
    (found) => {
      ports.set(connectionId, found);
      render();
    },
    () => {},
  );
}
/** The connection's addresses that contain the text, its history first, then its ports as local addresses. */
export function suggestions(connectionId: string, text: string): Suggestion[] {
  const query = text.trim().toLowerCase();
  const matches = (url: string) => url.toLowerCase().includes(query);
  const history = (histories[connectionId] ?? []).filter(matches);
  const local = (ports.get(connectionId) ?? [])
    .map((port) => `http://localhost:${port}/`)
    .filter((url) => matches(url) && !history.includes(url));
  return [
    ...history.map((url) => ({ url, kind: 'history' as const })),
    ...local.map((url) => ({ url, kind: 'port' as const })),
  ].slice(0, suggestionLimit);
}
export const suggestionId = (index: number) => `address-suggestion-${index}`;

/**
 * The suggestions drawn over the page below the address field, as wide as the field; the pointer chooses one. The
 * address field's document holds the copy assistive technology reads.
 */
export function AddressSuggestions({
  field,
  items,
  highlighted,
  onChoose,
  onLeave,
}: {
  field: () => HTMLElement | null;
  items: Suggestion[];
  highlighted: number;
  onChoose(url: string): void;
  onLeave(): void;
}) {
  const box = field()?.getBoundingClientRect();
  return (
    <Overlay
      name="suggestions"
      onLeave={onLeave}
      place={(size) => {
        const anchor = field()?.getBoundingClientRect();
        return items.length && anchor?.width ? { x: anchor.left - 12, y: anchor.bottom, ...size } : undefined;
      }}
    >
      {items.length > 0 && (
        <ul className="popover address-suggestions" aria-hidden="true" style={{ width: box?.width }}>
          {items.map((item, index) => (
            <li
              key={item.url}
              className="address-suggestion"
              data-highlighted={index === highlighted || undefined}
              data-kind={item.kind}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onChoose(item.url)}
            >
              <Icon name={item.kind === 'history' ? 'clock' : 'code'} />
              <span className="address-suggestion-url mono">{item.url}</span>
            </li>
          ))}
        </ul>
      )}
    </Overlay>
  );
}
