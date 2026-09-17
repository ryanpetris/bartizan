import { api } from './store';

export type MenuItem = { label: string; action: () => void; disabled?: boolean };
let actions: (() => void)[] = [];
/** Shows a native menu below an element; the main process reports the chosen item. */
export function openMenu(anchor: Element, items: MenuItem[]) {
  actions = items.map((item) => item.action);
  const { left, bottom } = anchor.getBoundingClientRect();
  api.menu(
    items.map((item) => ({ label: item.label, enabled: !item.disabled })),
    left,
    bottom,
  );
}
export const chooseMenuItem = (index: number) => actions[index]?.();
