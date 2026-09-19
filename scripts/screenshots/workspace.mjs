// The synthetic shell the screenshot's terminals run: a fixed prompt, and commands that print canned output.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const reset = '\x1b[0m', bold = '\x1b[1m', dim = '\x1b[2m', green = '\x1b[32m', boldGreen = '\x1b[1;32m', cyan = '\x1b[36m',
  boldCyan = '\x1b[1;36m', yellow = '\x1b[33m', red = '\x1b[31m', boldBlue = '\x1b[1;34m';

const check = [
  '',
  `  ${boldCyan}ATLAS${reset}  ${dim}/${reset}  ${boldCyan}build & test${reset}`,
  '',
  `  ${green}✓${reset} TypeScript                      ${dim}no errors${reset}`,
  `  ${green}✓${reset} Lint                            ${dim}0 problems${reset}`,
  `  ${green}✓${reset} Production build                ${dim}842 ms${reset}`,
  '',
  `  ${bold}Tests${reset}`,
  '',
  `  ${boldGreen} PASS ${reset} api/search.test.ts             ${dim}12 tests${reset}`,
  `  ${boldGreen} PASS ${reset} api/sessions.test.ts           ${dim}16 tests${reset}`,
  `  ${boldGreen} PASS ${reset} web/navigation.test.ts          ${dim}8 tests${reset}`,
  `  ${boldGreen} PASS ${reset} web/settings.test.ts            ${dim}6 tests${reset}`,
  `  ${boldGreen} PASS ${reset} worker/queue.test.ts           ${dim}11 tests${reset}`,
  '',
  `  ${dim}Test files${reset}  ${boldGreen}5 passed${reset}`,
  `  ${dim}     Tests${reset}  ${boldGreen}53 passed${reset}`,
  `  ${dim}  Duration${reset}  1.42 s`,
  '',
  `  ${dim}Watching for changes. Press Ctrl+C to stop.${reset}`,
];
const history = [
  `${yellow}* 4f2c9a1${reset} ${boldBlue}(HEAD -> main)${reset} Show deploy history on the dashboard`,
  `${yellow}* 9d1e0b7${reset} Cache search results per session`,
  `${yellow}* 2a7c5e3${reset} Add retry budget to the worker queue`,
  `${yellow}*   b81f4d2${reset} Merge branch ${green}settings-form${reset}`,
  `${red}|${reset}${green}\\${reset}`,
  `${red}|${reset} ${yellow}* 6e3d9a0${reset} Validate settings before saving`,
  `${red}|${reset} ${yellow}* c4b2f18${reset} Group settings by section`,
  `${red}|${reset}${green}/${reset}`,
  `${yellow}* 71a0e5c${reset} Stream logs to the admin view`,
  `${yellow}* e9f3b62${reset} ${boldBlue}(tag: v2.3.0)${reset} Release 2.3.0`,
];
const level = { INFO: green, DEBUG: dim, WARN: yellow, ERROR: red };
const logs = [
  ['09:41:02', 'INFO', 'http', 'GET /api/search?q=invoices 200 38ms'],
  ['09:41:02', 'INFO', 'http', 'GET /api/sessions/current 200 4ms'],
  ['09:41:05', 'INFO', 'worker', 'job 1842 finished: reindex tenant 17 (2.1s)'],
  ['09:41:07', 'DEBUG', 'cache', 'search results cached for session 8c21 (24 items)'],
  ['09:41:09', 'INFO', 'http', 'POST /api/settings 204 12ms'],
  ['09:41:12', 'WARN', 'worker', 'job 1843 retrying in 4s (attempt 2 of 5)'],
  ['09:41:16', 'INFO', 'worker', 'job 1843 finished: send digest emails (0.8s)'],
  ['09:41:18', 'INFO', 'http', 'GET /dashboard 200 61ms'],
  ['09:41:18', 'INFO', 'http', 'GET /api/deploys?limit=5 200 9ms'],
  ['09:41:21', 'DEBUG', 'db', 'pool: 4 active, 12 idle'],
  ['09:41:24', 'INFO', 'http', 'GET /api/search?q=refunds 200 41ms'],
  ['09:41:27', 'ERROR', 'http', 'GET /api/reports/q3 502 upstream timed out'],
  ['09:41:27', 'INFO', 'http', 'GET /api/reports/q3 200 212ms (retry)'],
  ['09:41:30', 'INFO', 'worker', 'job 1844 queued: export invoices (tenant 4)'],
  ['09:41:33', 'INFO', 'worker', 'job 1844 finished: export invoices (3.4s)'],
  ['09:41:35', 'DEBUG', 'cache', 'evicted 3 expired sessions'],
  ['09:41:38', 'INFO', 'http', 'GET /api/sessions/current 200 3ms'],
  ['09:41:41', 'INFO', 'http', 'GET /settings 200 22ms'],
].map(([time, name, source, message]) => `${dim}${time}${reset} ${level[name]}${name.padEnd(5)}${reset} ${cyan}${source.padEnd(6)}${reset} ${message}`);
const checklist = [
  `${boldBlue}# Release 2.4.0${reset}`,
  '',
  `${bold}## Before the release${reset}`,
  '',
  `- [${green}x${reset}] Merge ${green}settings-form${reset} and ${green}deploy-history${reset}`,
  `- [${green}x${reset}] Run the full check on ${cyan}main${reset}`,
  `- [${green}x${reset}] Update the changelog`,
  `- [ ] Tag ${yellow}v2.4.0${reset} and push the tag`,
  '',
  `${bold}## Rollout${reset}`,
  '',
  `- [ ] Deploy to ${cyan}staging${reset} and watch the error rate for 30 minutes`,
  `- [ ] Deploy to ${cyan}production${reset} in two batches`,
  `- [ ] Announce in the release notes`,
];

/**
 * Writes the shell's startup file and its canned output to `directory`, and returns the startup file. `title` names the
 * terminal; `npm`, `git`, `tail` and `cat RELEASE.md` print a build, a history, a log and a checklist, and the build and
 * the log keep running as the real commands would.
 */
export async function writeWorkspace(directory) {
  const files = { 'check.ans': check, 'git.ans': history, 'logs.ans': logs, 'release.ans': checklist };
  for (const [name, lines] of Object.entries(files)) await writeFile(join(directory, name), lines.join('\r\n') + '\r\n');
  const rc = join(directory, 'bashrc');
  await writeFile(rc, `export LANG=C.UTF-8
cd ${directory}
PS1='\\[\\e[32m\\]demo\\[\\e[0m\\] \\[\\e[1;34m\\]❯\\[\\e[0m\\] '
title() { printf '\\033]2;%s\\007' "$1"; }
npm() { command cat check.ans; sleep infinity; }
git() { command cat git.ans; }
tail() { command cat logs.ans; sleep infinity; }
cat() { if [ "$1" = RELEASE.md ]; then command cat release.ans; else command cat "$@"; fi; }
`);
  return rc;
}
