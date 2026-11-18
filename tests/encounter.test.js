import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    OPPOSITE_SIDE,
    describeEncounter,
    detectEncounter,
    encounterKey,
    encounterNames,
    isCombatActive,
    playerSideFor,
} from '../src/flows/encounter.js';
import { buildLocationIntro, createSceneFlow } from '../src/flows/scene.js';
import { renderContext } from '../src/context/renderer.js';
import { validateWorldState } from '../src/state/world-state.js';
import { createWorldStateStore } from '../src/state/store.js';
import { cloneDefaults } from '../src/core/defaults.js';

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
const seasonDark = readJson('data/seasons/s1dark.json');
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function character(charId, side, { alive = true, displayName = null, controlledBy = 'npc' } = {}) {
    return {
        charId,
        displayName: displayName ?? charId,
        side,
        alive,
        controlledBy,
        status: 'active',
    };
}

function makeState({ playerRole = 'hero', player = null, characters = {}, encounter = null, present = [], combat = null } = {}) {
    return {
        chatId: 'encounter-test',
        seasonId: 's1',
        playerRole,
        player: player ?? {
            identity: 'custom',
            characterId: null,
            displayName: 'The Player',
            side: playerRole === 'villain' ? 'villain' : 'neutral',
            controlledBy: 'player',
            alive: true,
        },
        characters,
        locations: {
            'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Hub', factionId: null, status: 'quiet' },
            'loc.b': { id: 'loc.b', name: 'Docks', district: 'West', factionId: null, status: 'quiet' },
        },
        factions: {},
        threats: [],
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [],
        scene: { locationId: 'loc.a', present, combat, framing: '', encounter },
        meta: { turn: 3, inGameDate: '2038-01-01', timeOfDay: 'night', sceneId: 'opening', inCombat: false },
        flags: {},
        log: [],
    };
}

function seededStore({ seasonDefinition = season, player = { identity: 'custom' }, chatId = 'encounter-test' } = {}) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
        now: () => NOW,
    });
    store.seed({
        season: seasonDefinition,
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

/** Move one seeded NPC to the player's location through the real reducer. */
function moveToPlayer(store, characterId) {
    const state = store.get();
    store.dispatch({
        type: 'MOVE_CHARACTER',
        characterId,
        locationId: state.scene.locationId,
    });
    return store.get();
}

test('side helpers', () => {
    assert.equal(playerSideFor('villain'), 'villain');
    assert.equal(playerSideFor('hero'), 'hero');
    assert.equal(playerSideFor('neutral'), 'hero');
    assert.equal(playerSideFor(undefined), 'hero');
    assert.deepEqual(OPPOSITE_SIDE, { hero: 'villain', villain: 'hero' });
});

test('a living villain at the location is an encounter for a hero player', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire' }) },
    });
    const encounter = detectEncounter({ state, present: ['c.villain'] });
    assert.deepEqual(encounter, {
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
        source: 'scene',
    });
});

test('a living hero at the location is an encounter for a villain player (S1Dark)', () => {
    const state = makeState({ playerRole: 'villain' });
    const encounter = detectEncounter({
        state,
        present: ['c.hero'],
        playerRole: 'villain',
    });
    state.characters['c.hero'] = character('c.hero', 'hero');
    const detected = detectEncounter({ state, present: ['c.hero'], playerRole: 'villain' });
    assert.equal(encounter, null, 'unknown characters never trigger');
    assert.deepEqual(detected.characterIds, ['c.hero']);
    assert.equal(detected.source, 'scene');
});

test('same-side villains are allies, and neutral characters never trigger', () => {
    const state = makeState({
        playerRole: 'villain',
        characters: {
            'c.villain': character('c.villain', 'villain'),
            'c.neutral': character('c.neutral', 'neutral'),
            'c.hero': character('c.hero', 'hero'),
        },
    });
    assert.equal(detectEncounter({ state, present: ['c.villain'], playerRole: 'villain' }), null);
    assert.equal(detectEncounter({ state, present: ['c.neutral'] }), null);
    assert.equal(detectEncounter({ state, present: [] }), null);
});

test('dead, player-controlled, and self entries are ignored', () => {
    const state = makeState({
        player: { identity: 'canon', characterId: 'c.player', displayName: 'Vaiva', controlledBy: 'player', alive: true, side: 'hero' },
        characters: {
            'c.dead': character('c.dead', 'villain', { alive: false }),
            'c.player': character('c.player', 'hero', { controlledBy: 'player' }),
            'c.ally': character('c.ally', 'hero'),
        },
    });
    assert.equal(detectEncounter({ state, present: ['c.dead', 'c.player', 'c.ally'] }), null);
});

test('an active threat at the location is an encounter with no character ids', () => {
    const state = makeState({ characters: {} });
    const encounter = detectEncounter({
        state,
        present: [],
        threatNames: ['Glass Cartel', 'Glass Cartel', ''],
    });
    assert.deepEqual(encounter, {
        locationId: 'loc.a',
        characterIds: [],
        threatNames: ['Glass Cartel'],
        source: 'scene',
    });
    assert.equal(encounterKey(encounter), 'loc.a||Glass Cartel');
});

test('an active combat or the legacy combat flag suppresses detection', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        combat: { locationId: 'loc.a', participants: [], round: 1 },
    });
    assert.equal(isCombatActive(state), true);
    assert.equal(detectEncounter({ state, present: ['c.villain'] }), null);

    const legacy = makeState({ characters: { 'c.villain': character('c.villain', 'villain') } });
    legacy.meta.inCombat = true;
    assert.equal(detectEncounter({ state: legacy, present: ['c.villain'] }), null);
});

test('travel and scene sources are normalized', () => {
    const state = makeState({ characters: { 'c.villain': character('c.villain', 'villain') } });
    assert.equal(detectEncounter({ state, present: ['c.villain'], source: 'travel' }).source, 'travel');
    assert.equal(detectEncounter({ state, present: ['c.villain'], source: 'nonsense' }).source, 'scene');
});

test('names and the intro paragraph use display names only', () => {
    const encounter = { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: ['Glass Cartel'], source: 'travel' };
    const state = makeState({
        characters: {
            'c.villain': character('c.villain', 'villain', { displayName: 'Claire Atropos' }),
        },
        encounter,
    });
    assert.deepEqual(encounterNames(state, encounter), ['Claire Atropos', 'Glass Cartel']);
    assert.equal(describeEncounter(state, encounter), 'Hostile presence: Claire Atropos, Glass Cartel.');
    assert.equal(describeEncounter(state, null), '');

    const intro = buildLocationIntro({
        state,
        from: { id: 'loc.b', name: 'Docks' },
        travel: { bridges: [], bridgeNames: [], turns: 1 },
    });
    assert.match(intro.text, /Hostile presence: Claire Atropos, Glass Cartel\./);
});

test('the intro omits the encounter paragraph on a peaceful arrival', () => {
    const state = makeState({});
    const intro = buildLocationIntro({ state, from: { id: 'loc.b', name: 'Docks' }, travel: {} });
    assert.doesNotMatch(intro.text, /Hostile presence/);
});

test('an encounter recorded for another location is not narrated', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire' }) },
        encounter: { locationId: 'loc.b', characterIds: ['c.villain'], threatNames: [], source: 'travel' },
    });
    // scene.locationId is loc.a; the stale record belongs to loc.b.
    assert.equal(describeEncounter(state, state.scene.encounter), '');
    const intro = buildLocationIntro({
        state,
        from: { id: 'loc.b', name: 'Docks' },
        travel: { turns: 1 },
    });
    assert.doesNotMatch(intro.text, /Hostile presence/);
});

test('the scene block carries Encounter and Threats here inside [NEOTERRA_SCENE]', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire Atropos' }) },
        present: ['c.villain'],
        encounter: { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: ['Glass Cartel'], source: 'scene' },
    });
    const settings = cloneDefaults();
    const result = renderContext(state, { settings });
    const sceneBlock = result.blocks.find((block) => block.id === 'scene');
    assert.ok(sceneBlock);
    assert.equal(sceneBlock.heading, '[NEOTERRA_SCENE]');
    assert.match(sceneBlock.body, /Encounter: Claire Atropos/);
    assert.match(sceneBlock.body, /Threats here: Glass Cartel/);
    // No new block was added for the encounter.
    assert.equal(result.blocks.some((block) => /encounter/i.test(block.id)), false);

    const off = cloneDefaults();
    off.context.blocks.scene = false;
    const withoutScene = renderContext(state, { settings: off });
    assert.equal(withoutScene.blocks.some((block) => block.id === 'scene'), false);

    const strict = cloneDefaults();
    strict.contentGate = 'strict';
    const gated = renderContext(state, { settings: strict });
    const gatedScene = gated.blocks.find((block) => block.id === 'scene');
    if (gatedScene) {
        assert.doesNotMatch(gatedScene.body, /explicit|lewd/i);
    }
});

test('finalize persists the encounter and clears it on a peaceful arrival', async () => {
    const store = seededStore();
    const state = store.get();
    const villainId = Object.values(state.characters)
        .find((entry) => entry.side === 'villain' && entry.controlledBy === 'npc')?.charId;
    assert.ok(villainId, 'S1 seeds at least one villain');
    moveToPlayer(store, villainId);

    const scene = createSceneFlow({
        store,
        season,
        registry,
        formGroups,
        formRules,
        getSettings: () => ({}),
    });
    const hostile = await scene.refreshCast({ runDirector: false });
    assert.ok(hostile.cast.present.includes(villainId), 'the villain is present');
    assert.ok(hostile.cast.encounter, 'a hostile arrival is an encounter');
    assert.ok(hostile.cast.encounter.characterIds.includes(villainId));
    assert.equal(store.get().scene.encounter.locationId, store.get().scene.locationId);

    // Round-trip: the encounter survives clone/JSON and validation.
    const cloned = JSON.parse(JSON.stringify(store.get()));
    assert.deepEqual(cloned.scene.encounter, store.get().scene.encounter);
    const validation = validateWorldState(cloned);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));

    // Move every villain away: a peaceful refresh clears the encounter.
    const destination = Object.keys(state.locations)
        .find((locationId) => locationId !== state.scene.locationId);
    for (const characterId of hostile.cast.encounter.characterIds) {
        store.dispatch({ type: 'MOVE_CHARACTER', characterId, locationId: destination });
    }
    const peaceful = await scene.refreshCast({ runDirector: false });
    if (!peaceful.cast.present.some((characterId) => (
        store.get().characters[characterId]?.side === 'villain'
    ))) {
        assert.equal(peaceful.cast.encounter?.characterIds?.length ?? 0, 0);
    }
    const settled = store.get().scene.encounter;
    assert.equal(settled === null || (Array.isArray(settled?.characterIds) && settled.characterIds.length === 0), true);
});

test('the scene flow reports the encounter source it was given', async () => {
    const store = seededStore();
    const state = store.get();
    const villainId = Object.values(state.characters)
        .find((entry) => entry.side === 'villain' && entry.controlledBy === 'npc')?.charId;
    assert.ok(villainId);
    moveToPlayer(store, villainId);
    const scene = createSceneFlow({ store, season, registry, formGroups, formRules });
    const result = await scene.refreshCast({ runDirector: false, encounterSource: 'travel' });
    assert.ok(result.cast.encounter, 'the villain triggers an encounter');
    assert.equal(result.cast.encounter.characterIds.includes(villainId), true);
    assert.equal(result.cast.encounter.source, 'travel');
});

test('a villain-POV scene does not treat same-side villains as enemies', async () => {
    const store = seededStore({
        seasonDefinition: seasonDark,
        player: { identity: 'canon', characterId: 's1dark.carol.bleeding-heart' },
        chatId: 'dark-test',
    });
    const state = store.get();
    const villainId = Object.values(state.characters)
        .find((entry) => entry.side === 'villain' && entry.controlledBy !== 'player')?.charId;
    assert.ok(villainId, 'the dark season seeds at least one allied villain');
    moveToPlayer(store, villainId);

    const scene = createSceneFlow({ store, season: seasonDark, registry, formGroups, formRules });
    const result = await scene.refreshCast({ runDirector: false });
    const encounter = result.cast.encounter;
    if (encounter) {
        assert.equal(encounter.characterIds.includes(villainId), false, 'allied villains are not hostiles');
    }
});
