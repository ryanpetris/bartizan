import { EventEmitter } from 'node:events';
import type { Catalog } from './config';

/** Every subscriber evaluates configuration changes for its own resources. */
export class Configuration extends EventEmitter<{ changed: [Catalog] }> {
  constructor(public catalog: Catalog) { super(); this.setMaxListeners(0); }
  publish(catalog: Catalog) { this.catalog = catalog; this.emit('changed', catalog); }
}
