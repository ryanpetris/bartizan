import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensureConfiguration, loadCatalog, resolveSpec, redactSpec, specSchema, type Spec, type Catalog } from '../core/config';
import { masterArgs } from '../core/ssh';
import { Askpass } from '../main/askpass';
import { Sessions } from '../main/sessions';
import { Configuration } from '../core/configuration';
import { Errors } from '../core/errors';
import { vncDestinationSchema } from '../main/vnc';
import { defaultSettings, type Capabilities, type Settings, type State, type Event } from '../shared';
import { profileDraft, profileChangesSchema, profileSaveSchema, prepareProfile, saveProfile, saveSettings, resolveDraft, draftSpec, type Draft } from '../core/profiles';

export type Handler = (...args: any[]) => unknown;
export type BackendExtension = {
  state(): Pick<State, 'workspaces'> & { challenges: State['challenges'] };
  answer(id: string, value: unknown): boolean;
  replay(): void;
  close(): void;
};
export type BackendOptions = {
  file: string;
  directory: string;
  helper: string;
  capabilities: Capabilities;
  send(event: Event): void;
  appearance?(settings: Settings): void;
  extend?(context: { sessions: Sessions; changed(): void; send(event: Event): void; handle(name: string, handler: Handler): void; serialize<T>(work: () => Promise<T>): Promise<T>; terminalConnection(id: unknown): string; reportError(source: string, message: string, connectionId?: string, label?: string): void }): BackendExtension;
};
export async function createBackend(options: BackendOptions) {
  const { file, send, capabilities } = options;
  const handlers = new Map<string, Handler>();
  const handle = (name: string, handler: Handler) => { handlers.set(name, handler); };
  let settings = { ...defaultSettings };
  let catalog: Catalog = { settings, defaults: {}, profiles: [], file };
  let configError: string | undefined;
  try {
    ensureConfiguration(file);
    catalog = loadCatalog(file);
  } catch (error) { configError = String(error); }
  settings = catalog.settings;
  const configuration = new Configuration(catalog);
  configuration.on('changed', catalog => { settings = catalog.settings; options.appearance?.(settings); });
  const errors = new Errors(log => send({ type: 'errors', log }));
  const reportError = (source: string, message: string, connectionId?: string, label?: string) => errors.report({ source, message, connectionId, label: connectionId ? label ?? sessions.entries.get(connectionId)?.info.label : 'App' });
  const state = (): State => {
    errors.sync(configError);
    return { ...catalog, settings, capabilities, configError, defaults: redactSpec(catalog.defaults), profiles: catalog.profiles.map(p => ({ ...p, spec: redactSpec(p.spec) })), connections: [...sessions.entries.values()].map(e => e.info), terminals: [...sessions.entries.values()].flatMap(connection => [...connection.terminals.values()].map(terminal => terminal.info)), vncs: [...sessions.entries.values()].flatMap(connection => [...connection.vncs.values()].map(vnc => vnc.info)), workspaces: extension?.state().workspaces ?? [], challenges: [...askpass.challenges, ...(extension?.state().challenges ?? [])] };
  };
  const changed = () => {
    if (closed) return;
    send({ type: 'state', state: state() });
  };
  const askpass = new Askpass(changed, changed, (message, id) => reportError('credentials', message, id));

  const sessions = new Sessions(join(options.directory, 'ssh'), askpass, options.helper, changed, (id, data) => { sessions.sent(id, data.length); send({ type: 'data', id, data }); }, (message, id, label) => reportError('ssh', message, id, label), configuration);
  sessions.messages.listen(event => send({ type: 'helper', ...event }));
  let closed = false;
  let connecting = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const result = connecting.then(() => { if (closed) throw new Error('Backend is closed'); return work(); }); connecting = result.then(() => {}, () => {}); return result;
  };
  const terminalConnection = (id: unknown) => {
    const connection = sessions.terminalOwner(z.string().parse(id));
    if (!connection) throw new Error('Terminal is closed');
    return connection.info.id;
  };
  const desktopVnc = () => { if (!capabilities.vnc) throw new Error('VNC is available only in the desktop app'); };
  const vnc = (connectionId: unknown, id: unknown) => {
    desktopVnc();
    return sessions.vnc(z.string().uuid().parse(connectionId), z.string().uuid().parse(id));
  };
  handle('new-vnc', (connectionId: unknown, destination: unknown) => {
    desktopVnc();
    const owner = z.string().uuid().parse(connectionId), target = vncDestinationSchema.parse(destination === undefined ? {} : destination);
    return serialize(async () => sessions.get(owner).newVnc(target));
  });
  handle('reconnect-vnc', (connectionId: unknown, id: unknown) => {
    const entry = vnc(connectionId, id);
    return serialize(async () => { if (entry.connection.vncs.get(entry.info.id) === entry) await entry.connection.reconnectVnc(entry.info.id); });
  });
  handle('close-vnc', (connectionId: unknown, id: unknown) => { vnc(connectionId, id).close(); });
  handle('stop-vnc', (connectionId: unknown, id: unknown, attempt: unknown) => {
    const entry = vnc(connectionId, id), token = z.string().uuid().parse(attempt);
    // A viewer closing after reconnect must not close the replacement channel.
    if (entry.info.attempt === token) { entry.stop(); changed(); }
  });

  const errorSchema = z.strictObject({ source: z.string().min(1).max(64), message: z.string().min(1).max(16384), connectionId: z.string().max(256).optional(), label: z.string().max(4096).optional() });
  handle('report-error', (input: unknown) => {
    const entry = errorSchema.parse(input);
    reportError(entry.source, entry.message, entry.connectionId, entry.label);
  });
  handle('clear-errors', () => errors.clear());
  handle('reload-config', () => serialize(async () => {
    try {
      catalog = loadCatalog(file); configError = undefined;
      configuration.publish(catalog);
    } catch (error) { configError = String(error); throw error; }
    finally { changed(); }
  }));
  handle('settings', (patch: unknown) => serialize(async () => {
    catalog = saveSettings(catalog, patch as Partial<typeof settings>);
    configError = undefined;
    configuration.publish(catalog);
    changed();
  }));
  const commandPreview = (spec: Spec, port?: number) => {
    const command = masterArgs(spec, '<application trust store>', port ?? 0, '<control socket>');
    if (port === undefined) command[command.indexOf('-D') + 1] = '127.0.0.1:<allocated port>';
    return command;
  };
  // Each client keeps its latest form draft.
  const drafts = new Map<string, { token: string; draft: Draft }>();
  let client = 'desktop';
  const draftInput = (input: unknown, owner = client) => {
    const changes = profileChangesSchema.parse(input);
    const current = drafts.get(owner);
    if (current?.token !== changes.token) throw new Error('Profile draft expired; reopen the profile');
    return { changes, draft: current.draft };
  };
  handle('profile-draft', (profileId: unknown) => {
    const id = z.string().min(1).optional().parse(profileId);
    const draft = profileDraft(catalog, id);
    const current = { token: randomUUID(), draft };
    drafts.set(client, current);
    const { tags = [], ...spec } = draft.profile ?? {};
    return { token: current.token, id, file, spec: redactSpec(spec), tags };
  });
  handle('profile-preview', (input: unknown) => {
    const { changes, draft } = draftInput(input);
    return commandPreview(resolveDraft(catalog, draft, changes));
  });
  handle('profile-connect', (input: unknown) => { const owner = client; return serialize(async () => {
    const { changes, draft } = draftInput(input, owner);
    if (draft.id) throw new Error('Save the profile before connecting');
    return sessions.create(draftSpec(draft, changes));
  }); });
  handle('profile-save', (input: unknown) => { const owner = client; return serialize(async () => {
    const { id, connect, ...fields } = profileSaveSchema.parse(input);
    const { changes, draft } = draftInput(fields, owner);
    if (draft.id && connect) throw new Error('Save the profile before connecting');
    const prepared = prepareProfile(catalog, draft, changes, id);
    const spec = connect ? resolveSpec(prepared.catalog, prepared.id, {}) : undefined;
    saveProfile(draft, prepared);
    catalog = prepared.catalog; configError = undefined;
    configuration.publish(catalog);
    const result: import('../shared').ProfileSaveResult = { profileId: prepared.id };
    changed();
    if (spec) {
      try { result.connectionId = await sessions.create({}, prepared.id); }
      catch (error) { result.connectionError = String(error); }
    }
    return result;
  }); });
  handle('details', (id: unknown) => sessions.get(z.string().parse(id)).details());
  const targetSchema = z.union([z.strictObject({ profileId: z.string() }), z.strictObject({ host: z.string(), username: z.string().optional(), port: specSchema.shape.port })]);
  handle('connect', (input: unknown) => serialize(async () => {
    const target = targetSchema.parse(input);
    if (!('profileId' in target)) return sessions.create(target, undefined, { destination: true });
    return sessions.create({}, target.profileId);
  }));
  const disconnect = (id: string) => sessions.entries.get(id)?.disconnect() ?? Promise.resolve();
  handle('disconnect', (id: unknown) => serialize(() => disconnect(z.string().parse(id))));
  handle('remove-connection', (id: unknown) => serialize(() => sessions.remove(z.string().parse(id))));
  handle('reconnect', (id: unknown) => serialize(async () => {
    const entry = sessions.entries.get(z.string().parse(id)); if (!entry) throw new Error('Unknown connection');
    if (entry.info.status !== 'closed') throw new Error('Disconnect before reconnecting');
    await entry.connect(false);
    return entry.info.id;
  }));
  handle('helper-message', (id: unknown, message: unknown) => sessions.messages.send(z.string().parse(id), z.object({ type: z.literal('sessions.refresh') }).parse(message)));
  handle('resume-remote-sessions', (id: unknown, keys: unknown, takeover: unknown) => sessions.get(z.string().parse(id)).resumeRemoteSessions(z.array(z.string().max(8192)).max(1000).parse(keys), z.boolean().parse(takeover)));
  handle('kill-remote-session', (id: unknown, key: unknown) => sessions.get(z.string().parse(id)).killRemoteSession(z.string().max(8192).parse(key)));
  handle('new-terminal', (id: unknown) => serialize(async () => sessions.get(z.string().parse(id)).newTerminal()));
  handle('reconnect-terminal', (id: unknown) => serialize(async () => {
    const terminal = sessions.terminals.get(z.string().parse(id));
    if (terminal) await terminal.connection.reconnectTerminal(terminal.info.id);
  }));
  handle('close-terminal', (id: unknown) => serialize(async () => sessions.terminals.get(z.string().parse(id))?.close()));
  handle('answer', (id: unknown, value: unknown) => {
    const challengeId = z.string().parse(id);
    if (extension?.answer(challengeId, value)) return;
    const connectionId = askpass.answer(challengeId, value);
    if (value === null && connectionId) void serialize(() => disconnect(connectionId)).catch(error => { if (!closed) reportError('ssh', String(error), connectionId); });
  });
  handle('capabilities', () => capabilities);
  handle('input', (id, data) => { if (typeof id !== 'string' || typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('Invalid terminal input'); sessions.terminals.get(id)?.input(data); });
  handle('acknowledge', (id, size) => { if (typeof id !== 'string' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid acknowledgement'); sessions.processed(client, id, size); });
  handle('resize', (id, cols, rows, repaint) => { if (typeof id !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) throw new Error('Invalid terminal size'); sessions.terminals.get(id)?.resize(cols, rows, repaint === true); });
  const extension = options.extend?.({ sessions, changed, send, handle, serialize, terminalConnection, reportError });
  await askpass.start();
  options.appearance?.(settings);
  return {
    state,
    snapshot: (): Event[] => [{ type: 'state', state: state() }, { type: 'errors', log: errors.snapshot(), initial: true }],
    replay: () => extension?.replay(),
    readVnc(connectionId: unknown, id: unknown, attempt: unknown) {
      if (closed) throw new Error('Backend is closed');
      return vnc(connectionId, id).read(z.string().uuid().parse(attempt));
    },
    writeVnc(connectionId: unknown, id: unknown, attempt: unknown, data: Uint8Array) {
      if (closed) throw new Error('Backend is closed');
      return vnc(connectionId, id).write(z.string().uuid().parse(attempt), data);
    },
    async request(method: string, args: unknown[], owner = 'desktop') {
      if (closed) throw new Error('Backend is closed');
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Unsupported operation: ${method}`);
      client = owner;
      return handler(...args);
    },
    /** Starts counting a client's unacknowledged terminal output from zero, and pacing terminals to it. */
    attach(owner: string) { sessions.attach(owner); },
    /** Whether a client has fallen more than `limit` behind on some terminal's output. */
    behind: (owner: string, limit: number) => sessions.behind(owner, limit),
    /** Stops counting a client's terminal output and pacing terminals to it. */
    detach(owner: string) { sessions.detach(owner); },
    release(owner: string) { drafts.delete(owner); },
    async close() { closed = true; await connecting; extension?.close(); await sessions.close(); askpass.close(); },
  };
}
export type Backend = Awaited<ReturnType<typeof createBackend>>;
