import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    STORYLINE_SCHEMA,
    buildStorylinePrompt,
    createStorylineTracker,
    normalizeStorylineResult,
    planDeterministicStoryline,
} from '../src/agents/storyline.js';
import { AgentAbortedError, validateJsonSchema } from '../src/agents/client.js';
import {
    ARCHITECT_SCHEMA,
    buildArchitectPrompt,
    createArchitect,
    normalizeArchitectResult,
} from '../src/agents/architect.js';
import { createAuditor } from '../src/agents/auditor.js';
import {
    applyEventBatch,
    createInitiative,
    getAgentCadence,
    shouldRunStoryline,
} from '../src/flows/initiative.js';
import { createTravelInitiativeHook, buildTravelInitiativeContext } from '../src/flows/travel.js';
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
    s1dark: readJson('data/seasons/s1dark.json'),
    s4: readJson('data/seasons/s4.json'),
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore(seasonId = 's1', player = { identity: 'custom' }) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'storyline-test-chat',
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
        chatId: 'storyline-test-chat',
        player,
        now: NOW,
    });
    return store;
}

function apply(store, events) {
    return store.replace(applyWorldEvents(store.get(), events, CONTEXT));
}

function stableState(state) {
    return JSON.stringify({ ...state, log: [] });
}

const emptyResult = {
    factions: [],
    threats: [],
    characters: [],
    locations: [],
    transformations: [],
    events: [],
    beats: [],
    rationale: '',
};

test('the storyline schema accepts the empty contract', () => {
    const validation = validateJsonSchema(emptyResult, STORYLINE_SCHEMA);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test('normalization translates supported world changes into reducer events', () => {
    const store = makeStore('s1');
    const state = store.get();
    const result = {
        ...emptyResult,
        factions: [{ id: 'clarity', influence: 75, goals: ['Control the plaza'] }],
        threats: [{ id: 's1.threat.clarity', progressDelta: 5, stage: 1 }],
        characters: [{
            id: 's1.vaiva.colorgarde',
            locationId: 'central-plaza',
            agenda: 'Find the arms dealer',
            goals: ['Locate the shipment'],
        }],
        locations: [{ id: 'central-plaza', status: 'contested', factionId: 'clarity' }],
        events: [{
            summary: 'A deal goes wrong in the plaza.',
            headline: 'Plaza deal collapses',
            actors: ['s1.vaiva.colorgarde'],
            locationId: 'central-plaza',
            tags: ['arms-deal'],
        }],
        framing: 'Gunfire echoes across Central Plaza.',
        rationale: 'The opening beat needs a setback.',
    };

    const normalized = normalizeStorylineResult({ result, state, season: seasons.s1, formRules });
    assert.equal(normalized.rejected.length, 0);
    assert.ok(normalized.events.some((event) => event.type === 'SET_FACTION_INFLUENCE'));
    assert.ok(normalized.events.some(
        (event) => event.type === 'ADVANCE_THREAT' && event.amount === 5,
    ));
    assert.ok(normalized.events.some(
        (event) => event.type === 'ADVANCE_THREAT' && event.stage === 1,
    ));
    assert.ok(normalized.events.some((event) => event.type === 'MOVE_CHARACTER'));
    assert.ok(normalized.events.some((event) => event.type === 'SET_LOCATION_STATUS'));
    assert.ok(normalized.events.some((event) => event.type === 'ADD_EVENT'));
    assert.ok(normalized.events.some((event) => event.type === 'SET_SCENE_FRAMING'));

    const next = applyWorldEvents(state, normalized.events, CONTEXT);
    assert.equal(next.factions.clarity.influence, 75);
    assert.equal(next.locations['central-plaza'].status, 'contested');
    assert.equal(next.characters['s1.vaiva.colorgarde'].agenda, 'Find the arms dealer');
    assert.ok(next.recentEvents.some((event) => event.tags.includes('arms-deal')));
    assert.ok(next.threats.find((threat) => threat.id === 's1.threat.clarity').progress > 0);
});

test('normalization rejects player edits, negative progress, and undeclared transforms', () => {
    const darkStore = makeStore('s1dark', {
        identity: 'canon',
        characterId: 's1dark.carol.bleeding-heart',
    });
    const darkState = darkStore.get();
    const playerResult = normalizeStorylineResult({
        result: {
            ...emptyResult,
            threats: [{ id: 's1dark.threat.resistance', progressDelta: -20 }],
            characters: [{
                id: 's1dark.carol.bleeding-heart',
                agenda: 'Surrender',
                status: 'captured',
            }],
        },
        state: darkState,
        season: seasons.s1dark,
        formRules,
    });
    assert.equal(playerResult.events.length, 0);
    assert.ok(playerResult.rejected.some((entry) => entry.reason === 'non-monotonic-progress'));
    assert.ok(playerResult.rejected.some((entry) => entry.reason === 'player-controlled'));

    const store = makeStore('s1');
    const state = store.get();
    const transformResult = normalizeStorylineResult({
        result: {
            ...emptyResult,
            transformations: [{
                characterId: 's1.aurelia.longshot',
                formId: 's1.redraw.corrupted.longshot',
            }],
        },
        state,
        season: seasons.s1,
        formRules: { rules: [] },
    });
    assert.equal(transformResult.events.length, 0);
    assert.ok(transformResult.rejected.some((entry) => entry.reason === 'undeclared-form-rule'));
});

test('a legal form rule becomes a TRANSFORM event and an illegal one is rejected', () => {
    const store = makeStore('s1');
    const state = store.get();
    const legal = normalizeStorylineResult({
        result: {
            ...emptyResult,
            transformations: [{
                characterId: 's1.aurelia.longshot',
                formId: 's1.redraw.corrupted.longshot',
            }],
        },
        state,
        season: seasons.s1,
        formRules,
    });
    assert.equal(legal.rejected.length, 0);
    assert.equal(legal.events[0].type, 'TRANSFORM');

    const illegal = normalizeStorylineResult({
        result: {
            ...emptyResult,
            transformations: [{
                characterId: 's1.aurelia.longshot',
                formId: 's1.redraw.corrupted.longshot',
            }],
        },
        state,
        season: seasons.s1,
        formRules: { rules: [] },
    });
    assert.equal(illegal.events.length, 0);
    assert.equal(illegal.rejected[0].reason, 'undeclared-form-rule');
});

test('beat actions resolve only satisfied predicates, adapt dead actors, and defer with a reason', () => {
    const store = makeStore('s1');
    let state = apply(store, [
        { type: 'SET_STATUS', characterId: 's1.vaiva.colorgarde', status: 'dead' },
        { type: 'SET_STATUS', characterId: 's1.claire.atropos', status: 'captured' },
    ]);

    const unsatisfied = normalizeStorylineResult({
        result: {
            ...emptyResult,
            beats: [{
                id: 's1.opening.beast-rumors',
                action: 'resolve',
                reason: 'seemed close enough',
            }],
        },
        state,
        season: seasons.s1,
        formRules,
    });
    assert.equal(unsatisfied.events.length, 0);
    assert.equal(unsatisfied.rejected[0].reason, 'predicates-not-satisfied');

    const adapted = normalizeStorylineResult({
        result: {
            ...emptyResult,
            beats: [{
                id: 's1.climax.claire-confrontation',
                action: 'adapt',
                adaptedFrom: 's1.vaiva.colorgarde',
                adaptedTo: 's1.crystal.cat',
                reason: 'Vaiva is dead; Crystal Cat takes the confrontation.',
            }],
        },
        state,
        season: seasons.s1,
        formRules,
    });
    assert.ok(adapted.events.some((event) => event.type === 'ADAPT_BEAT'));
    state = applyWorldEvents(state, adapted.events, CONTEXT);
    assert.equal(state.beats['s1.climax.claire-confrontation'].status, 'adapted');
    assert.equal(state.beats['s1.climax.claire-confrontation'].adaptedTo, 's1.crystal.cat');

    const deferred = normalizeStorylineResult({
        result: {
            ...emptyResult,
            beats: [{
                id: 's1.opening.beast-rumors',
                action: 'defer',
                reason: 'The scene moved away from the rumor.',
            }],
        },
        state,
        season: seasons.s1,
        formRules,
    });
    assert.ok(deferred.events.some((event) => event.type === 'DEFER_BEAT'));
});

test('short-circuit is terminal and cannot resolve twice', () => {
    const store = makeStore('s1');
    const state = store.get();
    const first = normalizeStorylineResult({
        result: {
            ...emptyResult,
            beats: [{
                id: 's1.climax.claire-confrontation',
                action: 'short-circuit',
                reason: 'The premise is impossible in this timeline.',
            }],
        },
        state,
        season: seasons.s1,
        formRules,
    });
    assert.ok(first.events.some((event) => event.type === 'SHORT_CIRCUIT_BEAT'));
    const next = applyWorldEvents(state, first.events, CONTEXT);
    assert.equal(next.beats['s1.climax.claire-confrontation'].status, 'short-circuited');

    const second = normalizeStorylineResult({
        result: {
            ...emptyResult,
            beats: [{
                id: 's1.climax.claire-confrontation',
                action: 'resolve',
                reason: 'Trying to reopen',
            }],
        },
        state: next,
        season: seasons.s1,
        formRules,
    });
    assert.equal(second.events.length, 0);
    assert.equal(second.rejected[0].reason, 'beat-already-terminal');
});

test('the prompt is deterministic and lists the current act and open beats', () => {
    const store = makeStore('s4');
    const prompt = buildStorylinePrompt({
        state: store.get(),
        season: seasons.s4,
        pressure: 'standard',
        recentProse: 'The city freezes.',
    });
    assert.match(prompt, /Storyline Tracker/);
    assert.match(prompt, /Act: opening/);
    assert.match(prompt, /s4\.opening\.claire-returns/);
    assert.match(prompt, /Never edit the player-controlled character/);
    assert.equal(prompt, buildStorylinePrompt({
        state: store.get(),
        season: seasons.s4,
        pressure: 'standard',
        recentProse: 'The city freezes.',
    }));
});

test('tracker failure and abort never mutate state; disabled mode makes no call', async () => {
    const store = makeStore('s1');
    const before = stableState(store.get());
    let calls = 0;

    const disabled = createStorylineTracker({
        runner: { runAgent: async () => { calls += 1; return emptyResult; } },
        getSettings: () => ({ agents: { storyline: { enabled: false } } }),
    });
    const skipped = await disabled.run({ state: store.get(), season: seasons.s1, formRules });
    assert.equal(calls, 0);
    assert.equal(skipped.source, 'deterministic');
    assert.equal(stableState(store.get()), before);

    const failing = createStorylineTracker({
        runner: { runAgent: async () => { throw new Error('model unavailable'); } },
        getSettings: () => ({}),
        log: () => {},
    });
    const failed = await failing.run({ state: store.get(), season: seasons.s1, formRules });
    assert.equal(failed.source, 'deterministic');
    assert.equal(stableState(store.get()), before);
    assert.match(failed.error, /model unavailable/);

    const aborted = createStorylineTracker({
        runner: { runAgent: async () => { throw new AgentAbortedError('chat changed'); } },
        getSettings: () => ({}),
    });
    await assert.rejects(
        () => aborted.run({ state: store.get(), season: seasons.s1, formRules }),
        (error) => error instanceof AgentAbortedError,
    );
    assert.equal(stableState(store.get()), before);
});

test('a tracker pass merges deterministic and agent events', async () => {
    const store = makeStore('s1');
    const state = apply(store, [{
        type: 'ADD_EVENT',
        summary: 'The arms deal is signed.',
        actors: [],
        locationId: 'central-plaza',
        tags: ['arms-deal'],
    }]);
    const tracker = createStorylineTracker({
        runner: {
            runAgent: async () => ({
                ...emptyResult,
                threats: [{ id: 's1.threat.clarity', progressDelta: 4 }],
                events: [{ summary: 'Clarity makes a move.', tags: ['clarity-move'] }],
            }),
        },
        getSettings: () => ({}),
    });
    const result = await tracker.run({ state, season: seasons.s1, formRules });
    assert.equal(result.source, 'agent');
    assert.ok(result.events.some((event) => event.type === 'RESOLVE_BEAT'));
    assert.ok(result.events.some((event) => event.type === 'ADVANCE_THREAT'));
});

test('cadence honors everyNTurns, location changes, and disabling', () => {
    const store = makeStore('s1');
    const state = store.get();
    const settings = {
        agents: {
            storyline: {
                enabled: true,
                cadence: 'everyNTurns',
                everyNTurns: 6,
                onLocationChange: true,
            },
        },
    };
    assert.equal(shouldRunStoryline({ state, settings, trigger: 'turn' }).run, true);
    assert.equal(shouldRunStoryline({ state, settings, trigger: 'location' }).run, true);

    const atZero = apply(store, [{ type: 'TICK_TIME', turns: 6 }]);
    const marked = {
        ...atZero,
        flags: { ...(atZero.flags ?? {}), storyline: { lastRunTurn: 6 } },
    };
    assert.equal(shouldRunStoryline({ state: marked, settings, trigger: 'turn' }).run, false);
    assert.equal(shouldRunStoryline({ state: marked, settings, trigger: 'turn', turn: 12 }).run, true);
    assert.equal(shouldRunStoryline({
        state: marked,
        settings: { agents: { storyline: { enabled: false } } },
        trigger: 'turn',
    }).run, false);

    assert.deepEqual(getAgentCadence(settings, 'storyline'), {
        enabled: true,
        cadence: 'everyNTurns',
        everyNTurns: 6,
        onLocationChange: true,
    });
});

test('initiative applies events atomically and persists the cadence marker', async () => {
    const store = makeStore('s1');
    const storyline = {
        run: async () => ({
            events: [
                { type: 'ADVANCE_THREAT', threatId: 's1.threat.clarity', amount: 5 },
                { type: 'ADD_EVENT', summary: 'A quiet escalation.', actors: [], tags: ['quiet'] },
            ],
            source: 'agent',
            act: 'opening',
            notes: [],
            rejected: [],
        }),
    };
    const initiative = createInitiative({
        store,
        season: seasons.s1,
        registry,
        formGroups,
        formRules,
        storyline,
        getSettings: () => ({}),
        now: () => NOW,
    });
    const result = await initiative.runStoryline({ force: true });
    assert.equal(result.ran, true);
    assert.equal(result.state.flags.storyline.lastRunTurn, 0);
    assert.equal(result.state.flags.storyline.lastSource, 'agent');
    assert.ok(result.state.threats.find((threat) => threat.id === 's1.threat.clarity').progress > 0);

    // Force an invalid batch: nothing is applied.
    const snapshot = stableState(store.get());
    const failed = applyEventBatch(store, [
        { type: 'MOVE_CHARACTER', characterId: 's1.vaiva.colorgarde', locationId: 'central-plaza' },
        { type: 'MOVE_CHARACTER', characterId: 's1.vaiva.colorgarde', locationId: 'nowhere' },
    ], { context: CONTEXT, log: () => {} });
    assert.equal(failed.ok, false);
    assert.equal(stableState(store.get()), snapshot);
    assert.ok(result.state.threats.find((threat) => threat.id === 's1.threat.clarity').progress > 0);
});

test('the travel hook notifies the initiative after a scene change', async () => {
    const store = makeStore('s1');
    let afterLocationCall = null;
    const hook = createTravelInitiativeHook({
        initiative: {
            afterLocationChange: async (options) => {
                afterLocationCall = options;
                return { ran: true, source: 'agent' };
            },
        },
    });
    const context = buildTravelInitiativeContext({
        from: 'central-plaza',
        to: 'harbor',
        path: ['central-plaza', 'harbor'],
        bridges: ['bridge-a'],
        distance: 500,
    });
    assert.equal(context.crossRegion, true);
    const result = await hook.afterTravel(context);
    assert.equal(result.ran, true);
    assert.equal(afterLocationCall.from, 'central-plaza');
    assert.equal(afterLocationCall.to, 'harbor');
});

test('the auditor flags a beat narrated in prose but never recorded', async () => {
    const store = makeStore('s1');
    const auditor = createAuditor({ getSettings: () => ({}) });
    const result = await auditor.run({
        state: store.get(),
        season: seasons.s1,
        recentProse: 'The Illegal Arms Deal is signed in the back room while the city sleeps.',
    });
    assert.equal(result.source, 'deterministic');
    assert.ok(result.findings.some(
        (entry) => entry.code === 'unrecorded-beat'
            && entry.referenceId === 's1.opening.arms-deal',
    ));
});

test('the auditor flags a recorded beat without supporting events', async () => {
    const store = makeStore('s1');
    const state = apply(store, [{
        type: 'RESOLVE_BEAT',
        beatId: 's1.opening.arms-deal',
        reason: 'recorded elsewhere',
    }]);
    const auditor = createAuditor({ getSettings: () => ({}) });
    const result = await auditor.run({ state, season: seasons.s1 });
    assert.ok(result.findings.some(
        (entry) => entry.code === 'unsupported-beat'
            && entry.referenceId === 's1.opening.arms-deal',
    ));
});

test('replaying the same deterministic event log produces the same state', () => {
    const store = makeStore('s1');
    const late = apply(store, [{ type: 'TICK_TIME', turns: 30 }]);
    const plan = planDeterministicStoryline({
        state: late,
        season: seasons.s1,
        pressure: 'standard',
    });
    const first = applyWorldEvents(late, plan.events, CONTEXT);
    const second = applyWorldEvents(late, plan.events, CONTEXT);
    assert.equal(stableState(first), stableState(second));
    assert.ok(plan.events.length > 0);
});

test('architect output becomes placements, agendas, headlines, and framing', () => {
    const store = makeStore('s1');
    const state = store.get();
    const result = normalizeArchitectResult({
        result: {
            placements: [{
                characterId: 's1.vaiva.colorgarde',
                locationId: 'central-plaza',
                reason: 'Opening scene',
            }],
            agendas: [{
                characterId: 's1.vaiva.colorgarde',
                agenda: 'Recover the stolen shipment',
                goals: ['Find the dealer'],
            }],
            headlines: [{ summary: 'A shipment vanishes.', headline: 'Shipment Lost' }],
            framing: 'Rain hammers Central Plaza.',
            rationale: 'Sets up the opening beat.',
        },
        state,
        season: seasons.s1,
    });
    assert.equal(result.rejected.length, 0);
    assert.ok(result.events.some((event) => event.type === 'MOVE_CHARACTER'));
    assert.ok(result.events.some((event) => event.type === 'SET_CHARACTER_FIELDS'));
    assert.ok(result.events.some((event) => event.type === 'ADD_EVENT'));
    assert.ok(result.events.some((event) => event.type === 'SET_SCENE_FRAMING'));

    const next = applyWorldEvents(state, result.events, CONTEXT);
    assert.equal(next.characters['s1.vaiva.colorgarde'].locationId, 'central-plaza');
    assert.equal(next.characters['s1.vaiva.colorgarde'].agenda, 'Recover the stolen shipment');
    assert.equal(next.scene.framing, 'Rain hammers Central Plaza.');

    assert.equal(validateJsonSchema({
        placements: [],
        agendas: [],
        headlines: [],
        framing: '',
        rationale: '',
    }, ARCHITECT_SCHEMA).ok, true);
});

test('architect rejects player placements and never calls a disabled agent', async () => {
    const store = makeStore('s1dark', {
        identity: 'canon',
        characterId: 's1dark.carol.bleeding-heart',
    });
    const state = store.get();
    const rejected = normalizeArchitectResult({
        result: {
            placements: [{
                characterId: 's1dark.carol.bleeding-heart',
                locationId: 'central-plaza',
                reason: 'Move the villain',
            }],
            agendas: [],
            headlines: [],
            framing: '',
            rationale: '',
        },
        state,
        season: seasons.s1dark,
    });
    assert.equal(rejected.events.length, 0);
    assert.equal(rejected.rejected[0].reason, 'player-controlled');

    let calls = 0;
    const architect = createArchitect({
        runner: { runAgent: async () => { calls += 1; return {}; } },
        getSettings: () => ({ agents: { architect: { enabled: false } } }),
    });
    const result = await architect.run({ state, season: seasons.s1dark });
    assert.equal(calls, 0);
    assert.equal(result.source, 'deterministic');
    assert.match(buildArchitectPrompt({ state, season: seasons.s1dark }), /Architect/);

    const aborted = createArchitect({
        runner: { runAgent: async () => { throw new AgentAbortedError('chat changed'); } },
        getSettings: () => ({}),
    });
    await assert.rejects(
        () => aborted.run({ state, season: seasons.s1dark }),
        (error) => error instanceof AgentAbortedError,
    );
});

test('an event and its beat resolve in the same agent response', () => {
    const store = makeStore('s1');
    const normalized = normalizeStorylineResult({
        result: {
            ...emptyResult,
            events: [{
                summary: 'The arms deal is signed.',
                tags: ['arms-deal'],
            }],
            beats: [{
                id: 's1.opening.arms-deal',
                action: 'resolve',
                reason: 'The deal happened on screen.',
            }],
        },
        state: store.get(),
        season: seasons.s1,
        formRules,
    });
    assert.equal(normalized.rejected.length, 0);
    assert.ok(normalized.events.some((event) => event.type === 'ADD_EVENT'));
    assert.ok(normalized.events.some((event) => event.type === 'RESOLVE_BEAT'));
});
