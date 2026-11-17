import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    assertStateFormExclusivity,
    buildFormIndex,
    clearFormsCache,
    findFormConflicts,
    getActiveFormGroupIds,
    loadFormGroups,
    loadFormRules,
    selectExclusiveCast,
} from '../src/data/forms.js';
import {
    WORLD_BOOK_MARKER,
    buildWorldBookEntry,
    createWorldBookAdapter,
    materializeSeasonWorldBook,
    mergeWorldBookDocuments,
    parseGeneratedEntryId,
} from '../src/context/worldbook.js';
import {
    buildDeterministicCast,
    createCastDirector,
    deterministic as deterministicFallback,
    normalizeCastDirectorResult,
} from '../src/agents/cast-director.js';
import { AgentAbortedError } from '../src/agents/client.js';
import { createSceneFlow } from '../src/flows/scene.js';
import { createWorldStateStore } from '../src/state/store.js';
import { createWorldState, validateWorldState } from '../src/state/world-state.js';

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

const seasonDocuments = {
    s1: readJson('data/seasons/s1.json'),
    s1dark: readJson('data/seasons/s1dark.json'),
};

const CONTEXT = { registry, factions, locations, formGroups, formRules };
const formIndex = buildFormIndex(registry, formGroups);

function makeState({ seasonId = 's1', player = { identity: 'custom' }, chatId = 'test-chat' } = {}) {
    return createWorldState({
        season: seasonDocuments[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId,
        player,
        now: NOW,
    });
}

function clone(value) {
    return structuredClone(value);
}

function cloneCharacterAs(state, sourceId, characterId, { locationId = null, formId = null } = {}) {
    const next = clone(state);
    const source = next.characters[sourceId];
    assert.ok(source, `missing source character ${sourceId}`);
    const entry = registry.entries.find((candidate) => candidate.id === characterId);
    assert.ok(entry, `missing registry entry ${characterId}`);
    next.characters[characterId] = {
        ...clone(source),
        charId: characterId,
        formId: formId ?? characterId,
        formGroup: entry.formGroup ?? null,
        displayName: entry.displayName,
        controlledBy: 'npc',
        status: 'active',
        alive: true,
        locationId: locationId ?? source.locationId,
    };
    next.flags = {
        ...(next.flags ?? {}),
        manualCharacters: [
            ...(Array.isArray(next.flags?.manualCharacters) ? next.flags.manualCharacters : []),
            characterId,
        ],
    };
    return next;
}

function worldBookEntries(materialized) {
    return Object.values(materialized.document.entries);
}

test('form exclusivity detects, asserts, and selects one form deterministically', () => {
    const base = makeState();
    const state = cloneCharacterAs(
        base,
        's1.aurelia.longshot',
        's1.redraw.corrupted.longshot',
        { formId: 's1.redraw.corrupted.longshot', locationId: 'central-plaza' },
    );

    const conflicts = findFormConflicts(state, formIndex);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].groupId, 's1.aurelia');
    assert.deepEqual(conflicts[0].characterIds, ['s1.aurelia.longshot', 's1.redraw.corrupted.longshot']);

    assert.throws(
        () => assertStateFormExclusivity(state, formIndex),
        /s1\.aurelia/,
    );

    const activeGroups = getActiveFormGroupIds(state, formIndex);
    assert.deepEqual(activeGroups.get('s1.aurelia'), [
        's1.aurelia.longshot',
        's1.redraw.corrupted.longshot',
    ]);

    const candidates = [
        state.characters['s1.redraw.corrupted.longshot'],
        state.characters['s1.aurelia.longshot'],
    ];
    const first = selectExclusiveCast(candidates, formIndex);
    const second = selectExclusiveCast(candidates, formIndex);
    assert.equal(first.length, 1);
    assert.equal(first[0].charId, 's1.aurelia.longshot');
    assert.deepEqual(first.map((character) => character.charId), second.map((character) => character.charId));
});

test('world book generates one trimmed entry per roster character and no blanket blob', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const materialized = materializeSeasonWorldBook({
        season,
        registry,
        state,
        name: 'Test Book',
        gateLevel: 'full',
        limits: {},
        maxTokensPerProfile: 600,
        now: () => NOW,
    });

    const entries = worldBookEntries(materialized);
    assert.equal(entries.length, season.roster.length);
    assert.equal(materialized.stats.generated, entries.length);
    assert.equal(materialized.stats.rosterCount, season.roster.length);
    assert.ok(materialized.stats.tokens > 0);

    const generatedIds = new Set();
    for (const entry of entries) {
        assert.ok(Array.isArray(entry.key));
        assert.ok(entry.key.length > 0);
        assert.equal(typeof entry.comment, 'string');
        assert.ok(entry.comment.includes(WORLD_BOOK_MARKER));
        assert.equal(typeof entry.content, 'string');
        assert.ok(entry.content.length > 0);
        assert.equal(Number.isInteger(entry.uid), true);
        assert.equal(entry.depth, 4);
        assert.equal(entry.position, 0);
        assert.equal(entry.comment === 'Neo Terra', false);
        const charId = parseGeneratedEntryId(entry);
        assert.equal(typeof charId, 'string');
        generatedIds.add(charId);
    }

    assert.deepEqual(
        [...generatedIds].sort(),
        season.roster.map((member) => member.characterId).sort(),
    );
    assert.equal(entries.some((entry) => entry.key.includes('Neo Terra')), false);
});

test('played canon character is excluded from the world book', () => {
    const season = seasonDocuments.s1dark;
    const playerId = season.defaultPlayerCharacterId;
    const state = makeState({
        seasonId: 's1dark',
        player: { identity: 'canon', characterId: playerId },
    });
    const materialized = materializeSeasonWorldBook({
        season,
        registry,
        state,
        name: 'Dark Book',
        now: () => NOW,
    });
    const entries = worldBookEntries(materialized);
    const ids = entries.map((entry) => parseGeneratedEntryId(entry));

    assert.equal(ids.includes(playerId), false);
    assert.equal(
        entries.some((entry) => entry.comment.includes(playerId)),
        false,
    );
    assert.equal(
        entries.some((entry) => entry.content.split('\n')[0].startsWith('Carol Fate')),
        false,
    );
    assert.ok(materialized.skipped.some((skip) => skip.charId === playerId && skip.reason === 'player-controlled'));
});

test('merge preserves user entries, drops stale generated entries, and never duplicates', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const first = materializeSeasonWorldBook({ season, registry, state, name: 'Merge Book' });
    const second = materializeSeasonWorldBook({ season, registry, state, name: 'Merge Book' });

    assert.deepEqual(
        worldBookEntries(first).map((entry) => parseGeneratedEntryId(entry)),
        worldBookEntries(second).map((entry) => parseGeneratedEntryId(entry)),
    );

    const userEntry = {
        uid: 0,
        key: ['my-note'],
        comment: 'My private note',
        content: 'This is a user entry and must survive.',
    };
    const staleEntry = buildWorldBookEntry({
        characterId: 's1.not.on.roster',
        entry: { displayName: 'Stale Character' },
        character: { charId: 's1.not.on.roster', displayName: 'Stale Character' },
        content: 'Stale content',
    });
    const existing = {
        name: 'Merge Book',
        entries: {
            0: userEntry,
            1: staleEntry,
            2: { ...worldBookEntries(first)[0] },
        },
    };

    const merged = mergeWorldBookDocuments(existing, first);
    const mergedEntries = Object.values(merged.entries);
    assert.equal(mergedEntries[0].comment, 'My private note');
    assert.equal(
        mergedEntries.some((entry) => parseGeneratedEntryId(entry) === 's1.not.on.roster'),
        false,
    );

    const generatedIds = mergedEntries
        .map((entry) => parseGeneratedEntryId(entry))
        .filter(Boolean);
    assert.equal(new Set(generatedIds).size, generatedIds.length);
    assert.deepEqual(
        [...generatedIds].sort(),
        worldBookEntries(first).map((entry) => parseGeneratedEntryId(entry)).sort(),
    );

    const mergedAgain = mergeWorldBookDocuments(merged, second);
    assert.deepEqual(
        Object.values(mergedAgain.entries).map((entry) => parseGeneratedEntryId(entry)),
        Object.values(merged.entries).map((entry) => parseGeneratedEntryId(entry)),
    );
});

test('world-book adapter saves, links, dedupes, and unlinks only its own book', async () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const saved = new Map();
    const deleted = [];
    let metadataSaves = 0;
    const ctx = {
        chatMetadata: {},
        saveMetadataDebounced: () => {
            metadataSaves += 1;
        },
    };
    const adapter = createWorldBookAdapter({
        ctx,
        saveWorldInfo: (name, document) => {
            saved.set(name, document);
        },
        loadWorldInfo: (name) => saved.get(name) ?? null,
        deleteWorldInfo: (name) => {
            deleted.push(name);
        },
        now: () => NOW,
    });

    const first = await adapter.ensure({
        name: 'Chat Book',
        season,
        registry,
        state,
        settings: {},
    });
    assert.equal(first.status, 'materialized');
    assert.equal(first.linked, true);
    assert.ok(first.entryCount > 0);
    assert.ok(saved.has('Chat Book'));
    assert.equal(ctx.chatMetadata.neoterra.worldBook.name, 'Chat Book');
    assert.equal(ctx.chatMetadata.world_info, 'Chat Book');
    assert.ok(metadataSaves > 0);

    const second = await adapter.ensure({
        name: 'Chat Book',
        season,
        registry,
        state,
        settings: {},
    });
    assert.equal(second.status, 'unchanged');
    assert.equal(second.linked, false);

    const linkedPrimary = createWorldBookAdapter({
        ctx: { chatMetadata: { world_info: 'User Book' }, saveMetadataDebounced: () => {} },
        saveWorldInfo: () => {},
        loadWorldInfo: () => null,
        now: () => NOW,
    });
    const linked = linkedPrimary.link('Chat Book');
    assert.equal(linked.primary, 'User Book');
    assert.equal(
        linkedPrimary.remove('Chat Book').status,
        'cleared',
    );
    assert.equal(linkedPrimary.read('Chat Book') ?? null, null);

    const noMetadata = createWorldBookAdapter({
        ctx: { chatMetadata: null },
        saveWorldInfo: () => {},
        loadWorldInfo: () => null,
        now: () => NOW,
    });
    assert.deepEqual(noMetadata.link('Chat Book'), { linked: false, primary: null });

    const removed = adapter.remove('Chat Book');
    assert.equal(removed.status, 'deleted');
    assert.deepEqual(deleted, ['Chat Book']);
    assert.equal(ctx.chatMetadata.neoterra.worldBook, null);
    assert.equal(Object.hasOwn(ctx.chatMetadata, 'world_info'), false);
});

test('deterministic cast picks residents, excludes the player and dead characters, and honors pins', () => {
    const state = makeState();
    const season = seasonDocuments.s1;

    const atClarity = buildDeterministicCast({
        state,
        season,
        formIndex,
        locationId: 'clarity-hq',
    });
    assert.ok(atClarity.present.includes('s1.claire.atropos'));
    assert.ok(atClarity.present.includes('s1.crystal.cat'));
    assert.equal(atClarity.present.includes(state.player.characterId), false);
    assert.ok(atClarity.threatsHere.includes('Clarity Incorporated'));

    const deadState = clone(state);
    deadState.characters['s1.claire.atropos'].status = 'dead';
    deadState.characters['s1.claire.atropos'].alive = false;
    const withoutDead = buildDeterministicCast({
        state: deadState,
        season,
        formIndex,
        locationId: 'clarity-hq',
    });
    assert.equal(withoutDead.present.includes('s1.claire.atropos'), false);

    const pinnedState = clone(state);
    pinnedState.flags.castDirector = {
        manualPins: ['s1.vaiva.colorgarde'],
        manualRemovals: ['s1.crystal.cat'],
    };
    const first = deterministicFallback({
        state: pinnedState,
        season,
        formIndex,
        locationId: 'clarity-hq',
    });
    assert.ok(first.present.includes('s1.vaiva.colorgarde'));
    assert.equal(first.present.includes('s1.crystal.cat'), false);

    const second = deterministicFallback({
        state: pinnedState,
        season,
        formIndex,
        locationId: 'clarity-hq',
    });
    assert.deepEqual(second.present, first.present);
    assert.deepEqual(first.pinned, ['s1.vaiva.colorgarde']);
    assert.deepEqual(first.removed, ['s1.crystal.cat']);
});

test('normalization rejects out-of-pool ids, missing destinations, and unknown locations', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const locationId = 'central-plaza';
    const deterministicCast = buildDeterministicCast({
        state,
        season,
        formIndex,
        locationId,
    });

    const normalized = normalizeCastDirectorResult({
        result: {
            present: ['s1.atropos.couple'],
            arrivals: ['s1.atropos.couple'],
            departures: ['s1.aurelia.longshot'],
            offscreenMoves: [
                { characterId: 's1.tindur.sharkbite', locationId: 'no-such-location' },
            ],
            rationale: 'bad output',
        },
        state,
        season,
        formIndex,
        locationId,
        deterministic: deterministicCast,
    });

    assert.equal(normalized.events.length, 0);
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.atropos.couple' && item.reason === 'not-in-pool'));
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.aurelia.longshot' && item.reason === 'no-destination'));
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.tindur.sharkbite' && item.reason === 'unknown-location'));

    const notOffscreen = normalizeCastDirectorResult({
        result: {
            present: [],
            arrivals: [],
            departures: [],
            offscreenMoves: [
                { characterId: 's1.aurelia.longshot', locationId: 'neon-docks' },
            ],
            rationale: 'resident cannot be merely offscreen',
        },
        state,
        season,
        formIndex,
        locationId,
        deterministic: deterministicCast,
    });
    assert.equal(notOffscreen.events.length, 0);
    assert.ok(notOffscreen.rejected.some((item) => item.characterId === 's1.aurelia.longshot' && item.reason === 'not-offscreen'));
});

test('agent output cannot move pinned or manually removed characters', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const locationId = 'central-plaza';
    const deterministicCast = {
        present: ['s1.aurelia.longshot'],
        residents: [],
        availablePool: [
            state.characters['s1.aurelia.longshot'],
            state.characters['s1.tindur.sharkbite'],
        ],
        threatsHere: [],
        pinned: ['s1.aurelia.longshot'],
        removed: ['s1.tindur.sharkbite'],
        locationId,
        notes: [],
    };

    const normalized = normalizeCastDirectorResult({
        result: {
            present: [],
            arrivals: ['s1.tindur.sharkbite'],
            departures: ['s1.aurelia.longshot'],
            offscreenMoves: [
                { characterId: 's1.aurelia.longshot', locationId: 'neon-docks' },
                { characterId: 's1.tindur.sharkbite', locationId: 'neon-docks' },
            ],
            rationale: 'ignore pins',
        },
        state,
        season,
        formIndex,
        locationId,
        deterministic: deterministicCast,
    });

    assert.equal(normalized.events.length, 0);
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.aurelia.longshot' && item.reason === 'pinned'));
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.tindur.sharkbite' && item.reason === 'manually-removed'));
    assert.deepEqual(normalized.cast.present, ['s1.aurelia.longshot']);
});

test('casting two forms of one group yields one present character and a rejection', () => {
    const base = makeState();
    const state = cloneCharacterAs(
        base,
        's1.aurelia.longshot',
        's1.redraw.corrupted.longshot',
        { formId: 's1.redraw.corrupted.longshot', locationId: 'neon-docks' },
    );
    const season = seasonDocuments.s1;
    const locationId = 'central-plaza';

    const deterministicCast = {
        present: [],
        residents: [],
        availablePool: [
            state.characters['s1.aurelia.longshot'],
            state.characters['s1.redraw.corrupted.longshot'],
        ],
        threatsHere: [],
        pinned: [],
        removed: [],
        locationId,
        notes: [],
    };

    const normalized = normalizeCastDirectorResult({
        result: {
            present: ['s1.aurelia.longshot', 's1.redraw.corrupted.longshot'],
            arrivals: ['s1.aurelia.longshot', 's1.redraw.corrupted.longshot'],
            departures: [],
            offscreenMoves: [],
            rationale: 'both forms arrive',
        },
        state,
        season,
        formIndex,
        locationId,
        deterministic: deterministicCast,
    });

    assert.equal(normalized.cast.present.length, 1);
    assert.equal(normalized.cast.present[0], 's1.aurelia.longshot');
    assert.ok(normalized.rejected.some((item) => item.characterId === 's1.redraw.corrupted.longshot' && item.reason === 'form-exclusive'));
});

test('the played canon character is never cast or moved by the director', () => {
    const season = seasonDocuments.s1dark;
    const playerId = season.defaultPlayerCharacterId;
    const state = makeState({
        seasonId: 's1dark',
        player: { identity: 'canon', characterId: playerId },
    });
    const locationId = 'clarity-hq';
    const deterministicCast = buildDeterministicCast({
        state,
        season,
        formIndex,
        locationId,
    });

    const normalized = normalizeCastDirectorResult({
        result: {
            present: [playerId],
            arrivals: [playerId],
            departures: [],
            offscreenMoves: [],
            rationale: 'the director tries to cast the player',
        },
        state,
        season,
        formIndex,
        locationId,
        deterministic: deterministicCast,
    });

    assert.equal(normalized.events.some((event) => event.characterId === playerId), false);
    assert.equal(normalized.cast.present.includes(playerId), false);
    assert.ok(normalized.rejected.some((item) => item.characterId === playerId && item.reason === 'player-controlled'));
});

test('agent pass uses valid JSON, degrades on failure, rethrows aborts, and respects disable', async () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const locationId = 'central-plaza';

    let calls = 0;
    const validRunner = {
        runAgent: async () => {
            calls += 1;
            return {
                value: {
                    present: ['s1.aurelia.longshot', 's1.vaiva.colorgarde'],
                    arrivals: [],
                    departures: [],
                    offscreenMoves: [
                        { characterId: 's1.vaiva.colorgarde', locationId: 'neon-docks' },
                    ],
                    rationale: 'move a rumor source offscreen',
                },
            };
        },
    };
    const director = createCastDirector({
        runner: validRunner,
        formIndex,
        getSettings: () => ({ agents: { castDirector: { enabled: true } } }),
    });
    const result = await director.run({ state, season, locationId });
    assert.equal(result.source, 'agent');
    assert.equal(calls, 1);
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], {
        type: 'MOVE_CHARACTER',
        characterId: 's1.vaiva.colorgarde',
        locationId: 'neon-docks',
    });

    const brokenRunner = {
        runAgent: async () => {
            throw new Error('malformed JSON');
        },
    };
    const broken = createCastDirector({ runner: brokenRunner, formIndex });
    const fallback = await broken.run({ state, season, locationId });
    assert.equal(fallback.source, 'deterministic');
    assert.equal(fallback.events.length, 0);
    assert.match(fallback.error, /malformed JSON/);

    const abortRunner = {
        runAgent: async () => {
            throw new AgentAbortedError('chat changed');
        },
    };
    const aborting = createCastDirector({ runner: abortRunner, formIndex });
    await assert.rejects(
        () => aborting.run({ state, season, locationId }),
        (error) => error instanceof AgentAbortedError,
    );

    let disabledCalls = 0;
    const disabled = createCastDirector({
        runner: {
            runAgent: async () => {
                disabledCalls += 1;
                return { value: {} };
            },
        },
        formIndex,
        getSettings: () => ({ agents: { castDirector: { enabled: false } } }),
    });
    const disabledResult = await disabled.run({ state, season, locationId });
    assert.equal(disabledResult.source, 'deterministic');
    assert.equal(disabledCalls, 0);
});

test('scene flow applies events, persists flags, honors pins/removals, and survives failures', async () => {
    const season = seasonDocuments.s1;
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'scene-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        now: () => NOW,
        context: CONTEXT,
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'scene-chat',
        player: { identity: 'custom' },
        now: NOW,
    });

    const director = {
        run: async ({ locationId }) => ({
            events: [
                { type: 'MOVE_CHARACTER', characterId: 's1.vaiva.colorgarde', locationId },
            ],
            rejected: [],
            source: 'agent',
            deterministic: null,
        }),
    };
    const failingWorldBook = {
        ensure: () => {
            throw new Error('book host unavailable');
        },
    };
    const flow = createSceneFlow({
        store,
        season,
        registry,
        formIndex,
        formGroups,
        formRules,
        director,
        worldBook: failingWorldBook,
        getSettings: () => ({}),
        now: () => 12345,
    });

    const initialized = await flow.initialize();
    assert.equal(initialized.worldBook, null);
    assert.equal(store.get().flags.castDirector.lastRunAt, 12345);

    const opened = await flow.enterScene({ locationId: store.get().scene.locationId, runDirector: false });
    assert.deepEqual(opened.events, []);
    assert.equal(opened.state.scene.locationId, store.get().scene.locationId);

    const entered = await flow.enterScene({ locationId: 'clarity-hq' });
    assert.equal(entered.state.scene.locationId, 'clarity-hq');
    assert.ok(entered.cast.present.includes('s1.vaiva.colorgarde'));
    assert.ok(entered.cast.present.includes('s1.claire.atropos'));
    assert.equal(entered.source, 'agent');
    assert.equal(store.get().flags.castDirector.locationId, 'clarity-hq');

    const pinned = flow.setManualPins(['s1.vaiva.colorgarde']);
    assert.ok(pinned.cast.present.includes('s1.vaiva.colorgarde'));
    assert.deepEqual(flow.getCastState().manualPins, ['s1.vaiva.colorgarde']);

    const removed = flow.setManualRemovals(['s1.claire.atropos']);
    assert.equal(removed.cast.present.includes('s1.claire.atropos'), false);
    assert.deepEqual(flow.getCastState().manualRemovals, ['s1.claire.atropos']);

    const failingDirector = {
        run: async () => {
            throw new Error('director exploded');
        },
    };
    const failingFlow = createSceneFlow({
        store,
        season,
        registry,
        formIndex,
        formGroups,
        formRules,
        director: failingDirector,
        getSettings: () => ({}),
        now: () => 23456,
    });
    const moved = await failingFlow.enterScene({ locationId: 'neon-docks' });
    assert.equal(moved.source, 'deterministic');
    assert.equal(moved.state.scene.locationId, 'neon-docks');
    assert.ok(moved.cast.present.includes('s1.tindur.sharkbite'));
    // Pins travel with the scene; removals physically leave it.
    assert.ok(moved.cast.present.includes('s1.vaiva.colorgarde'));
    assert.equal(
        moved.state.characters['s1.vaiva.colorgarde'].locationId,
        'neon-docks',
    );
    assert.equal(moved.cast.present.includes('s1.claire.atropos'), false);
    assert.notEqual(
        moved.state.characters['s1.claire.atropos'].locationId,
        'neon-docks',
    );
});

test('the synchronous plan hook normalizes proposed output without a runner', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const director = createCastDirector({ formIndex });
    const planned = director.plan({
        state,
        season,
        locationId: 'central-plaza',
        propose: () => ({
            present: ['s1.aurelia.longshot'],
            arrivals: [],
            departures: [],
            offscreenMoves: [],
            rationale: 'hook',
        }),
    });
    assert.equal(planned.source, 'agent');
    assert.equal(planned.rationale, 'hook');
    assert.ok(planned.cast.present.includes('s1.aurelia.longshot'));
});

test('deterministic planning and normalization never mutate the input state', () => {
    const state = makeState();
    const season = seasonDocuments.s1;
    const before = clone(state);

    const deterministicCast = buildDeterministicCast({
        state,
        season,
        formIndex,
        locationId: 'central-plaza',
    });
    assert.deepEqual(state, before);

    normalizeCastDirectorResult({
        result: {
            present: ['s1.aurelia.longshot'],
            arrivals: ['s1.tindur.sharkbite'],
            departures: [],
            offscreenMoves: [],
            rationale: 'a pure plan',
        },
        state,
        season,
        formIndex,
        locationId: 'central-plaza',
        deterministic: deterministicCast,
    });
    assert.deepEqual(state, before);

    // The seeded state is still schema-valid after planning.
    assert.equal(validateWorldState(state).ok, true);
});

test('form-data loaders validate injected fetch responses and cache', async () => {
    clearFormsCache();
    const fakeFetch = async (url) => {
        const body = String(url).endsWith('form-groups.json') ? formGroups : formRules;
        return { ok: true, status: 200, json: async () => clone(body) };
    };
    const loadedGroups = await loadFormGroups({ fetchImpl: fakeFetch });
    const loadedRules = await loadFormRules({ fetchImpl: fakeFetch, registry });
    assert.deepEqual(loadedGroups, formGroups);
    assert.deepEqual(loadedRules, formRules);

    // Cached reads do not hit the network again.
    const cached = await loadFormGroups({ fetchImpl: async () => { throw new Error('network used'); } });
    assert.deepEqual(cached, formGroups);

    clearFormsCache();
    await assert.rejects(
        loadFormGroups({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
        /HTTP 404/,
    );
    clearFormsCache();
});
