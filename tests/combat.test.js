import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    COMBAT_ACTIONS,
    COMBAT_RISK_TIERS,
    createSeededRng,
    normalizeCombatAction,
    resolveAction,
    rollD20,
} from '../src/combat/resolver.js';
import {
    DEFAULT_TIER_DELTAS,
    OUTCOME_CONTRACT_INSTRUCTION,
    OUTCOME_TIERS,
    buildOutcome,
    outcomeEvents,
} from '../src/combat/outcome.js';
import { createCombatFlow } from '../src/combat/combat-state.js';
import { detectEncounter } from '../src/flows/encounter.js';
import {
    endEncounterCombat,
    encounterActorId,
    startEncounterCombat,
} from '../src/ui/encounter-bar.js';
import { applyWorldEvents } from '../src/state/reducer.js';
import { createWorldStateStore } from '../src/state/store.js';
import { cloneDefaults } from '../src/core/defaults.js';
import { renderContext } from '../src/context/renderer.js';
import { isTravelBlockedByCombat } from '../src/flows/travel.js';
import {
    buildStateTrackerPrompt,
    normalizeStateTrackerResult,
} from '../src/agents/state-tracker.js';
import * as choices from '../src/agents/choices.js';
import * as resolver from '../src/combat/resolver.js';

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
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };

const HERO = 's1.vaiva.colorgarde';
const VILLAIN = 's1.aurelia.longshot';
// Aurelia is a hero card; encounters need an opposing-side (villain) NPC.
const ENCOUNTER_VILLAIN = 's1.claire.atropos';

function makeStore({ seasonId = 's1', player = { identity: 'custom' }, settings = null } = {}) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'combat-test-chat',
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
        chatId: 'combat-test-chat',
        player,
        now: NOW,
    });
    const getSettings = settings === null ? null : () => settings;
    const flow = createCombatFlow({
        store,
        getSettings,
        now: () => NOW,
    });
    return { store, flow };
}

function makeCanonStore(characterId = HERO) {
    return makeStore({ player: { identity: 'canon', characterId } });
}

function byId(result, id) {
    return result.blocks.find((block) => block.id === id) ?? null;
}

test('seeded rolls are deterministic and supplied rolls hit every tier boundary', () => {
    const inputs = {
        seed: 99,
        round: 2,
        actorId: HERO,
        targetId: VILLAIN,
        action: 'strike',
        attribute: 2,
        skill: 1,
    };
    const first = resolveAction(inputs);
    const second = resolveAction(inputs);
    assert.deepEqual(first, second);
    assert.ok(first.roll >= 1 && first.roll <= 20);

    // A different sequence still produces a valid, deterministic die.
    const seq0 = rollD20({ seed: 99, round: 2, actorId: HERO, targetId: VILLAIN, action: 'strike', sequence: 0 });
    const seq1 = rollD20({ seed: 99, round: 2, actorId: HERO, targetId: VILLAIN, action: 'strike', sequence: 1 });
    assert.ok(seq0 >= 1 && seq0 <= 20);
    assert.ok(seq1 >= 1 && seq1 <= 20);

    const tiers = [
        [20, 50, 'critical-success'], // nat 20 wins over a very negative margin
        [1, -50, 'critical-fail'], // nat 1 wins over a very positive margin
        [10, 20, 'critical-fail'],
        [10, 15, 'fail'],
        [10, 14, 'partial'],
        [10, 10, 'success'],
        [10, 1, 'success'],
        [10, 0, 'critical-success'],
    ];
    for (const [roll, targetDefense, tier] of tiers) {
        const resolved = resolveAction({
            seed: 1,
            round: 0,
            actorId: HERO,
            targetId: VILLAIN,
            action: 'strike',
            roll,
            targetDefense,
        });
        assert.equal(resolved.tier, tier, `roll ${roll}, defense ${targetDefense}`);
    }

    assert.equal(normalizeCombatAction('Talk Down'), 'talk-down');
    assert.equal(normalizeCombatAction(' TALK DOWN '), 'talk-down');
    assert.equal(normalizeCombatAction('dance'), null);
    assert.equal(typeof createSeededRng(1), 'function');
});

test('resolution rejects invalid actions, non-finite modifiers, and self-targets', () => {
    assert.throws(
        () => resolveAction({ action: 'dance', actorId: HERO, targetId: VILLAIN }),
        /Unknown combat action/,
    );
    assert.throws(
        () => resolveAction({ action: 'strike', actorId: HERO, targetId: VILLAIN, attribute: Infinity }),
        /finite number/,
    );
    assert.throws(
        () => resolveAction({ action: 'strike', actorId: HERO, targetId: HERO }),
        /cannot target the actor/,
    );
    assert.doesNotThrow(
        () => resolveAction({ action: 'defend', actorId: HERO, targetId: HERO }),
    );
});

test('tier and risk deltas stay bounded and never exceed 20 in magnitude', () => {
    for (const tier of OUTCOME_TIERS) {
        for (const risk of COMBAT_RISK_TIERS) {
            const outcome = buildOutcome({ tier, risk });
            for (const side of ['actor', 'target']) {
                for (const [resource, delta] of Object.entries(outcome.deltas[side])) {
                    assert.ok(
                        Math.abs(delta) <= 20,
                        `${tier}/${risk}/${side}.${resource} = ${delta}`,
                    );
                }
            }
            assert.match(outcome.contract, /Do not decide the next outcome/);
        }
    }
    assert.equal(OUTCOME_CONTRACT_INSTRUCTION.includes('Do not decide the next outcome'), true);
    assert.equal(DEFAULT_TIER_DELTAS.partial.actor.stamina, -4);
    // The base table never exceeds the cap even before scaling.
    for (const tier of OUTCOME_TIERS) {
        for (const side of ['actor', 'target']) {
            for (const delta of Object.values(DEFAULT_TIER_DELTAS[tier][side])) {
                assert.ok(Math.abs(delta) <= 20);
            }
        }
    }
});

test('outcome events clamp resources at 0 and max', () => {
    const { store, flow } = makeStore();
    store.dispatch({ type: 'SET_CHARACTER_STAT', characterId: VILLAIN, path: 'stamina.current', value: 5 });
    store.dispatch({ type: 'SET_CHARACTER_STAT', characterId: VILLAIN, path: 'corruption.progress', value: 99 });
    const started = flow.start({ participants: ['player', VILLAIN] });
    assert.equal(started.ok, true);
    const result = flow.resolve({
        actorId: 'player',
        targetId: VILLAIN,
        action: 'strike',
        roll: 20,
    });
    assert.equal(result.ok, true);
    // _20 * high risk, clamped to the target's own range.
    assert.equal(result.state.characters[VILLAIN].stamina.current, 0);
    assert.ok(result.state.characters[VILLAIN].corruption.progress <= 100);
    assert.equal(result.ended, true);
    assert.equal(result.endReason, 'stamina-zero');

    // Corruption clamps at 100 on a critical failure actor delta.
    const events = outcomeEvents({
        outcome: buildOutcome({ tier: 'critical-fail', risk: 'extreme' }),
        actorId: 'player',
        state: result.state,
    });
    const applied = applyWorldEvents(result.state, events);
    assert.ok(applied.player.corruption.progress <= 100);
});

test('start validates participants, sides, and rejects an active conflict without state change', () => {
    const { store, flow } = makeStore();
    const before = structuredClone(store.get());

    assert.equal(flow.start({ participants: ['player'] }).ok, false);
    assert.equal(flow.start({ participants: [VILLAIN, VILLAIN] }).reason, 'duplicate-participant');
    assert.equal(flow.start({ participants: ['player', 'nobody'] }).reason, 'unknown-participant');
    assert.equal(
        flow.start({
            participants: ['player', VILLAIN],
            sides: { player: 'a', [VILLAIN]: 'c' },
        }).reason,
        'unknown-side',
    );
    assert.equal(
        flow.start({
            participants: ['player', VILLAIN],
            sides: { player: 'a', [VILLAIN]: 'a' },
        }).reason,
        'invalid-sides',
    );
    assert.deepEqual(store.get(), before);

    assert.equal(flow.start({ participants: ['player', VILLAIN] }).ok, true);
    const active = structuredClone(store.get());
    const second = flow.start({ participants: [VILLAIN, HERO] });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'combat-active');
    assert.deepEqual(store.get(), active);
});

test('defend is always a self-guard and never damages an explicit target', () => {
    const { store, flow } = makeStore();
    flow.start({ participants: ['player', VILLAIN] });
    const beforeTarget = store.get().characters[VILLAIN].stamina.current;
    const result = flow.resolve({
        actorId: 'player',
        targetId: VILLAIN,
        action: 'defend',
        roll: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(result.action.targetId, 'player');
    assert.equal(result.state.characters[VILLAIN].stamina.current, beforeTarget);
    assert.equal(result.state.player.stamina.current, 100);
});

test('a custom persona resolves as "player"; canon players sync the mirror', () => {
    const { store, flow } = makeStore();
    assert.equal(flow.start({ participants: ['player', VILLAIN], stakes: 'Hold the line' }).ok, true);
    const playerResult = flow.resolve({
        actorId: 'player',
        targetId: VILLAIN,
        action: 'strike',
        roll: 3, // miss: the actor pays
    });
    assert.equal(playerResult.ok, true);
    assert.ok(playerResult.state.player.stamina.current < 100);

    const canon = makeCanonStore(HERO);
    const npc = VILLAIN;
    assert.equal(canon.flow.start({ participants: [HERO, npc] }).ok, true);
    const hit = canon.flow.resolve({
        actorId: npc,
        targetId: HERO,
        action: 'strike',
        roll: 20,
    });
    assert.equal(hit.ok, true);
    const character = hit.state.characters[HERO];
    assert.equal(hit.state.player.stamina.current, character.stamina.current);
    assert.ok(character.stamina.current < 100);
});

test('a player-controlled canon character is a valid combatant on either side', () => {
    const { flow } = makeCanonStore(HERO);
    const started = flow.start({
        participants: [HERO, VILLAIN],
        sides: { [HERO]: 'b', [VILLAIN]: 'a' },
    });
    assert.equal(started.ok, true);
    assert.equal(started.combat.participants.includes(HERO), true);
    assert.equal(started.combat.sides[HERO], 'b');
    const result = flow.resolve({
        actorId: HERO,
        targetId: VILLAIN,
        action: 'feint',
        roll: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome.tier, 'critical-success');
});

test('conflicts end on surrender, stamina zero, and the round cap', () => {
    const surrender = makeStore();
    surrender.flow.start({ participants: ['player', VILLAIN] });
    const yielded = surrender.flow.resolve({ actorId: 'player', action: 'surrender' });
    assert.equal(yielded.ok, true);
    assert.equal(yielded.ended, true);
    assert.equal(yielded.endReason, 'surrender');
    assert.equal(surrender.store.get().scene.combat, null);
    assert.equal(surrender.store.get().meta.inCombat, false);
    assert.equal(surrender.store.get().flags.lastCombat.endReason, 'surrender');

    const drained = makeStore();
    drained.store.dispatch({
        type: 'SET_CHARACTER_STAT',
        characterId: VILLAIN,
        path: 'stamina.current',
        value: 10,
    });
    drained.flow.start({ participants: ['player', VILLAIN] });
    const hit = drained.flow.resolve({
        actorId: 'player',
        targetId: VILLAIN,
        action: 'strike',
        roll: 20,
    });
    assert.equal(hit.endReason, 'stamina-zero');
    assert.equal(drained.store.get().scene.combat, null);
    assert.equal(drained.store.get().meta.inCombat, false);
    assert.deepEqual(drained.store.get().flags.lastCombat.loserIds, [VILLAIN]);

    const capped = makeStore({ settings: { combat: { maxRounds: 3 } } });
    capped.flow.start({ participants: ['player', VILLAIN] });
    const first = capped.flow.resolve({ actorId: 'player', action: 'defend', roll: 10 });
    const second = capped.flow.resolve({ actorId: 'player', action: 'defend', roll: 10 });
    const third = capped.flow.resolve({ actorId: 'player', action: 'defend', roll: 10 });
    assert.equal(first.ended, false);
    assert.equal(second.ended, false);
    assert.equal(third.ended, true);
    assert.equal(third.endReason, 'round-cap');
    assert.equal(capped.store.get().flags.lastCombat.endReason, 'round-cap');
});

test('the combat block renders only while active and replaces the scene combat line', () => {
    const { store, flow } = makeStore();
    const inactive = renderContext(store.get(), { settings: cloneDefaults() });
    assert.equal(byId(inactive, 'combat'), null);
    assert.doesNotMatch(byId(inactive, 'scene').text, /Combat: active/);

    flow.start({
        participants: ['player', VILLAIN],
        stakes: 'Keep the bridge',
        intent: 'Stop the courier',
    });
    flow.resolve({ actorId: 'player', targetId: VILLAIN, action: 'defend', roll: 10 });

    const active = renderContext(store.get(), { settings: cloneDefaults() });
    const block = byId(active, 'combat');
    assert.ok(block);
    assert.match(block.text, /\[NEOTERRA_COMBAT\]/);
    assert.match(block.text, /stakes: Keep the bridge/);
    assert.match(block.text, /Round: 1\/8/);
    assert.match(block.text, /risk low/);
    assert.match(block.text, /tier success/);
    assert.match(block.text, /margin \+0/);
    assert.match(block.text, /A clean success/);
    assert.match(block.text, /Do not decide outcomes/);
    assert.doesNotMatch(byId(active, 'scene').text, /Combat: active/);

    flow.end({ reason: 'test-over' });
    const ended = renderContext(store.get(), { settings: cloneDefaults() });
    assert.equal(byId(ended, 'combat'), null);
    assert.equal(store.get().meta.inCombat, false);
});

test('travel is blocked during combat and allowed after COMBAT_END', () => {
    const { store, flow } = makeStore();
    assert.equal(isTravelBlockedByCombat(store.get()), false);
    flow.start({ participants: ['player', VILLAIN] });
    assert.equal(isTravelBlockedByCombat(store.get()), true);
    flow.end({ reason: 'test-over' });
    assert.equal(isTravelBlockedByCombat(store.get()), false);
    assert.equal(store.get().scene.combat, null);
});

test('the state tracker suppresses engine-owned resources during combat only', () => {
    const { store, flow } = makeStore();
    flow.start({ participants: ['player', VILLAIN] });
    const combatState = store.get();
    const suppressed = normalizeStateTrackerResult({
        result: {
            changes: [
                { path: 'stamina.current', value: 5, reason: 'hit' },
                { path: 'willpower.max', value: 50, reason: 'hit' },
                { path: 'mood', value: 'angry', reason: 'hit' },
            ],
            relationships: [],
            rationale: '',
        },
        state: combatState,
    });
    const engineOwned = suppressed.suppressed.filter((entry) => entry.reason === 'combat-engine-owned');
    assert.deepEqual(engineOwned.map((entry) => entry.path), ['stamina.current', 'willpower.max']);
    assert.equal(
        suppressed.events.some((event) => event.type === 'SET_PLAYER_STAT'
            && ['stamina.current', 'stamina.max', 'willpower.current', 'willpower.max', 'corruption.stage', 'corruption.progress'].includes(event.path)),
        false,
    );
    assert.equal(suppressed.events.some((event) => event.path === 'mood'), true);

    const prompt = buildStateTrackerPrompt({ state: combatState });
    assert.match(prompt, /## Combat/);
    assert.match(prompt, /resolver owns stamina/);

    const calm = makeStore();
    const normal = normalizeStateTrackerResult({
        result: {
            changes: [{ path: 'stamina.current', value: 42, reason: 'rest' }],
            relationships: [],
            rationale: '',
        },
        state: calm.store.get(),
    });
    assert.equal(normal.suppressed.length, 0);
    assert.equal(normal.events[0].type, 'SET_PLAYER_STAT');
    assert.equal(normal.events[0].value, 42);
});

test('Engage from a detected encounter starts combat, blocks travel, and End clears it', () => {
    const { store, flow } = makeStore();
    const state = store.get();
    store.dispatch({
        type: 'MOVE_CHARACTER',
        characterId: ENCOUNTER_VILLAIN,
        locationId: state.scene.locationId,
    });
    const moved = store.get();
    const encounter = detectEncounter({ state: moved, present: [ENCOUNTER_VILLAIN] });
    assert.ok(encounter, 'the villain at the player location is an encounter');

    const result = startEncounterCombat({ flow, state: moved, encounter });
    assert.equal(result.ok, true);
    assert.ok(flow.activeCombat(), 'the conflict is active');
    assert.equal(flow.activeCombat().id, result.combat.id);
    assert.equal(isTravelBlockedByCombat(store.get()), true);

    const ended = endEncounterCombat(flow, { reason: 'scene-end' });
    assert.equal(ended.ok, true);
    assert.equal(store.get().scene.combat, null);
    assert.equal(isTravelBlockedByCombat(store.get()), false);
});

test('a canon player engages as the canon character id', () => {
    const { store, flow } = makeCanonStore(HERO);
    const state = store.get();
    store.dispatch({
        type: 'MOVE_CHARACTER',
        characterId: ENCOUNTER_VILLAIN,
        locationId: state.scene.locationId,
    });
    const moved = store.get();
    const encounter = detectEncounter({ state: moved, present: [ENCOUNTER_VILLAIN] });
    assert.ok(encounter);
    assert.equal(encounterActorId(moved), HERO);

    const result = startEncounterCombat({ flow, state: moved, encounter });
    assert.equal(result.ok, true);
    assert.deepEqual(result.participants, [HERO, ENCOUNTER_VILLAIN]);
    assert.deepEqual(flow.activeCombat().participants, [HERO, ENCOUNTER_VILLAIN]);
});

test('choices re-exports the resolver vocabulary by identity', () => {
    assert.equal(choices.COMBAT_ACTIONS, resolver.COMBAT_ACTIONS);
    assert.equal(choices.COMBAT_RISK_TIERS, resolver.COMBAT_RISK_TIERS);
    assert.deepEqual([...choices.COMBAT_ACTIONS], ['strike', 'defend', 'grapple', 'feint', 'skill', 'retreat', 'surrender', 'talk-down']);
    assert.deepEqual([...COMBAT_ACTIONS], [...resolver.COMBAT_ACTIONS]);
    assert.deepEqual([...COMBAT_RISK_TIERS], ['low', 'moderate', 'high', 'extreme']);
});
