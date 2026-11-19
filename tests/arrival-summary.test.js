import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArrivalSummary } from '../src/ui/arrival-summary.js';

function makeState({
    flags = {},
    timeOfDay = 'evening',
    turn = 12,
    locationId = 'loc.b',
    encounter = null,
    characters = {},
} = {}) {
    return {
        chatId: 'arrival-summary-test',
        seasonId: 's1',
        characters,
        locations: {
            'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Hub', status: 'quiet' },
            'loc.b': { id: 'loc.b', name: 'Docks', district: 'West', status: 'quiet' },
            'loc.c': { id: 'loc.c', name: 'Tower', status: 'quiet' },
        },
        scene: { locationId, present: [], encounter, framing: '' },
        meta: { turn, timeOfDay, inCombat: false },
        flags,
    };
}

const LAST_AT = 1763500000000;

const TRAVEL_FLAGS = {
    travel: {
        lastFrom: 'loc.a',
        lastTo: 'loc.b',
        lastPath: ['loc.a', 'loc.b'],
        lastBridges: [],
        lastTurns: 2,
        lastAt: LAST_AT,
    },
};

test('returns null when nothing has travelled', () => {
    assert.equal(buildArrivalSummary({ state: makeState() }), null);
    assert.equal(buildArrivalSummary({ state: null }), null);
    assert.equal(buildArrivalSummary({}), null);
});

test('builds a summary from a fresh travel result', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    const result = {
        ok: true,
        from: 'loc.a',
        to: 'loc.b',
        toName: 'Docks',
        turns: 2,
        state,
    };
    const summary = buildArrivalSummary({ result, state });
    assert.ok(summary);
    assert.equal(summary.key, `travel:loc.a:loc.b:${LAST_AT}`);
    assert.equal(summary.fromId, 'loc.a');
    assert.equal(summary.toId, 'loc.b');
    assert.equal(summary.destination, 'Docks');
    assert.equal(summary.district, 'West');
    assert.equal(summary.timeSlot, 'Evening');
    assert.equal(summary.turns, 2);
    assert.equal(summary.hasEncounter, false);
    assert.deepEqual(summary.hostiles, []);
    assert.equal(summary.encounterKey, null);
    assert.match(summary.text, /Docks/);
    assert.match(summary.text, /evening/);
    assert.match(summary.text, /No hostiles detected/);
});

test('derives the summary from WorldState after a remount', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    state.locations['loc.b'].name = 'The Docks';
    const fresh = buildArrivalSummary({
        result: { ok: true, from: 'loc.a', to: 'loc.b', toName: 'Docks', turns: 2, state: makeState({ flags: TRAVEL_FLAGS }) },
        state: makeState({ flags: TRAVEL_FLAGS }),
    });
    const summary = buildArrivalSummary({ result: null, state });
    assert.ok(summary);
    assert.equal(summary.key, `travel:loc.a:loc.b:${LAST_AT}`);
    // Fresh and remount paths must agree on the arrival identity.
    assert.equal(fresh.key, summary.key);
    assert.equal(summary.destination, 'The Docks');
    assert.equal(summary.turns, 2);
    assert.match(summary.text, /The Docks/);
});

test('a stale encounter at a different location yields no encounter', () => {
    const state = makeState({
        flags: TRAVEL_FLAGS,
        encounter: {
            locationId: 'loc.a',
            characterIds: ['npc.ghost'],
            threatNames: ['A Stale Threat'],
            source: 'travel',
        },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.hasEncounter, false);
    assert.equal(summary.encounterKey, null);
    assert.deepEqual(summary.hostiles, []);
    assert.match(summary.text, /No hostiles detected/);
    assert.doesNotMatch(summary.text, /Ghost/);
    assert.doesNotMatch(summary.text, /Stale Threat/);
});

test('a current encounter names its hostiles', () => {
    const state = makeState({
        flags: TRAVEL_FLAGS,
        encounter: {
            locationId: 'loc.b',
            characterIds: ['npc.ghost'],
            threatNames: ['Dock Riot'],
            source: 'travel',
        },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.hasEncounter, true);
    assert.deepEqual(summary.hostiles, ['Ghost', 'Dock Riot']);
    assert.equal(summary.encounterKey, 'loc.b|npc.ghost|Dock Riot');
    assert.match(summary.text, /Ghost, Dock Riot are present/);
});

test('alreadyThere and rejected results yield null even with a travel history', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    assert.equal(buildArrivalSummary({
        result: { ok: true, alreadyThere: true, from: 'loc.b', to: 'loc.b' },
        state,
    }), null);
    assert.equal(buildArrivalSummary({
        result: { ok: false, reason: 'in-combat', from: 'loc.a', to: 'loc.b' },
        state,
    }), null);
});

test('text never invents hostiles and handles a missing time slot', () => {
    const state = makeState({ flags: TRAVEL_FLAGS, timeOfDay: null });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.timeSlot, null);
    assert.equal(summary.hostiles.length, 0);
    assert.match(summary.text, /Docks/);
    assert.match(summary.text, /now/);
    assert.match(summary.text, /No hostiles detected/);
});

test('a first trip with no flags history keys from the fresh result and turn', () => {
    const state = makeState({ flags: {} });
    const summary = buildArrivalSummary({
        result: { ok: true, to: 'loc.b', toName: 'Docks', turns: '1', state },
        state,
    });
    assert.ok(summary);
    // No durable `lastAt` yet: the scene turn is the fallback identity.
    assert.equal(summary.key, 'travel::loc.b:12');
    assert.equal(summary.fromId, null);
    assert.equal(summary.turns, 1);
    assert.equal(summary.district, 'West');
});

test('a fresh result without its own state still uses the supplied state', () => {
    const state = makeState({ flags: {} });
    const summary = buildArrivalSummary({
        result: { ok: true, from: 'loc.a', to: 'loc.b', toName: 'Docks', turns: 2 },
        state,
    });
    assert.ok(summary);
    assert.equal(summary.key, 'travel:loc.a:loc.b:12');
    assert.equal(summary.district, 'West');
});

test('a malformed successful result never falls back to an older arrival', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    assert.equal(buildArrivalSummary({ result: { ok: true }, state }), null);
    assert.equal(buildArrivalSummary({ result: { ok: true, to: '' }, state }), null);
});

test('a location without a district still yields a summary', () => {
    const state = makeState({
        flags: {
            travel: { lastFrom: 'loc.a', lastTo: 'loc.c', lastTurns: 1, lastAt: 4 },
        },
        locationId: 'loc.c',
        timeOfDay: 'dawn',
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.destination, 'Tower');
    assert.equal(summary.district, null);
    assert.equal(summary.timeSlot, 'Dawn');
});
