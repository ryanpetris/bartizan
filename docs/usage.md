[Documentation](README.md) · [Project home](../README.md)

# Using Bartizan

## Connect and save profiles

Bartizan opens on its home page: the Connect field over a list of your profiles. Click a profile to connect to it. The home page returns whenever nothing is selected, and **Home**, the Bartizan mark at the top of the rail, goes back to it at any time. While a connection is in view, Connect sits at the foot of its panel.

Use **New Connection** on the rail or the home page to enter a host, port and authentication settings. The form can connect without saving, save a profile, or save and connect. **Profiles** on the rail opens the saved profile list and its Edit controls; on the home page, a profile's Edit button appears when you point at it.

The Connect field searches profile labels, IDs, hosts, usernames and tags. Use the arrow keys to choose a result and Enter to connect. A hostname or `user@host` also offers a direct connection using your configured defaults. Direct connections do not create profiles. Set a custom port in the connection form or configuration.

A connection with no terminals or browser sessions open shows **Nothing Open**; open one from the connection's add menu.

Selecting an already connected profile focuses its most recently viewed live terminal. If it has no live terminal, Bartizan opens one. Each connection shares one SSH transport across its terminals and browser sessions.

## Arrange your workspace

The connection's add menu offers **Terminal** and **Browser Session**. Drag navigation items to reorder connections, terminals, sessions or tabs within their group. The row context menu also offers **Move Up** and **Move Down**. Navigation order lasts for the current app session.

**Disconnect** ends the SSH transport and its shells. The connection remains in the connection list. Browser pages stay open but lose network access. **Reconnect** restores the transport and browser access; it does not resume closed shells. Use **New Terminal** for a fresh shell. Remove a disconnected connection to close its browser sessions and remove its navigation entry.

**Connection Details** shows connection state. Negotiated SSH algorithms, duration and traffic are available when the installed OpenSSH supports `ssh -O conninfo`.

## Work in terminals

Each terminal runs a separate remote shell. Programs can set its navigation and window title with OSC 0 or OSC 2. For example:

```sh
printf '\033]2;Build & tests\007'
```

Drag to select text. Releasing the mouse copies nonblank text to the clipboard and clears the selection. Hold Shift while dragging when a remote program handles mouse input. Remote programs can also write to the clipboard using OSC 52; clipboard queries are ignored.

Click an HTTP or HTTPS link to open it in the connection's first browser session, meaning the first session in navigation order. Bartizan creates a session if needed. Right-click a link to choose a different destination. Shift+F10 offers links from the terminal; when there are none, the key goes to the remote program.

## Browse through SSH

A new browser session starts with one empty tab. Enter an HTTP or HTTPS URL in **Address** and press Enter. An address without a scheme uses HTTP. The field does not perform web searches.

The add button on a session row opens another tab there. In Rail and Console, **New Browser Tab** in the title bar uses the session you are viewing, or the connection's first session when you are viewing a terminal. A session can hold up to 32 tabs.

Sessions receive a color and a name such as Browser 1. Use **Rename** in a session row's context menu to change its name. Clicking the row opens its first tab; if the session is empty, it opens a new tab.

Tabs in one session share cookies and site storage. Different sessions keep that data separate, in memory. Closing the last tab leaves the session and its data available. Closing the session closes all its tabs and clears its data. Quitting Bartizan closes every session.

### Page tools

A tab's row shows its page's icon. A tab that plays sound shows a speaker in its row. Click the speaker, or use **Mute Tab** in the row's context menu, to silence the tab.

Ctrl+F opens **Find in Page** below the toolbar. Enter and Shift+Enter move between matches, and Escape closes it. Ctrl+Plus, Ctrl+Minus and Ctrl+0 zoom the page. The address field shows a zoom level other than 100%; click it to reset the zoom. Zoom belongs to a site within its session. Shift-click **Reload**, or press Ctrl+Shift+R, to reload without the cache.

The toolbar's **Page Menu** offers the same commands with **Save as PDF…** and **Print…**. The address of a link under the pointer shows over the bottom corner of the page, or in Console's status line.

**Developer Tools**, or F12, opens the selected tab's tools docked below the page, inside the window; the same control closes them. Drag the divider to resize them, and use **Dock Developer Tools at Right** in the Page Menu to move them beside the page. The dock side and size last for the current app session. Requests the tools make pass through SSH like the page's own.

Website connections and DNS lookups pass through SSH. Remote loopback addresses refer to the SSH server. If the SSH transport ends, sessions go offline without switching to a direct connection. Website permission requests are denied, including camera, microphone and geolocation access.

### Links and popups

Right-click a link in a page or terminal to open it in the current/default session, a new session, or a named session on the same connection. **Copy Link** copies the address. **Open in External Browser** appears when `xdg-open` is available; that opens your system browser outside Bartizan's SSH routing.

Right-clicking an image, a text field or selected text offers the items for it. Anywhere else, the menu offers **Back**, **Forward**, **Reload**, **Save as PDF…** and **Print…**. Every page menu ends with **Inspect Element**, which opens developer tools on that element.

A page's new windows open as tabs in its own session. Each page can open at most one popup per second.

### Certificates, sign-in and downloads

An untrusted, expired or hostname-mismatched HTTPS certificate can show a warning with its fingerprint, issuer and validity dates. **Proceed** accepts that certificate and error for that origin until the session closes or the SSH connection ends. The exception is not saved.

HTTP Basic and Digest authentication open a sign-in dialog. Downloads open a save dialog, with one pending save dialog allowed per session. After choosing a location, the download runs in the background. Disconnecting or closing the session cancels its running downloads.

**Downloads** appears in the toolbar once the session has a download, and lists the session's downloads with their progress over the page. **Cancel** stops a running download, **Show in Folder** reveals a finished one and **Clear** removes those that have ended. The list lasts until the session closes.

Cancelling a sign-in, certificate warning or download save dialog suppresses further prompts and popups from that tab. Click in the page, press Enter or Space there, or navigate to allow them again.

## Shortcuts

A page sees the find, reload, print and zoom keys first, so a site that uses them itself keeps them; Bartizan acts when the page leaves the key alone. Ctrl+L, Ctrl+Shift+N and the developer tools keys always belong to Bartizan.

| Keys | Where | Action |
| --- | --- | --- |
| Ctrl+Shift+N | Main window | New connection |
| Ctrl+L | Browser | Focus Address |
| Ctrl+F | Browser | Find in page |
| Ctrl+R or F5 | Browser | Reload |
| Ctrl+Shift+R, Ctrl+F5 or Shift+F5 | Browser | Reload without the cache |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0 | Browser | Zoom in, zoom out, reset zoom |
| Ctrl+P | Browser | Print |
| F12 or Ctrl+Shift+I | Browser | Open or close the selected tab's developer tools |
| Shift+F10 | Navigation item | Open the row's context menu |
| Shift+F10 | Terminal with links | Open the link menu |

## Appearance and errors

Open **Settings** to choose Dark, Light or System appearance, a theme, an interface font, a terminal font, terminal size and ligatures.

A theme is a layout of the window with its own colours, terminal colours and scroll bars, in both appearances:

| Theme | Layout |
| --- | --- |
| Rail | Connections as a narrow strip of badges, beside a panel that lists the items of the connection in view |
| Tabs | No side list: connections as pills in the title bar, and the items of the connection in view as a strip of tabs |
| Console | The view at full width over two lines of text, one for the items of the connection in view and one for connections and status |

Rail is the default theme; this guide names controls as Rail places them. On the home page, Rail hides its panel, Tabs its tab strip and Console its line of items; in Tabs and Console, **Home** is the Bartizan mark at the start of the title bar. In Tabs, the connection's Add menu opens terminals and browser sessions; the add button on a session row opens a tab in that session. Console uses the terminal font throughout its interface, so its Settings has no Interface Font control. In Rail, Tabs and Console, choosing a connection returns to what it last showed. Where the lists run across the window, the row menus offer **Move Left** and **Move Right** and the Left and Right arrow keys move along them. Inter and JetBrains Mono are bundled. System Default uses the system font. Settings apply immediately and save to the configuration file. A connection's terminal overrides take priority over global settings.

**Errors** at the bottom of the rail shows current configuration problems and the error history. New failures also appear as short notifications. If a configuration edit fails, fix the file and use **Reload Configuration** in Profiles. See the [configuration reference](configuration.md) for accepted fields.
