import type { HelperRequest } from '../helper-messages';
import type { ConnectionController } from './connection';

/** Session discovery owns its helper requirement for as long as integration is active. */
export class RemoteIntegration {
  active = false;
  constructor(private connection: ConnectionController) {}
  sync(enabled: boolean) {
    const active = enabled && this.connection.info.status === 'connected';
    if (active === this.active) return;
    this.active = active;
    if (active) this.connection.info.remoteSessions = { sessions: [], loading: true, errors: [] };
    else {
      this.connection.info.remoteSessions = undefined;
      this.connection.remoteSessions.clear();
    }
    this.connection.setHelperNeeded(this, active);
    this.connection.helper?.reconfigure();
  }
  configuration(): HelperRequest { return { type: 'sessions.configure', enabled: this.active }; }
}
