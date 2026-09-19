import { useLayoutEffect, useRef } from 'react';
import type { Theme } from '..';
import { HomeButton, ContextTitle, ContextActions, AppActions, NewConnectionButton } from '../../chrome';
import { NavGroup, ConnectionChips, ConnectionItems, ConnectionName, ConnectionTools } from '../../nav';
import { Connect } from '../../connect';
import { ErrorsButton } from '../../errors';
import { Tags } from '../../ui';
import { groups, currentConnection } from '../../store';
import './style.css';

/** Brings the entry a list marks as current into view whenever another entry becomes the current one or the list is new. */
function useReveal(selector: string) {
  const list = useRef<HTMLElement>(null),
    revealed = useRef<{ list?: HTMLElement; id?: string }>({});
  useLayoutEffect(() => {
    const current = list.current?.querySelector<HTMLElement>(selector);
    if (list.current === revealed.current.list && current?.dataset.id === revealed.current.id) return;
    revealed.current = { list: list.current ?? undefined, id: current?.dataset.id };
    current?.scrollIntoView({ block: 'nearest' });
  });
  return list;
}
/**
 * A rail down the window's left edge of Home and every connection, a panel beside it for the connection in view, and a
 * slim bar over the view that names what it shows. The home page has no panel; Connect joins it there.
 */
function Chrome() {
  const current = groups().find(({ connection }) => connection.id === currentConnection());
  const connection = current?.connection;
  const rail = useReveal('.rail-connections [aria-current="true"]'),
    panel = useReveal('.rail-panel-scroll [aria-current="page"]');
  return (
    <>
      <nav ref={rail} className="rail" aria-label="Connections">
        <NavGroup name="rail" className="rail-nav">
          <div className="rail-brand">
            <HomeButton />
          </div>
          <div className="rail-connections">
            <ConnectionChips current={connection?.id} />
          </div>
        </NavGroup>
        <div className="rail-new">
          <NewConnectionButton />
        </div>
        <div className="rail-actions">
          <ErrorsButton />
          <AppActions />
        </div>
      </nav>
      {current && connection && (
        <nav ref={panel} className="rail-panel" aria-label="Current Connection">
          <NavGroup name="panel" className="rail-panel-nav">
            <header className="rail-panel-head" data-status={connection.status}>
              <div className="rail-panel-title">
                <ConnectionName connection={connection} />
                <ConnectionTools connection={connection} />
              </div>
              {!!current.profile?.tags.length && (
                <div className="rail-panel-meta">
                  <Tags tags={current.profile.tags} />
                </div>
              )}
            </header>
            <div className="rail-panel-scroll">
              <ConnectionItems group={current} />
            </div>
          </NavGroup>
          <div className="rail-panel-footer">
            <Connect />
          </div>
        </nav>
      )}
      <header className="rail-topbar">
        <div className="rail-topbar-context">
          <ContextTitle />
        </div>
        <ContextActions />
      </header>
    </>
  );
}

export const rail: Theme = {
  Chrome,
  Preview: () => (
    <svg viewBox="0 0 64 44" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="63" height="43" rx="4" fill="var(--preview-surface)" stroke="var(--preview-line)" />
      <path d="M10.5 0.5v43M26.5 0.5v43M10.5 8.5h53" stroke="var(--preview-line)" />
      <rect x="3" y="3.5" width="5" height="5" rx="1.75" fill="var(--preview-accent)" />
      <path d="M1 4.5v3" stroke="var(--preview-accent)" strokeLinecap="round" />
      <rect x="3" y="11.5" width="5" height="5" rx="1.75" fill="var(--preview-ink)" />
      <rect x="3" y="19.5" width="5" height="5" rx="1.75" fill="var(--preview-ink)" />
      <rect x="3.5" y="28" width="4" height="4" rx="1.25" fill="none" stroke="var(--preview-ink)" />
      <path d="M14 5h7M14 13h9M14 17h8M16 21h7M16 25h6M14 29h9" stroke="var(--preview-ink)" strokeLinecap="round" />
      <rect x="13.5" y="36" width="10" height="4" rx="1.5" fill="none" stroke="var(--preview-line)" />
    </svg>
  ),
  terminal: {
    dark: {
      background: '#1a1c23',
      foreground: '#d9dbe6',
      cursor: '#5e9ef7',
      cursorAccent: '#1a1c23',
      selectionBackground: 'rgba(94, 158, 247, 0.32)',
      scrollbarSliderBackground: 'rgba(216, 228, 255, 0.18)',
      scrollbarSliderHoverBackground: 'rgba(216, 228, 255, 0.3)',
      scrollbarSliderActiveBackground: 'rgba(216, 228, 255, 0.4)',
      black: '#262934',
      red: '#f0717a',
      green: '#5fd39a',
      yellow: '#e5b96a',
      blue: '#7aa7f7',
      magenta: '#d48ff0',
      cyan: '#5cc8d6',
      white: '#c4c7d4',
      brightBlack: '#6c7184',
      brightRed: '#f78f96',
      brightGreen: '#84e0b0',
      brightYellow: '#f0cf8d',
      brightBlue: '#9dbffa',
      brightMagenta: '#e2adf6',
      brightCyan: '#85d9e4',
      brightWhite: '#f4f5f9',
    },
    light: {
      background: '#fcfcfd',
      foreground: '#1b1d26',
      cursor: '#2563eb',
      cursorAccent: '#fcfcfd',
      selectionBackground: 'rgba(37, 99, 235, 0.2)',
      scrollbarSliderBackground: 'rgba(20, 28, 56, 0.22)',
      scrollbarSliderHoverBackground: 'rgba(20, 28, 56, 0.34)',
      scrollbarSliderActiveBackground: 'rgba(20, 28, 56, 0.46)',
      black: '#2a2c38',
      red: '#c4314b',
      green: '#1f7d4d',
      yellow: '#8a6200',
      blue: '#2b5fd0',
      magenta: '#a03fb5',
      cyan: '#11757f',
      white: '#5f6375',
      brightBlack: '#4d5163',
      brightRed: '#b3243f',
      brightGreen: '#166c40',
      brightYellow: '#7a5600',
      brightBlue: '#2450b8',
      brightMagenta: '#8c2fa3',
      brightCyan: '#0c6670',
      brightWhite: '#2f323e',
    },
  },
};
