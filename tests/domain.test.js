import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDomainView, isDomainActive } from '../src/data/domain.js';
import { validateSeasonDefinition } from '../src/data/seasons.js';
import { buildRegistryIndex } from '../src/data/registry.js';
import { renderContext } from '../src/context/renderer.js';
import { BLOCK_PRIORITY, DEFAULT_TOKEN_BUDGET, applyTokenBudget } from '../src/context/budget.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const locations = readJson('data/locations.json');
const districts = readJson('data/districts.json');
const s1dark = readJson('data/seasons/s1dark.json');
const sandbox = readJson('data/seasons/sandbox.json');

function character(id, overrides = {}) {
    return {
        charId: id,
        formId: id,
        formGroup: overrides.formGroup ?? null,
        displayName: overrides.displayName ?? id,
        side: overrides.side ?? 'villain',
        status: overrides.status ?? 'active',
        locationId: overrides.locationId ?? 'clarity-hq',
        allegiance: 'allegiance' in overrides ? overrides.allegiance : 'clarity',
        corruption: { stage: overrides.corruptionStage ?? 0, progress: overrides.corruptionProgress ?? 0 },
        ...overrides,
    };
}

function makeState(overrides = {}) {
    return {
        player: { identity: 'custom', displayName: 'The Player', relationships: [] },
        playerRole: 'villain',
        characters: {},
        locations: {},
        factions: {
            clarity: { id: 'clarity', name: 'Clarity Incorporated', side: 'villain', influence: 85, headquartersLocationId: 'clarity-hq' },
            petrabyte: { id: 'petrabyte', name: 'PetraByte', side: 'hero', influence: 25 },
        },
        threats: [],
        recentEvents: [],
        badEnds: {},
        ...overrides,
    };
}

const syntheticRegistry = {
    entries: [
        { id: 'k1.base', displayName: 'Base One', side: 'hero', formKind: 'base', formGroup: 'g1' },
        { id: 'k1.knight', displayName: 'Knight One', side: 'villain', formKind: 'knighted', formGroup: 'g1', altOf: 'k1.base' },
        { id: 'k2.base', displayName: 'Base Two', side: 'hero', formKind: 'base', formGroup: 'g2' },
        { id: 'k2.knight', displayName: 'Knight Two', side: 'villain', formKind: 'knighted', formGroup: 'g2', altOf: 'k2.base' },
        { id: 'other', displayName: 'Other', side: 'neutral', formKind: 'base', formGroup: 'g3' },
    ],
};

const syntheticSeason = {
    id: 'scratch',
    playerRole: 'villain',
    domain: {
        name: 'The Garden',
        factionId: 'clarity',
        description: 'A domain of thorns.',
        loreText: 'Every rose here has teeth.',
        knightFormKind: 'knighted',
        watchDistricts: ['downtown'],
        resistanceFactionIds: ['petrabyte'],
    },
};

test('s1dark authors a valid domain block', () => {
    const validation = validateSeasonDefinition(s1dark, {
        registry,
        factions: readJson('data/factions.json'),
        locations,
        districts,
    });
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    assert.equal(s1dark.domain.name, 'Wonderland');
    assert.equal(s1dark.domain.factionId, 'clarity');
    assert.equal(s1dark.domain.knightFormKind, 'knighted');
});

test('a scratch villain season validates with its own domain', () => {
    const minimal = {
        schemaVersion: 1,
        id: 's1',
        title: 'Scratch',
        era: 'Test',
        anchorDate: null,
        premise: 'Test.',
        toneNotes: 'Test.',
        playerRole: 'villain',
        defaultPlayerCharacterId: null,
        playable: true,
        alt: false,
        sandbox: true,
        allowAnyCharacter: false,
        roster: [
            { characterId: 's1.vaiva.colorgarde', formId: 's1.vaiva.colorgarde', locationId: 'central-plaza' },
        ],
        factions: [],
        threats: [],
        startLocationId: 'central-plaza',
        openingBeats: [],
        canonBeats: [],
        finalDeadline: { turns: 10, date: null },
        failureState: 'none',
        manualOnly: [],
        altFormsAllowed: [],
        domain: { name: 'The Garden', factionId: 'clarity' },
    };
    const validation = validateSeasonDefinition(minimal, {
        registry,
        factions: readJson('data/factions.json'),
        locations,
        districts,
    });
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test('a malformed domain block fails validation', () => {
    const bad = { ...s1dark, domain: { name: '', factionId: 'nope', watchDistricts: ['nowhere'] } };
    const validation = validateSeasonDefinition(bad, {
        registry,
        factions: readJson('data/factions.json'),
        locations,
        districts,
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.path === 'domain.name'));
    assert.ok(validation.errors.some((error) => error.path === 'domain.factionId'));
    assert.ok(validation.errors.some((error) => error.path === 'domain.watchDistricts[0]'));
});

test('hero seasons and sandbox produce an inactive view', () => {
    const heroSeason = { ...sandbox, playerRole: 'hero' };
    assert.equal(buildDomainView({ state: makeState({ playerRole: 'hero' }), season: heroSeason }).active, false);
    assert.equal(buildDomainView({ state: makeState(), season: sandbox }).active, false);
    assert.equal(isDomainActive(makeState(), heroSeason), false);
});

test('the domain follows the season even when the played identity is heroic', () => {
    const state = makeState({
        player: { identity: 'canon', characterId: 's1dark.carol.cleansed.bleeding.heart', relationships: [] },
        playerRole: 'villain',
    });
    const view = buildDomainView({ state, season: s1dark, registry });
    assert.equal(view.active, true);
    assert.equal(view.wonderland.name, 'Wonderland');
});

test('knights resolve from the registry and reflect live form state', () => {
    const state = makeState({
        characters: {
            'k1.base': character('k1.base', { formGroup: 'g1', side: 'villain' }),
            'k2.base': character('k2.base', { formGroup: 'g2', formId: 'k2.knight', side: 'villain' }),
        },
        locations: {
            'clarity-hq': { id: 'clarity-hq', name: 'Clarity HQ', district: 'Downtown', factionId: 'clarity' },
        },
    });
    const view = buildDomainView({ state, season: syntheticSeason, registry: syntheticRegistry });
    assert.equal(view.active, true);
    assert.equal(view.knights.length, 2);
    const one = view.knights.find((knight) => knight.id === 'k1.knight');
    const two = view.knights.find((knight) => knight.id === 'k2.knight');
    assert.equal(one.active, false);
    assert.equal(one.baseCharacterId, 'k1.base');
    assert.equal(one.locationName, 'Clarity HQ');
    assert.equal(two.active, true);
});

test('a villain world without knighted characters has an empty knights section', () => {
    const state = makeState({ characters: { other: character('other') } });
    const view = buildDomainView({ state, season: s1dark, registry: { entries: [] } });
    assert.deepEqual(view.knights, []);
    assert.equal(view.active, true);
});

test('court captures corrupted, sworn, and owner/servant characters', () => {
    const state = makeState({
        characters: {
            a: character('a', { corruptionStage: 2, corruptionProgress: 40 }),
            b: character('b', { allegiance: 'clarity', corruptionStage: 0 }),
            c: character('c', { corruptionStage: 0, allegiance: null }),
        },
        player: {
            identity: 'custom',
            displayName: 'The Player',
            relationships: [
                { withCharacterId: 'c', type: 'owner/servant', affinity: 50, tension: 0 },
            ],
        },
    });
    const view = buildDomainView({ state, season: s1dark, registry: { entries: [] } });
    const ids = view.court.map((member) => member.id);
    assert.deepEqual(ids, ['a', 'b', 'c']);
    assert.deepEqual(view.court.find((member) => member.id === 'c').reasons, ['owner/servant']);
    assert.equal(view.corruptionSpread.byStage[2], 1);
    assert.equal(view.corruptionSpread.top[0].id, 'a');
});

test('territory counts reconcile with live location control', () => {
    const state = makeState({
        locations: {
            'clarity-hq': { id: 'clarity-hq', name: 'Clarity HQ', district: 'Downtown', factionId: 'clarity' },
            'petrabyte-tower': { id: 'petrabyte-tower', name: 'PetraByte Tower', district: 'Downtown', factionId: 'petrabyte' },
            'central-plaza': { id: 'central-plaza', name: 'Central Plaza', district: 'Downtown', factionId: null },
        },
    });
    const view = buildDomainView({ state, season: s1dark, registry, locations, districts });
    const downtown = view.territory.districts.find((district) => district.id === 'downtown');
    assert.ok(downtown);
    // The authored document holds more Downtown locations than the three live
    // overrides above; every one is counted exactly once.
    const downtownAuthored = locations.locations.filter((entry) => entry.districtId === 'downtown');
    assert.equal(downtown.controlled + downtown.hostile + downtown.neutral, downtownAuthored.length);
    assert.ok(downtown.controlled >= 1);
    assert.ok(downtown.hostile >= 1);
    assert.ok(downtown.neutral >= 1);
    assert.equal(downtown.status, 'contested');
    assert.equal(downtown.watched, true);
    const totals = view.territory.counts;
    assert.equal(
        totals.controlled + totals.contested + totals.hostile + totals.unclaimed,
        totals.districts,
    );
    assert.equal(totals.districts, view.territory.districts.length);
});

test('territory still renders from live locations without the authored document', () => {
    const state = makeState({
        locations: {
            a: { id: 'a', district: 'Downtown', factionId: 'clarity' },
            b: { id: 'b', district: 'Harbor', factionId: 'petrabyte' },
        },
    });
    const view = buildDomainView({ state, season: s1dark, registry: { entries: [] } });
    assert.equal(view.territory.counts.districts, 2);
    assert.equal(view.territory.counts.controlled, 1);
});

test('resistance inverts the threat framing and keeps stages', () => {
    const state = makeState({
        threats: [
            { id: 't1', name: 'The Underground Resistance', sourceFactionId: 'petrabyte', stages: ['A', 'B', 'C'], progress: 50, stage: 1, status: 'active' },
            { id: 't2', name: 'Contained Cell', sourceFactionId: 'petrabyte', stages: ['A', 'B'], progress: 80, status: 'contained' },
            { id: 't3', name: 'Our Own Scheme', sourceFactionId: 'clarity', stages: ['A', 'B'], progress: 10, status: 'active' },
        ],
    });
    const view = buildDomainView({ state, season: s1dark, registry: { entries: [] } });
    assert.equal(view.resistance.length, 1);
    assert.equal(view.resistance[0].id, 't1');
    assert.equal(view.resistance[0].stageLabel, 'B');
    assert.match(view.resistance[0].danger, /^B/);
});

test('feed keeps only off-screen, knight, corruption, and beat events', () => {
    const state = makeState({
        recentEvents: [
            { summary: 'a', tags: ['offscreen'] },
            { summary: 'b', tags: ['chat'] },
            { summary: 'c', tags: ['beat'] },
        ],
    });
    const view = buildDomainView({ state, season: s1dark, registry: { entries: [] } });
    assert.deepEqual(view.feed.map((entry) => entry.summary), ['c', 'a']);
});

test('the prompt block renders only for an active villain domain', () => {
    const state = makeState({
        characters: {
            's1dark.heart.attack.knighted.cyber.sakura': character('s1dark.heart.attack.knighted.cyber.sakura', {
                displayName: 'Heart Attack',
                formGroup: 's1dark.akui',
            }),
        },
    });
    const active = renderContext(state, { season: s1dark, registry });
    const domain = active.blocks.find((block) => block.id === 'domain');
    assert.ok(domain, 'expected a [NEOTERRA_DOMAIN] block');
    assert.match(domain.heading, /NEOTERRA_DOMAIN/);
    assert.match(domain.body, /Wonderland/);
    assert.match(domain.body, /Heart Attack/);
    assert.match(domain.body, /Territory:/);

    const hero = renderContext(state, { season: { ...s1dark, playerRole: 'hero' }, registry });
    assert.equal(hero.blocks.some((block) => block.id === 'domain'), false);

    const disabled = renderContext(state, {
        season: s1dark,
        registry,
        settings: { ...DEFAULT_SETTINGS, context: { ...DEFAULT_SETTINGS.context, blocks: { ...DEFAULT_SETTINGS.context.blocks, domain: false } } },
    });
    assert.equal(disabled.blocks.some((block) => block.id === 'domain'), false);

    const noDomain = renderContext(state, { season: sandbox, registry });
    assert.equal(noDomain.blocks.some((block) => block.id === 'domain'), false);
});

test('the domain view model never mutates state', () => {
    const state = makeState({ characters: { a: character('a', { corruptionStage: 1 }) } });
    const before = JSON.parse(JSON.stringify(state));
    buildDomainView({ state, season: s1dark, registry, locations, districts });
    assert.deepEqual(state, before);
});

test('no authored Wonderland text is duplicated into the code', () => {
    const domainSource = readFileSync(join(ROOT, 'src/data/domain.js'), 'utf8');
    const uiSource = readFileSync(join(ROOT, 'src/ui/sensorium.js'), 'utf8');
    assert.doesNotMatch(domainSource, /Wonderland|Queen of Hearts/);
    assert.doesNotMatch(uiSource, /Wonderland|Queen of Hearts/);
});

test('knights are scoped to the current season', () => {
    const state = makeState({ characters: {} });
    const scratch = {
        ...syntheticSeason,
        id: 'scratch',
        domain: { ...syntheticSeason.domain, knightFormKind: 'knighted' },
    };
    const view = buildDomainView({ state, season: scratch, registry: syntheticRegistry });
    // Entries without a seasonId are legacy/test data and stay visible.
    assert.equal(view.knights.length, 2);
    const withSeason = {
        entries: [
            { id: 'a.knight', displayName: 'Ours', formKind: 'knighted', seasonId: 'scratch', formGroup: 'ga' },
            { id: 'b.knight', displayName: 'Theirs', formKind: 'knighted', seasonId: 's1dark', formGroup: 'gb' },
        ],
    };
    const scoped = buildDomainView({ state, season: scratch, registry: withSeason });
    assert.deepEqual(scoped.knights.map((knight) => knight.id), ['a.knight']);
});

test('a prebuilt registry index supplies knights', () => {
    const state = makeState({});
    const view = buildDomainView({
        state,
        season: s1dark,
        registry: buildRegistryIndex(registry),
    });
    assert.ok(view.knights.length >= 3);
});

test('the domain block has its own budget and drops before narrative context', () => {
    assert.equal(DEFAULT_TOKEN_BUDGET.domain, 350);
    assert.equal(BLOCK_PRIORITY.domain, 3.5);
    assert.ok(BLOCK_PRIORITY.domain <= BLOCK_PRIORITY.news);
    const blocks = [
        { id: 'scene', heading: 'S', body: 'x'.repeat(40), priority: 0 },
        { id: 'domain', heading: 'D', body: 'x'.repeat(40), priority: 3.5 },
        { id: 'pacing', heading: 'P', body: 'x'.repeat(40), priority: 7 },
    ];
    const result = applyTokenBudget(blocks, { ...DEFAULT_TOKEN_BUDGET, total: 20 });
    assert.ok(result.dropped.includes('pacing'));
    assert.equal(result.dropped.includes('domain'), false);
});

test('the registry index resolves the S1Dark knight forms', () => {
    const index = buildRegistryIndex(registry);
    const knights = Object.values(index.byId).filter((entry) => entry.formKind === 'knighted');
    assert.ok(knights.length >= 3);
});
