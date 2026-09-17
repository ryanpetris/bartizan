// The Debian and Arch packages keep this mode, so Chromium can fall back to the setuid sandbox helper where users
// cannot create user namespaces.
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

export default ({ appOutDir }) => chmod(join(appOutDir, 'chrome-sandbox'), 0o4755);
