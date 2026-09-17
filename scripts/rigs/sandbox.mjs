import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import electron from 'electron';

const directory = await mkdtemp(join(tmpdir(), 'bartizan-sandbox-'));
const executable = process.env.BARTIZAN_EXECUTABLE ?? electron;
const base = process.env.BARTIZAN_EXECUTABLE ? [] : ['.'];
const cases = ['no-sandbox', 'disable-seccomp-filter-sandbox', 'disable-namespace-sandbox', 'disable-setuid-sandbox', 'single-process', 'no-zygote'];
try {
  for (const flag of [...cases, 'environment']) {
    const result = spawnSync(executable, [...base, ...(flag === 'environment' ? [] : [`--${flag}`])], {
      env: { ...process.env, BARTIZAN_DATA_DIR: directory, ...(flag === 'environment' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}) },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined, flag);
    if (/FATAL:.*sandbox/.test(result.stderr)) {
      assert.notEqual(result.status, 0, flag);
      assert.match(result.stderr, /FATAL:.*sandbox/, flag);
    } else {
      assert.equal(result.status, 1, `${flag}: ${result.stderr}`);
      assert.match(result.stderr, /Bartizan requires Chromium sandboxing|Zygote cannot be disabled if sandbox is enabled/, flag);
    }
  }
  console.log('Sandbox-disabling flags and environment requests are rejected before opening a window.');
} finally { await rm(directory, { recursive: true, force: true }); }
