import { useLayoutEffect } from 'react';
import { browserSessionName } from '../shared';
import { Icon, IconButton, colorStyle } from './ui';
import {
  store,
  connectionOf,
  endpoint,
  terminalName,
  sessionColor,
  statusText,
  openTerminal,
  openBrowserTab,
  reconnect,
} from './store';
import { openSettings } from './settings';
import { openProfiles } from './profiles';
import { openDetails } from './details';

export function Titlebar() {
  const selection = store.selection;
  const terminal =
    selection?.kind === 'terminal' ? store.state.terminals.find((t) => t.id === selection.id) : undefined;
  const workspace =
    selection?.kind === 'browser' ? store.state.workspaces.find((w) => w.id === selection.id) : undefined;
  const owner = connectionOf(
    terminal?.connectionId ?? workspace?.connectionId ?? (selection?.kind === 'connection' ? selection.id : ''),
  );
  const name = terminal ? terminalName(terminal) : workspace ? browserSessionName(workspace) : '';
  useLayoutEffect(() => {
    document.title = owner ? `${owner.label}${name ? ` · ${name}` : ''} — Bartizan` : 'Bartizan';
  });
  const source = owner?.status === 'connecting' || !terminal ? owner : terminal;
  return (
    <header className="titlebar">
      <div className="titlebar-start">
        <svg className="brand-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" focusable="false">
          <rect width="32" height="32" rx="6.5" fill="var(--brand-plate)" />
          <path d="M8 9V5h4v3h2V5h4v3h2V5h4v4l-2 3v10l-6 6-6-6V12Z" fill="var(--brand-tower)" />
          <path d="M10 12h12M10 22h12" fill="none" stroke="var(--brand-glyph)" strokeWidth="1.5" />
          <path d="M13 14v5m6-5v5" stroke="var(--brand-glyph)" strokeWidth="2" />
        </svg>
        <span className="brand-name">Bartizan</span>
      </div>
      <div className="titlebar-context">
        <span className="titlebar-marker" hidden={!owner} style={colorStyle(workspace && sessionColor(workspace))}>
          {workspace ? (
            <Icon name="window" />
          ) : (
            <span className="status-dot" data-status={source?.status} />
          )}
        </span>
        <div className="titlebar-titles" hidden={!owner}>
          <h1 className="titlebar-heading" id="view-title">
            <span className="titlebar-group">{owner?.label}</span>
            <span className="titlebar-item" hidden={!name}>
              {name}
            </span>
          </h1>
          <span className="titlebar-subtitle mono">
            {owner &&
              source &&
              (source.status === 'connected' ? endpoint(owner) : `${statusText(source)} · ${endpoint(owner)}`)}
          </span>
        </div>
        <div className="titlebar-actions" hidden={!owner}>
          <IconButton
            icon="terminal"
            label="New Terminal"
            hidden={owner?.status !== 'connected'}
            onClick={() => owner && void openTerminal(owner.id)}
          />
          <IconButton
            icon="window"
            label="New Browser Tab"
            hidden={!store.state.capabilities.embeddedBrowser || owner?.status !== 'connected'}
            onClick={() => owner && void openBrowserTab(owner.id, workspace?.id)}
          />
          <IconButton
            icon="reload"
            label="Reconnect"
            hidden={owner?.status !== 'closed'}
            onClick={() => owner && void reconnect(owner.id)}
          />
          <IconButton
            icon="info"
            label="Connection Details"
            aria-haspopup="dialog"
            onClick={() => owner && void openDetails(owner.id)}
          />
        </div>
      </div>
      <div className="titlebar-end">
        <IconButton icon="profiles" label="Profiles" aria-haspopup="dialog" onClick={openProfiles} />
        <IconButton icon="settings" label="Settings" aria-haspopup="dialog" onClick={openSettings} />
      </div>
    </header>
  );
}
