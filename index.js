/**
 * Neo Terra Framework — SillyTavern extension entry point.
 *
 * SillyTavern calls the exported hooks declared in manifest.json:
 *   activate/enable -> initialize()
 *   disable/delete  -> dispose()
 */

import { initialize, dispose } from './src/ui/shell.js';

export { initialize, dispose };
