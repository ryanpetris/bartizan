[Documentation](README.md) · [Project home](../README.md)

# Using Bartizan

## Connect and Save Profiles

Bartizan opens on its home page. The home page returns whenever nothing is selected, and **Home**, the Bartizan mark at the top of the rail, goes back to it at any time.

**New Connection** on the rail shows the Connect page, which lists your profiles. Like the home page, it stands on its own, without the panel or tabs of a connection. Click a profile to connect to it, or use its Edit button to change its settings. **New Profile** opens the connection form to enter a host, port and authentication settings. The form can connect without saving, save a profile, or save and connect.

Connect's search matches profile labels, IDs, hosts, usernames and tags. Once the search has text, its first result is highlighted and Enter connects it; Up and Down move the highlight from one result to the next, which in a window wide enough for columns is the result beside it. Tab runs from the search through **Reload Configuration** and **New Profile** to the highlighted result, which is the only stop the results take; there Up and Down move through the results, Right and Left move between a profile and its Edit button, and Escape returns to the search. A hostname or `user@host` also offers a direct connection, listed after the profiles, using your configured defaults. Direct connections do not create profiles. Append `:port` to specify a port, such as `host:222` or `user@host:222`. IPv6 addresses with a port require brackets, such as `[2001:db8::1]:222`. Unbracketed IPv6 addresses use the configured default port. Ports must be integers from 1 to 65535.

A connection with no terminals or browser sessions open shows **Nothing Open**; open one from the connection's add menu.

Each profile has one connection, and so does each destination chosen from Connect's search, which matches an existing direct connection with the same host, username and port, counting omitted ones as their defaults. Selecting one that is connected focuses its most recently viewed live terminal; if it has no live terminal, Bartizan opens one. Selecting one that is disconnected connects it again. A profile and a direct connection to the same host stay separate. Each connection shares one SSH transport across its terminals and browser sessions.

## Arrange Your Workspace

The connection's add menu offers **Terminal** and **Browser Session**. Drag navigation items to reorder connections, terminals, sessions or tabs within their group. The row context menu also offers **Move Up** and **Move Down**. Navigation order lasts for the current app session. A control shown by its icon alone shows a tooltip once the pointer or keyboard focus rests on it. Where a browser session's tab row shows the tab's title, its tooltip is the tab's address.

**Disconnect** ends the SSH transport and its shells. The connection remains in the connection list. Browser pages stay open but lose network access. **Reconnect** restores the transport and browser access, loads again each page that failed to load while the connection was down, without sending a form again, and starts a fresh shell in each terminal whose shell was running when the connection ended; the terminal keeps its scrollback. A terminal whose shell exited stays closed; while the connection is connected, **Reconnect Terminal** in the title bar, or the reconnect button on the terminal's row, starts a fresh shell in it. Remove a disconnected connection to close its browser sessions and remove its navigation entry. Closing the window while a connection is active asks before quitting.

**Connection Details** shows connection state. Negotiated SSH algorithms, duration and traffic are available when the installed OpenSSH supports `ssh -O conninfo`.

## Work in Terminals

Each terminal runs a separate remote shell. A program that prints faster than the terminal can show waits for it, so after Ctrl+C little of its output remains to be shown. Programs can set its navigation and window title with OSC 0 or OSC 2. For example:

```sh
printf '\033]2;Build & tests\007'
```

Drag to select text. Releasing the mouse copies nonblank text to the clipboard and clears the selection. Hold Shift while dragging when a remote program handles mouse input. Remote programs can also write to the clipboard using OSC 52; clipboard queries are ignored.

Right-click a terminal away from links for **Copy**, **Paste** and **Select All**. Select All selects the whole scrollback for **Copy**. When a remote program handles mouse input, right clicks go to the program; hold Shift for the menu. Ctrl+Shift+V and Shift+Insert also paste, or Cmd+V on macOS.

Click an HTTP or HTTPS link to open it in the connection's first browser session, meaning the first session in navigation order. Bartizan creates a session if needed. Right-click a link to choose a different destination. Shift+F10 offers links from the terminal, each with its destinations in a submenu when there are several; when there are none, the key goes to the remote program.

## Browse Through SSH

A new browser session starts with one empty tab. Enter an HTTP or HTTPS URL in **Address** and press Enter. An address without a scheme uses HTTP, and `view-source:` before an address shows the page's source. The field does not perform web searches. While a page loads, **Address** shows the address it is loading; **Stop** returns it to the page that was there.

While **Address** has focus, a list below it suggests addresses, and once you type, those that contain the text: first those the connection's tabs have been to or been sent to during this app session, most recent first, then `http://localhost:PORT/` for each port listening on the remote host's loopback or every address. Ports are read from Linux hosts only. Up and Down move through the list, Enter opens the highlighted address or else the text, and Escape closes the list before it restores the address.

The add button on a session row opens another tab there. Closing the tab you are viewing shows the tab after it in the session, or the one before it when it was last.

Sessions receive a color and a name such as Browser 1. Use **Rename** in a session row's context menu to change its name. Clicking the row opens its first tab; if the session is empty, it opens a new tab.

A tab row's context menu offers **Reload**, **Duplicate Tab**, **Copy Address**, **Open in External Browser** where it is available, **Mute Tab**, **Close Tab**, **Close Other Tabs**, **Close Tabs Below**, or **Close Tabs to the Right** where tabs run across the window, and **Reopen Closed Tab**, which reopens the session's most recently closed tab at its address. Selecting a tab that shows a page gives the page the keyboard. When you close a tab whose page asks before it is left, **Leave Page?** offers **Leave** and **Stay**. A page without a title of its own, such as JSON or an image, is named by its host and path.

Right-click one of Bartizan's own text fields for **Undo**, **Redo**, **Cut**, **Copy**, **Paste**, **Delete** and **Select All**. In **Address** the menu also offers **Paste and Go**, which opens the address on the clipboard, and **Copy Address**.

Tabs in one session share cookies and site storage. Different sessions keep that data separate, in memory. Closing the last tab leaves the session and its data available. Closing the session closes all its tabs and clears its data. Quitting Bartizan closes every session.

### Page Tools

A tab's row shows its page's icon. A tab that plays sound shows a speaker in its row. Click the speaker, or use **Mute Tab** in the row's context menu, to silence the tab.

Ctrl+F opens **Find in Page** below the toolbar. Enter and Shift+Enter move between matches, and Escape closes it. Ctrl+Plus, Ctrl+Minus and Ctrl+0 zoom the page. The address field shows a zoom level other than 100%; click it to reset the zoom. Zoom belongs to a site within its session. Shift-click **Reload**, or press Ctrl+Shift+R, to reload without the cache.

The toolbar's **Page Menu** offers the same commands with **Clear Site Data**, **Save as PDF…**, **Save Screenshot…** and **Print…**. **Clear Site Data** removes the cache, local storage, IndexedDB databases, service workers and file systems of the page's origin in its session, and the cookies the page's address would send, then reloads the page; the tab's session storage stays. **Save Screenshot…** saves the visible part of the page as a PNG image. Save dialogs start in your Downloads folder. The address of a link under the pointer shows over the bottom corner of the page, or in Console's status line.

**Developer Tools**, or F12, opens the selected tab's tools docked below the page, inside the window; the same control closes them. Drag the divider to resize them, and use **Dock Developer Tools at Right** in the Page Menu to move them beside the page. The dock side and size last for the current app session. Requests the tools make pass through SSH like the page's own.

Website connections and DNS lookups pass through SSH. Remote loopback addresses refer to the SSH server. If the SSH transport ends, sessions go offline without switching to a direct connection. Website permission requests are denied, including camera, microphone and geolocation access, apart from writing to the clipboard; remote applications such as Visual Studio Code and T3 Code may also read it. A page that crashes, or one outside a remote application that stops responding, shows **Couldn't Load Page**, and **Retry** loads it again.

### Links and Popups

Right-click a link in a page or terminal to open it in the current/default session, a new session, or a named session on the same connection. In a page, **Open Link in New Tab** opens it in a tab behind the current one. **Copy Link** copies the address. **Open in External Browser** appears when `xdg-open` is available; that opens your system browser outside Bartizan's SSH routing.

When a page opens a `mailto:`, `tel:` or `sms:` link, **Open in Another Application?** shows the link as it will be opened, with every recipient but a long subject or body cut short, and **Open** hands it to your system's default application for its scheme, which on Linux is through `xdg-open`. A `mailto:` link keeps only its recipients, subject and body, in that order; one whose recipients could be read as more fields does nothing. If no application opens the link, Bartizan says so. Only the tab on show asks, while Bartizan's window has focus, one question at a time, and **Cancel** leaves the page asking nothing more until you next act in it. Right-clicking such a link offers **Open Link**, which asks the same, where `xdg-open` is available, and **Copy Link**. Links with other schemes, such as `file:`, open nothing.

Right-clicking an image, a text field or selected text offers the items for it. Anywhere else, the menu offers **Back**, **Forward**, **Reload**, **Copy Page Address**, **Open Page in External Browser** where it is available, **Save as PDF…**, **Print…** and **View Page Source**, which opens the page's source in a new tab; in a remote application it leaves out the commands for the page's address and source. Every page menu ends with **Inspect Element**, which opens developer tools on that element.

A page's new windows open as tabs in its own session and stay connected to the page that opened them, as sign-in popups need. Until such a tab is sent to an address, **Address** shows `about:blank`. Ctrl+click or middle-click a link to open it in a tab behind the current one. Apart from those, each page can open at most one popup per second. Popups from Visual Studio Code and T3 Code open in an ordinary browser session of the connection.

### Certificates, Sign-In and Downloads

An untrusted, expired or hostname-mismatched HTTPS certificate can show a warning with its fingerprint, issuer and validity dates. **Proceed** accepts that certificate and error for that origin until the session closes or the SSH connection ends. The exception is not saved.

When such a certificate stops a page from loading a resource or frame from another origin, the page stays in view with a notice above it naming that origin. **Review** opens the warning for that certificate, where **Proceed** accepts it the same way and reloads the page, unless the tab is already loading another. **Cancel** there, or **Dismiss** on the notice, leaves the resource blocked, and the tab does not show that certificate again until a page loads in it. A tab shows one such notice at a time.

HTTP Basic and Digest authentication open a sign-in dialog. Downloads open a save dialog, with one pending save dialog allowed per session. After choosing a location, the download runs in the background. Disconnecting or closing the session cancels its running downloads.

**Downloads** appears in the toolbar once the session has a download, and lists the session's downloads with their progress over the page. **Cancel** stops a running download, **Show in Folder** reveals a finished one and **Clear** removes those that have ended. The list lasts until the session closes.

Cancelling a sign-in, certificate warning, download save dialog or **Open in Another Application?**, or dismissing a certificate notice, suppresses further prompts, notices and popups from that tab. Click in the page, press Enter or Space there, or navigate to allow them again.

## Shortcuts

A page sees the find, reload, print, zoom, back and forward keys first, so a site that uses them itself keeps them; Bartizan acts when the page leaves the key alone. Ctrl+L, Ctrl+Shift+N, F11, the tab keys and the developer tools keys always belong to Bartizan. Visual Studio Code and T3 Code keep every key but Ctrl+Shift+N and F11. On macOS, use Cmd in place of Ctrl, apart from Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Down and Ctrl+Page Up.

| Keys | Where | Action |
| --- | --- | --- |
| Ctrl+Shift+N | Main window | New connection |
| F11 | Main window | Enter or leave fullscreen showing only the current view |
| Ctrl+L | Browser | Focus Address |
| Ctrl+T | Browser | New tab |
| Ctrl+W | Browser | Close tab |
| Ctrl+Shift+T | Browser | Reopen the session's most recently closed tab |
| Ctrl+Tab or Ctrl+Page Down | Browser | Next tab |
| Ctrl+Shift+Tab or Ctrl+Page Up | Browser | Previous tab |
| Alt+Left, or Cmd+[ on macOS | Browser | Back |
| Alt+Right, or Cmd+] on macOS | Browser | Forward |
| Ctrl+F | Browser | Find in page |
| Ctrl+R or F5 | Browser | Reload |
| Ctrl+Shift+R, Ctrl+F5 or Shift+F5 | Browser | Reload without the cache |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0 | Browser | Zoom in, zoom out, reset zoom |
| Ctrl+P | Browser | Print |
| F12 or Ctrl+Shift+I | Browser | Open or close the selected tab's developer tools |
| Shift+F10 | Navigation item | Open the row's context menu |
| Shift+F10 | Terminal with links | Open the link menu |
| Up, Down, Home, End or a letter | Menu | Move to an item |
| Enter or Space | Menu | Choose the item, or open its submenu |
| Right, Left | Menu | Open or close a submenu |
| Escape | Menu | Close the menu or submenu |
| Enter, Space, Up or Down | Select | Open its list, with the current option checked |
| Home, End or typing | Select | Open its list at the first, last or matching option |
| Up, Down, Home, End, Page Up, Page Down or typing | Select list | Move to an option; Up and Down start from the checked one |
| Enter, Space, Alt+Up or Alt+Down | Select list | Choose the highlighted option, or close the list when none is |
| Escape or Tab | Select list | Close the list unchanged |
| Ctrl+Shift+V or Shift+Insert; Cmd+V on macOS | Terminal | Paste |

## Appearance and Errors

Open **Settings** to choose Dark, Light or System appearance, a theme and an interface font under **Appearance**; the terminal font, its size and ligatures under **Terminal**; and WebGL rendering and remote sessions under **Advanced**.

A theme is a layout of the window with its own colours, terminal colours and scroll bars, in both appearances:

| Theme | Layout |
| --- | --- |
| Rail | Connections as a narrow strip of badges, beside a panel that lists the items of the connection in view |
| Tabs | No side list: connections as pills in the title bar, and the items of the connection in view as a strip of tabs |
| Console | The view at full width over two lines of text, one for the items of the connection in view and one for connections and status |

Rail is the default theme; this guide names controls as Rail places them. **Collapse Sidebar** at the top of Rail's panel narrows it to the icons of the items, each named in a tooltip beside it, and **Expand Sidebar** brings back their names and commands. On the home page, Rail hides its panel, Tabs its tab strip and Console its line of items; in Tabs and Console, **Home** is the Bartizan mark at the start of the title bar. Console uses the terminal font throughout its interface, so its Settings has no Interface Font control. In Rail, Tabs and Console, choosing a connection returns to what it last showed. Where the lists run across the window, the row menus offer **Move Left** and **Move Right** and the Left and Right arrow keys move along them. Inter and JetBrains Mono are bundled. System Default uses the system font. The font lists name each font in its own typeface. Settings apply immediately and save to the configuration file. A connection's terminal overrides take priority over global settings.

**Errors** at the bottom of the rail shows current configuration problems and the error history. New failures also appear as short notifications. If a configuration edit fails, fix the file and use **Reload Configuration** in Connect. See the [configuration reference](configuration.md) for accepted fields.

## Remote applications

Choose **Visual Studio Code** from a connected profile's add menu to open an application tab. Bartizan checks for the latest stable release on the remote system, downloads it into the user's cache when needed, and displays progress in the tab. If the update check fails, it uses the newest complete cached installation.

The tab displays the remote application's license notice when consent is needed. **Accept and Continue** proceeds. **Cancel**, in the notice or beside the launch progress, ends the launch. Closing the tab stops its remote server. After a disconnection, reconnect and choose **Retry** in the tab. Visual Studio Code settings and extensions persist separately from the download cache. Visual Studio Code requires the Electron desktop client and a Linux or macOS remote system with Python 3.9 or later.

**T3 Code** appears in the add menu when the remote system has it installed: when the login shell finds `t3`, or `~/.local/bin/t3` is executable. Bartizan looks each time the connection connects and never installs T3 Code itself. Each choice of T3 Code opens a new T3 Code tab, which signs in through a single-use pairing link of its own.

Bartizan uses the T3 Code server already running for the remote account. Without one, it starts a server on a random loopback port, which the connection's T3 Code tabs share; it stops when the last of them closes or the connection ends. A server this connection did not start stays running; if it stops, the tabs using it start T3 Code again. T3 Code keeps its data in `$T3CODE_HOME`, or `~/.t3`; a relative `$T3CODE_HOME` is taken from the home directory.

After a disconnection, the T3 Code tabs stay. When the connection reconnects, they start T3 Code again. If T3 Code is no longer installed, the tabs say so and **Retry** tries again.
