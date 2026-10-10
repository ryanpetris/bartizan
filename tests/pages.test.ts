import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagePermitted, systemLink, untitledName } from '../src/shared';

test('a page without a title is named by its host and path', () => {
  assert.equal(untitledName('http://user:secret@127.0.0.1:8080/data/file.json?query=1#part'), '127.0.0.1:8080/data/file.json');
  assert.equal(untitledName('https://example.invalid/'), 'example.invalid');
  assert.equal(untitledName('http://example.invalid/caf%C3%A9/'), 'example.invalid/café');
  assert.equal(untitledName('view-source:http://example.invalid/page'), 'view-source:example.invalid/page');
  assert.equal(untitledName('about:blank'), '');
});

test('every page may write to the clipboard, and only an application may read it', () => {
  for (const application of [false, true]) {
    assert.equal(pagePermitted('clipboard-sanitized-write', application), true);
    assert.equal(pagePermitted('fullscreen', application), true);
    assert.equal(pagePermitted('clipboard-read', application), application);
    assert.equal(pagePermitted('geolocation', application), false);
    assert.equal(pagePermitted('media', application), false);
  }
});

test('mailto:, tel: and sms: links reach the system in one form, with only the fields a mail application needs', () => {
  assert.equal(systemLink('mailto:a@example.com?subject=Hi%20there&attach=/etc/passwd&Body=x&%61ttachment=y&cc=b@example.com#part'), 'mailto:a@example.com?cc=b@example.com&subject=Hi%20there&body=x');
  assert.equal(systemLink(`mailto:a@example.com?body=${'x'.repeat(400)}&bcc=c@example.com&to=b@example.com`), `mailto:a@example.com?to=b@example.com&bcc=c@example.com&body=${'x'.repeat(400)}`);
  assert.equal(systemLink(`mailto:a@example.com?body=${'('.repeat(3000)}`), undefined);
  assert.equal(systemLink('mailto:a@example.com?attach=/etc/passwd'), 'mailto:a@example.com');
  assert.equal(systemLink('mailto:a@example.com,b@example.com?subject=Hi,attachment=/etc/passwd'), 'mailto:a@example.com,b@example.com?subject=Hi%2Cattachment%3D%2Fetc%2Fpasswd');
  assert.equal(systemLink("mailto:a@example.com?body=it's (here)*!+"), 'mailto:a@example.com?body=it%27s%20%28here%29%2A%21%2B');
  for (const link of ['mailto:a@example.com&attach=/etc/passwd', 'mailto:a@example.com%26attach=/etc/passwd', 'mailto:a@example.com%3Fattach=/etc/passwd',
    "mailto:a@example.com%27,attachment=%27/etc/passwd", 'mailto:%22a%22@example.com', "mailto:a@example.com?to=b@example.com'", 'mailto:a@example.com?cc=b@example.com%26attach=x', 'mailto:%E0%A4%A'])
    assert.equal(systemLink(link), undefined, link);
  assert.equal(systemLink('tel:+15550100'), 'tel:+15550100');
  assert.equal(systemLink('sms:+15550100?body=Hi'), 'sms:+15550100?body=Hi');
  for (const link of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'vscode://open', 'https://example.com/', 'mailto:a@example.com\n']) assert.equal(systemLink(link), undefined, link);
});
