import { pinnedHostKey } from '../core/host-keys';

try {
  process.stdout.write(pinnedHostKey(JSON.parse(process.env.BARTIZAN_HOST_KEY_PINS ?? 'null'), process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Host key verification failed'}\n`);
  process.exitCode = 1;
}
