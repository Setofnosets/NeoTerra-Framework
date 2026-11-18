import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorldStateStore } from '../src/state/store.js';
import { createWorldTick, planWorldTick } from '../src/flows/world-tick.js';
import { addDays } from '../src/core/world-clock.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;
const CHAT_ID = 'world-tick-test-chat';

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const agendas = readJson('data/agendas.json');
const seasons = {
    s1: readJson('data/seasons/s1.json'),
    s1dark: readJson('data/seasons/s1dark.json'),
    s2: readJson('data/seasons/s2.json'),
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore(seasonId = 's1', player = { identity: 'custom' }) {
    const store = createWorldStateStore({
        metadata: {},
        chatId: CHAT_ID,
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
        chatId: CHAT_ID,
        player,
        now: NOW,
    });
    return store;
}

function makeTick(store, {
    season = seasons.s1,
    settings = {},
    agenda = agendas,
    locationData = locations,
} = {}) {
    return createWorldTick({
        store,
        getSeason: () => season,
        getSettings: () => settings,
        loadData: async () => ({ agendas: agenda, locations: locationData }),
        log: () => {},
    });
}

/** Skip whole in-game days without touching the hold machinery. */
function skipDays(store, days) {
    const state = store.get();
    store.replace({
        ...state,
        meta: {
            ...state.meta,
            inGameDate: addDays(state.meta.inGameDate, days),
            storyTurn: state.meta.storyTurn + days * 5,
            turn: state.meta.turn + days * 5,
        },
    });
}

function snapshot(store) {
    return JSON.stringify(store.get());
}

function eventsOf(result, type) {
    return result.events.filter((event) => event.type === type);
}

test('the first run initializes flags.worldTick and emits zero events', async () => {
    const store = makeStore('s1');
    const before = store.get();
    const result = await makeTick(store).run();

    assert.equal(result.ran, true);
    assert.equal(result.initialized, true);
    assert.deepEqual(result.events, []);
    const after = store.get();
    assert.equal(after.meta.turn, before.meta.turn);
    assert.deepEqual(after.flags.worldTick, {
        lastDate: before.meta.inGameDate,
        lastTurn: before.meta.turn,
        lastStoryTurn: 0,
        totalDays: 0,
        suppressedDays: 0,
        pendingRumorIds: [],
        carryFactions: {},
        carryThreats: {},
    });
});

test('no tick without an elapsed day: zero events and a byte-identical state', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    const before = snapshot(store);

    const second = await tick.run();
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'no-elapsed-day');
    assert.deepEqual(second.events, []);
    assert.equal(snapshot(store), before);
});

test('one day advances influence and threat by the authored rate within caps', async () => {
    const store = makeStore('s1dark');
    const tick = makeTick(store, { season: seasons.s1dark });
    await tick.run();
    skipDays(store, 1);

    const result = await tick.run();
    assert.equal(result.ran, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.summary.elapsedDays, 1);
    assert.equal(result.summary.appliedDays, 1);
    assert.ok(result.events.length > 0);

    const after = store.get();
    assert.equal(after.factions.clarity.influence, 86); // 85 + 1.0/day
    const threat = after.threats.find((entry) => entry.id === 's1dark.threat.resistance');
    assert.equal(threat.progress, 32); // 30 + 1.5/day, rounded by the reducer

    const influenceEvent = eventsOf(result, 'SET_FACTION_INFLUENCE')
        .find((event) => event.factionId === 'clarity');
    assert.ok(influenceEvent);
    assert.ok(Math.abs(influenceEvent.influence - 85) <= agendas.defaults.maxFactionDeltaPerTick);
});

test('two identical runs over the same state produce byte-identical events', async () => {
    const storeA = makeStore('s1');
    const storeB = makeStore('s1');
    const tickA = makeTick(storeA);
    const tickB = makeTick(storeB);
    await tickA.run();
    await tickB.run();
    skipDays(storeA, 3);
    skipDays(storeB, 3);

    const first = await tickA.run();
    const second = await tickB.run();
    assert.deepEqual(first.events, second.events);
    assert.equal(JSON.stringify(storeA.get()), JSON.stringify(storeB.get()));
});

test('a 10-turn hold produces no tick; one released day produces exactly one tick', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();

    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' });
    for (let index = 0; index < 10; index += 1) {
        store.dispatch({ type: 'TICK_TIME', turns: 1, storyTurns: 0 });
    }
    const held = await tick.run();
    assert.equal(held.ran, false);
    assert.equal(held.reason, 'time-held');
    assert.deepEqual(held.events, []);
    assert.equal(store.get().factions.clarity.influence, 80);
    assert.equal(store.get().threats.find((threat) => threat.id === 's1.threat.clarity').progress, 25);

    store.dispatch({ type: 'SET_CLOCK_HOLD', active: false, reason: 'manual-release' });
    skipDays(store, 1);
    const released = await tick.run();
    assert.equal(released.ran, true);
    assert.equal(released.reason, 'ok');
    assert.ok(released.events.length > 0);
    assert.equal(store.get().flags.worldTick.totalDays, 1);
});

test('a 60-day gap clamps to maxDaysPerTick and keeps the remainder', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    skipDays(store, 60);

    const result = await tick.run();
    assert.equal(result.ran, true);
    assert.equal(result.summary.elapsedDays, 60);
    assert.equal(result.summary.appliedDays, agendas.defaults.maxDaysPerTick);
    assert.equal(result.summary.suppressedDays, 60 - agendas.defaults.maxDaysPerTick);
    const worldTick = store.get().flags.worldTick;
    assert.equal(worldTick.totalDays, 14);
    assert.equal(worldTick.suppressedDays, 46);

    skipDays(store, 1);
    await tick.run();
    const next = store.get().flags.worldTick;
    assert.equal(next.totalDays, 15);
    assert.equal(next.suppressedDays, 46);
});

test('influence and threat progress stay within 0-100 and the per-tick cap', async () => {
    const custom = structuredClone(agendas);
    custom.seasons.s1.factionAgendas.clarity = { influencePerDay: 50 };
    custom.seasons.s1.factionAgendas.petrabyte = { influencePerDay: -50 };
    custom.seasons.s1.threatPace['s1.threat.clarity'] = { progressPerDay: 50 };

    const store = makeStore('s1');
    const tick = makeTick(store, { agenda: custom });
    await tick.run();

    const prepared = store.get();
    prepared.factions.clarity.influence = 99;
    prepared.factions.petrabyte.influence = 1;
    const threat = prepared.threats.find((entry) => entry.id === 's1.threat.clarity');
    threat.progress = 98;
    store.replace(prepared);
    skipDays(store, 1);

    const beforeInfluence = Object.fromEntries(
        Object.entries(store.get().factions).map(([id, faction]) => [id, faction.influence]),
    );
    const result = await tick.run();
    assert.equal(result.ran, true);
    const after = store.get();
    assert.equal(after.factions.clarity.influence, 100);
    assert.equal(after.factions.petrabyte.influence, 0);
    assert.equal(after.threats.find((entry) => entry.id === 's1.threat.clarity').progress, 100);

    for (const event of eventsOf(result, 'SET_FACTION_INFLUENCE')) {
        assert.ok(event.influence >= 0 && event.influence <= 100);
        assert.ok(
            Math.abs(event.influence - beforeInfluence[event.factionId])
                <= custom.defaults.maxFactionDeltaPerTick,
        );
    }
    for (const event of eventsOf(result, 'ADVANCE_THREAT')) {
        assert.ok(Math.abs(event.amount) <= 100);
    }
});

test('disbanded factions and defeated/contained threats do not move', async () => {
    const store = makeStore('s2');
    const tick = makeTick(store, { season: seasons.s2 });
    await tick.run();

    const prepared = store.get();
    for (const threat of prepared.threats) {
        threat.status = threat.id === 's2.threat.renya-clan' ? 'defeated' : 'contained';
    }
    store.replace(prepared);
    skipDays(store, 1);

    const result = await tick.run();
    const after = store.get();
    assert.equal(after.factions.clarity.status, 'disbanded');
    assert.equal(after.factions.clarity.influence, 10);
    assert.equal(after.threats.find((entry) => entry.id === 's2.threat.renya-clan').progress, 35);
    assert.equal(after.threats.find((entry) => entry.id === 's2.threat.living-curse').progress, 30);
    assert.equal(eventsOf(result, 'ADVANCE_THREAT').length, 0);
    assert.equal(
        eventsOf(result, 'SET_FACTION_INFLUENCE').some((event) => event.factionId === 'clarity'),
        false,
    );
});

test('NPC movement is capped and skips present, pinned, dead, captured, and player characters', async () => {
    const cappedStore = makeStore('s1');
    const cappedTick = makeTick(cappedStore);
    await cappedTick.run();
    skipDays(cappedStore, 1);
    const capped = await cappedTick.run();
    const moves = eventsOf(capped, 'MOVE_CHARACTER');
    assert.equal(moves.length, agendas.defaults.maxNpcMovesPerTick);
    assert.equal(moves.length, 2);
    assert.equal(new Set(moves.map((event) => event.characterId)).size, moves.length);

    const custom = structuredClone(agendas);
    custom.defaults.maxNpcMovesPerTick = 10;
    const store = makeStore('s1');
    const tick = makeTick(store, { agenda: custom });
    await tick.run();

    store.dispatch({ type: 'SET_STATUS', characterId: 's1.vaiva.colorgarde', status: 'dead' });
    store.dispatch({ type: 'SET_STATUS', characterId: 's1.tindur.sharkbite', status: 'captured' });
    const prepared = store.get();
    prepared.flags.castDirector = { manualPins: ['s1.claire.atropos'] };
    prepared.scene.present = [...prepared.scene.present, 's1.twisting.fate.corrupted.carol.fate'];
    store.replace(prepared);
    skipDays(store, 1);

    const before = store.get();
    const result = await tick.run();
    const after = store.get();
    const moved = eventsOf(result, 'MOVE_CHARACTER');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].characterId, 's1.crystal.cat');

    for (const characterId of [
        's1.vaiva.colorgarde',
        's1.tindur.sharkbite',
        's1.claire.atropos',
        's1.twisting.fate.corrupted.carol.fate',
        's1.aurelia.longshot',
    ]) {
        assert.equal(after.characters[characterId].locationId, before.characters[characterId].locationId);
    }
    assert.notEqual(
        after.characters['s1.crystal.cat'].locationId,
        before.characters['s1.crystal.cat'].locationId,
    );

    const playerStore = makeStore('s1', {
        identity: 'canon',
        characterId: 's1.vaiva.colorgarde',
    });
    const playerTick = makeTick(playerStore, { agenda: custom });
    await playerTick.run();
    const playerLocation = playerStore.get().characters['s1.vaiva.colorgarde'].locationId;
    skipDays(playerStore, 1);
    const playerResult = await playerTick.run();
    assert.equal(
        eventsOf(playerResult, 'MOVE_CHARACTER')
            .some((event) => event.characterId === 's1.vaiva.colorgarde'),
        false,
    );
    assert.equal(playerStore.get().characters['s1.vaiva.colorgarde'].locationId, playerLocation);
});

test('every moved NPC lands on an authored connection that differs from the origin', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    skipDays(store, 2);

    const before = store.get();
    const result = await tick.run();
    const moves = eventsOf(result, 'MOVE_CHARACTER');
    assert.ok(moves.length > 0);
    const authored = new Map(locations.locations.map((location) => [location.id, location]));
    for (const move of moves) {
        const origin = before.characters[move.characterId].locationId;
        assert.notEqual(move.locationId, origin);
        assert.ok(
            (authored.get(origin)?.connections ?? []).includes(move.locationId),
            `${origin} must connect to ${move.locationId}`,
        );
        assert.ok(store.get().locations[move.locationId]);
    }
});

test('rumors respect the per-tick cap and resolve every placeholder', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    skipDays(store, 1);

    const result = await tick.run();
    const rumors = eventsOf(result, 'ADD_EVENT').filter((event) => event.tags?.includes('offscreen'));
    assert.equal(rumors.length, Math.min(agendas.defaults.rumorsPerTick, 1));
    assert.equal(rumors.length, 1);
    const [rumor] = rumors;
    assert.equal(typeof rumor.headline, 'string');
    assert.ok(rumor.headline.length > 0);
    assert.ok(rumor.headline.length <= 90);
    assert.equal(rumor.summary.includes('{'), false);
    assert.equal(rumor.summary.includes('}'), false);
    assert.ok(rumor.tags.includes('tick'));
    assert.ok(rumor.tags.some((tag) => /^tick:\d+$/.test(tag)));
    assert.deepEqual(rumor.actors, []);
    assert.ok(store.get().flags.worldTick.pendingRumorIds.includes(
        `rumor:${store.get().meta.inGameDate}:${store.get().meta.storyTurn}:0`,
    ));
});

test('sandbox seasons and epilogues stay static', async () => {
    const sandboxStore = makeStore('s1');
    const sandboxTick = makeTick(sandboxStore, {
        season: { ...seasons.s1, sandbox: true },
    });
    sandboxStore.dispatch({ type: 'TICK_TIME', turns: 1, storyTurns: 1 });
    const sandbox = await sandboxTick.run();
    assert.equal(sandbox.ran, false);
    assert.equal(sandbox.reason, 'sandbox');
    assert.deepEqual(sandbox.events, []);

    const endingStore = makeStore('s1');
    const endingTick = makeTick(endingStore);
    await endingTick.run();
    const prepared = endingStore.get();
    prepared.ending = { status: 'epilogue', firedTurn: 1 };
    endingStore.replace(prepared);
    skipDays(endingStore, 1);
    const ending = await endingTick.run();
    assert.equal(ending.ran, false);
    assert.equal(ending.reason, 'ending');
    assert.deepEqual(ending.events, []);
});

test('worldTick.enabled false produces zero events', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store, { settings: { worldTick: { enabled: false } } });
    skipDays(store, 1);
    const result = await tick.run();
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'disabled');
    assert.deepEqual(result.events, []);
    assert.equal(store.get().flags.worldTick, undefined);
});

test('a custom faction and threat rate overrides the default rate', async () => {
    const custom = structuredClone(agendas);
    custom.seasons.s1.factionAgendas.clarity = { influencePerDay: 2 };
    custom.seasons.s1.threatPace['s1.threat.clarity'] = { progressPerDay: 3 };
    const store = makeStore('s1');
    const tick = makeTick(store, { agenda: custom });
    await tick.run();
    skipDays(store, 1);

    const result = await tick.run();
    assert.equal(result.ran, true);
    const after = store.get();
    assert.equal(after.factions.clarity.influence, 82);
    assert.equal(after.threats.find((entry) => entry.id === 's1.threat.clarity').progress, 28);
});

test('the flow reports apply-failed and leaves the state untouched when the batch is rejected', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    skipDays(store, 1);
    const before = snapshot(store);

    const originalReplace = store.replace;
    store.replace = () => {
        throw new Error('write refused');
    };
    const result = await tick.run();
    store.replace = originalReplace;

    assert.equal(result.ran, false);
    assert.equal(result.reason, 'apply-failed');
    assert.equal(snapshot(store), before);
});

test('the planner is pure: it never mutates the state it is given', async () => {
    const store = makeStore('s1');
    await makeTick(store).run();
    skipDays(store, 2);
    const state = store.get();
    const before = JSON.stringify(state);
    const plan = planWorldTick({
        state,
        season: seasons.s1,
        agenda: null,
        locations,
        settings: {},
    });
    assert.equal(plan.ok, true);
    assert.ok(Array.isArray(plan.events));
    assert.equal(JSON.stringify(state), before);
});

test('sub-unit per-day rates accumulate through the carry instead of being lost', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    const start = store.get().factions.clarity.influence;

    // s1 clarity is +0.3/day: one day rounds to zero, two days cross the unit.
    skipDays(store, 1);
    const first = await tick.run();
    assert.equal(first.ran, true);
    assert.equal(store.get().factions.clarity.influence, start);

    skipDays(store, 1);
    await tick.run();
    assert.equal(store.get().factions.clarity.influence, start + 1);
    const carry = store.get().flags.worldTick.carryFactions.clarity;
    assert.ok(Math.abs(carry) < 0.5);
});

test('a date-static clock (V1 mode) still ticks from the story-turn delta', async () => {
    const store = makeStore('s1dark');
    const tick = makeTick(store, { season: seasons.s1dark });
    await tick.run();
    const before = store.get();
    // Advance fiction turns without touching the date, exactly like a disabled clock.
    store.replace({
        ...before,
        meta: {
            ...before.meta,
            turn: before.meta.turn + 5,
            storyTurn: before.meta.storyTurn + 5,
        },
    });
    const result = await tick.run();
    assert.equal(result.ran, true);
    assert.equal(result.summary.appliedDays, 1);
    assert.ok(result.events.length > 0);
});

test('an unreadable agenda document falls back to the global defaults', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store, { agenda: null });
    await tick.run();
    skipDays(store, 1);
    const result = await tick.run();
    assert.equal(result.ran, true);
    assert.equal(result.summary.appliedDays, 1);
    assert.ok(result.events.length > 0);
});

test('an aborted tick leaves the world byte-identical', async () => {
    const store = makeStore('s1');
    const tick = makeTick(store);
    await tick.run();
    skipDays(store, 3);
    const before = snapshot(store);
    const result = await tick.run({ signal: { aborted: true } });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'aborted');
    assert.equal(snapshot(store), before);
});

test('a due tick with zero events still advances its baseline', async () => {
    const zeroAgenda = {
        schemaVersion: 1,
        defaults: {
            factionInfluencePerDay: 0,
            mainThreatProgressPerDay: 0,
            secondaryThreatProgressPerDay: 0,
            maxFactionDeltaPerTick: 0,
            maxNpcMovesPerTick: 0,
            maxDaysPerTick: 14,
            rumorsPerTick: 0,
            rumorTemplates: ['Nothing happens in {location}.'],
        },
        seasons: {},
    };
    const store = makeStore('s1');
    const tick = makeTick(store, { agenda: zeroAgenda });
    await tick.run();
    skipDays(store, 2);
    const result = await tick.run();
    assert.equal(result.ran, true);
    assert.deepEqual(result.events, []);
    const tickFlags = store.get().flags.worldTick;
    assert.equal(tickFlags.totalDays, 2);
    assert.equal(tickFlags.lastStoryTurn, store.get().meta.storyTurn);
});

test('rumor ids already recorded in pendingRumorIds are not repeated', () => {
    const store = makeStore('s1');
    const state = store.get();
    const baseline = {
        ...state,
        meta: { ...state.meta, storyTurn: 5 },
        flags: {
            ...state.flags,
            worldTick: {
                lastDate: state.meta.inGameDate,
                lastTurn: 0,
                lastStoryTurn: 0,
                totalDays: 0,
                suppressedDays: 0,
                pendingRumorIds: [`rumor:${state.meta.inGameDate}:5:1`],
                carryFactions: {},
                carryThreats: {},
            },
        },
    };
    const plan = planWorldTick({
        state: baseline,
        season: seasons.s1,
        agenda: agendas,
        locations,
        settings: {},
    });
    assert.equal(plan.ok, true);
    const rumorTags = plan.events
        .filter((event) => Array.isArray(event.tags) && event.tags.includes('offscreen'))
        .flatMap((event) => event.tags.filter((tag) => tag.startsWith('tick:')));
    assert.ok(rumorTags.length > 0);
    const updated = plan.worldTick.pendingRumorIds;
    assert.equal(new Set(updated).size, updated.length);
    assert.ok(updated.includes(`rumor:${state.meta.inGameDate}:5:1`));
});

