import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    collectTravelRegions,
    computeRegionVisibility,
    destinationVisibility,
    getExploration,
    normalizeExploration,
    regionState,
    seedExplorationFor,
} from '../src/state/exploration.js';
import {
    applyMapFog,
    buildMapViewModel,
    buildMapSubmenu,
    buildTravelGraph,
} from '../src/data/map.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { createWorldState } from '../src/state/world-state.js';
import { createWorldStateStore } from '../src/state/store.js';
import { createTravelFlow } from '../src/flows/travel.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { migrateSettings } from '../src/core/migrations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const districts = readJson('data/districts.json');
const regions = readJson('data/map/regions.geojson');
const bridges = readJson('data/map/bridges.geojson');
const keyLocations = readJson('data/map/key-locations.json');
const overrides = readJson('data/map/overrides.json');
const seasonS1 = readJson('data/seasons/s1.json');

const SYNTHETIC_REGIONS = [
    { id: 'region:a', label: 'A', name: 'Alpha' },
    { id: 'region:b', label: 'B', name: 'Beta' },
    { id: 'region:c', label: 'C', name: 'Gamma' },
];
const SYNTHETIC_BRIDGES = [{ id: 'bridge:ab', label: 'AB', connects: ['region:a', 'region:b'] }];

function seed() {
    return createWorldState({
        season: seasonS1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'exploration-test',
        now: 123,
    });
}

function viewModel(state) {
    return buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        state,
    });
}

test('a fresh world seeds exactly the start region as discovered', () => {
    const state = seed();
    const exploration = getExploration(state);
    assert.ok(exploration);
    const discovered = Object.entries(exploration.regions)
        .filter(([, entry]) => entry.state === 'discovered')
        .map(([id]) => id);
    assert.deepEqual(discovered, ['region:center']);
    assert.equal(exploration.regions['region:center'].source, 'start');
    assert.deepEqual(exploration.keyLocations, {});
    assert.equal(regionState(exploration, 'region:center'), 'discovered');
    assert.equal(regionState(exploration, 'region:nowhere'), 'unknown');
});

test('rumors mode marks bridge neighbours rumored, hard mode reveals none', () => {
    const exploration = seedExplorationFor({
        locations: { locations: [{ id: 'x', regionId: 'region:a' }] },
        startLocationId: 'x',
    });
    const rumors = computeRegionVisibility({
        exploration,
        regions: SYNTHETIC_REGIONS,
        bridges: SYNTHETIC_BRIDGES,
        mode: 'rumors',
    });
    assert.equal(rumors.get('region:a'), 'discovered');
    assert.equal(rumors.get('region:b'), 'rumored');
    assert.equal(rumors.get('region:c'), 'unknown');

    const hard = computeRegionVisibility({
        exploration,
        regions: SYNTHETIC_REGIONS,
        bridges: SYNTHETIC_BRIDGES,
        mode: 'hard',
    });
    assert.equal(hard.get('region:b'), 'unknown');

    const flat = computeRegionVisibility({
        exploration,
        regions: SYNTHETIC_REGIONS,
        bridges: SYNTHETIC_BRIDGES,
        mode: 'rumors',
        revealNeighbors: false,
    });
    assert.equal(flat.get('region:b'), 'unknown');
});

test('applyMapFog blanks hidden names, descriptions, factions, cast, and travel', () => {
    const state = seed();
    const vm = viewModel(state);
    const exploration = {
        regions: { 'region:center': { state: 'discovered', turn: 0, source: 'start' } },
        keyLocations: {},
        updatedAt: 0,
    };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard', showRumoredLabels: true });
    const far = fogged.regions.find((region) => region.id === 'region:airport');
    assert.equal(far.visibility, 'unknown');
    assert.equal(far.name, 'Uncharted');
    assert.equal(far.description, null);
    assert.equal(far.factionId, null);
    assert.equal(far.factionName, null);
    assert.equal(far.labelHidden, true);

    const center = fogged.regions.find((region) => region.id === 'region:center');
    assert.equal(center.visibility, 'discovered');
    assert.notEqual(center.name, 'Uncharted');

    // No authored name for a hidden district survives anywhere in the model.
    const airportName = vm.regions.find((region) => region.id === 'region:airport').name;
    assert.doesNotMatch(JSON.stringify(fogged.regions), new RegExp(airportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a discovered district hides its unvisited venues and their details', () => {
    const state = seed();
    const vm = viewModel(state);
    const exploration = {
        regions: { 'region:center': { state: 'discovered', turn: 0, source: 'start' } },
        keyLocations: {},
        updatedAt: 0,
    };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard', showRumoredLabels: true });
    const tower = fogged.namedLocations.find((location) => location.id === 'petrabyte-tower');
    assert.equal(tower.visibility, 'rumored');
    assert.equal(tower.name, 'PetraByte Tower');
    assert.equal(tower.description, null);
    assert.equal(tower.factionId, null);
    assert.deepEqual(tower.present, []);
    assert.equal(tower.regionName, null);
    assert.equal(tower.districtName, null);

    const submenu = buildMapSubmenu({ kind: 'namedLocation', id: 'petrabyte-tower' }, fogged, { state });
    assert.equal(submenu.visibility, 'rumored');
    assert.equal(submenu.description, null);
    assert.equal(submenu.factionId, null);
    assert.equal(submenu.districtName, null);
    assert.deepEqual(submenu.present, []);
    assert.equal(submenu.isPlayerHere, false);
    assert.equal(submenu.travel.enabled, true, 'rumoured destinations are blind trips');
    assert.equal(submenu.travel.blindTrip, true);
});

test('a hidden location never exposes live cast, district, or a travel button', () => {
    const state = seed();
    const vm = viewModel(state);
    const exploration = {
        regions: { 'region:center': { state: 'discovered' } },
        keyLocations: {},
        updatedAt: 0,
    };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard', showRumoredLabels: false });
    const hidden = fogged.namedLocations.find((location) => location.id === 'neon-docks');
    assert.equal(hidden.visibility, 'unknown');
    assert.equal(hidden.name, 'Uncharted');
    assert.equal(hidden.regionName, null);
    assert.equal(hidden.label, null);

    const submenu = buildMapSubmenu({ kind: 'namedLocation', id: 'neon-docks' }, fogged, { state });
    assert.equal(submenu.title, 'Uncharted');
    assert.equal(submenu.description, null);
    assert.equal(submenu.factionId, null);
    assert.equal(submenu.districtId, null);
    assert.equal(submenu.districtName, null);
    assert.deepEqual(submenu.present, []);
    assert.equal(submenu.isPlayerHere, false);
    assert.equal(submenu.travel.enabled, false);
    assert.match(submenu.travel.reason, /Uncharted/);
});

test('a virtual node stays reachable from a visited connection when its region is uncharted', () => {
    const state = seed();
    const vm = viewModel(state);
    const exploration = {
        regions: { 'region:center': { state: 'discovered' } },
        keyLocations: {},
        updatedAt: 0,
    };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard', showRumoredLabels: false });
    const subway = fogged.namedLocations.find((location) => location.id === 'old-subway');
    // old-subway is virtual and connects to central-plaza (the start).
    const submenu = buildMapSubmenu({ kind: 'namedLocation', id: 'old-subway' }, fogged, { state });
    assert.equal(subway.virtual, true);
    assert.equal(submenu.travel.enabled, true);
    assert.equal(submenu.travel.blindTrip, true);
    assert.equal(submenu.description, null);
});

test('fog never reveals that the player is at a hidden location', () => {
    const base = seed();
    const state = {
        ...base,
        player: { ...base.player, locationId: 'neon-docks' },
        scene: { ...base.scene, locationId: 'neon-docks' },
    };
    const vm = viewModel(state);
    const exploration = { regions: {}, keyLocations: {}, updatedAt: 0 };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard', showRumoredLabels: false });
    const here = buildMapSubmenu(
        { kind: 'namedLocation', id: 'neon-docks' },
        fogged,
        { state },
    );
    assert.equal(here.visibility, 'unknown');
    assert.deepEqual(here.present, []);
    assert.equal(here.isPlayerHere, false);
});

test('bridge visibility follows the endpoints', () => {
    const vm = {
        regions: SYNTHETIC_REGIONS.map((region) => ({ ...region, kind: 'region' })),
        bridges: [{
            id: 'bridge:ab',
            kind: 'bridge',
            label: 'AB',
            name: 'Alpha–Beta Bridge',
            connects: ['region:a', 'region:b'],
            status: 'open',
            connectsNames: ['Alpha', 'Beta'],
            labelHidden: false,
        }],
        keyLocations: [],
        namedLocations: [],
        index: { keyByLocationId: new Map() },
    };
    const discovery = { regions: { 'region:a': { state: 'discovered' } }, keyLocations: {}, updatedAt: 0 };
    const visible = applyMapFog(vm, discovery, { mode: 'rumors' });
    assert.equal(visible.bridges[0].visibility, 'discovered');
    assert.equal(visible.bridges[0].status, 'open');

    const hidden = applyMapFog(vm, { regions: {}, keyLocations: {}, updatedAt: 0 }, { mode: 'hard' });
    assert.equal(hidden.bridges[0].visibility, 'unknown');
    assert.equal(hidden.bridges[0].name, 'Uncharted');
    assert.equal(hidden.bridges[0].status, null);
    assert.deepEqual(hidden.bridges[0].connectsNames, [null, null]);
});

test('repeated reveals are idempotent and invalid discoveries are rejected', () => {
    const state = seed();
    const once = applyWorldEvent(state, { type: 'REVEAL_REGION', regionId: 'region:park-c', source: 'editor' });
    const twice = applyWorldEvent(once, { type: 'REVEAL_REGION', regionId: 'region:park-c', source: 'travel' });
    assert.deepEqual(twice.flags.map.exploration, once.flags.map.exploration);
    assert.equal(once.flags.map.exploration.regions['region:park-c'].source, 'editor');
    assert.throws(
        () => applyWorldEvent(state, { type: 'DISCOVER_MAP_FEATURE', kind: 'bridge', id: 'x' }),
        /kind must be/,
    );
    assert.throws(
        () => applyWorldEvent(state, { type: 'DISCOVER_MAP_FEATURE', kind: 'region', id: '' }),
        /requires an id/,
    );
});

test('a rumoured district shows only its name when labels are enabled', () => {    const state = seed();
    const exploration = { regions: { 'region:a': { state: 'discovered' } }, keyLocations: {}, updatedAt: 0 };
    const vm = {
        regions: SYNTHETIC_REGIONS.map((region) => ({
            ...region,
            kind: 'region',
            description: `${region.name} description`,
            factionId: 'clarity',
            factionName: 'Clarity',
            status: 'hostile',
            labelHidden: false,
        })),
        bridges: SYNTHETIC_BRIDGES,
        keyLocations: [],
        namedLocations: [],
        index: { keyByLocationId: new Map() },
    };
    const visible = applyMapFog(vm, exploration, {
        mode: 'rumors',
        showRumoredLabels: true,
    });
    const beta = visible.regions.find((region) => region.id === 'region:b');
    assert.equal(beta.visibility, 'rumored');
    assert.equal(beta.name, 'Beta');
    assert.equal(beta.description, null);
    assert.equal(beta.factionId, null);

    const hidden = applyMapFog(vm, exploration, {
        mode: 'rumors',
        showRumoredLabels: false,
    });
    const hiddenBeta = hidden.regions.find((region) => region.id === 'region:b');
    assert.equal(hiddenBeta.name, 'Uncharted');
    assert.equal(hiddenBeta.labelHidden, true);
});

test('fog off or a world without exploration returns the view model unchanged', () => {
    const vm = viewModel(seed());
    assert.equal(applyMapFog(vm, null), vm);
    assert.equal(applyMapFog(vm, undefined), vm);
    assert.equal(applyMapFog(vm, { regions: {}, keyLocations: {} }, { enabled: false }), vm);
});

test('the submenu hides travel for an uncharted destination', () => {
    const state = seed();
    const vm = viewModel(state);
    const exploration = { regions: {}, keyLocations: {}, updatedAt: 0 };
    const fogged = applyMapFog(vm, exploration, { mode: 'hard' });
    const selection = { kind: 'namedLocation', id: 'maple-heights' };
    const submenu = buildMapSubmenu(selection, fogged, { state });
    assert.equal(submenu.ok, true);
    assert.equal(submenu.visibility, 'unknown');
    assert.equal(submenu.travel.enabled, false);
    assert.match(submenu.travel.reason, /Uncharted/);
    assert.equal(submenu.description, null);
    assert.deepEqual(submenu.present, []);
});

test('discovery events are idempotent and mark key locations too', () => {
    const state = seed();
    const first = applyWorldEvent(state, {
        type: 'DISCOVER_MAP_FEATURE',
        kind: 'region',
        id: 'region:airport',
        source: 'editor',
    });
    const second = applyWorldEvent(first, {
        type: 'DISCOVER_MAP_FEATURE',
        kind: 'region',
        id: 'region:airport',
        source: 'travel',
    });
    assert.deepEqual(second.flags.map.exploration, first.flags.map.exploration);
    assert.equal(first.flags.map.exploration.regions['region:airport'].state, 'discovered');
    assert.equal(first.flags.map.exploration.regions['region:airport'].source, 'editor');

    const key = applyWorldEvent(second, {
        type: 'DISCOVER_MAP_FEATURE',
        kind: 'keyLocation',
        id: 'key:big-office-b',
        source: 'storyline',
    });
    assert.equal(key.flags.map.exploration.keyLocations['key:big-office-b'].state, 'discovered');

    const revealed = applyWorldEvent(key, { type: 'REVEAL_REGION', regionId: 'region:park-c' });
    assert.equal(revealed.flags.map.exploration.regions['region:park-c'].state, 'discovered');

    const reset = applyWorldEvent(revealed, {
        type: 'RESET_EXPLORATION',
        regionIds: ['region:center'],
        source: 'editor',
    });
    assert.deepEqual(Object.keys(reset.flags.map.exploration.regions), ['region:center']);
    assert.deepEqual(reset.flags.map.exploration.keyLocations, {});
});

test('destination rules: unknown is gated, rumored is a blind trip, virtual needs a visited connection', () => {
    const exploration = { regions: { 'region:a': { state: 'discovered' } }, keyLocations: {}, updatedAt: 0 };
    const unknown = destinationVisibility({
        exploration,
        regionId: 'region:c',
        bridges: SYNTHETIC_BRIDGES,
        mode: 'hard',
        gateTravel: true,
    });
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, 'uncharted');

    const rumored = destinationVisibility({
        exploration,
        regionId: 'region:b',
        bridges: SYNTHETIC_BRIDGES,
        mode: 'rumors',
        gateTravel: true,
    });
    assert.equal(rumored.allowed, true);
    assert.equal(rumored.blind, true);

    assert.equal(destinationVisibility({ exploration, regionId: 'region:c', mode: 'hard', gateTravel: false }).allowed, true);

    const virtualAllowed = destinationVisibility({
        exploration,
        regionId: null,
        virtual: true,
        connections: ['start'],
        visitedLocationIds: ['start'],
    });
    assert.equal(virtualAllowed.allowed, true);
    const virtualBlocked = destinationVisibility({
        exploration,
        regionId: null,
        virtual: true,
        connections: ['elsewhere'],
        visitedLocationIds: ['start'],
    });
    assert.equal(virtualBlocked.allowed, false);
});

test('a completed trip lists every region on its path and bridge endpoints', () => {
    const graph = {
        getNode: (id) => ({ a: { regionId: 'region:a' }, b: { regionId: 'region:b' }, c: { regionId: 'region:c' } })[id] ?? null,
        bridgeById: new Map([['bridge:ab', { connects: ['region:a', 'region:b'] }]]),
    };
    assert.deepEqual(
        collectTravelRegions({ graph, path: ['a', 'c'], bridges: ['bridge:ab'] }).sort(),
        ['region:a', 'region:b', 'region:c'],
    );
});

test('normalizeExploration tolerates malformed input and ignores unknown states', () => {
    const normalized = normalizeExploration({
        regions: { a: { state: 'bogus' }, b: { state: 'discovered', turn: 3, source: 'travel' } },
        keyLocations: [],
        extra: 'keep',
    });
    assert.equal(normalized.regions.a, undefined);
    assert.deepEqual(normalized.regions.b, { state: 'discovered', turn: 3, source: 'travel' });
    assert.deepEqual(normalized.keyLocations, {});
    assert.equal(normalized.extra, 'keep');
    assert.equal(normalizeExploration(null), null);
});

/* ------------------------------------------------------------------ *
 * Settings and travel integration
 * ------------------------------------------------------------------ */

test('fog settings ship off with sane defaults and normalize', () => {
    assert.equal(DEFAULT_SETTINGS.map.showFogOfWar, false);
    assert.deepEqual(DEFAULT_SETTINGS.map.fog, {
        mode: 'rumors',
        revealOnTravel: true,
        showRumoredLabels: true,
        gateTravel: true,
        revealNeighbors: true,
    });
    const migrated = migrateSettings({
        schemaVersion: 1,
        map: { showFogOfWar: true, fog: { mode: 'nope', gateTravel: false, custom: 'keep' } },
    });
    assert.equal(migrated.map.showFogOfWar, true);
    assert.equal(migrated.map.fog.mode, 'rumors');
    assert.equal(migrated.map.fog.gateTravel, false);
    assert.equal(migrated.map.fog.custom, 'keep');
});

function makeStore() {
    const store = createWorldStateStore({
        metadata: {},
        chatId: 'fog-travel',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: { registry, factions, locations, formGroups, formRules },
        now: () => 1700000000000,
    });
    store.seed({
        season: seasonS1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'fog-travel',
        player: { identity: 'custom' },
        now: 1700000000000,
    });
    return store;
}

const FOG_SETTINGS = {
    map: {
        showFogOfWar: true,
        fog: { mode: 'hard', gateTravel: true, revealOnTravel: true, showRumoredLabels: true, revealNeighbors: true },
    },
};

test('fog gating rejects an uncharted destination and leaves the world unchanged', async () => {
    const store = makeStore();
    const state = store.get();
    store.replace({
        ...state,
        flags: { ...state.flags, map: { exploration: { regions: {}, keyLocations: {}, updatedAt: 0 } } },
    });
    const before = JSON.stringify(store.get());
    const flow = createTravelFlow({
        store,
        season: seasonS1,
        sources: { locations, generated: { regions, bridges }, overrides },
        getSettings: () => FOG_SETTINGS,
        now: () => 1700000000000,
    });
    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'uncharted');
    assert.match(result.message, /uncharted/);
    assert.equal(JSON.stringify(store.get()), before);
});

test('a virtual destination remains travelable through a visited connection under hard fog', async () => {
    const store = makeStore();
    const state = store.get();
    store.replace({
        ...state,
        flags: { ...state.flags, map: { exploration: { regions: { 'region:center': { state: 'discovered' } }, keyLocations: {}, updatedAt: 0 } } },
    });
    const flow = createTravelFlow({
        store,
        season: seasonS1,
        sources: { locations, generated: { regions, bridges }, overrides },
        getSettings: () => ({
            map: { ...FOG_SETTINGS.map, fog: { ...FOG_SETTINGS.map.fog, mode: 'hard' } },
        }),
        now: () => 1700000000000,
    });
    const result = await flow.travel({ to: 'old-subway' });
    assert.equal(result.ok, true, result.message);
    assert.equal(store.get().scene.locationId, 'old-subway');
});

test('an uncharted trip is allowed when fog gating is off, and the path is discovered', async () => {
    const store = makeStore();
    const state = store.get();
    store.replace({
        ...state,
        flags: { ...state.flags, map: { exploration: { regions: {}, keyLocations: {}, updatedAt: 0 } } },
    });
    const flow = createTravelFlow({
        store,
        season: seasonS1,
        sources: { locations, generated: { regions, bridges }, overrides },
        getSettings: () => ({
            map: { ...FOG_SETTINGS.map, fog: { ...FOG_SETTINGS.map.fog, gateTravel: false } },
        }),
        now: () => 1700000000000,
    });
    const result = await flow.travel({ to: 'petrabyte-tower' });
    assert.equal(result.ok, true, result.message);
    const exploration = store.get().flags.map.exploration;
    assert.equal(exploration.regions['region:center'].state, 'discovered');
    assert.equal(exploration.regions['region:center'].source, 'travel');
});
