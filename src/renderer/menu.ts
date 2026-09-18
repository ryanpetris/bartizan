import { api } from './store';

export type MenuItem = { label: string; action: () => void; disabled?: boolean } | { separator: true };
let actions: ((() => void) | undefined)[] = [];
/** Shows a native menu below an element; the main process reports the chosen item. */
export function openMenu(anchor: Element, items: MenuItem[]) {
  actions = items.map((item) => ('separator' in item ? undefined : item.action));
  const { left, bottom } = anchor.getBoundingClientRect();
  api.menu(
    items.map((item) => ('separator' in item ? item : { label: item.label, enabled: !item.disabled })),
    left,
    bottom,
  );
}
export const chooseMenuItem = (index: number) => actions[index]?.();
