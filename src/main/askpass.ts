import { createServer, type Socket, type Server } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CredentialError, readSecret, secretValue, type Spec } from '../core/config';

/** A host key OpenSSH asks the user to trust. */
export type HostKey = { host?: string; algorithm?: string; fingerprint?: string; notes: string[] };
/** An OpenSSH prompt; `secret` is what the prompt asks for, when it names one. */
export type Challenge = { id: string; connectionId: string; prompt: string; confirm: boolean; notification: boolean; secret?: 'password' | 'passphrase'; hostKey?: HostKey };
function hostKey(prompt: string): HostKey | undefined {
  if (!/continue connecting \(yes\/no/.test(prompt)) return undefined;
  const result: HostKey = { notes: [] };
  for (const line of prompt.split('\n').map(l => l.trim()).filter(Boolean)) {
    const host = /^The authenticity of host '([^']+)'/.exec(line);
    const key = /^(\S+) key fingerprint is:?\s+(\S+?)\.?$/.exec(line);
    if (host) result.host = host[1]!.replace(/ \(.*\)$/, '');
    else if (key) { result.algorithm = key[1]; result.fingerprint = key[2]; }
    else if (!/continue connecting/.test(line)) result.notes.push(line);
  }
  return result;
}
const requestSchema = z.strictObject({ token: z.string(), prompt: z.string().max(16384), hint: z.string().max(32) });
export class Askpass {
  private server: Server;
  private directory = mkdtempSync(join(tmpdir(), 'bartizan-auth-'));
  private credentials = new Map<string, { id: string; spec: Spec; used: Set<string> }>();
  private pending = new Map<string, { challenge: Challenge; socket: Socket }>();
  readonly socketPath = join(this.directory, 'broker');
  readonly helperPath = join(this.directory, 'askpass');
  constructor(private notify: (challenge: Challenge) => void, private withdrawn: (id: string) => void = () => {}, private error: (message: string, connectionId: string) => void = () => {}) {
    chmodSync(this.directory, 0o700);
    writeFileSync(this.helperPath, '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$BARTIZAN_EXEC" "$BARTIZAN_ASKPASS_JS" "$@"\n', { mode: 0o700 });
    this.server = createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(120000, () => socket.destroy());
      socket.on('error', () => {});
      let buffer = '';
      let received = false;
      socket.on('data', data => {
        if (received) return;
        buffer += data.toString();
        if (Buffer.byteLength(buffer) > 20000) { socket.destroy(); return; }
        if (!buffer.includes('\n')) return;
        received = true;
        try {
          const request = requestSchema.parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
          const credential = this.credentials.get(request.token);
          if (!credential) { socket.destroy(); return; }
          const confirm = request.hint === 'confirm';
          const notification = request.hint === 'none';
          const kind = !notification && !confirm && /^Enter passphrase for key '.+':\s*$/.test(request.prompt) ? 'passphrase' :
            !notification && !confirm && /'.*password:\s*$/.test(request.prompt) && request.prompt.includes("'s password:") ? 'password' : undefined;
          const mode = credential.spec.auth?.method;
          if (kind && !credential.used.has(kind) && (kind === 'passphrase' || mode === 'auto' || mode === 'password')) {
            credential.used.add(kind);
            try {
              const secret = readSecret(credential.spec.auth?.[kind]);
              if (secret !== undefined) { socket.end(JSON.stringify({ value: secret }) + '\n'); return; }
            } catch (error) {
              let message = 'Configured credential could not be read';
              if (error instanceof CredentialError) message = error.message;
              else if (error instanceof z.ZodError) message = error.issues[0]?.message ?? message;
              else if (error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') message = 'Configured credential is not valid UTF-8';
              this.error(message, credential.id);
            }
          }
          const id = randomUUID();
          const secret = /passphrase/i.test(request.prompt) ? 'passphrase' as const : /password/i.test(request.prompt) ? 'password' as const : undefined;
          const challenge = { id, connectionId: credential.id, prompt: request.prompt, confirm, notification, secret, hostKey: hostKey(request.prompt) };
          this.pending.set(id, { challenge, socket });
          socket.once('close', () => { if (this.pending.delete(id)) this.withdrawn(id); });
          this.notify(challenge);
        } catch { socket.end(JSON.stringify({ value: null }) + '\n'); }
      });
    });
  }
  get challenges(): Challenge[] { return [...this.pending.values()].map(entry => entry.challenge); }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => { chmodSync(this.socketPath, 0o600); resolve(); });
    });
  }
  register(id: string, spec: Spec, executable: string, script: string): Record<string, string> {
    const token = randomBytes(32).toString('hex');
    this.credentials.set(token, { id, spec, used: new Set() });
    return { SSH_ASKPASS: this.helperPath, SSH_ASKPASS_REQUIRE: 'force', BARTIZAN_SOCKET: this.socketPath, BARTIZAN_TOKEN: token, BARTIZAN_EXEC: executable, BARTIZAN_ASKPASS_JS: script };
  }
  answer(id: string, input: unknown) {
    const value = secretValue.nullable().parse(input);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); this.withdrawn(id);
    pending.socket.end(JSON.stringify({ value }) + '\n');
    return pending.challenge.connectionId;
  }
  unregister(id: string) {
    for (const [key, entry] of this.credentials) if (entry.id === id) this.credentials.delete(key);
    for (const [key, entry] of this.pending) if (entry.challenge.connectionId === id) { entry.socket.destroy(); this.pending.delete(key); this.withdrawn(key); }
  }
  close() {
    for (const id of [...this.pending.keys()]) this.answer(id, null);
    this.credentials.clear(); this.server.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
