import { useLayoutEffect } from 'react';
import { formatBytes, type Download, type Workspace } from '../shared';
import { Icon, IconButton, Button } from './ui';
import { api, run, render } from './store';
import { Overlay } from './overlay';

/** The browser session whose downloads are showing. */
let shown: string | undefined;
let button: HTMLButtonElement | null = null;
function toggle(workspaceId?: string) {
  shown = shown === workspaceId ? undefined : workspaceId;
  render();
}
/** Closes the list and returns focus to its button. */
function dismiss() {
  if (!shown) return;
  toggle();
  button?.focus();
}
const status = (item: Download) =>
  item.state === 'progressing'
    ? item.total
      ? `${formatBytes(item.received)} / ${formatBytes(item.total)}`
      : formatBytes(item.received)
    : item.state === 'completed'
      ? formatBytes(item.total || item.received)
      : item.state === 'cancelled'
        ? 'Cancelled'
        : 'Failed';

/** Appears once the session has downloads, and fills as the running ones progress. */
export function DownloadsButton({ workspace }: { workspace: Workspace }) {
  const running = workspace.downloads.filter((item) => item.state === 'progressing');
  const total = running.reduce((sum, item) => sum + item.total, 0),
    received = running.reduce((sum, item) => sum + item.received, 0);
  return (
    <button
      ref={(node) => {
        button = node;
      }}
      type="button"
      className="icon-button downloads-button"
      aria-label="Downloads"
      title="Downloads"
      aria-haspopup="dialog"
      aria-expanded={shown === workspace.id}
      hidden={!workspace.downloads.length}
      data-running={running.length > 0 || undefined}
      onClick={() => toggle(workspace.id)}
    >
      <Icon name="download" />
      {running.length > 0 && (
        <progress className="downloads-progress" aria-label="Download Progress" max={total || undefined} value={total ? received : undefined} />
      )}
    </button>
  );
}
/** The session's downloads, drawn over the page below their button. */
export function DownloadsPopover({ workspace }: { workspace: Workspace }) {
  const open = shown === workspace.id && workspace.downloads.length > 0;
  // The list closes with the session it belongs to, and when another session takes its place.
  useLayoutEffect(
    () => () => {
      if (shown === workspace.id) shown = undefined;
    },
    [workspace.id],
  );
  const act = (action: 'cancel' | 'show' | 'clear', id?: string) =>
    void run('browser', api.download(workspace.id, action, id), workspace.connectionId);
  return (
    <Overlay
      name="popover"
      onLeave={() => shown && toggle()}
      place={(size) => {
        const anchor = button?.getBoundingClientRect();
        return open && anchor?.width ? { x: anchor.right - size.width + 16, y: anchor.bottom, ...size } : undefined;
      }}
    >
      {open && (
        <section
          className="popover downloads"
          role="dialog"
          aria-label="Downloads"
          onKeyDown={(event) => {
            if (event.key === 'Escape') dismiss();
          }}
        >
          <ul className="download-list">
            {workspace.downloads.map((item) => (
              <li key={item.id} className="download" data-state={item.state}>
                <div className="download-titles">
                  <span className="download-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="download-status">{status(item)}</span>
                  {item.state === 'progressing' && (
                    <progress className="download-progress" aria-label={item.name} max={item.total || undefined} value={item.total ? item.received : undefined} />
                  )}
                </div>
                {item.state === 'progressing' && (
                  <IconButton icon="close" label={`Cancel ${item.name}`} title="Cancel" onClick={() => act('cancel', item.id)} />
                )}
                {item.state === 'completed' && (
                  <IconButton icon="folder" label={`Show ${item.name} in Folder`} title="Show in Folder" onClick={() => act('show', item.id)} />
                )}
              </li>
            ))}
          </ul>
          <footer className="popover-actions" hidden={workspace.downloads.every((item) => item.state === 'progressing')}>
            <Button className="ghost" onClick={() => act('clear')}>
              Clear
            </Button>
          </footer>
        </section>
      )}
    </Overlay>
  );
}
// A press anywhere else in the application, or Escape, closes the list.
addEventListener('pointerdown', (event) => {
  if (shown && !button?.contains(event.target as Node)) toggle();
}, true);
addEventListener('keydown', (event) => {
  if (shown && event.key === 'Escape') {
    event.preventDefault();
    dismiss();
  }
}, true);
