[Documentation](README.md) · [Project home](../README.md)

# Architecture

Bartizan has one Electron application window containing a React sidebar and either an xterm terminal or a native browser view. The main process owns connections, PTYs, browser sessions, credentials and configuration writes.

## Source map

| Location | Responsibility |
| --- | --- |
| [`src/main/main.ts`](../src/main/main.ts) | Startup, window lifecycle, IPC validation and state publication |
| [`src/main/sessions.ts`](../src/main/sessions.ts) | SSH master processes and terminal PTYs |
| [`src/main/browser.ts`](../src/main/browser.ts) | Browser partitions, tabs, page tools, downloads and HTTP authentication |
| [`src/main/overlays.ts`](../src/main/overlays.ts) | Views for interface drawn above pages |
| [`src/main/certificates.ts`](../src/main/certificates.ts) | TLS warnings and temporary certificate approvals |
| [`src/main/askpass.ts`](../src/main/askpass.ts) | OpenSSH authentication prompts and configured credentials |
| [`src/core/`](../src/core/) | Configuration schemas, profile persistence, SSH arguments and TCP relay |
| [`src/renderer/`](../src/renderer/) | React UI, selection, sidebar ordering and terminal rendering |
| [`src/shared.ts`](../src/shared.ts) | Shared state, events and preload API types |

## State and process boundaries

The application renderer is sandboxed and context-isolated with Node integration disabled. Its [preload](../src/main/preload.ts) exposes a fixed API through `contextBridge`. The main process accepts IPC only from the application window's main frame at its bundled page URL, then validates request arguments.

The main process publishes state snapshots and separate terminal data events. Tab icons, find results and the address of a hovered link also arrive as events of their own. The renderer's [store](../src/renderer/store.ts) handles selection and sidebar order, and notifies React through `useSyncExternalStore`. Sidebar order is stored in `sessionStorage`. Terminal titles are renderer state.

Browser tabs use sandboxed `WebContentsView` instances without a preload or Node integration. The renderer reports the browser area's bounds to the main process, which positions the selected native view. Modal dialogs and overlapping Connect results hide the view so that native page content does not cover app controls.

Interface that floats over a page, such as the downloads list and a hovered link's address, is drawn in an overlay: a transparent `WebContentsView` above the page views. The renderer opens each overlay as a named blank child window. The [main process](../src/main/overlays.ts) makes that window a view inside the application window and denies every other `window.open`. The child shares the renderer's process, so the [renderer](../src/renderer/overlay.tsx) copies its styles into the overlay's document and renders into it through a React portal. An overlay has no preload and cannot navigate. It is sized to its content, so the page around it keeps receiving input, and its top left corner stays fixed while it resizes, because a view that moves as it resizes shows one frame out of place.

## SSH transport

Each connection starts one OpenSSH master with `-M -N` and a private control socket. The master opens a SOCKS forward on a loopback port. A successful `ssh -O check` probe marks the connection ready.

Each terminal runs another `ssh` process in a `node-pty` pseudo-terminal and uses the master's control socket. `ControlMaster=no` and `ProxyCommand=/bin/false` prevent that terminal from silently opening an independent transport when the master is missing.

[SSH argument generation](../src/core/ssh.ts) uses `-F none`, explicit authentication settings and Bartizan's own trust store. Authentication prompts go through an askpass helper to a private Unix socket. The broker supplies a configured credential once for each recognized password/passphrase kind and sends remaining prompts to the UI.

Pinned connections use an OpenSSH `KnownHostsCommand` helper. It validates the offered public host key against the configured SHA-256 fingerprints and rejects host certificates.

## Browser routing and storage

Each browser session owns an in-memory Electron partition and a [TCP relay](../src/core/relay.ts). The partition uses that relay as a fixed SOCKS5 proxy, including loopback destinations. The relay forwards to the connection's SSH SOCKS port. Tabs in the session share the partition; other sessions receive separate partitions.

Disconnecting removes the relay target, destroys its sockets and enables offline network emulation. Reconnecting points the relay at the new SSH SOCKS port and restores network access. Non-proxied WebRTC UDP is disabled. Browser permission handlers deny website permission requests.

Browser shortcuts come in two kinds. The application takes its own, such as the address field's, from a page's input before the page sees the key. The rest, such as find and reload, are accelerators of a hidden application menu, which receive a key only after the page, or the application's own page, has left it alone.

The main process fetches a tab's icon through the tab's session, so the request takes the same route as the page, and passes it to the renderer as a size-limited data URL. The renderer never loads a remote image. A tab's developer tools open in a second view docked beside the page. That view uses the tab's session too, so requests the tools make also pass through SSH.

Closing a session cancels downloads and authentication prompts, closes its views and relay, and clears authentication, storage and cache data. Certificate approvals belong to the live session and are also cleared when the connection ends.

## Configuration writes

[Configuration parsing](../src/core/config.ts) uses `yaml` and strict Zod schemas. Effective connection settings merge built-ins, shared defaults and profile values. Relative file paths resolve against the configuration file.

[Profile persistence](../src/core/profiles.ts) edits the parsed YAML document rather than serializing only a new configuration object. A draft records the file contents and resolved target. Saving checks that both still match before atomically replacing the target, preserving symlinks and file permissions.

Literal passwords and passphrases are redacted from state sent to the renderer. Credential files are read by the main process when needed for a prompt.

## Terminal rendering and shutdown

[Terminals](../src/renderer/terminals.tsx) use xterm with font loading, a fit addon, web links and a ligature joiner. WebGL is preferred; initialization failure or unrecoverable context loss falls back to DOM rendering.

Closing the application window stops SSH sessions, closes the askpass broker and shuts down browser sessions. A second launch focuses the existing instance. The test rig selects a separate application data directory to run independently.

See [Development](development.md) for the build, test and package commands.
