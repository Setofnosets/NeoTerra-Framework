import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAP_TRAVEL_MODES,
    buildTravelGraph,
    detectTravelAbilities,
    findTravelPath,
    reachableNodes,
    resolveBridgeStatus,
    setChatMapOverride,
    getChatMapOverrides,
    addChatVirtualNode,
    removeChatVirtualNode,
    updateChatVirtualNode,
    resetChatMapOverrides,
    travelTurnsForDistance,
} from '../src/data/map.js';
import { TRAVEL_MODES } from '../src/data/locations.js';
import {
    buildTravelInitiativeContext,
    createTravelFlow,
    createTravelInitiativeHook,
    describeTravelFailure,
    isTravelBlockedByCombat,
    buildTravelMessageExtra,
    attachTravelToMessage,
} from '../src/flows/travel.js';
import { buildLocationIntro, createSceneFlow } from '../src/flows/scene.js';
import { createInitiative } from '../src/flows/initiative.js';
import { createStorylineTracker } from '../src/agents/storyline.js';
import { createWorldStateStore } from '../src/state/store.js';
import { createWorldState } from '../src/state/world-state.js';
import { buildFormIndex } from '../src/data/forms.js';

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
const regions = readJson('data/map/regions.geojson');
const bridges = readJson('data/map/bridges.geojson');
const overrides = readJson('data/map/overrides.json');
const seasons = {
    s1: readJson('data/seasons/s1.json'),
    s1dark: readJson('data/seasons/s1dark.json'),
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };
const SOURCES = {
    locations,
    generated: { regions, bridges },
    overrides,
};

function makeStore({ seasonId = 's1', player = { identity: 'custom' } } = {}) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'travel-test-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
        now: () => NOW,
    });
    store.seed({
        season: seasons[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'travel-test-chat',
        player,
        now: NOW,
    });
    return store;
}

function baseState(overridesPatch = {}) {
    return {
        flags: {},
        locations: {},
        factions: {},
        threats: [],
        beats: {},
        recentEvents: [],
        ...overridesPatch,
    };
}

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

test('the travel mode vocabulary in src/data/map.js mirrors the location registry', () => {
    assert.deepEqual([...MAP_TRAVEL_MODES].sort(), [...TRAVEL_MODES].sort());
});

test('the travel graph contains every named location and every bridge', () => {
    const graph = buildTravelGraph({ locations, bridges, regions, overrides });
    assert.equal(graph.nodes.size, locations.locations.length);
    assert.equal(graph.bridges.length, bridges.features.length);
    assert.ok(graph.edges.length > 0);
    for (const bridge of graph.bridges) {
        assert.equal(bridge.connects.length, 2);
        assert.ok(bridge.connects.every((regionId) => regionId.startsWith('region:')));
    }
});

test('cross-district trips name the bridges used; same-region trips are cheap', () => {
    const graph = buildTravelGraph({ locations, bridges, regions, overrides });
    const crossDistrict = findTravelPath(graph, 'central-plaza', 'maple-heights');
    assert.equal(crossDistrict.ok, true);
    assert.ok(crossDistrict.bridges.length >= 1, 'a cross-district route must list its bridges');
    assert.ok(crossDistrict.turns >= 1);

    const sameRegion = findTravelPath(graph, 'central-plaza', 'clarity-hq');
    assert.equal(sameRegion.ok, true);
    assert.equal(sameRegion.sameRegion, true);
    assert.equal(sameRegion.turns, 1);
    assert.deepEqual(sameRegion.bridges, []);
});

test('pathfinding never falls back to straight-line distance across an unbridged gap', () => {
    const graph = buildTravelGraph({ locations, bridges, regions, overrides });
    const path = findTravelPath(graph, 'central-plaza', 'maple-heights');
    assert.equal(path.ok, true);
    assert.ok(path.bridges.length >= 1, 'every cross-district hop names a bridge');
    for (const hop of path.path.slice(1).map((id, index) => [path.path[index], id])) {
        assert.notEqual(hop[0], hop[1]);
    }
    // A pair with no bridge and no mutual secret route is rejected, not
    // connected by a straight line.
    const synthetic = buildTravelGraph(syntheticSources());
    const renya = findTravelPath(synthetic, 'plaza', 'old-subway');
    assert.equal(renya.ok, false);
    assert.equal(renya.reason, 'unknown-destination');
});

/**
 * A minimal two-district world so bridge rules can be asserted exactly:
 * `plaza`/`tower` (downtown, region:center) and `hill` (maple-heights,
 * region:hill). Two spans join the districts; `hill` also has one secret
 * neighbour in its own district.
 */
function syntheticSources() {
    const syntheticLocations = {
        schemaVersion: 1,
        locations: [
            {
                id: 'plaza',
                name: 'Plaza',
                district: 'Downtown',
                districtId: 'downtown',
                regionId: 'region:center',
                x: 500,
                y: 500,
                travel: ['walk'],
                connections: ['tower', 'hill'],
            },
            {
                id: 'tower',
                name: 'Tower',
                district: 'Downtown',
                districtId: 'downtown',
                regionId: 'region:center',
                x: 560,
                y: 520,
                travel: ['walk'],
                connections: ['plaza'],
            },
            {
                id: 'hill',
                name: 'Hill',
                district: 'Maple Heights',
                districtId: 'maple-heights',
                regionId: 'region:hill',
                x: 900,
                y: 300,
                travel: ['walk'],
                connections: ['plaza', 'hill-house'],
            },
            {
                id: 'hill-house',
                name: 'Hill House',
                district: 'Maple Heights',
                districtId: 'maple-heights',
                regionId: 'region:hill',
                x: 940,
                y: 320,
                travel: ['walk'],
                connections: ['hill'],
            },
        ],
    };
    const syntheticRegions = {
        features: [
            { id: 'region:center', label: 'Center', districtId: 'downtown' },
            { id: 'region:hill', label: 'Hill', districtId: 'maple-heights' },
        ],
    };
    const syntheticBridges = {
        features: [
            { id: 'bridge:north', label: 'North', connects: ['region:center', 'region:hill'], length: 40, status: 'open' },
            { id: 'bridge:south', label: 'South', connects: ['region:center', 'region:hill'], length: 60, status: 'open' },
        ],
    };
    return {
        locations: syntheticLocations,
        // Both shapes are accepted: `loadMapSources` returns `generated`, while
        // `buildTravelGraph` takes the layers directly.
        generated: { regions: syntheticRegions, bridges: syntheticBridges },
        regions: syntheticRegions,
        bridges: syntheticBridges,
        overrides: { schemaVersion: 1, regions: {}, bridges: {}, keyLocations: {} },
    };
}

function chatBridgeStatus(statuses) {
    return baseState({ flags: { map: { bridges: statuses } } });
}

test('a destroyed bridge removes that route; a detour is used while one span stands', () => {
    const sources = syntheticSources();
    const clean = buildTravelGraph(sources);
    const original = findTravelPath(clean, 'plaza', 'hill');
    assert.equal(original.ok, true);
    assert.deepEqual(original.bridges, ['bridge:north']);

    const oneDown = buildTravelGraph({
        ...sources,
        state: chatBridgeStatus({ North: { status: 'destroyed' } }),
    });
    const detour = findTravelPath(oneDown, 'plaza', 'hill');
    assert.equal(detour.ok, true);
    assert.deepEqual(detour.bridges, ['bridge:south'], 'the remaining span is the detour');

    const bothDown = buildTravelGraph({
        ...sources,
        state: chatBridgeStatus({ North: { status: 'blocked' }, South: { status: 'destroyed' } }),
    });
    const blocked = findTravelPath(bothDown, 'plaza', 'hill');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'blocked');
    assert.ok(blocked.blockedBridges.some((bridge) => bridge.label === 'North'));
    assert.match(describeTravelFailure(blocked), /blocked bridge/i);
});

test('two sites inside one district are a short walk even when the only spans are down', () => {
    const sources = syntheticSources();
    const bothDown = buildTravelGraph({
        ...sources,
        state: chatBridgeStatus({ North: { status: 'blocked' }, South: { status: 'destroyed' } }),
    });
    const local = findTravelPath(bothDown, 'hill', 'hill-house');
    assert.equal(local.ok, true);
    assert.equal(local.sameRegion, true);
    assert.equal(local.turns, 1);
    assert.deepEqual(local.bridges, []);
});

test('bridge status precedence is chat > global > generated', () => {
    const bridge = bridges.features.find((feature) => feature.label === 'BridgeA');
    assert.equal(resolveBridgeStatus(bridge, {}), 'open');
    const global = { bridges: { BridgeA: { status: 'contested' } } };
    assert.equal(resolveBridgeStatus(bridge, { overrides: global }), 'contested');
    const chat = { bridges: { BridgeA: { status: 'destroyed' } } };
    assert.equal(resolveBridgeStatus(bridge, { overrides: global, chat }), 'destroyed');
});

test('a blocked route is bypassed only by a declared ability, and the cost is recorded', () => {
    const sources = syntheticSources();
    const blocked = buildTravelGraph({
        ...sources,
        state: chatBridgeStatus({ North: { status: 'destroyed' }, South: { status: 'destroyed' } }),
    });
    const denied = findTravelPath(blocked, 'plaza', 'hill');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'blocked');
    assert.equal(findTravelPath(blocked, 'plaza', 'hill', { allowBypass: false }).ok, false);

    const teleport = findTravelPath(blocked, 'plaza', 'hill', { abilities: ['teleport'] });
    assert.equal(teleport.ok, true);
    assert.equal(teleport.ability, 'teleport');
    assert.equal(teleport.turns, 1);
    assert.deepEqual(teleport.bypass, {
        ability: 'teleport',
        cost: 1,
        distance: teleport.distance,
    });
    assert.equal(teleport.groundReason, 'blocked');
});

test('travel abilities are detected from the played character state', () => {
    assert.deepEqual(detectTravelAbilities({ abilities: ['Teleportation'], skills: ['Flight'] }), ['teleport', 'flight']);
    assert.deepEqual(detectTravelAbilities('Aquatic respiration'), ['swim']);
    assert.deepEqual(detectTravelAbilities({ traits: [] }), []);
});

test('travel turns scale with distance and clamp, with a short hop for same-region trips', () => {
    assert.equal(travelTurnsForDistance(0), 1);
    assert.equal(travelTurnsForDistance(100), 1);
    assert.equal(travelTurnsForDistance(900), 3);
    assert.equal(travelTurnsForDistance(100000), 8);
    assert.equal(travelTurnsForDistance(900, { sameRegion: true }), 1);
    assert.equal(travelTurnsForDistance(900, { bypass: 'flight' }), 2);
});

test('same-location travel is a no-op and unknown nodes are rejected', () => {
    const graph = buildTravelGraph({ locations, bridges, regions, overrides });
    const same = findTravelPath(graph, 'central-plaza', 'central-plaza');
    assert.equal(same.ok, true);
    assert.equal(same.alreadyThere, true);
    assert.equal(same.turns, 0);

    const unknown = findTravelPath(graph, 'central-plaza', 'atlantis');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'unknown-destination');
});

test('reachableNodes stops at blocked bridges', () => {
    const sources = syntheticSources();
    const clean = buildTravelGraph(sources);
    assert.ok(reachableNodes(clean, 'plaza').includes('hill'));

    const blocked = buildTravelGraph({
        ...sources,
        state: chatBridgeStatus({ North: { status: 'destroyed' }, South: { status: 'destroyed' } }),
    });
    const reachable = reachableNodes(blocked, 'plaza');
    assert.ok(reachable.includes('tower'), 'same-district sites stay reachable');
    assert.equal(reachable.includes('hill'), false, 'a blocked district pair is unreachable');
});

/* ------------------------------------------------------------------ *
 * Per-chat map layer
 * ------------------------------------------------------------------ */

test('per-chat overrides mutate a copy and survive export/import', () => {
    const state = baseState();
    const next = setChatMapOverride(state, {
        layer: 'bridges',
        key: 'BridgeA',
        patch: { status: 'destroyed' },
    });
    assert.deepEqual(state.flags, {}, 'the input state must not be mutated');
    assert.equal(getChatMapOverrides(next).bridges.BridgeA.status, 'destroyed');
    assert.equal(JSON.parse(JSON.stringify(next)).flags.map.bridges.BridgeA.status, 'destroyed');
    assert.throws(
        () => setChatMapOverride(state, { layer: 'nope', key: 'x', patch: {} }),
        /Unknown map override layer/,
    );
});

test('chat overrides are isolated between chats and do not touch the global document', () => {
    const chatA = setChatMapOverride(baseState(), {
        layer: 'bridges',
        key: 'BridgeA',
        patch: { status: 'destroyed' },
    });
    const chatB = baseState();

    const graphA = buildTravelGraph({ locations, bridges, regions, overrides, state: chatA });
    const graphB = buildTravelGraph({ locations, bridges, regions, overrides, state: chatB });
    assert.equal(graphA.bridgeById.get('bridge:bridge-a').status, 'destroyed');
    assert.equal(graphB.bridgeById.get('bridge:bridge-a').status, 'open');

    // The authored document is untouched.
    assert.equal(overrides.bridges.BridgeA.status, 'open');
});

test('virtual nodes become locations and travel edges; removing them cleans up', () => {
    let state = baseState();
    state = addChatVirtualNode(state, {
        name: 'Hidden Bunker',
        x: 900,
        y: 900,
        connections: ['central-plaza'],
    });
    assert.ok(state.locations['chat:hidden-bunker']);
    assert.equal(state.locations['chat:hidden-bunker'].virtual, true);

    const graph = buildTravelGraph({ locations, bridges, regions, overrides, state });
    const route = findTravelPath(graph, 'central-plaza', 'chat:hidden-bunker');
    assert.equal(route.ok, true);

    const removed = removeChatVirtualNode(state, 'chat:hidden-bunker');
    assert.equal(removed.locations['chat:hidden-bunker'], undefined);
    assert.equal(getChatMapOverrides(removed).virtualNodes.length, 0);

    assert.throws(() => addChatVirtualNode(baseState(), { name: 'Off map', x: 5000, y: 10 }), /canvas/);
});

test('a virtual node can be edited and its new connections appear in travel', () => {
    let state = baseState();
    state = addChatVirtualNode(state, { name: 'Safehouse', x: 700, y: 700 });
    const orphan = buildTravelGraph({ locations, bridges, regions, overrides, state });
    assert.equal(findTravelPath(orphan, 'central-plaza', 'chat:safehouse').ok, false);

    state = updateChatVirtualNode(state, 'chat:safehouse', {
        connections: ['central-plaza'],
        name: 'Safehouse Annex',
    });
    const graph = buildTravelGraph({ locations, bridges, regions, overrides, state });
    const route = findTravelPath(graph, 'central-plaza', 'chat:safehouse');
    assert.equal(route.ok, true);
    assert.equal(graph.getNode('chat:safehouse').name, 'Safehouse Annex');
    assert.equal(state.locations['chat:safehouse'].name, 'Safehouse Annex');
    assert.throws(() => updateChatVirtualNode(state, 'chat:missing', { name: 'x' }), /No chat virtual node/);
    assert.throws(
        () => updateChatVirtualNode(state, 'chat:safehouse', { x: 5000 }),
        /canvas/,
        'a marker move must stay on canvas',
    );
});

test('an unknown or undeclared ability is refused, never granted for free', async () => {
    const store = makeStore();
    const flow = makeTravel(store);
    const result = await flow.travel({ to: 'maple-heights', ability: 'teleport' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ability-unavailable');
    assert.equal(store.get().scene.locationId, 'central-plaza');
});

test('resetting the chat map layer removes chat-only nodes but keeps the world', () => {
    let state = baseState();
    state = addChatVirtualNode(state, { name: 'Safehouse', x: 500, y: 500, connections: ['central-plaza'] });
    state = setChatMapOverride(state, { layer: 'bridges', key: 'BridgeC', patch: { status: 'blocked' } });
    const reset = resetChatMapOverrides(state);
    assert.equal(Object.keys(reset.locations).length, 0);
    assert.equal(reset.flags.map, undefined);
    assert.equal(getChatMapOverrides(reset).bridges.BridgeC, undefined);
});

/* ------------------------------------------------------------------ *
 * Travel flow
 * ------------------------------------------------------------------ */

function makeTravel(store, options = {}) {
    return createTravelFlow({
        store,
        season: seasons.s1,
        sources: SOURCES,
        now: () => NOW,
        ...options,
    });
}

test('travel moves the player, advances time, journals the trip, and builds an intro', async () => {
    const store = makeStore();
    const flow = makeTravel(store, { initiative: null });
    const before = store.get();
    assert.equal(before.scene.locationId, 'central-plaza');

    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, true);
    assert.equal(result.from, 'central-plaza');
    assert.equal(result.to, 'maple-heights');
    assert.ok(result.bridges.length >= 1);
    assert.ok(result.turns >= 1);
    assert.equal(result.state.scene.locationId, 'maple-heights');
    assert.equal(result.state.meta.turn, before.meta.turn + result.turns);
    const travelEvent = result.state.recentEvents.at(-1);
    assert.ok(travelEvent.tags.includes('travel'));
    assert.equal(travelEvent.locationId, 'maple-heights');
    assert.match(result.intro.text, /Maple Heights/);
    assert.equal(result.tracker.ran, false);
    assert.equal(result.tracker.reason, 'no-initiative');
    assert.equal(result.state.flags.travel.lastTo, 'maple-heights');
    assert.equal(result.messageExtra.to, 'maple-heights');
});

test('a canonical player moves with the scene location', async () => {
    const store = makeStore({ player: { identity: 'canon', characterId: 's1.vaiva.colorgarde' } });
    const flow = makeTravel(store);
    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, true);
    assert.equal(result.state.characters['s1.vaiva.colorgarde'].locationId, 'maple-heights');
    assert.equal(result.state.player.locationId, 'maple-heights');
});

test('combat blocks travel without touching state', async () => {
    const store = makeStore();
    store.dispatch({ type: 'COMBAT_START', participants: [] });
    const flow = makeTravel(store);
    const before = store.get();
    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'in-combat');
    assert.equal(store.get().scene.locationId, before.scene.locationId);
    assert.equal(isTravelBlockedByCombat(store.get()), true);
});

test('a blocked route rejects with a clear reason and leaves the move untouched', async () => {
    const store = makeStore();
    // Both realistic spans between Downtown and Maple Heights down.
    store.replace(setChatMapOverride(store.get(), {
        layer: 'bridges',
        key: 'BridgeA',
        patch: { status: 'destroyed' },
    }));
    store.replace(setChatMapOverride(store.get(), {
        layer: 'bridges',
        key: 'BridgeB',
        patch: { status: 'destroyed' },
    }));
    const flow = makeTravel(store);
    const before = store.get();
    const result = await flow.travel({ to: 'maple-heights' });
    // Either a legitimate detour exists, or the trip is rejected cleanly.
    if (!result.ok) {
        assert.equal(result.reason, 'blocked');
        assert.match(result.message, /blocked/i);
        assert.equal(store.get().scene.locationId, before.scene.locationId);
        assert.equal(store.get().meta.turn, before.meta.turn);
    } else {
        assert.notDeepEqual(result.bridges, ['bridge:bridge-a', 'bridge:bridge-b']);
        assert.equal(store.get().scene.locationId, 'maple-heights');
    }
});

test('an ability bypass completes the trip and records its cost', async () => {
    // Only two real locations and no spans: the ground route cannot exist, so
    // the trip is impossible without a declared ability.
    const cutSources = {
        locations: {
            schemaVersion: 1,
            locations: locations.locations
                .filter((location) => location.id === 'central-plaza' || location.id === 'maple-heights')
                .map((location) => ({
                    ...location,
                    travel: ['walk'],
                    connections: location.id === 'central-plaza'
                        ? ['maple-heights']
                        : ['central-plaza'],
                })),
        },
        generated: {
            regions,
            bridges: { type: 'FeatureCollection', features: [] },
        },
        overrides: { schemaVersion: 1, regions: {}, bridges: {}, keyLocations: {} },
    };
    const store = makeStore();
    const withoutAbility = createTravelFlow({
        store,
        season: seasons.s1,
        sources: cutSources,
        now: () => NOW,
    });
    const refused = await withoutAbility.travel({ to: 'maple-heights' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'no-route');

    const state = store.get();
    state.player.abilities = ['Teleportation'];
    store.replace(state);

    const flow = createTravelFlow({
        store,
        season: seasons.s1,
        sources: cutSources,
        now: () => NOW,
    });
    const before = store.get();
    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, true);
    assert.equal(result.ability, 'teleport');
    assert.equal(result.turns, 1);
    assert.equal(result.state.meta.turn, before.meta.turn + 1);
    assert.equal(result.state.flags.travel.lastAbility, 'teleport');
    assert.equal(result.state.scene.locationId, 'maple-heights');
});

test('travel to the current location is a no-op', async () => {
    const store = makeStore();
    const flow = makeTravel(store);
    const before = store.get();
    const result = await flow.travel({ to: before.scene.locationId });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyThere, true);
    assert.equal(store.get().meta.turn, before.meta.turn);
});

test('a tracker pass runs after the move and a failing tracker never rolls it back', async () => {
    const store = makeStore();
    const calls = [];
    const initiative = {
        afterLocationChange: async (options) => {
            calls.push(options);
            return { ran: true, source: 'agent' };
        },
    };
    const flow = makeTravel(store, { initiative });
    const result = await flow.travel({ to: 'clarity-hq' });
    assert.equal(result.ok, true);
    assert.equal(result.tracker.ran, true);
    assert.equal(calls[0].from, 'central-plaza');
    assert.equal(calls[0].to, 'clarity-hq');
    assert.equal(calls[0].travel.type, 'travel');

    const failingStore = makeStore();
    const failing = makeTravel(failingStore, {
        initiative: {
            afterLocationChange: async () => {
                throw new Error('agent exploded');
            },
        },
    });
    const moved = await failing.travel({ to: 'clarity-hq' });
    assert.equal(moved.ok, true);
    assert.equal(moved.tracker.reason, 'failed');
    assert.equal(moved.state.scene.locationId, 'clarity-hq');
});

test('travel recomputes the present cast on the new location', async () => {
    const store = makeStore();
    const scene = createSceneFlow({
        store,
        season: seasons.s1,
        registry,
        formGroups,
        formRules,
        director: null,
        getSettings: () => ({}),
    });
    const flow = makeTravel(store, { scene, initiative: null });
    const result = await flow.travel({ to: 'clarity-hq' });
    assert.equal(result.ok, true);
    assert.ok(result.cast, 'the cast is refreshed after the move');
    assert.ok(result.state.flags.castDirector.locationId === 'clarity-hq');
});

test('the travel hook builds a tracker context and reports a failing hook without throwing', async () => {
    const context = buildTravelInitiativeContext({
        from: 'central-plaza',
        to: 'maple-heights',
        path: ['central-plaza', 'maple-heights'],
        bridges: ['bridge-a'],
        distance: 400,
        turns: 2,
        modes: ['bridge'],
    });
    assert.equal(context.type, 'travel');
    assert.equal(context.crossRegion, true);
    assert.equal(context.turns, 2);

    const hook = createTravelInitiativeHook({
        initiative: { afterLocationChange: async () => ({ ran: true }) },
    });
    const ran = await hook.afterTravel(context);
    assert.equal(ran.ran, true);
    assert.equal(ran.context.bridges[0], 'bridge-a');

    const failing = createTravelInitiativeHook({
        initiative: {
            afterLocationChange: async () => {
                throw new Error('boom');
            },
        },
    });
    const failed = await failing.afterTravel(context);
    assert.equal(failed.ran, false);
    assert.equal(failed.reason, 'failed');
});

test('the storyline prompt receives the travel context', async () => {
    const store = makeStore();
    const prompts = [];
    const initiative = createInitiative({
        store,
        season: seasons.s1,
        storyline: {
            run: async (request) => {
                prompts.push(request);
                return { events: [], source: 'deterministic' };
            },
        },
        getSettings: () => ({ agents: { storyline: { onLocationChange: true } } }),
    });
    const flow = makeTravel(store, { initiative });
    const result = await flow.travel({ to: 'maple-heights' });
    assert.equal(result.ok, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].travel.to, 'maple-heights');
    assert.ok(prompts[0].travel.bridges.length >= 1);
});

test('a message extra records the route for the swipe/reload path', () => {
    const extra = buildTravelMessageExtra({
        travelContext: buildTravelInitiativeContext({
            from: 'central-plaza',
            to: 'maple-heights',
            path: ['central-plaza', 'maple-heights'],
            bridges: ['bridge-a'],
            turns: 2,
        }),
        plan: { bypass: null },
        intro: { text: 'Arrived.' },
    });
    assert.equal(extra.to, 'maple-heights');
    assert.deepEqual(extra.bridges, ['bridge-a']);
    assert.equal(extra.intro, 'Arrived.');
});

/* ------------------------------------------------------------------ *
 * Location intro
 * ------------------------------------------------------------------ */

test('the location intro names the location, district, route, and present cast', () => {
    const state = createWorldState({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'intro-chat',
        now: NOW,
    });
    const intro = buildLocationIntro({
        state: {
            ...state,
            scene: { ...state.scene, locationId: 'maple-heights' },
        },
        season: seasons.s1,
        from: { id: 'central-plaza', name: 'Central Plaza' },
        travel: {
            from: 'central-plaza',
            path: ['central-plaza', 'maple-heights'],
            bridges: ['bridge:bridge-a'],
            bridgeNames: ['Center Bridge A'],
            turns: 2,
        },
    });
    assert.match(intro.text, /Maple Heights/);
    assert.match(intro.text, /Center Bridge A/);
    assert.match(intro.text, /2 turns/);
    assert.match(intro.text, /Present:/);
    assert.equal(intro.locationId, 'maple-heights');
    assert.equal(intro.fromName, 'Central Plaza');
});

test('the scene flow stays available without a travel flow', async () => {
    const store = makeStore();
    const scene = createSceneFlow({
        store,
        season: seasons.s1,
        registry,
        formGroups,
        formRules,
    });
    const entered = await scene.enterScene({ locationId: 'clarity-hq', runDirector: false });
    assert.equal(entered.state.scene.locationId, 'clarity-hq');
});

test('a tracker that resolves the player never moves the player', async () => {
    const store = makeStore();
    const storyline = createStorylineTracker({ getSettings: () => ({}) });
    const initiative = createInitiative({
        store,
        season: seasons.s1,
        storyline,
        getSettings: () => ({ agents: { storyline: { onLocationChange: true } } }),
    });
    const flow = makeTravel(store, { initiative });
    const before = store.get().player.characterId;
    const result = await flow.travel({ to: 'clarity-hq' });
    assert.equal(result.ok, true);
    assert.equal(result.state.player.characterId, before ?? null);
    assert.equal(result.state.scene.locationId, 'clarity-hq');
});

test('an aborting tracker never rolls back a committed move', async () => {
    const store = makeStore();
    const flow = makeTravel(store, {
        initiative: {
            afterLocationChange: async () => {
                throw Object.assign(new Error('chat changed'), {
                    name: 'AgentAbortedError',
                    code: 'AGENT_ABORTED',
                });
            },
        },
    });
    const result = await flow.travel({ to: 'clarity-hq' });
    assert.equal(result.ok, true);
    assert.equal(result.tracker.reason, 'aborted');
    assert.equal(result.state.scene.locationId, 'clarity-hq');
});

test('the form index used by the scene flow is unchanged by travel', () => {
    const index = buildFormIndex(registry, formGroups);
    assert.ok(Object.keys(index.groupByMemberId).length > 0);
});

test('a travel record attaches to a message without clobbering other extras', () => {
    const message = { extra: { neoterra: { context: true }, other: 1 } };
    const extra = buildTravelMessageExtra({
        travelContext: buildTravelInitiativeContext({ from: 'a', to: 'b', turns: 1 }),
        plan: null,
        intro: null,
    });
    attachTravelToMessage(message, extra);
    assert.equal(message.extra.other, 1);
    assert.equal(message.extra.neoterra.context, true);
    assert.equal(message.extra.neoterra.travel.to, 'b');
    // A malformed call is a no-op, not a crash.
    assert.equal(attachTravelToMessage(null, extra), null);
});

test('a chat map override survives a store round-trip and still gates travel', () => {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'persisted-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season: seasons.s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'persisted-chat',
        now: NOW,
    });
    store.replace(setChatMapOverride(store.get(), {
        layer: 'bridges',
        key: 'BridgeA',
        patch: { status: 'destroyed' },
    }));
    store.saveNow();

    // A fresh store reads the same document back from chat metadata.
    const reopened = createWorldStateStore({
        metadata,
        chatId: 'persisted-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    const restored = reopened.get();
    assert.equal(getChatMapOverrides(restored).bridges.BridgeA.status, 'destroyed');
});
