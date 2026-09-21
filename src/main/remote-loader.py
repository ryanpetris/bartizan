import os, sys
remaining = int(sys.argv[1])
source = b""
while remaining:
    chunk = os.read(0, remaining)
    if not chunk: raise EOFError
    source += chunk
    remaining -= len(chunk)
exec(source)
