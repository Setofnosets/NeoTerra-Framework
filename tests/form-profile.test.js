import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorldState } from '../src/state/world-state.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { buildFormProfileOverlay, applyFormProfileOverlay } from '../src/state/form-profiles.js';
import { buildFormIndex } from '../src/data/forms.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const registry = readJson('data/characters/index.json');
const profiles = readJson('data/characters/profiles.json').profiles;
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const s1 = readJson('data/seasons/s1.json');

const CONTEXT = { registry, formGroups, formRules, factions, locations };

function seed() {
    return createWorldState({
        season: s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'form-profile-chat',
        player: { identity: 'custom' },
        now: 1,
    });
}

const VAIVA = 's1.vaiva.colorgarde';
const LIGHT_SHADE = 's1.light.shade.corrupted.colorgarde';

test('seeding stores one overlay per form in the group', () => {
    const state = seed();
    const character = state.characters[VAIVA];
    assert.ok(character.formProfiles);
    assert.ok(character.formProfiles[VAIVA]);
    assert.ok(character.formProfiles[LIGHT_SHADE]);
    assert.equal(character.profileFormId, VAIVA);
    assert.equal(character.profileSource, 'card');
    // The active overlay is what seeded the live text.
    assert.equal(character.appearance, character.formProfiles[VAIVA].appearance);
    assert.match(character.formProfiles[LIGHT_SHADE].appearance, /Light Shade/);
});

test('transform swaps appearance, attire, abilities, skills, traits, aliases, tags, and likes', () => {
    const state = seed();
    const before = state.characters[VAIVA];
    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: VAIVA, formId: LIGHT_SHADE },
        CONTEXT,
    );
    const after = next.characters[VAIVA];
    assert.equal(after.formId, LIGHT_SHADE);
    assert.equal(after.profileFormId, LIGHT_SHADE);
    assert.equal(after.profileSource, 'card');
    assert.notEqual(after.appearance, before.appearance);
    assert.match(after.appearance, /Light Shade/);
    assert.deepEqual(after.abilities, after.formProfiles[LIGHT_SHADE].abilities);
    assert.deepEqual(after.skills, after.formProfiles[LIGHT_SHADE].skills);
    assert.deepEqual(after.traits, after.formProfiles[LIGHT_SHADE].traits);
    assert.deepEqual(after.likes, after.formProfiles[LIGHT_SHADE].likes);
    // Aliases/tags follow the active form's registry entry (Light Shade's card
    // labels no aliases, so the list is honestly empty).
    assert.deepEqual(after.aliases, []);
    assert.equal(after.tags[0], 'femdom');
    assert.equal(after.tags.includes('Corruption'), true);
    // Resources and status are untouched.
    assert.deepEqual(after.stamina, before.stamina);
    assert.deepEqual(after.willpower, before.willpower);
    assert.deepEqual(after.corruption, before.corruption);
    assert.equal(after.status, before.status);
});

test('reverting restores base aliases and facets', () => {
    const dark = readJson('data/seasons/s1dark.json');
    const base = createWorldState({
        season: dark,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'form-profile-dark',
        player: { identity: 'custom' },
        now: 1,
    });
    const characterId = 's1dark.carol.bleeding-heart';
    const altId = 's1dark.carol.cleansed.bleeding.heart';
    const baseCharacter = base.characters[characterId];
    const baseAliases = baseCharacter.aliases.slice();
    const baseSkills = baseCharacter.skills.slice();
    assert.ok(baseAliases.includes('Bleeding Heart'));

    const transformed = applyWorldEvent(
        base,
        { type: 'TRANSFORM', characterId, formId: altId },
        CONTEXT,
    );
    assert.deepEqual(transformed.characters[characterId].aliases, base.characters[altId]?.aliases
        ?? registry.entries.find((entry) => entry.id === altId).aliases);

    const reverted = applyWorldEvent(
        transformed,
        { type: 'TRANSFORM', characterId, formId: characterId },
        CONTEXT,
    );
    const after = reverted.characters[characterId];
    assert.deepEqual(after.aliases, baseAliases);
    assert.deepEqual(after.skills, baseSkills);
});

test('a tracker-written goal survives a transform and a form swap keeps it', () => {
    const state = seed();
    state.characters[VAIVA].goals = ['Expose Clairity Incorporated'];
    state.characters[VAIVA].goalsSource = 'live';
    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: VAIVA, formId: LIGHT_SHADE },
        CONTEXT,
    );
    assert.deepEqual(next.characters[VAIVA].goals, ['Expose Clairity Incorporated']);
    assert.equal(next.characters[VAIVA].goalsSource, 'live');
});

test('seeded goals carry the card source marker', () => {
    const state = seed();
    assert.equal(state.characters[VAIVA].goalsSource, 'card');
});

test('reverting restores the base overlay', () => {
    const state = seed();
    const characterId = 's1.claire.atropos';
    const altId = 's1.claire.lachesis.cleansed.claire.atropos';
    const base = state.characters[characterId];
    assert.ok(base.formProfiles[altId]);
    const transformed = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId, formId: altId },
        CONTEXT,
    );
    const reverted = applyWorldEvent(
        transformed,
        { type: 'TRANSFORM', characterId, formId: characterId },
        CONTEXT,
    );
    const after = reverted.characters[characterId];
    assert.equal(after.formId, characterId);
    assert.equal(after.appearance, base.appearance);
    assert.deepEqual(after.abilities, base.abilities);
    assert.equal(after.profileFormId, characterId);
});

test('manual edits and live fields survive a transform', () => {
    const state = seed();
    const manualAppearance = 'A hand-written appearance that must survive.';
    state.characters[VAIVA].appearance = manualAppearance;
    state.characters[VAIVA].relationships = [{ a: VAIVA, b: 's1.claire.atropos', type: 'rival', affinity: -20, tension: 40 }];
    state.flags = {
        ...(state.flags ?? {}),
        playerTracker: { manualEdits: { appearance: { value: manualAppearance } } },
    };
    // The player must be Vaiva for the manual marker to apply.
    state.player = {
        ...state.characters[VAIVA],
        identity: 'canon',
        characterId: VAIVA,
    };
    state.characters[VAIVA].controlledBy = 'player';

    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: VAIVA, formId: LIGHT_SHADE },
        CONTEXT,
    );
    const after = next.characters[VAIVA];
    assert.equal(after.appearance, manualAppearance);
    assert.deepEqual(after.relationships, state.characters[VAIVA].relationships);
    // Non-manual profile fields still changed.
    assert.notDeepEqual(after.abilities, state.characters[VAIVA].abilities);
});

test('a form without a card profile keeps the previous fields and records a note', () => {
    const state = seed();
    const character = state.characters[VAIVA];
    const previousAppearance = character.appearance;
    delete character.formProfiles[LIGHT_SHADE];
    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: VAIVA, formId: LIGHT_SHADE },
        CONTEXT,
    );
    const after = next.characters[VAIVA];
    assert.equal(after.appearance, previousAppearance);
    assert.equal(after.profileSource, 'missing');
    assert.equal(after.profileMissing, LIGHT_SHADE);
});

test('a generated form with no registry metadata clears aliases instead of inheriting', () => {
    const state = seed();
    const character = state.characters[VAIVA];
    assert.ok(character.aliases.length > 0);
    const next = applyWorldEvent(
        state,
        {
            type: 'TRANSFORM',
            characterId: VAIVA,
            formId: 'generated.light.shade',
            dynamicForm: {
                formId: 'generated.light.shade',
                displayName: 'Generated Shade',
                side: 'villain',
                overlay: {
                    appearance: 'A generated appearance.',
                    outfit: '',
                    abilities: ['Generated ability'],
                    skills: [],
                    traits: [],
                    likes: [],
                    dislikes: [],
                    goals: [],
                    notes: '',
                    source: 'generated',
                },
            },
        },
        CONTEXT,
    );
    // No metadata means no stale aliases from the previous form.
    assert.deepEqual(next.characters[VAIVA].aliases, []);
    assert.deepEqual(next.characters[VAIVA].tags, []);
});

test('the overlay helper never touches live combat state', () => {
    const overlay = buildFormProfileOverlay(profiles[LIGHT_SHADE], { formId: LIGHT_SHADE });
    const character = {
        appearance: 'old',
        outfit: 'old',
        abilities: ['old'],
        traits: [],
        likes: [],
        dislikes: [],
        goals: [],
        notes: '',
        stamina: { current: 12, max: 100 },
        status: 'captured',
    };
    applyFormProfileOverlay(character, overlay);
    assert.equal(character.stamina.current, 12);
    assert.equal(character.status, 'captured');
    assert.match(character.appearance, /Light Shade/);
});

test('the form index resolves the group used for seeding', () => {
    const index = buildFormIndex(registry, formGroups);
    assert.equal(index.groupByMemberId[VAIVA].id, 's1.vaiva');
    assert.equal(index.groupByMemberId[LIGHT_SHADE].id, 's1.vaiva');
});
