import type { State } from '../shared';
import { Icon } from './ui';
import { Overlay } from './overlay';

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

/** The connection's addresses that contain the text, most recent first. */
export function suggestions(connectionId: string, text: string): string[] {
  const query = text.trim().toLowerCase();
  return (histories[connectionId] ?? []).filter((url) => url.toLowerCase().includes(query)).slice(0, suggestionLimit);
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
  items: string[];
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
          {items.map((url, index) => (
            <li
              key={url}
              className="address-suggestion"
              data-highlighted={index === highlighted || undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onChoose(url)}
            >
              <Icon name="clock" />
              <span className="address-suggestion-url mono">{url}</span>
            </li>
          ))}
        </ul>
      )}
    </Overlay>
  );
}
