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
