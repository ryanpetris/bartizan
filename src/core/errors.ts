import type { ErrorEntry, ErrorLog, ErrorReport } from '../shared';

/** IDs increase by magnitude within backend and page-local errors. */
export const newestErrorFirst = (a: ErrorEntry, b: ErrorEntry) => b.lastTime - a.lastTime || Math.abs(b.id) - Math.abs(a.id);

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
    queueMicrotask(() => {
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
  setCurrent(key: string, input?: ErrorReport) {
    const previous = this.current.get(key);
    if (previous && input && previous.message === input.message.slice(0, 16384) &&
        previous.connectionId === input.connectionId && previous.terminalId === input.terminalId &&
        previous.label === (input.label ?? (input.connectionId ? 'Connection' : 'App'))) return;
    if (!previous && !input) return;
    if (previous) {
      previous.resolvedAt = this.now();
      this.current.delete(key);
    }
    if (input) this.current.set(key, this.add(input, 'current'));
    this.notify();
  }
  sync(configError: string | undefined) {
    this.setCurrent('config', configError ? { source: 'config', message: configError, label: 'App' } : undefined);
  }
  clear() {
    this.history = [];
    this.notify();
  }
}
