/**
 * New-timeline chat creation.
 *
 * "New timeline" must never destroy the current chat. This module wraps
 * SillyTavern's own chat creation so the fallback is testable: prefer the
 * installed Director card, otherwise keep the current card, and create a new
 * chat through `/newchat`. If SillyTavern cannot create a chat, the caller
 * falls back to the explicit replace confirmation.
 */

import { DIRECTOR_CARD_NAME, findStCharacter } from './season-start.js';

function readChatId(ctx, getChatId) {
    try {
        const value = typeof getChatId === 'function'
            ? getChatId()
            : (typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null);
        return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

function withTimeout(promise, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`chat creation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * Create a new chat for a fresh timeline.
 *
 * @param {{
 *   ctx?: object,
 *   director?: object|null,
 *   execute?: Function,
 *   selectCharacter?: Function,
 *   getChatId?: Function,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   chatId?: string|null,
 *   characterName?: string|null,
 *   usedDirector?: boolean,
 *   reason?: string,
 *   message?: string,
 * }>}
 */
export async function createNewTimeline({
    ctx = null,
    director = null,
    execute = null,
    selectCharacter = null,
    getChatId = null,
    timeoutMs = 15000,
} = {}) {
    const run = execute
        ?? (typeof ctx?.executeSlashCommandsWithOptions === 'function'
            ? ctx.executeSlashCommandsWithOptions.bind(ctx)
            : null);
    if (typeof run !== 'function') {
        return {
            ok: false,
            reason: 'no-chat-api',
            message: 'SillyTavern cannot create a new chat from here. Replace this chat’s world instead.',
        };
    }

    const directorCharacter = director ?? findStCharacter(ctx, DIRECTOR_CARD_NAME);
    const select = selectCharacter
        ?? (typeof ctx?.selectCharacterById === 'function' ? ctx.selectCharacterById.bind(ctx) : null);
    const before = readChatId(ctx, getChatId);
    const previousCharacterId = ctx?.characterId ?? null;
    let usedDirector = false;

    if (directorCharacter && typeof select === 'function') {
        const target = directorCharacter.avatar ?? directorCharacter.id ?? null;
        try {
            if (target) {
                await select(target);
                usedDirector = true;
            }
        } catch {
            // Selecting the Director is best-effort: the current card still
            // hosts the new chat when the switch fails.
            usedDirector = false;
        }
    }

    const restorePreviousCharacter = async () => {
        if (!usedDirector || !previousCharacterId || typeof select !== 'function') {
            return;
        }
        try {
            await select(previousCharacterId);
        } catch {
            // The user can pick the card again; never throw from cleanup.
        }
    };

    try {
        await withTimeout(Promise.resolve(run('/newchat')), timeoutMs);
    } catch (error) {
        await restorePreviousCharacter();
        return {
            ok: false,
            reason: 'chat-create-failed',
            message: `A new chat could not be created (${error?.message ?? String(error)}). Replace this chat’s world instead.`,
        };
    }

    const after = readChatId(ctx, getChatId);
    if (before && after && before === after) {
        // `/newchat` can be blocked or silently no-op; never report success
        // without a new chat id.
        await restorePreviousCharacter();
        return {
            ok: false,
            reason: 'chat-not-created',
            message: 'SillyTavern did not open a new chat. Replace this chat’s world instead.',
        };
    }
    return {
        ok: true,
        chatId: after,
        characterName: usedDirector ? DIRECTOR_CARD_NAME : null,
        usedDirector,
        ...(after ? {} : { warning: 'chat-id-unverified' }),
    };
}
