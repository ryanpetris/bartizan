import type { ErrorEntry, ErrorLog, ErrorReport } from '../shared';

/** App-session history; active conditions remain tracked even after history is cleared or trimmed. */
export class Errors {
  private nextId = 0;
  private current = new Map<string, ErrorEntry>();
  private history: ErrorEntry[] = [];
  private pending = false;
  constructor(private changed: (log: ErrorLog) => void, private now = Date.now) {}

  snapshot(): ErrorLog {
    return { current: [...this.current.values()].map(entry => ({ ...entry })), history: this.history.map(entry => ({ ...entry })) };
  }
  private notify() {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.changed(this.snapshot());
    });
  }
  private add(input: ErrorReport, kind: ErrorEntry['kind']) {
    const time = this.now();
    const entry: ErrorEntry = { ...input, label: input.label ?? (input.connectionId ? 'Connection' : 'App'), message: input.message.slice(0, 16384), id: ++this.nextId, kind, time, lastTime: time, count: 1 };
    this.history.push(entry);
    if (this.history.length > 200) this.history.shift();
    return entry;
  }
  report(input: ErrorReport) {
    const last = this.history.at(-1);
    if (last?.kind === 'event' && last.source === input.source && last.connectionId === input.connectionId && last.message === input.message.slice(0, 16384)) {
      last.count++;
      last.lastTime = this.now();
    } else this.add(input, 'event');
    this.notify();
  }
  sync(configError: string | undefined) {
    const conditions = new Map<string, ErrorReport>();
    if (configError) conditions.set('config', { source: 'config', message: configError, label: 'App' });
    let changed = false;
    for (const [key, entry] of this.current) {
      if (conditions.get(key)?.message.slice(0, 16384) === entry.message) continue;
      entry.resolvedAt = this.now();
      this.current.delete(key);
      changed = true;
    }
    for (const [key, input] of conditions) if (!this.current.has(key)) {
      this.current.set(key, this.add(input, 'current'));
      changed = true;
    }
    if (changed) this.notify();
  }
  clear() {
    this.history = [];
    this.notify();
  }
}
