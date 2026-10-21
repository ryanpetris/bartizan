import { test } from 'node:test';
import assert from 'node:assert/strict';

const element = () => ({
  className: '',
  hidden: false,
  style: {},
  append() {},
  appendChild() {},
  remove() {},
  addEventListener() {},
  setAttribute() {},
  getContext() { return null; },
});
const documentStub = {
  activeElement: null,
  body: element(),
  documentElement: element(),
  createElement: element,
  querySelector() { return null; },
  addEventListener() {},
};
const api = new Proxy(
  { onHelperMessage() {} },
  { get: (target, key) => Reflect.get(target, key) ?? (() => Promise.resolve()) },
);
Object.assign(globalThis, {
  addEventListener() {},
  document: documentStub,
  window: { addEventListener() {}, bartizan: api, document: documentStub, isSecureContext: true },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
});

test('VNC credentials leave no values in the object retained by noVNC', async t => {
  const [{ default: RFB }, { clearVncCredentials }] = await Promise.all([import('@novnc/novnc'), import('../src/renderer/vnc')]);
  type RetainingRfb = InstanceType<typeof RFB> & {
    _listeners: Map<string, Set<(event: Event) => void>>;
    _resumeAuthentication(): void;
    _rfbCredentials: object;
    dispatchEvent(event: Event): boolean;
  };

  for (const [lifecycle, event] of [
    ['successful authentication', 'connect'],
    ['failed authentication', 'securityfailure'],
    ['cancelled authentication', undefined],
  ] as const) {
    await t.test(lifecycle, () => {
      const rfb = Object.create(RFB.prototype) as RetainingRfb;
      rfb._listeners = new Map();
      rfb._resumeAuthentication = () => {};
      const credentials = { username: 'account', password: 'secret' };
      rfb.sendCredentials(credentials);
      assert.strictEqual(rfb._rfbCredentials, credentials);

      const viewer = { submitted: credentials };
      if (event) {
        rfb.addEventListener(event, () => clearVncCredentials(viewer));
        rfb.dispatchEvent(new Event(event));
      } else {
        clearVncCredentials(viewer);
      }
      assert.deepEqual(rfb._rfbCredentials, {});
      assert.equal(viewer.submitted, undefined);
    });
  }
});
