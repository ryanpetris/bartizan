import os
import select
import signal
import sys
import tempfile
import runpy


SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)


def terminate(*_):
    for signum in SIGNALS:
        signal.signal(signum, signal.SIG_IGN)
    sys.exit(0)


for signum in SIGNALS:
    signal.signal(signum, terminate)
# A signal that arrives just before a read would otherwise wait for its handler until stdin is readable.
wakeup, signalled = os.pipe()
os.set_blocking(signalled, False)
signal.set_wakeup_fd(signalled)

remaining = int(sys.argv[1])
if remaining <= 0:
    raise ValueError("Invalid helper archive size")
# A signal between creating the directory and entering the block would leave the directory behind.
signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
with tempfile.TemporaryDirectory(prefix="bartizan-helper-") as directory:
    signal.pthread_sigmask(signal.SIG_UNBLOCK, SIGNALS)
    path = os.path.join(directory, "helper.pyz")
    with open(path, "wb") as archive:
        while remaining:
            if wakeup in select.select([0, wakeup], [], [])[0]:
                os.read(wakeup, 4096)
                continue
            chunk = os.read(0, min(remaining, 256 * 1024))
            if not chunk:
                raise EOFError
            archive.write(chunk)
            remaining -= len(chunk)
    runpy.run_path(path, run_name="__main__")
