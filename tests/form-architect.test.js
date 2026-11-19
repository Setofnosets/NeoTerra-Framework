import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildFormArchitectPrompt,
    createFormArchitect,
    generatedFormOverlay,
    validateGeneratedForm,
} from '../src/agents/form-architect.js';
import { createWorldState } from '../src/state/world-state.js';
import { applyWorldEvent } from '../src/state/reducer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const registry = readJson('data/characters/index.json');
const profiles = readJson('data/characters/profiles.json').profiles;
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const s1 = readJson('data/seasons/s1.json');

const valid = {
    displayName: 'Light Shade (Generated)',
    side: 'villain',
    formKind: 'corrupted',
    appearance: 'A shadow-wrapped figure with neon seams.',
    attire: 'A tattered coat and a mirrored mask.',
    personality: 'Cold and exacting.',
    speech: 'Clipped, quiet sentences.',
    abilities: ['Shadow step', 'Mirror echo'],
    likes: ['Control'],
    dislikes: ['Noise'],
    goals: ['Turn the district quiet'],
    notes: 'Generated as a fallback profile.',
    transformationSummary: 'The corruption folds the light inward.',
};

test('a valid generated form normalizes and caps fields', () => {
    const result = validateGeneratedForm(valid);
    assert.equal(result.ok, true);
    assert.equal(result.value.displayName, valid.displayName);
    assert.deepEqual(result.value.abilities, valid.abilities);
});

test('missing required fields are rejected', () => {
    const result = validateGeneratedForm({ ...valid, appearance: '' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /appearance/.test(error)));
});

test('the prompt includes threats, factions, other cast, and the form group', () => {
    const prompt = buildFormArchitectPrompt({
        season: s1,
        character: {
            charId: 's1.vaiva.colorgarde',
            formId: 's1.vaiva.colorgarde',
            displayName: 'Vaiva',
            appearance: 'Tall, bright.',
            abilities: ['Light'],
        },
        targetFormId: 's1.light.shade.corrupted.colorgarde',
        formLabel: 'Light Shade',
        otherCast: [{ displayName: 'Claire Atropos', side: 'villain' }],
        recentScene: { location: 'Central Plaza' },
    });
    assert.match(prompt, /Season threats and factions/);
    assert.match(prompt, /Other cast/);
    assert.match(prompt, /Central Plaza/);
    assert.match(prompt, /Light Shade/);
});

test('a fake runner success produces an overlay and a validated value', async () => {
    const agent = createFormArchitect({
        runner: { runAgent: async () => valid },
        getSettings: () => ({ agents: { formArchitect: { enabled: true } } }),
    });
    const result = await agent.run({ season: s1, character: { charId: 'x' }, targetFormId: 'f2' });
    assert.equal(result.ok, true);
    assert.match(result.overlay.appearance, /shadow/i);
    assert.equal(result.overlay.source, 'generated');
});

test('invalid JSON and timeouts fail without throwing', async () => {
    const invalid = createFormArchitect({
        runner: { runAgent: async () => ({ nope: true }) },
        getSettings: () => ({ agents: { formArchitect: { enabled: true } } }),
    });
    const invalidResult = await invalid.run({ season: s1, character: { charId: 'x' } });
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.reason, 'invalid');

    const timedOut = createFormArchitect({
        runner: { runAgent: async () => { throw new Error('timeout'); } },
        getSettings: () => ({ agents: { formArchitect: { enabled: true } } }),
    });
    const timeoutResult = await timedOut.run({ season: s1, character: { charId: 'x' } });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.reason, 'failed');
});

test('a generated overlay applies through TRANSFORM and is stored per chat', () => {
    const state = createWorldState({
        season: s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'generated-form-chat',
        player: { identity: 'custom' },
        now: 1,
    });
    const characterId = 's1.vaiva.colorgarde';
    const formId = 'generated.vaiva.shadow';
    const dynamicForm = {
        ...valid,
        overlay: generatedFormOverlay(valid, { formId }),
    };
    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId, formId, dynamicForm },
        { registry, formGroups, formRules },
    );
    assert.equal(next.characters[characterId].formId, formId);
    assert.equal(next.characters[characterId].profileSource, 'generated');
    assert.match(next.characters[characterId].appearance, /shadow/i);
    assert.equal(next.flags.generatedForms[characterId][formId].generated, true);
    assert.equal(next.flags.generatedForms[characterId][formId].overlay.source, 'generated');
});

test('the export payload keeps the generated flag', () => {
    const overlay = generatedFormOverlay(valid, { formId: 'f2' });
    assert.equal(overlay.generated, true);
    assert.equal(overlay.approved, false);
    assert.equal(overlay.formId, 'f2');
});

test('the codex renders the generated section, export, edit, and approve actions', async () => {
    const { buildCodexView, renderCodexMarkup } = await import('../src/ui/codex.js');
    const state = createWorldState({
        season: s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'codex-generated',
        player: { identity: 'custom' },
        now: 1,
    });
    const characterId = 's1.vaiva.colorgarde';
    const formId = 'generated.vaiva.shadow';
    const dynamicForm = { ...valid, overlay: generatedFormOverlay(valid, { formId }) };
    const next = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId, formId, dynamicForm },
        { registry, formGroups, formRules },
    );
    const view = buildCodexView({
        state: next,
        season: s1,
        registry,
        formGroups,
        formRules,
        profiles,
        selectedId: characterId,
    });
    const markup = renderCodexMarkup(view);
    assert.match(markup, /data-neoterra-generated-form/);
    assert.match(markup, /data-neoterra-generate-export/);
    assert.match(markup, /data-neoterra-generate-edit/);
    assert.match(markup, /data-neoterra-generate-approve/);
    assert.match(markup, /Generated form/);
});

