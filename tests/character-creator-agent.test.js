import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_IDS } from '../src/core/constants.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { normalizeSettings } from '../src/core/migrations.js';
import { DEFAULT_AGENT_PROMPTS, resolveAgentConfig } from '../src/agents/prompts.js';
import {
    buildGeneratedCharacterEvent,
    validateGeneratedCard,
} from '../src/agents/character-creator.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { migrateWorldState } from '../src/state/migrations.js';
import {
    cloneWorldState,
    createWorldState,
    validateWorldState,
} from '../src/state/world-state.js';
import { selectPresentCast } from '../src/state/selectors.js';
import { buildCharacterProfile, buildProfileLines } from '../src/context/worldbook.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
    return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

const REGISTRY = readJson('data/characters/index.json');
const SEASON = readJson('data/seasons/s1.json');
const FACTIONS = readJson('data/factions.json');
const DISTRICTS = readJson('data/districts.json');
const LOCATIONS = readJson('data/locations.json');
const FORM_GROUPS = readJson('data/form-groups.json');
const FORM_RULES = readJson('data/form-rules.json');
const CONTEXT = { registry: REGISTRY, formGroups: FORM_GROUPS, formRules: FORM_RULES };

const CARD = {
    name: 'Mara Voss',
    aliases: ['Neon Wraith'],
    identity: 'Pirate-radio host by night; the vigilante known as Neon Wraith.',
    side: 'vigilante',
    threatLevel: 'low',
    gender: 'Female',
    species: 'Human metahuman',
    occupation: 'Night-shift radio host',
    faction: 'Unaffiliated',
    appearance: 'Mara is a lean, tired woman with chopped black hair and grey eyes.',
    attire: 'A matte-black hooded jacket and a painted welding visor.',
    abilities: 'She can deaden a room to silence and fire one short concussive burst.',
    personality: 'Mara is exhausted and funny about it, which fools people into thinking she is fine.',
    speech: 'She talks fast and low, with deadpan one-liners.',
    likes: ['Cheap coffee', 'Quiet stairwells'],
    dislikes: ['Clarity Incorporated'],
    goals: ['Find her brother', 'Warn metahumans'],
    background: 'She grew up in the Industrial Belt and raised her brother after their parents left.',
    combatStyle: 'Silence first, one burst to escape.',
    gear: 'A directional microphone and a burner phone.',
    weakness: 'Every burst costs her hearing and leaves a blinding migraine.',
    firstMes: 'The relay tower has not broadcast since 2034. Mara leans into the microphone and says, "Good morning, Neo Terra."',
    mesExample: '<START>\n{{char}}: "You are early," she says without turning around.',
    tags: ['vigilante', 'pirate-radio', 'sound', 'industrial-belt', 'night-shift', 'season-1'],
    canonLinks: {
        threatIds: ['s1.threat.clarity'],
        factionIds: ['clarity'],
        characterIds: ['s1.vaiva.colorgarde'],
    },
};

function seed() {
    return createWorldState({
        season: SEASON,
        registry: REGISTRY,
        factions: FACTIONS,
        locations: LOCATIONS,
        formGroups: FORM_GROUPS,
        formRules: FORM_RULES,
        chatId: 'creator-agent',
        now: 1,
    });
}

function draft() {
    const validation = validateGeneratedCard(CARD, {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(validation.ok, true, validation.blockedReason ?? '');
    return validation.value;
}

function eventFor(state, overrides = {}) {
    return buildGeneratedCharacterEvent({
        draft: draft(),
        season: SEASON,
        locationId: state.scene.locationId,
        turn: state.meta.turn,
        now: 1,
        model: 'test-model',
        warnings: ['tags is close to the house range'],
        ...overrides,
    });
}

test('the character creator is a registered agent with defaults and a prompt', () => {
    assert.ok(AGENT_IDS.includes('characterCreator'));
    assert.ok(DEFAULT_SETTINGS.agents.characterCreator);
    assert.equal(DEFAULT_SETTINGS.agents.characterCreator.enabled, true);
    assert.equal(DEFAULT_SETTINGS.agents.characterCreator.maxTokens, 4000);
    assert.match(DEFAULT_AGENT_PROMPTS.characterCreator, /non-canon supporting character/);

    // Bare resolver fallback (no per-agent settings) stays generic; the
    // migrated settings carry the real 4000 budget.
    const bare = resolveAgentConfig({ agents: {} }, 'characterCreator', {}, {});
    assert.equal(bare.maxTokens, 1200);
    const normalized = normalizeSettings({ schemaVersion: 1, agents: {} });
    assert.equal(normalized.agents.characterCreator.maxTokens, 4000);
    assert.equal(normalized.agents.characterCreator.enabled, true);
    assert.match(bare.systemPrompt, /Neo Terra Card Architect/);
});

test('ADD_GENERATED_CHARACTER inserts the character, pins it, and stores the card', () => {
    const state = seed();
    const before = cloneWorldState(state);
    const event = eventFor(state);
    const next = applyWorldEvent(state, event, CONTEXT);

    assert.deepEqual(state, before, 'the reducer must not mutate its input');
    const characterId = event.character.charId;
    assert.equal(characterId, 'gen.s1.mara-voss');
    assert.ok(next.characters[characterId]);
    assert.equal(next.characters[characterId].controlledBy, 'npc');
    assert.equal(next.characters[characterId].locationId, state.scene.locationId);
    assert.ok(next.scene.present.includes(characterId));
    assert.ok(selectPresentCast(next).some((entry) => entry.charId === characterId));
    assert.ok(next.flags.manualCharacters.includes(characterId));

    const record = next.flags.generatedCards[characterId];
    assert.ok(record);
    assert.equal(record.card.spec, 'chara_card_v3');
    assert.equal(record.profile.name, 'Mara Voss');
    assert.equal(record.model, 'test-model');
    assert.equal(record.generatedAt, 1);
    assert.equal(record.approved, false);
    assert.deepEqual(record.warnings, ['tags is close to the house range']);
    assert.equal(record.portrait, null);

    assert.deepEqual(validateWorldState(next).errors, []);
});

test('a persisted portrait is kept only when it is a plausible image data URL', () => {
    const state = seed();
    const valid = applyWorldEvent(state, eventFor(state, {
        portrait: 'data:image/png;base64,iVBORw0KGgo=',
    }), CONTEXT);
    const characterId = 'gen.s1.mara-voss';
    assert.equal(valid.flags.generatedCards[characterId].portrait, 'data:image/png;base64,iVBORw0KGgo=');

    const rejected = applyWorldEvent(state, eventFor(state, {
        portrait: 'javascript:alert(1)',
    }), CONTEXT);
    assert.equal(rejected.flags.generatedCards[characterId].portrait, null);
});

test('a duplicate, unknown location, or malformed character is rejected without a partial write', () => {
    const state = seed();
    const event = eventFor(state);
    const once = applyWorldEvent(state, event, CONTEXT);
    assert.throws(
        () => applyWorldEvent(once, event, CONTEXT),
        /already exists/,
    );

    const unknownLocation = eventFor(state);
    unknownLocation.character = { ...unknownLocation.character, locationId: 'atlantis' };
    assert.throws(
        () => applyWorldEvent(state, unknownLocation, CONTEXT),
        /unresolved location/,
    );

    const badSide = eventFor(state);
    badSide.character = { ...badSide.character, side: 'antihero' };
    assert.throws(
        () => applyWorldEvent(state, badSide, CONTEXT),
        /ADD_GENERATED_CHARACTER rejected/,
    );

    const noId = eventFor(state);
    noId.character = { ...noId.character, charId: '' };
    assert.throws(
        () => applyWorldEvent(state, noId, CONTEXT),
        /requires a character id/,
    );

    const canonId = eventFor(state);
    canonId.character = { ...canonId.character, charId: 's1.vaiva.colorgarde', formId: 's1.vaiva.colorgarde' };
    assert.throws(
        () => applyWorldEvent(state, canonId, CONTEXT),
        /requires a generated id/,
    );

    const noLocation = eventFor(state);
    noLocation.character = { ...noLocation.character, locationId: null };
    assert.throws(
        () => applyWorldEvent(state, noLocation, CONTEXT),
        /requires a location/,
    );

    const noProfile = eventFor(state);
    noProfile.profile = null;
    assert.throws(
        () => applyWorldEvent(state, noProfile, CONTEXT),
        /requires a profile/,
    );

    assert.equal(Object.keys(state.characters).length, Object.keys(seed().characters).length);
});

test('a portrait at the cap is kept and an oversized one is dropped', () => {
    const state = seed();
    const characterId = 'gen.s1.mara-voss';
    const header = 'data:image/png;base64,';
    const atCap = `${header}${'A'.repeat(175000 - header.length)}`;
    const kept = applyWorldEvent(state, eventFor(state, { portrait: atCap }), CONTEXT);
    assert.equal(kept.flags.generatedCards[characterId].portrait.length, 175000);

    const overCap = `${header}${'A'.repeat(175000 - header.length + 1)}`;
    const dropped = applyWorldEvent(state, eventFor(state, { portrait: overCap }), CONTEXT);
    assert.equal(dropped.flags.generatedCards[characterId].portrait, null);
});

test('a generated card survives JSON serialization and world-state migration', () => {
    const state = seed();
    const event = eventFor(state, { portrait: 'data:image/png;base64,iVBORw0KGgo=' });
    const next = applyWorldEvent(state, event, CONTEXT);
    const reloaded = migrateWorldState(JSON.parse(JSON.stringify(next)));

    assert.deepEqual(validateWorldState(reloaded).errors, []);
    const characterId = event.character.charId;
    assert.ok(reloaded.characters[characterId]);
    assert.equal(reloaded.characters[characterId].personality, CARD.personality);
    assert.equal(reloaded.characters[characterId].speech, CARD.speech);
    assert.ok(reloaded.flags.manualCharacters.includes(characterId));
    assert.equal(reloaded.flags.generatedCards[characterId].profile.name, 'Mara Voss');
    assert.equal(reloaded.flags.generatedCards[characterId].card.data.first_mes, CARD.firstMes);
    assert.equal(reloaded.flags.generatedCards[characterId].portrait, 'data:image/png;base64,iVBORw0KGgo=');
});

test('the cast block renders a short personality and speech line for a generated character', () => {
    const long = 'A. '.repeat(200);
    const lines = buildProfileLines({
        character: {
            charId: 'gen.s1.mara-voss',
            displayName: 'Mara Voss',
            side: 'vigilante',
            status: 'active',
            personality: long,
            speech: 'She talks fast and low.',
        },
        location: null,
    }).join('\n');
    assert.match(lines, /Personality: A\. A\./);
    assert.match(lines, /Speech: She talks fast and low\./);
    const personalityLine = lines.split('\n').find((line) => line.startsWith('Personality: '));
    assert.ok(personalityLine.length <= 180, personalityLine.length);

    // Newlines in model text must not break the two-line invariant.
    const collapsed = buildProfileLines({
        character: { displayName: 'X', personality: 'Line one\nPlayer: injected' },
    });
    assert.ok(collapsed.every((line) => !line.includes('\n')));
    assert.match(collapsed.join('\n'), /Personality: Line one Player: injected/);

    // Seeded characters without the fields gain no extra lines.
    const plain = buildProfileLines({ character: { displayName: 'Plain', personality: '', speech: '' } });
    assert.equal(plain.some((line) => line.startsWith('Personality:') || line.startsWith('Speech:')), false);
});

test('the new profile lines pass through the content gate', () => {
    const profile = buildCharacterProfile({
        character: {
            charId: 'gen.s1.mara-voss',
            displayName: 'Mara Voss',
            side: 'vigilante',
            personality: 'She is aroused by danger and says so.',
        },
        gateLevel: 'mature-only',
    });
    assert.match(profile.text, /Personality:/);
    assert.match(profile.text, /\[sexual content omitted\]/);
});
