/**
 * Live SillyTavern context helpers.
 *
 * SillyTavern's `getContext()` returns a plain object snapshot: `chatId` is
 * computed at call time and `chatMetadata` is a reference that gets replaced when
 * a chat loads or changes. Never cache that object across chats; re-read it at the
 * moment of action and resolve the active chat id through `getCurrentChatId()`
 * (the canonical accessor, which also handles group chats).
 */

import { createLogger } from './logger.js';

const logger = createLogger('live-context');

/**
 * Re-read `SillyTavern.getContext()`. Returns `fallback` when SillyTavern is
 * unavailable or the context call throws.
 *
 * @param {object|null} [fallback]
 * @returns {object|null}
 */
export function readLiveContext(fallback = null) {
    try {
        const context = globalThis.SillyTavern?.getContext?.();
        if (context !== null && typeof context === 'object') {
            return context;
        }
    } catch (error) {
        logger.warn('Could not read the live SillyTavern context', error);
    }
    return fallback;
}

/**
 * Resolve the active chat id without trusting a cached snapshot.
 *
 * A present `getCurrentChatId()` is authoritative: if it reports no chat, the
 * fallbacks are not consulted, because a stale snapshot must not bind a new
 * season to the previous chat. Fallbacks apply only when the accessor is
 * unavailable or throws:
 *   1. `ctx.getCurrentChatId()` — canonical upstream accessor, group-aware
 *   2. `ctx.chatId` — the context snapshot's computed value
 *   3. `ctx.chatMetadata.chat_id`
 *
 * @param {object|null} ctx
 * @returns {string|null}
 */
export function resolveActiveChatId(ctx) {
    if (ctx === null || typeof ctx !== 'object') {
        return null;
    }

    const candidates = [];
    if (typeof ctx.getCurrentChatId === 'function') {
        try {
            const current = ctx.getCurrentChatId();
            // Trust the canonical accessor: an empty value means "no chat", not
            // "fall back to the stale snapshot".
            return typeof current === 'string' && current.trim().length > 0
                ? current.trim()
                : null;
        } catch (error) {
            logger.warn('getCurrentChatId failed; falling back to the context snapshot', error);
        }
    }
    candidates.push(ctx.chatId);
    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
        candidates.push(ctx.chatMetadata.chat_id);
    }

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}
