"""Socket integration checks; run by the sessions Docker rig."""
import importlib.util
import json
import os
import pwd
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location("helper", Path(__file__).parents[1] / "src/main/remote-helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def run():
    with tempfile.TemporaryDirectory(prefix="helper-") as directory:
        root = Path(directory)
        sockets = root / ("tmux-" + str(os.getuid()))
        sockets.mkdir()
        path = str(sockets / "quoted ' 雪")
        def tmux(*args):
            return subprocess.check_output(["tmux", "-S", path, *args], stderr=subprocess.PIPE)
        tmux("-f", "/dev/null", "new-session", "-d", "-s", "unicode-雪-🚀", "sleep 300")
        child = None
        try:
            metadata = os.stat(path)
            before = tmux("list-sessions", "-F", "#{session_attached} #{window_width} #{window_height}")
            os.environ["LC_ALL"] = "C"
            records = helper.tmux(path, "source", [metadata.st_ino], time.monotonic() + 3)
            assert records[0]["label"] == "unicode-雪-🚀", records
            assert before == tmux("list-sessions", "-F", "#{session_attached} #{window_width} #{window_height}")
            assert path in subprocess.check_output(["sh", "-c", "printf '%s' " + helper.command(path)]).decode()
            # The production monitor runs with no tmux/screen/herdr executable on PATH.
            env = {**os.environ, "TMUX_TMPDIR": directory, "XDG_CONFIG_HOME": directory, "PATH": str(root / "no-executables")}
            env.pop("TMUX", None)
            invalid = root / "herdr" / "herdr.sock"
            invalid.parent.mkdir()
            invalid.write_text("not a socket")
            program = "import runpy; m=runpy.run_path(" + repr(spec.origin) + "); m['monitor'].__globals__.update(INTERVAL=.1,SNAPSHOT_INTERVAL=.4); m['monitor']()"
            child = subprocess.Popen([sys.executable, "-u", "-c", program], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            pending = bytearray()
            def message(kind, predicate=lambda m: True):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if b"\n" not in pending:
                        if not select.select([child.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                            break
                        data = os.read(child.stdout.fileno(), 65536)
                        assert data, "helper exited"
                        pending.extend(data)
                    while b"\n" in pending:
                        line, _, tail = pending.partition(b"\n")
                        pending[:] = tail
                        result = json.loads(line)
                        if result["type"] == kind and predicate(result):
                            return result
                raise AssertionError("No matching " + kind)
            first = message("sessions.snapshot")
            assert any(str(invalid) in error["message"] and "not a socket" in error["message"] for error in first["errors"]), first
            found = next(s for s in first["sessions"] if s["label"] == "unicode-雪-🚀")
            message("sessions.snapshot")  # Periodic reconciliation without a request.
            tmux("rename-session", "-t", "$0", "renamed")
            update = message("sessions.upsert", lambda m: m["session"]["label"] == "renamed")
            assert update["session"]["key"] == found["key"]
            tmux("kill-server")
            message("sessions.remove", lambda m: m["key"] == found["key"])
            child.stdin.write(b'{"type":"sessions.refresh"}\n'); child.stdin.flush()
            message("sessions.snapshot", lambda m: not any(s["source"] == found["source"] for s in m["sessions"]))
            child.stdin.close()
            assert child.wait(timeout=3) == 0, child.stderr.read()
        finally:
            if child and child.poll() is None:
                child.kill(); child.wait()
            try:
                tmux("kill-server")
            except subprocess.CalledProcessError:
                pass

        # A real Unix listener verifies the Herdr request and response contract.
        path = str(root / "herdr.sock")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(path); server.listen()
            errors = []
            def serve():
                try:
                    with server.accept()[0] as stream:
                        request = json.loads(stream.recv(4096))
                        assert request["method"] == "workspace.list"
                        stream.sendall(json.dumps({"id": request["id"], "result": {"workspaces": [{"label": "build", "tab_count": 2}]}}).encode() + b"\n")
                except Exception as error:
                    errors.append(error)
            worker = threading.Thread(target=serve); worker.start()
            records = helper.herdr(path, "herdr", [os.stat(path).st_ino], time.monotonic() + 2)
            worker.join(timeout=3)
            assert not errors, errors
            assert records[0]["detail"] == "2 tabs · build", records
            assert "HERDR_SOCKET_PATH=" + path in records[0]["commands"]["resume"]

        # Screen's conventional /tmp socket directory works without SCREENDIR in the helper environment.
        screen_root = Path("/tmp/screens") / ("S-" + pwd.getpwuid(os.getuid()).pw_name)
        existed = screen_root.exists()
        screen_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = root.name
        env = {**os.environ, "SCREENDIR": str(screen_root)}
        subprocess.run(["screen", "-dmS", name, "sleep", "300"], env=env, check=True)
        try:
            path = None
            for _ in range(40):
                path = next((str(p) for p in screen_root.iterdir() if p.name.endswith("." + name)), None)
                if path:
                    break
                time.sleep(.05)
            assert path, "Screen did not create its socket"
            inherited = os.environ.pop("SCREENDIR", None)
            try:
                assert helper.candidates()[0][path] == "screen"
            finally:
                if inherited is not None:
                    os.environ["SCREENDIR"] = inherited
            assert helper.screen(path, "screen", [os.stat(path).st_ino], time.monotonic() + 2)[0]["label"] == name
        finally:
            subprocess.run(["screen", "-S", name, "-X", "quit"], env=env, check=True)
            if not existed:
                for _ in range(40):
                    if not any(screen_root.iterdir()):
                        break
                    time.sleep(.05)
                screen_root.rmdir()
    print("Helper socket checks passed: UTF-8, unchanged attachments, executable-free discovery, updates, snapshots, EOF and Herdr RPC.")


if __name__ == "__main__":
    run()
