import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { WebContents } from 'electron';
import type { BrowserTab, CertificateChallenge } from '../shared';

const errors = new Set(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID']);
const requestURL = (address: string) => { try { const url = new URL(address); url.hash = ''; return url.href; } catch { return ''; } };
type Pending = { tab: BrowserTab; key: string; certificate: CertificateChallenge; callback: (allow: boolean) => void };

/** Certificate decisions belong to one live browser session. Tabs in `muted` show no new warnings. */
export class Certificates {
  private approved = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private navigation = new Map<string, string>();
  constructor(private changed: () => void, private muted: Set<string>) {}

  attach(tab: BrowserTab, contents: WebContents) {
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
      if (!mainFrame || !address.startsWith('https:') || this.navigation.get(tab.id) !== requestURL(address) || this.muted.has(tab.id) || tab.certificate) { callback(false); return; }
      this.pending.set(info.id, { tab, key, certificate: info, callback });
      tab.certificate = info;
      this.changed();
    });
    contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { this.cancel(tab); this.navigation.set(tab.id, requestURL(details.url)); } });
    contents.on('did-redirect-navigation', details => { if (details.isMainFrame) { this.cancel(tab); this.navigation.set(tab.id, requestURL(details.url)); } });
    contents.on('did-fail-provisional-load', (_event, _code, _error, url, mainFrame) => { if (mainFrame && tab.certificate && requestURL(tab.certificate.url) === requestURL(url)) this.cancel(tab); });
    contents.on('did-stop-loading', () => { this.navigation.delete(tab.id); this.cancel(tab); });
    contents.on('render-process-gone', () => this.cancel(tab));
    contents.on('destroyed', () => { this.navigation.delete(tab.id); this.cancel(tab); });
  }

  /** Cancels a tab's warning; the tab shows no further warnings until the user acts in it. */
  cancel(tab: BrowserTab) { if (tab.certificate) { this.muted.add(tab.id); this.finish(tab.certificate.id, false); } }
  answer(id: string, allow: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (allow) this.approved.set(pending.certificate.origin, pending.key);
    else this.muted.add(pending.tab.id);
    this.finish(id, allow);
    return true;
  }
  private finish(id: string, allow: boolean) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    delete pending.tab.certificate;
    if (!allow) pending.tab.error = pending.certificate.error;
    try { pending.callback(allow); } catch {} finally { this.changed(); }
  }
  close() {
    this.approved.clear(); this.navigation.clear();
    for (const id of this.pending.keys()) this.finish(id, false);
  }
}
