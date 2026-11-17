import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYABLE_SEASON_IDS } from '../src/data/seasons.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import {
    CURRENT_WORLD_STATE_VERSION,
    migrateWorldState,
} from '../src/state/migrations.js';
import {
    createWorldState,
    validateWorldState,
    cloneWorldState,
} from '../src/state/world-state.js';
import {
    METADATA_KEY,
    WAL_PREFIX,
    createWorldStateStore,
    loadWorldStateFromMetadata,
    saveWorldStateToMetadata,
} from '../src/state/store.js';
import {
    selectBadEnds,
    selectBeat,
    selectCharacter,
    selectFaction,
    selectLocation,
    selectNpcPool,
    selectOpenBeats,
    selectPlayerView,
    selectPresentCast,
    selectThreat,
} from '../src/state/selectors.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
    return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const seasons = Object.fromEntries(
    PLAYABLE_SEASON_IDS.map((id) => [id, readJson(`data/seasons/${id}.json`)]),
);

const CONTEXT = { registry, formGroups, formRules };
const NOW = 1_700_000_000_000;

function seed(seasonId, extra = {}) {
    return createWorldState({
        season: seasons[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: `chat-${seasonId}`,
        now: NOW,
        ...extra,
    });
}

function memoryStorage() {
    const map = new Map();
    return {
        getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            map.set(key, String(value));
        },
        removeItem(key) {
            map.delete(key);
        },
        _map: map,
    };
}

function quietSchedule() {
    return 1;
}

function storeOptions(extra = {}) {
    return {
        metadata: {},
        storage: memoryStorage(),
        schedule: quietSchedule,
        cancel: () => {},
        now: () => NOW,
        context: CONTEXT,
        ...extra,
    };
}

test('every playable season seeds a valid WorldState', () => {
    for (const seasonId of PLAYABLE_SEASON_IDS) {
        const state = seed(seasonId);
        const validation = validateWorldState(state);
        assert.equal(validation.ok, true, `${seasonId}: ${JSON.stringify(validation.errors)}`);

        if (seasonId === 'sandbox') {
            assert.equal(state.threats.length, 0);
            assert.deepEqual(state.beats, {});
        }
    }

    const dark = seed('s1dark');
    assert.equal(dark.player.identity, 'canon');
    assert.equal(dark.player.characterId, 's1dark.carol.bleeding-heart');
    assert.equal(dark.characters['s1dark.carol.bleeding-heart'].controlledBy, 'player');
    assert.ok(
        !selectNpcPool(dark).some((character) => character.charId === 's1dark.carol.bleeding-heart'),
    );
});

test('seeding is deterministic apart from startedAt', () => {
    const first = seed('s1');
    const second = seed('s1');
    assert.deepEqual(first, second);

    const later = seed('s1', { now: NOW + 999 });
    assert.notEqual(later.meta.startedAt, first.meta.startedAt);
    later.meta.startedAt = first.meta.startedAt;
    assert.deepEqual(later, first);
});

test('roster, locations, factions, threats, and beats are seeded from data', () => {
    const season = seasons.s1;
    const state = seed('s1');

    assert.deepEqual(
        Object.keys(state.characters).sort(),
        season.roster.map((member) => member.characterId).sort(),
    );
    assert.deepEqual(
        Object.keys(state.locations).sort(),
        locations.locations.map((location) => location.id).sort(),
    );
    assert.deepEqual(
        Object.keys(state.factions).sort(),
        season.factions.map((faction) => faction.id).sort(),
    );
    assert.deepEqual(
        state.threats.map((threat) => threat.id).sort(),
        season.threats.map((threat) => threat.id).sort(),
    );
    assert.deepEqual(
        Object.keys(state.beats).sort(),
        season.canonBeats.map((beat) => beat.id).sort(),
    );

    const vaiva = state.characters['s1.vaiva.colorgarde'];
    assert.equal(vaiva.formId, 's1.vaiva.colorgarde');
    assert.equal(vaiva.controlledBy, 'npc');
    assert.equal(state.locations[season.startLocationId].visited, true);
    assert.equal(state.locations['petrabyte-tower'].visited, season.startLocationId === 'petrabyte-tower');
    assert.equal(state.scene.locationId, season.startLocationId);
    assert.deepEqual(
        state.scene.present.sort(),
        season.roster
            .filter((member) => member.locationId === season.startLocationId)
            .map((member) => member.characterId)
            .sort(),
    );
    assert.ok(state.threats.every((threat) => threat.stage === 0 && threat.status === 'active'));
    assert.ok(Object.values(state.beats).every((beat) => beat.status === 'open'));
});

test('custom persona is the default without a default player character', () => {
    const state = seed('s4');
    assert.equal(state.player.identity, 'custom');
    assert.equal(state.player.characterId, null);
    assert.equal(state.player.displayName, 'The Player');

    const explicit = seed('s1dark', {
        player: { identity: 'custom', displayName: 'Vex', personaNotes: 'A stranger.' },
    });
    assert.equal(explicit.player.identity, 'custom');
    assert.equal(explicit.player.characterId, null);
    assert.equal(explicit.player.displayName, 'Vex');
    assert.equal(explicit.player.personaNotes, 'A stranger.');
    assert.equal(explicit.characters['s1dark.carol.bleeding-heart'].controlledBy, 'npc');
});

test('validateWorldState reports missing references and invalid enums without throwing', () => {
    const missingCharacter = seed('s1');
    delete missingCharacter.characters['s1.aurelia.longshot'];
    const missingCharacterResult = validateWorldState(missingCharacter);
    assert.equal(missingCharacterResult.ok, false);
    assert.ok(missingCharacterResult.errors.some((error) => error.path.startsWith('scene.present')));

    const missingLocation = seed('s1');
    missingLocation.characters['s1.vaiva.colorgarde'].locationId = 'no-such-location';
    const missingLocationResult = validateWorldState(missingLocation);
    assert.ok(
        missingLocationResult.errors.some(
            (error) => error.path === 'characters.s1.vaiva.colorgarde.locationId',
        ),
    );

    const missingBeat = seed('s1');
    missingBeat.recentEvents[0].beatId = 'no-such-beat';
    const missingBeatResult = validateWorldState(missingBeat);
    assert.ok(
        missingBeatResult.errors.some((error) => error.path === 'recentEvents[0].beatId'),
    );

    const invalidEnums = seed('s1');
    invalidEnums.mode = 'theatre';
    invalidEnums.characters['s1.vaiva.colorgarde'].status = 'zombie';
    const invalidEnumsResult = validateWorldState(invalidEnums);
    assert.ok(invalidEnumsResult.errors.some((error) => error.path === 'mode'));
    assert.ok(
        invalidEnumsResult.errors.some(
            (error) => error.path === 'characters.s1.vaiva.colorgarde.status',
        ),
    );

    const notAnObject = validateWorldState('nope');
    assert.equal(notAnObject.ok, false);
});

test('migrations normalize v0, preserve unknown keys, and never downgrade', () => {
    assert.equal(migrateWorldState(null), null);
    assert.equal(migrateWorldState(undefined), null);
    assert.throws(() => migrateWorldState('not-a-state'), /Invalid WorldState document/);

    const v0 = {
        chatId: 'legacy-chat',
        seasonId: 's1',
        meta: { turn: '4' },
        unknownExtension: { keep: true },
    };
    const migrated = migrateWorldState(v0);
    assert.equal(migrated.schemaVersion, CURRENT_WORLD_STATE_VERSION);
    assert.deepEqual(migrated.unknownExtension, { keep: true });
    assert.equal(migrated.meta.turn, 4);
    assert.equal(migrated.meta.timeOfDay, 'evening');
    assert.equal(migrated.player.identity, 'custom');
    assert.deepEqual(migrated.characters, {});
    assert.equal(validateWorldState(migrated).ok, true);

    const future = { schemaVersion: 99, chatId: 'future', mystery: true };
    assert.deepEqual(migrateWorldState(future), future);
});

test('an empty metadata store seeds a valid state for every playable season', () => {
    for (const seasonId of PLAYABLE_SEASON_IDS) {
        const store = createWorldStateStore(storeOptions({ chatId: `empty-${seasonId}` }));
        const state = store.seed({
            season: seasons[seasonId],
            registry,
            factions,
            locations,
            formGroups,
            formRules,
            chatId: `empty-${seasonId}`,
            now: NOW,
        });
        assert.equal(validateWorldState(state).ok, true);
        store.dispose();
    }
});

test('store round-trips through chat metadata', () => {
    const metadata = {};
    const storage = memoryStorage();
    const store = createWorldStateStore(storeOptions({ metadata, storage }));
    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'round-trip',
        now: NOW,
    });
    store.dispatch({ type: 'TICK_TIME', turns: 3, date: '2037-03-04' });
    store.saveNow();

    const fresh = createWorldStateStore(storeOptions({ metadata, storage }));
    const loaded = fresh.get();
    assert.deepEqual(loaded, store.get());
    assert.equal(loaded.meta.turn, 3);
    assert.equal(loaded.meta.inGameDate, '2037-03-04');
    assert.equal(storage.getItem(store.walKey()), null);
    store.dispose();
    fresh.dispose();
});

test('WAL recovers in-flight state, is chat-scoped, and is cleared by saveNow', () => {
    const storage = memoryStorage();
    const metadata = {};
    let clock = NOW;
    const store = createWorldStateStore(
        storeOptions({
            metadata,
            storage,
            chatId: 'wal-chat',
            now: () => clock,
        }),
    );
    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'wal-chat',
        now: NOW,
    });
    store.dispatch({ type: 'TICK_TIME', turns: 1 });
    assert.ok(store.walKey().includes('wal-chat'));
    assert.ok(store.walKey().startsWith(WAL_PREFIX));
    assert.ok(storage.getItem(store.walKey()));

    clock += 10;
    const recovered = createWorldStateStore(
        storeOptions({
            metadata: {},
            storage,
            chatId: 'wal-chat',
            now: () => clock,
        }),
    );
    const fromWal = recovered.get();
    assert.equal(fromWal.chatId, 'wal-chat');
    assert.equal(fromWal.meta.turn, 1);
    assert.equal(recovered.recoverFromWal('other-chat'), null);

    store.saveNow();
    assert.equal(storage.getItem(store.walKey()), null);
    recovered.dispose();
    store.dispose();
});

test('debounced saves coalesce, flush persists, and dispose cancels', () => {
    const metadata = {};
    const scheduled = [];
    const cancelled = [];
    let saves = 0;
    const store = createWorldStateStore({
        metadata,
        storage: memoryStorage(),
        schedule(callback) {
            scheduled.push(callback);
            return scheduled.length;
        },
        cancel(handle) {
            cancelled.push(handle);
        },
        now: () => NOW,
        context: CONTEXT,
        saveMetadataDebounced() {
            saves += 1;
        },
    });

    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'debounce-chat',
        now: NOW,
    });
    assert.equal(scheduled.length, 1);

    store.dispatch({ type: 'TICK_TIME', turns: 1 });
    store.dispatch({ type: 'TICK_TIME', turns: 1 });
    assert.equal(scheduled.length, 1);
    assert.equal(metadata[METADATA_KEY], undefined);

    scheduled[0]();
    assert.equal(saves, 1);
    assert.equal(metadata[METADATA_KEY].worldState.meta.turn, 2);

    store.dispatch({ type: 'TICK_TIME', turns: 1 });
    assert.equal(scheduled.length, 2);
    store.flush();
    assert.equal(saves, 2);
    assert.equal(metadata[METADATA_KEY].worldState.meta.turn, 3);
    assert.equal(cancelled.length, 1);

    store.dispatch({ type: 'TICK_TIME', turns: 1 });
    const savesBeforeDispose = saves;
    store.dispose();
    assert.equal(cancelled.length, 2);
    assert.equal(saves, savesBeforeDispose);
});

test('swipe snapshots restore exactly and leave other swipes untouched', () => {
    const store = createWorldStateStore(storeOptions({ chatId: 'snapshots' }));
    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'snapshots',
        now: NOW,
    });

    const message = { extra: { neoterra: { snapshots: { 2: { marker: true } } } } };
    const first = store.snapshotForSwipe(message, 0);
    store.dispatch({ type: 'TICK_TIME', turns: 5 });
    const second = store.snapshotForSwipe(message, 1);
    store.dispatch({ type: 'TICK_TIME', turns: 5 });

    assert.equal(store.hasSnapshot(message, 0), true);
    assert.equal(store.hasSnapshot(message, 9), false);
    assert.deepEqual(store.restoreSnapshot(message, 0), first);
    assert.deepEqual(store.get(), first);
    assert.deepEqual(store.restoreSnapshot(message, 1), second);
    assert.deepEqual(store.get(), second);
    assert.equal(store.restoreSnapshot(message, 9), null);
    assert.deepEqual(message.extra.neoterra.snapshots['2'], { marker: true });
    assert.deepEqual(message.extra.neoterra.snapshots['0'], first);
    store.dispose();
});

test('a corrupted swipe snapshot is reported and ignored', () => {
    const errors = [];
    const store = createWorldStateStore(storeOptions({
        chatId: 'corrupt-snapshot',
        onError: (error) => errors.push(error),
    }));
    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'corrupt-snapshot',
        now: NOW,
    });
    const before = cloneWorldState(store.get());
    const message = {
        extra: { neoterra: { snapshots: { 0: { schemaVersion: 1, chatId: 'corrupt-snapshot' } } } },
    };

    assert.equal(store.restoreSnapshot(message, 0), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Invalid WorldState/);
    assert.deepEqual(store.get(), before);
    store.dispose();
});

test('metadata helpers read and write only the neoterra slot', () => {
    const metadata = { otherExtension: { keep: true } };
    const state = seed('s1');
    saveWorldStateToMetadata(metadata, state, 123);
    assert.equal(metadata.otherExtension.keep, true);
    assert.equal(metadata[METADATA_KEY].savedAt, 123);
    assert.deepEqual(loadWorldStateFromMetadata(metadata), state);
    assert.equal(loadWorldStateFromMetadata({}), null);
});

test('selectors resolve present cast, NPC pool, player view, beats, and bad ends', () => {
    const state = seed('s1dark');
    const present = selectPresentCast(state);
    assert.equal(present.length, state.scene.present.length);
    assert.ok(present.every((character) => character.locationId === state.scene.locationId));

    const playerView = selectPlayerView(state);
    assert.equal(playerView.character.charId, 's1dark.carol.bleeding-heart');
    assert.equal(playerView.form, playerView.character.formId);

    const npcPool = selectNpcPool(state);
    assert.ok(!npcPool.some((character) => character.controlledBy === 'player'));
    const dead = applyWorldEvent(
        state,
        { type: 'SET_STATUS', characterId: 's1dark.aurelia.season-dark-version', status: 'dead' },
        CONTEXT,
    );
    assert.ok(
        !selectNpcPool(dead).some(
            (character) => character.charId === 's1dark.aurelia.season-dark-version',
        ),
    );

    assert.ok(selectLocation(state, 'clarity-hq'));
    assert.ok(selectFaction(state, 'clarity'));
    assert.ok(selectThreat(state, 's1dark.threat.resistance'));
    assert.equal(selectCharacter(state, 's1dark.carol.bleeding-heart').formId, 's1dark.carol.bleeding-heart');

    const beats = selectOpenBeats(state, seasons.s1dark);
    assert.equal(beats.length, seasons.s1dark.canonBeats.length);
    assert.deepEqual(
        beats.map((beat) => beat.order),
        [...beats.map((beat) => beat.order)].sort((a, b) => a - b),
    );
    const first = beats[0];
    assert.ok(selectBeat(state, first.id));
    const resolved = applyWorldEvent(state, { type: 'RESOLVE_BEAT', beatId: first.id }, CONTEXT);
    assert.ok(!selectOpenBeats(resolved, seasons.s1dark).some((beat) => beat.id === first.id));

    const withBadEnd = applyWorldEvent(
        state,
        {
            type: 'RECORD_BAD_END',
            characterId: 's1dark.aurelia.season-dark-version',
            badEndType: 'death',
            cause: 'Test',
            continuityKey: 'selector-key',
        },
        CONTEXT,
    );
    const badEnds = selectBadEnds(withBadEnd);
    assert.equal(badEnds.length, 1);
    assert.equal(badEnds[0].characterId, 's1dark.aurelia.season-dark-version');
    assert.equal(badEnds[0].type, 'death');
});

test('cloneWorldState produces an independent document', () => {
    const state = seed('s1');
    const cloned = cloneWorldState(state);
    cloned.characters['s1.vaiva.colorgarde'].notes = 'changed';
    assert.notEqual(state.characters['s1.vaiva.colorgarde'].notes, 'changed');
});
