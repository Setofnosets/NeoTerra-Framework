/**
 * Chat-affinity guard.
 *
 * Tracks the SillyTavern chat a multi-step operation began in. Callers capture
 * a token from `begin()`, pass it to `isCurrent()`/`assertCurrent()` after
 * asynchronous work, and call `end(token)` when finished. A chat change can
 * also abort running work through `onChange`.
 *
 * No DOM or SillyTavern globals are read at import time.
 */

export class ChatChangedError extends Error {
    constructor(previousChatId, chatId, message) {
        super(
            message ??
                `Chat changed from "${formatId(previousChatId)}" to "${formatId(chatId)}"`,
        );
        this.name = 'ChatChangedError';
        this.previousChatId = previousChatId ?? null;
        this.chatId = chatId ?? null;
    }
}

/**
 * Create a chat-affinity guard.
 *
 * @param {object} [options]
 * @param {() => unknown} [options.getChatId] Reads the external chat id.
 * @param {(event: {previousChatId: unknown, chatId: unknown}) => void} [options.onChange]
 */
export function createChatAffinity({ getChatId, onChange } = {}) {
    const listeners = new Set();
    let initialized = false;
    let chatId = null;
    let activeToken = null;

    if (typeof onChange === 'function') {
        listeners.add(onChange);
    }

    function readExternal() {
        if (typeof getChatId !== 'function') {
            return null;
        }
        return getChatId() ?? null;
    }

    function current() {
        if (!initialized) {
            chatId = readExternal();
            initialized = true;
        }
        return chatId;
    }

    // External chat changes must be reported through setChatId(); this module
    // deliberately does not poll getChatId() while a pass is active.
    function begin() {
        if (!activeToken) {
            chatId = readExternal();
            initialized = true;
        }
        const token = {
            chatId: current(),
            startedAt: Date.now(),
        };
        activeToken = token;
        return token;
    }

    function setChatId(id) {
        const next = id ?? null;
        const previous = current();
        if (next === previous) {
            return { changed: false };
        }
        chatId = next;
        initialized = true;
        notify({ previousChatId: previous, chatId: next });
        return { changed: true };
    }

    function isCurrent(token) {
        if (!token || typeof token !== 'object') {
            return false;
        }
        return (token.chatId ?? null) === current();
    }

    function assertCurrent(token) {
        if (!isCurrent(token)) {
            const previous = token?.chatId ?? null;
            throw new ChatChangedError(previous, current());
        }
        return true;
    }

    function end(token) {
        if (activeToken && activeToken === token) {
            activeToken = null;
        }
    }

    function subscribe(handler) {
        if (typeof handler !== 'function') {
            return () => {};
        }
        listeners.add(handler);
        return () => {
            listeners.delete(handler);
        };
    }

    function dispose() {
        listeners.clear();
        activeToken = null;
    }

    function notify(event) {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch (error) {
                console.warn('[Neo Terra] Chat affinity listener failed', error);
            }
        }
    }

    return {
        current,
        begin,
        setChatId,
        isCurrent,
        assertCurrent,
        end,
        onChange: subscribe,
        dispose,
    };
}

function formatId(value) {
    if (value === null || value === undefined) {
        return 'no chat';
    }
    return String(value);
}
