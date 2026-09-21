import hashlib
import http.cookiejar
import json
import os
import platform
import re
import select
import time
import urllib.parse
import urllib.request
from .applications import atomic_json, read_json, xdg, version_key


class VSCode:
    def __init__(self, launch):
        self.launch = launch
        self.cache = xdg("XDG_CACHE_HOME", ".cache") / "bartizan/tools/vscode"
        self.data = xdg("XDG_DATA_HOME", ".local/share") / "bartizan/tools/vscode"

    def release(self):
        target = {
            ("Linux", "x86_64"): "cli-linux-x64",
            ("Linux", "aarch64"): "cli-linux-arm64",
            ("Linux", "armv7l"): "cli-linux-armhf",
            ("Darwin", "x86_64"): "cli-darwin-x64",
            ("Darwin", "arm64"): "cli-darwin-arm64",
        }.get((platform.system(), platform.machine()))
        if not target:
            raise ValueError("Visual Studio Code requires a supported Linux or macOS architecture")
        with urllib.request.urlopen("https://update.code.visualstudio.com/api/update/" + target + "/stable/latest", timeout=10) as response:
            release = json.loads(response.read(65536))
        version_key(release["name"])
        if not re.fullmatch(r"[a-f0-9]{40}", release["version"]) or not re.fullmatch(r"[a-f0-9]{64}", release["sha256hash"]):
            raise ValueError("Invalid release metadata")
        return release

    def start(self):
        launch = self.launch
        if not isinstance(launch.options, dict) or set(launch.options) - {"folder"}:
            raise ValueError("Unsupported Visual Studio Code options")
        folder = launch.options.get("folder")
        if folder is not None and (not isinstance(folder, str) or not os.path.isabs(folder) or "\0" in folder or len(folder) > 4096):
            raise ValueError("Invalid project folder")
        launch.component = "Visual Studio Code Launcher"
        directory, release = launch.install(self.cache, self.release, "code", valid_release=lambda record: isinstance(record, dict) and isinstance(record.get("version"), str) and re.fullmatch(r"[a-f0-9]{40}", record["version"]))
        launch.component = "Visual Studio Code"
        self.data.mkdir(parents=True, exist_ok=True)
        # Serialize initial CLI token creation; the CLI locks its own server downloads.
        with launch.lock(directory / "launch.lock"):
            launch.progress("starting", release=release["name"])
            args = [str(directory / "code"), "serve-web", "--host", "127.0.0.1", "--port", "0",
                    "--cli-data-dir", str(directory / "cli-data"), "--server-data-dir", str(self.data / "server-data"),
                    "--commit-id", release["version"], "--log", "trace"]
            if folder:
                args += ["--default-folder", folder]
            process = launch.spawn(args)
            notice, notice_size, buffer, url = [], 0, b"", None
            deadline = time.monotonic() + 45
            while url is None:
                launch.check()
                if time.monotonic() > deadline:
                    raise ValueError("Visual Studio Code did not report a listening address")
                if not select.select([process.stdout], [], [], 0.1)[0]:
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError("Visual Studio Code exited before reporting a listening address")
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").rstrip("\r")
                    if text.startswith("Web UI available at "):
                        url = text.removeprefix("Web UI available at ")
                        break
                    if re.match(r"\[\d{4}-\d{2}-\d{2} [^]]+\] (trace|debug|info|warn|error|critical) ", text):
                        continue
                    notice_size += len(text.encode("utf-16-le")) // 2 + 1
                    if notice_size > 32768:
                        raise ValueError("Visual Studio Code notice is too large")
                    notice.append(text)
                if len(buffer) > 65536:
                    raise ValueError("Visual Studio Code startup output is too large")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password:
            raise ValueError("Visual Studio Code reported an invalid listening address")
        text = "\n".join(notice).strip()
        if not text:
            raise ValueError("Visual Studio Code did not provide its license notice")
        digest = hashlib.sha256(text.encode()).hexdigest()
        consent_file = self.data / "consent" / (digest + ".json")
        if read_json(consent_file) != {"accepted": True}:
            launch.consent(text)
            atomic_json(consent_file, {"accepted": True})
        launch.progress("loading", release=release["name"])
        deadline = time.monotonic() + 180
        phase = "loading"
        # The launcher fetches and runs the server itself, so that stretch of the launch reports on the server.
        application, server = launch.component, launch.component + " Server"
        # The CLI prints its address before downloading and starting the web server.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        while True:
            launch.check()
            if process.poll() is not None:
                raise ValueError("Visual Studio Code exited while loading")
            if time.monotonic() > deadline:
                raise ValueError("Visual Studio Code startup timed out")
            try:
                with opener.open(url, timeout=2) as response:
                    body = response.read(2 * 1024 * 1024)
                    next_phase = ("downloading" if phase == "loading" else phase) if response.status == 202 else "loading"
                    if next_phase != phase:
                        phase = next_phase
                        launch.component = application if phase == "loading" else server
                        launch.progress(phase, release=release["name"])
                    if response.status == 200 and b"workbench" in body and b"vscode" in body:
                        break
            except (OSError, urllib.error.URLError):
                pass
            if select.select([process.stdout], [], [], 0)[0]:
                buffer += os.read(process.stdout.fileno(), 65536)
            update = None
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                progress = re.fullmatch(rb"\[\d{4}-\d{2}-\d{2} [^]]+\] trace Downloading server: (\d+)/(\d+)(?: \(\d+%\))?\r?", line)
                if progress:
                    received, total = map(int, progress.groups())
                    if total and received > total:
                        continue
                    transfer = dict(receivedBytes=received)
                    if total:
                        transfer["totalBytes"] = total
                    phase = "extracting" if total and received == total else "downloading"
                    update = dict(transfer=transfer) if phase == "downloading" else {}
                elif re.fullmatch(rb"\[\d{4}-\d{2}-\d{2} [^]]+\] info Starting server [a-f0-9]{40}\r?", line):
                    phase, update = "starting", {}
            if update is not None:
                launch.component = application if phase == "loading" else server
                launch.progress(phase, release=release["name"], **update)
            # Only incomplete log lines need buffering; discard oversized diagnostics.
            if len(buffer) > 65536:
                buffer = b""
            launch.cancel.wait(0.2)
        (directory / "complete").touch()
        launch.check()
        launch.ready = True
        launch.emit("ready", release=release["name"], view=dict(kind="browser", url=url))
