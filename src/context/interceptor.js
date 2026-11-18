/**
 * SillyTavern generation interceptor.
 *
 * The manifest names `neoTerraGenerateInterceptor`. SillyTavern calls it with a
 * prompt copy of the chat; we render the Neo Terra blocks and splice exactly
 * one narrator/system message into that copy. The message is tagged so a second
 * run (or another entry point) removes the old one first instead of stacking a
 * duplicate. This module never calls `setExtensionPrompt`.
 */

import { DEFAULT_CONTEXT_DEPTH } from '../core/constants.js';
import { createLogger } from '../core/logger.js';
import { getSettings } from '../core/settings.js';
import { loadRegistry } from '../data/registry.js';
import { renderContext } from './renderer.js';

export const INTERCEPTOR_GLOBAL_NAME = 'neoTerraGenerateInterceptor';
export const CONTEXT_MESSAGE_NAME = 'Neo Terra';
export const CONTEXT_MARKER = 'neoterra.context';
export { DEFAULT_CONTEXT_DEPTH };

const logger = createLogger('context/interceptor');

function defaultGetContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        logger.warn('Could not read SillyTavern context', error);
        return null;
    }
}

function defaultGetWorldState(ctx) {
    const metadata = ctx?.chatMetadata?.neoterra;
    return metadata?.worldState ?? metadata?.world_state ?? null;
}

function defaultGetSeason(ctx) {
    const metadata = ctx?.chatMetadata?.neoterra;
    return metadata?.seasonDefinition ?? metadata?.season ?? null;
}

/**
 * The chat slice only contains roster forms. A villain season's knights are
 * alternate forms, so the domain block needs the full registry to name them.
 * The full registry is normally already cached by the codex/tab mount.
 */
async function defaultGetRegistry(ctx) {
    const metadata = ctx?.chatMetadata?.neoterra;
    const slice = metadata?.registry ?? null;
    const season = metadata?.seasonDefinition ?? metadata?.season ?? null;
    const knightFormKind = season?.domain?.knightFormKind ?? null;
    if (knightFormKind && Array.isArray(slice?.entries)) {
        const hasKnight = slice.entries.some((entry) => entry?.formKind === knightFormKind);
        if (!hasKnight) {
            try {
                return await loadRegistry();
            } catch {
                return slice;
            }
        }
    }
    return slice;
}

/** True for messages this extension injected into a prompt copy. */
export function isContextMessage(message) {
    return Boolean(
        message
        && message.extra
        && (message.extra.neoterra?.context === true
            || message.extra[CONTEXT_MARKER] === true),
    );
}

/** Remove every Neo Terra context message from a prompt copy. Returns the count. */
export function stripContextPrompt(chat) {
    if (!Array.isArray(chat)) {
        return 0;
    }
    let removed = 0;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (isContextMessage(chat[index])) {
            chat.splice(index, 1);
            removed += 1;
        }
    }
    return removed;
}

/**
 * Insert the rendered context message at the configured depth.
 * Any previous injection is removed first, so the operation is idempotent.
 *
 * @param {Array<object>} chat prompt copy (mutated)
 * @param {string} text rendered blocks
 * @param {{ depth?: number, name?: string, generation?: string|number }} [options]
 * @returns {object|null} the inserted message, or null for empty text
 */
export function injectContextPrompt(chat, text, options = {}) {
    if (!Array.isArray(chat)) {
        throw new TypeError('injectContextPrompt requires a chat array');
    }
    stripContextPrompt(chat);

    if (typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }

    const depthValue = Number(options.depth);
    const depth = Number.isFinite(depthValue)
        ? Math.min(100, Math.max(0, Math.floor(depthValue)))
        : DEFAULT_CONTEXT_DEPTH;
    const index = Math.max(0, chat.length - depth);

    const message = {
        name: options.name ?? CONTEXT_MESSAGE_NAME,
        mes: text,
        is_user: false,
        extra: {
            type: 'narrator',
            neoterra: {
                context: true,
                generation: options.generation ?? null,
                version: 1,
            },
        },
    };
    chat.splice(index, 0, message);
    return message;
}

/**
 * Build the interceptor function. Dependencies are injectable for tests.
 */
export function createGenerationInterceptor(options = {}) {
    const {
        getContext = defaultGetContext,
        getSettings: readSettings = (ctx) => getSettings(ctx),
        getWorldState = defaultGetWorldState,
        getSeason = defaultGetSeason,
        getRegistry = defaultGetRegistry,
        render = renderContext,
        log = logger,
    } = options;

    return async function intercept(chat, _contextSize, _abort, type) {
        if (!Array.isArray(chat)) {
            return;
        }
        let settings;
        try {
            const ctx = getContext();
            settings = readSettings(ctx);
            const state = getWorldState(ctx);
            if (!state) {
                stripContextPrompt(chat);
                return;
            }
            const registry = await getRegistry(ctx);
            const result = render(state, {
                settings,
                season: getSeason(ctx),
                registry,
            });
            const depth = settings?.context?.depth ?? DEFAULT_CONTEXT_DEPTH;
            injectContextPrompt(chat, result?.text ?? '', {
                depth,
                generation: type,
            });
        } catch (error) {
            // Never abort a generation because context rendering failed.
            log.warn('Context injection failed; generation continues', error);
            stripContextPrompt(chat);
        }
    };
}

/** Singleton referenced by `manifest.json`. */
export const neoTerraGenerateInterceptor = createGenerationInterceptor();
