import type { ReactNode } from 'react';
import { browserSessionName } from '../shared';
import { Icon, IconButton, colorStyle } from './ui';
import { store, select, showConnect, connectionOf, terminalName, activeTab, sessionColor, statusText, openTerminal, openBrowserTab, openApplication, reconnect } from './store';
import { openSettings } from './settings';
import { openDetails } from './details';

/** What each page that belongs to no connection's items is called, in the bar over the view and on the page itself. */
export const pageName = { connect: 'Connect', remote: 'Remote Sessions' } as const;
/** What is in view: the selected terminal or browser session, the connection that owns it, and the item whose status describes it. */
export function viewContext() {
  const selection = store.selection;
  const terminal =
    selection?.kind === 'terminal' ? store.state.terminals.find((t) => t.id === selection.id) : undefined;
  const workspace =
    selection?.kind === 'browser' ? store.state.workspaces.find((w) => w.id === selection.id) : undefined;
  const owner = connectionOf(
    terminal?.connectionId ?? workspace?.connectionId ?? (selection?.kind === 'connection' || selection?.kind === 'remote' ? selection.id : ''),
  );
  const name = terminal
    ? terminalName(terminal)
    : workspace
      // An application fills its session with one tab and shows no session row, so its tab names the session.
      ? (workspace.application && activeTab(workspace)?.title) || browserSessionName(workspace)
      : selection?.kind === 'remote'
        ? pageName.remote
        : selection?.kind === 'connect'
          ? pageName.connect
          : '';
  const source = owner?.status === 'connecting' || !terminal ? owner : terminal;
  return { terminal, workspace, owner, name, source };
}
export function Brand() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="6.5" fill="var(--brand-plate)" />
      <path d="M8 9V5h4v3h2V5h4v3h2V5h4v4l-2 3v10l-6 6-6-6V12Z" fill="var(--brand-tower)" />
      <path d="M10 12h12M10 22h12" fill="none" stroke="var(--brand-glyph)" strokeWidth="1.5" />
      <path d="M13 14v5m6-5v5" stroke="var(--brand-glyph)" strokeWidth="2" />
    </svg>
  );
}
/** The brand's mark as the way to the home page, which is current while nothing is selected; `children` follow the mark. */
export function HomeButton({ children }: { children?: ReactNode }) {
  return (
    <button
      type="button"
      className="home-button"
      aria-label="Home"
      title="Home"
      aria-current={store.selection ? undefined : 'page'}
      onClick={() => select(undefined)}
    >
      <Brand />
      {children}
    </button>
  );
}
/** The window's title, which names what is in view. */
export function windowTitle() {
  const { owner, name } = viewContext();
  if (owner) return `${owner.label}${name ? ` · ${name}` : ''} — Bartizan`;
  return name ? `${name} — Bartizan` : 'Bartizan';
}
/**
 * Names what is in view and labels the view; every theme shows it once while a connection is in view, and for a page of
 * its own, such as Connect, it names the page alone, without a connection's status.
 */
export function ContextTitle() {
  const { workspace, owner, name, source } = viewContext();
  return (
    <>
      <span className="titlebar-marker" role="img" aria-label={source && statusText(source)} hidden={!owner} style={colorStyle(workspace && sessionColor(workspace))}>
        {workspace ? <Icon name="window" /> : <span className="status-dot" data-status={source?.status} />}
      </span>
      <div className="titlebar-titles" hidden={!owner && !name}>
        <h1 className="titlebar-heading" id="view-title">
          <span className="titlebar-group" hidden={!owner}>
            {owner?.label}
          </span>
          <span className="titlebar-item" hidden={!name}>
            {name}
          </span>
        </h1>
      </div>
    </>
  );
}
/** What the connection in view can open, and its details. */
export function ContextActions() {
  const { workspace, owner } = viewContext();
  return (
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
        icon="code"
        label="Visual Studio Code"
        hidden={!store.state.capabilities.embeddedBrowser || owner?.status !== 'connected'}
        onClick={() => owner && void openApplication(owner.id, 'vscode')}
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
  );
}
export function AppActions() {
  return <IconButton icon="settings" label="Settings" aria-haspopup="dialog" onClick={openSettings} />;
}
/** The way to the Connect page, which is current while that page is in view. */
export function NewConnectionButton() {
  return (
    <IconButton
      icon="plus"
      label="New Connection"
      aria-current={store.selection?.kind === 'connect' ? 'page' : undefined}
      onClick={showConnect}
    />
  );
}
