[Documentation](README.md) · [Architecture](architecture.md)

# Remote helper

Each connected SSH master with remote session integration enabled runs a Python 3.9+ helper on a separate channel. It queries local tmux and Herdr sockets and checks Screen sockets every two seconds. Discovery does not execute those programs. Full snapshots are sent on startup, every minute and when requested. Closing the channel ends the helper; an interrupted helper channel restarts automatically while the SSH connection remains connected.

The helper uses newline-delimited JSON on stdin and stdout. A request is:

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

The backend exposes `sessions.messages.send`, `.on` and `.listen`. The client exposes `sendHelperMessage` and `onHelperMessage`. Subscribers receive `{connectionId, message}` independently; one subscriber cannot consume another's message. The channel supervisor publishes `helper.error` on failure. Refresh disables only its button until any snapshot or error for that connection, or a failed send. There is no response-to-click matching.

Socket discovery honors `TMUX_TMPDIR`, `TMUX`, `SCREENDIR`, `XDG_CONFIG_HOME` and `HERDR_SOCKET_PATH`, alongside conventional locations. Actions include the selected socket or directory explicitly. Arbitrary custom sockets outside these locations must be exposed through the remote login environment. tmux discovery speaks its native protocol 8; unsupported socket protocols surface as source errors. Python uses its standard library only.

Run the socket and UI checks inside Docker:

```sh
npm run rigs -- --docker sessions
```
