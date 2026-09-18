[Documentation](README.md) · [Project home](../README.md)

# Installation

Bartizan runs on Linux x86-64. Download a package from the [releases page](https://github.com/ryanpetris/bartizan/releases/latest).

| Package | Install or run |
| --- | --- |
| AppImage | Make the file executable, then open it. |
| Debian `.deb` | Install with `sudo apt install ./bartizan_*.deb`. |
| Arch `.pkg.tar.zst` | Install with `sudo pacman -U ./bartizan-*.pkg.tar.zst`. |
| `.tar.gz` | Extract the archive and run `AppRun` from the extracted directory. |

OpenSSH must be installed. Chromium's sandbox needs working user namespaces, or the setuid `chrome-sandbox` helper that the Debian and Arch packages install. Bartizan refuses to start with the sandbox turned off.

## First connection

1. Open Bartizan and choose **New Connection** next to Connect at the bottom of the sidebar.
2. Enter the host, username and authentication details. Connect once, or save a profile to use again.
3. Check the host key fingerprint when prompted, then accept it if it matches the server's key.
4. Use the connection's add menu to open more terminals or a browser session.

You can also type a hostname or `user@host` into Connect for a one-off connection using your configured defaults. Saved profiles appear in the same search.

Bartizan uses its own SSH settings and trust store. It does not read your existing SSH configuration. Add connection details in the app or in the [configuration file](configuration.md).

For terminal controls, browser sessions and shortcuts, see [Using Bartizan](usage.md).

## Browser server

The existing executable can start the server with `bartizan serve`. It uses its bundled Node runtime and does not open a desktop window or need a display server. Normal launches still open the desktop app.

From a source checkout with the [development prerequisites](development.md#run-from-source) installed:

```sh
npm ci
npm start -- serve
```

The server defaults to `127.0.0.1:3000`. To choose the listening address, port and configuration file:

```sh
bartizan serve --host localhost --port 8080 --config ./config.yaml
```

For a standalone Node process, `npm run web` builds and starts the server. After building, `node dist/server.cjs` starts the server without rebuilding. Port `0` asks the operating system to choose a free port; startup prints the actual address. `--help` lists the options.

There is no application authentication. Binding to a non-loopback address prints a prominent warning and requires typing `yes`. `--allow-remote` bypasses confirmation but keeps the warning; without it, noninteractive remote startup exits. Protect remote access with an authenticated reverse proxy, VPN, or equivalent protection. All clients share the server's connections, terminals, settings and error history.

The server runs SSH and reads configuration, keys and credential files on its own machine. File-path fields refer to that machine; native file-picker buttons are unavailable. `BARTIZAN_DATA_DIR` selects its data directory; otherwise it uses `bartizan` under `XDG_CONFIG_HOME` or the user's `.config` directory. `--config` changes only the configuration file.

Embedded browser sessions are unavailable. Terminal links open in ordinary browser tabs using the client's network, without Bartizan's SSH routing. Browser clipboard permissions apply. Closing a tab leaves SSH connections running on the server; stopping the server closes them. Reload the page to reconnect after losing the WebSocket connection. Terminal output is streamed live and is not stored for replay to a newly opened page.

The web endpoint checks WebSocket origins against the HTTP Host. A loopback-only server also accepts only loopback Host names. A reverse proxy must preserve a matching public Host and Origin when forwarding to a server explicitly configured for remote access.
