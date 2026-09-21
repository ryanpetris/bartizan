import { Configuration } from '../src/core/configuration';
import { ConnectionController } from '../src/main/connection';
import type { Askpass } from '../src/main/askpass';
import { defaultSettings } from '../src/shared';

export function connectionFixture(directory: string) {
  const configuration = new Configuration({ file: '', settings: { ...defaultSettings, remoteSessionIntegration: false }, defaults: {}, profiles: [] });
  const connection = new ConnectionController('c', { host: 'example.invalid' }, undefined, configuration, directory, {} as Askpass, '', () => {}, () => {}, () => {}, () => {}, new Map());
  return { connection, configuration };
}
