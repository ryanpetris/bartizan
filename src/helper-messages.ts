export type RemoteSession = {
  source: string; key: string; label: string; group: string; detail: string; attached: boolean;
  commands: { resume?: string; takeover?: string; stop?: string };
  error?: string;
};
export type SessionFailure = { source?: string; message: string };
export type ApplicationPhase = 'checking' | 'downloading' | 'extracting' | 'starting' | 'loading';
export type ApplicationRequest =
  | { type: 'applications.launch'; launchId: string; application: string; options?: Record<string, unknown> }
  | { type: 'applications.respond'; launchId: string; consentId: string; accepted: boolean }
  | { type: 'applications.stop'; launchId: string };
export type ApplicationMessage =
  | { type: 'applications.progress'; launchId: string; phase: ApplicationPhase; component?: string; release?: string; usingCachedRelease?: boolean; transfer?: { receivedBytes: number; totalBytes?: number } }
  | { type: 'applications.consent'; launchId: string; consentId: string; content: { text: string; prompt?: string } }
  | { type: 'applications.ready'; launchId: string; release?: string; view: { kind: 'browser'; url: string } }
  | { type: 'applications.ended'; launchId: string; reason: 'cancelled' | 'stopped' | 'exited' | 'failed'; exitCode?: number; error?: { code: string; message: string } };
/** A launch and its view; `page` follows the page it serves, which the application navigates itself once that page is open. */
export type ApplicationState = { application: string; launchId: string; event: ApplicationMessage; page?: 'loading' | 'open' };
export type HelperRequest = { type: 'sessions.refresh' } | { type: 'sessions.configure'; enabled: boolean } | ApplicationRequest;
export type HelperMessage = ApplicationMessage
  | { type: 'sessions.upsert'; source: string; session: RemoteSession }
  | { type: 'sessions.remove'; source: string; key: string }
  | { type: 'sessions.snapshot'; sources: string[]; sessions: RemoteSession[]; errors: SessionFailure[] }
  | { type: 'helper.error'; message: string };
export type HelperEnvelope<M = HelperMessage> = { connectionId: string; message: M };
export type HelperListener<T extends HelperMessage['type']> = (event: HelperEnvelope<Extract<HelperMessage, { type: T }>>) => void;

/** Each consumer receives its own message so reconciliation cannot alter another subscriber's input. */
export class HelperMessages {
  private listeners = new Set<(event: HelperEnvelope) => void>();
  constructor(readonly send: (connectionId: string, message: HelperRequest) => Promise<void>, private failed: (error: unknown) => void = console.error) {}
  listen(callback: (event: HelperEnvelope) => void) {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }
  on<T extends HelperMessage['type']>(type: T, callback: HelperListener<T>) {
    return this.listen(event => { if (event.message.type === type) callback(event as HelperEnvelope<Extract<HelperMessage, { type: T }>>); });
  }
  publish(connectionId: string, message: HelperMessage) {
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone({ connectionId, message })); }
      catch (error) { this.failed(error); }
    }
  }
}
