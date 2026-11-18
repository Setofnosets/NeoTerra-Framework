import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SCENE_AVATAR_URL,
    SCENE_KINDS,
    SCENE_MESSAGE_NAME,
    buildKickoffLines,
    buildOpeningFrameText,
    buildOpeningSceneKey,
    buildSceneChatMessage,
    buildSceneKey,
    buildTravelFrameText,
    buildTravelSceneKey,
    hasStoryHistory,
    postSceneMessage,
    readSceneExtra,
    sceneKeyOf,
    stripContextBlocks,
} from '../src/ui/chat-output.js';
import { postTravelOutcome } from '../src/ui/shell.js';

const NOW = Date.UTC(2037, 4, 1, 12, 30, 0);

function fakeCtx(initial = []) {
    const calls = { rendered: 0, saves: 0 };
    const chat = [...initial];
    return {
        chat,
        calls,
        addOneMessage(message) {
            calls.rendered += 1;
            return message;
        },
        async saveChat() {
            calls.saves += 1;
        },
    };
}

test('a scene message is a normal assistant frame the model can see', () => {
    const message = buildSceneChatMessage({
        kind: SCENE_KINDS.TRAVEL,
        text: 'Location changed: A → B',
        key: 'travel:chat:1',
        now: NOW,
    });
    assert.equal(message.name, SCENE_MESSAGE_NAME);
    assert.equal(message.is_user, false);
    // ST filters `is_system` messages out of the prompt history.
    assert.equal(message.is_system, false);
    assert.equal(message.mes, 'Location changed: A → B');
    assert.equal(message.send_date, new Date(NOW).toISOString());
    assert.ok(message.force_avatar.includes('neoterra-avatar.svg'));
    assert.equal(SCENE_AVATAR_URL, message.force_avatar);
    assert.deepEqual(readSceneExtra(message), { kind: 'travel', key: 'travel:chat:1' });
    assert.equal(sceneKeyOf(message), 'travel:chat:1');
});

test('extra fields merge into the scene record and do not leak onto the message', () => {
    const message = buildSceneChatMessage({
        kind: 'travel',
        text: 'arrival',
        key: 'k',
        extra: { encounter: { characterIds: ['a'] }, from: 'x' },
        now: NOW,
    });
    assert.deepEqual(readSceneExtra(message), {
        kind: 'travel',
        key: 'k',
        encounter: { characterIds: ['a'] },
        from: 'x',
    });
    assert.equal(Object.hasOwn(message, 'encounter'), false);
    assert.deepEqual(Object.keys(message.extra), ['neoterra']);
});

test('missing optional input still yields a valid message', () => {
    const message = buildSceneChatMessage({ text: 'only text' });
    assert.equal(message.mes, 'only text');
    assert.equal(readSceneExtra(message).kind, 'scene');
    assert.equal(readSceneExtra(message).key, null);
    assert.equal(sceneKeyOf(message), null);
    assert.ok(!Number.isNaN(new Date(message.send_date).getTime()));

    const empty = buildSceneChatMessage({});
    assert.equal(empty.mes, '');
    assert.equal(empty.is_system, false);
});

test('scene frames never carry prompt context blocks', () => {
    const text = [
        'The door opens onto the arcade.',
        '[NEOTERRA_SCENE]',
        'Location: Arcade',
        '[NEOTERRA_PLAYER]',
        'Name: Vaiva',
    ].join('\n');
    const message = buildSceneChatMessage({ kind: 'travel', text, now: NOW });
    assert.doesNotMatch(message.mes, /\[NEOTERRA_/);
    assert.match(message.mes, /The door opens onto the arcade\./);
    assert.doesNotMatch(message.mes, /Name: Vaiva/);
    // Prose-only frames pass through; a block marker and its body are removed.
    assert.equal(stripContextBlocks('The door opens.'), 'The door opens.');
    assert.equal(stripContextBlocks('[NEOTERRA_SCENE]\nLocation: Arcade'), '');
    assert.equal(stripContextBlocks('A\n\n\n\nB'), 'A\n\nB');
    assert.equal(stripContextBlocks(null), '');
});

test('buildSceneKey joins non-empty parts', () => {
    assert.equal(buildSceneKey('a', null, ' ', 'b', 3), 'a:b:3');
    assert.equal(buildSceneKey(), '');
    assert.equal(buildSceneKey(['x', 'y']), 'x:y');
});

test('posting appends once, renders once, and saves once', async () => {
    const ctx = fakeCtx([{ name: 'Player', is_user: true, mes: 'hello' }]);
    const message = buildSceneChatMessage({ kind: 'opening', text: 'begin', key: 'opening:c1:s1:0', now: NOW });
    const result = await postSceneMessage(ctx, message, { dedupeKey: 'opening:c1:s1:0' });
    assert.deepEqual(result, { posted: true, index: 1 });
    assert.equal(ctx.chat.length, 2);
    assert.equal(ctx.chat[1], message);
    assert.equal(ctx.calls.rendered, 1);
    assert.equal(ctx.calls.saves, 1);
});

test('a repeated dedupe key posts nothing', async () => {
    const ctx = fakeCtx([]);
    const first = await postSceneMessage(
        ctx,
        buildSceneChatMessage({ kind: 'travel', text: 'one', key: 'travel:c:1' }),
        { dedupeKey: 'travel:c:1' },
    );
    assert.equal(first.posted, true);
    const second = await postSceneMessage(
        ctx,
        buildSceneChatMessage({ kind: 'travel', text: 'one again', key: 'travel:c:1' }),
        { dedupeKey: 'travel:c:1' },
    );
    assert.equal(second.posted, false);
    assert.equal(second.deduped, true);
    assert.equal(second.reason, 'duplicate');
    assert.equal(second.index, 0);
    assert.equal(ctx.chat.length, 1);
    assert.equal(ctx.calls.rendered, 1);
    assert.equal(ctx.calls.saves, 1);
});

test('a different key posts a second frame (a real second visit)', async () => {
    const ctx = fakeCtx([]);
    await postSceneMessage(ctx, buildSceneChatMessage({ kind: 'travel', text: 'one', key: 'travel:c:1' }));
    const second = await postSceneMessage(ctx, buildSceneChatMessage({ kind: 'travel', text: 'two', key: 'travel:c:2' }));
    assert.equal(second.posted, true);
    assert.equal(second.index, 1);
    assert.equal(ctx.chat.length, 2);
});

test('a message without a key still posts (only identical keys dedupe)', async () => {
    const ctx = fakeCtx([]);
    const first = await postSceneMessage(ctx, buildSceneChatMessage({ kind: 'travel', text: 'one' }));
    const second = await postSceneMessage(ctx, buildSceneChatMessage({ kind: 'travel', text: 'one' }));
    assert.equal(first.posted, true);
    assert.equal(second.posted, true);
    assert.equal(ctx.chat.length, 2);
});

test('posting degrades gracefully without chat, renderer, or save', async () => {
    const message = buildSceneChatMessage({ kind: 'travel', text: 'x', key: 'k' });
    assert.deepEqual(await postSceneMessage(null, message), { posted: false, index: null, reason: 'no-chat' });
    assert.deepEqual(await postSceneMessage({}, message), { posted: false, index: null, reason: 'no-chat' });
    assert.deepEqual(await postSceneMessage({ chat: {} }, message), { posted: false, index: null, reason: 'no-chat' });
    assert.equal((await postSceneMessage({ chat: [] }, null)).reason, 'invalid-message');
    assert.equal((await postSceneMessage({ chat: [] }, { mes: 5 })).reason, 'invalid-message');

    const noDom = { chat: [] };
    const result = await postSceneMessage(noDom, message);
    assert.deepEqual(result, { posted: true, index: 0, reason: 'not-rendered' });
    assert.equal(noDom.chat.length, 1);

    const failingRender = { chat: [], addOneMessage() { throw new Error('nope'); } };
    const rendered = await postSceneMessage(failingRender, message);
    assert.deepEqual(rendered, { posted: true, index: 0, reason: 'render-failed' });
    assert.equal(failingRender.chat.length, 1);

    const failingSave = { chat: [], addOneMessage() {}, saveChat: async () => { throw new Error('disk'); } };
    const saved = await postSceneMessage(failingSave, message);
    assert.deepEqual(saved, { posted: true, index: 0, reason: 'save-failed' });
});

test('a synchronous saveChat is tolerated', async () => {
    let saved = 0;
    const ctx = { chat: [], addOneMessage() {}, saveChat: () => { saved += 1; } };
    const result = await postSceneMessage(ctx, buildSceneChatMessage({ kind: 'travel', text: 'x' }));
    assert.equal(result.posted, true);
    assert.equal(saved, 1);
});

test('the kickoff card names the player, role, location, goals, and situation', () => {
    const state = {
        seasonId: 's1',
        playerRole: 'hero',
        player: { identity: 'canon', characterId: 's1.vaiva.colorgarde', displayName: null },
        characters: {
            's1.vaiva.colorgarde': {
                charId: 's1.vaiva.colorgarde',
                displayName: 'Vaiva Colorgarde',
                goals: ['Find the missing courier', 'Keep the arcade open'],
            },
        },
        locations: { 'loc.arcade': { id: 'loc.arcade', name: 'Neon Arcade' } },
        scene: { locationId: 'loc.arcade', framing: 'Rain hammers the shutters.', present: [], combat: null },
        threats: [{ id: 't1', name: 'Glass Cartel', status: 'active', agenda: 'take the arcade' }],
    };
    const season = { id: 's1', title: 'Season One', premise: 'A city under glass.' };
    const lines = buildKickoffLines({
        state,
        season,
        opening: { playerName: 'Vaiva Colorgarde', playerRole: 'hero', locationName: 'Neon Arcade', title: 'Season One' },
    });
    assert.equal(lines[0], 'Season started — Season One');
    assert.equal(lines[1], 'You are Vaiva Colorgarde, hero, at Neon Arcade.');
    assert.equal(lines[2], 'Goals: Find the missing courier; Keep the arcade open');
    assert.equal(lines[3], 'Current situation: Rain hammers the shutters.');
    assert.match(lines[4], /Current action: none yet/);
    assert.match(lines[5], /Your move:/);
});

test('a custom persona without goals gets neutral fallbacks', () => {
    const state = {
        seasonId: 'sandbox',
        playerRole: 'neutral',
        player: { identity: 'custom', characterId: null, displayName: 'The Player' },
        characters: {},
        locations: { 'loc.a': { id: 'loc.a', name: 'Transit Hub' } },
        scene: { locationId: 'loc.a', present: [], combat: null, framing: '' },
        threats: [],
    };
    const lines = buildKickoffLines({ state, season: { id: 'sandbox', title: 'Sandbox', premise: '' } });
    assert.equal(lines[1], 'You are The Player, neutral, at Transit Hub.');
    assert.match(lines[2], /No goals are recorded yet/);
    assert.match(lines[3], /Current situation: The city is quiet/);

    const noState = buildKickoffLines({});
    assert.equal(noState[0], 'Season started — Neo Terra');
    assert.equal(noState[1], 'You are The Player, neutral, at an unrecorded part of the city.');
});

test('the opening frame is the opening text plus the kickoff block', () => {
    const state = {
        playerRole: 'villain',
        player: { identity: 'canon', characterId: 'c' },
        characters: { c: { displayName: 'Carol Fate', goals: ['Hold the tower'] } },
        locations: { l: { id: 'l', name: 'Clarity HQ' } },
        scene: { locationId: 'l', framing: 'The elevator hums.', present: [], combat: null },
        threats: [],
    };
    const text = buildOpeningFrameText({
        state,
        season: { id: 's1dark', title: 'Season 1 Dark' },
        opening: { text: 'Season 1 Dark — 2037–2040', playerName: 'Carol Fate', playerRole: 'villain', title: 'Season 1 Dark' },
    });
    assert.match(text, /^Season 1 Dark — 2037–2040\n\nSeason started/);
    assert.match(text, /You are Carol Fate, villain, at Clarity HQ\./);
    assert.match(text, /Goals: Hold the tower/);
    // The kickoff alone is valid when there is no opening text.
    assert.match(buildOpeningFrameText({ state, season: null, opening: null }), /^Season started/);
});

test('the opening dedupe key is chat, season, and turn specific', () => {
    assert.equal(
        buildOpeningSceneKey({ chatId: 'c1', seasonId: 's1', turn: 0 }),
        'opening:c1:s1:0',
    );
    assert.notEqual(
        buildOpeningSceneKey({ chatId: 'c1', seasonId: 's1', turn: 0 }),
        buildOpeningSceneKey({ chatId: 'c2', seasonId: 's1', turn: 0 }),
    );
    assert.equal(buildOpeningSceneKey({}), 'opening:0');
});

test('a travel frame is the location change header plus the intro paragraph', () => {
    const text = buildTravelFrameText({
        fromName: 'Central Plaza',
        toName: 'Maple Heights',
        intro: { text: 'Vaiva arrives at Maple Heights, Hilltop, on foot from Central Plaza.\n\nRain on the glass.' },
    });
    const [header, body] = text.split('\n\n');
    assert.equal(header, 'Location changed: Central Plaza → Maple Heights');
    assert.match(header, /→/);
    assert.match(body, /Vaiva arrives at Maple Heights/);
    // Prompt context blocks never survive into a chat frame.
    const dirty = buildTravelFrameText({
        fromName: 'A',
        toName: 'B',
        intro: { text: 'Arrived.\n[NEOTERRA_SCENE]\nLocation: B' },
    });
    assert.doesNotMatch(dirty, /\[NEOTERRA_/);
    // The header alone is valid when the intro text is empty.
    assert.equal(
        buildTravelFrameText({ fromName: 'A', toName: 'B', intro: { text: '' } }),
        'Location changed: A → B',
    );
    // The intro's location name is the destination, never the origin: a missing
    // origin falls back to a neutral word instead of repeating the destination.
    assert.equal(
        buildTravelFrameText({ intro: { locationName: 'Maple Heights', text: '' } }),
        'Location changed: somewhere → Maple Heights',
    );
    assert.equal(buildTravelFrameText({}), 'Location changed: somewhere → a new location');
});

test('the travel dedupe key is chat, route, and turn specific', () => {
    assert.equal(
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 3 }),
        'travel:c1:a:b:3',
    );
    assert.notEqual(
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 3 }),
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 4 }),
    );
    assert.notEqual(
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 3 }),
        buildTravelSceneKey({ chatId: 'c2', from: 'a', to: 'b', turn: 3 }),
    );
    assert.notEqual(
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 3 }),
        buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'c', turn: 3 }),
    );
    const empty = buildTravelSceneKey({});
    assert.equal(typeof empty, 'string');
    assert.ok(empty.length > 0);
    assert.equal(empty, 'travel:0');
});

test('a travel frame posts once and a repeat with the same key dedupes', async () => {
    const ctx = fakeCtx([{ name: 'Player', is_user: true, mes: 'go north' }]);
    const key = buildTravelSceneKey({ chatId: 'c1', from: 'a', to: 'b', turn: 2 });
    const frame = () => buildSceneChatMessage({
        kind: SCENE_KINDS.TRAVEL,
        text: buildTravelFrameText({ fromName: 'A', toName: 'B', intro: { text: 'Arrived.' } }),
        key,
        extra: { from: 'a', to: 'b', turn: 2, encounter: null },
        now: NOW,
    });
    const first = await postSceneMessage(ctx, frame(), { dedupeKey: key });
    assert.deepEqual(first, { posted: true, index: 1 });
    assert.equal(ctx.calls.rendered, 1);
    assert.equal(ctx.calls.saves, 1);
    assert.equal(ctx.chat[1].mes, 'Location changed: A → B\n\nArrived.');
    assert.deepEqual(readSceneExtra(ctx.chat[1]), {
        kind: 'travel',
        key,
        from: 'a',
        to: 'b',
        turn: 2,
        encounter: null,
    });

    const second = await postSceneMessage(ctx, frame(), { dedupeKey: key });
    assert.equal(second.posted, false);
    assert.equal(second.deduped, true);
    assert.equal(ctx.chat.length, 2);
    assert.equal(ctx.calls.saves, 1);
});

test('a greeting-only chat is fresh; real story turns are not', () => {
    const greeting = { name: 'Carol', is_user: false, mes: 'Hello.' };
    assert.equal(hasStoryHistory([]), false);
    assert.equal(hasStoryHistory([greeting]), false);
    assert.equal(hasStoryHistory([greeting, frame()]), false);
    assert.equal(
        hasStoryHistory([greeting, { name: 'You', is_user: true, mes: 'I look around' }]),
        true,
    );
    assert.equal(
        hasStoryHistory([greeting, { name: 'Carol', is_user: false, mes: 'She smiles.' }]),
        true,
    );
    assert.equal(hasStoryHistory(null), false);
});

function frame() {
    return buildSceneChatMessage({ kind: SCENE_KINDS.OPENING, text: 'Season started', key: 'opening:c1:s1:0' });
}

test('the interceptor injects into the prompt copy only, once, and never into ctx.chat', async () => {
    const { createGenerationInterceptor, isContextMessage } = await import('../src/context/interceptor.js');
    const state = {
        chatId: 'c1',
        seasonId: 's1',
        player: { identity: 'custom', displayName: 'Player', characterId: null },
        characters: {},
        locations: { 'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Center', factionId: null, status: 'quiet' } },
        factions: {},
        threats: [],
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [],
        scene: { locationId: 'loc.a', present: [], combat: null, framing: 'Rain on the glass.' },
        meta: { turn: 0, inGameDate: '2038-01-01', timeOfDay: 'night', sceneId: 'opening', inCombat: false },
        flags: {},
        log: [],
    };
    const settings = { context: { enabled: true, depth: 0, blocks: {} }, contentGate: 'full', contentLimits: {}, tokenBudget: {} };
    const sceneFrame = buildSceneChatMessage({ kind: SCENE_KINDS.TRAVEL, text: 'Location changed: A → B', key: 'travel:c1:1' });
    const ctx = fakeCtx([sceneFrame]);
    const before = ctx.chat.length;
    const intercept = createGenerationInterceptor({
        getContext: () => ({ chatMetadata: { neoterra: { worldState: state } } }),
        getSettings: () => settings,
    });

    // ST hands the interceptor a prompt copy, never `ctx.chat` itself.
    const promptCopy = ctx.chat.slice();
    await intercept(promptCopy, 4096, () => {}, 'normal');
    await intercept(promptCopy, 4096, () => {}, 'normal');
    assert.equal(promptCopy.filter(isContextMessage).length, 1, 'one copy after repeated runs');
    assert.match(promptCopy.find(isContextMessage).mes, /\[NEOTERRA_SCENE\]/);
    assert.equal(ctx.chat.length, before, 'ctx.chat is unchanged');
    assert.equal(ctx.chat.filter(isContextMessage).length, 0);
});

/* ------------------------------------------------------------------ *
 * Travel outcome poster (shell seam)
 * ------------------------------------------------------------------ */

function travelCtx(chatId = 'c1', initial = []) {
    const ctx = fakeCtx(initial);
    ctx.chatId = chatId;
    ctx.chatMetadata = { neoterra: { worldState: { chatId } } };
    return ctx;
}

function travelResult(overrides = {}) {
    return {
        ok: true,
        alreadyThere: false,
        from: 'central-plaza',
        to: 'maple-heights',
        fromName: 'Central Plaza',
        toName: 'Maple Heights',
        turns: 1,
        intro: { text: 'Vaiva arrives at Maple Heights on foot.', locationName: 'Maple Heights' },
        messageExtra: { from: 'central-plaza', to: 'maple-heights', turns: 1 },
        state: { meta: { turn: 2 }, scene: { encounter: null } },
        ...overrides,
    };
}

test('a successful travel posts one frame, attaches the record, announces, then requests choices', async () => {
    const ctx = travelCtx('c1', [{ name: 'Player', is_user: true, mes: 'go north' }]);
    const order = [];
    const requests = [];
    const posted = await postTravelOutcome(ctx, { chatId: 'c1' }, travelResult(), {
        onPosted: (result) => order.push(`posted:${result.index}`),
        requestChoices: async (live, index) => {
            order.push(`choices:${index}`);
            requests.push({ live, index });
        },
    });
    assert.deepEqual(posted, { posted: true, index: 1 });
    assert.equal(ctx.chat.length, 2);
    assert.equal(ctx.calls.rendered, 1);
    assert.equal(ctx.calls.saves, 1);
    assert.match(ctx.chat[1].mes, /^Location changed: Central Plaza → Maple Heights\n\n/);
    assert.equal(ctx.chat[1].extra.neoterra.travel.to, 'maple-heights');
    assert.equal(ctx.chat[1].extra.neoterra.scene.kind, 'travel');
    assert.deepEqual(order, ['posted:1', 'choices:1']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].index, 1);
});

test('a chat switch aborts the travel post without writing', async () => {
    const ctx = travelCtx('c1', [{ name: 'Player', is_user: true, mes: 'go' }]);
    const other = travelCtx('c2');
    const posted = await postTravelOutcome(ctx, { chatId: 'c1' }, travelResult(), {
        resolveContext: () => other,
    });
    assert.equal(posted, null);
    assert.equal(ctx.chat.length, 1);
    assert.equal(ctx.calls.saves, 0);
});

test('a choices failure never discards the posted frame or throws', async () => {
    const ctx = travelCtx('c1', []);
    const posted = await postTravelOutcome(ctx, { chatId: 'c1' }, travelResult(), {
        requestChoices: async () => { throw new Error('agent aborted'); },
    });
    assert.equal(posted.posted, true);
    assert.equal(ctx.chat.length, 1);
    assert.equal(ctx.calls.saves, 1);
});

test('a duplicate travel frame dedupes and still requests choices for its index', async () => {
    const ctx = travelCtx('c1', []);
    const result = travelResult();
    await postTravelOutcome(ctx, { chatId: 'c1' }, result);
    const requests = [];
    const second = await postTravelOutcome(ctx, { chatId: 'c1' }, result, {
        requestChoices: async (_live, index) => { requests.push(index); },
    });
    assert.equal(second.posted, false);
    assert.equal(second.deduped, true);
    assert.equal(ctx.chat.length, 1);
    assert.deepEqual(requests, [0]);
});
