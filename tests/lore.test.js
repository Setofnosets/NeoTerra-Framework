import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    LORE_RELATIONSHIP_MAX_DELTA,
    LORE_SCHEMA,
    RELATIONSHIP_TYPES,
    applyLoreRelationships,
    buildLorePrompt,
    createLoreAgent,
    normalizeLoreResult,
    runLorePass,
    slugifyLoreId,
} from '../src/agents/lore.js';
import { AgentAbortedError, validateJsonSchema } from '../src/agents/client.js';
import {
    WORLD_BOOK_LORE_MARKER,
    WORLD_BOOK_MARKER,
    buildLoreWorldBookEntry,
    buildWorldBookEntry,
    createWorldBookAdapter,
    isGeneratedLoreEntry,
    loreEntriesSimilar,
    mergeLoreEntries,
    normalizeLoreText,
    parseGeneratedLoreEntryId,
    removeGeneratedLoreEntries,
    selectLoreEntriesForInjection,
} from '../src/context/worldbook.js';
import {
    selectPresentRelationships,
    selectRelationshipBetween,
    selectRelationships,
} from '../src/state/selectors.js';
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
const CONTEXT = { registry, factions, locations, formGroups, formRules };

const VAIVA = 's1.vaiva.colorgarde';
const CRYSTAL = 's1.crystal.cat';

function makeStore(player = { identity: 'custom' }) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'lore-test-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'lore-test-chat',
        player,
        now: NOW,
    });
    return store;
}

function makeAdapter() {
    const books = {};
    const adapter = createWorldBookAdapter({
        loadWorldInfo: (name) => books[name] ?? null,
        saveWorldInfo: (name, document) => {
            books[name] = JSON.parse(JSON.stringify(document));
        },
    });
    return { adapter, books };
}

function emptyLoreResult(overrides = {}) {
    return {
        entries: [],
        selections: [],
        relationships: [],
        rationale: '',
        ...overrides,
    };
}

function fakeAgent(result, { onRun = null } = {}) {
    return {
        run: async (request) => {
            if (onRun) {
                onRun(request);
            }
            return normalizeLoreResult({
                result,
                state: request.state,
                season: request.season,
                existingEntries: request.existingEntries,
            });
        },
    };
}

/* ------------------------------------------------------------------ */
/* 1. Schema                                                           */
/* ------------------------------------------------------------------ */

test('the lore schema accepts empty and populated results and rejects unknown relationship types', () => {
    const empty = validateJsonSchema(emptyLoreResult(), LORE_SCHEMA);
    assert.equal(empty.ok, true, JSON.stringify(empty.errors));

    const valid = validateJsonSchema({
        entries: [{ id: 's1.lore.docks', title: 'The Docks', keys: ['docks'], content: 'A deal went wrong.', tags: ['clarity'], importance: 4 }],
        selections: [{ id: 's1.lore.docks', reason: 'location match' }],
        relationships: [{ a: VAIVA, b: CRYSTAL, type: 'rivalry', affinityDelta: -4, tensionDelta: 6, notes: 'open hostility' }],
        rationale: 'Recent play established a rivalry.',
    }, LORE_SCHEMA);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors));

    const invalid = validateJsonSchema({
        ...emptyLoreResult(),
        relationships: [{ a: VAIVA, b: CRYSTAL, type: 'nemesis' }],
    }, LORE_SCHEMA);
    assert.equal(invalid.ok, false);
    assert.ok(RELATIONSHIP_TYPES.includes('owner/servant'));
});

/* ------------------------------------------------------------------ */
/* 2. Normalization                                                    */
/* ------------------------------------------------------------------ */

test('a custom-player relationship normalizes to PLAYER_RELATIONSHIP_DELTA', () => {
    const store = makeStore({ identity: 'custom', displayName: 'Alex' });
    const result = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            relationships: [{ a: 'player', b: VAIVA, type: 'ally', affinityDelta: 7 }],
        }),
    });
    assert.equal(result.relationshipEvents.length, 1);
    assert.equal(result.relationshipEvents[0].type, 'PLAYER_RELATIONSHIP_DELTA');
    assert.equal(result.relationshipEvents[0].withCharacterId, VAIVA);
});

test('a canon-player relationship normalizes to RELATIONSHIP_DELTA', () => {
    const store = makeStore({ identity: 'canon', characterId: VAIVA });
    const result = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            relationships: [{ a: 'player', b: CRYSTAL, type: 'rivalry', tensionDelta: 9 }],
        }),
    });
    assert.equal(result.relationshipEvents.length, 1);
    const event = result.relationshipEvents[0];
    assert.equal(event.type, 'RELATIONSHIP_DELTA');
    assert.deepEqual([event.a, event.b].sort(), [CRYSTAL, VAIVA].sort());
});

test('reciprocal proposals merge into one canonical event and deltas clamp to the lore bound', () => {
    const store = makeStore();
    const result = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            relationships: [
                { a: CRYSTAL, b: VAIVA, type: 'rivalry', affinityDelta: 15, tensionDelta: 15 },
                { a: VAIVA, b: CRYSTAL, type: 'rivalry', affinityDelta: 15, tensionDelta: 15 },
            ],
        }),
    });
    assert.equal(result.relationshipEvents.length, 1);
    const event = result.relationshipEvents[0];
    assert.equal(event.a, CRYSTAL.localeCompare(VAIVA) < 0 ? CRYSTAL : VAIVA);
    assert.equal(event.affinityDelta, LORE_RELATIONSHIP_MAX_DELTA);
    assert.equal(event.tensionDelta, LORE_RELATIONSHIP_MAX_DELTA);
});

test('self-targets and unknown ids are rejected without throwing', () => {
    const store = makeStore();
    const result = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            relationships: [
                { a: CRYSTAL, b: CRYSTAL, type: 'ally', affinityDelta: 5 },
                { a: VAIVA, b: 's1.nobody.here', type: 'ally', affinityDelta: 5 },
                { a: 'player', b: 'player', type: 'likes', affinityDelta: 5 },
            ],
        }),
    });
    assert.equal(result.relationshipEvents.length, 0);
    assert.ok(result.rejected.some((entry) => entry.reason.startsWith('self-target')));
    assert.ok(result.rejected.some((entry) => entry.reason.includes('unknown-relationship-side')));
});

test('normalization derives stable ids, dedupes, and caps entries', () => {
    const store = makeStore();
    const once = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            entries: [
                { title: 'The Docks Deal', content: 'Colorgarde broke up an arms deal.' },
                { title: 'The Docks Deal', content: 'Colorgarde broke up an arms deal at the docks.', keys: ['docks'] },
            ],
        }),
    });
    assert.equal(once.entries.length, 1);
    assert.equal(once.entries[0].id, `${store.get().seasonId}.lore.${slugifyLoreId('The Docks Deal')}`);
    assert.ok(once.entries[0].keys.includes('docks'));

    const again = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            entries: [{ title: 'The Docks Deal', content: 'Colorgarde broke up an arms deal.' }],
        }),
    });
    assert.equal(again.entries[0].id, once.entries[0].id);

    const many = normalizeLoreResult({
        state: store.get(),
        result: emptyLoreResult({
            entries: Array.from({ length: 9 }, (_, index) => ({
                title: `Entry ${index}`,
                content: `Fact number ${index} stands.`,
            })),
        }),
    });
    assert.equal(many.entries.length, 5);

    const garbage = normalizeLoreResult({ state: store.get(), result: { entries: 'nope' } });
    assert.equal(garbage.entries.length, 0);
    assert.equal(garbage.relationshipEvents.length, 0);
});

test('selections only accept known ids', () => {
    const store = makeStore();
    const result = normalizeLoreResult({
        state: store.get(),
        existingEntries: [{ id: 's1.lore.known', content: 'known' }],
        candidates: [{ id: 'candidate.one', content: 'candidate' }],
        result: emptyLoreResult({
            selections: [
                { id: 's1.lore.known' },
                { id: 'candidate.one' },
                { id: 's1.lore.unknown' },
                { id: 's1.lore.known' },
            ],
        }),
    });
    assert.deepEqual(result.selections.map((selection) => selection.id), ['s1.lore.known', 'candidate.one']);
    assert.ok(result.rejected.some((entry) => entry.reason.startsWith('unknown-id')));
});

/* ------------------------------------------------------------------ */
/* 3. Atomic relationships                                             */
/* ------------------------------------------------------------------ */

test('relationship events apply atomically or not at all', () => {
    const store = makeStore();
    const before = JSON.stringify(store.get());
    const ok = applyLoreRelationships(store, {
        relationshipEvents: [{
            type: 'PLAYER_RELATIONSHIP_DELTA',
            withCharacterId: VAIVA,
            affinityDelta: 6,
            tensionDelta: 2,
        }],
    });
    assert.equal(ok.ok, true);
    assert.equal(store.get().player.relationships[0].affinity, 6);

    const afterOk = JSON.stringify(store.get());
    const bad = applyLoreRelationships(store, {
        relationshipEvents: [{
            type: 'RELATIONSHIP_DELTA',
            a: VAIVA,
            b: 's1.missing.character',
            affinityDelta: 5,
        }],
    });
    assert.equal(bad.ok, false);
    assert.equal(JSON.stringify(store.get()), afterOk);
    assert.notEqual(afterOk, before);
});

test('an empty relationship batch leaves state byte-identical', () => {
    const store = makeStore();
    const before = JSON.stringify(store.get());
    const applied = applyLoreRelationships(store, { relationshipEvents: [] });
    assert.equal(applied.ok, true);
    assert.equal(JSON.stringify(store.get()), before);
});

/* ------------------------------------------------------------------ */
/* 4. ST entry shape                                                   */
/* ------------------------------------------------------------------ */

test('a lore entry is a complete ST world-info entry tagged with the lore marker', () => {
    const entry = buildLoreWorldBookEntry({
        id: 's1.lore.the-docks-deal',
        title: 'The Docks Deal',
        keys: ['docks', 'arms deal'],
        content: 'Colorgarde interrupted an arms deal at the docks.',
        tags: ['clarity'],
        uid: 3,
    });
    assert.ok(Array.isArray(entry.key));
    assert.ok(entry.key.includes('The Docks Deal'));
    assert.ok(entry.key.includes('docks'));
    assert.ok(entry.key.includes('clarity'));
    assert.ok(entry.key.length <= 12);
    assert.equal(entry.comment, `Neo Terra — Lore: The Docks Deal [${WORLD_BOOK_LORE_MARKER}s1.lore.the-docks-deal]`);
    assert.match(entry.content, /arms deal/);
    assert.equal(entry.depth, 4);
    assert.equal(entry.order, 200);
    assert.equal(entry.uid, 3);
    assert.equal(entry.constant, false);
    assert.equal(entry.selective, true);
    assert.equal(parseGeneratedLoreEntryId(entry), 's1.lore.the-docks-deal');
    assert.equal(isGeneratedLoreEntry(entry), true);
    assert.equal(parseGeneratedLoreEntryId({ comment: 'a plain note' }), null);
    assert.notEqual(WORLD_BOOK_LORE_MARKER, WORLD_BOOK_MARKER);
});

test('lore entries are trimmed to the token cap and reject empty input', () => {
    const long = buildLoreWorldBookEntry({
        id: 's1.lore.long',
        title: 'Long',
        content: 'word '.repeat(400),
        maxTokens: 40,
    });
    assert.ok(long.content.length <= 40 * 4);
    assert.equal(buildLoreWorldBookEntry({ id: '', title: 'x', content: 'y' }), null);
    assert.equal(buildLoreWorldBookEntry({ id: 's1.lore.x', title: 'x', content: '   ' }), null);
});

/* ------------------------------------------------------------------ */
/* 5–8. Merge, duplicates, preservation, removal                       */
/* ------------------------------------------------------------------ */

test('committing the same entries twice never duplicates them', () => {
    const entry = buildLoreWorldBookEntry({
        id: 's1.lore.docks',
        title: 'The Docks',
        content: 'Colorgarde broke up an arms deal at the docks.',
    });
    const first = mergeLoreEntries({ name: 'Book', entries: {} }, [entry]);
    const second = mergeLoreEntries(first, [{
        id: 's1.lore.docks',
        title: 'The Docks',
        content: 'Colorgarde broke up an arms deal at the docks.',
    }]);
    const ids = Object.values(second.entries).map(parseGeneratedLoreEntryId);
    assert.deepEqual(ids, ['s1.lore.docks']);
    assert.deepEqual(ids, Object.values(first.entries).map(parseGeneratedLoreEntryId));
});

test('near-duplicate entries collapse into one with merged keys', () => {
    const a = buildLoreWorldBookEntry({
        id: 's1.lore.docks-a',
        title: 'The Docks',
        keys: ['neon docks'],
        content: 'Colorgarde broke up an arms deal at the neon docks.',
        order: 200,
    });
    const b = buildLoreWorldBookEntry({
        id: 's1.lore.docks-b',
        title: 'Docks Ambush',
        keys: ['arms deal'],
        content: 'Colorgarde BROKE UP an arms deal at the neon docks!!',
        order: 210,
    });
    assert.equal(loreEntriesSimilar(a, b), true);
    assert.equal(normalizeLoreText('Neon-Docks!'), 'neon docks');

    const merged = mergeLoreEntries({ name: 'Book', entries: {} }, [a, b]);
    const entries = Object.values(merged.entries);
    assert.equal(entries.length, 1);
    assert.equal(parseGeneratedLoreEntryId(entries[0]), 's1.lore.docks-a');
    assert.ok(entries[0].key.includes('arms deal'));
});

test('merging lore keeps character and user entries untouched', () => {
    const characterEntry = buildWorldBookEntry({
        characterId: VAIVA,
        entry: { id: VAIVA, displayName: 'Vaiva', dataName: 'Vaiva', aliases: [] },
        content: 'Vaiva profile line.',
    });
    const userEntry = { uid: 9, key: ['my note'], comment: 'My private note', content: 'Hand written lore.' };
    const existing = {
        name: 'Book',
        entries: { 0: characterEntry, 1: userEntry },
    };
    const merged = mergeLoreEntries(existing, [{
        id: 's1.lore.docks',
        title: 'The Docks',
        content: 'The docks deal collapsed.',
    }]);
    const entries = Object.values(merged.entries);
    const loreIds = entries.map((entry) => parseGeneratedLoreEntryId(entry)).filter(Boolean);
    assert.deepEqual(loreIds, ['s1.lore.docks']);
    assert.ok(entries.some((entry) => entry.comment === 'My private note'));
    assert.ok(entries.some((entry) => entry.comment.includes(WORLD_BOOK_MARKER)
        && !entry.comment.includes(WORLD_BOOK_LORE_MARKER)));
    entries.forEach((entry, index) => assert.equal(entry.uid, index));
});

test('removing generated lore entries keeps character and user entries and reindexes uids', () => {
    const characterEntry = buildWorldBookEntry({
        characterId: VAIVA,
        entry: { id: VAIVA, displayName: 'Vaiva', dataName: 'Vaiva', aliases: [] },
        content: 'Vaiva profile line.',
    });
    const document = {
        name: 'Book',
        entries: {
            0: characterEntry,
            1: buildLoreWorldBookEntry({ id: 's1.lore.a', title: 'A', content: 'Fact A.' }),
            2: { uid: 2, key: ['note'], comment: 'user', content: 'User lore.' },
            3: buildLoreWorldBookEntry({ id: 's1.lore.b', title: 'B', content: 'Fact B.' }),
        },
    };
    const reset = removeGeneratedLoreEntries(document);
    const entries = Object.values(reset.entries);
    assert.equal(entries.length, 2);
    assert.equal(reset.name, 'Book');
    assert.ok(entries.every((entry) => parseGeneratedLoreEntryId(entry) === null));
    entries.forEach((entry, index) => assert.equal(entry.uid, index));
});

test('merge and removal tolerate partial documents', () => {
    assert.deepEqual(mergeLoreEntries(null, []).entries, {});
    assert.deepEqual(removeGeneratedLoreEntries(null).entries, {});
    assert.deepEqual(mergeLoreEntries({ name: 'Book' }, 'nope').entries, {});
});

/* ------------------------------------------------------------------ */
/* 9 and 14. Injection selection                                       */
/* ------------------------------------------------------------------ */

test('injection selection respects the token budget and prefers relevant entries', () => {
    const relevant = buildLoreWorldBookEntry({
        id: 's1.lore.central-plaza',
        title: 'Central Plaza',
        keys: ['Central Plaza'],
        content: 'Central Plaza is where the city gathers.',
        order: 205,
    });
    const unrelated = buildLoreWorldBookEntry({
        id: 's1.lore.deep-sea',
        title: 'Deep Sea Rig',
        keys: ['Rig'],
        content: 'An abandoned rig in the southern sea.',
        order: 200,
    });
    const document = mergeLoreEntries({ name: 'Book', entries: {} }, [relevant, unrelated]);
    const state = makeStore().get();

    const selected = selectLoreEntriesForInjection({ entries: document, state, maxTokens: 900 });
    assert.deepEqual(selected.selected.map((item) => item.id), ['s1.lore.central-plaza', 's1.lore.deep-sea']);
    assert.match(selected.text, /Central Plaza:/);

    const tight = selectLoreEntriesForInjection({ entries: document, state, maxTokens: 18 });
    assert.ok(tight.tokens <= 18);
    assert.ok(tight.dropped.length >= 1);
    assert.ok(tight.selected.length >= 1);

    const none = selectLoreEntriesForInjection({ entries: document, state, maxTokens: 1 });
    assert.ok(none.tokens <= 1);
    assert.equal(none.selected.length, 0);
    assert.equal(none.text, '');
});

test('injection selection ignores user entries and accepts loose shapes', () => {
    const userEntry = { uid: 0, key: ['x'], comment: 'Hand note', content: 'User lore about the docks.' };
    const loreEntry = buildLoreWorldBookEntry({ id: 's1.lore.docks', title: 'Docks', content: 'Docks lore.' });
    const state = makeStore().get();

    const fromArray = selectLoreEntriesForInjection({ entries: [userEntry, loreEntry], state });
    assert.deepEqual(fromArray.selected.map((item) => item.id), ['s1.lore.docks']);

    const fromMerged = selectLoreEntriesForInjection({
        entries: mergeLoreEntries({ name: 'B', entries: {} }, [loreEntry]),
        state,
    });
    assert.deepEqual(fromMerged.selected.map((item) => item.id), ['s1.lore.docks']);

    const fromDocument = selectLoreEntriesForInjection({
        entries: { name: 'B', entries: { 0: loreEntry } },
        state,
    });
    assert.deepEqual(fromDocument.selected.map((item) => item.id), ['s1.lore.docks']);
});

/* ------------------------------------------------------------------ */
/* 13. Selectors                                                       */
/* ------------------------------------------------------------------ */

function withRelationships(relationships) {
    const store = makeStore();
    const state = store.get();
    store.replace({
        ...state,
        scene: { ...state.scene, present: [VAIVA] },
        relationships,
    });
    return store.get();
}

test('relationship selectors are order-independent and present-only filters offscreen pairs', () => {
    const state = withRelationships([
        { a: CRYSTAL, b: VAIVA, type: 'rivalry', affinity: -20, tension: 40, notes: '', sinceTurn: 0 },
        { a: 's1.claire.atropos', b: 's1.tindur.sharkbite', type: 'rivalry', affinity: -10, tension: 10, notes: '', sinceTurn: 0 },
    ]);

    const between = selectRelationshipBetween(state, VAIVA, CRYSTAL);
    assert.equal(between.type, 'rivalry');
    assert.equal(selectRelationshipBetween(state, CRYSTAL, VAIVA).affinity, -20);
    assert.equal(selectRelationshipBetween(state, VAIVA, 's1.claire.atropos'), null);

    const present = selectPresentRelationships(state);
    assert.equal(present.length, 1);
    assert.ok([VAIVA, CRYSTAL].includes(present[0].a));

    const filtered = selectRelationships(state, { type: 'rivalry', minAffinity: -15 });
    assert.equal(filtered.length, 1);

    const byCharacter = selectRelationships(state, { characterId: 's1.claire.atropos' });
    assert.equal(byCharacter.length, 1);

    // Clones: mutating a result cannot touch state.
    filtered[0].affinity = 99;
    assert.equal(selectRelationshipBetween(state, VAIVA, CRYSTAL).affinity, -20);
});

/* ------------------------------------------------------------------ */
/* 10–12. Agent and full pass                                          */
/* ------------------------------------------------------------------ */

test('a disabled lore agent makes no runner call and writes nothing', async () => {
    const store = makeStore();
    const { adapter, books } = makeAdapter();
    let calls = 0;
    const agent = createLoreAgent({
        runner: { runAgent: async () => { calls += 1; return emptyLoreResult(); } },
        getSettings: () => ({ agents: { lore: { enabled: false } } }),
    });
    const before = JSON.stringify(store.get());
    const pass = await runLorePass({
        store,
        agent,
        adapter,
        bookName: 'Neo Terra — Test',
        season,
        settings: { agents: { lore: { enabled: false } } },
        log: () => {},
    });
    assert.equal(calls, 0);
    assert.equal(pass.ran, false);
    assert.equal(pass.saved, false);
    assert.equal(JSON.stringify(store.get()), before);
    assert.equal(books['Neo Terra — Test'], undefined);
});

test('a failed lore agent leaves state and book unchanged while abort propagates', async () => {
    const store = makeStore();
    const { adapter, books } = makeAdapter();
    const before = JSON.stringify(store.get());
    const failing = createLoreAgent({
        runner: { runAgent: async () => { throw new Error('timeout'); } },
        getSettings: () => ({}),
        log: () => {},
    });
    const failed = await runLorePass({
        store,
        agent: failing,
        adapter,
        bookName: 'Neo Terra — Test',
        season,
        log: () => {},
    });
    assert.equal(failed.ran, false);
    assert.equal(failed.saved, false);
    assert.equal(typeof failed.error, 'string');
    assert.equal(JSON.stringify(store.get()), before);
    assert.equal(books['Neo Terra — Test'], undefined);

    const aborting = createLoreAgent({
        runner: { runAgent: async () => { throw new AgentAbortedError('chat changed'); } },
        getSettings: () => ({}),
    });
    await assert.rejects(
        () => runLorePass({
            store,
            agent: aborting,
            adapter,
            bookName: 'Neo Terra — Test',
            season,
        }),
        (error) => error instanceof AgentAbortedError,
    );
    assert.equal(JSON.stringify(store.get()), before);
});

test('plan honors the propose seam and the prompt names ids and rules', () => {
    const store = makeStore({ identity: 'custom', displayName: 'Alex' });
    const agent = createLoreAgent({ getSettings: () => ({}) });
    const planned = agent.plan({
        state: store.get(),
        season,
        existingEntries: [{ id: 's1.lore.known', title: 'Known', content: 'Already recorded.' }],
        propose: ({ prompt, schema }) => {
            assert.match(prompt, /Lore Keeper/);
            assert.equal(schema, LORE_SCHEMA);
            return {
                ...emptyLoreResult({
                    selections: [{ id: 's1.lore.known' }],
                }),
            };
        },
    });
    assert.equal(planned.source, 'agent');
    assert.deepEqual(planned.selections.map((selection) => selection.id), ['s1.lore.known']);

    const prompt = buildLorePrompt({
        state: store.get(),
        season,
        recentProse: 'Crystal Cat watches from the roof.',
        existingEntries: [{ id: 's1.lore.known', title: 'Known', content: 'Already recorded.' }],
        presentCharacterIds: [VAIVA],
    });
    assert.match(prompt, /Turn: 0/);
    assert.match(prompt, new RegExp(VAIVA));
    assert.match(prompt, /120 words or fewer/);
    assert.match(prompt, /owner\/servant/);
    assert.match(prompt, /s1\.lore\.known/);
});

test('a full lore pass stores relationships and commits a valid ST entry once', async () => {
    const store = makeStore();
    const { adapter, books } = makeAdapter();
    const bookName = 'Neo Terra — Lore Test';
    const result = {
        ...emptyLoreResult({
            entries: [{
                title: 'The Docks Deal',
                keys: ['docks', 'arms deal'],
                content: 'Colorgarde broke up a Clarity arms deal at the neon docks.',
                tags: ['clarity'],
            }],
            selections: [{ id: `${store.get().seasonId}.lore.${slugifyLoreId('The Docks Deal')}` }],
            relationships: [{ a: 'player', b: VAIVA, type: 'ally', affinityDelta: 5, notes: 'fought side by side' }],
            rationale: 'The deal is now established lore.',
        }),
    };
    const agent = fakeAgent(result);

    const first = await runLorePass({
        store,
        agent,
        adapter,
        bookName,
        season,
        recentProse: 'Colorgarde kicks the crate open.',
        settings: { agents: { lore: { enabled: true } } },
        log: () => {},
    });
    assert.equal(first.ran, true);
    assert.equal(first.saved, true);
    assert.equal(first.entries.length, 1);
    assert.equal(first.relationships.length, 1);

    const saved = books[bookName];
    const savedEntries = Object.values(saved.entries);
    assert.equal(savedEntries.length, 1);
    assert.equal(parseGeneratedLoreEntryId(savedEntries[0]), `s1.lore.${slugifyLoreId('The Docks Deal')}`);
    assert.equal(savedEntries[0].constant, false);
    assert.equal(savedEntries[0].selective, true);
    assert.equal(savedEntries[0].depth, 4);
    assert.ok(savedEntries[0].key.includes('docks'));

    const playerRelationships = store.get().player.relationships;
    assert.equal(playerRelationships.length, 1);
    assert.equal(playerRelationships[0].withCharacterId, VAIVA);
    assert.equal(playerRelationships[0].affinity, 5);

    const second = await runLorePass({
        store,
        agent,
        adapter,
        bookName,
        season,
        settings: { agents: { lore: { enabled: true } } },
        log: () => {},
    });
    assert.equal(second.ran, true);
    assert.equal(second.saved, false);
    assert.equal(Object.values(books[bookName].entries).length, 1);
    assert.deepEqual(second.selections, first.selections);
    // A retry in the same turn must not double-apply relationship deltas.
    assert.equal(store.get().player.relationships.length, 1);
    assert.equal(store.get().player.relationships[0].affinity, 5);
    assert.equal(second.relationships.length, 0);

    // A later turn genuinely re-applies the same proposal.
    const advanced = structuredClone(store.get());
    advanced.meta.turn = 1;
    store.replace(advanced);
    const third = await runLorePass({
        store,
        agent,
        adapter,
        bookName,
        season,
        settings: { agents: { lore: { enabled: true } } },
        log: () => {},
    });
    assert.equal(third.relationships.length, 1);
    assert.equal(store.get().player.relationships[0].affinity, 10);
});

test('a failed read refuses to overwrite the existing world book', async () => {
    const store = makeStore();
    const before = JSON.stringify(store.get());
    let saved = 0;
    const adapter = createWorldBookAdapter({
        loadWorldInfo: () => { throw new Error('read boom'); },
        saveWorldInfo: () => { saved += 1; },
    });
    const agent = fakeAgent({
        ...emptyLoreResult({
            entries: [{ title: 'Unsafe Write', content: 'This must never replace the book.' }],
        }),
    });
    const pass = await runLorePass({
        store,
        agent,
        adapter,
        bookName: 'Neo Terra — Unsafe',
        season,
        settings: { agents: { lore: { enabled: true } } },
        log: () => {},
    });
    assert.equal(pass.ran, false);
    assert.equal(pass.saved, false);
    assert.match(String(pass.error), /read boom/);
    assert.equal(saved, 0);
    assert.equal(JSON.stringify(store.get()), before);

    // The strict reader distinguishes absent from unreadable.
    assert.deepEqual(
        createWorldBookAdapter({ loadWorldInfo: () => null }).readResult('missing'),
        { ok: true, available: true, document: null, error: null },
    );
    assert.equal(createWorldBookAdapter({}).readResult('missing').available, false);
});

test('a failed book save keeps the applied relationship state and reports the error', async () => {
    const store = makeStore();
    const before = JSON.stringify(store.get());
    const adapter = createWorldBookAdapter({
        loadWorldInfo: () => null,
        saveWorldInfo: () => { throw new Error('disk full'); },
    });
    const agent = fakeAgent({
        ...emptyLoreResult({
            entries: [{ title: 'Save Failure', content: 'This entry cannot be written.' }],
            relationships: [{ a: 'player', b: CRYSTAL, type: 'dislikes', tensionDelta: 4 }],
        }),
    });
    const pass = await runLorePass({
        store,
        agent,
        adapter,
        bookName: 'Neo Terra — Broken',
        season,
        settings: { agents: { lore: { enabled: true } } },
        log: () => {},
    });
    assert.equal(pass.saved, false);
    assert.match(String(pass.error), /disk full/);
    assert.equal(store.get().player.relationships.length, 1);
    assert.notEqual(JSON.stringify(store.get()), before);
});
