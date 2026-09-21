import type { RemoteProcess, ProcessReport } from '../shared';

/** Current managed processes for one connection, including launches without a remote PID yet. */
export class Processes {
  private readonly records = new Map<string, RemoteProcess>();
  constructor(private changed: (snapshot: RemoteProcess[]) => void) {}
  report(record: ProcessReport) {
    if (record.status === 'stopped') this.records.delete(record.id);
    else this.records.set(record.id, { ...record });
    this.changed(this.snapshot());
  }
  snapshot(): RemoteProcess[] { return [...this.records.values()].map(record => ({ ...record })); }
}
