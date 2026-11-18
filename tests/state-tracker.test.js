import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    STATE_TRACKER_SCHEMA,
    applyManualPlayerEdit,
    applyStateTrackerResult,
    buildStateTrackerPrompt,
    createStateTracker,
    createTurnGate,
    getManualEditPaths,
    messageTurnIdentity,
    normalizeStateTrackerResult,
    runTurnPipeline,
} from '../src/agents/state-tracker.js';
import { AgentAbortedError, validateJsonSchema } from '../src/agents/client.js';
import { buildPlayerSheet, renderPlayerPanelMarkup } from '../src/ui/player-panel.js';
import { createWorldStateStore } from '../src/state/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const seasons = {
    s1: readJson('data/seasons/s1.json'),
    s1dark: readJson('data/seasons/s1dark.json'),
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore(seasonId = 's1', player = { identity: 'custom' }) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'state-tracker-test-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season: seasons[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'state-tracker-test-chat',
        player,
        now: NOW,
    });
    return store;
}

const emptyResult = { changes: [], relationships: [], rationale: '' };

function trackerResult(overrides = {}) {
    return { ...emptyResult, ...overrides };
}

test('the player tracker schema accepts the empty contract', () => {
    const validation = validateJsonSchema(emptyResult, STATE_TRACKER_SCHEMA);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test('a custom persona tracks stamina, willpower, status, skills, outfit, injuries, and corruption', () => {
    const store = makeStore('s1', { identity: 'custom', displayName: 'Alex' });
    const state = store.get();
    const result = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [
                { path: 'stamina.current', value: 42, reason: 'Took a hit' },
                { path: 'willpower.current', value: 55, reason: 'Held firm' },
                { path: 'status', value: 'active', reason: 'Still standing' },
                { path: 'skills', value: ['brawling', 'stealth'], reason: 'Used both' },
                { path: 'outfit', value: 'Torn jacket', reason: 'Fight damage' },
                { path: 'injuries', value: ['bruised ribs'], reason: 'Took a hit' },
                { path: 'corruption.stage', value: 1, reason: 'Exposure' },
                { path: 'corruption.progress', value: 20, reason: 'Exposure' },
            ],
        }),
        state,
    });
    assert.equal(result.rejected.length, 0);
    assert.equal(result.events.length, 8);

    const applied = applyStateTrackerResult(store, result);
    assert.equal(applied.ok, true);
    const player = store.get().player;
    assert.equal(player.stamina.current, 42);
    assert.equal(player.willpower.current, 55);
    assert.deepEqual(player.skills, ['brawling', 'stealth']);
    assert.equal(player.outfit, 'Torn jacket');
    assert.deepEqual(player.injuries, ['bruised ribs']);
    assert.equal(player.corruption.stage, 1);
    assert.equal(player.corruption.progress, 20);

    // No NPC was touched.
    const npc = store.get().characters['s1.vaiva.colorgarde'];
    assert.equal(npc.stamina.current, 100);
    assert.deepEqual(npc.skills, []);
});

test('a played canon character mirrors into both the player view and the character state', () => {
    const store = makeStore('s1dark', {
        identity: 'canon',
        characterId: 's1dark.carol.bleeding-heart',
    });
    const state = store.get();
    const result = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [
                { path: 'stamina.current', value: 30, reason: 'Wounded' },
                { path: 'skills', value: ['command'], reason: 'Used authority' },
            ],
        }),
        state,
    });
    const applied = applyStateTrackerResult(store, result);
    assert.equal(applied.ok, true);
    const next = store.get();
    assert.equal(next.player.characterId, 's1dark.carol.bleeding-heart');
    assert.equal(next.player.stamina.current, 30);
    assert.equal(next.characters['s1dark.carol.bleeding-heart'].stamina.current, 30);
    assert.deepEqual(next.characters['s1dark.carol.bleeding-heart'].skills, ['command']);
});

test('manual edits win for exactly one tracker pass and are then cleared', () => {
    const store = makeStore('s1');
    applyManualPlayerEdit(store, {
        path: 'stamina.current',
        value: 77,
        reason: 'Player correction',
        now: NOW,
    });
    assert.equal(store.get().player.stamina.current, 77);
    assert.deepEqual(getManualEditPaths(store.get()), ['stamina.current']);

    const trackerChange = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [{ path: 'stamina.current', value: 10, reason: 'Prose says exhausted' }],
        }),
        state: store.get(),
    });
    assert.equal(trackerChange.events.length, 0);
    assert.deepEqual(trackerChange.suppressed, [{
        path: 'stamina.current',
        reason: 'manual-edit',
    }]);

    const applied = applyStateTrackerResult(store, trackerChange);
    assert.equal(applied.ok, true);
    assert.equal(applied.cleared, 1);
    assert.equal(store.get().player.stamina.current, 77);
    assert.deepEqual(getManualEditPaths(store.get()), []);

    // The next pass may now update the field.
    const nextPass = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [{ path: 'stamina.current', value: 10, reason: 'Prose says exhausted' }],
        }),
        state: store.get(),
    });
    assert.equal(nextPass.events.length, 1);
    applyStateTrackerResult(store, nextPass);
    assert.equal(store.get().player.stamina.current, 10);
});

test('stamina and willpower clamp at 0 and max; corruption progress clamps at 100', () => {
    const store = makeStore('s1');
    const state = store.get();
    const high = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [
                { path: 'stamina.current', value: 999, reason: 'Overflow' },
                { path: 'willpower.current', value: -20, reason: 'Underflow' },
                { path: 'corruption.progress', value: 300, reason: 'Overflow' },
            ],
        }),
        state,
    });
    applyStateTrackerResult(store, high);
    assert.equal(store.get().player.stamina.current, store.get().player.stamina.max);
    assert.equal(store.get().player.willpower.current, 0);
    assert.equal(store.get().player.corruption.progress, 100);
});

test('malformed responses and unknown paths are discarded without a state change', () => {
    const store = makeStore('s1');
    const before = JSON.stringify(store.get());
    const malformed = normalizeStateTrackerResult({
        result: { changes: 'not-an-array', relationships: null },
        state: store.get(),
    });
    assert.equal(malformed.events.length, 0);
    const applied = applyStateTrackerResult(store, malformed);
    assert.equal(applied.ok, true);
    assert.equal(JSON.stringify(store.get()), before);

    const bad = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [
                { path: 'characters.s1.vaiva.colorgarde.status', value: 'dead', reason: 'Sneaky NPC edit' },
                { path: 'status', value: 'ascended', reason: 'Unknown status' },
            ],
        }),
        state: store.get(),
    });
    assert.equal(bad.events.length, 0);
    assert.ok(bad.rejected.some((entry) => entry.reason === 'unknown-path'));
    assert.ok(bad.rejected.some((entry) => entry.reason === 'unknown-status'));
    assert.equal(store.get().characters['s1.vaiva.colorgarde'].status, 'active');
});

test('relationship deltas work for a custom persona and for a played canon character', () => {
    const customStore = makeStore('s1');
    const customResult = normalizeStateTrackerResult({
        result: trackerResult({
            relationships: [{
                withCharacterId: 's1.vaiva.colorgarde',
                type: 'ally',
                affinityDelta: 10,
                tensionDelta: -5,
                notes: 'Saved each other',
            }],
        }),
        state: customStore.get(),
    });
    assert.equal(customResult.events[0].type, 'PLAYER_RELATIONSHIP_DELTA');
    applyStateTrackerResult(customStore, customResult);
    assert.equal(customStore.get().player.relationships[0].withCharacterId, 's1.vaiva.colorgarde');

    const canonStore = makeStore('s1', { identity: 'canon', characterId: 's1.vaiva.colorgarde' });
    const canonResult = normalizeStateTrackerResult({
        result: trackerResult({
            relationships: [{
                withCharacterId: 's1.crystal.cat',
                type: 'rival',
                affinityDelta: -10,
                tensionDelta: 20,
            }],
        }),
        state: canonStore.get(),
    });
    assert.equal(canonResult.events[0].type, 'RELATIONSHIP_DELTA');
    applyStateTrackerResult(canonStore, canonResult);
    assert.ok(canonStore.get().relationships.some(
        (relationship) => (relationship.a === 's1.vaiva.colorgarde'
            && relationship.b === 's1.crystal.cat')
            || (relationship.b === 's1.vaiva.colorgarde'
                && relationship.a === 's1.crystal.cat'),
    ));
});

test('switching identity moves the tracker target atomically', () => {
    const store = makeStore('s1', { identity: 'custom', displayName: 'Alex' });
    store.dispatch({
        type: 'SET_PLAYER_IDENTITY',
        identity: 'canon',
        characterId: 's1.vaiva.colorgarde',
    });
    const state = store.get();
    assert.equal(state.player.characterId, 's1.vaiva.colorgarde');
    assert.equal(state.characters['s1.vaiva.colorgarde'].controlledBy, 'player');

    const result = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [{ path: 'stamina.current', value: 44, reason: 'Wounded' }],
        }),
        state,
    });
    applyStateTrackerResult(store, result);
    assert.equal(store.get().characters['s1.vaiva.colorgarde'].stamina.current, 44);
    assert.equal(store.get().player.stamina.current, 44);
});

test('the tracker never calls a disabled agent and aborts cleanly', async () => {
    const store = makeStore('s1');
    let calls = 0;
    const disabled = createStateTracker({
        runner: { runAgent: async () => { calls += 1; return emptyResult; } },
        getSettings: () => ({ agents: { stateTracker: { enabled: false } } }),
    });
    const skipped = await disabled.run({ state: store.get(), message: 'You take a hit.' });
    assert.equal(calls, 0);
    assert.equal(skipped.source, 'deterministic');
    assert.equal(skipped.events.length, 0);

    const aborted = createStateTracker({
        runner: { runAgent: async () => { throw new AgentAbortedError('chat changed'); } },
        getSettings: () => ({}),
    });
    await assert.rejects(
        () => aborted.run({ state: store.get(), message: 'You take a hit.' }),
        (error) => error instanceof AgentAbortedError,
    );
});

test('a failed agent pass returns no events and leaves state byte-identical', async () => {
    const store = makeStore('s1');
    const before = JSON.stringify(store.get());
    const tracker = createStateTracker({
        runner: { runAgent: async () => { throw new Error('timeout'); } },
        getSettings: () => ({}),
        log: () => {},
    });
    const result = await tracker.run({ state: store.get(), message: 'You take a hit.' });
    assert.equal(result.source, 'deterministic');
    assert.equal(result.events.length, 0);
    assert.equal(JSON.stringify(store.get()), before);
});

test('the prompt names the played canon character and the protected manual paths', () => {
    const store = makeStore('s1dark', {
        identity: 'canon',
        characterId: 's1dark.carol.bleeding-heart',
    });
    applyManualPlayerEdit(store, { path: 'stamina.current', value: 80, now: NOW });
    const prompt = buildStateTrackerPrompt({
        state: store.get(),
        message: 'Bleeding Heart surveys her city.',
    });
    assert.match(prompt, /Carol|Bleeding Heart/);
    assert.match(prompt, /stamina\.current/);
    assert.match(prompt, /Never change NPCs/);
});

test('the villain-POV sheet uses villain-side labels and the same modular fields', () => {
    const store = makeStore('s1dark', {
        identity: 'canon',
        characterId: 's1dark.carol.bleeding-heart',
    });
    const sheet = buildPlayerSheet({
        state: store.get(),
        season: seasons.s1dark,
        registry,
    });
    assert.equal(sheet.villainPov, true);
    assert.equal(sheet.roleLabel, 'Villain');
    assert.match(sheet.playingAs, /Playing as/);
    assert.equal(sheet.labels.stamina, 'Dominion');
    assert.equal(sheet.labels.corruption, 'Ascension');
    assert.ok(sheet.statusChips.some((chip) => chip.label === 'Villain POV'));
    assert.ok(sheet.form.label);

    const markup = renderPlayerPanelMarkup(sheet);
    assert.match(markup, /data-neoterra-player-sheet/);
    assert.match(markup, /Playing as/);
    assert.match(markup, /Dominion/);
    assert.match(markup, /data-neoterra-player-input="stamina.current"/);
    assert.match(markup, /Save manual edit/);

    const readonly = renderPlayerPanelMarkup(sheet, { editable: false });
    assert.doesNotMatch(readonly, /Save manual edit/);
});

test('the sheet reflects state without a reload', () => {
    const store = makeStore('s1');
    const before = buildPlayerSheet({ state: store.get(), season: seasons.s1, registry });
    const result = normalizeStateTrackerResult({
        result: trackerResult({
            changes: [{ path: 'stamina.current', value: 12, reason: 'Exhausted' }],
        }),
        state: store.get(),
    });
    applyStateTrackerResult(store, result);
    const after = buildPlayerSheet({ state: store.get(), season: seasons.s1, registry });
    assert.notEqual(before.resources[0].current, after.resources[0].current);
    assert.equal(after.resources[0].current, 12);
    assert.match(renderPlayerPanelMarkup(after), /12\/100/);
});

test('the turn pipeline ticks, tracks, advances the storyline, then refreshes the cast', async () => {
    const store = makeStore('s1');
    const startTurn = store.get().meta.turn;
    const order = [];
    const dispatch = store.dispatch.bind(store);
    store.dispatch = (event) => {
        if (event?.type === 'TICK_TIME') {
            order.push('tick');
        }
        return dispatch(event);
    };
    const tracker = {
        run: async ({ state }) => {
            order.push('tracker');
            assert.equal(state.meta.turn, startTurn + 1);
            return normalizeStateTrackerResult({
                result: trackerResult({
                    changes: [{ path: 'stamina.current', value: 64, reason: 'Took a hit' }],
                }),
                state,
            });
        },
    };
    const initiative = {
        afterTurn: async ({ recentProse }) => {
            order.push('initiative');
            assert.equal(recentProse, 'A blow lands.');
            return { ran: true };
        },
    };
    const scene = {
        refreshCast: async ({ runDirector }) => {
            order.push('cast');
            assert.equal(runDirector, false);
            return { applied: [] };
        },
    };

    const result = await runTurnPipeline({
        store,
        tracker,
        initiative,
        scene,
        getSettings: () => ({}),
        message: 'A blow lands.',
    });

    assert.deepEqual(order, ['tick', 'tracker', 'initiative', 'cast']);
    assert.equal(result.ok, true);
    assert.equal(result.ticked, true);
    assert.equal(result.turn, startTurn + 1);
    assert.equal(store.get().meta.turn, startTurn + 1);
    assert.equal(store.get().player.stamina.current, 64);
    assert.equal(result.tracker.ran, true);
    assert.equal(result.tracker.applied, true);
    assert.equal(result.storyline.ran, true);
    assert.deepEqual(result.errors, []);
});

test('the turn gate accepts each chat/message identity exactly once', () => {
    const gate = createTurnGate();
    assert.equal(gate.accept({ chatId: 'c', messageIndex: 4 }), true);
    assert.equal(gate.accept({ chatId: 'c', messageIndex: 4 }), false);
    assert.equal(gate.accept({ chatId: 'c', messageIndex: 5 }), true);
    assert.equal(gate.accept({ chatId: 'other', messageIndex: 5 }), true);
    assert.equal(gate.last, 'other:5:');
    gate.reset();
    assert.equal(gate.accept({ chatId: 'c', messageIndex: 5 }), true);
    assert.equal(gate.last, 'c:5:');
});

test('message identity survives a swipe but a new message at the same index is a new turn', () => {
    const original = {
        send_date: '2038-01-02',
        swipe_id: 0,
        swipe_info: [{ send_date: '2038-01-02' }, { send_date: '2038-01-03' }],
        mes: 'The first take.',
    };
    const swipe = { ...original, swipe_id: 1, send_date: '2038-01-03', mes: 'The second take.' };
    assert.equal(messageTurnIdentity(original), messageTurnIdentity(swipe));

    const regenerated = {
        send_date: '2038-01-04',
        swipe_id: 0,
        swipe_info: [{ send_date: '2038-01-04' }],
        mes: 'A fresh reply.',
    };
    assert.notEqual(messageTurnIdentity(original), messageTurnIdentity(regenerated));

    const gate = createTurnGate();
    const chatId = 'c';
    assert.equal(gate.accept({ chatId, messageIndex: 4, identity: messageTurnIdentity(original) }), true);
    assert.equal(gate.accept({ chatId, messageIndex: 4, identity: messageTurnIdentity(swipe) }), false);
    assert.equal(gate.accept({ chatId, messageIndex: 4, identity: messageTurnIdentity(regenerated) }), true);

    // Missing timestamps still produce a stable identity.
    assert.equal(messageTurnIdentity({ mes: 'hi' }), 'len:2');
    assert.equal(messageTurnIdentity(null), '');
});

test('a storyline MOVE_CHARACTER is visible in the cast and encounter after the turn', async () => {
    const { createSceneFlow } = await import('../src/flows/scene.js');
    const store = makeStore('s1');
    const before = store.get();
    const villainId = Object.values(before.characters)
        .find((entry) => entry.side === 'villain' && entry.controlledBy === 'npc')?.charId;
    assert.ok(villainId, 'S1 seeds at least one villain');
    const playerLocation = before.scene.locationId;

    const scene = createSceneFlow({
        store,
        season: seasons.s1,
        registry,
        formGroups,
        formRules,
        getSettings: () => ({}),
    });
    const initiative = {
        afterTurn: async () => {
            store.dispatch({ type: 'MOVE_CHARACTER', characterId: villainId, locationId: playerLocation });
            return { ran: true, reason: 'every-6-turns' };
        },
    };

    const result = await runTurnPipeline({
        store,
        tracker: null,
        initiative,
        scene,
        getSettings: () => ({ agents: { stateTracker: { enabled: false } } }),
    });
    assert.equal(result.ok, true);
    assert.equal(store.get().characters[villainId].locationId, playerLocation);
    assert.ok(result.cast?.cast?.present?.includes(villainId), 'the moved NPC is present');
    assert.ok(result.cast?.cast?.encounter?.characterIds?.includes(villainId));

    // A manual removal still wins over the deterministic cast.
    store.replace({
        ...store.get(),
        flags: {
            ...(store.get().flags ?? {}),
            castDirector: {
                ...(store.get().flags?.castDirector ?? {}),
                manualRemovals: [villainId],
            },
        },
    });
    const pinned = await scene.refreshCast({ runDirector: false });
    assert.equal(pinned.cast.present.includes(villainId), false);
    assert.equal(pinned.cast.encounter?.characterIds?.includes(villainId) ?? false, false);
});

test('a throwing settings getter does not abort the turn pipeline', async () => {
    const store = makeStore('s1');
    const startTurn = store.get().meta.turn;
    const result = await runTurnPipeline({
        store,
        tracker: { run: async () => { throw new Error('should not run'); } },
        getSettings: () => { throw new Error('settings down'); },
        log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(store.get().meta.turn, startTurn + 1);
    assert.equal(result.tracker.ran, false);
});

test('a disabled player tracker never runs and the rest of the turn still advances', async () => {
    const store = makeStore('s1');
    const startTurn = store.get().meta.turn;
    let calls = 0;
    let initiativeCalls = 0;
    let castCalls = 0;
    const tracker = {
        run: async () => {
            calls += 1;
            return normalizeStateTrackerResult({ result: null, state: store.get() });
        },
    };

    const result = await runTurnPipeline({
        store,
        tracker,
        initiative: {
            afterTurn: async () => {
                initiativeCalls += 1;
                return { ran: true };
            },
        },
        scene: {
            refreshCast: async () => {
                castCalls += 1;
                return null;
            },
        },
        getSettings: () => ({ agents: { stateTracker: { enabled: false } } }),
    });

    assert.equal(calls, 0);
    assert.equal(result.ticked, true);
    assert.equal(result.tracker.ran, false);
    assert.equal(result.tracker.reason, 'disabled');
    assert.equal(store.get().meta.turn, startTurn + 1);
    assert.equal(initiativeCalls, 1);
    assert.equal(castCalls, 1);
});

test('a throwing player tracker leaves the state unchanged and does not skip later stages', async () => {
    const store = makeStore('s1');
    const startTurn = store.get().meta.turn;
    const stamina = store.get().player.stamina.current;
    let initiativeCalls = 0;
    let castCalls = 0;

    const result = await runTurnPipeline({
        store,
        tracker: {
            run: async () => {
                throw new Error('agent down');
            },
        },
        initiative: {
            afterTurn: async () => {
                initiativeCalls += 1;
                return { ran: true };
            },
        },
        scene: {
            refreshCast: async () => {
                castCalls += 1;
                return null;
            },
        },
        getSettings: () => ({}),
        log: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.tracker.ran, false);
    assert.equal(result.tracker.reason, 'failed');
    assert.equal(store.get().player.stamina.current, stamina);
    assert.equal(store.get().meta.turn, startTurn + 1);
    assert.equal(initiativeCalls, 1);
    assert.equal(castCalls, 1);
    assert.ok(result.errors.some((entry) => entry.stage === 'tracker'));
});

test('a failed clock tick is recorded and the player tracker still runs', async () => {
    const store = makeStore('s1');
    const dispatch = store.dispatch.bind(store);
    store.dispatch = (event) => {
        if (event?.type === 'TICK_TIME') {
            throw new Error('clock jammed');
        }
        return dispatch(event);
    };
    let calls = 0;

    const result = await runTurnPipeline({
        store,
        tracker: {
            run: async ({ state }) => {
                calls += 1;
                return normalizeStateTrackerResult({
                    result: trackerResult({
                        changes: [{ path: 'willpower.current', value: 41, reason: 'Pressured' }],
                    }),
                    state,
                });
            },
        },
        getSettings: () => ({}),
        log: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.ticked, false);
    assert.equal(calls, 1);
    assert.equal(store.get().player.willpower.current, 41);
    assert.ok(result.errors.some((entry) => entry.stage === 'tick'));
});

test('an unheld turn advances the slot and date once', async () => {
    const store = makeStore('s1');
    const before = store.get();
    const result = await runTurnPipeline({
        store,
        getSettings: () => ({ clock: { enabled: true } }),
        log: () => {},
    });
    const after = store.get();
    assert.equal(result.ok, true);
    assert.equal(result.ticked, true);
    assert.equal(after.meta.turn, before.meta.turn + 1);
    assert.equal(after.meta.storyTurn, before.meta.storyTurn + 1);
    assert.equal(after.meta.timeOfDay, 'night');
    assert.equal(after.meta.inGameDate, before.meta.inGameDate);
    assert.deepEqual(result.clock, {
        held: false,
        storyTurn: after.meta.storyTurn,
        timeOfDay: 'night',
        date: before.meta.inGameDate,
    });
});

test('a held turn ticks the mechanical turn but not fiction time', async () => {
    const store = makeStore('s1');
    const before = store.get();
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' });
    const result = await runTurnPipeline({
        store,
        getSettings: () => ({ clock: { enabled: true } }),
        log: () => {},
    });
    const after = store.get();
    assert.equal(after.meta.turn, before.meta.turn + 1);
    assert.equal(after.meta.storyTurn, 0);
    assert.equal(after.meta.inGameDate, before.meta.inGameDate);
    assert.equal(after.meta.timeOfDay, before.meta.timeOfDay);
    assert.equal(result.clock.held, true);
});

test('a disabled clock leaves the date and slot byte-identical', async () => {
    const store = makeStore('s1');
    const before = store.get();
    await runTurnPipeline({
        store,
        getSettings: () => ({ clock: { enabled: false } }),
        log: () => {},
    });
    const after = store.get();
    assert.equal(after.meta.turn, before.meta.turn + 1);
    assert.equal(after.meta.inGameDate, before.meta.inGameDate);
    assert.equal(after.meta.timeOfDay, before.meta.timeOfDay);
});

test('the encounter auto-hold is set and released per settings', async () => {
    const store = makeStore('s1');
    const before = store.get();
    const settings = { clock: { enabled: true, autoHold: { encounter: true } } };
    const withEncounter = {
        encounter: { characterIds: ['s1.vaiva.colorgarde'], locationId: before.scene.locationId },
        refreshCast: async () => ({ applied: [] }),
    };
    const entered = await runTurnPipeline({
        store,
        scene: withEncounter,
        getSettings: () => settings,
        log: () => {},
    });
    assert.equal(entered.clock.held, true);
    assert.equal(store.get().flags.clock.hold.reason, 'encounter');
    assert.equal(store.get().meta.storyTurn, 0);

    const cleared = await runTurnPipeline({
        store,
        scene: { refreshCast: async () => ({ applied: [] }) },
        getSettings: () => settings,
        log: () => {},
    });
    assert.equal(cleared.clock.held, false);
    assert.equal(store.get().flags.clock.hold.reason, 'encounter-cleared');
    assert.equal(store.get().meta.storyTurn, 1);
});

test('the cast refresh still runs while time is held', async () => {
    const store = makeStore('s1');
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' });
    let refreshed = 0;
    const result = await runTurnPipeline({
        store,
        scene: {
            refreshCast: async () => {
                refreshed += 1;
                return { applied: [] };
            },
        },
        getSettings: () => ({}),
        log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(refreshed, 1);
    assert.ok(result.cast);
});
