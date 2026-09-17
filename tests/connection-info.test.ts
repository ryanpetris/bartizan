import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionInfo } from '../src/main/connection-info';

test('connection information reads negotiated fields and traffic', () => {
  assert.deepEqual(parseConnectionInfo('Connection information\n  tcp ::1:43210 -> ::1:22\n  duration 00:03:12\n  cipher aes256-ctr\n  mac hmac-sha2-256\n  traffic 30 pkts 10 blks 4.2KB in, 20 pkts 8 blks 3.1KB out\n'), {
    endpoints: '::1:43210 -> ::1:22', duration: '00:03:12', cipher: 'aes256-ctr', mac: 'hmac-sha2-256', received: '4.2KB', sent: '3.1KB',
  });
  assert.deepEqual(parseConnectionInfo('Invalid multiplex command.'), {});
});
