import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


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
        with archive.open("rb") as header:
            zipped = header.read(4) == b"PK\x03\x04"
        with (zipfile.ZipFile(archive) if zipped else tarfile.open(archive)) as source:
            for member in source.infolist() if zipped else source:
                self.check()
                if zipped:
                    path = Path(member.filename)
                    mode = member.external_attr >> 16
                    directory = member.is_dir()
                    regular = stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and (not stat.S_ISDIR(mode) or directory)
                    size = member.file_size
                else:
                    path, mode, size = Path(member.name), member.mode, member.size
                    directory, regular = member.isdir(), member.isfile() or member.isdir()
                if path.is_absolute() or ".." in path.parts or not regular:
                    raise ValueError("Unsafe archive entry")
                total += size
                if total > 1024 * 1024 * 1024:
                    raise ValueError("Archive is too large")
                target = destination / path
                if directory:
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with (source.open(member) if zipped else source.extractfile(member)) as incoming, target.open("wb") as output:
                        shutil.copyfileobj(incoming, output)
                    target.chmod(0o700 if mode & 0o111 else 0o600)

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
            adapter = self.manager.adapters.get(self.application)
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


class Applications:
    def __init__(self, emit, adapters):
        self.emit = emit
        self.adapters = adapters
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
