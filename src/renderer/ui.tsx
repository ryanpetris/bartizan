import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
const paths: Record<string, string> = {
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  close: '<path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5"/>',
  terminal:
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="m4.5 6.25 2 1.75-2 1.75M8.25 10h3"/>',
  window:
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M1.75 5.75h12.5"/><circle cx="3.9" cy="4.25" r=".2" fill="currentColor"/><circle cx="5.5" cy="4.25" r=".2" fill="currentColor"/>',
  globe:
    '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25C6.2 12.55 5.3 10.45 5.3 8S6.2 3.45 8 1.75Z"/>',
  back: '<path d="M13 8H3.25M7.25 4 3.25 8l4 4"/>',
  forward: '<path d="M3 8h9.75M8.75 4l4 4-4 4"/>',
  reload: '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M12.25 1.75v2.75H9.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.35 3.35"/>',
  power: '<path d="M8 1.75v5.5M4.6 3.9a5.25 5.25 0 1 0 6.8 0"/>',
  key: '<circle cx="5.25" cy="10.75" r="3"/><path d="m7.4 8.6 6.1-6.1M11.25 4.75 13 6.5M9.5 6.5l1.25 1.25"/>',
  shield:
    '<path d="M8 1.75 13.25 3.6v4.05c0 3.05-2.2 5.55-5.25 6.6-3.05-1.05-5.25-3.55-5.25-6.6V3.6Z"/><path d="m5.75 8 1.6 1.6 2.9-3.1"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M7 7.25h1v4M7 11.25h2"/><circle cx="7.9" cy="4.75" r=".35" fill="currentColor"/>',
  alert:
    '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.9"/><circle cx="8" cy="11.1" r=".35" fill="currentColor"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2"/>',
  undo: '<path d="M3.75 6h6a3.25 3.25 0 0 1 0 6.5H6.5"/><path d="M6.5 3 3.5 6l3 3"/>',
  settings:
    '<path d="M6.73 3.27 6.98 1.58h2.04l.25 1.69 1.18.49 1.37-1.02 1.44 1.44-1.02 1.37.49 1.18 1.69.25v2.04l-1.69.25-.49 1.18 1.02 1.37-1.44 1.44-1.37-1.02-1.18.49-.25 1.69H6.98l-.25-1.69-1.18-.49-1.37 1.02-1.44-1.44 1.02-1.37-.49-1.18-1.69-.25V6.98l1.69-.25.49-1.18-1.02-1.37 1.44-1.44 1.37 1.02Z"/><circle cx="8" cy="8" r="2"/>',
  code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5"/>',
  volume: '<path d="M2.75 6.25h2.5L8.5 3.5v9L5.25 9.75h-2.5Z"/><path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.4 4a5.6 5.6 0 0 1 0 8"/>',
  'volume-off': '<path d="M2.75 6.25h2.5L8.5 3.5v9L5.25 9.75h-2.5Z"/><path d="m10.75 6.25 3 3.5m0-3.5-3 3.5"/>',
  download: '<path d="M8 2.5v7.75M4.75 7.25 8 10.5l3.25-3.25M3 13.25h10"/>',
  folder:
    '<path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75h5a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  more: '<circle cx="8" cy="3.5" r=".5" fill="currentColor"/><circle cx="8" cy="8" r=".5" fill="currentColor"/><circle cx="8" cy="12.5" r=".5" fill="currentColor"/>',
  up: '<path d="m4.5 9.75 3.5-3.5 3.5 3.5"/>',
  down: '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
  sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M6.25 2.75v10.5"/>',
  sliders:
    '<path d="M2.25 4.75h6.5m3 0h2M2.25 11.25h2m3 0h6.5"/><circle cx="10.25" cy="4.75" r="1.5"/><circle cx="5.75" cy="11.25" r="1.5"/>',
};
export type IconName = keyof typeof paths;

export const colorStyle = (color: string | undefined) => ({ '--session-color': color }) as CSSProperties;
export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: paths[name] }}
    />
  );
}
export function IconButton({
  icon,
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" className={`icon-button ${className}`.trim()} aria-label={label} title={label} {...props}>
      <Icon name={icon} />
    </button>
  );
}
export function Button({
  children,
  icon,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName }) {
  return (
    <button type="button" className={`button ${className}`.trim()} {...props}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}
export function Tags({ tags }: { tags: string[] }) {
  return (
    <span className="tag-list" title={tags.join(', ') || undefined}>
      {tags.map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  );
}
/** Moves focus among items with the arrow, Home and End keys; returns whether it handled the key. */
export function moveFocus(items: HTMLElement[], key: string, wrap = false): boolean {
  const index = items.indexOf((items[0]?.ownerDocument ?? document).activeElement as HTMLElement);
  const next =
    key === 'ArrowDown' ? index + 1 : key === 'ArrowUp' ? index - 1 : key === 'Home' ? 0 : key === 'End' ? items.length - 1 : NaN;
  if (index < 0 || Number.isNaN(next)) return false;
  items[wrap ? (next + items.length) % items.length : Math.min(items.length - 1, Math.max(0, next))]?.focus();
  return true;
}
/** A dialog's notice of unsaved changes, and `hold`, which shows it for three seconds when they keep a click outside from dismissing the dialog. */
export function useUnsavedNotice(): [notice: ReactNode, hold: () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hold = useCallback(() => {
    setShown(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), 3000);
  }, []);
  return [
    <p className="unsaved-notice" role="status">
      {shown ? 'Unsaved changes' : ''}
    </p>,
    hold,
  ];
}
