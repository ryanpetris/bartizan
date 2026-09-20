import { register } from 'node:module';

// The build bundles helper programs as text; tests load them the same way.
register('./program-text-hooks.mjs', import.meta.url);
