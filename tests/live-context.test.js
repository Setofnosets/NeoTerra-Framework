import assert from 'node:assert/strict';
import test from 'node:test';

import { readLiveContext, resolveActiveChatId } from '../src/core/live-context.js';

test('readLiveContext returns the fresh SillyTavern context', () => {
    const live = { chatId: 'chat-live' };
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => live };
    try {
        assert.equal(readLiveContext(), live);
    } finally {
        if (previous === undefined) {
            delete globalThis.SillyTavern;
        } else {
            globalThis.SillyTavern = previous;
        }
    }
});

test('readLiveContext falls back when SillyTavern is unavailable or throws', () => {
    const previous = globalThis.SillyTavern;
    try {
        delete globalThis.SillyTavern;
        assert.equal(readLiveContext('fallback'), 'fallback');

        globalThis.SillyTavern = {
            getContext: () => {
                throw new Error('boom');
            },
        };
        assert.equal(readLiveContext('fallback'), 'fallback');
    } finally {
        if (previous === undefined) {
            delete globalThis.SillyTavern;
        } else {
            globalThis.SillyTavern = previous;
        }
    }
});

test('getCurrentChatId wins over a stale chatId snapshot', () => {
    const ctx = {
        getCurrentChatId: () => 'chat-current',
        chatId: 'chat-stale',
        chatMetadata: { chat_id: 'chat-metadata' },
    };
    assert.equal(resolveActiveChatId(ctx), 'chat-current');
});

test('resolveActiveChatId falls back to chatId then chatMetadata.chat_id', () => {
    assert.equal(resolveActiveChatId({ chatId: 'chat-snapshot' }), 'chat-snapshot');
    assert.equal(
        resolveActiveChatId({ chatId: '', chatMetadata: { chat_id: 'chat-meta' } }),
        'chat-meta',
    );
    assert.equal(
        resolveActiveChatId({ chatId: '  chat-trim  ' }),
        'chat-trim',
    );
});

test('resolveActiveChatId is safe when the accessor throws or values are invalid', () => {
    const throwing = {
        getCurrentChatId: () => {
            throw new Error('not ready');
        },
        chatId: 'chat-after-throw',
    };
    assert.equal(resolveActiveChatId(throwing), 'chat-after-throw');

    // A working accessor that reports "no chat" must not fall back to a stale
    // snapshot: that snapshot would bind a new season to the previous chat.
    assert.equal(
        resolveActiveChatId({ getCurrentChatId: () => '', chatId: 'chat-stale' }),
        null,
    );

    assert.equal(resolveActiveChatId(null), null);
    assert.equal(resolveActiveChatId({}), null);
    assert.equal(resolveActiveChatId({ chatId: 42 }), null);
    assert.equal(resolveActiveChatId({ chatMetadata: null }), null);
});

test('group chat ids pass through unchanged', () => {
    assert.equal(
        resolveActiveChatId({ getCurrentChatId: () => 'group-abc123' }),
        'group-abc123',
    );
});
