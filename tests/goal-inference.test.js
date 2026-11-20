import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GOAL_INFERENCE_SCHEMA,
    buildGoalInferencePrompt,
    createGoalInference,
    ensurePlayerGoals,
    validateGoalInference,
} from '../src/agents/goal-inference.js';

const CHARACTER_ID = 'test.hero';
const VALID_GOALS = [
    'Secure the docks before the rival crew arrives',
    'Find her missing sister',
    'Break the family curse',
];
const SETTINGS = {
    agents: {
        goalInference: { enabled: true, model: 'test-model', timeoutMs: 20000 },
    },
};

function character(overrides = {}) {
    return {
        charId: CHARACTER_ID,
        formId: CHARACTER_ID,
        displayName: 'Test Hero',
        side: 'hero',
        agenda: 'Protect the docks',
        locationId: null,
        goals: [],
        goalsSource: 'card',
        ...overrides,
    };
}

function makeStore({ goals = [], goalsSource = 'card', flags = {} } = {}) {
    let state = {
        characters: { [CHARACTER_ID]: character({ goals, goalsSource }) },
        scene: { locationId: null, present: [] },
        locations: {},
        flags: { ...flags },
        recentEvents: [],
        player: { identity: 'canon', characterId: CHARACTER_ID },
    };
    const events = [];
    function dispatch(event) {
        events.push(event);
        if (event.type === 'SET_CHARACTER_FIELDS') {
            const current = state.characters[event.characterId];
            state = {
                ...state,
                characters: {
                    ...state.characters,
                    [event.characterId]: {
                        ...current,
                        goals: event.goals.slice(),
                        goalsSource: event.goalsSource === 'card' ? 'card' : 'live',
                    },
                },
            };
        }
        return state;
    }
    return {
        events,
        get: () => state,
        dispatch,
        replace(next) {
            state = next;
            return state;
        },
    };
}

function makeRunner(handler) {
    const calls = [];
    return {
        calls,
        async runAgent(request) {
            calls.push(request);
            return handler(request);
        },
    };
}

function validRunner(goals = VALID_GOALS) {
    return makeRunner(() => ({ value: { goals, rationale: 'Grounded in the card.' } }));
}

test('validateGoalInference accepts a grounded draft and rejects bad shapes', () => {
    const ok = validateGoalInference({ goals: VALID_GOALS, rationale: 'Because.' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.goals, VALID_GOALS);
    assert.equal(ok.rationale, 'Because.');

    assert.equal(validateGoalInference(null).ok, false);
    assert.equal(validateGoalInference({ goals: 'nope', rationale: '' }).ok, false);
    assert.equal(validateGoalInference({ goals: VALID_GOALS.slice(0, 1), rationale: '' }).ok, false);
    assert.equal(validateGoalInference({ goals: [null, '', 'ab'], rationale: '' }).ok, false);
});

test('run performs one grounded request and returns the validated goals', async () => {
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await goalInference.run({
        state: makeStore().get(),
        season: { title: 'Season', premise: 'A city of masks.' },
        character: character(),
        profile: { goals: [], background: 'She wants to rule the docks.', identity: '' },
        recentScene: [],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.goals, VALID_GOALS);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].agentId, 'goalInference');
    assert.equal(runner.calls[0].schema, GOAL_INFERENCE_SCHEMA);
});

test('ensurePlayerGoals dispatches once and records the inference flag', async () => {
    const store = makeStore();
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [], background: '', identity: '' } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
        now: () => 1234,
    });
    assert.equal(result.ok, true);
    assert.equal(result.inferred, true);
    assert.equal(runner.calls.length, 1);
    const state = store.get();
    assert.deepEqual(state.characters[CHARACTER_ID].goals, VALID_GOALS);
    assert.equal(state.characters[CHARACTER_ID].goalsSource, 'live');
    assert.deepEqual(state.flags.goalInference, {
        characterId: CHARACTER_ID,
        at: 1234,
        source: 'ai',
        model: 'test-model',
        goals: VALID_GOALS,
    });
    assert.equal(store.events.filter((event) => event.type === 'SET_CHARACTER_FIELDS').length, 1);
});

test('an invalid draft leaves goals untouched and returns ok:false', async () => {
    const store = makeStore();
    const runner = makeRunner(() => ({ value: { goals: ['Too few'], rationale: '' } }));
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const runResult = await goalInference.run({ character: character(), profile: {} });
    assert.equal(runResult.ok, false);

    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, []);
    assert.equal(store.get().characters[CHARACTER_ID].goalsSource, 'card');
});

test('a transport failure never throws and leaves goals untouched', async () => {
    const store = makeStore();
    const runner = makeRunner(() => {
        throw new Error('network down');
    });
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /network down/);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, []);
    assert.equal(store.get().characters[CHARACTER_ID].goalsSource, 'card');
});

test('the card is parsed deterministically and never calls the runner', async () => {
    const store = makeStore();
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: ['Rule the docks'] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'card');
    assert.equal(result.inferred, false);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, ['Rule the docks']);
    assert.equal(store.get().characters[CHARACTER_ID].goalsSource, 'card');
});

test('a tracker-owned list is never overwritten', async () => {
    const store = makeStore({ goals: ['Tracker goal'], goalsSource: 'live' });
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'live');
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, ['Tracker goal']);
});

test('a tracker-owned list outranks usable card goals', async () => {
    const store = makeStore({ goals: ['Tracker goal'], goalsSource: 'live' });
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: ['Card goal'] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'live');
    assert.equal(result.inferred, false);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, ['Tracker goal']);
});

test('force re-runs only an AI-inferred list, never a tracker rewrite', async () => {
    const inferredGoals = ['Inferred one', 'Inferred two', 'Inferred three'];
    const flagged = {
        goalInference: {
            characterId: CHARACTER_ID,
            at: 1,
            source: 'ai',
            model: 'test-model',
            goals: inferredGoals,
        },
    };
    const aiStore = makeStore({ goals: inferredGoals, goalsSource: 'live', flags: flagged });
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const reRun = await ensurePlayerGoals({
        store: aiStore,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
        force: true,
    });
    assert.equal(reRun.inferred, true);
    assert.equal(runner.calls.length, 1);

    const trackerStore = makeStore({
        goals: ['Tracker wrote this'],
        goalsSource: 'live',
        flags: flagged,
    });
    const blocked = await ensurePlayerGoals({
        store: trackerStore,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
        force: true,
    });
    assert.equal(blocked.inferred, false);
    assert.equal(blocked.source, 'live');
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(trackerStore.get().characters[CHARACTER_ID].goals, ['Tracker wrote this']);
});

test('a disabled agent makes no call and leaves goals untouched', async () => {
    const store = makeStore();
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const disabled = { agents: { goalInference: { enabled: false } } };
    const result = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: disabled,
        characterId: CHARACTER_ID,
    });
    assert.equal(result.ok, false);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(store.get().characters[CHARACTER_ID].goals, []);
});

test('one inference per identity change; force bypasses the flag guard', async () => {
    const flagged = {
        goalInference: { characterId: CHARACTER_ID, at: 1, source: 'ai', model: 'test-model' },
    };
    const store = makeStore({ goals: [], goalsSource: 'card', flags: flagged });
    const runner = validRunner();
    const goalInference = createGoalInference({ runner, getSettings: () => SETTINGS });
    const skipped = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
    });
    assert.equal(skipped.cached, true);
    assert.equal(runner.calls.length, 0);

    const forced = await ensurePlayerGoals({
        store,
        profiles: { [CHARACTER_ID]: { goals: [] } },
        goalInference,
        settings: SETTINGS,
        characterId: CHARACTER_ID,
        force: true,
    });
    assert.equal(forced.inferred, true);
    assert.equal(runner.calls.length, 1);
});

test('the prompt is grounded and carries no injected gate block', () => {
    const prompt = buildGoalInferencePrompt({
        state: {
            scene: { locationId: 'docks', present: [CHARACTER_ID] },
            locations: { docks: { name: 'The Docks' } },
            characters: { [CHARACTER_ID]: character() },
        },
        season: { title: 'Season Two', premise: 'A city of masks.' },
        character: character({ displayName: 'Leila Renya' }),
        profile: { goals: [], background: 'She wants to rule the docks.', identity: 'Public' },
        recentScene: [{ summary: 'A tense meeting at the docks.' }],
    });
    assert.match(prompt, /Leila Renya/);
    assert.match(prompt, /She wants to rule the docks\./);
    assert.match(prompt, /Season Two/);
    assert.doesNotMatch(prompt, /\[NEOTERRA_/);
    assert.match(prompt, /3 to 5/);
});
