import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { dialogOpen, onFocusRequest } from './store';
import { Icon } from './ui';

/** A row of a picker: what it shows, what choosing it does, and the heading it falls under. */
export type PickerRow = {
  key: string;
  /** The heading the row falls under; rows sharing one follow the first of them. */
  group?: string;
  className?: string;
  /** Whether choosing the row does nothing, as while the page is busy; the row keeps its place in the focus order. */
  disabled?: boolean;
  /** Attributes of the row, such as its data and its context menu. */
  row?: HTMLAttributes<HTMLElement> & { [data: `data-${string}`]: string | undefined };
  /** Attributes of the row's own button. */
  item?: ButtonHTMLAttributes<HTMLButtonElement>;
  content: ReactNode;
  /** A control beside the row that Right and Left reach, which takes the `tabIndex` it is given. */
  action?: (tabIndex: number) => ReactNode;
  choose(): void;
};
/** The button of a row's result, or of its action where it has one. */
const button = (row: Element | undefined, action: boolean) =>
  (action && row?.querySelector<HTMLElement>('.row-actions button')) || row?.querySelector<HTMLElement>('.picker-item');

/**
 * A page of results a search narrows, as a grid. One result is current: the first once the search has text, until Up
 * and Down in the search or a moving pointer choose another. Tab takes focus to the current result, and in the grid Up
 * and Down move through the results, Right and Left between a result and its action, and Escape returns to the search.
 * Enter in the search chooses the current result. The search is the page's, so the page decides what matches it.
 */
export function Picker({
  name,
  title,
  searchLabel,
  query,
  onQuery,
  rows,
  actions,
  notices,
  empty,
  busy,
  className = '',
}: {
  /** Names the page's focus group and its elements. */
  name: string;
  /** What the page is called; the bar over the view shows it, and it names the page and its results. */
  title: string;
  searchLabel: string;
  query: string;
  onQuery(query: string): void;
  rows: PickerRow[];
  /** Controls beside the search. */
  actions?: ReactNode;
  /** Alerts above the results. */
  notices?: ReactNode;
  /** What stands in for the results while the page has none of its own to show. */
  empty?: ReactNode;
  busy?: boolean;
  className?: string;
}) {
  const search = useRef<HTMLInputElement>(null),
    body = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<{ key: string; action: boolean }>(),
    [pointing, setPointing] = useState(false);
  // The page is in view while its picker stands, so the search takes the focus the view is given.
  useLayoutEffect(() => onFocusRequest(() => !dialogOpen() && search.current?.focus()), []);
  // The result made current, while it remains; otherwise the first once the search has text.
  const found = current ? rows.findIndex((row) => row.key === current.key) : -1;
  const chosen = found >= 0 ? found : query.trim() && rows.length ? 0 : -1;
  // Tab reaches the current result, or its action if that had focus last; with none, the first result.
  const stop = Math.max(chosen, 0),
    stopAction = found >= 0 && current!.action && !!rows[stop]?.action;
  const chosenKey = rows[chosen]?.key;
  // Each search shows its results from the top.
  useLayoutEffect(() => {
    body.current!.scrollTop = 0;
  }, [query]);
  // A result that becomes current comes into view, unless the pointer chose it where it is.
  const pointed = useRef(false);
  useLayoutEffect(() => {
    if (pointed.current) pointed.current = false;
    else list.current!.querySelector('[data-chosen]')?.scrollIntoView({ block: 'nearest' });
  }, [chosenKey]);
  const choose = (row: PickerRow) => {
    if (!row.disabled) row.choose();
  };
  const cellId = (index: number) => `${name}-item-${index}`;
  return (
    <section
      className={`view page picker ${className}`.trim()}
      aria-label={title}
      aria-busy={busy}
      data-focus-group={name}
      data-focus-items=".picker-search .input, .picker-item"
      onKeyDown={() => {
        if (pointing) setPointing(false);
      }}
    >
      <header className="page-toolbar">
        <label className="picker-search">
          <Icon name="search" />
          <input
            ref={search}
            className="input"
            type="text"
            role="combobox"
            aria-label={searchLabel}
            aria-haspopup="grid"
            aria-expanded={rows.length > 0}
            aria-controls={`${name}-results`}
            aria-autocomplete="list"
            aria-activedescendant={rows[chosen] && cellId(chosen)}
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              onQuery(event.target.value);
              setCurrent(undefined);
            }}
            // Back in the search, Tab returns to the current result itself.
            onFocus={() => current?.action && setCurrent({ ...current, action: false })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
              const last = rows.length - 1;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (last < 0) return;
                const down = event.key === 'ArrowDown';
                const next = chosen < 0 ? (down ? 0 : last) : Math.min(last, Math.max(0, chosen + (down ? 1 : -1)));
                setCurrent({ key: rows[next]!.key, action: false });
              } else if (event.key === 'Enter') {
                if (rows[chosen]) choose(rows[chosen]);
              } else if (event.key === 'Escape') {
                if (!query) return;
                onQuery('');
                setCurrent(undefined);
              } else return;
              event.preventDefault();
            }}
          />
        </label>
        {actions}
      </header>
      <div ref={body} className="picker-body">
        {notices && <div className="picker-notices">{notices}</div>}
        <div
          ref={list}
          className="picker-list"
          id={`${name}-results`}
          role="grid"
          aria-label={title}
          hidden={!rows.length}
          // The pointer hides the focus ring until a key is pressed.
          data-pointing={pointing || undefined}
          onPointerDown={() => setPointing(true)}
          onPointerLeave={() => {
            if (pointing && !query.trim() && !list.current!.contains(document.activeElement)) setCurrent(undefined);
          }}
          onPointerMove={(event) => {
            // Rows that appear under a still pointer get a move with no movement; only a moving pointer chooses.
            if (!event.movementX && !event.movementY) return;
            const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
            if (!row) return;
            setPointing(true);
            if (row.dataset.key !== chosenKey) pointed.current = true;
            if (current?.key !== row.dataset.key) setCurrent({ key: row.dataset.key!, action: false });
            // Focus in the results follows the pointer to the result or action under it, so keys act on what it chose.
            const focused = document.activeElement,
              target = button(row, !!(event.target as Element).closest('.row-actions'));
            if (list.current!.contains(focused) && target !== focused) target?.focus({ preventScroll: true });
          }}
          // The result or action that takes focus becomes current.
          onFocus={(event) => {
            const row = (event.target as Element).closest<HTMLElement>('[role="row"]');
            if (row) setCurrent({ key: row.dataset.key!, action: !!(event.target as Element).closest('.row-actions') });
          }}
          onKeyDown={(event) => {
            if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === 'Escape') {
              search.current!.focus();
              event.preventDefault();
              return;
            }
            const cells = [...list.current!.querySelectorAll(':scope > [role="row"]')];
            const row = (event.target as Element).closest('[role="row"]')!,
              index = cells.indexOf(row),
              action = !!(event.target as Element).closest('.row-actions');
            const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: cells.length - 1 }[event.key];
            let target: HTMLElement | null | undefined;
            if (to !== undefined) target = button(cells[Math.min(cells.length - 1, Math.max(0, to))], action);
            else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') target = button(row, event.key === 'ArrowRight');
            else return;
            event.preventDefault();
            target?.focus();
          }}
        >
          {rows.map((row, index) => (
            <Row key={row.key} row={row} heading={row.group !== rows[index - 1]?.group ? row.group : undefined}>
              <div role="gridcell" id={cellId(index)} aria-selected={index === chosen || undefined}>
                <button
                  type="button"
                  data-id={row.key}
                  {...row.item}
                  className={`picker-item ${row.item?.className ?? ''}`.trim()}
                  data-chosen={index === chosen || undefined}
                  tabIndex={index === stop && !stopAction ? 0 : -1}
                  aria-disabled={row.disabled || undefined}
                  onClick={() => choose(row)}
                >
                  {row.content}
                </button>
              </div>
              {row.action && (
                <span role="gridcell" className="row-actions">
                  {row.action(index === stop && stopAction ? 0 : -1)}
                </span>
              )}
            </Row>
          ))}
        </div>
        {empty}
        <p className="section-empty" hidden={!query.trim() || !!rows.length}>
          No Results Found
        </p>
      </div>
    </section>
  );
}
/** A result's row, under the heading of the group it starts. */
function Row({ row, heading, children }: { row: PickerRow; heading?: string; children: ReactNode }) {
  return (
    <>
      {heading && (
        <h3 className="picker-group" aria-hidden="true">
          {heading}
        </h3>
      )}
      <div
        role="row"
        style={row.action ? ({ '--actions': 1 } as CSSProperties) : undefined}
        {...row.row}
        className={`row picker-row ${row.className ?? ''}`.trim()}
        data-key={row.key}
      >
        {children}
      </div>
    </>
  );
}
/** An alert above a page's results. */
export function Notice({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="notice" role="alert">
      <Icon name="alert" />
      <div className="notice-body">
        {title && <div className="notice-title">{title}</div>}
        <p className="notice-message">{children}</p>
      </div>
    </div>
  );
}
