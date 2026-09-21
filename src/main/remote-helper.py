"""Remote session discovery and supervised application launches over SSH."""
import contextlib
import errno
import fcntl
import hashlib
import http.cookiejar
import json
import os
import platform
import pwd
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

session_discovery = False

INTERVAL = 2.0
SNAPSHOT_INTERVAL = 60.0
LIMIT = 100
MAX_BYTES = 1024 * 1024
HEADER = struct.Struct("=IHHII")


def identity(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=True).encode()).hexdigest()


emit_lock = threading.Lock()


def emit(message):
    data = json.dumps(message, ensure_ascii=True)
    if len(data) > MAX_BYTES:
        raise ValueError("Session message is too large")
    with emit_lock:
        print(data, flush=True)


def connect(path, deadline):
    left = min(0.5, deadline - time.monotonic())
    if left <= 0:
        raise TimeoutError("Session scan timed out")
    stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stream.settimeout(left)
    try:
        stream.connect(path)
        return stream
    except Exception:
        stream.close()
        raise


def tmux_query(path, args, deadline):
    """tmux protocol 8 command client, with no terminal or attached session."""
    with connect(path, deadline) as stream:
        def send(kind, data=b""):
            stream.sendall(HEADER.pack(kind, HEADER.size + len(data), 0, 8, os.getpid()) + data)

        def read(size):
            data = b""
            while len(data) < size:
                stream.settimeout(max(0.001, min(0.5, deadline - time.monotonic())))
                if time.monotonic() >= deadline:
                    raise TimeoutError("Session scan timed out")
                chunk = stream.recv(size - len(data))
                if not chunk:
                    raise EOFError("tmux closed its socket")
                data += chunk
            return data

        send(100, struct.pack("=i", 0x10000))  # CLIENT_UTF8 keeps output independent of the login locale.
        send(101, b"xterm\0")
        send(102, b"\0")
        send(108, b"/\0")
        send(107, struct.pack("=i", os.getpid()))
        send(106)
        send(200, struct.pack("=i", len(args)) + b"".join(a.encode() + b"\0" for a in args))
        output, errors, streams = bytearray(), bytearray(), {}
        while True:
            kind, size, flags, version, _ = HEADER.unpack(read(HEADER.size))
            if kind == 12:
                raise ValueError("Unsupported tmux socket protocol: {}".format(version & 255))
            if size < HEADER.size or size > 16384 or flags:
                raise ValueError("Invalid tmux socket message")
            data = read(size - HEADER.size)
            if kind in (211, 213):
                width = struct.calcsize("@n")
                count = struct.unpack("@n", data[:width])[0]
                if count < 0 or count > len(data) - width:
                    raise ValueError("Invalid tmux output size")
                (output if kind == 213 else errors).extend(data[width:width + count])
            elif kind == 303:
                number, fd, _ = struct.unpack("=iii", data[:12])
                streams[number] = fd
                send(305, struct.pack("=ii", number, 0 if fd in (1, 2) else errno.EBADF))
            elif kind == 304:
                fd = streams[struct.unpack("=i", data[:4])[0]]
                if fd not in (1, 2):
                    raise ValueError("Unexpected tmux output stream")
                (output if fd == 1 else errors).extend(data[4:])
            elif kind == 306:
                send(308, struct.pack("=ii", struct.unpack("=i", data)[0], 0))
            elif kind == 203:
                code = struct.unpack("=i", data[:4])[0] if data else 0
                if code:
                    raise ValueError(errors.decode("utf-8", "replace").strip() or "tmux query failed")
                return output.decode("utf-8", "replace").removesuffix("\n")
            if len(output) + len(errors) > MAX_BYTES:
                raise ValueError("tmux output is too large")


def command(*args):
    return " ".join(shlex.quote(str(arg)) for arg in args)


def record(source, key, label, group, detail, attached, commands):
    return dict(source=source, key=key, label=label[:4096], group=group, detail=detail[:4096], attached=attached, commands=commands)


def tmux(path, source, stamp, deadline):
    executable = shutil.which("tmux") or "tmux"
    prefix = [executable, "-u", "-S", path]
    rows = tmux_query(path, ["list-sessions", "-F", "#{pid} #{session_id} #{session_attached} #{session_windows} #{session_created}"], deadline).splitlines()
    if len(rows) > LIMIT:
        raise ValueError("Too many tmux sessions")
    found = []
    for row in rows:
        pid, target, clients, windows, created = row.split()
        if not target.startswith("$") or not target[1:].isdecimal():
            raise ValueError("Invalid tmux session identifier")
        name = tmux_query(path, ["display-message", "-p", "-t", target, "#{session_name}"], deadline)
        cwd = tmux_query(path, ["display-message", "-p", "-t", target, "#{pane_current_path}"], deadline)
        if tmux_query(path, ["display-message", "-p", "-t", target, "#{pid} #{session_id}"], deadline) != pid + " " + target:
            raise ValueError("tmux session changed during discovery")
        attach = command(*prefix, "attach-session", "-t", target)
        check = command(*prefix, "display-message", "-p", "-t", target, "#{session_attached}")
        resume = "attached=$({}) || exit; if [ \"$attached\" != 0 ]; then printf '%s\\n' 'Session is attached' >&2; exit 1; fi; exec {}".format(check, attach)
        home = os.path.expanduser("~")
        if cwd == home or cwd.startswith(home + "/"):
            cwd = "~" + cwd[len(home):]
        detail = "{} window{}".format(windows, "" if windows == "1" else "s")
        if cwd:
            detail += " · " + cwd
        if int(clients):
            detail += " · {} client{}".format(clients, "" if clients == "1" else "s")
        found.append(record(source, identity(source, stamp, pid, target, created), name, "tmux", detail, int(clients) > 0,
                            dict(resume=resume, takeover="exec " + command(*prefix, "attach-session", "-d", "-t", target),
                                 stop=command(*prefix, "kill-session", "-t", target))))
    return found


def screen(path, source, stamp, deadline):
    with connect(path, deadline):
        pass
    identifier = os.path.basename(path)
    attached = bool(os.stat(path).st_mode & stat.S_IXUSR)
    prefix = ["env", "SCREENDIR=" + os.path.dirname(path), shutil.which("screen") or "screen"]
    return [record(source, identity(source, stamp), identifier.partition(".")[2] or identifier, "Screen",
                   "Attached" if attached else "", attached,
                   dict(resume="exec " + command(*prefix, "-r", identifier),
                        takeover="exec " + command(*prefix, "-d", "-r", identifier),
                        stop=command(*prefix, "-S", identifier, "-X", "quit")))]


def herdr(path, source, stamp, deadline):
    with connect(path, deadline) as stream:
        stream.sendall(b'{"id":"sessions","method":"workspace.list","params":{}}\n')
        data = bytearray()
        while b"\n" not in data:
            stream.settimeout(max(0.001, min(0.5, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                raise TimeoutError("Session scan timed out")
            chunk = stream.recv(65536)
            if not chunk:
                raise EOFError("Herdr closed its socket")
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise ValueError("Herdr response is too large")
        response = json.loads(data.split(b"\n", 1)[0])
        spaces = response.get("result", {}).get("workspaces")
        if not isinstance(spaces, list):
            raise ValueError("Invalid Herdr workspace listing")
    parent = os.path.dirname(path)
    name = os.path.basename(parent) if os.path.basename(os.path.dirname(parent)) == "sessions" else "default"
    prefix = ["env", "HERDR_SOCKET_PATH=" + path, "HERDR_CLIENT_SOCKET_PATH=" + path.removesuffix(".sock") + "-client.sock", shutil.which("herdr") or "herdr"]
    tabs = sum(s.get("tab_count", 0) for s in spaces if isinstance(s.get("tab_count"), int))
    labels = [s["label"] for s in spaces if isinstance(s.get("label"), str)]
    detail = "{} tab{}".format(tabs, "" if tabs == 1 else "s")
    if labels:
        detail += " · " + ", ".join(labels)
    return [record(source, identity(source, stamp), name, "Herdr", detail, False,
                   dict(resume="exec " + command(*prefix), stop=command(*prefix, "server", "stop")))]


def candidates():
    """Common directories plus explicit inherited socket locations, without executing backends."""
    user = pwd.getpwuid(os.getuid()).pw_name
    home = os.path.expanduser("~")
    paths, errors = {}, []

    def add(backend, path):
        paths[os.path.abspath(path)] = backend

    def directory(backend, path):
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    if len(paths) >= 1024:
                        raise ValueError("Too many session sockets")
                    if backend == "herdr":
                        if entry.is_dir(follow_symlinks=False):
                            add(backend, os.path.join(entry.path, "herdr.sock"))
                    elif stat.S_ISSOCK(entry.stat(follow_symlinks=False).st_mode):
                        add(backend, entry.path)
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as error:
            errors.append(dict(message=(path + ": " + str(error))[:1024]))

    directory("tmux", os.path.join(os.environ.get("TMUX_TMPDIR", "/tmp"), "tmux-" + str(os.getuid())))
    if os.environ.get("TMUX"):
        add("tmux", os.environ["TMUX"].split(",")[0])
    for root in set(map(os.path.realpath, filter(None, [os.environ.get("SCREENDIR"), "/run/screen/S-" + user, "/var/run/screen/S-" + user, "/tmp/screens/S-" + user, "/tmp/uscreens/S-" + user, os.path.join(home, ".screen")]))):
        directory("screen", os.path.realpath(root))
    config = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config")), "herdr")
    add("herdr", os.path.join(config, "herdr.sock"))
    directory("herdr", os.path.join(config, "sessions"))
    if os.environ.get("HERDR_SOCKET_PATH"):
        add("herdr", os.environ["HERDR_SOCKET_PATH"])
    return paths, errors


def monitor():
    global session_discovery
    known, previous = {}, {}
    next_scan = next_snapshot = 0.0
    pending = bytearray()
    while True:
        now = time.monotonic()
        if now >= next_scan:
            paths, errors = candidates() if session_discovery else ({}, [])
            if not session_discovery:
                known.clear()
                previous.clear()
            known.update(paths)
            covered, sessions = [], []
            deadline = time.monotonic() + 10
            for path, backend in list(known.items()):
                source = identity(backend, path)
                try:
                    metadata = os.stat(path)
                    if not stat.S_ISSOCK(metadata.st_mode):
                        raise ValueError("Session path is not a socket")
                    if metadata.st_uid != os.getuid():
                        raise ValueError("Session socket is not owned by this user")
                    stamp = [metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns]
                    found = globals()[backend](path, source, stamp, min(deadline, time.monotonic() + 2))
                    if len(sessions) + len(found) > LIMIT:
                        raise ValueError("Too many remote sessions")
                except OSError as error:
                    if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
                        found = []
                    else:
                        errors.append(dict(source=source, message=(backend + ": " + path + ": " + str(error))[:1024]))
                        continue
                except Exception as error:
                    errors.append(dict(source=source, message=(backend + ": " + path + ": " + str(error))[:1024]))
                    continue
                covered.append(source)
                sessions.extend(found)
                current = {s["key"]: s for s in found}
                old = previous.get(source, {})
                for key in old.keys() - current.keys():
                    emit(dict(type="sessions.remove", source=source, key=key))
                for key, session in current.items():
                    if old.get(key) != session:
                        emit(dict(type="sessions.upsert", source=source, session=session))
                previous[source] = current
            if now >= next_snapshot:
                emit(dict(type="sessions.snapshot", sources=covered, sessions=sessions, errors=errors))
                next_snapshot = time.monotonic() + SNAPSHOT_INTERVAL
                for path in list(known):
                    source = identity(known[path], path)
                    if path not in paths and source in covered and not previous.get(source):
                        del known[path]
                        previous.pop(source, None)
            next_scan = time.monotonic() + INTERVAL
        if select.select([sys.stdin], [], [], max(0, next_scan - time.monotonic()))[0]:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                return
            pending.extend(chunk)
            if len(pending) > 65536:
                raise ValueError("Helper request is too large")
            while b"\n" in pending:
                line, _, tail = pending.partition(b"\n")
                pending[:] = tail
                message = json.loads(line)
                if message.get("type", "").startswith("applications."):
                    applications.request(message)
                elif message.get("type") == "sessions.configure":
                    session_discovery = message["enabled"]
                    next_scan = next_snapshot = 0.0
                elif message.get("type") == "sessions.refresh":
                    next_scan = next_snapshot = 0.0


def xdg(name, default):
    value = os.environ.get(name, "")
    return Path(value) if os.path.isabs(value) else Path.home() / default


def version_key(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("Invalid release")
    return tuple(map(int, value.split(".")))


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


class Cancelled(Exception):
    pass


class Launch:
    def __init__(self, manager, request):
        self.manager = manager
        self.id = request["launchId"]
        self.application = request["application"]
        self.options = request.get("options", {})
        self.cancel = threading.Event()
        self.answer = threading.Event()
        self.consent_id = None
        self.accepted = False
        self.process = None
        self.ready = False
        self.component = None
        self.cached = False
        self.resources = contextlib.ExitStack()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def emit(self, kind, **fields):
        self.manager.emit(dict(type="applications." + kind, launchId=self.id, **fields))

    def check(self):
        if self.cancel.is_set():
            raise Cancelled()

    def progress(self, phase, **fields):
        self.check()
        if self.component:
            fields["component"] = self.component
        if self.cached:
            fields["usingCachedRelease"] = True
        self.emit("progress", phase=phase, **fields)

    @contextlib.contextmanager
    def lock(self, path, shared=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as file:
            while True:
                self.check()
                try:
                    fcntl.flock(file, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    self.cancel.wait(0.1)
            yield

    def download(self, url, target, checksum):
        if urllib.parse.urlsplit(url).scheme != "https":
            raise ValueError("Download requires HTTPS")
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=15) as response, target.open("wb") as output:
            if urllib.parse.urlsplit(response.url).scheme != "https":
                raise ValueError("Download requires HTTPS")
            total = int(response.headers.get("Content-Length", "0"))
            received, reported = 0, 0
            while True:
                self.check()
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > 512 * 1024 * 1024:
                    raise ValueError("Download is too large")
                output.write(chunk)
                digest.update(chunk)
                if time.monotonic() - reported > 0.25:
                    transfer = dict(receivedBytes=received)
                    if total:
                        transfer["totalBytes"] = total
                    self.progress("downloading", transfer=transfer)
                    reported = time.monotonic()
        if digest.hexdigest() != checksum:
            raise ValueError("Download checksum does not match")

    def extract(self, archive, destination):
        self.progress("extracting")
        total = 0
        with tarfile.open(archive) as source:
            for member in source:
                self.check()
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                    raise ValueError("Unsafe archive entry")
                total += member.size
                if total > 1024 * 1024 * 1024:
                    raise ValueError("Archive is too large")
                target = destination / path
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(member) as incoming, target.open("wb") as output:
                        shutil.copyfileobj(incoming, output)
                    target.chmod(0o700 if member.mode & 0o111 else 0o600)

    def install(self, cache, fetch_release, executable, release_order=version_key, valid_release=lambda record: True):
        launch = self
        launch.progress("checking")
        cache.mkdir(parents=True, exist_ok=True)
        try:
            release = fetch_release()
        except Exception:
            launch.check()
            cached = []
            for directory in cache.iterdir():
                try:
                    release_order(directory.name)
                    record = read_json(directory / "release.json")
                    if record and valid_release(record) and record["name"] == directory.name and (directory / "complete").is_file() and os.access(directory / executable, os.X_OK):
                        cached.append((release_order(directory.name), directory, record))
                except (ValueError, KeyError, TypeError):
                    continue
            if not cached:
                raise ValueError("Could not check for updates and no complete cached application installation is available")
            _, directory, release = max(cached)
            self.resources.enter_context(self.lock(cache / ("." + directory.name + ".lock"), shared=True))
            release = read_json(directory / "release.json")
            if not release or not valid_release(release) or not (directory / "complete").is_file():
                raise ValueError("Cached application installation is incomplete")
            launch.cached = True
            launch.progress("starting", release=release["name"])
            return directory, release
        directory = cache / release["name"]
        identity = lambda record: tuple(record.get(key) for key in ("name", "version", "sha256hash")) if isinstance(record, dict) else None
        version_lock = cache / ("." + release["name"] + ".lock")
        with launch.lock(cache / "install.lock"):
            if identity(read_json(directory / "release.json")) != identity(release) or not os.access(directory / executable, os.X_OK):
                # Replacing a damaged cache must not remove files from a running server.
                with launch.lock(version_lock), tempfile.TemporaryDirectory(prefix=".download-", dir=cache) as temporary:
                    stage = Path(temporary)
                    launch.progress("downloading", release=release["name"])
                    launch.download(release["url"], stage / "archive", release["sha256hash"])
                    payload = stage / "payload"
                    payload.mkdir()
                    launch.extract(stage / "archive", payload)
                    if not os.access(payload / executable, os.X_OK):
                        raise ValueError("Application archive contains no executable")
                    atomic_json(payload / "release.json", release)
                    old = stage / "previous"
                    if directory.exists():
                        os.rename(directory, old)
                    try:
                        os.rename(payload, directory)
                    except BaseException:
                        if old.exists():
                            os.rename(old, directory)
                        raise
            self.resources.enter_context(self.lock(version_lock, shared=True))
        return directory, release

    def consent(self, text, prompt=None):
        if not text.strip():
            raise ValueError("Application did not provide its consent notice")
        self.consent_id = secrets.token_hex(16)
        self.accepted = False
        self.answer.clear()
        content = dict(text=text)
        if prompt:
            content["prompt"] = prompt
        self.emit("consent", consentId=self.consent_id, content=content)
        while not self.answer.wait(0.1):
            self.check()
        self.consent_id = None
        self.check()
        if not self.accepted:
            raise Cancelled()

    def spawn(self, args):
        self.check()
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, start_new_session=True)
        return self.process

    def stop_process(self):
        process, self.process = self.process, None
        if process is None:
            return
        # The CLI owns server children which can outlive the CLI itself.
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()

    def run(self):
        reason, error, exit_code = "failed", None, None
        try:
            adapter = APPLICATIONS.get(self.application)
            if adapter is None:
                raise ValueError("Unknown application")
            adapter(self).start()
            while self.process.poll() is None:
                self.check()
                # Drain output so a verbose server cannot block on its pipe.
                if select.select([self.process.stdout], [], [], 0.2)[0]:
                    os.read(self.process.stdout.fileno(), 65536)
            exit_code = self.process.returncode
            reason = "exited" if exit_code == 0 else "failed"
            if exit_code:
                error = dict(code="process_exited", message="Application process exited unexpectedly")
        except Cancelled:
            reason = "stopped" if self.ready else "cancelled"
        except Exception as failure:
            # URLs and subprocess output may contain authentication tokens.
            error = dict(code="launch_failed", message=str(failure)[:2048] if isinstance(failure, ValueError) else "Application launch failed: " + type(failure).__name__)
        finally:
            self.stop_process()
            self.resources.close()
            fields = dict(reason=reason)
            if error:
                fields["error"] = error
            if exit_code is not None:
                fields["exitCode"] = exit_code
            self.emit("ended", **fields)
            with self.manager.lock:
                self.manager.launches.pop(self.id, None)


class VSCode:
    def __init__(self, launch):
        self.launch = launch
        self.cache = xdg("XDG_CACHE_HOME", ".cache") / "bartizan/tools/vscode"
        self.data = xdg("XDG_DATA_HOME", ".local/share") / "bartizan/tools/vscode"

    def release(self):
        machine = {"x86_64": "x64", "aarch64": "arm64", "armv7l": "armhf"}.get(platform.machine())
        if platform.system() != "Linux" or not machine:
            raise ValueError("Visual Studio Code requires a supported Linux architecture")
        target = "cli-linux-" + machine
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


APPLICATIONS = {"vscode": VSCode}


class Applications:
    def __init__(self, emit):
        self.emit = emit
        self.launches = {}
        self.lock = threading.Lock()

    def request(self, message):
        kind, identifier = message.get("type"), message.get("launchId")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", identifier):
            raise ValueError("Invalid launch identifier")
        with self.lock:
            launch = self.launches.get(identifier)
            if kind == "applications.launch":
                if launch:
                    return
                if len(self.launches) >= 16:
                    self.emit(dict(type="applications.ended", launchId=identifier, reason="failed", error=dict(code="launch_limit", message="Application limit reached")))
                    return
                launch = Launch(self, message)
                self.launches[identifier] = launch
                launch.thread.start()
            elif launch and kind == "applications.stop":
                launch.cancel.set()
            elif launch and kind == "applications.respond" and message.get("consentId") == launch.consent_id and isinstance(message.get("accepted"), bool) and not launch.answer.is_set():
                launch.accepted = message["accepted"]
                launch.answer.set()

    def close(self):
        with self.lock:
            launches = list(self.launches.values())
            for launch in launches:
                launch.cancel.set()
        for launch in launches:
            launch.thread.join(timeout=20)


if __name__ == "__main__":
    applications = Applications(emit)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        monitor()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        applications.close()
