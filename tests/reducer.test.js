import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFormExclusivity, buildFormIndex } from '../src/data/forms.js';
import { applyWorldEvent, applyWorldEvents } from '../src/state/reducer.js';
import { cloneWorldState, createWorldState, createEmptyWorldState } from '../src/state/world-state.js';

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
    ['s1', 's1dark', 's4', 'sandbox'].map((id) => [id, readJson(`data/seasons/${id}.json`)]),
);
const CONTEXT = { registry, formGroups, formRules };

function seed(seasonId) {
    return createWorldState({
        season: seasons[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: `reducer-${seasonId}`,
        now: 123,
    });
}

test('reducer is pure and deterministic', () => {
    const state = seed('s1');
    const before = cloneWorldState(state);
    const events = [
        { type: 'TICK_TIME', turns: 2, date: '2037-03-03' },
        { type: 'ADD_EVENT', summary: 'A patrol passes.', actors: ['s1.aurelia.longshot'] },
        { type: 'SET_PLAYER_STAT', path: 'mood', value: 'watchful' },
    ];

    const first = applyWorldEvents(state, events, CONTEXT);
    const second = applyWorldEvents(state, events, CONTEXT);
    assert.deepEqual(state, before);
    assert.deepEqual(first, second);

    first.meta.turn = 999;
    assert.equal(state.meta.turn, 0);
});

test('unknown events and unresolved ids throw clear errors', () => {
    const state = seed('s1');
    assert.throws(
        () => applyWorldEvent(state, { type: 'TELEPORT_EVERYONE' }, CONTEXT),
        /Unknown world event "TELEPORT_EVERYONE"/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'MOVE_CHARACTER', characterId: 'nobody', locationId: 'central-plaza' }, CONTEXT),
        /Unknown character/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_LOCATION', locationId: 'atlantis' }, CONTEXT),
        /Unknown location/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'ADVANCE_THREAT', threatId: 'nobody' }, CONTEXT),
        /Unknown threat/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'RESOLVE_BEAT', beatId: 'nobody' }, CONTEXT),
        /Unknown beat/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'ADD_EVENT', summary: 'x', actors: ['nobody'] }, CONTEXT),
        /Unknown character/,
    );
});

test('TRANSFORM accepts declared rules, rejects same/cross-group/undeclared forms, and keeps exclusivity', () => {
    const base = seed('s1dark');
    const carolId = 's1dark.carol.bleeding-heart';
    const cleansedId = 's1dark.carol.cleansed.bleeding.heart';

    assert.throws(
        () => applyWorldEvent(base, { type: 'TRANSFORM', characterId: carolId, formId: cleansedId }),
        /requires form context/,
    );
    assert.throws(
        () => applyWorldEvent(
            base,
            { type: 'TRANSFORM', characterId: carolId, formId: carolId },
            CONTEXT,
        ),
        /already active/,
    );
    assert.throws(
        () => applyWorldEvent(
            base,
            {
                type: 'TRANSFORM',
                characterId: carolId,
                formId: 's1dark.heart.attack.knighted.cyber.sakura',
            },
            CONTEXT,
        ),
        /not in the character's form group/,
    );

    const transformed = applyWorldEvent(
        base,
        { type: 'TRANSFORM', characterId: carolId, formId: cleansedId },
        CONTEXT,
    );
    assert.equal(transformed.characters[carolId].formId, cleansedId);
    assert.equal(transformed.characters[carolId].formGroup, 's1dark.carol');
    assert.equal(transformed.player.formId, cleansedId);
    assert.equal(
        Object.values(transformed.characters).filter((character) => character.formGroup === 's1dark.carol').length,
        1,
    );
    assert.doesNotThrow(() =>
        assertFormExclusivity(buildFormIndex(registry, formGroups), { [carolId]: 'active' }),
    );

    assert.throws(
        () => applyWorldEvent(
            transformed,
            {
                type: 'TRANSFORM',
                characterId: carolId,
                formId: 's1dark.carol.infected.bleeding.heart',
            },
            CONTEXT,
        ),
        /no declared rule/,
    );
});

test('ADVANCE_THREAT clamps progress and stage', () => {
    const state = seed('s1');
    const threatId = 's1.threat.clarity';
    const maxStage = state.threats.find((threat) => threat.id === threatId).stages.length - 1;

    const maxed = applyWorldEvent(
        state,
        { type: 'ADVANCE_THREAT', threatId, amount: 500 },
        CONTEXT,
    );
    assert.equal(maxed.threats[0].progress, 100);
    assert.equal(maxed.threats[0].stage, maxStage);

    const bottomed = applyWorldEvent(
        maxed,
        { type: 'ADVANCE_THREAT', threatId, amount: -500, stage: -5 },
        CONTEXT,
    );
    assert.equal(bottomed.threats[0].progress, 0);
    assert.equal(bottomed.threats[0].stage, 0);

    const explicit = applyWorldEvent(
        state,
        { type: 'ADVANCE_THREAT', threatId, stage: 99 },
        CONTEXT,
    );
    assert.equal(explicit.threats[0].stage, maxStage);
});

test('SET_STATUS validates enums and death/alive semantics', () => {
    const state = seed('s1');
    const characterId = 's1.aurelia.longshot';
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_STATUS', characterId, status: 'zombie' }, CONTEXT),
        /Unknown character status/,
    );

    const dead = applyWorldEvent(
        state,
        { type: 'SET_STATUS', characterId, status: 'dead' },
        CONTEXT,
    );
    assert.equal(dead.characters[characterId].alive, false);

    const captured = applyWorldEvent(
        dead,
        { type: 'SET_STATUS', characterId, status: 'captured' },
        CONTEXT,
    );
    assert.equal(captured.characters[characterId].alive, true);

    const retired = applyWorldEvent(
        dead,
        { type: 'SET_STATUS', characterId, status: 'retired' },
        CONTEXT,
    );
    assert.equal(retired.characters[characterId].alive, false);
});

test('beat transitions are monotonic and support adapt/defer', () => {
    const state = seed('s1');
    const firstBeat = seasons.s1.canonBeats[0].id;
    const secondBeat = seasons.s1.canonBeats[1].id;

    const resolved = applyWorldEvent(
        state,
        { type: 'RESOLVE_BEAT', beatId: firstBeat, turn: 4, reason: 'Happened.' },
        CONTEXT,
    );
    assert.equal(resolved.beats[firstBeat].status, 'resolved');
    assert.equal(resolved.beats[firstBeat].resolvedTurn, 4);
    assert.throws(
        () => applyWorldEvent(resolved, { type: 'DEFER_BEAT', beatId: firstBeat, reason: 'nope' }, CONTEXT),
        /Illegal beat status transition/,
    );

    const deferred = applyWorldEvent(
        state,
        { type: 'DEFER_BEAT', beatId: secondBeat, reason: 'Waiting.', untilTurn: 9 },
        CONTEXT,
    );
    assert.equal(deferred.beats[secondBeat].status, 'deferred');
    assert.equal(deferred.beats[secondBeat].deferredUntilTurn, 9);
    const reopened = applyWorldEvent(
        deferred,
        { type: 'RESOLVE_BEAT', beatId: secondBeat },
        CONTEXT,
    );
    assert.equal(reopened.beats[secondBeat].status, 'resolved');

    const adapted = applyWorldEvent(
        state,
        {
            type: 'ADAPT_BEAT',
            beatId: secondBeat,
            adaptedFrom: 'original-actor',
            adaptedTo: 'substitute-actor',
            reason: 'Original actor was elsewhere.',
        },
        CONTEXT,
    );
    assert.equal(adapted.beats[secondBeat].status, 'adapted');
    assert.equal(adapted.beats[secondBeat].adaptedFrom, 'original-actor');
    assert.equal(adapted.beats[secondBeat].adaptedTo, 'substitute-actor');
});

test('SET_PLAYER_IDENTITY flips controlledBy atomically and preserves character state', () => {
    const state = seed('s1dark');
    const oldId = 's1dark.carol.bleeding-heart';
    const newId = 's1dark.aurelia.season-dark-version';
    state.characters[oldId].notes = 'old notes';
    state.characters[newId].notes = 'new notes';

    const switched = applyWorldEvent(
        state,
        { type: 'SET_PLAYER_IDENTITY', identity: 'canon', characterId: newId, personaNotes: 'New POV.' },
        CONTEXT,
    );
    assert.equal(switched.characters[oldId].controlledBy, 'npc');
    assert.equal(switched.characters[newId].controlledBy, 'player');
    assert.equal(switched.characters[oldId].notes, 'old notes');
    assert.equal(switched.characters[newId].notes, 'new notes');
    assert.equal(switched.player.identity, 'canon');
    assert.equal(switched.player.characterId, newId);
    assert.equal(switched.player.personaNotes, 'New POV.');
    assert.equal(switched.player.formId, switched.characters[newId].formId);

    const custom = applyWorldEvent(
        switched,
        { type: 'SET_PLAYER_IDENTITY', identity: 'custom', personaNotes: 'Myself again.' },
        CONTEXT,
    );
    assert.equal(custom.characters[newId].controlledBy, 'npc');
    assert.equal(custom.player.identity, 'custom');
    assert.equal(custom.player.characterId, null);
    assert.equal(custom.player.personaNotes, 'Myself again.');

    const dead = applyWorldEvent(
        state,
        { type: 'SET_STATUS', characterId: newId, status: 'dead' },
        CONTEXT,
    );
    assert.throws(
        () => applyWorldEvent(
            dead,
            { type: 'SET_PLAYER_IDENTITY', identity: 'canon', characterId: newId },
            CONTEXT,
        ),
        /dead or missing/,
    );
});

test('a custom player persona does not inherit canon fields', () => {
    const state = seed('s1dark');
    const carolId = 's1dark.carol.bleeding-heart';
    state.characters[carolId].stamina.current = 12;
    state.characters[carolId].displayName = 'Bleeding Heart';
    state.characters[carolId].agenda = 'Rule forever';

    const custom = applyWorldEvent(
        state,
        { type: 'SET_PLAYER_IDENTITY', identity: 'custom', personaNotes: 'A new arrival.' },
        CONTEXT,
    );
    assert.equal(custom.player.identity, 'custom');
    assert.equal(custom.player.displayName, 'The Player');
    assert.deepEqual(custom.player.stamina, { current: 100, max: 100 });
    assert.notEqual(custom.player.agenda, 'Rule forever');
    assert.equal(custom.player.personaNotes, 'A new arrival.');
    assert.equal(custom.player.locationId, custom.scene.locationId);
    // The canon character keeps their own state after losing control.
    assert.equal(custom.characters[carolId].stamina.current, 12);
    assert.equal(custom.characters[carolId].displayName, 'Bleeding Heart');
});

test('TRIGGER_ENDING is idempotent and CHOOSE_ENDING_PATH is state-aware', () => {
    const state = seed('s1');
    assert.throws(
        () => applyWorldEvent(state, { type: 'CHOOSE_ENDING_PATH', path: 'resistance' }, CONTEXT),
        /requires an epilogue ending/,
    );

    const epilogue = applyWorldEvent(state, { type: 'TRIGGER_ENDING' }, CONTEXT);
    assert.equal(epilogue.ending.status, 'epilogue');
    assert.equal(epilogue.ending.firedTurn, 0);
    const again = applyWorldEvent(epilogue, { type: 'TRIGGER_ENDING', firedTurn: 99 }, CONTEXT);
    assert.equal(again, epilogue);

    assert.throws(
        () => applyWorldEvent(epilogue, { type: 'CHOOSE_ENDING_PATH', path: 'join-villain' }, CONTEXT),
        /not available/,
    );
    assert.throws(
        () => applyWorldEvent(epilogue, { type: 'CHOOSE_ENDING_PATH', path: 'conquer' }, CONTEXT),
        /Invalid ending path/,
    );

    const resistance = applyWorldEvent(
        epilogue,
        { type: 'CHOOSE_ENDING_PATH', path: 'resistance' },
        CONTEXT,
    );
    assert.equal(resistance.ending.status, 'continued');
    assert.equal(resistance.ending.path, 'resistance');
    assert.equal(resistance.arc, 'post-victory');
    assert.ok(resistance.recentEvents.at(-1).tags.includes('ending'));

    const ended = applyWorldEvent(
        epilogue,
        { type: 'CHOOSE_ENDING_PATH', path: 'end' },
        CONTEXT,
    );
    assert.equal(ended.ending.status, 'ended');
    assert.equal(ended.arc, 'season');

    const villain = seed('s1dark');
    const villainEpilogue = applyWorldEvent(villain, { type: 'TRIGGER_ENDING' }, CONTEXT);
    const joined = applyWorldEvent(
        villainEpilogue,
        { type: 'CHOOSE_ENDING_PATH', path: 'join-villain' },
        CONTEXT,
    );
    assert.equal(joined.ending.status, 'continued');
    assert.equal(joined.ending.path, 'join-villain');
    assert.equal(joined.arc, 'post-victory');
});

test('RECORD_BAD_END is idempotent per key and REVERSE_BAD_END preserves history', () => {
    const state = seed('s1');
    const characterId = 's1.aurelia.longshot';
    const event = {
        type: 'RECORD_BAD_END',
        characterId,
        badEndType: 'death',
        severity: 'terminal',
        cause: 'Held the line.',
        epilogueText: 'She did not come back.',
        playableAs: false,
        continuityKey: 's1:aurora:1',
        reversibility: 'none',
    };

    const recorded = applyWorldEvent(state, event, CONTEXT);
    assert.equal(recorded.characters[characterId].status, 'dead');
    assert.equal(recorded.characters[characterId].alive, false);
    assert.equal(recorded.characters[characterId].badEndType, 'death');
    assert.equal(recorded.badEnds[characterId].type, 'death');
    assert.equal(recorded.badEnds[characterId].epilogueText, 'She did not come back.');

    const duplicate = applyWorldEvent(recorded, event, CONTEXT);
    assert.equal(duplicate, recorded);

    const reversed = applyWorldEvent(
        recorded,
        { type: 'REVERSE_BAD_END', characterId, reason: 'A cure was found.' },
        CONTEXT,
    );
    assert.equal(reversed.characters[characterId].status, 'active');
    assert.equal(reversed.characters[characterId].alive, true);
    assert.equal(reversed.characters[characterId].badEndType, null);
    assert.equal(reversed.badEnds[characterId].reversed, true);
    assert.equal(reversed.badEnds[characterId].reversalReason, 'A cure was found.');
    assert.equal(reversed.badEnds[characterId].type, 'death');
    assert.equal(reversed.badEnds[characterId].epilogueText, 'She did not come back.');

    const autonomy = applyWorldEvent(
        state,
        {
            type: 'RECORD_BAD_END',
            characterId,
            badEndType: 'autonomy-loss',
            cause: 'Conditioning.',
            continuityKey: 's1:aurora:2',
        },
        CONTEXT,
    );
    assert.equal(autonomy.characters[characterId].status, 'captured');
    assert.equal(autonomy.characters[characterId].alive, true);
});

test('clamp, time, relationships, events, combat, and player stats behave', () => {
    const state = seed('s1');

    const ticked = applyWorldEvent(
        state,
        { type: 'TICK_TIME', turns: 2, date: '2037-03-03', timeOfDay: 'night' },
        CONTEXT,
    );
    assert.equal(ticked.meta.turn, 2);
    assert.equal(ticked.meta.inGameDate, '2037-03-03');
    assert.equal(ticked.meta.timeOfDay, 'night');

    const a = 's1.aurelia.longshot';
    const b = 's1.vaiva.colorgarde';
    const relationship = applyWorldEvent(
        state,
        { type: 'RELATIONSHIP_DELTA', a, b, relationshipType: 'friend', affinityDelta: 90, tensionDelta: -90 },
        CONTEXT,
    );
    const clamped = applyWorldEvent(
        relationship,
        { type: 'RELATIONSHIP_DELTA', a: b, b: a, affinityDelta: 50, tensionDelta: -50 },
        CONTEXT,
    );
    assert.equal(clamped.relationships.length, 1);
    assert.equal(clamped.relationships[0].affinity, 100);
    assert.equal(clamped.relationships[0].tension, -100);
    assert.throws(
        () => applyWorldEvent(
            state,
            { type: 'RELATIONSHIP_DELTA', a, b: a, affinityDelta: 1 },
            CONTEXT,
        ),
        /two different characters/,
    );

    const withEvents = cloneWorldState(state);
    withEvents.recentEvents = Array.from({ length: 200 }, (_, index) => ({
        turn: 0,
        date: withEvents.meta.inGameDate,
        summary: `old-${index}`,
        actors: [],
        locationId: null,
        tags: [],
    }));
    const appended = applyWorldEvent(
        withEvents,
        {
            type: 'ADD_EVENT',
            summary: 'The dam breaks.',
            actors: [a],
            tags: ['disaster'],
        },
        CONTEXT,
    );
    assert.equal(appended.recentEvents.length, 200);
    assert.equal(appended.recentEvents[0].summary, 'old-1');
    assert.equal(appended.recentEvents.at(-1).summary, 'The dam breaks.');
    assert.equal(appended.characters[a].lastUpdatedTurn, 0);

    const combat = applyWorldEvent(
        state,
        { type: 'COMBAT_START', participants: [a, b], kind: 'brawl' },
        CONTEXT,
    );
    assert.equal(combat.meta.inCombat, true);
    assert.equal(combat.scene.combat.kind, 'brawl');
    const combatEnded = applyWorldEvent(combat, { type: 'COMBAT_END' }, CONTEXT);
    assert.equal(combatEnded.meta.inCombat, false);
    assert.equal(combatEnded.scene.combat, null);

    const stats = applyWorldEvent(
        state,
        { type: 'SET_PLAYER_STAT', path: 'stamina.current', value: 999 },
        CONTEXT,
    );
    assert.equal(stats.player.stamina.current, 100);
    const lowerMax = applyWorldEvent(
        stats,
        { type: 'SET_PLAYER_STAT', path: 'stamina.max', value: 50 },
        CONTEXT,
    );
    assert.equal(lowerMax.player.stamina.max, 50);
    assert.equal(lowerMax.player.stamina.current, 50);
    const zero = applyWorldEvent(
        lowerMax,
        { type: 'SET_PLAYER_STAT', path: 'stamina.current', value: -10 },
        CONTEXT,
    );
    assert.equal(zero.player.stamina.current, 0);

    const corruption = applyWorldEvent(
        zero,
        { type: 'SET_PLAYER_STAT', path: 'corruption.progress', value: 999 },
        CONTEXT,
    );
    assert.equal(corruption.player.corruption.progress, 100);
    const mood = applyWorldEvent(
        corruption,
        { type: 'SET_PLAYER_STAT', path: 'mood', value: 'furious' },
        CONTEXT,
    );
    assert.equal(mood.player.mood, 'furious');

    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_PLAYER_STAT', path: 'hp', value: 1 }, CONTEXT),
        /Unknown SET_PLAYER_STAT path/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_PLAYER_STAT', path: 'corruption.stage', value: -1 }, CONTEXT),
        /non-negative integer/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_PLAYER_STAT', path: 'outfit', value: 7 }, CONTEXT),
        /requires a string/,
    );
});

test('canon player stats mirror into the character state', () => {
    const state = seed('s1dark');
    const characterId = 's1dark.carol.bleeding-heart';
    const updated = applyWorldEvent(
        state,
        { type: 'SET_PLAYER_STAT', path: 'stamina.max', value: 40 },
        CONTEXT,
    );
    assert.equal(updated.player.stamina.max, 40);
    assert.equal(updated.characters[characterId].stamina.max, 40);
    assert.equal(updated.characters[characterId].stamina.current, 40);

    const event = applyWorldEvent(
        updated,
        { type: 'ADD_EVENT', summary: 'A quiet night.', actors: [characterId], tags: ['downtime'] },
        CONTEXT,
    );
    assert.equal(event.characters[characterId].lastUpdatedTurn, event.meta.turn);
    assert.equal(event.player.lastUpdatedTurn, event.meta.turn);
});

test('empty state supports movement without characters', () => {
    const state = createEmptyWorldState({ chatId: 'empty' });
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_ARC', arc: 'post-victory' }, CONTEXT),
        /post-victory arc requires a continued ending/,
    );

    const fired = applyWorldEvent(state, { type: 'TRIGGER_ENDING' }, CONTEXT);
    const continued = applyWorldEvent(
        fired,
        { type: 'CHOOSE_ENDING_PATH', path: 'resistance' },
        CONTEXT,
    );
    assert.equal(continued.arc, 'post-victory');
    assert.equal(continued.ending.status, 'continued');
    assert.equal(state.arc, 'season');
    assert.equal(state.ending.status, 'none');
});

test('TICK_TIME advances storyTurn by default and honours an explicit value', () => {
    const state = seed('s1');
    const defaulted = applyWorldEvent(state, { type: 'TICK_TIME', turns: 2 }, CONTEXT);
    assert.equal(defaulted.meta.turn, 2);
    assert.equal(defaulted.meta.storyTurn, 2);

    const held = applyWorldEvent(
        defaulted,
        { type: 'TICK_TIME', turns: 3, storyTurns: 0 },
        CONTEXT,
    );
    assert.equal(held.meta.turn, 5);
    assert.equal(held.meta.storyTurn, 2);

    const explicit = applyWorldEvent(
        held,
        { type: 'TICK_TIME', turns: 4, storyTurns: 1 },
        CONTEXT,
    );
    assert.equal(explicit.meta.turn, 9);
    assert.equal(explicit.meta.storyTurn, 3);

    assert.throws(
        () => applyWorldEvent(state, { type: 'TICK_TIME', turns: 1, storyTurns: -1 }, CONTEXT),
        /TICK_TIME storyTurns must be a non-negative integer/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'TICK_TIME', turns: 1, storyTurns: 1.5 }, CONTEXT),
        /TICK_TIME storyTurns must be a non-negative integer/,
    );

    // A V1-shaped document without `storyTurn` starts from `meta.turn`.
    const legacy = cloneWorldState(state);
    delete legacy.meta.storyTurn;
    const migratedOnTick = applyWorldEvent(legacy, { type: 'TICK_TIME', turns: 2 }, CONTEXT);
    assert.equal(migratedOnTick.meta.storyTurn, 2);
});

test('SET_CLOCK_HOLD records entry and exit and is idempotent', () => {
    const state = seed('s1');
    const entered = applyWorldEvent(
        state,
        { type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' },
        CONTEXT,
    );
    assert.deepEqual(entered.flags.clock.hold, {
        active: true,
        reason: 'manual',
        sinceTurn: 0,
        sinceDate: state.meta.inGameDate,
    });

    // Applying the same hold state returns the exact same document.
    const repeated = applyWorldEvent(
        entered,
        { type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' },
        CONTEXT,
    );
    assert.equal(repeated, entered);

    const released = applyWorldEvent(
        entered,
        { type: 'SET_CLOCK_HOLD', active: false, reason: 'released-by-hand' },
        CONTEXT,
    );
    assert.equal(released.flags.clock.hold.active, false);
    assert.equal(released.flags.clock.hold.reason, 'released-by-hand');
    assert.equal(released.flags.clock.hold.sinceTurn, 0);
    assert.equal(released.flags.clock.hold.sinceDate, state.meta.inGameDate);

    // Releasing when nothing is held is a no-op document.
    assert.equal(
        applyWorldEvent(state, { type: 'SET_CLOCK_HOLD', active: false }, CONTEXT),
        state,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'SET_CLOCK_HOLD', active: 'yes' }, CONTEXT),
        /SET_CLOCK_HOLD active must be a boolean/,
    );

    // A missing flags.clock is created rather than throwing.
    const bare = cloneWorldState(state);
    delete bare.flags;
    const created = applyWorldEvent(
        bare,
        { type: 'SET_CLOCK_HOLD', active: true, reason: 'encounter' },
        CONTEXT,
    );
    assert.equal(created.flags.clock.hold.reason, 'encounter');
});

test('combat auto-holds and only a combat hold is cleared by COMBAT_END', () => {
    const state = seed('s1');
    const a = 's1.aurelia.longshot';
    const b = 's1.vaiva.colorgarde';

    const combat = applyWorldEvent(
        state,
        { type: 'COMBAT_START', participants: [a, b], kind: 'brawl' },
        CONTEXT,
    );
    assert.deepEqual(combat.flags.clock.hold, {
        active: true,
        reason: 'combat',
        sinceTurn: 0,
        sinceDate: state.meta.inGameDate,
    });

    const manual = applyWorldEvent(
        state,
        { type: 'SET_CLOCK_HOLD', active: true, reason: 'manual' },
        CONTEXT,
    );
    const manualCombat = applyWorldEvent(
        manual,
        { type: 'COMBAT_START', participants: [a, b] },
        CONTEXT,
    );
    assert.equal(manualCombat.flags.clock.hold.reason, 'manual');

    const ended = applyWorldEvent(combat, { type: 'COMBAT_END' }, CONTEXT);
    assert.equal(ended.flags.clock.hold.active, false);
    const manualEnded = applyWorldEvent(manualCombat, { type: 'COMBAT_END' }, CONTEXT);
    assert.equal(manualEnded.flags.clock.hold.active, true);
    assert.equal(manualEnded.flags.clock.hold.reason, 'manual');

    const suppressed = applyWorldEvent(
        state,
        { type: 'COMBAT_START', participants: [a, b], hold: false },
        CONTEXT,
    );
    assert.equal(suppressed.flags.clock.hold.active, false);
    assert.equal(suppressed.meta.inCombat, true);
});

test('PUBLISH_EDITION validates, dedupes by date, and records the last edition', () => {
    const state = seed('s1');
    const edition = {
        id: 'edition:s1:2037-03-06:4',
        date: '2037-03-06',
        turn: 4,
        masthead: 'THE NEO TERRA CHRONICLE',
        dateline: 'NEO TERRA — EVENING EDITION',
        style: 'broadsheet',
        source: 'deterministic',
        headlines: [{ title: 'A quiet city', lede: 'Nothing happens.', section: 'general', tone: 'neutral' }],
    };
    const published = applyWorldEvent(state, { type: 'PUBLISH_EDITION', edition }, CONTEXT);
    assert.equal(published.flags.newsroom.editions.length, 1);
    assert.equal(published.flags.newsroom.lastEditionDate, '2037-03-06');
    assert.equal(published.flags.newsroom.lastEditionTurn, 4);

    const again = applyWorldEvent(published, {
        type: 'PUBLISH_EDITION',
        edition: { ...edition, id: 'edition:other', turn: 5 },
    }, CONTEXT);
    assert.equal(again, published, 'the same date is an idempotent no-op');
    assert.equal(again.flags.newsroom.editions.length, 1);
});
