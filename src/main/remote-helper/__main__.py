import signal

from helper.applications import Applications
from helper.messages import emit
from helper.sessions import monitor
from helper.vscode import VSCode

applications = Applications(emit, {"vscode": VSCode})
try:
    monitor(applications)
except (BrokenPipeError, KeyboardInterrupt):
    pass
finally:
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, signal.SIG_IGN)
    applications.close()
