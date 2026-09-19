import type { Theme } from '..';
import { IconButton } from '../../ui';
import { groups, currentConnection, statusText } from '../../store';
import { HomeButton, ContextTitle, AppActions, NewConnectionButton } from '../../chrome';
import { NavGroup, ConnectionChips, ConnectionItems, ConnectionTools } from '../../nav';
import { ErrorsButton } from '../../errors';
import { openDetails } from '../../details';
import { Strip } from './strip';
import './style.css';

/**
 * Two tiers across the window and no side panel. The title tier, which moves the window, holds Home and every
 * connection as a pill beside the application's commands. The tab tier holds the items of the connection in view as
 * tabs: a terminal is a tab and a browser session is a group of tabs. The end of the tab tier shows the connection's
 * status for a browser session, as a terminal's does. The home page has no tab tier.
 */
function Chrome() {
  const all = groups();
  const current = all.find(({ connection }) => connection.id === currentConnection());
  return (
    <>
      <header className="tabs-title">
        <HomeButton>
          <span className="tabs-wordmark" hidden={all.length > 0}>
            Bartizan
          </span>
        </HomeButton>
        {all.length > 0 && (
          <Strip className="tabs-connections" label="Connections">
            <NavGroup name="connections" className="tabs-connections-list">
              <ConnectionChips current={current?.connection.id} />
            </NavGroup>
          </Strip>
        )}
        <NewConnectionButton />
        <span className="tabs-gap" />
        <ErrorsButton />
        <AppActions />
      </header>
      {current && (
        <div className="tabs-tier">
          <Strip className="tabs-strip" label={current.connection.label} fit>
            <NavGroup name="items" className="tabs-items">
              <ConnectionItems group={current} />
            </NavGroup>
          </Strip>
          <div className="tabs-trail">
            <div className="tabs-context">
              <span className="status-dot tabs-status" role="img" aria-label={statusText(current.connection)} data-status={current.connection.status} />
              <ContextTitle />
            </div>
            <ConnectionTools connection={current.connection} />
            <IconButton
              icon="info"
              label="Connection Details"
              aria-haspopup="dialog"
              onClick={() => void openDetails(current.connection.id)}
            />
          </div>
        </div>
      )}
    </>
  );
}
export const tabs: Theme = {
  Chrome,
  Preview: () => (
    <svg viewBox="0 0 64 44" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="63" height="43" rx="4" fill="var(--preview-surface)" stroke="var(--preview-line)" />
      <rect x="4" y="3.5" width="5" height="5" rx="1.5" fill="var(--preview-accent)" />
      <path d="M13 6h8M25 6h6M44 6h16" stroke="var(--preview-ink)" strokeLinecap="round" />
      <path d="M0.5 19.5H4a2 2 0 0 0 2-2V14a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3.500a2 2 0 0 0 2 2h39.5" fill="none" stroke="var(--preview-line)" />
      <path d="M9 12h10" stroke="var(--preview-accent)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 16h8M28 16h8M42 16h8" stroke="var(--preview-ink)" strokeLinecap="round" />
    </svg>
  ),
  terminal: {
    dark: {
      background: '#1c1917',
      foreground: '#e7e0d8',
      cursor: '#e8793f',
      cursorAccent: '#1c1917',
      selectionBackground: 'rgba(232, 121, 63, 0.28)',
      scrollbarSliderBackground: 'rgba(231, 214, 196, 0.36)',
      scrollbarSliderHoverBackground: 'rgba(231, 214, 196, 0.5)',
      scrollbarSliderActiveBackground: 'rgba(231, 214, 196, 0.62)',
      black: '#4a433c',
      red: '#e0736a',
      green: '#9bbf7a',
      yellow: '#deb765',
      blue: '#82abd9',
      magenta: '#c495cf',
      cyan: '#78c1b5',
      white: '#cfc6bb',
      brightBlack: '#8a8076',
      brightRed: '#ee8f86',
      brightGreen: '#b2d391',
      brightYellow: '#ebcb85',
      brightBlue: '#9dc0e8',
      brightMagenta: '#d6aee0',
      brightCyan: '#93d4c9',
      brightWhite: '#f7f2ec',
    },
    light: {
      background: '#faf8f5',
      foreground: '#2b2622',
      cursor: '#c2410c',
      cursorAccent: '#faf8f5',
      selectionBackground: 'rgba(194, 65, 12, 0.18)',
      scrollbarSliderBackground: 'rgba(87, 70, 54, 0.5)',
      scrollbarSliderHoverBackground: 'rgba(87, 70, 54, 0.66)',
      scrollbarSliderActiveBackground: 'rgba(87, 70, 54, 0.8)',
      black: '#2b2622',
      red: '#b3362b',
      green: '#4a7a2c',
      yellow: '#946200',
      blue: '#2c64a3',
      magenta: '#8b4a97',
      cyan: '#1b7874',
      white: '#7a7167',
      brightBlack: '#6b6259',
      brightRed: '#c2402d',
      brightGreen: '#457527',
      brightYellow: '#8f6100',
      brightBlue: '#336fb0',
      brightMagenta: '#9652a3',
      brightCyan: '#1a7470',
      brightWhite: '#453e37',
    },
  },
};
