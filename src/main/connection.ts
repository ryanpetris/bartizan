import { Processes } from './processes';
import { userInfo } from 'node:os';
import { remoteCommand, loginCommand } from './remote-sessions';
import { remotePorts } from './remote-ports';
import type { HelperMessage, HelperRequest, RemoteSession } from '../helper-messages';
import { RemoteHelper } from './remote-helper';
import { RemoteIntegration } from './remote-integration';
import { resolveSpec, merge, builtins, type Spec, type Catalog } from '../core/config';
import type { Configuration } from '../core/configuration';
import type { Browsers } from './browser';
import { ApplicationSession } from './application-session';
import { applications, type ApplicationId, type Connection, type TerminalSession } from '../shared';
import type { ConnectionInfo } from './connection-info';
import type { Askpass } from './askpass';
import { SshConnection } from './ssh-connection';
import { TerminalController } from './terminal';

/**
 * Where a connection goes, compared without case, IPv6 spelling, or the difference between an omitted username or port
 * and its default.
 */
export function destination(spec: Spec) {
  const [address, scope] = spec.host!.split('%');
  const host = address!.includes(':') ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address!.toLowerCase();
  return JSON.stringify([scope === undefined ? host : `${host}%${scope}`, spec.username || userInfo().username, spec.port ?? 22]);
}
export class ConnectionController {
  readonly terminals = new Map<string, TerminalController>();
  readonly remoteSessions = new Map<string, RemoteSession>();
  private readonly remoteTerminals = new Map<string, TerminalController>();
  readonly info: Connection;
  readonly processes = new Processes(snapshot => { this.info.processes = snapshot; this.changed(); });
  spec: Spec;
  private transport?: SshConnection;
  get port() { return this.transport?.port ?? 0; }
  get socket() { return this.transport?.socket ?? ''; }
  get ended() { return this.transport?.ended ?? Promise.resolve(); }
  helper?: RemoteHelper;
  browsers?: Browsers;
  readonly applications = new Map<string, ApplicationSession>();
  private readonly integration = new RemoteIntegration(this);
  private readonly helperUsers = new Set<object>();
  private disposed = false;
  private ports?: { at: number; ports: Promise<number[]> };
  constructor(id: string, private overrides: Spec, profileId: string | undefined, private configuration: Configuration,
    private directory: string, private askpass: Askpass, private askpassHelper: string, private publish: () => void,
    private data: (id: string, chunk: string) => void, private diagnostic: (message: string, connectionId: string, label: string) => void,
    private receive: (message: HelperMessage) => void, private terminalIndex: Map<string, TerminalController>) {
    this.spec = resolveSpec(configuration.catalog, profileId, overrides);
    this.info = { id, profileId, label: this.spec.label ?? profileId ?? this.spec.host!, host: this.spec.host!, username: this.spec.username, status: 'closed', terminal: {}, processes: [] };
    this.configure(configuration.catalog);
    configuration.on('changed', this.configure);
  }
  readonly changed = () => this.publish();
  private configure = (catalog: Catalog) => {
    const profile = catalog.profiles.find(profile => profile.id === this.info.profileId);
    this.spec = merge(merge(merge(builtins, catalog.defaults), profile?.spec ?? {}), this.overrides);
    this.info.label = this.spec.label ?? this.info.profileId ?? this.spec.host!;
    this.info.terminal = {
      font: catalog.settings.terminalFont, font_size: catalog.settings.terminalFontSize,
      ligatures: catalog.settings.terminalLigatures, webgl: catalog.settings.terminalWebgl,
      ...this.spec.terminal,
    };
    this.integration.sync(this.spec.remote_sessions ?? catalog.settings.remoteSessionIntegration);
  };
  setHelperNeeded(consumer: object, needed: boolean) {
    if (needed) this.helperUsers.add(consumer);
    else this.helperUsers.delete(consumer);
    this.syncHelper();
  }
  async openApplication(application: ApplicationId) {
    if (!this.browsers) throw new Error('Embedded browsers are unavailable');
    const id = await this.browsers.open(undefined, 'new', false, { name: applications[application].name, application: ApplicationSession.initial(application) });
    const browser = this.browsers.entries.get(id)!;
    browser.application = new ApplicationSession(this, browser, application);
    browser.application.start();
    return id;
  }
  /** Looks for the optional applications on the host, as its login shell finds them or in the user's own programs. */
  private async detect(transport: SshConnection) {
    if (!this.browsers) return;
    const found = await remoteCommand(transport.socket, transport.spec, 'if command -v t3 >/dev/null 2>&1 || { [ -f "$HOME/.local/bin/t3" ] && [ -x "$HOME/.local/bin/t3" ]; }; then echo t3; fi').catch(() => '');
    if (this.transport !== transport || this.info.status !== 'connected') return;
    this.info.installed = found.split('\n').filter((line): line is ApplicationId => line === 't3');
    this.changed();
  }
  private syncHelper() {
    const needed = this.helperUsers.size > 0;
    if (this.info.status !== 'connected') {
      this.helper?.stop(); this.helper = undefined;
    } else if (this.helper) this.helper.setNeeded(needed);
    else if (needed) {
      const helper = new RemoteHelper(this.socket, this.transport!.spec, message => {
        if (this.helper !== helper) return;
        this.receiveHelperMessage(message);
        this.receive(message);
      }, () => [this.integration.configuration()], record => this.processes.report(record));
      this.helper = helper;
    }
  }
  async sendHelperMessage(message: HelperRequest) {
    if (!this.helper) throw new Error('Remote helper is disconnected');
    await this.helper.send(message);
  }
  async connect(initialTerminal = true): Promise<void> {
    if (this.disposed) throw new Error('Connection is removed');
    if (this.info.status !== 'closed') throw new Error('Disconnect before reconnecting');
    await this.ended;
    this.configure(this.configuration.catalog);
    const spec = resolveSpec(this.configuration.catalog, this.info.profileId, this.overrides);
    Object.assign(this.info, { host: spec.host!, username: spec.username, status: 'connecting', exitCode: undefined });
    const initial = initialTerminal ? this.allocateTerminal() : undefined;
    let diagnosticTerminal = initial;
    const transport = this.transport = new SshConnection(spec, this.info.id, this.directory, this.askpass, this.askpassHelper,
      () => {
        diagnosticTerminal = undefined;
        this.info.status = 'connected'; this.integration.sync(this.spec.remote_sessions ?? this.configuration.catalog.settings.remoteSessionIntegration); this.browsers?.sync();
        if (initial && this.terminals.has(initial.info.id) && initial.info.status !== 'closed') initial.start(transport);
        for (const terminal of this.terminals.values()) if (terminal.reconnectOnConnect) this.startTerminal(terminal);
        for (const browser of this.browsers?.entries.values() ?? []) if (browser.application?.relaunches && browser.info.application?.event.type === 'applications.ended') browser.application.retry(true);
        void this.detect(transport);
        this.changed();
      },
      code => {
        if (this.info.status === 'connecting') this.failReconnects(`SSH connection exited with code ${code}`);
        this.info.status = 'closed'; this.info.exitCode = code;
        this.disconnected(); this.changed();
      },
      text => {
        if (!diagnosticTerminal || diagnosticTerminal.info.status === 'closed') diagnosticTerminal = [...this.terminals.values()].find(terminal => terminal.info.status !== 'closed') ?? diagnosticTerminal;
        if (diagnosticTerminal && this.terminals.has(diagnosticTerminal.info.id)) this.data(diagnosticTerminal.info.id, text);
      },
      text => { if (!diagnosticTerminal || !this.terminals.has(diagnosticTerminal.info.id)) this.diagnostic(text, this.info.id, this.info.label); });
    try { await transport.start(); }
    catch (error) { this.info.status = 'closed'; initial?.close(); this.failReconnects(String(error)); this.disconnected(); this.changed(); throw error; }
    this.changed();
  }
  private allocateTerminal(remoteSession?: TerminalSession['remoteSession']) {
    const terminal = new TerminalController(this, this.data, remoteSession);
    this.terminals.set(terminal.info.id, terminal); this.terminalIndex.set(terminal.info.id, terminal);
    if (remoteSession) this.remoteTerminals.set(remoteSession.key, terminal);
    return terminal;
  }
  terminalEnded(terminal: TerminalController) {
    const key = terminal.info.remoteSession?.key;
    if (key && this.remoteTerminals.get(key) === terminal) this.remoteTerminals.delete(key);
  }
  removeTerminal(terminal: TerminalController) {
    this.terminals.delete(terminal.info.id); this.terminalIndex.delete(terminal.info.id);
  }
  receiveHelperMessage(message: HelperMessage) {
    if (message.type === 'helper.error') { for (const application of this.applications.values()) application.fail(message.message); }
    else if (message.type === 'applications.spawned') this.applications.get(message.launchId)?.receiveSpawned(message);
    else if ('launchId' in message) this.applications.get(message.launchId)?.receive(message);
    const state = this.info.remoteSessions;
    if (!state || message.type.startsWith('applications.')) return;
    if (message.type === 'helper.error') {
      state.loading = false; state.errors = [{ message: message.message }];
    } else if (message.type === 'sessions.snapshot') {
      const covered = new Set(message.sources), failed = new Set(message.errors.map(error => error.source));
      const previous = new Map(this.remoteSessions);
      this.remoteSessions.clear();
      for (const session of message.sessions) this.remoteSessions.set(session.key, { ...session, error: previous.get(session.key)?.error });
      for (const session of previous.values()) if (!covered.has(session.source) && (failed.has(undefined) || failed.has(session.source)) && !this.remoteSessions.has(session.key)) this.remoteSessions.set(session.key, session);
      state.errors = message.errors; state.loading = false;
    } else if (message.type === 'sessions.remove') {
      if (this.remoteSessions.get(message.key)?.source === message.source) this.remoteSessions.delete(message.key);
    } else if (message.type === 'sessions.upsert') {
      const error = this.remoteSessions.get(message.session.key)?.error;
      if (!this.remoteSessions.has(message.session.key) && this.remoteSessions.size >= 100) this.remoteSessions.delete(this.remoteSessions.keys().next().value!);
      this.remoteSessions.set(message.session.key, { ...message.session, error });
    }
    this.publishRemoteSessions(); this.changed();
  }
  publishRemoteSessions() {
    while (this.remoteSessions.size > 100) this.remoteSessions.delete([...this.remoteSessions.keys()].at(-1)!);
    if (this.info.remoteSessions) this.info.remoteSessions.sessions = [...this.remoteSessions.values()];
  }
  resumeRemoteSessions(keys: string[], takeover: boolean): string[] {
    if (this.info.status !== 'connected' || !this.integration.active) throw new Error('Session integration is unavailable');
    const opened: string[] = [];
    for (const key of new Set(keys)) {
      const session = this.remoteSessions.get(key);
      if (!session || session.attached && !takeover) continue;
      if (this.remoteTerminals.has(key)) continue;
      const command = takeover ? session.commands.takeover ?? session.commands.resume : session.commands.resume;
      if (!command) continue;
      const id = this.newTerminal(command, { ...session, error: undefined });
      const terminal = this.terminals.get(id)!;
      if (terminal.process) {
        opened.push(id);
        session.error = undefined;
      } else {
        terminal.close();
        session.error = 'Could not open terminal';
      }
    }
    this.changed();
    return opened;
  }
  /** Ends a session on the host; the terminals showing it close as it goes. */
  async killRemoteSession(key: string): Promise<void> {
    if (this.info.status !== 'connected' || !this.integration.active) throw new Error('Session integration is unavailable');
    const session = this.remoteSessions.get(key);
    if (!session?.commands.stop) throw new Error('Session cannot be stopped');
    await remoteCommand(this.socket, this.transport!.spec, session.commands.stop);
    void this.sendHelperMessage({ type: 'sessions.refresh' }).catch(() => {});
  }
  private startTerminal(terminal: TerminalController, command?: string) {
    const key = terminal.info.remoteSession?.key;
    if (key) {
      const other = this.remoteTerminals.get(key);
      if (other && other !== terminal) { terminal.failure('Session is already open in another terminal'); this.changed(); return; }
      this.remoteTerminals.set(key, terminal);
    }
    terminal.start(this.transport!, command);
  }
  private failReconnects(message: string) {
    for (const terminal of this.terminals.values()) if (terminal.reconnectOnConnect) terminal.failure(message);
  }
  async reconnectTerminal(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.info.status !== 'closed') return;
    if (this.info.status === 'connected') this.startTerminal(terminal);
    else {
      terminal.reconnectOnConnect = true;
      if (this.info.status === 'closed') {
        try { await this.connect(false); }
        catch (error) { if (terminal.reconnectOnConnect) terminal.failure(String(error)); this.changed(); }
      }
    }
  }
  newTerminal(command?: string, remoteSession?: TerminalSession['remoteSession']): string {
    if (this.info.status !== 'connected') throw new Error('Connection is not connected');
    const terminal = this.allocateTerminal(remoteSession);
    this.startTerminal(terminal, command ? loginCommand(command) : undefined);
    return terminal.info.id;
  }
  /** The host's listening ports, read again at most every few seconds. */
  remotePorts(): Promise<number[]> {
    if (this.info.status !== 'connected') return Promise.resolve([]);
    const now = performance.now();
    if (!this.ports || now - this.ports.at >= 5000) this.ports = { at: now, ports: remotePorts(this.socket, this.transport!.spec) };
    return this.ports.ports;
  }
  /** Whether the connection was made from a destination chosen by host, username and port alone. */
  chosen = false;
  /** A chosen connection's destination, of the transport in use or of the next one while disconnected. */
  get destination() {
    if (!this.chosen) return;
    if (this.info.status !== 'closed' && this.transport) return destination(this.transport.spec);
    try { return destination(resolveSpec(this.configuration.catalog, undefined, this.overrides)); } catch { return; }
  }
  details(): Promise<ConnectionInfo> {
    return this.transport?.details() ?? Promise.resolve({ status: this.info.status, username: this.info.username || userInfo().username });
  }
  private disconnected() {
    this.info.installed = undefined;
    this.integration.sync(false);
    for (const application of this.applications.values()) application.fail('Connection disconnected');
    this.syncHelper();
    for (const terminal of this.terminals.values()) terminal.stop(true);
    this.browsers?.sync();
  }
  async disconnect() {
    this.info.status = 'closed';
    this.disconnected(); this.changed();
    await this.transport?.stop();
  }
  async dispose() {
    this.disposed = true;
    this.configuration.off('changed', this.configure);
    await this.disconnect();
    await this.browsers?.closeConnection();
    for (const terminal of this.terminals.values()) terminal.close();
  }
}
