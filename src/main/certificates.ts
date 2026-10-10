import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { WebContents } from 'electron';
import type { BrowserTab, CertificateChallenge } from '../shared';

const errors = new Set(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID']);
const requestURL = (address: string) => { try { const url = new URL(address); url.hash = ''; return url.href; } catch { return ''; } };
/** A warning holds its page's request until answered; one for a resource the page loads has already been refused, and its page loads again on Proceed. */
type Pending = { tab: BrowserTab; key: string; certificate: CertificateChallenge; callback?: (allow: boolean) => void; reload?: () => void };

/** Certificate decisions belong to one live browser session. Tabs in `muted` show no new warnings. */
export class Certificates {
  private approved = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private navigation = new Map<string, string>();
  /** The resource certificates each tab's page has had cancelled, which it does not show again. */
  private dismissed = new Map<string, Set<string>>();
  /** Tabs whose page has a navigation of its own on the way, which an approval leaves to finish rather than reloading over it. */
  private navigating = new Set<string>();
  constructor(private changed: () => void, private muted: Set<string>, private route: (id: string, pending: boolean) => void = () => {}) {}

  /** Watches a tab's page; `reload` loads it again once a certificate for one of its resources is approved. */
  attach(tab: BrowserTab, contents: WebContents, reload: () => void) {
    contents.on('certificate-error', (event, address, error, certificate, callback, mainFrame) => {
      event.preventDefault();
      if (!errors.has(error) || address.length > 8192 || certificate.data.length > 65536) { callback(false); return; }
      let info: CertificateChallenge;
      try {
        const url = new URL(address);
        if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid TLS endpoint');
        url.protocol = 'https:';
        const leaf = new X509Certificate(certificate.data);
        info = { id: randomUUID(), url: address, origin: url.origin, error, fingerprint: createHash('sha256').update(leaf.raw).digest('hex'), subject: leaf.subject.slice(0, 1024), issuer: leaf.issuer.slice(0, 1024), validFrom: leaf.validFrom, validTo: leaf.validTo };
      } catch { callback(false); return; }
      const key = `${info.fingerprint}:${error}`;
      if (this.approved.get(info.origin) === key) { callback(true); return; }
      if (!mainFrame) {
        callback(false);
        // A tab shows one blocked resource at a time, and none while its own page waits on a warning.
        if (this.muted.has(tab.id) || tab.certificate || tab.blockedCertificate || this.dismissed.get(tab.id)?.has(`${info.origin} ${key}`)) return;
        this.pending.set(info.id, { tab, key, certificate: info, reload });
        this.route(info.id, true);
        tab.blockedCertificate = info;
        this.changed();
        return;
      }
      if (!address.startsWith('https:') || this.navigation.get(tab.id) !== requestURL(address) || this.muted.has(tab.id) || tab.certificate) { callback(false); return; }
      this.pending.set(info.id, { tab, key, certificate: info, callback });
      this.route(info.id, true);
      tab.certificate = info;
      this.changed();
    });
    contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { this.cancel(tab); this.navigation.set(tab.id, requestURL(details.url)); this.navigating.add(tab.id); } });
    contents.on('did-redirect-navigation', details => { if (details.isMainFrame) { this.cancel(tab); this.navigation.set(tab.id, requestURL(details.url)); } });
    contents.on('did-fail-provisional-load', (_event, _code, _error, url, mainFrame) => {
      if (!mainFrame) return;
      this.navigating.delete(tab.id);
      if (tab.certificate && requestURL(tab.certificate.url) === requestURL(url)) this.cancel(tab);
    });
    // A page that commits, including an error page, replaces the one whose resources were refused.
    const replaced = () => { this.navigating.delete(tab.id); this.dismissed.delete(tab.id); this.forget(tab); };
    contents.on('did-navigate', replaced);
    contents.on('did-fail-load', (_event, code, _error, _url, mainFrame) => { if (mainFrame && code !== -3) replaced(); });
    contents.on('did-stop-loading', () => { this.navigation.delete(tab.id); this.navigating.delete(tab.id); this.cancel(tab); });
    contents.on('render-process-gone', () => { this.cancel(tab); this.forget(tab); });
    contents.on('destroyed', () => { this.navigation.delete(tab.id); this.navigating.delete(tab.id); this.dismissed.delete(tab.id); this.cancel(tab); this.forget(tab); });
  }

  /** Cancels a tab's warning; the tab shows no further warnings until the user acts in it. */
  cancel(tab: BrowserTab) { if (tab.certificate) { this.muted.add(tab.id); this.finish(tab.certificate.id, false); } }
  /** Drops a tab's blocked resource once the page that loaded it is gone or the user moves on from it. */
  forget(tab: BrowserTab) { if (tab.blockedCertificate) this.finish(tab.blockedCertificate.id, false); }
  answer(id: string, allow: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    const { tab, certificate, key, reload } = pending;
    if (allow) this.approved.set(certificate.origin, key);
    else {
      this.muted.add(tab.id);
      if (reload) { const dismissed = this.dismissed.get(tab.id) ?? new Set(); this.dismissed.set(tab.id, dismissed.add(`${certificate.origin} ${key}`)); }
    }
    this.finish(id, allow);
    // A navigation on the way, and any warning it raised, go on; its page loads the resource afresh.
    if (allow && !this.navigating.has(tab.id)) reload?.();
    return true;
  }
  private finish(id: string, allow: boolean) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); this.route(id, false);
    if (pending.reload) { delete pending.tab.blockedCertificate; this.changed(); return; }
    delete pending.tab.certificate;
    if (!allow) pending.tab.error = pending.certificate.error;
    try { pending.callback?.(allow); } catch {} finally { this.changed(); }
  }
  close() {
    this.approved.clear(); this.navigation.clear(); this.navigating.clear(); this.dismissed.clear();
    for (const id of this.pending.keys()) this.finish(id, false);
  }
}
