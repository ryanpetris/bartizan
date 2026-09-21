import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export function archiveSources(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.py') && entry.name !== 'loader.py')
    .map(entry => join(entry.parentPath, entry.name)).sort();
}

// A zipapp is a ZIP archive with a __main__.py entry point.
export function pythonArchive(directory) {
  const files = archiveSources(directory).map(file => relative(directory, file));
  return execFileSync('python3', ['-c', `
import io, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
output = io.BytesIO()
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in sys.argv[2:]:
        entry = zipfile.ZipInfo(name.replace("\\\\", "/"))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, (root / name).read_bytes())
sys.stdout.buffer.write(output.getvalue())
`, directory, ...files]);
}
