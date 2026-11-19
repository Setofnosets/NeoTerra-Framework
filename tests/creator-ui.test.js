import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildCodexView,
    downscalePortrait,
    renderCodexMarkup,
    renderCreatorDialog,
    renderCreatorPreview,
} from '../src/ui/codex.js';
import { loadCardExemplars } from '../src/ui/codex-data.js';
import {
    buildGeneratedCharacterEvent,
    validateGeneratedCard,
} from '../src/agents/character-creator.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { createWorldState } from '../src/state/world-state.js';

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
    identity: 'Pirate-radio host by night.',
    side: 'vigilante',
    threatLevel: 'low',
    gender: 'Female',
    species: 'Human metahuman',
    occupation: 'Night-shift radio host',
    faction: 'Unaffiliated',
    appearance: 'Mara is a lean, tired woman with chopped black hair.',
    attire: 'A matte-black hooded jacket.',
    abilities: 'She can deaden a room to silence and fire one concussive burst.',
    personality: 'Mara is exhausted and funny about it.',
    speech: 'She talks fast and low.',
    likes: ['Cheap coffee'],
    dislikes: ['Clarity Incorporated'],
    goals: ['Find her brother'],
    background: 'She grew up in the Industrial Belt.',
    combatStyle: 'Silence first.',
    gear: 'A directional microphone.',
    weakness: 'Every burst costs her hearing.',
    firstMes: 'The relay tower has not broadcast since 2034. Mara leans into the microphone.',
    mesExample: '<START>\n{{char}}: "You are early."',
    tags: ['vigilante', 'pirate-radio', 'sound', 'industrial-belt', 'night-shift', 'season-1'],
    canonLinks: { threatIds: ['s1.threat.clarity'], factionIds: ['clarity'], characterIds: [] },
};

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

function stateWithGenerated() {
    const state = createWorldState({
        season: SEASON,
        registry: REGISTRY,
        factions: FACTIONS,
        locations: LOCATIONS,
        formGroups: FORM_GROUPS,
        formRules: FORM_RULES,
        chatId: 'creator-ui',
        now: 1,
    });
    const event = buildGeneratedCharacterEvent({
        draft: draft(),
        season: SEASON,
        locationId: state.scene.locationId,
        turn: state.meta.turn,
        now: 1,
        portrait: 'data:image/png;base64,iVBORw0KGgo=',
        warnings: ['appearance is over the guide'],
    });
    return applyWorldEvent(state, event, CONTEXT);
}

function viewFor(state) {
    return buildCodexView({
        state,
        season: SEASON,
        registry: REGISTRY,
        formGroups: FORM_GROUPS,
        formRules: FORM_RULES,
        selectedId: 'gen.s1.mara-voss',
    });
}

test('the creator form renders the concept fields and a generate action', () => {
    const markup = renderCreatorDialog({
        concept: { name: '', side: 'vigilante', concept: '', powers: '', ties: '', contentNote: '' },
    });
    assert.match(markup, /data-neoterra-creator-step="form"/);
    assert.match(markup, /data-neoterra-creator-field="concept"/);
    assert.match(markup, /data-neoterra-creator-field="side"/);
    assert.match(markup, /data-neoterra-creator-portrait/);
    assert.match(markup, /data-neoterra-creator-generate/);
    assert.doesNotMatch(markup, /data-neoterra-creator-keep/);
});

test('the preview renders the card, the badge, the warnings, and keep/regenerate/cancel', () => {
    const markup = renderCreatorDialog({
        draft: draft(),
        warnings: ['appearance is over the guide'],
    });
    assert.match(markup, /data-neoterra-creator-step="preview"/);
    assert.match(markup, /Generated · non-canon/);
    assert.match(markup, /appearance is over the guide/);
    assert.match(markup, /Opening scene/);
    assert.match(markup, /Mara is exhausted and funny/);
    assert.match(markup, /data-neoterra-creator-keep/);
    assert.match(markup, /data-neoterra-creator-regenerate/);
    assert.match(markup, /data-neoterra-codex-dialog-close/);
    assert.doesNotMatch(markup, /data-neoterra-creator-generate/);
});

test('the preview escapes model text', () => {
    const unsafe = draft();
    unsafe.name = '<img src=x onerror=alert(1)>';
    unsafe.personality = 'She said "<script>alert(2)</script>".';
    const markup = renderCreatorPreview({ draft: unsafe, warnings: ['<b>bad</b>'] });
    assert.doesNotMatch(markup, /<img src=x/);
    assert.doesNotMatch(markup, /<script>/);
    assert.doesNotMatch(markup, /<b>bad<\/b>/);
    assert.match(markup, /&lt;img src=x/);
});

test('the busy form and preview disable their actions and show progress', () => {
    const busyForm = renderCreatorDialog({
        concept: { name: '', side: 'vigilante', concept: 'A courier.', powers: '', ties: '', contentNote: '' },
        busy: true,
    });
    assert.match(busyForm, /data-neoterra-creator-busy/);
    assert.match(busyForm, /data-neoterra-creator-generate disabled/);
    assert.match(busyForm, /data-neoterra-creator-form disabled/);

    const busyPreview = renderCreatorDialog({ draft: draft(), busy: true });
    assert.match(busyPreview, /Regenerating…/);
    assert.match(busyPreview, /data-neoterra-creator-keep disabled/);
    assert.match(busyPreview, /data-neoterra-creator-regenerate disabled/);
    assert.match(busyPreview, /data-neoterra-creator-busy/);
});

test('a preview with no optional lists still renders', () => {
    const minimal = { ...draft(), goals: [], likes: [], dislikes: [], tags: [] };
    const markup = renderCreatorPreview({ draft: minimal });
    assert.match(markup, /Opening scene/);
    assert.doesNotMatch(markup, /<h6>Goals<\/h6>/);
});

test('the empty preview is inert', () => {
    assert.equal(renderCreatorPreview({ draft: null }), '');
});

test('portrait guards reject non-images and oversized files before reading', async () => {
    assert.match((await downscalePortrait(null)).error, /Choose an image/);
    assert.match((await downscalePortrait({ type: 'image/gif', size: 10 })).error, /PNG, JPEG, or WebP/);
    assert.match((await downscalePortrait({ type: 'image/png', size: 5 * 1024 * 1024 })).error, /4 MB/);
});

test('the codex lists a generated character with its badge and portrait', () => {
    const state = stateWithGenerated();
    const view = viewFor(state);
    const item = view.items.find((entry) => entry.characterId === 'gen.s1.mara-voss');
    assert.ok(item);
    assert.equal(item.generated, true);
    assert.equal(item.portraitUrl, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(item.nonCanon, true);
    assert.equal(view.selected.generated, true);
    assert.equal(view.selected.profile.liveAppearance, CARD.appearance);
    assert.deepEqual(view.selected.generatedWarnings, ['appearance is over the guide']);

    const markup = renderCodexMarkup(view);
    assert.match(markup, /data-neoterra-create-character/);
    assert.match(markup, /Generated/);
    assert.match(markup, /data-neoterra-export-generated-card="gen\.s1\.mara-voss"/);
    assert.match(markup, /data-avatar-source="generated"/);
});

test('loadCardExemplars filters, skips failures, and caches by entry set', async () => {
    const { clearCardExemplarCache } = await import('../src/ui/codex-data.js');
    clearCardExemplarCache();
    const cards = {
        'Chars/S1/A.json': { data: { name: 'A', description: 'Appearance: a hero.' } },
        'Chars/S1/B.json': { data: { name: 'B', description: '' } },
    };
    let calls = 0;
    const fetchImpl = async (href) => {
        calls += 1;
        const key = Object.keys(cards).find((path) => href.endsWith(path.split('/').join('/')));
        if (!key) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => cards[key] };
    };
    const registry = {
        entries: [
            { id: 'a', seasonId: 's1', formKind: 'base', cardPath: 'Chars/S1/A.json' },
            { id: 'b', seasonId: 's1', formKind: 'base', cardPath: 'Chars/S1/B.json' },
            { id: 'c', seasonId: 's1', formKind: 'corrupted', cardPath: 'Chars/S1/C.json' },
            { id: 'd', seasonId: 's1', formKind: 'base', bundle: true, cardPath: 'Chars/S1/D.json' },
            { id: 'e', seasonId: 's1', formKind: 'base', cardPath: 'Chars/S1/Missing.json' },
        ],
    };
    const first = await loadCardExemplars({ registry, seasonId: 's1', fetchImpl });
    assert.deepEqual(first.map((exemplar) => exemplar.name), ['A']);
    assert.equal(calls, 3, 'only the three eligible entries are fetched');

    const before = calls;
    const second = await loadCardExemplars({ registry, seasonId: 's1', fetchImpl });
    assert.deepEqual(second, first);
    assert.equal(calls, before, 'a repeated call is served from the cache');

    // A different entry set must not reuse the cache.
    await loadCardExemplars({ registry: { entries: registry.entries.slice(0, 1) }, seasonId: 's1', fetchImpl });
    assert.ok(calls > before);

    assert.deepEqual(await loadCardExemplars({ registry: null, seasonId: 's1' }), []);
    assert.deepEqual(await loadCardExemplars({ registry, seasonId: null }), []);
    clearCardExemplarCache();
});

test('a seeded card without generated flags renders no generated affordances', () => {
    const state = createWorldState({
        season: SEASON,
        registry: REGISTRY,
        factions: FACTIONS,
        locations: LOCATIONS,
        formGroups: FORM_GROUPS,
        formRules: FORM_RULES,
        chatId: 'creator-ui-plain',
        now: 1,
    });
    const view = buildCodexView({
        state,
        season: SEASON,
        registry: REGISTRY,
        formGroups: FORM_GROUPS,
        formRules: FORM_RULES,
    });
    assert.equal(view.items.every((item) => item.generated === false), true);
    assert.doesNotMatch(renderCodexMarkup(view), /data-neoterra-export-generated-card/);
});
