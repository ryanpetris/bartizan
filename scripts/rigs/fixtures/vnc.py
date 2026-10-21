"""An isolated SSH host with two TigerVNC desktops and a Unix-socket SSH bridge. The first desktop accepts remote resizing
and the second refuses it."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time


def desktop(directory, index):
    import tkinter as tk

    root = tk.Tk()
    root.overrideredirect(True)
    root.geometry("640x480+0+0")
    canvas = tk.Canvas(root, background="#cc2233", highlightthickness=0)
    canvas.pack(fill="both", expand=True)

    def record(kind, event, color):
        canvas.configure(background=color)
        with (directory / f"input-{index}.jsonl").open("a") as stream:
            stream.write(json.dumps({"kind": kind, "key": event.keysym if kind != "mouse" else None,
                                     "x": event.x, "y": event.y, "state": event.state}) + "\n")

    canvas.bind("<KeyPress>", lambda event: record("key", event, "#22bb44"))
    canvas.bind("<KeyRelease>", lambda event: record("release", event, "#22bb44"))
    canvas.bind("<ButtonPress>", lambda event: record("mouse", event, "#2244cc"))

    # The driver sets the desktop's clipboard through a file, and each text the clipboard takes is recorded.
    copied = [None]

    def clipboard():
        request = directory / f"copy-{index}"
        if request.exists():
            root.clipboard_clear()
            root.clipboard_append(request.read_text())
            request.unlink()
        try:
            text = root.clipboard_get()
        except tk.TclError:
            text = None
        if text is not None and text != copied[0]:
            copied[0] = text
            with (directory / f"clipboard-{index}.jsonl").open("a") as stream:
                stream.write(json.dumps(text) + "\n")
        root.after(200, clipboard)

    root.after(200, clipboard)

    # The pointer over the desktop has no visible pixels, as the X server's own has none, until the driver gives it a
    # shape through a file.
    def pointer():
        request = directory / f"pointer-{index}"
        if request.exists():
            canvas.configure(cursor=request.read_text())
            request.unlink()
        root.after(200, pointer)

    root.after(200, pointer)
    canvas.focus_force()
    root.after(100, lambda: (directory / f"desktop-{index}").touch())
    root.mainloop()


def bridge(client, port):
    with client, socket.create_connection(("127.0.0.1", port)) as upstream:
        def copy(source, target):
            try:
                while data := source.recv(65536):
                    target.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    target.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
        thread = threading.Thread(target=copy, args=(client, upstream), daemon=True)
        thread.start()
        copy(upstream, client)
        thread.join()


def serve(directory, port):
    # Keep fixture files shared with the driver while X sockets and locks stay private.
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=1777", "tmpfs", "/tmp"], check=True)
        directory.mkdir(parents=True, exist_ok=True)
        subprocess.run(["mount", "--no-canonicalize", "--bind", f"/proc/{os.getpid()}/fd/{directory_fd}", str(directory)], check=True)
    finally:
        os.close(directory_fd)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    subprocess.run(["ip", "address", "add", "192.0.2.20/32", "dev", "lo"], check=True)
    children = []
    servers = {}

    def start(index):
        display = f":{80 + index}"
        marker = directory / f"desktop-{index}"
        marker.unlink(missing_ok=True)
        log = (directory / f"vnc-{index}.log").open("a")
        args = ["Xtigervnc", display, "-geometry", "640x480", "-depth", "24", "-rfbport", str(5900 + index),
                "-interface", "127.0.0.1" if index == 0 else "192.0.2.20", "-localhost", "no",
                "-SecurityTypes", "VncAuth" if index == 0 else "None", "-AlwaysShared", "-ac",
                "-MaxCutText=1048576",
                "-AcceptSetDesktopSize=1" if index == 0 else "-AcceptSetDesktopSize=0"]
        if index == 0:
            args += ["-PasswordFile", str(directory / "password")]
        server = subprocess.Popen(args, stdout=log, stderr=log)
        children.append(server)
        deadline = time.monotonic() + 10
        while not Path(f"/tmp/.X11-unix/X{80 + index}").exists():
            if server.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError((directory / f"vnc-{index}.log").read_text())
            time.sleep(0.05)
        app = subprocess.Popen([sys.executable, __file__, str(directory), "desktop", str(index)],
                               env=dict(os.environ, DISPLAY=display), stdout=log, stderr=log)
        children.append(app)
        while not marker.exists():
            if app.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError((directory / f"vnc-{index}.log").read_text())
            time.sleep(0.05)
        servers[index] = (server, app)

    def stop(index):
        for child in reversed(servers.pop(index)):
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)

    def drop_ssh():
        descendants = []
        def visit(pid):
            for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split():
                child = int(value)
                visit(child)
                descendants.append(child)
        visit(sshd.pid)
        for pid in descendants:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    try:
        ssh_log = (directory / "sshd.log").open("a")
        sshd = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(directory / "sshd_config")],
                                stdout=ssh_log, stderr=ssh_log)
        children.append(sshd)
        for index in (0, 1):
            start(index)
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(directory / "ssh.sock"))
        listener.listen()
        def accept():
            while True:
                client, _ = listener.accept()
                threading.Thread(target=bridge, args=(client, port), daemon=True).start()
        threading.Thread(target=accept, daemon=True).start()
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            if request["action"] == "stop":
                stop(request["index"])
            elif request["action"] == "start":
                start(request["index"])
            elif request["action"] == "drop-ssh":
                drop_ssh()
            elif request["action"] == "copy":
                (directory / f"copy-{request['index']}").write_text(request["text"])
            elif request["action"] == "pointer":
                (directory / f"pointer-{request['index']}").write_text(request["text"])
            print(json.dumps({"done": True}), flush=True)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    if sys.argv[2] == "desktop":
        desktop(directory, int(sys.argv[3]))
    else:
        serve(directory, int(sys.argv[2]))
