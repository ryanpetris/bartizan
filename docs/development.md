[Documentation](README.md) · [Project home](../README.md)

# Development

## Run from source

Use Linux with Node.js 24 or newer, npm and OpenSSH. Building the native `node-pty` dependency also needs Python, make and a C++ compiler. Electron needs the desktop libraries listed in [the rig image](../packaging/rig.Dockerfile) and a working Chromium sandbox.

From a checkout:

```sh
npm ci
npm start
```

`npm ci` installs the lockfile's dependency versions and rebuilds native dependencies for Electron. `npm start` builds the app and launches it. To use a separate configuration:

```sh
npm start -- --config ./demo.yaml
```

The app uses one instance per application data directory. For an isolated development instance, set `BARTIZAN_DATA_DIR` to a separate directory before launching. `--config` selects only the YAML file; it does not isolate the trust store or running instance.

## Checks

```sh
npm run typecheck
npm test
npm run rigs -- smoke
```

TypeScript checks the source without emitting files. Unit tests use Node's test runner through `tsx`. The smoke rig launches the real Electron app, opens the connection form and checks the SSH command preview.

Run all rigs or select them by filename without `.mjs`:

```sh
npm run rigs
npm run rigs -- connect profiles order
npm run rigs -- --docker integration
```

Rigs run under Xvfb and drive Electron with Playwright. They use temporary configuration and application data directories. Some start an isolated SSH server; the network rig starts a Docker container. The runner builds the app first unless `--no-build` or `BARTIZAN_EXECUTABLE` is set.

Local execution requires `xvfb-run`. Each rig also checks for its own tools, such as `sshd`, Vim, OpenSSL or xdotool, and skips if they are absent. Check the runner's output for skipped rigs before treating a run as complete.

`--docker` builds the image in `packaging/rig.Dockerfile` and runs the selected rigs there with their dependencies. The network rig runs on the host because it manages its own container. The Docker rig invocation enables the privileges needed for Chromium's sandbox inside the container.

The runner uses software WebGL by default. Set `BARTIZAN_RIG_SOFTWARE_GL=0` to use the normal graphics backend.

## Build and package

`npm run build` bundles the main process, preload, SSH helpers and renderer into `dist/`. It also copies the stylesheet and bundled fonts.

```sh
npm run package
```

Packaging requires Linux x86-64 and Docker. The packaging script rebuilds `node-pty` against Electron in the Debian base image declared by the rig Dockerfile. Electron Builder then writes AppImage, Debian, Arch and tar archives to `release/`.

To check the unpacked packaged application:

```sh
BARTIZAN_EXECUTABLE=release/linux-unpacked/bartizan npm run rigs -- --docker smoke
```

`BARTIZAN_EXECUTABLE` accepts a path relative to the repository for both local and Docker runs.

## Releases

The [release workflow](../.github/workflows/release.yml) runs for tags matching `vX.Y.Z`. It derives the package version from the tag, installs dependencies, checks types and unit tests, builds packages, and runs the smoke rig against the packaged executable. The repository's package version is `0.0.0`.

The workflow generates `SHA256SUMS`, uploads the artifacts, then creates and publishes a GitHub release. Publishing requires pushing a release tag; ordinary local builds do not publish.

See [Architecture](architecture.md) for the source layout and state flow.
