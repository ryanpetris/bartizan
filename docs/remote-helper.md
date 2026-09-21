[Documentation](README.md) · [Architecture](architecture.md)

# Remote helper

Each connected SSH master that needs remote session discovery or application launches runs a Python 3.9+ helper on a separate channel. It queries local tmux and Herdr sockets and checks Screen sockets every two seconds. Discovery does not execute those programs. Full snapshots are sent after configuration, every minute and when requested. Once started, the helper remains running until disconnection or a channel failure, even when no consumer needs it. An interrupted helper channel restarts only while the SSH connection remains connected and a consumer still needs it.

A small [Python loader](../src/main/remote-helper/loader.py), bundled as text with the app, reads a compressed Python zipapp from stdin using a byte count supplied on the command line. It writes `helper.pyz` inside a private temporary directory and runs it in the same process. Python selects the temporary location from `TMPDIR`, `TEMP`, `TMP`, or platform defaults. Modules load directly from the archive without extraction. After the archive, stdin carries newline-delimited JSON requests and stdout carries newline-delimited JSON responses. The file remains available for imports until the helper exits. Normal shutdown, startup errors, and handled `SIGTERM`, `SIGHUP`, or `SIGINT` signals delete the temporary directory and its archive after application cleanup. Forced termination with `SIGKILL` or a machine crash can leave the directory behind.

The helper waits for configuration before scanning or sending session snapshots; after `helper.ready` reports readiness and the remote helper PID, the remote integration lifecycle manager supplies its current `sessions.configure` command. Integration records its helper requirement when activated after connection; application launches record their own requirements. These requirements trigger helper startup. Releasing a requirement leaves a running helper available. Each helper restart repeats this initialization without replaying application commands. A request is:

```json
{"type":"sessions.refresh"}
```

Responses are `sessions.upsert` (`source`, `session`), `sessions.remove` (`source`, `key`), and `sessions.snapshot` (`sources`, `sessions`, `errors`). A session contains:

```json
{
  "source": "opaque-socket-identity",
  "key": "opaque-session-identity",
  "label": "build",
  "group": "tmux",
  "detail": "1 window",
  "attached": false,
  "commands": {
    "resume": "exec tmux -u -S '/tmp/example.sock' attach-session -t '$0'",
    "takeover": "exec tmux -u -S '/tmp/example.sock' attach-session -d -t '$0'",
    "stop": "tmux -u -S '/tmp/example.sock' kill-session -t '$0'"
  }
}
```

Commands are shell programs supplied by the connected host. Available actions are optional. tmux resume commands also check attachment before opening. Bartizan starts terminals with the supplied command and tracks them by connection and session key. Stop commands run on a separate SSH channel. Display text is sanitized independently of executable commands.

A snapshot's `sources` identifies successfully scanned sockets, including confirmed empty ones. Its `sessions` replaces records from those sources. Errors contain `message` and, when a socket is known, `source`. Records from failed sources are retained. If directory enumeration failed, the error has no source and records outside the successful scans are retained too. Otherwise unlisted sources are absent and their records are removed, including after helper reconnection.

The backend exposes `sessions.messages.send`, `.on` and `.listen`. The client exposes `sendHelperMessage` and `onHelperMessage`. Subscribers receive `{connectionId, message}` independently; one subscriber cannot consume another's message. The channel supervisor publishes `helper.error` on failure. Empty snapshots maintain the heartbeat while discovery is disabled. Refresh disables only its button until any snapshot or error for that connection, or a failed send. There is no response-to-click matching.

Socket discovery honors `TMUX_TMPDIR`, `TMUX`, `SCREENDIR`, `XDG_CONFIG_HOME` and `HERDR_SOCKET_PATH`, alongside conventional locations. Actions include the selected socket or directory explicitly. Arbitrary custom sockets outside these locations must be exposed through the remote login environment. tmux discovery speaks its native protocol 8; unsupported socket protocols surface as source errors. Python uses its standard library only.

Run the socket and UI checks inside Docker:

```sh
npm run rigs -- --docker sessions
```

## Remote applications

Electron application tabs use the same helper even when session discovery is disabled. `sessions.configure` with an `enabled` boolean controls discovery independently. Downloads and application processes run in worker threads so session snapshots and requests continue during a launch.

The client sends `applications.launch` with `launchId`, `application`, and optional adapter-validated `options`. Application IDs select built-in adapters; requests do not contain executable commands or download URLs. Visual Studio Code accepts an optional absolute `folder` path. `applications.stop` with the same `launchId` cancels work or stops the running process group.

Every application event includes `launchId`:

- `applications.progress`: `phase` is `checking`, `downloading`, `extracting`, `starting`, or `loading`. Optional `release`, `usingCachedRelease`, and `transfer` describe the selected release and download. A launch that falls back to a cached release carries `usingCachedRelease` for the rest of its progress events. Transfers contain `receivedBytes` and optional `totalBytes`.
- `applications.consent`: `consentId` and `content` containing remote-supplied `text` and optional `prompt`. The client sends `applications.respond` with the launch and consent IDs and an `accepted` boolean. Responses only apply to the outstanding consent request.
- `applications.ready`: optional `release` and `view` containing `kind: "browser"` and a loopback HTTP or HTTPS `url`. The URL can contain credentials and must not be logged.
- `applications.spawned`: the launcher `pid`, reported immediately after spawning it.
- `applications.ended`: `reason` is `cancelled`, `stopped`, `exited`, or `failed`, with optional `exitCode` and `error` containing `code` and `message`.

Each connection owns an in-memory process tracker keyed by UUID. Lifecycle managers report complete records before starting remote work, then report status, remote PID and activity messages as they change. A `stopped` report removes a record. Connection state includes the current process snapshot; the details page renders it without subscribing to helper events.

A helper keeps its UUID across retries and clears its PID while retrying. Each application launch has its own record with a name assigned by Bartizan. Closing an application tab keeps its lifecycle manager and stopping records until `applications.ended` confirms cleanup. Lost helper channels mark open launches failed; closed launches are retired. These launches release their helper requirements before the supervisor decides whether to retry. Active session integration retains its requirement through helper failures; application commands are not replayed.

Retry creates a new launch ID. Closing the helper cancels launches and stops their child processes. Disconnecting leaves the application tab available for retry after reconnection.

Progress events may include a `component` label and a `transfer` with `receivedBytes` and optional `totalBytes`. The component names the part being installed, so Visual Studio Code Launcher and Server downloads report separately. The CLI runs with trace logging; its server-download byte counts and server-start message feed progress, while other diagnostic output is discarded.

The shared launcher provides download verification, safe extraction, atomic cache installation, installation locks, consent exchange and process supervision. Adapters supply release lookup, launch arguments and readiness detection.

Visual Studio Code checks the stable release service on every launch. The helper selects the CLI for the remote host: Linux x64, ARM64 or ARMhf, or macOS Intel or Apple Silicon. Linux downloads use tar archives and macOS downloads use ZIP archives. Downloads live under `$XDG_CACHE_HOME/bartizan/tools/vscode/<release>/`, defaulting to `~/.cache`. If the query fails, the newest complete cached release is used. Each tab uses its own private in-memory browser session, server process and random loopback port. Settings, extensions and CLI state are shared by the remote account, as with ordinary Visual Studio Code launches. The CLI uses a pinned server commit; a release becomes complete after its web server has loaded. Settings, extensions and notice acceptance live under `$XDG_DATA_HOME/bartizan/tools/vscode/`, defaulting to `~/.local/share`. Consent content comes from the downloaded CLI's startup notice. Acceptance is keyed by the notice hash, so a changed notice requires another response.

Run the application checks with `npm run rigs -- --docker applications`.
