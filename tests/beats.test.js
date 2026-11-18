import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getBeatStatus,
    getCurrentAct,
    getUpcomingBeats,
    isBeatOverdue,
    isFinalDeadlinePassed,
    listImpossibleBeats,
    listSatisfiedBeats,
    planBeatLifecycleEvents,
    summarizeBeatLedger,
} from '../src/data/beats.js';
import { applyWorldEvents } from '../src/state/reducer.js';
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
    s4: readJson('data/seasons/s4.json'),
};

const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore(seasonId = 's1', player = { identity: 'custom' }) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'beat-test-chat',
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
        chatId: 'beat-test-chat',
        player,
        now: NOW,
    });
    return store;
}

function apply(store, events) {
    const next = applyWorldEvents(store.get(), events, CONTEXT);
    return store.replace(next);
}

test('deadline helpers read turns, dates, acts, and upcoming beats deterministically', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const state = store.get();

    assert.equal(isFinalDeadlinePassed(season, state), false);
    assert.equal(getCurrentAct(state, season), 'opening');
    assert.deepEqual(
        getUpcomingBeats(state, season, 2).map((beat) => beat.id),
        ['s1.opening.arms-deal', 's1.opening.beast-rumors'],
    );

    const overdueState = { ...state, meta: { ...state.meta, turn: 13, storyTurn: 13 } };
    const armsDeal = season.canonBeats.find((beat) => beat.id === 's1.opening.arms-deal');
    assert.equal(isBeatOverdue(armsDeal, overdueState), true);
    assert.equal(isBeatOverdue(armsDeal, state), false);

    const late = { ...state, meta: { ...state.meta, turn: 91, storyTurn: 91 } };
    assert.equal(isFinalDeadlinePassed(season, late), true);
});

test('a satisfied completion predicate resolves the beat and journals it', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const withEvent = apply(store, [{
        type: 'ADD_EVENT',
        summary: 'The arms deal is signed.',
        actors: [],
        locationId: 'central-plaza',
        tags: ['arms-deal'],
    }]);

    assert.deepEqual(
        listSatisfiedBeats(withEvent, season).map((beat) => beat.id),
        ['s1.opening.arms-deal'],
    );

    const plan = planBeatLifecycleEvents({ state: withEvent, season });
    const resolve = plan.events.find((event) => event.type === 'RESOLVE_BEAT');
    assert.equal(resolve.beatId, 's1.opening.arms-deal');

    const next = applyWorldEvents(withEvent, plan.events, CONTEXT);
    assert.equal(getBeatStatus(next, 's1.opening.arms-deal'), 'resolved');
    assert.equal(next.ending.status, 'none');
    assert.ok(next.recentEvents.some(
        (event) => event.beatId === 's1.opening.arms-deal'
            && event.tags.includes('beat-resolved'),
    ));
});

test('a missed soft deadline defers once and escalates the primary threat', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const ticked = apply(store, [{ type: 'TICK_TIME', turns: 13 }]);
    const before = ticked.threats.find((threat) => threat.id === 's1.threat.clarity').progress;

    const plan = planBeatLifecycleEvents({ state: ticked, season, pressure: 'standard' });
    assert.ok(plan.events.some(
        (event) => event.type === 'DEFER_BEAT' && event.beatId === 's1.opening.arms-deal',
    ));
    assert.ok(plan.events.some(
        (event) => event.type === 'ADVANCE_THREAT' && event.threatId === 's1.threat.clarity',
    ));
    assert.ok(plan.events.some(
        (event) => event.type === 'ADD_EVENT' && event.tags.includes('beat-deadline'),
    ));

    const next = applyWorldEvents(ticked, plan.events, CONTEXT);
    assert.equal(getBeatStatus(next, 's1.opening.arms-deal'), 'deferred');
    assert.equal(
        next.threats.find((threat) => threat.id === 's1.threat.clarity').progress,
        Math.min(100, before + 10),
    );

    // Deferred beats are not escalated twice.
    const second = planBeatLifecycleEvents({ state: next, season, pressure: 'standard' });
    assert.equal(second.events.some(
        (event) => event.type === 'DEFER_BEAT' && event.beatId === 's1.opening.arms-deal',
    ), false);
});

test('pressure off disables escalation but still records the deadline miss', () => {
    const store = makeStore('s1');
    const state = apply(store, [{ type: 'TICK_TIME', turns: 13 }]);
    const plan = planBeatLifecycleEvents({ state, season: seasons.s1, pressure: 'off' });
    assert.equal(plan.events.some((event) => event.type === 'ADVANCE_THREAT'), false);
    assert.ok(plan.events.some((event) => event.type === 'DEFER_BEAT'));
});

test('the final deadline records a villain victory exactly once', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const late = apply(store, [{ type: 'TICK_TIME', turns: 91 }]);

    const plan = planBeatLifecycleEvents({ state: late, season, pressure: 'off' });
    assert.equal(plan.ending, true);
    assert.ok(plan.events.some((event) => event.type === 'TRIGGER_ENDING'));

    const next = applyWorldEvents(late, plan.events, CONTEXT);
    assert.equal(next.ending.status, 'epilogue');
    assert.equal(next.ending.firedTurn, 91);
    assert.ok(next.recentEvents.some(
        (event) => event.tags.includes('villain-victory')
            && event.tags.includes('final-deadline'),
    ));

    const second = planBeatLifecycleEvents({ state: next, season, pressure: 'off' });
    assert.equal(second.ending, false);
    assert.equal(second.events.some((event) => event.type === 'TRIGGER_ENDING'), false);
});

test('an early main-threat defeat short-circuits impossible beats and promotes a successor', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    let state = apply(store, [
        { type: 'SET_THREAT_STATUS', threatId: 's1.threat.clarity', status: 'defeated' },
        { type: 'SET_STATUS', characterId: 's1.vaiva.colorgarde', status: 'dead' },
        { type: 'SET_STATUS', characterId: 's1.claire.atropos', status: 'dead' },
        { type: 'TICK_TIME', turns: 50 },
    ]);

    assert.deepEqual(
        listImpossibleBeats(state, season).map((beat) => beat.id),
        ['s1.opening.arms-deal', 's1.climax.claire-confrontation'],
    );

    const plan = planBeatLifecycleEvents({ state, season, pressure: 'off' });
    assert.ok(plan.events.some(
        (event) => event.type === 'SHORT_CIRCUIT_BEAT'
            && event.beatId === 's1.climax.claire-confrontation',
    ));
    assert.ok(plan.events.some(
        (event) => event.type === 'ADD_EVENT'
            && event.tags.includes('successor:s1.threat.bcp'),
    ));

    state = applyWorldEvents(state, plan.events, CONTEXT);
    assert.equal(getBeatStatus(state, 's1.climax.claire-confrontation'), 'short-circuited');
    assert.equal(getBeatStatus(state, 's1.resolution.clarity-falls'), 'resolved');

    const summary = summarizeBeatLedger(state, season);
    assert.ok(summary.statuses['short-circuited'] >= 1);
});

test('final deadline is averted when every main threat is already defeated', () => {
    const store = makeStore('s4');
    const season = seasons.s4;
    const state = apply(store, [
        { type: 'SET_THREAT_STATUS', threatId: 's4.threat.noah-atopos', status: 'defeated' },
        { type: 'SET_THREAT_STATUS', threatId: 's4.threat.ginny-avalanche', status: 'defeated' },
        { type: 'TICK_TIME', turns: 91 },
    ]);
    const plan = planBeatLifecycleEvents({ state, season, pressure: 'off' });
    assert.equal(plan.ending, false);
    assert.ok(plan.notes.includes('final-deadline-averted'));
});

test('S4 exposes two independent main threats and their progress clamps', () => {
    const store = makeStore('s4');
    const season = seasons.s4;
    const mains = store.get().threats.filter((threat) => threat.rank === 'main');
    assert.equal(mains.length, 2);

    const next = applyWorldEvents(store.get(), [
        { type: 'ADVANCE_THREAT', threatId: 's4.threat.noah-atopos', amount: 500 },
        { type: 'ADVANCE_THREAT', threatId: 's4.threat.ginny-avalanche', amount: 15 },
    ], CONTEXT);
    const noah = next.threats.find((threat) => threat.id === 's4.threat.noah-atopos');
    const ginny = next.threats.find((threat) => threat.id === 's4.threat.ginny-avalanche');
    assert.equal(noah.progress, 100);
    assert.equal(noah.stage, noah.stages.length - 1);
    assert.ok(ginny.progress > 25);
    assert.ok(getCurrentAct(next, season));
});

test('a hold freezes fiction time and suppresses deadline escalation', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const start = store.get();
    const startDate = start.meta.inGameDate;
    const startSlot = start.meta.timeOfDay;

    let state = apply(store, [{ type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' }]);
    state = applyWorldEvents(state, [{ type: 'TICK_TIME', turns: 10, storyTurns: 0 }], CONTEXT);
    assert.equal(state.meta.turn, 10);
    assert.equal(state.meta.storyTurn, 0);
    assert.equal(state.meta.inGameDate, startDate);
    assert.equal(state.meta.timeOfDay, startSlot);

    const plan = planBeatLifecycleEvents({ state, season, pressure: 'standard' });
    assert.ok(plan.notes.includes('time-held'));
    assert.equal(plan.ending, false);
    assert.equal(plan.events.some((event) => event.type === 'DEFER_BEAT'), false);
    assert.equal(plan.events.some((event) => event.type === 'ADVANCE_THREAT'), false);
    assert.equal(plan.events.some((event) => event.type === 'TRIGGER_ENDING'), false);

    // Suspension must hold even when fiction time is already past every
    // deadline: the world cannot punish the player inside a frozen scene.
    const overdueHeld = applyWorldEvents(state, [{
        type: 'TICK_TIME',
        turns: 0,
        storyTurns: 500,
    }], CONTEXT);
    assert.equal(overdueHeld.meta.storyTurn, 500);
    const overduePlan = planBeatLifecycleEvents({ state: overdueHeld, season, pressure: 'standard' });
    assert.ok(overduePlan.notes.includes('time-held'));
    assert.equal(overduePlan.ending, false);
    assert.equal(overduePlan.events.some((event) => event.type === 'DEFER_BEAT'), false);
    assert.equal(overduePlan.events.some((event) => event.type === 'ADVANCE_THREAT'), false);
    assert.equal(overduePlan.events.some((event) => event.type === 'TRIGGER_ENDING'), false);

    // An explicit tick still advances both counters and the date.
    const explicit = applyWorldEvents(state, [{
        type: 'TICK_TIME',
        turns: 13,
        storyTurns: 13,
        date: '2037-03-20',
        timeOfDay: 'night',
    }], CONTEXT);
    assert.equal(explicit.meta.turn, 23);
    assert.equal(explicit.meta.storyTurn, 13);
    assert.equal(explicit.meta.inGameDate, '2037-03-20');
    assert.equal(explicit.meta.timeOfDay, 'night');

    // Releasing the hold re-enables overdue escalation.
    const released = applyWorldEvents(explicit, [{
        type: 'SET_CLOCK_HOLD',
        active: false,
        reason: 'manual-release',
    }], CONTEXT);
    const escalation = planBeatLifecycleEvents({ state: released, season, pressure: 'standard' });
    assert.ok(escalation.events.some(
        (event) => event.type === 'DEFER_BEAT' && event.beatId === 's1.opening.arms-deal',
    ));
});

test('isBeatOverdue is driven by storyTurn, not the mechanical turn', () => {
    const store = makeStore('s1');
    const season = seasons.s1;
    const state = store.get();
    const armsDeal = season.canonBeats.find((beat) => beat.id === 's1.opening.arms-deal');
    assert.equal(isBeatOverdue(armsDeal, { ...state, meta: { ...state.meta, turn: 99, storyTurn: 0 } }), false);
    assert.equal(
        isBeatOverdue(armsDeal, { ...state, meta: { ...state.meta, turn: 0, storyTurn: 99 } }),
        true,
    );
});

test('a date-based beat deadline becomes reachable once the in-game date passes it', () => {
    const store = makeStore('s1');
    const state = store.get();
    const dated = { id: 'fixture.dated', deadlineDate: '2037-03-05', deadlineTurns: null };
    const before = { ...state, meta: { ...state.meta, inGameDate: '2037-03-05', storyTurn: 0 } };
    const after = { ...state, meta: { ...state.meta, inGameDate: '2037-03-06', storyTurn: 0 } };
    assert.equal(isBeatOverdue(dated, before), false);
    assert.equal(isBeatOverdue(dated, after), true);
});
