import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DOWNTIME_ACTIONS,
    buildDowntimePlan,
    createDowntimeFlow,
    resolveDowntimeEvents,
} from '../src/flows/downtime.js';
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
const season = readJson('data/seasons/s1.json');
const agendas = readJson('data/agendas.json');
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore() {
    const store = createWorldStateStore({
        metadata: {},
        chatId: 'downtime-test-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
        now: () => NOW,
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'downtime-test-chat',
        player: { identity: 'custom', displayName: 'Alex' },
        now: NOW,
    });
    return store;
}

test('every authored downtime action plans one clock slot, a bounded stat change, and an event', () => {
    const state = makeStore().get();
    for (const action of DOWNTIME_ACTIONS) {
        const plan = buildDowntimePlan({ actionId: action.id, state, season });
        assert.equal(plan.ok, true, action.id);
        assert.equal(plan.events[0].type, 'TICK_TIME', action.id);
        assert.equal(plan.events[0].turns, 1, action.id);
        const event = plan.events.find((entry) => entry.type === 'ADD_EVENT');
        assert.ok(event, action.id);
        assert.ok(event.tags.includes('downtime'), action.id);
        assert.ok(event.tags.includes(action.id), action.id);
        for (const stat of plan.events.filter((entry) => entry.type === 'SET_PLAYER_STAT')) {
            assert.ok(Number.isFinite(stat.value), action.id);
            assert.ok(stat.value >= 0, action.id);
        }
    }
});

test('rest raises stamina without exceeding the maximum and train spends it', () => {
    const store = makeStore();
    const before = structuredClone(store.get());
    before.player.stamina.current = Math.max(0, Number(before.player.stamina.max) - 5);
    before.player.willpower.current = Math.max(0, Number(before.player.willpower.max) - 5);
    const rest = buildDowntimePlan({ actionId: 'rest', state: before, season });
    const stamina = rest.events.find((entry) => entry.type === 'SET_PLAYER_STAT' && entry.path === 'stamina.current');
    assert.ok(stamina);
    assert.ok(stamina.value > Number(before.player.stamina.current));
    assert.ok(stamina.value <= Number(before.player.stamina.max));

    const train = buildDowntimePlan({ actionId: 'train', state: before, season });
    const trainStamina = train.events.find((entry) => entry.type === 'SET_PLAYER_STAT' && entry.path === 'stamina.current');
    assert.ok(trainStamina);
    assert.ok(trainStamina.value < Number(before.player.stamina.current));
    assert.ok(trainStamina.value >= 0);
});

test('the downtime flow applies the turn atomically and writes a journal event', async () => {
    const store = makeStore();
    const before = store.get();
    const flow = createDowntimeFlow({
        store,
        season,
        getSettings: () => ({ agents: { storyline: { enabled: false } } }),
        loadEvents: async () => resolveDowntimeEvents(agendas, 's1'),
        now: () => NOW,
    });
    const result = await flow.perform('patrol');
    assert.equal(result.ok, true);
    assert.equal(result.ran, true);
    assert.equal(store.get().meta.turn, before.meta.turn + 1);
    const events = store.get().recentEvents;
    assert.ok(events.some((event) => event.tags.includes('downtime') && event.tags.includes('patrol')));
    assert.match(result.summary, /Patrol/);
});

test('downtime works with every agent disabled and content gate applies', async () => {
    const store = makeStore();
    const flow = createDowntimeFlow({
        store,
        season,
        getSettings: () => ({
            contentGate: 'strict',
            contentLimits: {},
            agents: {
                stateTracker: { enabled: false },
                storyline: { enabled: false },
                castDirector: { enabled: false },
                lore: { enabled: false },
                auditor: { enabled: false },
            },
        }),
        loadEvents: async () => ['An explicit sex scene and graphic violence unfold in {location}.'],
        now: () => NOW,
    });
    const result = await flow.perform('socialize');
    assert.equal(result.ok, true);
    assert.ok(result.events.some((event) => event.type === 'ADD_EVENT'));
    // Strict gating strips the flagged sentence; the action still applies.
    assert.doesNotMatch(result.summary, /explicit sex|graphic violence/i);
});

test('an unknown action is rejected without mutating the world', async () => {
    const store = makeStore();
    const before = store.get();
    const flow = createDowntimeFlow({ store, season, now: () => NOW });
    const result = await flow.perform('fly');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-action');
    assert.equal(store.get(), before);
});

test('resolveDowntimeEvents prefers a season table and falls back to defaults', () => {
    const s1 = resolveDowntimeEvents(agendas, 's1');
    assert.ok(s1.some((entry) => /Clarity/.test(entry)));
    const unknown = resolveDowntimeEvents(agendas, 'nope');
    assert.ok(unknown.length >= 2);
    const empty = resolveDowntimeEvents(null, 's1');
    assert.ok(empty.length >= 2);
});
