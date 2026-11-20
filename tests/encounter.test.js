import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    OPPOSITE_SIDE,
    SURPRISED_COMBAT_ACTIONS,
    buildNoticeFrameText,
    describeEncounter,
    detectEncounter,
    detectNotice,
    encounterKey,
    encounterNames,
    isCombatActive,
    isSurprisedCombat,
    playerSideFor,
    threatRank,
} from '../src/flows/encounter.js';
import {
    avoidEncounter,
    buildCombatResolutionFrameText,
    buildEncounterBarModel,
    encounterActorId,
    encounterFromCombat,
    engageEncounter,
    endEncounterCombat,
    markAmbushOpening,
    startEncounterCombat,
    surrenderEncounterCombat,
} from '../src/ui/encounter-bar.js';
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

test('the encounter bar model offers Engage, Talk, and Avoid for hostile characters', () => {
    const encounter = {
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
        source: 'travel',
    };
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        encounter,
    });
    const model = buildEncounterBarModel({ state });
    assert.equal(model.visible, true);
    assert.equal(model.mode, 'encounter');
    assert.equal(model.key, encounterKey(encounter));
    assert.equal(model.locationId, 'loc.a');
    assert.equal(model.encounter, encounter);
    assert.deepEqual(model.actions.map((action) => action.id), ['engage', 'talk', 'avoid']);
    assert.equal(model.actions[0].enabled, true);
    assert.equal(model.actions[0].reason, null);
    assert.equal(model.actions[1].enabled, true);
    assert.equal(model.actions[2].enabled, true);
});

test('a threat-only encounter disables Engage with a reason', () => {
    const encounter = {
        locationId: 'loc.a',
        characterIds: [],
        threatNames: ['Glass Cartel'],
        source: 'scene',
    };
    const model = buildEncounterBarModel({ state: makeState({ encounter }) });
    assert.equal(model.visible, true);
    assert.equal(model.mode, 'encounter');
    assert.equal(model.actions[0].id, 'engage');
    assert.equal(model.actions[0].enabled, false);
    assert.match(model.actions[0].reason, /prose/);
});

test('active combat shows Surrender and End immediately; no encounter hides the bar', () => {
    const combat = { id: 'combat-1', participants: ['player', 'c.villain'], round: 1 };
    const combatState = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        encounter: { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] },
        combat,
    });
    const combatModel = buildEncounterBarModel({ state: combatState });
    assert.equal(combatModel.visible, true);
    assert.equal(combatModel.mode, 'combat');
    assert.equal(combatModel.encounter, null);
    assert.equal(combatModel.key, null);
    assert.equal(combatModel.combat, combat);
    assert.deepEqual(combatModel.actions.map((action) => action.id), ['surrender', 'end']);

    assert.equal(buildEncounterBarModel({ state: makeState({}) }).visible, false);
    assert.deepEqual(buildEncounterBarModel(null), { visible: false });
    assert.deepEqual(buildEncounterBarModel(undefined), { visible: false });
    assert.deepEqual(buildEncounterBarModel({ state: null }), { visible: false });
});

test('an avoided key hides the same encounter and a different key shows it again', () => {
    const encounter = {
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
        source: 'travel',
    };
    const key = encounterKey(encounter);
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        encounter,
    });
    state.flags.encounter = { avoidedKey: key };
    const avoided = buildEncounterBarModel({ state });
    assert.equal(avoided.visible, false);
    assert.equal(avoided.reason, 'avoided');
    assert.equal(avoided.key, key);

    state.flags.encounter = { avoidedKey: 'loc.b|other|' };
    assert.equal(buildEncounterBarModel({ state }).visible, true);
});

test('the encounter actor is the canon id for a canon player and "player" otherwise', () => {
    assert.equal(encounterActorId(makeState({})), 'player');
    const canon = makeState({
        player: {
            identity: 'canon',
            characterId: 'c.player',
            displayName: 'Vaiva',
            side: 'hero',
            controlledBy: 'player',
            alive: true,
        },
    });
    assert.equal(encounterActorId(canon), 'c.player');
});

test('avoidEncounter records the avoided key immutably and never throws', () => {
    const encounter = { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] };
    const state = makeState({});
    let current = state;
    const store = {
        get: () => current,
        replace: (next) => {
            current = next;
        },
    };
    const next = avoidEncounter(store, encounter);
    assert.ok(next);
    assert.equal(current.flags.encounter.avoidedKey, encounterKey(encounter));
    assert.equal(typeof current.flags.encounter.avoidedAt, 'number');
    assert.equal(state.flags.encounter, undefined, 'the previous state is untouched');

    assert.equal(avoidEncounter(store, null), null);
    assert.equal(avoidEncounter(null, encounter), null);
    assert.equal(avoidEncounter({
        get() {
            throw new Error('read-failed');
        },
        replace() {},
    }, encounter), null);
    assert.equal(avoidEncounter({
        get: () => current,
        replace() {
            throw new Error('write-failed');
        },
    }, encounter), null);
});

test('startEncounterCombat calls the flow once with player and hostiles', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire' }) },
    });
    const calls = [];
    const flow = {
        start(payload) {
            calls.push(payload);
            return { ok: true, combat: { id: 'combat-1', participants: payload.participants } };
        },
        getState() {
            return { scene: { combat: null } };
        },
    };
    const encounter = {
        locationId: 'loc.a',
        characterIds: ['c.villain', 'c.villain', 'player'],
        threatNames: [],
    };
    const result = startEncounterCombat({ flow, state, encounter });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, 'start is called exactly once');
    assert.deepEqual(calls[0].participants, ['player', 'c.villain']);
    assert.deepEqual(calls[0].sides, { player: 'a', 'c.villain': 'b' });
    assert.equal(calls[0].locationId, 'loc.a');
    assert.equal(calls[0].kind, 'skirmish');
    assert.ok(calls[0].stakes.length > 0);
    assert.match(result.text, /Combat begins at Arcade: The Player against Claire\./);
    assert.match(result.text, /Stakes: /);
    assert.equal(result.combat.id, 'combat-1');

    const threatOnly = startEncounterCombat({
        flow,
        state,
        encounter: { locationId: 'loc.a', characterIds: [], threatNames: ['Glass Cartel'] },
    });
    assert.equal(threatOnly.ok, false);
    assert.equal(threatOnly.reason, 'threat-only');
    assert.equal(calls.length, 1, 'threat-only never calls the flow');
});

test('a failing flow start returns ok false with no frame text', () => {
    const state = makeState({});
    const failed = startEncounterCombat({
        flow: {
            start: () => ({ ok: false, reason: 'combat-active', message: 'A conflict is already active' }),
        },
        state,
        encounter: { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'combat-active');
    assert.equal(failed.message, 'A conflict is already active');
    assert.equal(failed.text, undefined);
});

test('surrender and end call the flow and pass the reason', () => {
    const calls = [];
    const flow = {
        surrender() {
            calls.push(['surrender']);
            return { ok: true, ended: true, endReason: 'surrender' };
        },
        end(options) {
            calls.push(['end', options]);
            return { ok: true, ended: true, endReason: options.reason };
        },
    };
    assert.equal(surrenderEncounterCombat(flow).endReason, 'surrender');
    const ended = endEncounterCombat(flow, { reason: 'scene-end' });
    assert.equal(ended.endReason, 'scene-end');
    assert.deepEqual(calls, [['surrender'], ['end', { reason: 'scene-end' }]]);
    assert.deepEqual(surrenderEncounterCombat(null), { ok: false, reason: 'no-flow' });
    assert.deepEqual(endEncounterCombat(undefined), { ok: false, reason: 'no-flow' });
});

test('combat frame text is deterministic prose only', () => {
    assert.equal(
        buildCombatResolutionFrameText({ state: { flags: {} }, result: { endReason: 'surrender' } }),
        'Combat ends — surrender.',
    );
    const withSummary = {
        flags: { lastCombat: { endReason: 'stamina-zero', summary: 'skirmish ended: stamina-zero' } },
    };
    assert.equal(
        buildCombatResolutionFrameText({ state: withSummary, result: null }),
        'Combat ends — stamina-zero.\n\nskirmish ended: stamina-zero',
    );
    assert.equal(buildCombatResolutionFrameText(), 'Combat ends — resolved.');
});

test('engageEncounter starts once, posts one combat frame, then requests combat choices', async () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire' }) },
    });
    const encounter = {
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
        source: 'travel',
    };
    let starts = 0;
    const posts = [];
    const choices = [];
    const flow = {
        start(payload) {
            starts += 1;
            return { ok: true, combat: { id: 'combat-9', participants: payload.participants } };
        },
    };
    const result = await engageEncounter({
        flow,
        state,
        encounter,
        chatId: 'c1',
        post: async (message, key) => {
            posts.push({ message, key });
            return { posted: true, index: 4 };
        },
        requestChoices: async (index) => { choices.push(index); },
        now: () => NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(starts, 1, 'start is called exactly once');
    assert.equal(posts.length, 1, 'exactly one combat frame is posted');
    assert.equal(posts[0].message.extra.neoterra.scene.kind, 'combat');
    assert.ok(!posts[0].key.startsWith('travel:'));
    assert.match(posts[0].message.mes, /Combat begins at Arcade/);
    assert.deepEqual(choices, [4], 'combat choices use the posted index');
});

test('a failed engage posts nothing and returns the flow reason', async () => {
    const state = makeState({});
    let posts = 0;
    const result = await engageEncounter({
        flow: {
            start: () => ({ ok: false, reason: 'combat-active', message: 'A conflict is already active' }),
        },
        state,
        encounter: { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] },
        post: async () => { posts += 1; return { posted: true, index: 1 }; },
        requestChoices: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.message, 'A conflict is already active');
    assert.equal(posts, 0);
});

test('encounterFromCombat recovers the hostile ids after scene.encounter clears', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        encounter: null,
        combat: {
            id: 'combat-2',
            locationId: 'loc.a',
            participants: ['player', 'c.villain'],
            round: 1,
        },
    });
    const encounter = encounterFromCombat(state);
    assert.deepEqual(encounter, {
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
        source: 'scene',
    });
    assert.equal(encounterKey(encounter), encounterKey({
        locationId: 'loc.a',
        characterIds: ['c.villain'],
        threatNames: [],
    }));
    assert.equal(encounterFromCombat(makeState({})), null);

    const canonical = makeState({
        player: {
            identity: 'canon',
            characterId: 'c.player',
            displayName: 'Vaiva',
            controlledBy: 'player',
            alive: true,
            side: 'hero',
        },
        characters: { 'c.player': character('c.player', 'hero', { controlledBy: 'player' }), 'c.villain': character('c.villain', 'villain') },
        combat: { locationId: 'loc.a', participants: ['c.player', 'c.villain'], round: 1 },
    });
    assert.deepEqual(encounterFromCombat(canonical).characterIds, ['c.villain']);
});

test('the bar model hides a stale encounter recorded at another location', () => {
    const state = makeState({ encounter: { locationId: 'loc.b', characterIds: ['c.villain'], threatNames: [] } });
    const model = buildEncounterBarModel({ state });
    assert.equal(model.visible, false);
    assert.equal(model.reason, 'stale-location');
});

test('avoidEncounter uses the injected clock', () => {
    let current = makeState({});
    const store = {
        get: () => current,
        replace: (next) => { current = next; },
    };
    avoidEncounter(store, { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] }, { now: () => 1234 });
    assert.equal(current.flags.encounter.avoidedAt, 1234);
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

/* ------------------------------------------------------------------ *
 * Step 8: notice-first and deterministic ambush
 * ------------------------------------------------------------------ */

function noticeState({ status = 'quiet', characterIds = ['c.villain'], threatLevels = null } = {}) {
    const state = makeState({
        characters: Object.fromEntries(characterIds.map((id) => [
            id,
            {
                ...character(id, 'villain', { displayName: id === 'c.villain' ? 'Claire' : id }),
                threatLevel: threatLevels?.[id] ?? null,
            },
        ])),
    });
    state.locations['loc.a'].status = status;
    state.scene.encounter = {
        locationId: 'loc.a',
        characterIds,
        threatNames: [],
        source: 'travel',
    };
    return state;
}

function strongSeedFor(state, encounter) {
    for (let index = 0; index < 500; index += 1) {
        const seed = `seed-${index}`;
        const notice = detectNotice({ state, encounter, seed });
        if (notice && notice.margin >= 5) {
            return seed;
        }
    }
    throw new Error('no strong-success seed found');
}

test('the same seed and encounter always produce the same notice result', () => {
    const state = noticeState();
    const encounter = state.scene.encounter;
    const seed = strongSeedFor(state, encounter);
    const first = detectNotice({ state, encounter, seed });
    const second = detectNotice({ state, encounter, seed });
    assert.deepEqual(first, second);
    assert.equal(typeof first?.die, 'number');
});

test('no encounter, active combat, or noticeFirst:false yields null', () => {
    const state = noticeState();
    const encounter = state.scene.encounter;
    assert.equal(detectNotice({ state, encounter: null, seed: 1 }), null);
    assert.equal(detectNotice({ state: { ...state, scene: { ...state.scene, encounter: null } }, seed: 1 }), null);
    assert.equal(detectNotice({ state, encounter, seed: 1, noticeFirst: false }), null);
    const combatState = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        encounter,
        combat: { id: 'combat-1', participants: ['player', 'c.villain'] },
    });
    assert.equal(detectNotice({ state: combatState, encounter, seed: 1 }), null);
});

test('a strong hostile success is an ambush only in a hostile/contested location', () => {
    const base = noticeState();
    const encounter = base.scene.encounter;
    const seed = strongSeedFor(base, encounter);
    const hostile = noticeState({ status: 'hostile' });
    hostile.scene.encounter = encounter;
    const ambush = detectNotice({ state: hostile, encounter, seed, ambush: true });
    assert.equal(ambush.noticedFirst, true);
    assert.equal(ambush.ambush, true);
    const stable = noticeState({ status: 'stable' });
    stable.scene.encounter = encounter;
    const noticed = detectNotice({ state: stable, encounter, seed, ambush: true });
    assert.equal(noticed.noticedFirst, true);
    assert.equal(noticed.ambush, false);
    const demoted = detectNotice({ state: hostile, encounter, seed, ambush: false });
    assert.equal(demoted.ambush, false);
    assert.equal(demoted.noticedFirst, true);
});

test('the most threatening hostile names the notice, ties by id', () => {
    const state = noticeState({
        characterIds: ['c.low', 'c.high', 'c.a', 'c.b'],
        threatLevels: { 'c.low': 'low', 'c.high': 'high', 'c.a': 'medium', 'c.b': 'medium' },
    });
    const encounter = state.scene.encounter;
    const notice = detectNotice({ state, encounter, seed: 'fixed-seed' });
    assert.equal(notice.actorId, 'c.high');
    assert.equal(threatRank(state.characters['c.high']), 3);
    const tieState = noticeState({
        characterIds: ['c.b', 'c.a'],
        threatLevels: { 'c.a': 'medium', 'c.b': 'medium' },
    });
    const tie = detectNotice({ state: tieState, encounter: tieState.scene.encounter, seed: 'fixed-seed' });
    assert.equal(tie.actorId, 'c.a');
});

test('a stealth-coded arrival suppresses the notice entirely', () => {
    const state = noticeState();
    state.player.abilities = ['Stealth suit'];
    assert.equal(detectNotice({ state, encounter: state.scene.encounter, seed: 'fixed-seed' }), null);
    const clean = noticeState();
    assert.equal(detectNotice({
        state: clean,
        encounter: clean.scene.encounter,
        seed: 'fixed-seed',
        stealth: true,
    }), null);
});

test('a threat-only encounter never names a notice actor', () => {
    const state = noticeState();
    state.scene.encounter = { locationId: 'loc.a', characterIds: [], threatNames: ['The Beast'] };
    assert.equal(detectNotice({ state, encounter: state.scene.encounter, seed: 'fixed-seed' }), null);
});

test('notice frames name the actor and carry no numbers or prompt blocks', () => {
    const state = noticeState({ status: 'hostile' });
    const encounter = state.scene.encounter;
    const seed = strongSeedFor(state, encounter);
    const notice = detectNotice({ state, encounter, seed, ambush: true });
    const ambushText = buildNoticeFrameText({ state, notice });
    assert.match(ambushText, /Claire/);
    assert.match(ambushText, /springs the ambush/);
    const plain = buildNoticeFrameText({
        state,
        notice: { ...notice, ambush: false },
    });
    assert.match(plain, /spots you before you can act/);
    for (const text of [ambushText, plain]) {
        assert.doesNotMatch(text, /\d/);
        assert.doesNotMatch(text, /\[NEOTERRA_/);
    }
});

test('the scene block and intro carry the recorded ambush actor', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain', { displayName: 'Claire' }) },
    });
    state.scene.ambush = { actorId: 'c.villain', actorName: 'Claire', at: NOW };
    const rendered = renderContext(state, { settings: cloneDefaults() });
    assert.match(rendered.text, /Ambushed by: Claire/);
    const intro = buildLocationIntro({ state });
    assert.match(intro.text, /Claire sprang the ambush before you could move\./);
});

test('markAmbushOpening flags the opening round and the bar shows Surprised', () => {
    const state = makeState({
        characters: { 'c.villain': character('c.villain', 'villain') },
        combat: { id: 'combat-1', participants: ['player', 'c.villain'], round: 0, opening: null },
    });
    const writes = [];
    const store = {
        get: () => state,
        replace: (next) => {
            writes.push(next);
        },
    };
    const next = markAmbushOpening(store, { now: () => NOW });
    assert.equal(writes.length, 1);
    assert.equal(next.scene.combat.opening, 'hostile');
    assert.equal(next.flags.lastCombat.ambush, true);
    assert.equal(isSurprisedCombat(next), true);
    assert.deepEqual([...SURPRISED_COMBAT_ACTIONS].sort(), ['defend', 'retreat', 'surrender', 'talk-down']);
    const model = buildEncounterBarModel({ state: next });
    assert.equal(model.visible, true);
    assert.equal(model.surprised, true);
    assert.match(model.title, /Surprised/);
    assert.equal(isSurprisedCombat({
        ...next,
        scene: { ...next.scene, combat: { ...next.scene.combat, round: 1 } },
    }), false);
});
