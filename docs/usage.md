[Documentation](README.md) · [Project home](../README.md)

# Using Bartizan

## Connect and save profiles

Use **New Connection** beside the sidebar's Connect field to enter a host, port and authentication settings. The form can connect without saving, save a profile, or save and connect. **Profiles** in the title bar opens the saved profile list and its Edit controls.

The Connect field searches profile labels, IDs, hosts, usernames and tags. Use the arrow keys to choose a result and Enter to connect. A hostname or `user@host` also offers a direct connection using your configured defaults. Direct connections do not create profiles. Set a custom port in the connection form or configuration.

Selecting an already connected profile focuses its most recently viewed live terminal. If it has no live terminal, Bartizan opens one. Each connection shares one SSH transport across its terminals and browser sessions.

## Arrange your workspace

The connection's add menu offers **Terminal** and **Browser Session**. Drag sidebar rows to reorder connections, terminals, sessions or tabs within their group. The row context menu also offers **Move Up** and **Move Down**. Sidebar order lasts for the current app session.

**Disconnect** ends the SSH transport and its shells. The connection remains in the sidebar. Browser pages stay open but lose network access. **Reconnect** restores the transport and browser access; it does not resume closed shells. Use **New Terminal** for a fresh shell. Remove a disconnected connection to close its browser sessions and remove its sidebar entry.

**Connection Details** shows connection state. Negotiated SSH algorithms, duration and traffic are available when the installed OpenSSH supports `ssh -O conninfo`.

## Work in terminals

Each terminal runs a separate remote shell. Programs can set its sidebar and window title with OSC 0 or OSC 2. For example:

```sh
printf '\033]2;Build & tests\007'
```

Drag to select text. Releasing the mouse copies nonblank text to the clipboard and clears the selection. Hold Shift while dragging when a remote program handles mouse input. Remote programs can also write to the clipboard using OSC 52; clipboard queries are ignored.

Click an HTTP or HTTPS link to open it in the connection's first browser session, meaning the highest session in the sidebar. Bartizan creates a session if needed. Right-click a link to choose a different destination. Shift+F10 offers links from the terminal; when there are none, the key goes to the remote program.

## Browse through SSH

A new browser session starts with one empty tab. Enter an HTTP or HTTPS URL in **Address** and press Enter. An address without a scheme uses HTTP. The field does not perform web searches.

The add button on a session row opens another tab there. **New Browser Tab** in the title bar uses the session you are viewing, or the connection's first session when you are viewing a terminal. A session can hold up to 32 tabs.

Sessions receive a color and a name such as Browser 1. Use **Rename** in a session row's context menu to change its name. Clicking the row opens its first tab; if the session is empty, it opens a new tab.

Tabs in one session share cookies and site storage. Different sessions keep that data separate, in memory. Closing the last tab leaves the session and its data available. Closing the session closes all its tabs and clears its data. Quitting Bartizan closes every session.

Website connections and DNS lookups pass through SSH. Remote loopback addresses refer to the SSH server. If the SSH transport ends, sessions go offline without switching to a direct connection. Website permission requests are denied, including camera, microphone and geolocation access.

### Links and popups

Right-click a link in a page or terminal to open it in the current/default session, a new session, or a named session on the same connection. **Copy Link** copies the address. **Open in External Browser** appears when `xdg-open` is available; that opens your system browser outside Bartizan's SSH routing.

A page's new windows open as tabs in its own session. Each page can open at most one popup per second.

### Certificates, sign-in and downloads

An untrusted, expired or hostname-mismatched HTTPS certificate can show a warning with its fingerprint, issuer and validity dates. **Proceed** accepts that certificate and error for that origin until the session closes or the SSH connection ends. The exception is not saved.

HTTP Basic and Digest authentication open a sign-in dialog. Downloads open a save dialog, with one pending save dialog allowed per session. After choosing a location, the download runs in the background. Disconnecting or closing the session cancels its running downloads.

Cancelling a sign-in, certificate warning or download save dialog suppresses further prompts and popups from that tab. Click in the page, press Enter or Space there, or navigate to allow them again.

## Shortcuts

| Keys | Where | Action |
| --- | --- | --- |
| Ctrl+Shift+N | Main window | New connection |
| Ctrl+L | Browser | Focus Address |
| F12 or Ctrl+Shift+I | Browser | Open the selected tab's developer tools |
| Shift+F10 | Sidebar row | Open the row's context menu |
| Shift+F10 | Terminal with links | Open the link menu |

## Appearance and errors

Open **Settings** in the title bar to choose Dark, Light or System appearance, an interface font, a terminal font, terminal size and ligatures. Inter and JetBrains Mono are bundled. System Default uses the system font. Settings apply immediately and save to the configuration file. A connection's terminal overrides take priority over global settings.

**Errors** beside Connect shows current configuration problems and the error history. New failures also appear as short notifications. If a configuration edit fails, fix the file and use **Reload Configuration** in Profiles. See the [configuration reference](configuration.md) for accepted fields.
