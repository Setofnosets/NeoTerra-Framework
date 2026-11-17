import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BAD_END_EPILOGUE_SCHEMA,
    BAD_END_SCHEMA,
    buildBadEndEpiloguePrompt,
    buildBadEndPrompt,
    createBadEndDetector,
    evaluateBadEndCandidates,
} from '../src/agents/bad-end.js';
import {
    createBadEndFlow,
    listContinuationOptionsFor,
} from '../src/flows/bad-end.js';
import { AgentAbortedError, validateJsonSchema } from '../src/agents/client.js';
import { buildBadEndView, renderBadEndMarkup } from '../src/ui/bad-end.js';
import {
    createWorldStateStore,
    saveWorldStateToMetadata,
} from '../src/state/store.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import {
    DEFAULT_BAD_END_EPILOGUE_PROMPT,
    DEFAULT_BAD_END_PROMPT,
    cloneDefaults,
} from '../src/core/defaults.js';
import { migrateSettings } from '../src/core/migrations.js';
import { defaultPromptFor } from '../src/ui/settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;
const TARGET = 's1.vaiva.colorgarde';
const OTHER = 's1.aurelia.longshot';

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
        chatId: `bad-end-test-${seasonId}`,
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
        chatId: `bad-end-test-${seasonId}`,
        player,
        now: NOW,
    });
    return store;
}

function settingsFor(overrides = {}) {
    const settings = cloneDefaults();
    settings.badEnds.enabled = true;
    Object.assign(settings.badEnds, overrides);
    return settings;
}

function mutate(store, mutator) {
    const next = structuredClone(store.get());
    mutator(next);
    store.replace(next);
    return next;
}

function makeFlow(store, settings, runner = null, detector = null) {
    return createBadEndFlow({
        store,
        detector: detector ?? createBadEndDetector({
            runner,
            getSettings: () => settings,
        }),
        runner,
        getSettings: () => settings,
        season: seasons.s1,
        context: CONTEXT,
        log: () => {},
        now: () => NOW,
    });
}

function setDeath(state, characterId = TARGET) {
    const character = state.characters[characterId];
    character.stamina.current = 0;
    state.flags.lethalIntent = true;
}

function setIdentityLoss(state, characterId = TARGET) {
    const character = state.characters[characterId];
    character.corruption.stage = 3;
    character.status = 'lost';
    state.flags.brainwashed = true;
}

function setAmbiguousAutonomy(state, characterId = TARGET) {
    const character = state.characters[characterId];
    character.status = 'captured';
    character.willpower.current = 5;
}

function journalsFor(store) {
    return store.get().recentEvents.filter((event) => event.tags?.includes('bad-end'));
}

test('the confirmation and epilogue schemas accept their contracts', () => {
    const confirmation = validateJsonSchema({
        confirmed: true,
        characterId: TARGET,
        type: 'death',
        severity: 'major',
        confidence: 0.8,
        cause: 'Stamina reached zero in combat.',
        playableAs: false,
        reversibility: 'none',
        rationale: 'Combat participant with zero stamina.',
    }, BAD_END_SCHEMA);
    assert.equal(confirmation.ok, true, JSON.stringify(confirmation.errors));
    assert.equal(validateJsonSchema({
        confirmed: true,
        type: 'death',
        severity: 'major',
        confidence: 0.8,
        cause: 'Missing character binding.',
        playableAs: false,
        reversibility: 'none',
        rationale: 'No character id.',
    }, BAD_END_SCHEMA).ok, false);

    const epilogue = validateJsonSchema({
        epilogueText: 'x'.repeat(80),
    }, BAD_END_EPILOGUE_SCHEMA);
    assert.equal(epilogue.ok, true, JSON.stringify(epilogue.errors));
});

test('disabled bad ends make zero calls and leave state byte-identical', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const before = structuredClone(store.get());
    let runnerCalls = 0;
    const runner = {
        async runAgent() {
            runnerCalls += 1;
            throw new Error('should never run');
        },
    };
    let proposeCalls = 0;
    const settings = cloneDefaults();
    const detector = createBadEndDetector({
        runner,
        getSettings: () => settings,
    });
    const flow = makeFlow(store, settings, runner, detector);
    const result = await flow.detectAndRecord({
        message: 'They killed her.',
        propose: () => {
            proposeCalls += 1;
        },
    });
    assert.equal(result.enabled, false);
    assert.equal(result.calls, 0);
    assert.deepEqual(result.recorded, []);
    assert.equal(runnerCalls, 0);
    assert.equal(proposeCalls, 0);
    assert.deepEqual(store.get(), before);
});

test('deterministic death records once without an LLM call even when propose is available', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const settings = settingsFor();
    let proposals = 0;
    const detector = createBadEndDetector({ getSettings: () => settings });
    const plan = detector.plan({
        state: store.get(),
        formRules,
        propose: () => {
            proposals += 1;
            return { confirmed: true };
        },
    });
    assert.equal(proposals, 0);
    assert.equal(plan.calls, 0);
    assert.equal(plan.ambiguous.length, 0);
    assert.ok(plan.records.some((entry) => entry.badEndType === 'death'));

    const flow = makeFlow(store, settings);
    const result = await flow.detectAndRecord({ message: '' });
    assert.equal(result.enabled, true);
    assert.equal(result.calls, 0);
    assert.equal(result.recorded.length, 1);
    assert.equal(result.recorded[0].record.type, 'death');
    assert.equal(store.get().characters[TARGET].status, 'dead');
    assert.equal(store.get().characters[TARGET].alive, false);
    assert.equal(store.get().badEnds[TARGET].type, 'death');
    assert.ok(store.get().badEnds[TARGET].epilogueText.length > 0);
    assert.equal(journalsFor(store).length, 1);
});

test('deterministic identity-loss records from max corruption plus brainwashing', async () => {
    const store = makeStore();
    mutate(store, (state) => setIdentityLoss(state));
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    const result = await flow.detectAndRecord({ message: '' });
    assert.equal(result.calls, 0);
    assert.equal(result.recorded.length, 1);
    assert.equal(result.recorded[0].record.type, 'identity-loss');
    assert.equal(store.get().characters[TARGET].status, 'lost');
    assert.equal(store.get().badEnds[TARGET].type, 'identity-loss');
});

test('ambiguous evidence requires confirmation and never records from low confidence or malformed output', async () => {
    const settings = settingsFor();
    const confirmation = {
        confirmed: true,
        characterId: TARGET,
        type: 'autonomy-loss',
        severity: 'major',
        confidence: 0.9,
        cause: 'Captive with almost no willpower remaining.',
        playableAs: true,
        reversibility: 'conditional',
        rationale: 'Partial deterministic evidence.',
    };

    // confirmed: false
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        let calls = 0;
        const runner = {
            async runAgent({ agentId }) {
                calls += 1;
                if (agentId === 'badEnd') {
                    return { value: { ...confirmation, confirmed: false } };
                }
                return { value: { epilogueText: 'Should not be used.' } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(calls, 1);
        assert.equal(result.calls, 1);
        assert.equal(result.ambiguous.length, 1);
        assert.equal(result.recorded.length, 0);
        assert.deepEqual(store.get(), before);
    }

    // low confidence
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        const runner = {
            async runAgent() {
                return { value: { ...confirmation, confidence: 0.1 } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.calls, 1);
        assert.equal(result.recorded.length, 0);
        assert.deepEqual(store.get(), before);
    }

    // confirmed but for the wrong type
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        const runner = {
            async runAgent() {
                return { value: { ...confirmation, type: 'death' } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.calls, 1);
        assert.equal(result.recorded.length, 0);
        assert.deepEqual(store.get(), before);
    }

    // confirmed but for the wrong character
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        const runner = {
            async runAgent() {
                return { value: { ...confirmation, characterId: OTHER } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.calls, 1);
        assert.equal(result.recorded.length, 0);
        assert.deepEqual(store.get(), before);
    }

    // malformed output
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        const runner = {
            async runAgent() {
                return { value: { confirmed: true } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.recorded.length, 0);
        assert.deepEqual(store.get(), before);
    }

    // failed call
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const before = structuredClone(store.get());
        const runner = {
            async runAgent() {
                throw new Error('transport down');
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.recorded.length, 0);
        assert.ok(result.error);
        assert.deepEqual(store.get(), before);
    }

    // confirmed: true
    {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const runner = {
            async runAgent({ agentId }) {
                if (agentId === 'badEnd') {
                    return { value: confirmation };
                }
                return {
                    value: {
                        epilogueText: 'The captive remains behind guarded doors, and the city does not learn her name. '
                            .repeat(2),
                    },
                };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.calls, 2);
        assert.equal(result.recorded.length, 1);
        assert.equal(result.recorded[0].record.type, 'autonomy-loss');
        assert.equal(store.get().badEnds[TARGET].type, 'autonomy-loss');
        assert.equal(store.get().characters[TARGET].status, 'captured');
    }

    // plan() also exposes the propose seam.
    const store = makeStore();
    mutate(store, (state) => setAmbiguousAutonomy(state));
    let proposals = 0;
    const detector = createBadEndDetector({ getSettings: () => settings });
    const plan = detector.plan({
        state: store.get(),
        formRules,
        propose: () => {
            proposals += 1;
            return { confirmed: true, ...confirmation };
        },
    });
    assert.equal(proposals, 1);
    assert.equal(plan.calls, 1);
    assert.ok(plan.records.some((entry) => entry.badEndType === 'autonomy-loss'));
});

test('a confirmed record is stored with a fallback when the epilogue call fails or is invalid', async () => {
    const settings = settingsFor();
    const confirmation = {
        confirmed: true,
        characterId: TARGET,
        type: 'autonomy-loss',
        severity: 'moderate',
        confidence: 0.9,
        cause: 'Captive with almost no willpower remaining.',
        playableAs: true,
        reversibility: 'conditional',
        rationale: 'Partial deterministic evidence.',
    };

    for (const epilogueResponse of ['throw', 'short']) {
        const store = makeStore();
        mutate(store, (state) => setAmbiguousAutonomy(state));
        const runner = {
            async runAgent({ agentId }) {
                if (agentId === 'badEnd') {
                    return { value: confirmation };
                }
                if (epilogueResponse === 'throw') {
                    throw new Error('epilogue transport down');
                }
                return { value: { epilogueText: 'Too short.' } };
            },
        };
        const flow = makeFlow(store, settings, runner);
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.calls, 2);
        assert.equal(result.recorded.length, 1);
        assert.equal(result.recorded[0].record.type, 'autonomy-loss');
        assert.ok(result.recorded[0].record.epilogueText.length > 60);
        assert.match(result.recorded[0].record.epilogueText, /story reaches its end/);
        assert.equal(store.get().badEnds[TARGET].type, 'autonomy-loss');
    }
});

test('a confirmation with an empty cause still records with an evidence-based cause', async () => {
    const settings = settingsFor();
    const store = makeStore();
    mutate(store, (state) => setAmbiguousAutonomy(state));
    const runner = {
        async runAgent({ agentId }) {
            if (agentId === 'badEnd') {
                return {
                    value: {
                        confirmed: true,
                        characterId: TARGET,
                        type: 'autonomy-loss',
                        severity: 'moderate',
                        confidence: 0.9,
                        cause: '   ',
                        playableAs: true,
                        reversibility: 'conditional',
                        rationale: 'Partial deterministic evidence.',
                    },
                };
            }
            return {
                value: {
                    epilogueText: 'The captive remains behind guarded doors, and the city does not learn her name. '
                        .repeat(2),
                },
            };
        },
    };
    const flow = makeFlow(store, settings, runner);
    const result = await flow.detectAndRecord({ message: '' });
    assert.equal(result.recorded.length, 1);
    const record = store.get().badEnds[TARGET];
    assert.equal(record.type, 'autonomy-loss');
    assert.ok(record.cause.length > 0);
    assert.match(record.cause, /Autonomy loss recorded/);
});

test('prose alone never creates a candidate or calls the model', async () => {
    const store = makeStore();
    const before = structuredClone(store.get());
    let calls = 0;
    const runner = {
        async runAgent() {
            calls += 1;
            return { value: { confirmed: true } };
        },
    };
    const settings = settingsFor();
    const flow = makeFlow(store, settings, runner);
    const result = await flow.detectAndRecord({
        message: 'The hero is dead. Someone killed her in the street.',
        recentProse: 'Blood pooled under the body. She dies.',
    });
    assert.equal(calls, 0);
    assert.equal(result.recorded.length, 0);
    assert.equal(result.ambiguous.length, 0);
    const evaluation = evaluateBadEndCandidates({
        state: store.get(),
        message: 'She is dead.',
        recentProse: 'Someone killed her.',
        formRules,
    });
    assert.equal(evaluation.candidates.length, 0);
    assert.equal(evaluation.ambiguous.length, 0);
    assert.deepEqual(store.get(), before);
});

test('running detection twice with the same continuity key records one record and one journal entry', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    const first = await flow.detectAndRecord({ message: '' });
    assert.equal(first.recorded.length, 1);
    assert.equal(journalsFor(store).length, 1);

    const afterFirst = structuredClone(store.get());
    const second = await flow.detectAndRecord({ message: 'She is still dead.' });
    assert.equal(second.recorded.length, 0);
    assert.equal(second.calls, 0);
    assert.deepEqual(store.get(), afterFirst);
    assert.equal(Object.keys(store.get().badEnds).length, 1);
    assert.equal(journalsFor(store).length, 1);
});

test('all six bad-end types have a deterministic case', async () => {
    const cases = [
        ['death', (state) => setDeath(state)],
        ['identity-loss', (state) => setIdentityLoss(state)],
        ['autonomy-loss', (state) => {
            state.characters[TARGET].status = 'captured';
            state.characters[TARGET].willpower.current = 0;
        }],
        ['corruption', (state) => {
            state.characters[TARGET].corruption.stage = 3;
        }],
        ['imprisonment', (state) => {
            state.characters[TARGET].status = 'imprisoned';
        }],
        ['retirement', (state) => {
            state.characters[TARGET].status = 'retired';
        }],
    ];

    for (const [type, mutator] of cases) {
        const store = makeStore();
        mutate(store, mutator);
        const flow = makeFlow(store, settingsFor());
        const result = await flow.detectAndRecord({ message: '' });
        assert.equal(result.recorded.length, 1, `${type}: expected one record`);
        assert.equal(result.recorded[0].record.type, type, `${type}: wrong persisted type`);
        assert.equal(store.get().badEnds[TARGET].type, type, `${type}: wrong state type`);
    }
});

test('continuing as the bad-ended character preserves altered state and gates death continuation', async () => {
    const store = makeStore();
    mutate(store, (state) => {
        setIdentityLoss(state);
        const character = state.characters[TARGET];
        character.goals = ['Serve the new order'];
        character.traits = ['conditioned'];
        character.agenda = 'Obey the handler';
    });
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    await flow.detectAndRecord({ message: '' });

    const continued = flow.continueAsBadEnded({ characterId: TARGET });
    assert.equal(continued.ok, true);
    const state = store.get();
    assert.equal(state.player.identity, 'canon');
    assert.equal(state.player.characterId, TARGET);
    assert.equal(state.characters[TARGET].controlledBy, 'player');
    assert.equal(state.characters[TARGET].status, 'lost');
    assert.deepEqual(state.characters[TARGET].goals, ['Serve the new order']);
    assert.deepEqual(state.characters[TARGET].traits, ['conditioned']);
    assert.equal(state.characters[TARGET].agenda, 'Obey the handler');
    assert.equal(state.badEnds[TARGET].type, 'identity-loss');
    assert.deepEqual(state.flags.badEndContinuation, {
        characterId: TARGET,
        choice: 'self',
        turn: state.meta.turn,
    });

    const deadStore = makeStore();
    mutate(deadStore, (state) => setDeath(state));
    const deadSettings = settingsFor({ allowDeadContinuation: true });
    const deadFlow = makeFlow(deadStore, deadSettings);
    await deadFlow.detectAndRecord({ message: '' });
    assert.equal(deadStore.get().badEnds[TARGET].playableAs, true);

    deadSettings.badEnds.allowDeadContinuation = false;
    const beforeRejection = structuredClone(deadStore.get());
    assert.throws(
        () => deadFlow.continueAsBadEnded({ characterId: TARGET }),
        /dead continuation is not available/,
    );
    assert.deepEqual(deadStore.get(), beforeRejection);

    deadSettings.badEnds.allowDeadContinuation = true;
    const deadContinued = deadFlow.continueAsBadEnded({ characterId: TARGET });
    assert.equal(deadContinued.ok, true);
    assert.equal(deadStore.get().player.identity, 'canon');
    assert.equal(deadStore.get().player.characterId, TARGET);
    assert.equal(deadStore.get().characters[TARGET].status, 'dead');
    assert.equal(deadStore.get().characters[TARGET].controlledBy, 'player');
    assert.equal(deadStore.get().badEnds[TARGET].type, 'death');
});

test('continuing as someone else keeps the old record, relationships, and journal intact', async () => {
    const store = makeStore('s1', { identity: 'canon', characterId: TARGET });
    mutate(store, (state) => {
        setIdentityLoss(state);
    });
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    await flow.detectAndRecord({ message: '' });
    store.dispatch({
        type: 'RELATIONSHIP_DELTA',
        a: TARGET,
        b: OTHER,
        affinityDelta: 20,
        relationshipType: 'ally',
    });
    const recordBefore = structuredClone(store.get().badEnds[TARGET]);
    const relationshipsBefore = structuredClone(store.get().relationships);
    const journalBefore = structuredClone(store.get().recentEvents);

    const switched = flow.continueAsSomeoneElse({ identity: 'canon', characterId: OTHER });
    assert.equal(switched.ok, true);
    assert.equal(store.get().player.identity, 'canon');
    assert.equal(store.get().player.characterId, OTHER);
    assert.equal(store.get().characters[TARGET].controlledBy, 'npc');
    assert.equal(store.get().characters[OTHER].controlledBy, 'player');
    assert.deepEqual(store.get().badEnds[TARGET], recordBefore);
    assert.deepEqual(store.get().relationships, relationshipsBefore);
    assert.deepEqual(store.get().recentEvents, journalBefore);

    const custom = flow.continueAsSomeoneElse({ identity: 'custom', displayName: 'Alex' });
    assert.equal(custom.ok, true);
    assert.equal(store.get().player.identity, 'custom');
    assert.equal(store.get().player.displayName, 'Alex');
    assert.deepEqual(store.get().badEnds[TARGET], recordBefore);
    assert.deepEqual(store.get().relationships, relationshipsBefore);
    assert.deepEqual(store.get().recentEvents, journalBefore);

    const options = listContinuationOptionsFor({
        state: store.get(),
        characterId: TARGET,
        settings,
        registry,
    });
    assert.equal(options.self.available, true);
    assert.equal(options.other.available, true);
    assert.equal(options.end.available, true);
});

test('continuation options exclude unreversed bad-end targets until they are reversed', async () => {
    const store = makeStore();
    const settings = settingsFor();
    store.dispatch({
        type: 'RECORD_BAD_END',
        characterId: OTHER,
        badEndType: 'imprisonment',
        cause: 'Locked away with no escape.',
        epilogueText: 'The cell door closes.',
        playableAs: true,
        continuityKey: `s1:${OTHER}`,
    });

    const before = listContinuationOptionsFor({
        state: store.get(),
        characterId: TARGET,
        settings,
        registry,
    });
    assert.ok(!before.other.characters.some((entry) => entry.characterId === OTHER));

    assert.throws(
        () => applyWorldEvent(store.get(), {
            type: 'CONTINUE_BAD_END',
            action: 'other',
            identity: 'canon',
            characterId: OTHER,
        }, CONTEXT),
        /active bad-end record/,
    );

    const flow = makeFlow(store, settings);
    flow.reverseBadEnd({ characterId: OTHER, reason: 'Released', restoredStatus: 'active' });
    const after = listContinuationOptionsFor({
        state: store.get(),
        characterId: TARGET,
        settings,
        registry,
    });
    assert.ok(after.other.characters.some((entry) => entry.characterId === OTHER));
});

test('end here changes no character and keeps the record', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    await flow.detectAndRecord({ message: '' });
    const before = structuredClone(store.get());
    const result = flow.endHere({ characterId: TARGET });
    assert.equal(result.ended, true);
    assert.equal(result.characterId, TARGET);
    assert.equal(result.record.type, 'death');
    assert.deepEqual(store.get(), before);

    const reduced = applyWorldEvent(store.get(), { type: 'CONTINUE_BAD_END', action: 'end' }, CONTEXT);
    assert.deepEqual(reduced, before);
});

test('declared reversal keeps the historical record and updates status and flags', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    await flow.detectAndRecord({ message: '' });
    const before = structuredClone(store.get().badEnds[TARGET]);

    const reversed = flow.reverseBadEnd({
        characterId: TARGET,
        reason: 'Rescued before brain death',
        restoredStatus: 'active',
    });
    assert.equal(reversed.ok, true);
    const record = store.get().badEnds[TARGET];
    assert.ok(record, 'the historical record is preserved');
    assert.equal(record.type, before.type);
    assert.equal(record.epilogueText, before.epilogueText);
    assert.equal(record.reversed, true);
    assert.equal(record.reversalReason, 'Rescued before brain death');
    assert.equal(record.restoredStatus, 'active');
    assert.equal(store.get().characters[TARGET].status, 'active');
    assert.equal(store.get().characters[TARGET].badEndType, null);
    assert.equal(store.get().characters[TARGET].alive, true);
});

test('edited bad-end prompts persist across reloads and reset helpers restore defaults', () => {
    const edited = migrateSettings({
        schemaVersion: 1,
        badEnds: {
            enabled: true,
            prompt: 'CUSTOM DETECT {{candidates}}',
            epiloguePrompt: 'CUSTOM EPILOGUE {{character}}',
        },
    });
    assert.equal(edited.badEnds.prompt, 'CUSTOM DETECT {{candidates}}');
    assert.equal(edited.badEnds.epiloguePrompt, 'CUSTOM EPILOGUE {{character}}');

    const reloaded = migrateSettings(JSON.parse(JSON.stringify(edited)));
    assert.equal(reloaded.badEnds.prompt, edited.badEnds.prompt);
    assert.equal(reloaded.badEnds.epiloguePrompt, edited.badEnds.epiloguePrompt);

    const store = makeStore();
    const prompt = buildBadEndPrompt({
        state: store.get(),
        message: 'She is dying.',
        recentProse: 'The wound is fatal.',
        candidates: [{ characterId: TARGET, badEndType: 'death' }],
        settings: reloaded,
    });
    assert.match(prompt, /CUSTOM DETECT/);
    assert.match(prompt, new RegExp(TARGET.replaceAll('.', '\\.')));

    const epilogue = buildBadEndEpiloguePrompt({
        state: store.get(),
        record: {
            characterId: TARGET,
            type: 'death',
            cause: 'Zero stamina with lethal intent.',
        },
        settings: reloaded,
    });
    assert.match(epilogue, /CUSTOM EPILOGUE/);

    assert.equal(defaultPromptFor('badEnds.prompt'), DEFAULT_BAD_END_PROMPT);
    assert.equal(defaultPromptFor('badEnds.epiloguePrompt'), DEFAULT_BAD_END_EPILOGUE_PROMPT);
    assert.equal(defaultPromptFor('badEnds.unknown'), null);

    assert.equal(migrateSettings({ schemaVersion: 1, badEnds: { minConfidence: 5 } }).badEnds.minConfidence, 1);
    assert.equal(migrateSettings({ schemaVersion: 1, badEnds: { minConfidence: -2 } }).badEnds.minConfidence, 0);
    assert.equal(migrateSettings({ schemaVersion: 1, badEnds: { minConfidence: 'nope' } }).badEnds.minConfidence, 0.6);
    const preserved = migrateSettings({
        schemaVersion: 1,
        badEnds: { minConfidence: 0.25, customKey: 'keep' },
    });
    assert.equal(preserved.badEnds.minConfidence, 0.25);
    assert.equal(preserved.badEnds.customKey, 'keep');
});

test('JSON export and metadata reload preserve the bad-end record', async () => {
    const store = makeStore();
    mutate(store, (state) => setDeath(state));
    const settings = settingsFor();
    const flow = makeFlow(store, settings);
    await flow.detectAndRecord({ message: '' });
    const state = store.get();
    const record = structuredClone(state.badEnds[TARGET]);

    const metadata = {};
    saveWorldStateToMetadata(metadata, JSON.parse(JSON.stringify(state)), NOW);
    const reloadedStore = createWorldStateStore({
        metadata,
        chatId: state.chatId,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    const reloaded = reloadedStore.get();
    assert.deepEqual(reloaded.badEnds[TARGET], record);
    assert.equal(reloaded.characters[TARGET].status, 'dead');
});

test('the UI view exposes the record, epilogue, and only available continuation choices', async () => {
    const store = makeStore();
    mutate(store, (state) => setIdentityLoss(state));
    store.dispatch({
        type: 'RECORD_BAD_END',
        characterId: TARGET,
        badEndType: 'identity-loss',
        severity: 'major',
        cause: '<script>alert(1)</script>',
        epilogueText: '<b>Ended</b>',
        playableAs: true,
        continuityKey: `s1:${TARGET}`,
    });
    const view = buildBadEndView({
        state: store.get(),
        characterId: TARGET,
        settings: settingsFor(),
    });
    assert.equal(view.available, true);
    assert.equal(view.record.type, 'identity-loss');
    assert.equal(view.epilogueText, '<b>Ended</b>');
    assert.equal(view.badge.type, 'identity-loss');
    assert.equal(view.options.self.available, true);
    assert.equal(view.options.other.available, true);
    assert.equal(view.options.end.available, true);
    assert.ok(view.options.other.characters.some((entry) => entry.characterId === OTHER));
    assert.ok(!view.options.other.characters.some((entry) => entry.characterId === TARGET));

    const markup = renderBadEndMarkup(view);
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(markup, /&lt;b&gt;Ended&lt;\/b&gt;/);
    assert.ok(markup.includes('data-neoterra-bad-end-choice="self"'));
    assert.ok(markup.includes('data-neoterra-bad-end-choice="other"'));
    assert.ok(markup.includes('data-neoterra-bad-end-choice="end"'));

    store.dispatch({
        type: 'RECORD_BAD_END',
        characterId: OTHER,
        badEndType: 'retirement',
        cause: 'Steps away from the fight.',
        epilogueText: 'A quiet retirement.',
        playableAs: true,
        continuityKey: `s1:${OTHER}`,
    });
    const implicitView = buildBadEndView({
        state: store.get(),
        settings: settingsFor(),
    });
    assert.equal(implicitView.characterId, [TARGET, OTHER].sort()[0]);

    const deadStore = makeStore();
    mutate(deadStore, (state) => setDeath(state));
    deadStore.dispatch({
        type: 'RECORD_BAD_END',
        characterId: TARGET,
        badEndType: 'death',
        cause: 'Zero stamina with lethal intent.',
        epilogueText: 'The end.',
        playableAs: false,
        continuityKey: `s1:${TARGET}`,
    });
    const deadView = buildBadEndView({
        state: deadStore.get(),
        characterId: TARGET,
        settings: settingsFor({ allowDeadContinuation: false }),
    });
    assert.equal(deadView.options.self.available, false);
    const deadMarkup = renderBadEndMarkup(deadView);
    assert.ok(!deadMarkup.includes('data-neoterra-bad-end-choice="self"'));
    assert.ok(deadMarkup.includes('data-neoterra-bad-end-choice="other"'));
    assert.ok(deadMarkup.includes('data-neoterra-bad-end-choice="end"'));
});

test('an abort from the detector propagates and writes nothing', async () => {
    const store = makeStore();
    mutate(store, (state) => setAmbiguousAutonomy(state));
    const before = structuredClone(store.get());
    const runner = {
        async runAgent() {
            throw new AgentAbortedError('user aborted');
        },
    };
    const settings = settingsFor();
    const flow = makeFlow(store, settings, runner);
    await assert.rejects(
        () => flow.detectAndRecord({ message: '' }),
        (error) => error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED',
    );
    assert.deepEqual(store.get(), before);
    assert.equal(store.get().badEnds[TARGET], undefined);
});
