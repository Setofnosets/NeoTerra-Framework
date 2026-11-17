/**
 * Neo Terra Framework — SillyTavern extension entry point.
 *
 * SillyTavern calls the exported hooks declared in manifest.json:
 *   activate/enable -> initialize()
 *   disable/delete  -> dispose()
 *
 * The manifest also names `neoTerraGenerateInterceptor`; SillyTavern resolves
 * it from `globalThis`, so registration is repeated on every enable (a module
 * is imported only once, even if the extension is disabled and re-enabled).
 */

import { neoTerraGenerateInterceptor } from './src/context/interceptor.js';
import { initialize as initializeShell, dispose as disposeShell } from './src/ui/shell.js';

function registerInterceptor() {
    if (typeof globalThis !== 'undefined') {
        globalThis.neoTerraGenerateInterceptor = neoTerraGenerateInterceptor;
    }
}

function unregisterInterceptor() {
    if (typeof globalThis !== 'undefined') {
        delete globalThis.neoTerraGenerateInterceptor;
    }
}

registerInterceptor();

export async function initialize(options = {}) {
    registerInterceptor();
    return initializeShell(options);
}

export function dispose() {
    unregisterInterceptor();
    return disposeShell();
}
