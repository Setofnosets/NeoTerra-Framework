import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEndingFlow } from '../src/flows/ending.js';
import { createWorldStateStore } from '../src/state/store.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';

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
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore() {
    const store = createWorldStateStore({
        metadata: {},
        chatId: 'ending-pilot-test-chat',
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
        chatId: 'ending-pilot-test-chat',
        player: { identity: 'custom', displayName: 'Alex' },
        now: NOW,
    });
    return store;
}

function setPastDeadline(store) {
    const state = structuredClone(store.get());
    state.meta.turn = 100;
    state.meta.inGameDate = '2041-01-01';
    store.replace(state);
}

function settings(overrides = {}) {
    return {
        contentGate: 'full',
        contentLimits: {},
        ending: { paragraphs: 4, prompt: '', dynamic: false, ...(overrides.ending ?? {}) },
        agents: { epilogue: { enabled: true }, ...(overrides.agents ?? {}) },
    };
}

function makeFlow(store, settingsDoc, agent) {
    return createEndingFlow({
        store,
        agent,
        season,
        getSettings: () => settingsDoc,
        context: CONTEXT,
        log: () => {},
        now: () => NOW,
    });
}

test('dynamic ending prose is off by default', () => {
    assert.equal(DEFAULT_SETTINGS.ending.dynamic, false);
});

test('the default deterministic epilogue uses the season-specific template', async () => {
    const store = makeStore();
    setPastDeadline(store);
    let calls = 0;
    const flow = makeFlow(store, settings(), {
        run: async () => {
            calls += 1;
            return { epilogueText: 'Dynamic prose.', source: 'agent' };
        },
    });
    const result = await flow.trigger({});
    assert.equal(result.triggered, true);
    assert.equal(calls, 0);
    assert.equal(store.get().ending.dynamic, false);
    assert.equal(store.get().ending.reviewRequired, false);
    assert.match(store.get().ending.epilogueText, /owns Neo Terra now/);
    assert.match(store.get().ending.epilogueText, /Clarity|Clarity Mandate/);
    assert.equal(store.get().ending.epilogueText.split(/\n{2,}/).length, 4);
});

test('ending.dynamic calls the Epilogue agent once and marks reviewRequired', async () => {
    const store = makeStore();
    setPastDeadline(store);
    let calls = 0;
    const flow = makeFlow(store, settings({ ending: { dynamic: true, paragraphs: 4 } }), {
        run: async ({ paragraphs }) => {
            calls += 1;
            return {
                epilogueText: Array.from({ length: paragraphs }, (_, index) => `Dynamic ${index + 1}.`).join('\n\n'),
                victor: 'The Clarity Mandate',
                playerStatus: 'Free but hunted.',
                castFates: [],
                paragraphs,
                source: 'agent',
            };
        },
    });
    await flow.trigger({});
    assert.equal(calls, 1);
    assert.equal(store.get().ending.dynamic, true);
    assert.equal(store.get().ending.reviewRequired, true);
    assert.equal(store.get().ending.source, 'agent');
    assert.match(store.get().ending.epilogueText, /Dynamic 1/);

    const stored = store.get().ending.epilogueText;
    await flow.trigger({});
    assert.equal(calls, 1);
    assert.equal(store.get().ending.epilogueText, stored);
});

test('a disabled Epilogue agent falls back to the deterministic template even with ending.dynamic on', async () => {
    const store = makeStore();
    setPastDeadline(store);
    let calls = 0;
    const flow = makeFlow(store, settings({
        ending: { dynamic: true },
        agents: { epilogue: { enabled: false } },
    }), {
        run: async () => { calls += 1; return { epilogueText: 'Should not run.' }; },
    });
    await flow.trigger({});
    assert.equal(calls, 0);
    assert.equal(store.get().ending.dynamic, false);
    assert.doesNotMatch(store.get().ending.epilogueText, /Should not run/);
});
