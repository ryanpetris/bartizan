import errno
import hashlib
import json
import os
import pwd
import select
import shlex
import shutil
import socket
import stat
import struct
import sys
import time
from .messages import MAX_BYTES, emit


session_discovery = False

INTERVAL = 2.0
SNAPSHOT_INTERVAL = 60.0
LIMIT = 100
HEADER = struct.Struct("=IHHII")


def identity(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=True).encode()).hexdigest()


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


def monitor(applications):
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
