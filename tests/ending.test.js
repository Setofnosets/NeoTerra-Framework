import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    EPILOGUE_SCHEMA,
    buildDeterministicEpilogue,
    buildEpiloguePrompt,
    createEpilogueAgent,
    normalizeEpilogueResult,
} from '../src/agents/epilogue.js';
import {
    buildPostVictoryState,
    createEndingFlow,
    isEndingScreenActive,
    isJoinVillainAvailable,
    listEndingChoices,
    shouldTriggerEnding,
} from '../src/flows/ending.js';
import { createWorldStateStore } from '../src/state/store.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { validateJsonSchema } from '../src/agents/client.js';
import { validateWorldState } from '../src/state/world-state.js';
import { buildEndingView, renderEndingMarkup } from '../src/ui/ending.js';

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
const CONTEXT = { registry, factions, locations, formGroups, formRules };
const season = readJson('data/seasons/s1.json');

function makeStore({ player = { identity: 'custom' }, seasonId = 's1' } = {}) {
    const metadata = {};
    const chatId = `ending-test-${seasonId}`;
    const store = createWorldStateStore({
        metadata,
        chatId,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    const seasonDoc = seasonId === 's1' ? season : readJson(`data/seasons/${seasonId}.json`);
    store.seed({
        season: seasonDoc,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId,
        player,
        now: NOW,
    });
    return store;
}

function setDeadline(store, turn = 100) {
    const state = structuredClone(store.get());
    state.meta.turn = turn;
    state.meta.inGameDate = '2041-01-01';
    store.replace(state);
}

function settingsFor(overrides = {}) {
    return {
        contentGate: 'full',
        contentLimits: {},
        ending: { paragraphs: 5, prompt: '' },
        agents: { epilogue: { enabled: true } },
        ...overrides,
    };
}

function makeFlow(store, settings = settingsFor(), seasonDoc = season, agent = null) {
    return createEndingFlow({
        store,
        agent: agent ?? createEpilogueAgent({ getSettings: () => settings }),
        season: seasonDoc,
        getSettings: () => settings,
        context: CONTEXT,
        log: () => {},
        now: () => NOW,
    });
}

test('the final deadline triggers the ending exactly once', async () => {
    const store = makeStore();
    setDeadline(store);
    const flow = makeFlow(store);

    assert.equal(shouldTriggerEnding({ state: store.get(), season }), true);
    const first = await flow.trigger({});
    assert.equal(first.triggered, true);
    assert.equal(first.alreadyFired, false);

    const state = store.get();
    assert.equal(state.ending.status, 'epilogue');
    assert.equal(state.ending.firedTurn, 100);
    assert.equal(state.ending.epilogueText.split(/\n{2,}/).length, 5);
    assert.match(state.ending.epilogueText, /Clarity Incorporated/);
    assert.match(state.ending.epilogueText, /The Player/);
    const fateNames = Object.values(state.characters)
        .filter((character) => character.controlledBy !== 'player')
        .map((character) => character.displayName);
    assert.ok(fateNames.filter((name) => state.ending.epilogueText.includes(name)).length >= 2);
    assert.ok(state.recentEvents.some((event) => event.tags.includes('epilogue')));

    const second = await flow.trigger({});
    assert.equal(second.triggered, false);
    assert.equal(second.alreadyFired, true);
    assert.equal(store.get().ending.epilogueText, state.ending.epilogueText);
});

test('a terminal main threat triggers the ending even before the deadline', () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    const main = state.threats.find((threat) => threat.rank === 'main');
    main.stage = main.stages.length - 1;
    store.replace(state);
    assert.equal(shouldTriggerEnding({ state: store.get(), season }), true);
});

test('ending choices are state-aware for heroes, coerced heroes, and brainwashed players', () => {
    const heroStore = makeStore();
    const hero = listEndingChoices({ state: heroStore.get(), season });
    assert.equal(hero.resistance.available, true);
    assert.equal(hero['join-villain'].available, false);
    assert.equal(hero.end.available, true);

    const coercedStore = makeStore();
    const coerced = structuredClone(coercedStore.get());
    coerced.flags.coercedHero = true;
    coercedStore.replace(coerced);
    assert.equal(isJoinVillainAvailable(coercedStore.get()), true);
    assert.equal(listEndingChoices({ state: coercedStore.get(), season })['join-villain'].available, true);

    const brainwashedStore = makeStore();
    const brainwashed = structuredClone(brainwashedStore.get());
    brainwashed.flags.brainwashed = true;
    brainwashedStore.replace(brainwashed);
    const choices = listEndingChoices({ state: brainwashedStore.get(), season });
    assert.equal(choices['join-villain'].available, true);
    assert.equal(choices.resistance.available, false);
});

test('Resistance produces a valid post-victory state with new beats and no orphaned threats', async () => {
    const store = makeStore();
    setDeadline(store);
    const flow = makeFlow(store);
    await flow.trigger({});

    const result = flow.choosePath('resistance');
    assert.equal(result.arc, 'post-victory');
    const state = result.state;
    const validation = validateWorldState(state);
    assert.deepEqual(validation.errors, []);
    assert.equal(state.ending.status, 'continued');
    assert.equal(state.ending.path, 'resistance');
    assert.ok(state.postVictoryBeats.length >= 2);
    assert.ok(state.postVictoryBeats.every((beat) => state.beats[beat.id]?.status === 'open'));
    assert.ok(state.postVictoryBeats.every((beat) => beat.deadlineTurns > 100));
    assert.ok(state.threats.length > 0);
    assert.ok(state.threats.every((threat) => typeof threat.sourceFactionId === 'string'));
    assert.equal(state.threats.filter((threat) => threat.status === 'active').length, 1);
    assert.equal(
        state.threats.find((threat) => threat.id === 's1.post.victor')?.name,
        'Clarity Incorporated Regime',
    );
    assert.ok(state.recentEvents.some((event) => event.tags.includes('resistance')));
    assert.deepEqual(state.player.goals, [
        'Build the resistance',
        'Sabotage the victor\'s regime',
        'Liberate Neo Terra',
    ]);
});

test('Join the villain works for a brainwashed hero and opens the conquest track', async () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    state.meta.turn = 100;
    state.meta.inGameDate = '2041-01-01';
    state.flags.brainwashed = true;
    store.replace(state);
    const flow = makeFlow(store);
    await flow.trigger({});

    const result = flow.choosePath('join-villain');
    assert.equal(validateWorldState(result.state).ok, true);
    assert.equal(result.state.ending.path, 'join-villain');
    assert.equal(result.state.player.goals[0], 'Serve the victor');
    assert.equal(result.state.player.allegiance, 'villain');
    assert.equal(result.state.flags.postVictory.conquest.goal, 'Conquer the neighbouring districts and city.');
    assert.ok(Object.keys(result.state.flags.postVictory.conquest.occupation).length > 0);
    const resistanceThreat = result.state.threats.find((threat) => threat.id === 's1.post.resistance');
    assert.ok(resistanceThreat);
    assert.equal(resistanceThreat.status, 'active');
    const faction = result.state.factions[resistanceThreat.sourceFactionId];
    assert.ok(faction);
});

test('End here leaves the world viewable and inert', async () => {
    const store = makeStore();
    setDeadline(store);
    const flow = makeFlow(store);
    await flow.trigger({});
    const before = structuredClone(store.get());

    const result = flow.choosePath('end');
    assert.equal(result.state.ending.status, 'ended');
    assert.equal(result.state.arc, 'season');
    assert.deepEqual(result.state.flags.postVictory ?? null, before.flags.postVictory ?? null);
    assert.deepEqual(result.state.beats, before.beats);
    assert.equal(isEndingScreenActive(result.state), true);
});

test('unavailable paths are rejected and an ended season must be continued first', async () => {
    const heroStore = makeStore();
    setDeadline(heroStore);
    const heroFlow = makeFlow(heroStore);
    await heroFlow.trigger({});
    assert.throws(() => heroFlow.choosePath('join-villain'), /not available/);
    assert.throws(() => heroFlow.choosePath('nonsense'), /Invalid ending path/);

    const endedStore = makeStore();
    setDeadline(endedStore);
    const endedFlow = makeFlow(endedStore);
    await endedFlow.trigger({});
    endedFlow.choosePath('end');
    assert.throws(() => endedFlow.choosePath('resistance'), /epilogue ending/);
});

test('combat is ended cleanly when the ending fires', async () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    state.meta.turn = 100;
    state.meta.inGameDate = '2041-01-01';
    state.meta.inCombat = true;
    state.scene.combat = {
        locationId: state.scene.locationId,
        participants: state.scene.present.slice(),
        kind: 'skirmish',
        startedTurn: 90,
    };
    store.replace(state);
    const flow = makeFlow(store);
    await flow.trigger({});
    assert.equal(store.get().meta.inCombat, false);
    assert.equal(store.get().scene.combat, null);
});

test('the epilogue agent response is schema-valid and normalized', () => {
    const store = makeStore();
    const state = store.get();
    const response = {
        epilogueText: 'Clarity Incorporated wins the season and the city bends toward its new order.\n\nThis paragraph describes how the victory arrived and what it cost the cast.\n\nThe player survives with a status the ending screen can display.',

        victor: 'Clarity Incorporated',
        playerStatus: 'The Player is free but hunted.',
        castFates: [{ characterId: 's1.vaiva.colorgarde', fate: 'Vaiva goes underground.' }],
    };
    assert.equal(validateJsonSchema(response, EPILOGUE_SCHEMA).ok, true);
    const normalized = normalizeEpilogueResult({
        result: response,
        state,
        season,
        paragraphs: 5,
    });
    assert.equal(normalized.source, 'agent');
    assert.equal(normalized.victor, 'Clarity Incorporated');
    assert.equal(normalized.castFates.length, 1);
    assert.match(buildEpiloguePrompt({ state, season, settings: settingsFor() }), /exactly 5 paragraphs/);
});

test('the deterministic epilogue honours the configured paragraph count', () => {
    const store = makeStore();
    for (const paragraphs of [3, 5, 8]) {
        const text = buildDeterministicEpilogue({ state: store.get(), season, paragraphs });
        const parts = text.split(/\n{2,}/);
        assert.equal(parts.length, paragraphs);
    }
});

test('the ending UI renders the epilogue and only available choices', () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    state.ending = {
        status: 'epilogue',
        firedTurn: 12,
        epilogueText: 'First paragraph.\n\nSecond paragraph.',
        victor: 'Clarity Incorporated',
        source: 'agent',
    };
    store.replace(state);
    const view = buildEndingView({ state: store.get(), season, settings: settingsFor() });
    assert.equal(view.showChoices, true);
    assert.equal(view.choices['join-villain'].available, false);
    const markup = renderEndingMarkup(view);
    assert.match(markup, /First paragraph/);
    assert.match(markup, /Resistance/);
    assert.match(markup, /disabled/);
});

test('concurrent trigger calls share one epilogue and one journal entry', async () => {
    const store = makeStore();
    setDeadline(store);
    let calls = 0;
    const agent = {
        run: async ({ paragraphs }) => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return {
                epilogueText: Array.from({ length: paragraphs }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n'),
                victor: 'Clarity Incorporated',
                playerStatus: 'Free but hunted.',
                castFates: [],
                paragraphs,
                source: 'agent',
            };
        },
    };
    const flow = makeFlow(store, settingsFor(), season, agent);
    const [first, second] = await Promise.all([flow.trigger({}), flow.trigger({})]);
    assert.equal(first.triggered, true);
    assert.equal(second.triggered, true);
    assert.equal(calls, 1);
    assert.equal(
        store.get().recentEvents.filter((event) => event.tags.includes('epilogue')).length,
        1,
    );
});

test('the reducer enforces resistance availability for a mind-overwritten player', () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    state.ending = { status: 'epilogue', firedTurn: 5, epilogueText: 'Ending.' };
    state.flags.brainwashed = true;
    store.replace(state);
    assert.throws(
        () => applyWorldEvent(store.get(), { type: 'CHOOSE_ENDING_PATH', path: 'resistance' }, CONTEXT),
        /not available/,
    );
    const next = applyWorldEvent(
        store.get(),
        { type: 'CHOOSE_ENDING_PATH', path: 'join-villain' },
        CONTEXT,
    );
    assert.equal(next.ending.path, 'join-villain');
});

test('the conquest track updates occupation state per chat', async () => {
    const store = makeStore();
    const state = structuredClone(store.get());
    state.meta.turn = 100;
    state.meta.inGameDate = '2041-01-01';
    state.flags.brainwashed = true;
    store.replace(state);
    const flow = makeFlow(store);
    await flow.trigger({});
    const joined = flow.choosePath('join-villain');
    const target = joined.state.flags.postVictory.conquest.targets[0];
    assert.equal(joined.state.flags.postVictory.conquest.occupation[target], 'occupied');

    const updated = flow.setOccupation({ locationId: target, status: 'liberated' });
    assert.equal(updated.state.flags.postVictory.conquest.occupation[target], 'liberated');
    assert.equal(validateWorldState(updated.state).ok, true);
});

test('buildPostVictoryState is pure and rejects unknown paths', () => {
    const store = makeStore();
    const before = structuredClone(store.get());
    const state = structuredClone(before);
    state.ending = { status: 'continued', path: 'resistance', firedTurn: 1 };
    state.arc = 'post-victory';
    const next = buildPostVictoryState({ state, season, path: 'resistance' });
    assert.equal(state.threats.length, before.threats.length);
    assert.equal(next.threats.length, before.threats.length + 1);
    assert.throws(() => buildPostVictoryState({ state, season, path: 'end' }), /Unknown post-victory path/);
});
