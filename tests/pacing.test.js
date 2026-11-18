import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PACING_LEVELS,
    analyzePacing,
    buildCutFraming,
    buildCutSummary,
    createPacingFlow,
    pacingSettings,
    recordPacing,
} from '../src/flows/pacing.js';
import { createWorldStateStore } from '../src/state/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;
const CHAT_ID = 'pacing-test-chat';

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const season = readJson('data/seasons/s1.json');
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore() {
    const store = createWorldStateStore({
        metadata: {},
        chatId: CHAT_ID,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: CHAT_ID,
        player: { identity: 'custom', displayName: 'Alex' },
        now: NOW,
    });
    return store;
}

function snapshot(store) {
    return JSON.stringify(store.get());
}

/** Move the mechanical clock and scene markers without running a pipeline. */
function atTurn(store, turn, patch = {}) {
    const state = store.get();
    store.replace({
        ...state,
        meta: { ...state.meta, turn },
        flags: {
            ...state.flags,
            castDirector: { ...(state.flags?.castDirector ?? {}), turn: 0 },
            pacing: { ...(state.flags?.pacing ?? {}), sceneStartedTurn: 0 },
            ...patch,
        },
    });
}

function makeFlow(store, overrides = {}) {
    return createPacingFlow({
        store,
        season,
        scene: {
            refreshCast: async () => ({ applied: [] }),
        },
        getSettings: () => ({}),
        now: () => NOW,
        log: () => {},
        ...overrides,
    });
}

test('pacing settings default and clamp', () => {
    const defaults = pacingSettings({});
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.stallTurns, 3);
    assert.equal(defaults.sceneMaxTurns, 12);
    assert.equal(defaults.cutSlots, 2);
    const clamped = pacingSettings({
        pacing: { sceneMaxTurns: 1, cutSlots: 99, stallTurns: 0, enabled: false },
    });
    assert.equal(clamped.sceneMaxTurns, 2);
    assert.equal(clamped.cutSlots, 12);
    assert.equal(clamped.stallTurns, 1);
    assert.equal(clamped.enabled, false);
    assert.deepEqual(PACING_LEVELS, ['ok', 'nudge', 'cut', 'stalled']);
});

test('a fresh scene is ok', () => {
    const store = makeStore();
    const analysis = analyzePacing({ state: store.get(), settings: {} });
    assert.equal(analysis.level, 'ok');
    assert.equal(analysis.canCut, false);
    assert.equal(analysis.suggestion, 'none');
    assert.deepEqual(analysis.reasons, []);
});

test('three turns without an event become a nudge', () => {
    const store = makeStore();
    atTurn(store, 3);
    const analysis = analyzePacing({ state: store.get(), settings: {} });
    assert.equal(analysis.level, 'nudge');
    assert.equal(analysis.turnsSinceEvent, 3);
    assert.ok(analysis.codes.includes('no-development'));
    assert.equal(analysis.suggestion, 'none');
});

test('a long scene becomes a cut, and a doubled bound becomes stalled', () => {
    const store = makeStore();
    atTurn(store, 12);
    const analysis = analyzePacing({ state: store.get(), settings: {} });
    assert.equal(analysis.level, 'cut');
    assert.equal(analysis.suggestion, 'cut');
    assert.equal(analysis.canCut, true);

    atTurn(store, 24);
    assert.equal(analyzePacing({ state: store.get(), settings: {} }).level, 'stalled');
});

test('thresholds are settings-driven', () => {
    const store = makeStore();
    atTurn(store, 3);
    const analysis = analyzePacing({
        state: store.get(),
        settings: { pacing: { sceneMaxTurns: 3, stallTurns: 3 } },
    });
    assert.equal(analysis.level, 'cut');
});

test('a held scene downgrades to a nudge and offers release time', () => {
    const store = makeStore();
    atTurn(store, 12);
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'chip' });
    const analysis = analyzePacing({ state: store.get(), settings: {} });
    assert.equal(analysis.level, 'nudge');
    assert.equal(analysis.held, true);
    assert.equal(analysis.canCut, false);
    assert.equal(analysis.suggestion, 'release-time');
    assert.ok(analysis.codes.includes('time-held'));
});

test('snooze suppresses levels until it expires', () => {
    const store = makeStore();
    atTurn(store, 12);
    const flow = makeFlow(store);
    const snoozed = flow.snooze();
    assert.equal(snoozed.ok, true);
    assert.equal(snoozed.snoozedUntilTurn, 15);

    assert.equal(flow.analyze().level, 'ok');
    assert.equal(flow.analyze().reason, 'snoozed');

    atTurn(store, 15);
    assert.equal(flow.analyze().level, 'ok', 'the last snoozed turn is still suppressed');
    atTurn(store, 16);
    assert.notEqual(flow.analyze().level, 'ok');
});

test('combat and the ending screen block a cut with a reason and mutate nothing', async () => {
    const store = makeStore();
    atTurn(store, 12);
    const flow = makeFlow(store);

    store.replace({
        ...store.get(),
        meta: { ...store.get().meta, inCombat: true },
        scene: {
            ...store.get().scene,
            combat: { locationId: store.get().scene.locationId, participants: [] },
        },
    });
    let before = snapshot(store);
    const combat = await flow.cutScene({});
    assert.equal(combat.ok, false);
    assert.equal(combat.reason, 'combat');
    assert.equal(snapshot(store), before);

    store.replace({
        ...store.get(),
        meta: { ...store.get().meta, inCombat: false },
        scene: { ...store.get().scene, combat: null },
        ending: { status: 'epilogue', path: 'resistance', firedTurn: 12 },
        arc: 'season',
    });
    before = snapshot(store);
    const ending = await flow.cutScene({});
    assert.equal(ending.ok, false);
    assert.equal(ending.reason, 'ending');
    assert.equal(snapshot(store), before);
});

test('a held scene refuses a cut and offers release', async () => {
    const store = makeStore();
    atTurn(store, 12);
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'chip' });
    const before = snapshot(store);
    const flow = makeFlow(store);
    const refused = await flow.cutScene({});
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'time-held');
    assert.equal(refused.offerRelease, true);
    assert.equal(snapshot(store), before);

    const released = await flow.releaseTime();
    assert.equal(released.ok, true);
    assert.equal(store.get().flags.clock.hold.active, false);
});

test('a cut advances exactly cutSlots, keeps the location, and records pacing', async () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = store.get();
    const flow = makeFlow(store, {
        getSettings: () => ({ pacing: { cutSlots: 3 } }),
    });
    const result = await flow.cutScene({ reason: 'The stakeout drags.' });
    assert.equal(result.ok, true);
    assert.equal(result.slots, 3);

    const after = store.get();
    assert.equal(after.meta.turn, before.meta.turn + 3);
    assert.equal(after.meta.storyTurn, before.meta.storyTurn + 3);
    assert.equal(after.scene.locationId, before.scene.locationId);
    assert.match(after.scene.framing, /Time moves on/);
    assert.match(after.scene.framing, /The stakeout drags/);
    assert.ok(after.recentEvents.some(
        (event) => event.tags.includes('pacing') && event.tags.includes('cut'),
    ));
    assert.equal(after.flags.pacing.lastCutTurn, after.meta.turn);
    assert.equal(after.flags.pacing.level, 'ok');
});

test('a cut commits even when the optional storyline beat pass fails', async () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = store.get();
    const flow = makeFlow(store, {
        initiative: {
            runStoryline: async () => {
                throw new Error('storyline down');
            },
        },
    });
    const result = await flow.cutScene({ forceBeat: true });
    assert.equal(result.ok, true);
    assert.equal(store.get().meta.turn, before.meta.turn + 2);
    assert.match(store.get().scene.framing, /Time moves on/);
});

test('analysis records flags.pacing without touching story state', () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = store.get();
    const analysis = analyzePacing({ state: before, settings: {} });
    const recorded = recordPacing(store, analysis);
    assert.equal(recorded.ok, true);
    const after = store.get();
    assert.equal(after.meta.turn, before.meta.turn);
    assert.equal(after.meta.storyTurn, before.meta.storyTurn);
    assert.equal(after.scene.locationId, before.scene.locationId);
    assert.equal(after.flags.pacing.level, 'cut');
    assert.equal(after.flags.pacing.lastAnalyzedTurn, 12);
    assert.equal(after.flags.pacing.suggestedSlots, 2);
    assert.equal(after.flags.pacing.held, false);
});

test('cut framing and summary are deterministic and invent no plot', () => {
    const framing = buildCutFraming({ locationName: 'Neon Docks', slots: 2, reason: 'Rain.' });
    assert.match(framing, /2 slots later/);
    assert.match(framing, /Neon Docks/);
    assert.match(framing, /Rain\./);
    assert.equal(
        buildCutSummary({ locationName: 'Neon Docks', slots: 2 }),
        'Meanwhile, 2 slots pass at Neon Docks.',
    );
    assert.equal(buildCutFraming({ slots: 1 }), 'Time moves on — 1 slot later. The scene resumes at the same place.');
});

test('analyzePacing accepts an injected turn and date', () => {
    const store = makeStore();
    const state = store.get();
    const analysis = analyzePacing({
        state: {
            ...state,
            meta: { ...state.meta, turn: 0 },
            flags: { ...state.flags, pacing: { sceneStartedTurn: 0 } },
        },
        settings: {},
        turn: 12,
        date: '2037-04-01',
    });
    assert.equal(analysis.lastAnalyzedTurn, 12);
    assert.equal(analysis.analyzedDate, '2037-04-01');
    assert.equal(analysis.level, 'cut');
});

test('a cut never moves the player and stores exactly the documented pacing keys', async () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = store.get();
    const playerLocation = before.player.locationId ?? before.characters[before.player.characterId]?.locationId;
    const result = await makeFlow(store).cutScene({});
    assert.equal(result.ok, true);
    const after = store.get();
    assert.equal(after.scene.locationId, before.scene.locationId);
    assert.equal(
        after.player.locationId ?? after.characters[after.player.characterId]?.locationId,
        playerLocation,
    );
    const keys = [
        'level', 'reasons', 'lastAnalyzedTurn', 'lastCutTurn', 'snoozedUntilTurn',
        'suggestedSlots', 'held',
    ];
    for (const key of keys) {
        assert.ok(Object.hasOwn(after.flags.pacing, key), `missing flags.pacing.${key}`);
    }
    assert.equal(after.flags.pacing.lastCutTurn, after.meta.turn);
});

test('release time then cut advances exactly cutSlots', async () => {
    const store = makeStore();
    atTurn(store, 12);
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'chip' });
    const flow = makeFlow(store, { getSettings: () => ({ pacing: { cutSlots: 2 } }) });
    assert.equal((await flow.releaseTime()).ok, true);
    assert.equal(store.get().flags.pacing.held, false);
    const before = store.get();
    const cut = await flow.cutScene({});
    assert.equal(cut.ok, true);
    assert.equal(store.get().meta.turn, before.meta.turn + 2);
});

test('a rejected analysis write leaves the state byte-identical', () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = snapshot(store);
    const analysis = analyzePacing({ state: store.get(), settings: {} });
    const originalReplace = store.replace;
    store.replace = () => {
        throw new Error('write refused');
    };
    const recorded = recordPacing(store, analysis);
    store.replace = originalReplace;
    assert.equal(recorded.ok, false);
    assert.match(recorded.error, /write refused/);
    assert.equal(snapshot(store), before);
});

test('a cut is refused while the pacing feature is off', async () => {
    const store = makeStore();
    atTurn(store, 12);
    const before = snapshot(store);
    const flow = makeFlow(store, { getSettings: () => ({ pacing: { enabled: false } }) });
    const result = await flow.cutScene({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(snapshot(store), before);
});
