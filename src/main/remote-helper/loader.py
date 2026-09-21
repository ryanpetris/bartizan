import os
import signal
import sys
import tempfile
import runpy


def terminate(*_):
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, signal.SIG_IGN)
    sys.exit(0)


for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(signum, terminate)

remaining = int(sys.argv[1])
if remaining <= 0:
    raise ValueError("Invalid helper archive size")
with tempfile.TemporaryDirectory(prefix="bartizan-helper-") as directory:
    path = os.path.join(directory, "helper.pyz")
    with open(path, "wb") as archive:
        while remaining:
            chunk = os.read(0, min(remaining, 256 * 1024))
            if not chunk:
                raise EOFError
            archive.write(chunk)
            remaining -= len(chunk)
    runpy.run_path(path, run_name="__main__")
