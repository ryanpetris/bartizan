[Documentation](README.md) · [Project home](../README.md)

# Development

## Run From Source

Use Linux or macOS with Node.js 24 or newer, npm and OpenSSH. Building the native `node-pty` dependency also needs Python, make and a C++ compiler. On macOS, install Xcode Command Line Tools with `xcode-select --install`. On Linux, Electron needs the desktop libraries listed in [the rig image](../packaging/rig.Dockerfile) and a working Chromium sandbox.

From a checkout:

```sh
npm ci
npm start
```

`npm ci` installs the lockfile's dependency versions and downloads the development Electron runtime with `install-electron`. The `node-pty` installer uses its prebuilt binary on macOS and compiles it on Linux. Its Node-API binary runs in both Node and Electron. `npm start` builds the app and launches it. To use a separate configuration:

```sh
npm start -- --config ./demo.yaml
```

For development with automatic updates:

```sh
npm run dev
```

Vite serves the renderer on loopback with React Fast Refresh and CSS updates, including styles in overlays. Component edits can preserve React state; edits outside refresh boundaries reload the renderer. Preload edits also reload the renderer. Main-process and backend edits restart Electron and disconnect live sessions. Renderer reloads keep the backend running.

Pass application arguments after an extra separator, for example `npm run dev -- -- --config ./demo.yaml`. `npm start`, `npm run build` and packaging use the production build.

The app uses one instance per application data directory. For an isolated development instance, set `BARTIZAN_DATA_DIR` to a separate directory before launching. `--config` selects only the YAML file; it does not isolate the trust store or running instance.

## Checks

```sh
npm run typecheck
npm test
npx tsx --import ./tests/program-text.mjs --test tests/sessions-resize.test.ts
npm run rigs -- smoke
```

TypeScript checks the source without emitting files. Unit tests use Node's test runner through `tsx`, which loads helper programs as text; run one file with the command above. The smoke rig launches the real Electron app, opens the connection form and checks the SSH command preview.

Run all rigs or select them by filename without `.mjs`:

```sh
npm run rigs
npm run rigs -- connect profiles order
npm run rigs -- --docker integration
```

Rigs run under Xvfb and drive Electron with Playwright. The `web` rig starts both the Node server and Electron `serve` without a display, then drives Chromium against each, exercising the same terminal and configuration backend. It requires `chromium`; `BARTIZAN_CHROMIUM` can select its executable. They use temporary configuration and application data directories. Some start an isolated SSH server; the network rig starts a Docker container. The runner builds the app first unless `--no-build` or `BARTIZAN_EXECUTABLE` is set.

The `dev` rig runs `npm run dev` in a temporary source copy and edits that copy to check component and CSS updates, font loading, renderer reloads and Electron restarts.

Local execution requires `xvfb-run`. Each rig also checks for its own tools, such as `sshd`, Vim, OpenSSL or xdotool, and skips if they are absent. Check the runner's output for skipped rigs before treating a run as complete.

`--docker` installs dependencies and builds the application inside `packaging/rig.Dockerfile`, then runs the selected rigs there. The image has its own dependencies and output. Packaged runs mount only the executable's directory. The network rig runs on the host because it manages its own container. The Docker rig invocation enables the privileges needed for Chromium's sandbox inside the container.

The runner uses software WebGL by default. Set `BARTIZAN_RIG_SOFTWARE_GL=0` to use the normal graphics backend.

## Screenshots

```sh
npm run screenshots
```

This regenerates `docs/images/bartizan.png`, the animated screenshot in the README, which shows the Rail, Tabs and Console themes in turn. Docker installs dependencies, builds the app and captures inside the rig image. The workspace is synthetic: an SSH server in the container whose shell prints canned output, and a small web app served there for the browser sessions. Nothing of the machine running the script appears in the image. `npm run screenshots -- --no-build` uses the existing rig image.

## Build and Package

`npm run build` uses Vite to bundle the Electron main process, web server and SSH helpers into `out/main/`, the preload into `out/preload/`, and the renderer into `out/renderer/`. The renderer includes its styles, font worker, bundled fonts and font licenses.

```sh
make portable
```

Portable packaging requires Linux x86-64 and Docker. Dependencies and the application are built inside the pinned Debian 12 image in `packaging/build.Dockerfile`. Electron Builder writes an AppImage and tar archive to `release/`, automatically unpacking native modules from ASAR.

Native packages consume the same validated tar archive. Run these commands on the target distribution with its packaging tools installed:

```sh
make arch
make deb
```

Arch uses `makepkg`. Debian and Ubuntu use `dpkg-buildpackage`, debhelper and `dh_shlibdeps` to calculate library dependencies. Both install into `/opt/bartizan`, with a launcher in `/usr/bin`, a desktop entry, icon and license. Native packages install the setuid Chromium sandbox helper; Debian packages also install an AppArmor user namespace profile. Packages are written to `build/packages/`. `BARTIZAN_ARCHIVE` selects another portable tar archive; `DEB_DISTRIBUTION` and `DEB_REVISION` select the Debian package suffix.

To check the unpacked packaged application:

```sh
BARTIZAN_EXECUTABLE=release/linux-unpacked/bartizan npm run rigs -- --docker smoke
```

`BARTIZAN_EXECUTABLE` accepts a path relative to the repository for both local and Docker runs.

On an Apple Silicon Mac:

```sh
make mac
```

Electron Builder writes `release/mac-arm64/Bartizan.app` and a `bartizan-<version>-mac-arm64.dmg` to `release/`. Packaging uses an ad-hoc signature, with hardened runtime and notarization disabled. It needs no Apple Developer account, certificates or signing secrets. Chromium's renderer sandbox remains enabled.

`BARTIZAN_VERSION` supplies a strict `X.Y.Z` application version, defaulting to `0.0.0`, without editing either package manifest. `SOURCE_DATE_EPOCH` defaults to the current commit's timestamp. `make check` runs type, unit and packaging validation tests. `make clean` clears generated build output.

## Releases

The [release workflow](../.github/workflows/release.yml) validates `vX.Y.Z` tags and passes the version and commit timestamp to each build. Linux portable packages feed Arch and distribution-specific Debian 13, Ubuntu 24.04 and Ubuntu 26.04 package jobs. Checks cover archive boundaries, package installation, reinstall and removal, system libraries, native PTY operations, the AppImage launcher and the installed desktop with sandboxing enabled. The Apple Silicon job checks PTY operations under Node and packaged Electron, plus the packaged `serve` command. The repository's package version is `0.0.0`.

The workflow requires every expected package and verifies `SHA256SUMS` before creating and publishing a GitHub release. Publishing requires pushing a release tag; ordinary local builds do not publish.

See [Architecture](architecture.md) for the source layout and state flow.

See [Remote helper](remote-helper.md) for the session stream, message subscriptions and socket discovery checks.

## Python helper

Building and developing Bartizan requires Python 3.9 or later on `PATH` as `python3`. The build packages `src/main/remote-helper/__main__.py` and the `helper/` package into a compressed zipapp embedded in the application bundle. `loader.py` is bundled separately as bootstrap source. Development builds watch the Python modules and rebuild the archive when they change.
