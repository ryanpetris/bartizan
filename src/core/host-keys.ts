import { createHash, ECDH } from 'node:crypto';

export const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;

/** Parses a single OpenSSH public key; comments do not participate in trust. */
export function publicKeyFingerprint(value: string): string {
  if (value.length > 65536 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error('Expected a single OpenSSH public host key');
  const match = /^[ \t]*(\S+)[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+[^\r\n]*)?$/.exec(value);
  if (!match) throw new Error('Expected an OpenSSH public host key');
  const [, type, encoded] = match;
  const key = Buffer.from(encoded!, 'base64');
  if (key.toString('base64') !== encoded) throw new Error('Invalid public host key encoding');
  let offset = 0;
  const field = () => {
    if (offset + 4 > key.length) throw new Error('Truncated public host key');
    const length = key.readUInt32BE(offset); offset += 4;
    if (length > key.length - offset) throw new Error('Truncated public host key');
    const result = key.subarray(offset, offset + length); offset += length;
    return result;
  };
  const integer = () => {
    const bytes = field();
    if (!bytes.length || bytes[0]! & 0x80 || bytes[0] === 0 && (bytes.length === 1 || !(bytes[1]! & 0x80))) throw new Error('Invalid public host key integer');
  };
  if (!field().equals(Buffer.from(type!))) throw new Error('Public host key type does not match its contents');
  if (type === 'ssh-ed25519') {
    if (field().length !== 32) throw new Error('Invalid Ed25519 public host key');
  } else if (type === 'ssh-rsa') {
    integer(); integer();
  } else if (type?.startsWith('ecdsa-sha2-')) {
    const curve = type.slice('ecdsa-sha2-'.length);
    const curves: Record<string, [string, number]> = { nistp256: ['prime256v1', 65], nistp384: ['secp384r1', 97], nistp521: ['secp521r1', 133] };
    const parameters = curves[curve];
    if (!parameters || !field().equals(Buffer.from(curve))) throw new Error('Invalid ECDSA public host key curve');
    const point = field();
    if (point.length !== parameters[1] || point[0] !== 4) throw new Error('Invalid ECDSA public host key point');
    ECDH.convertKey(point, parameters[0]);
  } else {
    throw new Error('Expected an Ed25519, ECDSA or RSA public host key');
  }
  if (offset !== key.length) throw new Error('Unexpected public host key data');
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=$/, '')}`;
}

export function hostKeyPins(keys?: { fingerprints?: string[]; public_keys?: string[] }): string[] {
  return [...new Set([...(keys?.fingerprints ?? []), ...(keys?.public_keys ?? []).map(publicKeyFingerprint)])];
}

export function pinnedHostKey(pins: unknown, args: string[]): string {
  if (!Array.isArray(pins) || !pins.length || pins.some(pin => typeof pin !== 'string' || !fingerprintPattern.test(pin))) throw new Error('Invalid host key fingerprints');
  const [reason, type, encoded] = args;
  if (reason === 'ORDER') return '';
  if (args.length !== 3 || !['HOSTNAME', 'ADDRESS'].includes(reason!)) throw new Error('Invalid host key lookup');
  if (!type || !/^[A-Za-z0-9@._+-]+$/.test(type) || type.includes('-cert-')) throw new Error('Pinned connections require a public host key, not a host certificate');
  if (!encoded || encoded.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid host key');
  const key = Buffer.from(encoded, 'base64');
  if (key.toString('base64') !== encoded || key.length < 4 || key.readUInt32BE(0) !== Buffer.byteLength(type) || key.subarray(4, 4 + Buffer.byteLength(type)).toString() !== type) throw new Error('Invalid host key');
  const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=$/, '')}`;
  if (!pins.includes(fingerprint)) throw new Error(`Host key fingerprint does not match configured pins: ${fingerprint}`);
  return `* ${type} ${encoded}\n`;
}
