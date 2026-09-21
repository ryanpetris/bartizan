import { registerHooks } from 'node:module';
import * as hooks from './program-text-hooks.mjs';

// Tests use the same Python source and archive formats as the build.
registerHooks(hooks);
