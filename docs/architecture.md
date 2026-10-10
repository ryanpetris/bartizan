[Documentation](README.md) · [Project home](../README.md)

# Architecture

Bartizan has one Electron application window containing a React interface around either an xterm terminal or a native browser view. The shared backend owns connections, PTYs, credentials and configuration writes. Electron adds embedded browser sessions; a standalone Node server serves the terminal UI in an ordinary browser.

## Source Map

| Location | Responsibility |
| --- | --- |
| [`src/backend/app.ts`](../src/backend/app.ts) | Shared operations, validation, configuration, SSH lifecycle and state publication |
| [`src/transport.ts`](../src/transport.ts), [`src/client.ts`](../src/client.ts) | Request/response envelopes, transport interface and typed client API |
| [`src/main/main.ts`](../src/main/main.ts) | Electron startup, window lifecycle, trusted IPC and platform operations |
| [`src/web/`](../src/web/) | HTTP assets, WebSocket transport and server CLI |
| [`src/renderer/web-api.ts`](../src/renderer/web-api.ts) | Browser transport, clipboard, menus and external links |
| [`src/main/sessions.ts`](../src/main/sessions.ts) | Connection registry and terminal request routing |
| [`src/main/connection.ts`](../src/main/connection.ts) | Persistent connection controller, effective configuration, helper and remote sessions |
| [`src/main/ssh-connection.ts`](../src/main/ssh-connection.ts), [`src/main/terminal.ts`](../src/main/terminal.ts) | One SSH transport attempt and one terminal tab |
| [`src/main/application-session.ts`](../src/main/application-session.ts) | One remote application launch and its browser session |
| [`src/main/browser.ts`](../src/main/browser.ts) | Browser-session collection belonging to one connection |
| [`src/main/browser-session.ts`](../src/main/browser-session.ts) | One browser partition, relay, downloads and authentication |
| [`src/main/browser-tab.ts`](../src/main/browser-tab.ts) | One browser tab, its page view, tools and favicon |
| [`src/main/browser-window.ts`](../src/main/browser-window.ts) | Window presentation and direct routing indexes |
| [`src/main/overlays.ts`](../src/main/overlays.ts) | Views for interface drawn above pages |
| [`src/main/menus.ts`](../src/main/menus.ts) | Menus the main process builds and the application draws |
| [`src/main/certificates.ts`](../src/main/certificates.ts) | TLS warnings and temporary certificate approvals |
| [`src/main/askpass.ts`](../src/main/askpass.ts) | OpenSSH authentication prompts and configured credentials |
| [`src/core/`](../src/core/) | Configuration schemas, profile persistence, SSH arguments and TCP relay |
| [`src/renderer/`](../src/renderer/) | React UI, selection, ordering and terminal rendering |
| [`src/themes/`](../src/themes/) | What both processes know of each theme |
| [`src/renderer/themes/`](../src/renderer/themes/) | Each theme's layout, styles, terminal colours and preview |
| [`src/shared.ts`](../src/shared.ts) | Shared state, events and preload API types |

## State and Process Boundaries

The application renderer is sandboxed and context-isolated with Node integration disabled. Its [preload](../src/main/preload.ts) exposes a fixed API through `contextBridge`. The main process accepts IPC only from the application window's main frame at its bundled page URL, then validates request arguments.

Both transports carry requests with an ID, method and argument array. Responses carry the matching ID and either a result or an error; events carry state snapshots or incremental updates. IPC validates the caller before dispatch; WebSocket validates its origin and request envelope before reaching the same handlers. The shared client maps the public API onto either transport. Fire-and-forget terminal input, resize and acknowledgement calls use the same request path.

Terminal output has flow control. The backend counts, for each attached client, the output of each terminal it has sent but the client has not acknowledged. A client is the Electron window's page, counted afresh each time it loads and left out from the moment a new page replaces it until that page has loaded, and after its process has gone, or a web page, counted afresh each time its socket connects. The renderer acknowledges output in batches once xterm has parsed it, which it does for terminals not on show too, and acknowledges output it drops. A terminal's PTY pauses while every attached client is more than 256K characters behind on it, and resumes once one is within 64K, so output keeps pace with the fastest client and a slower one never holds the others back. A paused PTY reads on once its child exits, since node-pty discards unread output shortly afterwards. The web server disconnects a client more than 8M characters behind on output it has not processed, or with more than 8 MB still to be sent. The Electron window keeps its page's timers running while hidden. A browser runs a hidden page's timers rarely, so such a page acknowledges output as it arrives while at most 4M characters of a terminal's output awaits parsing. The web server pings each socket every 30 seconds and drops one that has not answered the previous ping. The page drops output for a terminal while more than 32M characters of it await parsing. When a web client reconnects, it sizes the terminal on show again, and each other terminal when next shown, so full-screen programs redraw. Output after dropped output, or after a web client reconnects, starts with a cancel character, so an escape sequence cut short does not swallow later output.

The web client reconnects a lost socket, waiting longer between attempts up to ten seconds. It names itself with a random identifier for the life of the page, so the backend keeps its profile draft for ten minutes after its last socket closes. The server sends it a fresh snapshot; terminals keep what they show and continue with live output, without replaying what was missed.

`window.bartizan.capabilities()` returns the running backend's capabilities, also included in state snapshots. `embeddedBrowser` controls browser-session actions; `nativeFilePicker` controls native file-picker buttons; `externalBrowser` says whether links can open in the system browser. Electron provides the first two, and the third where it finds a way to open links; the web server provides none. Unsupported backend operations reject even if a caller bypasses the UI. This API is available to future integrations without depending on a particular transport.

Web clients share one backend, while each client's profile form has its own draft. The backend serializes connection/configuration mutations. Shutdown rejects queued mutations, waits for the active one, and closes platform resources and SSH sessions.

The backend publishes state snapshots and separate terminal data events. Tab icons, find results and the address of a hovered link also arrive as events of their own. The renderer's [store](../src/renderer/store.ts) handles selection and navigation order, and notifies React through `useSyncExternalStore`. Navigation order is stored in `sessionStorage`, and each connection's order goes to the main process, which opens links in the browser session nearest the terminal or application they came from. Terminal titles are renderer state.

Browser tabs use sandboxed `WebContentsView` instances without a preload or Node integration. The renderer reports the browser area's bounds to the main process, which positions the selected native view. Dialogs open in the modal overlay, above the page. The main process's questions, whether to leave a page that asks before it is left or to open a link in another application, are such dialogs: the main process sends each to the renderer with an ID and waits for its answer. A question about a tab that closes is withdrawn, and one the renderer's page has gone or reloaded before answering, or whose window has closed, goes unanswered, which leaves the page open and the link unopened. A page that loads while questions wait asks them.

Interface that floats over a page, such as the downloads list and a hovered link's address, is drawn in an overlay: a transparent `WebContentsView` above the page views. The renderer opens each overlay as a named blank child window. The [main process](../src/main/overlays.ts) makes that window a view inside the application window and denies every other `window.open`. The child shares the renderer's process, so the [renderer](../src/renderer/overlay.tsx) copies its styles into the overlay's document and renders into it through a React portal. An overlay has no preload and cannot navigate. A floating overlay is sized to its content, so the page around it keeps receiving input, and its top left corner stays fixed while it resizes, because a view that moves as it resizes shows one frame out of place. The modal overlay holds dialogs instead: while one is open it covers the window below the title bar, so its backdrop dims the page and the application, and it takes the keyboard.

Menus, including a page's context menu, and the option lists of [selects](../src/renderer/select.tsx) are the application's own, drawn by a [popup](../src/renderer/popup.tsx) in the popup overlay, above the pages and dialogs, which takes the keyboard while one is open. A press outside one closes it: the application page and the popup overlay see their own presses, and the main process reports those in page views and other overlays. Over a dialog the overlay covers the dialog too, so such a press leaves the dialog alone. The main process builds the menus of pages, text fields and terminal links and keeps their actions; the renderer draws them at the point where they opened, a page's offset by its view, and reports the item chosen by the menu's ID, so only an item of the open menu runs. Before an item runs, the keyboard returns to the contents the menu opened for, so editing commands act on the field and selection it left. A question such as **Leave Page?** closes any open popup, so the question has the keyboard. The web client draws the same menus in its page, inside the dialog on top where one is open.

Tooltips are popups as well, drawn in the tooltip overlay above the popup overlay, which the main process never gives the keyboard; in the web client, in a layer of the page that lets the pointer through. A control gives its tooltip in a `data-tooltip` attribute, which the [renderer](../src/renderer/tooltip.tsx) watches for in its page and every overlay. A view above a page takes the pointer wherever it lies, so a tooltip keeps a gap from its control and goes as the pointer reaches it, whether it showed for the pointer or for keyboard focus. Focus counts only when a key moved it, not when the page moves it by itself or a popup that a key closed returns it to the control it opened from.

## Themes

A theme is a layout of the window, chosen in settings. Its [manifest](../src/themes/index.ts) holds what both processes need: its name, the way its lists run, where error notifications go, and the height and colours of the native window controls, which the main process applies to the title bar overlay. In the renderer a [theme](../src/renderer/themes/index.tsx) adds a component that draws the window around the selected view, terminal colours for both appearances and a preview for Settings. It can also move error notifications from where its manifest puts them while its layout leaves no room there, as Rail does beside its thin panel.

The theme's elements and the view are children of the application root. The document root's `data-theme` attribute names the theme; `data-appearance` selects its light or dark colors in both Electron and web clients. The base stylesheet supplies shared component styles. Each theme uses a `:root[data-theme]` selector to set its design tokens and grid and customize those shared components. The views stay mounted when the theme changes. Navigation, ordering, renaming and the commands of connections, terminals, browser sessions and tabs are [shared](../src/renderer/nav.tsx) by every theme, which arranges them with its styles; a theme brings components of its own only for what it shows differently.

A theme places error notifications inside the application page only beside a corner that no page view covers. Otherwise they are drawn in an overlay over the view. Web clients draw all notifications inside the application page, using the top-right corner for themes that use native overlays in Electron.

## SSH Transport

A connection controller lives until its connection entry is removed or the application shuts down. Disconnecting stops its transport, helper and terminal processes, ends application launches, and takes browser sessions offline. Terminal records, browser tabs and browser storage remain owned by that controller across reconnects. Each browser session and terminal tab owns its cleanup; a browser tab owns its native page and developer-tools views. Routing indexes point to these owners without assembling or searching application-wide resource lists.

Each connection starts one OpenSSH master with `-M -N` and a private control socket. The master opens a SOCKS forward on a loopback port. A successful `ssh -O check` probe marks the connection ready. Until then the master's error output, such as banners and authentication failures, appears in the terminal opened with the connection, or another live terminal when that one has closed. After that it is kept only for the error reported when the master fails, and a deliberate disconnect records no exit code.

Each terminal runs another `ssh` process in a `node-pty` pseudo-terminal and uses the master's control socket. `ControlMaster=no` and `ProxyCommand=/bin/false` prevent that terminal from silently opening an independent transport when the master is missing.

[SSH argument generation](../src/core/ssh.ts) uses `-F none`, explicit authentication settings and Bartizan's own trust store. Authentication prompts go through an askpass helper to a private Unix socket. The broker supplies a configured credential once for each recognized password/passphrase kind and sends remaining prompts to the UI.

Pinned connections use an OpenSSH `KnownHostsCommand` helper. It validates the offered public host key against the configured SHA-256 fingerprints and fingerprints derived from configured public keys and rejects host certificates.

## Browser Routing and Storage

Each browser session owns an in-memory Electron partition and a [TCP relay](../src/core/relay.ts). The partition uses that relay as a fixed SOCKS5 proxy, including loopback destinations. The relay forwards to the connection's SSH SOCKS port. Tabs in the session share the partition; other sessions receive separate partitions.

Disconnecting removes the relay target, destroys its sockets and enables offline network emulation. Reconnecting points the relay at the new SSH SOCKS port, restores network access and reloads each tab whose page failed to load for want of the route. Non-proxied WebRTC UDP is disabled. Browser permission handlers deny website permission requests, apart from fullscreen, pointer and keyboard lock and clipboard writes, and clipboard reads for application sessions, all for the page on show in the focused window.

A page's popup is created by Chromium and adopted as a tab of the page's session, so it keeps its opener. An application's session holds one tab, so its popups open in an ordinary session of the connection instead; a blank one is kept out of sight until its opener sends it to an address, which the ordinary session opens.

Browser shortcuts come in two kinds. The application takes its own, such as the address field's and those that manage tabs, from a page's input before the page sees the key. The rest, such as find, reload, back and forward, are accelerators of a hidden application menu, which receive a key only after the page, or the application's own page, has left it alone. An application's page keeps both kinds.

The main process fetches a tab's icon through the tab's session, so the request takes the same route as the page, and passes it to the renderer as a size-limited data URL. The renderer never loads a remote image. A tab's developer tools open in a second view docked beside the page. That view uses the tab's session too, so requests the tools make also pass through SSH.

Closing a session cancels downloads and authentication prompts, closes its views and relay, and clears authentication, storage and cache data. Certificate approvals belong to the live session and are also cleared when the connection ends.

## Configuration Writes

[Configuration parsing](../src/core/config.ts) uses `yaml` and strict Zod schemas. Successful settings saves, profile saves and configuration reloads publish a configuration event. Each connection controller subscribes and resolves built-ins, shared defaults, its profile and explicit connection overrides. Global terminal preferences fill unspecified terminal settings. Discovery changes are sent to the helper immediately; SSH transport settings apply on the next connection. Controllers remain subscribed while disconnected and unsubscribe on disposal. Relative file paths resolve against the configuration file.

[Profile persistence](../src/core/profiles.ts) edits the parsed YAML document rather than serializing only a new configuration object. A draft records the file contents and resolved target. Saving checks that both still match before atomically replacing the target, preserving symlinks and file permissions.

Literal passwords and passphrases are redacted from state sent to the renderer. Credential files are read by the main process when needed for a prompt.

## Terminal Rendering and Shutdown

[Terminals](../src/renderer/terminals.tsx) use xterm with font loading, a fit addon, web links and a ligature joiner. WebGL rendering is disabled globally by default and profiles inherit it unless overridden. Without it terminals use DOM rendering without terminal ligatures; global changes apply to open terminals that inherit the setting. When enabled, initialization failure or unrecoverable context loss falls back to DOM rendering. Context loss adds a current error for the affected terminal until WebGL recovers or the terminal closes. An initialization failure instead adds one app-wide current error for the page. Graphics errors belong to the page displaying the terminals and appear alongside backend errors in the Errors panel.

Closing the application window stops SSH sessions, closes the askpass broker and shuts down browser sessions. The application waits up to five seconds for that before it exits, so SSH processes end and their temporary directories are removed. While a connection is connecting or connected, the main process holds the window open, brings it into view and has the renderer ask the user to confirm quitting. Quitting the application closes it without asking, as does closing it while the renderer has crashed, or closing it again once the renderer has left the question unacknowledged for two seconds. A page that loads while the question is unacknowledged asks it. A second launch focuses the existing instance. The test rig selects a separate application data directory to run independently.

See [Development](development.md) for the build, test and package commands.
