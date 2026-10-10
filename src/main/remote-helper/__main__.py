import os
import signal

from helper.applications import Applications
from helper.messages import emit
from helper.sessions import monitor
from helper.t3 import T3
from helper.vscode import VSCode

applications = Applications(emit, {"vscode": VSCode, "t3": T3})
try:
    emit(dict(type="helper.ready", pid=os.getpid()))
    monitor(applications)
except (BrokenPipeError, KeyboardInterrupt):
    pass
finally:
    # A signal handled while these are being ignored ends the helper, after the applications have closed.
    try:
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
    finally:
        applications.close()
