import fcntl
import http.client
import json
import os
import re
import select
import shutil
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from .applications import read_json, stop, xdg

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def executable():
    found = shutil.which("t3")
    if found:
        return found
    fallback = Path.home() / ".local/bin/t3"
    return str(fallback) if fallback.is_file() and os.access(fallback, os.X_OK) else None


def base_dir():
    """T3 Code's base directory as T3 Code resolves it, with a relative one taken from home, where its servers start."""
    value, home = os.environ.get("T3CODE_HOME", "").strip(), str(Path.home())
    if not value:
        return Path(home, ".t3")
    if value == "~" or value.startswith("~/"):
        value = home + value[1:]
    return Path(os.path.normpath(os.path.join(home, value)))


def answers(url, timeout=3):
    try:
        with opener.open(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (OSError, ValueError, http.client.HTTPException):
        return False


def alive(pid):
    """Whether a process of this account has the pid."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def loopback(url):
    """The scheme, host and port of a loopback HTTP address without credentials, or None."""
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError, AttributeError):
        return None
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or not port or parsed.username or parsed.password:
        return None
    return "http://{}:{}".format("[::1]" if parsed.hostname == "::1" else parsed.hostname, port)


def running(base):
    """The pid and origin of the live loopback server recorded under the base directory, if it answers."""
    record = read_json(base / "userdata/server-runtime.json")
    if not isinstance(record, dict):
        return None
    pid, origin = record.get("pid"), loopback(record.get("origin"))
    if type(pid) is not int or pid <= 0 or not origin or not alive(pid):
        return None
    return (pid, origin) if answers(origin + "/.well-known/t3/environment") else None


def pairing(output, origin):
    """The pairing address from `t3 auth pairing create --json`, which must be a page of the server at `origin`."""
    text = output.decode("utf-8", "replace")
    decoder = json.JSONDecoder()
    # Configuration logging can precede the record.
    for match in re.finditer(r"^\{", text, re.M):
        try:
            record, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(record, dict) and "pairUrl" in record:
            break
    else:
        raise ValueError("T3 Code did not create a pairing link")
    url = record["pairUrl"]
    if not isinstance(url, str) or len(url) > 8192 or loopback(url) != origin:
        raise ValueError("T3 Code created an invalid pairing link")
    return url


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Server:
    """A T3 Code server this helper started, which runs while any of the helper's launches uses it."""

    def __init__(self, process, origin, lock):
        self.process, self.origin, self.lock = process, origin, lock
        self.users = set()
        self.stopping = False


class T3:
    """Shares one T3 Code server per host. A launch reuses a running one, or starts one that runs while any launch of
    this helper uses it, and signs in to it with a pairing link of its own."""

    def __init__(self, launch):
        self.launch = launch
        self.server = None
        self.pid = None

    def start(self):
        launch = self.launch
        program = executable()
        if not program:
            raise ValueError("T3 Code is not installed")
        launch.component = "T3 Code"
        launch.progress("starting")
        base = base_dir()
        # A server stops under the same lock, so no launch finds it while it is going away.
        lock = xdg("XDG_CACHE_HOME", ".cache") / "bartizan/tools/t3/launch.lock"
        while True:
            with launch.lock(lock):
                if not self.attach():
                    if self.server:
                        origin = self.server.origin
                    else:
                        server = running(base)
                        if server:
                            self.pid, origin = server
                        else:
                            origin = self.serve(program, base, lock)
                    break
            # A server of this helper that is going away keeps its record until it has stopped.
            launch.cancel.wait(0.1)
            launch.check()
        launch.progress("loading")
        url = pairing(self.output([program, "auth", "pairing", "create", "--base-dir", str(base), "--json", "--base-url", origin, "--label", "Bartizan"]), origin)
        launch.check()
        launch.ready = True
        launch.emit("ready", view=dict(kind="browser", url=url))

    def attach(self):
        """Uses this helper's server unless it is going away, which this returns."""
        with self.launch.manager.lock:
            server = self.launch.manager.servers.get("t3")
            if server is None:
                return False
            if server.stopping or server.process.poll() is not None:
                return True
            self.use(server)
            return False

    def use(self, server):
        """Joins a server's users, under the manager's lock; the server lasts until its last user leaves."""
        server.users.add(self.launch.id)
        self.server = server
        self.launch.resources.callback(self.detach)

    def detach(self):
        """Leaves the server; the last launch to leave it stops it, holding the lock so no launch finds it going away."""
        server, manager = self.server, self.launch.manager
        with manager.lock:
            server.users.discard(self.launch.id)
            if server.users or server.stopping:
                return
            server.stopping = True
        try:
            # A launch that holds the lock only checks for this server, but one starting another can hold it for long.
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(server.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        break
                    time.sleep(0.1)
                except OSError:
                    break
            # A server stops its own children on interrupt, which takes a while.
            stop(server.process, 10)
        except OSError:
            pass
        finally:
            with manager.lock:
                manager.servers.pop("t3", None)
            server.lock.close()

    def serve(self, program, base, lock):
        launch = self.launch
        home = str(Path.home())
        # Another program can take the chosen port before the server binds it.
        for _ in range(3):
            origin = "http://127.0.0.1:{}".format(free_port())
            # The server announces a credential on its output, which goes unread.
            process = subprocess.Popen([program, "serve", "--host", "127.0.0.1", "--port", origin.rsplit(":", 1)[1], "--base-dir", str(base), home],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                                       env=dict(os.environ, T3CODE_NO_BROWSER="1"), cwd=home)
            try:
                deadline = time.monotonic() + 90
                while process.poll() is None:
                    launch.check()
                    if time.monotonic() > deadline:
                        raise ValueError("T3 Code startup timed out")
                    # The record follows startup, so a launch that finds it after the lock is released uses this server.
                    if answers(origin + "/", timeout=2) and (running(base) or (0, ""))[1] == origin and process.poll() is None:
                        # Only a launch holding the lock registers a server, and it found none.
                        with launch.manager.lock:
                            launch.manager.servers["t3"] = server = Server(process, origin, lock.open("a"))
                            self.use(server)
                        launch.emit("spawned", pid=process.pid)
                        return origin
                    launch.cancel.wait(0.2)
            except BaseException:
                stop(process, 10)
                raise
            stop(process, 10)
        raise ValueError("T3 Code exited while starting")

    def output(self, args):
        launch = self.launch
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            output, deadline = b"", time.monotonic() + 60
            while True:
                launch.check()
                if time.monotonic() > deadline:
                    raise ValueError("T3 Code did not create a pairing link")
                if select.select([process.stdout], [], [], 0.2)[0]:
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    output += chunk
                    if len(output) > 1024 * 1024:
                        raise ValueError("T3 Code did not create a pairing link")
            if process.wait() != 0:
                raise ValueError("T3 Code could not create a pairing link")
            return output
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()

    def wait(self):
        """Waits for the server the launch uses to go away, however it ends; a server someone else started is theirs to stop."""
        launch = self.launch
        while (self.server.process.poll() is None) if self.server else alive(self.pid):
            launch.check()
            launch.cancel.wait(0.5)
        return 0
