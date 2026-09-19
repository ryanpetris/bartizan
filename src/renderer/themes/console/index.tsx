import { useInsertionEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Theme } from '..';
import { HomeButton, ContextTitle, ContextActions, AppActions, NewConnectionButton } from '../../chrome';
import { NavGroup, ConnectionItems, ConnectionChips, ConnectionTools } from '../../nav';
import { ErrorsButton } from '../../errors';
import { hoveredLink } from '../../browser';
import { terminalFontFamily } from '../../fonts';
import { store, groups, currentConnection } from '../../store';
import './style.css';

/**
 * A list along a line. It scrolls sideways without a scroll bar: the wheel moves it, its ends are marked while more
 * lies beyond them, and the current item is brought into view when it changes.
 */
function Strip({ name, children }: { name: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null),
    sizes = useRef<ResizeObserver | undefined>(undefined),
    revealed = useRef<string | undefined>(undefined);
  const scroller = () => box.current!.firstElementChild as HTMLElement;
  const measure = () => {
    const list = scroller();
    box.current!.toggleAttribute('data-more-before', list.scrollLeft > 0);
    box.current!.toggleAttribute('data-more-after', list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  };
  useLayoutEffect(() => {
    const list = scroller();
    const wheel = (event: WheelEvent) => {
      if (event.deltaX || !event.deltaY || event.ctrlKey || list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    list.addEventListener('scroll', measure, { passive: true });
    list.addEventListener('wheel', wheel, { passive: false });
    void document.fonts.ready.then(() => box.current && measure());
    return () => {
      list.removeEventListener('scroll', measure);
      list.removeEventListener('wheel', wheel);
    };
  }, []);
  // The list's width and its content's are watched: either changing moves the ends.
  useLayoutEffect(() => {
    const list = scroller();
    sizes.current ??= new ResizeObserver(measure);
    sizes.current.disconnect();
    for (const element of [list, ...list.children]) sizes.current.observe(element);
  });
  useLayoutEffect(() => () => sizes.current?.disconnect(), []);
  useLayoutEffect(() => {
    const list = scroller();
    const current = list.querySelector<HTMLElement>('[aria-current="page"]') ?? list.querySelector<HTMLElement>('[aria-current="true"]');
    if (current?.dataset.id !== revealed.current) {
      revealed.current = current?.dataset.id;
      current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    measure();
  });
  return (
    <div
      ref={box}
      className="console-strip"
      onFocus={(event) => {
        if (event.target.matches(':focus-visible')) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}
    >
      <NavGroup name={name} className="console-scroll">
        {children}
      </NavGroup>
    </div>
  );
}
/**
 * Three lines of text around the view, as a terminal multiplexer draws them: a title line of Home and what is in view,
 * and below the view a line of the windows of the connection in view over a status line of connections, the hovered
 * link's address and the application's commands. The home page has no windows line. The lines are set in the
 * configured terminal font, so that they and a terminal read as one.
 */
function Chrome() {
  const all = groups(),
    current = currentConnection(),
    font = store.state.settings.terminalFont;
  useInsertionEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--console-font', terminalFontFamily(font));
    return () => void root.style.removeProperty('--console-font');
  }, [font]);
  const selected = all.find((group) => group.connection.id === current);
  return (
    <>
      <header className="console-title">
        <div className="console-brand">
          <HomeButton>
            <span className="console-wordmark">Bartizan</span>
          </HomeButton>
        </div>
        <div className="console-context">
          <ContextTitle />
          <ContextActions />
        </div>
      </header>
      <nav className="console-windows" aria-label={selected?.connection.label} hidden={!selected}>
        <Strip name="windows">{selected && <ConnectionItems group={selected} />}</Strip>
        {selected && <ConnectionTools connection={selected.connection} />}
      </nav>
      <footer className="console-status">
        <div className="console-places">
          <nav className="console-connections" aria-label="Connections">
            <Strip name="connections">
              <ConnectionChips current={selected?.connection.id} />
            </Strip>
            <p className="console-empty" hidden={all.length > 0}>
              No Connections
            </p>
          </nav>
          <span className="console-link">{hoveredLink()}</span>
        </div>
        <div className="console-new">
          <NewConnectionButton />
        </div>
        <div className="console-app">
          <ErrorsButton />
          <AppActions />
        </div>
      </footer>
    </>
  );
}
export const consoleTheme: Theme = {
  Chrome,
  Preview: () => (
    <svg viewBox="0 0 64 44" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="63" height="43" rx="1.5" fill="var(--preview-surface)" stroke="var(--preview-line)" />
      <path d="M0.5 7.5h63M0.5 31.5h63M0.5 37.5h63" stroke="var(--preview-line)" />
      <path d="M4 4h7" stroke="var(--preview-accent)" strokeWidth="1.5" />
      <path d="M14 4h16M4 13h22M4 17h15M4 21h26M4 25h11M4 34.5h7M24 34.5h8M35 34.5h10M13 40.5h8M24 40.5h6M44 40.5h16" stroke="var(--preview-ink)" />
      <rect x="13" y="32.5" width="9" height="4" fill="var(--preview-accent)" />
      <rect x="3" y="39" width="8" height="3" fill="var(--preview-accent)" />
    </svg>
  ),
  terminal: {
    dark: {
      background: '#0b0f0d',
      foreground: '#c3d2c8',
      cursor: '#4ade80',
      cursorAccent: '#0b0f0d',
      selectionBackground: 'rgba(74, 222, 128, 0.28)',
      scrollbarSliderBackground: '#4a6b58',
      scrollbarSliderHoverBackground: '#5d8570',
      scrollbarSliderActiveBackground: '#4ade80',
      black: '#16201a',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#6cb2f7',
      magenta: '#c49bf5',
      cyan: '#3fd3c0',
      white: '#c3d2c8',
      brightBlack: '#708378',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fcd34d',
      brightBlue: '#9ccbfa',
      brightMagenta: '#d9bcf9',
      brightCyan: '#7ce6d8',
      brightWhite: '#f0fbf3',
    },
    light: {
      background: '#f3efe3',
      foreground: '#2b2a24',
      cursor: '#17603a',
      cursorAccent: '#f3efe3',
      selectionBackground: 'rgba(23, 96, 58, 0.22)',
      scrollbarSliderBackground: '#8f866e',
      scrollbarSliderHoverBackground: '#766e58',
      scrollbarSliderActiveBackground: '#17603a',
      black: '#2b2a24',
      red: '#a8281e',
      green: '#1d6b3a',
      yellow: '#855700',
      blue: '#1f57a8',
      magenta: '#863a94',
      cyan: '#0f6b72',
      white: '#676251',
      brightBlack: '#565243',
      brightRed: '#c2362a',
      brightGreen: '#207844',
      brightYellow: '#8f5f00',
      brightBlue: '#2a6bc4',
      brightMagenta: '#9f48ae',
      brightCyan: '#10747b',
      brightWhite: '#3b392f',
    },
  },
};
