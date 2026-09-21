import json
import threading


MAX_BYTES = 1024 * 1024

emit_lock = threading.Lock()


def emit(message):
    data = json.dumps(message, ensure_ascii=True)
    if len(data) > MAX_BYTES:
        raise ValueError("Session message is too large")
    with emit_lock:
        print(data, flush=True)
