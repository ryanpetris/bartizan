import { writeFileSync, chmodSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Replaces a file atomically using a temporary file in the same directory. */
export function writeAtomic(file: string, source: string, mode = 0o600): void {
  const directory = mkdtempSync(join(dirname(file), '.bartizan-'));
  try {
    const temporary = join(directory, 'data');
    writeFileSync(temporary, source, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
