import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHelperMessage, applicationRequest } from '../src/main/remote-helper';
import { namedByAddress } from '../src/shared';

test('application wire messages validate endpoints and correlate consent without application-specific types', () => {
  assert.equal(applicationRequest.parse({ type: 'applications.launch', launchId: 'launch-1', application: 'another-editor', options: { project: 'one' } }).type, 'applications.launch');
  assert.equal(parseHelperMessage(JSON.stringify({ type: 'applications.consent', launchId: 'launch-1', consentId: 'notice-1', content: { text: 'Remote notice\nhttps://example.com/terms' } })).type, 'applications.consent');
  const ready = (url: string) => JSON.stringify({ type: 'applications.ready', launchId: 'launch-1', view: { kind: 'browser', url } });
  assert.equal(parseHelperMessage(ready('http://127.0.0.1:12345/?tkn=secret')).type, 'applications.ready');
  for (const url of ['file:///etc/passwd', 'http://example.com/', 'http://user:password@localhost/', 'javascript:alert(1)']) assert.throws(() => parseHelperMessage(ready(url)));
  assert.throws(() => parseHelperMessage(JSON.stringify({ type: 'applications.progress', launchId: 'launch-1', phase: 'downloading', transfer: { receivedBytes: -1 } })));
});

test('a page named after its address is refused so a launch address never names a tab', () => {
  // Chromium names a page with no title of its own after its address, dropping the scheme and a bare host's trailing slash.
  for (const [title, url] of [
    ['127.0.0.1:37543/?tkn=secret', 'http://127.0.0.1:37543/?tkn=secret'],
    ['localhost/?tkn=secret', 'http://localhost/?tkn=secret'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:8080/x', 'http://[::1]:8080/x'],
    ['127.0.0.1:8080/a b?tkn=secret', 'http://127.0.0.1:8080/a%20b?tkn=secret'],
    ['https://example.com/page', 'https://example.com/page'],
  ]) assert.equal(namedByAddress(title, url), true, title);
  for (const [title, url] of [
    ['Visual Studio Code', 'http://127.0.0.1:37543/?tkn=secret'],
    ['index.ts \u2014 bartizan \u2014 Visual Studio Code', 'http://127.0.0.1:37543/?tkn=secret'],
    ['GitHub - anthropics/claude-code: Claude Code is an agentic coding tool', 'https://github.com/anthropics/claude-code'],
    ['claude-code/src/index.ts at main', 'https://github.com/anthropics/claude-code/blob/main/src/index.ts'],
    ['Fixture /', 'http://127.0.0.1:8080/'],
    ['New Tab', ''],
  ]) assert.equal(namedByAddress(title, url), false, title);
});
