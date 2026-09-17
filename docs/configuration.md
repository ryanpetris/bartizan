[Documentation](README.md) · [Project home](../README.md)

# Configuration

Bartizan reads `config.yaml` from its application data directory, normally `~/.config/bartizan/` on Linux. Start with `bartizan --config ./config.yaml` to choose another file. The command-line path resolves against your working directory. A missing file is created with `version: 1`.

A second launch focuses the existing instance. Quit the running instance before starting with a different configuration.

## File structure

The file has four top-level fields: `version`, `settings`, `defaults` and `profiles`. Only `version` is required. Unknown fields are rejected.

```yaml
version: 1
settings:
  appearance: dark
  terminalFontSize: 14
defaults:
  username: demo
  auth:
    method: key
    identity_files: [./keys/demo_ed25519]
profiles:
  development:
    label: Development
    host: dev.example.com
    tags: [web, development]
  staging:
    label: Staging
    host: staging.example.com
    port: 2222
    tags: [web, staging]
```

These are example destinations and credentials. Substitute your server and key file.

Profiles inherit built-in defaults, then `defaults`, then their own fields. Nested mappings merge by field. Lists replace inherited lists; an empty list clears one. A credential source replaces the entire inherited credential source.

Profile IDs use letters, digits, `_` and `-`; `__proto__` is not allowed. Tags belong to profiles, not defaults. Tags are trimmed and deduplicated without regard to case.

After editing the file, choose **Reload Configuration** in Profiles. Connection settings take effect on subsequent connections. App settings apply on reload. Saving through the UI edits the YAML document and retains comments, though formatting may change. If the file changed after a profile form opened, reopen the form before saving.

## App settings

| Setting | Default | Accepted values |
| --- | --- | --- |
| `appearance` | `dark` | `dark`, `light`, `system` |
| `interfaceFont` | `Inter` | Font family, or `""` for the system font |
| `terminalFont` | `JetBrains Mono` | Font family, or `""` for system monospace |
| `terminalFontSize` | `13` | Integer from 8 to 32 |
| `terminalLigatures` | `true` | Boolean |

## Connection fields

The fields below work in `defaults` or an individual profile, except `tags`.

| Field | Behavior |
| --- | --- |
| `label` | Display name; otherwise the profile ID or direct connection's host |
| `host` | Required when connecting; hostname, IPv4 or IPv6 address |
| `username` | Remote account; omitted or empty lets OpenSSH use the local account name |
| `port` | Integer from 1 to 65535; default 22 |
| `tags` | List of search tags, only in profiles |
| `terminal.font` | Override the global terminal font |
| `terminal.font_size` | Override the global size, from 8 to 32 |
| `terminal.ligatures` | Override the global ligature setting |
| `terminal.scrollback` | Integer from 0 to 100000; default 5000 lines |

Key, agent socket and credential file paths resolve relative to the configuration file. `~` and `~/` expand to your home directory. Environment variables are not expanded.

## Authentication

Set `auth.method` to choose how OpenSSH authenticates:

| Method | Behavior |
| --- | --- |
| `auto` | Default. Try public keys, keyboard-interactive, then password. A configured password moves password ahead of keyboard-interactive. |
| `agent` | Use keys from the SSH agent only. |
| `key` | Use the files in `identity_files` only. At least one file is required. |
| `password` | Use password authentication. |
| `keyboard-interactive` | Answer the server's interactive prompts. |

`auth.identity_files` is a list of private key paths. In `auto` mode, listing files restricts the keys offered to those identities; otherwise OpenSSH uses its default identity files and agent.

`auth.agent` selects an agent socket. Omit it or use `SSH_AUTH_SOCK` for the environment's agent, provide a socket path, or use `none` to disable it. The `agent` method cannot use `none`.

### Passwords and passphrases

`auth.password` and `auth.passphrase` each accept one of these mappings:

```yaml
password: {source: prompt}
```

```yaml
password: {source: file, path: ./secrets/password}
```

```yaml
password: {source: literal, value: example-password}
```

Prompting is the default. File sources must contain a single UTF-8 line; one trailing newline is stripped. Credentials have a maximum length of 1023 UTF-8 bytes and cannot contain NUL, CR or LF.

Bartizan supplies a configured password or passphrase once per connection for its matching OpenSSH prompt. Retries and other prompts come to you. Keyboard-interactive prompts are answered interactively. Literal credentials are plain text in your YAML file, but are redacted from renderer state, the form and command preview.

## Host keys

`host_keys.policy` controls unpinned connections:

| Policy | Behavior |
| --- | --- |
| `ask` | Default. Ask before trusting an unknown key. |
| `strict` | Require a key already in Bartizan's trust store. |
| `accept-new` | Trust unknown keys automatically; reject changed keys. |
| `off` | Disable normal host key checking. |

Bartizan keeps accepted keys in `ssh/known_hosts` inside its application data directory. It does not use your user or system known-hosts files.

Set `host_keys.fingerprints` to a list of `SHA256:` fingerprints to pin keys. A nonempty list takes precedence over the policy and bypasses the trust store. Any listed fingerprint may match. Use an empty list to clear inherited pins.

Obtain fingerprints through a trusted channel. On the server, an administrator can inspect a public host key with:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Pins support plain public host keys, not host certificates. If the server offers several key types, `ssh.HostKeyAlgorithms` can select the type you pinned.

## OpenSSH options

Bartizan starts OpenSSH with `-F none`, so neither user nor system SSH configuration applies. The `ssh` mapping accepts only these options:

| Option | Accepted values | Bartizan default |
| --- | --- | --- |
| `ConnectTimeout` | Integer seconds, 0 to 86400 | `15` |
| `ServerAliveInterval` | Integer seconds, 0 to 86400 | `30` |
| `ServerAliveCountMax` | Integer, 0 to 1000 | `3` |
| `ForwardAgent` | Boolean | `false` |
| `Compression`, `TCPKeepAlive` | Boolean | OpenSSH default |
| `AddressFamily` | `any`, `inet`, `inet6` | OpenSSH default |
| `LogLevel` | `QUIET`, `FATAL`, `ERROR`, `INFO`, `VERBOSE` | OpenSSH default |
| `KexAlgorithms`, `Ciphers`, `MACs`, `HostKeyAlgorithms`, `PubkeyAcceptedAlgorithms` | OpenSSH algorithm list | OpenSSH default |

Algorithm lists accept comma-separated names and the `+`, `-` and `^` prefixes. An empty string leaves OpenSSH's default unchanged. Algorithm availability depends on your installed OpenSSH.
