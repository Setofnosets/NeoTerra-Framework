import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_LAYER_VISIBILITY,
    MAP_FEATURE_COUNTS,
    MAP_LAYER_ORDER,
    buildMapFeatureIndex,
    buildMapSubmenu,
    buildMapViewModel,
    clearGeneratedMapCaches,
    loadBridges,
    loadDistricts,
    loadGeneratedMapData,
    loadKeyLocations,
    loadMapManifest,
    loadMapOverrides,
    loadRegions,
    mapBounds,
    pointInRegion,
    resolveMapRef,
    toLatLng,
    toMapPoint,
    validateBridgeCollection,
    validateKeyLocationDocument,
    validateMapManifest,
    validateRegionCollection,
} from '../src/data/map.js';
import {
    buildLocationsByRegion,
    findLocationByMapRef,
    findLocationsInRegion,
    validateLocationMapBindings,
} from '../src/data/locations.js';
import { createMachine } from '../src/core/machine.js';
import { createCityMap } from '../src/ui/leaflet-adapter.js';
import {
    MAP_LAYER_LABELS,
    bridgeStatusClass,
    defaultLayerVisibility,
    mountFallbackMap,
    mountCityMap,
    renderLayerToggles,
} from '../src/ui/map.js';
import {
    GEOMETRY_VERSION,
    buildLayerToggleState,
    buildPanelViewModel,
    clampPanelGeometry,
    loadLayerVisibility,
    loadMapSources,
    loadPanelGeometry,
    renderSubmenuMarkup,
    runCloseHandler,
    saveLayerVisibility,
    savePanelGeometry,
} from '../src/ui/map-panel.js';
import { shouldCloseAfterTravel } from '../src/ui/shell.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function fileFetch(url) {
    const href = typeof url === 'string' ? url : url.href;
    const path = decodeURIComponent(new URL(href).pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(readFileSync(path, 'utf8')),
    };
}

const regions = readJson('data/map/regions.geojson');
const bridges = readJson('data/map/bridges.geojson');
const keyLocations = readJson('data/map/key-locations.json');
const manifest = readJson('data/map/map.json');
const overrides = readJson('data/map/overrides.json');
const districts = readJson('data/districts.json');
const locations = readJson('data/locations.json');
const mapReport = readJson('data/map/report.json');

const regionIds = new Set(regions.features.map((feature) => feature.id));

/* ------------------------------------------------------------------ *
 * Generated data validation
 * ------------------------------------------------------------------ */

test('generated map documents validate and match the authored counts', () => {
    assert.equal(validateMapManifest(manifest).ok, true);
    assert.equal(validateRegionCollection(regions).ok, true);
    assert.equal(validateBridgeCollection(bridges, { regionIds }).ok, true);
    assert.equal(validateKeyLocationDocument(keyLocations, { regionIds }).ok, true);
    assert.deepEqual(manifest.counts, {
        districts: MAP_FEATURE_COUNTS.districts,
        bridges: MAP_FEATURE_COUNTS.bridges,
        keyLocations: MAP_FEATURE_COUNTS.keyLocations,
    });
});

test('generated validators reject drift with useful paths', () => {
    const badManifest = structuredClone(manifest);
    badManifest.counts.districts = 35;
    assert.equal(validateMapManifest(badManifest).ok, false);

    const badRegions = structuredClone(regions);
    badRegions.features[0].kind = 'moon-base';
    const regionErrors = validateRegionCollection(badRegions).errors;
    assert.ok(regionErrors.some((error) => /unknown kind/.test(error.message)));

    const badBridges = structuredClone(bridges);
    badBridges.features[0].connects = [badBridges.features[0].connects[0], badBridges.features[0].connects[0]];
    assert.equal(validateBridgeCollection(badBridges, { regionIds }).ok, false);

    const badKeys = structuredClone(keyLocations);
    badKeys.keyLocations[0].x = 5000;
    assert.equal(validateKeyLocationDocument(badKeys, { regionIds }).ok, false);

    const badRing = structuredClone(regions);
    badRing.features[1].geometry.coordinates[0] = [[0, 0], [1, 1]];
    assert.equal(validateRegionCollection(badRing).ok, false);
});

test('location map bindings validate: mapRefs resolve and regionIds agree', () => {
    assert.equal(
        validateLocationMapBindings(locations, { regions, bridges, keyLocations }).ok,
        true,
    );

    const brokenRef = structuredClone(locations);
    brokenRef.locations[0].mapRef = { layer: 'keyLocation', id: 'key:does-not-exist' };
    const refErrors = validateLocationMapBindings(brokenRef, { regions, bridges, keyLocations }).errors;
    assert.ok(refErrors.some((error) => /unresolved generated feature/.test(error.message)));

    const brokenRegion = structuredClone(locations);
    brokenRegion.locations[0].regionId = 'region:nowhere';
    assert.equal(validateLocationMapBindings(brokenRegion, { regions, bridges, keyLocations }).ok, false);

    const virtualWithRef = structuredClone(locations);
    virtualWithRef.locations.find((location) => location.virtual).mapRef = { layer: 'keyLocation', id: 'key:home-b' };
    assert.equal(validateLocationMapBindings(virtualWithRef, { regions, bridges, keyLocations }).ok, false);
});

test('map report resolves every bridge and key location', () => {
    assert.deepEqual(mapReport.errors, []);
    assert.deepEqual(mapReport.unassignedBridges, []);
    assert.deepEqual(mapReport.unassignedKeyLocations, []);
    assert.deepEqual(mapReport.duplicateLabels, []);
    assert.deepEqual(mapReport.missingRegionOverrides, []);
    // Nearest-endpoint assignments are recorded for human review.
    assert.ok(Array.isArray(mapReport.nearestBridgeAssignments));
});

/* ------------------------------------------------------------------ *
 * Coordinates
 * ------------------------------------------------------------------ */

test('toLatLng flips y exactly once and toMapPoint inverts it', () => {
    assert.deepEqual(toLatLng({ x: 0, y: 0 }), { lat: 0, lng: 0 });
    assert.deepEqual(toLatLng({ x: 2048, y: 1536 }), { lat: -1536, lng: 2048 });
    assert.deepEqual(toLatLng({ x: 995, y: 698 }), { lat: -698, lng: 995 });
    assert.deepEqual(toMapPoint(toLatLng({ x: 995, y: 698 })), { x: 995, y: 698 });
    assert.throws(() => toLatLng({ x: 'a', y: 1 }));
    assert.throws(() => toMapPoint({ lat: 'a', lng: 1 }));
});

test('map bounds match L.CRS.Simple for the canonical canvas', () => {
    assert.deepEqual(mapBounds(), [[-1536, 0], [0, 2048]]);
});

test('pointInRegion uses the generated polygon geometry', () => {
    const center = regions.features.find((feature) => feature.label === 'Center');
    assert.equal(pointInRegion(center.centroid, center), true);
    assert.equal(pointInRegion({ x: -50, y: -50 }, center), false);
});

/* ------------------------------------------------------------------ *
 * Feature index + view model
 * ------------------------------------------------------------------ */

const featureIndex = buildMapFeatureIndex({
    regions,
    bridges,
    keyLocations,
    overrides,
    districts,
    locations,
});

test('feature index resolves every feature, location, and region', () => {
    assert.equal(featureIndex.regions.length, 36);
    assert.equal(featureIndex.bridges.length, 12);
    assert.equal(featureIndex.keyLocations.length, 22);

    assert.ok(featureIndex.get('region:center'));
    assert.ok(featureIndex.getByLabel('Center'));
    assert.equal(featureIndex.get('region:does-not-exist'), null);

    const centralPlaza = locations.locations.find((location) => location.id === 'central-plaza');
    const region = featureIndex.getRegionForLocation('central-plaza');
    assert.equal(region?.id, centralPlaza.regionId);

    assert.ok(featureIndex.getBridgesForRegion('region:upper-middle-residential-a').length >= 1);
    assert.ok(featureIndex.getKeyLocationsForRegion('region:center').length >= 1);
    assert.ok(featureIndex.getRegionAt({ x: 995, y: 698 }));
    assert.equal(featureIndex.getRegionAt({ x: -20, y: -20 }), null);
});

test('view model includes all features with overrides applied', () => {
    const vm = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        index: featureIndex,
    });
    assert.deepEqual(vm.canvas, { width: 2048, height: 1536 });
    assert.equal(vm.image, 'NeoTerra.png');
    assert.deepEqual(vm.bounds, [[-1536, 0], [0, 2048]]);
    assert.equal(vm.regions.length, 36);
    assert.equal(vm.bridges.length, 12);
    assert.equal(vm.keyLocations.length, 22);
    assert.equal(vm.namedLocations.length, locations.locations.length);

    const center = vm.regions.find((view) => view.label === 'Center');
    assert.equal(center.name, 'Center');
    assert.equal(center.districtId, 'downtown');
    assert.equal(center.districtName, 'Downtown');
    assert.ok(center.color.startsWith('#'));

    const petrabyte = vm.keyLocations.find((view) => view.locationId === 'petrabyte-tower');
    assert.equal(petrabyte.name, 'PetraByte Tower');
    assert.equal(petrabyte.named, true);
    assert.equal(petrabyte.districtId, 'downtown');

    const unassignedOffice = vm.keyLocations.find((view) => view.label === 'BigOfficeA');
    assert.equal(unassignedOffice.named, false);
    assert.match(unassignedOffice.name, /Unassigned Office/);

    const harborBridge = vm.bridges.find((view) => view.label === 'BridgeI');
    assert.equal(harborBridge.name, 'Harbor Lift');
    assert.equal(harborBridge.status, 'open');
    assert.equal(harborBridge.connectsNames.length, 2);
    assert.ok(harborBridge.connectsNames.every(Boolean));

    const subway = vm.namedLocations.find((view) => view.id === 'old-subway');
    assert.equal(subway.virtual, true);
    assert.ok(subway.regionId);
});

test('view model merges live WorldState faction and status without touching geometry', () => {
    const base = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        index: featureIndex,
    });
    const state = {
        locations: {
            'central-plaza': {
                id: 'central-plaza',
                regionId: 'region:center',
                factionId: 'iron-serpents',
                status: 'contested',
                present: ['s1.leila.renya'],
                visited: true,
            },
        },
        factions: { 'iron-serpents': { id: 'iron-serpents', name: 'Iron Serpents' } },
        scene: { locationId: 'central-plaza', present: [] },
    };
    const live = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        state,
        index: featureIndex,
    });
    const center = live.regions.find((view) => view.id === 'region:center');
    assert.equal(center.factionId, 'iron-serpents');
    assert.equal(center.factionName, 'Iron Serpents');
    const plaza = live.namedLocations.find((view) => view.id === 'central-plaza');
    assert.equal(plaza.status, 'contested');
    assert.deepEqual(plaza.present, ['s1.leila.renya']);
    assert.equal(plaza.visited, true);

    // Geometry is untouched by state.
    assert.deepEqual(
        live.regions[0].geometry,
        base.regions[0].geometry,
    );
});

test('submenu describes a district, a bridge, a key location, and a named location', () => {
    const vm = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        index: featureIndex,
    });
    const state = { scene: { locationId: 'central-plaza', present: ['s1.leila.renya'] }, locations: {} };

    const regionMenu = buildMapSubmenu({ kind: 'region', id: 'region:center' }, vm, { state });
    assert.equal(regionMenu.ok, true);
    assert.equal(regionMenu.typeLabel, 'region');
    assert.equal(regionMenu.districtName, 'Downtown');
    assert.equal(regionMenu.travel.enabled, false);
    assert.ok(regionMenu.keyLocationIds.length > 0);

    const bridgeMenu = buildMapSubmenu({ kind: 'bridge', id: 'bridge:bridge-i' }, vm, { state });
    assert.equal(bridgeMenu.ok, true);
    assert.equal(bridgeMenu.title, 'Harbor Lift');
    assert.equal(bridgeMenu.connects.length, 2);
    assert.equal(bridgeMenu.travel.enabled, false);

    const keyMenu = buildMapSubmenu({ kind: 'keyLocation', id: 'key:city-core' }, vm, { state });
    assert.equal(keyMenu.ok, true);
    assert.equal(keyMenu.travel.enabled, true);
    assert.equal(keyMenu.travel.locationId, 'central-plaza');

    const namedMenu = buildMapSubmenu({ kind: 'namedLocation', id: 'central-plaza' }, vm, { state });
    assert.equal(namedMenu.ok, true);
    assert.equal(namedMenu.title, 'Central Plaza');
    assert.equal(namedMenu.travel.enabled, true);

    const unknown = buildMapSubmenu({ kind: 'region', id: 'region:nope' }, vm, { state });
    assert.equal(unknown.ok, false);
});

test('travel is disabled the moment combat starts', () => {
    const vm = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        index: featureIndex,
    });
    const menu = buildMapSubmenu(
        { kind: 'namedLocation', id: 'central-plaza' },
        vm,
        { state: { scene: { combat: { round: 1 } }, locations: {} } },
    );
    assert.equal(menu.travel.enabled, false);
    assert.match(menu.travel.reason, /combat/i);
});

test('submenu markup renders title, facts, present cast, and travel state', () => {
    const vm = buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        index: featureIndex,
    });
    const menu = buildMapSubmenu(
        { kind: 'namedLocation', id: 'central-plaza' },
        vm,
        { state: { scene: { locationId: 'central-plaza', present: ['Leila Renya'] }, locations: {} } },
    );
    const html = renderSubmenuMarkup(menu);
    assert.match(html, /Central Plaza/);
    assert.match(html, /data-neoterra-map-travel/);
    assert.match(html, /Leila Renya/);
    const empty = renderSubmenuMarkup({ ok: false, error: 'Select a district' });
    assert.match(empty, /Select a district/);
});

/* ------------------------------------------------------------------ *
 * Leaflet-free rendering
 * ------------------------------------------------------------------ */

class FakeLatLng {
    constructor(lat, lng) {
        this.lat = lat;
        this.lng = lng;
    }

    equals(other) {
        return other && other.lat === this.lat && other.lng === this.lng;
    }
}

class FakeLayer {
    constructor(options) {
        this.options = options;
        this.handlers = {};
        this.style = { ...options };
        this.children = [];
    }

    on(event, handler) {
        this.handlers[event] = handler;
        return this;
    }

    setStyle(style) {
        Object.assign(this.style, style);
    }

    bindTooltip() {
        return this;
    }

    bindPopup() {
        return this;
    }

    addTo(parent) {
        if (Array.isArray(parent.layers)) {
            parent.layers.push(this);
        } else {
            parent.registerGroup?.(this);
        }
        return this;
    }
}

class FakePolygon extends FakeLayer {}

class FakePolyline extends FakeLayer {}

class FakeCircleMarker extends FakeLayer {}

class FakeMarker extends FakeLayer {}

class FakeLayerGroup extends FakeLayer {
    constructor() {
        super({});
        this.layers = [];
    }

    addTo(parent) {
        parent.registerGroup(this);
        return this;
    }

    add(layer) {
        this.layers.push(layer);
        return this;
    }
}

class FakeImageOverlay extends FakeLayer {}

const fakeMap = {
    layers: [],
    addLayer(layer) {
        this.layers.push(layer);
    },
    removeLayer(layer) {
        this.layers = this.layers.filter((entry) => entry !== layer);
    },
    hasLayer(layer) {
        return this.layers.includes(layer);
    },
    registerGroup() {},
    fitBounds() {
        return this;
    },
    setView() {
        return this;
    },
    on() {
        return this;
    },
    removeCalls: 0,
    remove() {
        this.removeCalls += 1;
    },
    invalidateSize() {
        return this;
    },
};

function fakeLeaflet() {
    const groups = [];
    return {
        version: '1.9.4-fake',
        CRS: { Simple: { code: 'Simple' } },
        latLng: (lat, lng) => new FakeLatLng(lat, lng),
        latLngBounds: (a, b) => ({ pad: () => ({ a, b }), a, b }),
        map: () => ({
            ...fakeMap,
            layers: [],
            children: [],
            registerGroup(group) {
                this.layers.push(group);
            },
        }),
        polygon: (points, options) => {
            const layer = new FakePolygon(options);
            layer.points = points;
            return layer;
        },
        polyline: (points, options) => {
            const layer = new FakePolyline(options);
            layer.points = points;
            return layer;
        },
        circleMarker: (point, options) => {
            const layer = new FakeCircleMarker(options);
            layer.point = point;
            return layer;
        },
        marker: (point, options) => {
            const layer = new FakeMarker(options);
            layer.point = point;
            return layer;
        },
        layerGroup: () => {
            const group = new FakeLayerGroup();
            groups.push(group);
            return group;
        },
        imageOverlay: (url, bounds, options) => {
            const layer = new FakeImageOverlay(options);
            layer.url = url;
            return layer;
        },
        divIcon: (options) => ({ options }),
        Polygon: FakePolygon,
        Polyline: FakePolyline,
        CircleMarker: FakeCircleMarker,
        Marker: FakeMarker,
        layerGroups: groups,
    };
}

const vm = buildMapViewModel({
    regions,
    bridges,
    keyLocations,
    overrides,
    districts,
    locations,
    index: featureIndex,
});

test('createCityMap builds every layer from the generated model', () => {
    const L = fakeLeaflet();
    const selections = [];
    const cityMap = createCityMap({
        L,
        container: {},
        viewModel: vm,
        onSelect: (selection) => selections.push(selection),
    });
    assert.equal(cityMap.layers.districts.layers.length, 36);
    assert.equal(cityMap.layers.keyLocations.layers.length, 22);
    assert.equal(cityMap.layers.namedLocations.layers.length, locations.locations.length);
    const bridgeLine = cityMap.layers.bridges.layers[0];
    assert.ok(bridgeLine.points.length >= 2);
    assert.equal(bridgeLine.points[0].lat, -vm.bridges[0].centerline[0].y);

    cityMap.layers.districts.layers[0].handlers.click();
    assert.equal(selections[0].kind, 'region');

    cityMap.setLayerVisible('districts', false);
    assert.equal(cityMap.layers.districts.layers !== undefined, true);
    cityMap.dispose();
    assert.equal(cityMap.map.removeCalls, 1);
});

test('layer toggles default on with fog off, and labels match', () => {
    const toggles = defaultLayerVisibility({});
    assert.deepEqual(
        MAP_LAYER_ORDER.map((layer) => toggles[layer]),
        [true, true, true, true, true, false],
    );
    assert.equal(defaultLayerVisibility({ showFogOfWar: true }).fog, true);
    assert.equal(defaultLayerVisibility({ districts: false }).districts, false);
    assert.deepEqual(
        Object.keys(buildLayerToggleState({ bridges: false, showFogOfWar: true })).sort(),
        [...MAP_LAYER_ORDER].sort(),
    );
    assert.equal(buildLayerToggleState({ bridges: false }).bridges, false);
    const html = renderLayerToggles(toggles);
    for (const layer of MAP_LAYER_ORDER) {
        assert.match(html, new RegExp(`data-neoterra-map-toggle="${layer}"`));
        assert.match(html, new RegExp(MAP_LAYER_LABELS[layer]));
    }
    assert.equal(DEFAULT_LAYER_VISIBILITY.fog, false);
    assert.equal(bridgeStatusClass('destroyed'), 'is-destroyed');
    assert.equal(bridgeStatusClass('nonsense'), 'is-open');
});

test('fallback mount renders only named locations and no geometry', async () => {
    const L = fakeLeaflet();
    const selections = [];
    const fallback = await mountFallbackMap({
        container: {},
        viewModel: vm,
        leaflet: L,
        onSelect: (selection) => selections.push(selection),
    });
    assert.equal(fallback.layers.districts.layers.length, 0);
    assert.equal(fallback.layers.bridges.layers.length, 0);
    assert.equal(fallback.layers.keyLocations.layers.length, 0);
    assert.equal(fallback.layers.namedLocations.layers.length, locations.locations.length);
    fallback.layers.namedLocations.layers[0].handlers.click();
    assert.equal(selections[0].kind, 'namedLocation');
    fallback.destroy();
    assert.equal(fallback.map.removeCalls, 1);
});

test('mountCityMap requires a container and uses the provided Leaflet', async () => {
    await assert.rejects(() => mountCityMap({ viewModel: vm }), /container/);
    const L = fakeLeaflet();
    const mounted = await mountCityMap({ container: {}, viewModel: vm, leaflet: L });
    assert.equal(mounted.layers.districts.layers.length, 36);
    mounted.destroy();
});

/* ------------------------------------------------------------------ *
 * Map panel helpers (DOM-free)
 * ------------------------------------------------------------------ */

test('panel geometry is clamped, persisted, and restored', () => {
    const small = clampPanelGeometry({ x: -100, y: -100, width: 100, height: 100 }, { width: 1080, height: 720 });
    assert.equal(small.width >= 360, true);
    assert.equal(small.height >= 300, true);
    assert.equal(small.x >= 12, true);
    assert.equal(small.y >= 12, true);

    const huge = clampPanelGeometry({ x: 99999, y: 99999, width: 99999, height: 99999 }, { width: 1440, height: 900 });
    assert.ok(huge.x + huge.width <= 1440);
    assert.ok(huge.y + huge.height <= 900);

    const stored = new Map();
    const storage = {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
    };
    assert.equal(loadPanelGeometry(null).x, null);
    assert.equal(savePanelGeometry(storage, { x: 40, y: 60, width: 900, height: 600 }), true);
    assert.equal(JSON.parse(stored.get('neoterra:map:panel')).geometryVersion, GEOMETRY_VERSION);
    const restored = loadPanelGeometry(storage);
    assert.deepEqual(restored, { x: 40, y: 60, width: 900, height: 600 });
    stored.set('neoterra:map:panel', '{bad json');
    assert.equal(loadPanelGeometry(storage).x, null);
});

test('panel geometry fits 1080p and 1440p viewports', () => {
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
        const geometry = clampPanelGeometry({ width: 99999, height: 99999 }, viewport);
        assert.ok(geometry.width <= viewport.width - 24, `${viewport.width}px width`);
        assert.ok(geometry.height <= viewport.height - 24, `${viewport.height}px height`);
        assert.ok(geometry.x >= 12 && geometry.x + geometry.width <= viewport.width);
        assert.ok(geometry.y >= 12 && geometry.y + geometry.height <= viewport.height);
    }
});

test('legacy 1080x700 storage migrates to the taller default; custom sizes survive', () => {
    const stored = new Map();
    const storage = {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
    };

    // Exactly the old default with no version marker: treated as unset.
    stored.set('neoterra:map:panel', JSON.stringify({ x: null, y: null, width: 1080, height: 700 }));
    const migrated = loadPanelGeometry(storage);
    assert.deepEqual(migrated, { x: null, y: null, width: 1080, height: 820 });

    // A custom size is the user's choice and is preserved.
    stored.set('neoterra:map:panel', JSON.stringify({ x: 40, y: 60, width: 900, height: 640 }));
    assert.deepEqual(loadPanelGeometry(storage), { x: 40, y: 60, width: 900, height: 640 });

    // The v1 default at a saved position still migrates: positions are
    // re-clamped on load, so the user only loses the offset, not a size.
    stored.set('neoterra:map:panel', JSON.stringify({ x: 100, y: 80, width: 1080, height: 700 }));
    assert.deepEqual(loadPanelGeometry(storage), { x: null, y: null, width: 1080, height: 820 });

    // A versioned 1080x700 is a deliberate choice made after the migration.
    stored.set('neoterra:map:panel', JSON.stringify({ x: null, y: null, width: 1080, height: 700, geometryVersion: GEOMETRY_VERSION }));
    assert.deepEqual(loadPanelGeometry(storage), { x: null, y: null, width: 1080, height: 700 });

    // Round-trip: saving the migrated default persists the version.
    savePanelGeometry(storage, migrated);
    assert.equal(JSON.parse(stored.get('neoterra:map:panel')).geometryVersion, GEOMETRY_VERSION);
    assert.deepEqual(loadPanelGeometry(storage), migrated);
});

test('the panel grows with the host instead of staying at the old 396px clamp', () => {
    // 1296x894 shell -> ~1182x600 host (the live-measured map tab).
    const host = { width: 1182, height: 600 };
    const wide = clampPanelGeometry({ x: null, y: null, width: 1080, height: 820 }, host);
    assert.equal(wide.width, 1080);
    assert.equal(wide.height, 600 - 24);
    assert.ok(wide.height > 396, 'panel must be taller than the old 396px clamp');

    // 1920x1080 viewport -> ~750px host.
    const tall = clampPanelGeometry({ width: 1080, height: 820 }, { width: 1200, height: 750 });
    assert.equal(tall.height, 750 - 24);

    // Drag and resize both use `clampPanelGeometry` with the host box, so a
    // host-sized viewport can never yield a panel taller than viewHeight - 24.
    for (const viewport of [{ width: 1182, height: 600 }, { width: 900, height: 500 }, { width: 2000, height: 1200 }]) {
        const dragged = clampPanelGeometry({ x: 5000, y: 5000, width: 5000, height: 5000 }, viewport);
        assert.equal(dragged.height, Math.max(300, viewport.height - 24));
        assert.ok(dragged.height <= Math.max(300, viewport.height - 24));
        assert.ok(dragged.width <= Math.max(360, viewport.width - 24));
        assert.ok(dragged.x + dragged.width <= Math.max(372, viewport.width), 'drag stays inside the host');
        assert.ok(dragged.y + dragged.height <= Math.max(312, viewport.height), 'drag stays inside the host');
    }

    // Narrow/short host: the minimum still wins and the panel stays inside
    // the host horizon where the host allows it.
    const narrow = clampPanelGeometry({ width: 1080, height: 820 }, { width: 900, height: 700 });
    assert.equal(narrow.width, 900 - 24);
    assert.equal(narrow.height, 700 - 24);
    assert.ok(narrow.x >= 12 && narrow.x + narrow.width <= 900);
    assert.ok(narrow.y >= 12 && narrow.y + narrow.height <= 700);
    assert.ok(narrow.x + narrow.width - 12 > 0, 'resize handle stays reachable');
});

test('drag and resize clamp to the map host, never the window', () => {
    const source = readFileSync(join(ROOT, 'src/ui/map-panel.js'), 'utf8');
    const start = source.indexOf('function mountDragResize');
    const end = source.indexOf('export function refreshMapPanel');
    const body = source.slice(start, end);
    assert.ok(start > -1 && end > start);
    assert.equal((body.match(/clampToHost\(state\)/g) ?? []).length, 2, 'both handlers clamp via clampToHost');
    assert.doesNotMatch(body, /window\.innerWidth|window\.innerHeight/);
});

test('the map close callback is guarded and invoked once', () => {
    let calls = 0;
    assert.equal(runCloseHandler(() => { calls += 1; }), true);
    assert.equal(calls, 1);
    assert.equal(runCloseHandler(null), false);
    assert.equal(runCloseHandler(() => { throw new Error('host failed'); }), false);
    // The panel wires the option and forwards the click to the guard.
    const source = readFileSync(join(ROOT, 'src/ui/map-panel.js'), 'utf8');
    assert.match(source, /onClose: typeof onClose === 'function' \? onClose : null/);
    assert.match(source, /runCloseHandler\(state\.onClose\)/);
});

test('closeOnTravel closes only after a posted or deduped frame', () => {
    const on = { map: { closeOnTravel: true } };
    const off = { map: { closeOnTravel: false } };
    assert.equal(shouldCloseAfterTravel({ posted: true, index: 3 }, on), true);
    assert.equal(shouldCloseAfterTravel({ posted: false, deduped: true, index: 3 }, on), true);
    assert.equal(shouldCloseAfterTravel({ posted: true }, off), false);
    assert.equal(shouldCloseAfterTravel({ posted: false, deduped: false }, on), false);
    assert.equal(shouldCloseAfterTravel({ posted: false, reason: 'no-chat' }, on), false);
    // Rejected travel and `alreadyThere` call announce() with no result.
    assert.equal(shouldCloseAfterTravel(null, on), false);
    assert.equal(shouldCloseAfterTravel(undefined, on), false);
    // Missing settings means the default (`true`).
    assert.equal(shouldCloseAfterTravel({ posted: true }, undefined), true);
});

test('layer visibility persists per user and sanitizes bad input', () => {    const stored = new Map();
    const storage = {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
    };
    const defaults = loadLayerVisibility(null, {});
    assert.equal(defaults.districts, true);
    assert.equal(defaults.fog, false);

    assert.equal(saveLayerVisibility(storage, { ...defaults, districts: false, fog: true }), true);
    const restored = loadLayerVisibility(storage, {});
    assert.equal(restored.districts, false);
    assert.equal(restored.fog, true);

    stored.set('neoterra:map:layers', '{"districts":"nope","bridges":false}');
    const sanitized = loadLayerVisibility(storage, {});
    assert.equal(sanitized.districts, true);
    assert.equal(sanitized.bridges, false);

    stored.set('neoterra:map:layers', '{bad json');
    assert.equal(loadLayerVisibility(storage, {}).districts, true);
});

test('panel view model is built from sources and survives a missing build', () => {
    const sources = { generated: { regions, bridges, keyLocations }, districts, overrides, locations };
    const built = buildPanelViewModel(sources, null);
    assert.equal(built.regions.length, 36);
    assert.equal(built.keyLocations.length, 22);

    const fallback = buildPanelViewModel({
        generated: null,
        districts,
        overrides,
        locations,
    }, null);
    assert.equal(fallback.regions.length, 0);
    assert.equal(fallback.bridges.length, 0);
    assert.equal(fallback.namedLocations.length, locations.locations.length);
});

/* ------------------------------------------------------------------ *
 * State machine
 * ------------------------------------------------------------------ */

test('map state machine only accepts declared transitions', () => {
    const transitions = [];
    const ignored = [];
    const flow = createMachine({
        name: 'map',
        initial: 'closed',
        states: {
            closed: { on: { OPEN: 'open' } },
            open: { on: { SELECT: 'location', CLOSE: 'closed' } },
            location: { on: { OPEN_TRAVEL: 'travel', CLEAR: 'open', CLOSE: 'closed' } },
            travel: { on: { CONFIRM_TRAVEL: 'location', CANCEL_TRAVEL: 'location' } },
        },
        onChange: (to) => transitions.push(to),
        onIgnored: (event, from) => ignored.push(`${from}:${event}`),
    });

    assert.equal(flow.state, 'closed');
    assert.equal(flow.send('SELECT'), false);
    assert.deepEqual(ignored, ['closed:SELECT']);

    assert.equal(flow.send('OPEN'), true);
    assert.equal(flow.state, 'open');
    assert.equal(flow.send('SELECT', { id: 'x' }), true);
    assert.equal(flow.state, 'location');
    assert.equal(flow.send('OPEN_TRAVEL'), true);
    assert.equal(flow.state, 'travel');
    assert.equal(flow.send('SELECT'), false);
    assert.equal(flow.send('CONFIRM_TRAVEL'), true);
    assert.deepEqual(transitions, ['open', 'location', 'travel', 'location']);
    assert.equal(flow.can('OPEN_TRAVEL'), true);
});

test('map state machine guards, internal transitions, and queued sends', () => {
    let entered = 0;
    const flow = createMachine({
        name: 'map',
        initial: 'a',
        context: { allowed: false },
        states: {
            a: {
                on: {
                    GO: {
                        target: 'b',
                        guard: (context) => context.allowed,
                    },
                },
            },
            b: {
                enter: () => {
                    entered += 1;
                    flow.send('BACK');
                },
                on: {
                    AGAIN: { target: 'b', internal: true },
                    BACK: 'a',
                },
            },
        },
    });
    assert.equal(flow.send('GO'), false);
    flow.context.allowed = true;
    assert.equal(flow.send('GO'), true);
    assert.equal(flow.state, 'a');
    assert.equal(entered, 1);
});

test('map state machine rejects a bad state graph at construction', () => {
    assert.throws(() => createMachine({ name: 'x', initial: 'nope', states: {} }), /unknown initial state/);
    assert.throws(
        () => createMachine({ name: 'x', initial: 'a', states: { a: { on: { GO: 'nowhere' } } } }),
        /unknown state nowhere/,
    );
});

/* ------------------------------------------------------------------ *
 * Loaders and fallbacks
 * ------------------------------------------------------------------ */

test('generated loaders validate, cache, and expose a fallback', async () => {
    clearGeneratedMapCaches();
    const loaded = await loadGeneratedMapData({ fetchImpl: fileFetch });
    assert.ok(loaded);
    assert.equal(loaded.regions.features.length, 36);
    clearGeneratedMapCaches();

    const cachedManifest = await loadMapManifest({ fetchImpl: fileFetch });
    assert.equal(cachedManifest.schemaVersion, 1);
    assert.equal((await loadRegions({ fetchImpl: fileFetch })).features.length, 36);
    assert.equal((await loadBridges({ fetchImpl: fileFetch })).features.length, 12);
    assert.equal((await loadKeyLocations({ fetchImpl: fileFetch })).keyLocations.length, 22);
    clearGeneratedMapCaches();

    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    clearGeneratedMapCaches();
    assert.equal(await loadGeneratedMapData({ fetchImpl: failing }), null);
    await assert.rejects(() => loadGeneratedMapData({ fetchImpl: failing, strict: true }), /HTTP 503/);
    clearGeneratedMapCaches();
});

test('loadMapSources degrades gracefully but surfaces auth/lore failures', async () => {
    clearGeneratedMapCaches();
    const sources = await loadMapSources({ fetchImpl: fileFetch });
    assert.ok(sources.generated);
    assert.equal(sources.districts.districts.length, 10);
    assert.ok(sources.overrides.regions.Center);
    assert.equal(sources.locations.locations.length, locations.locations.length);
});

test('resolveMapRef still works against the generated feature lists', () => {
    const resolved = resolveMapRef(
        { layer: 'keyLocation', id: 'key:city-core' },
        { regions: regions.features, bridges: bridges.features, keyLocations: keyLocations.keyLocations },
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.feature.label, 'CityCore');
});

/* ------------------------------------------------------------------ *
 * Authored helpers
 * ------------------------------------------------------------------ */

test('location mapRef/region helpers index the migrated registry', () => {
    const byRegion = buildLocationsByRegion(locations);
    assert.ok(byRegion.get('region:center').some((location) => location.id === 'central-plaza'));

    const byRef = findLocationByMapRef(locations, { layer: 'keyLocation', id: 'key:big-office-b' });
    assert.equal(byRef.id, 'petrabyte-tower');

    const inRegion = findLocationsInRegion(locations, 'region:center');
    assert.ok(inRegion.some((location) => location.id === 'clarity-hq'));
    assert.deepEqual(findLocationsInRegion(locations, 'region:nope'), []);
});

test('the authored overrides bind each named location exactly once', () => {
    const claimed = Object.entries(overrides.keyLocations)
        .filter(([, override]) => override.locationId)
        .map(([, override]) => override.locationId);
    assert.equal(new Set(claimed).size, claimed.length);
    for (const locationId of claimed) {
        const location = locations.locations.find((entry) => entry.id === locationId);
        assert.ok(location, locationId);
        assert.equal(location.virtual, false);
    }
});

/* ------------------------------------------------------------------ *
 * Packaging + runtime boundaries
 * ------------------------------------------------------------------ */

test('Leaflet is vendored locally with LICENSE and VERSION', () => {
    const leafletJs = readFileSync(join(ROOT, 'vendor/leaflet/leaflet.js'), 'utf8');
    const leafletCss = readFileSync(join(ROOT, 'vendor/leaflet/leaflet.css'), 'utf8');
    const version = readFileSync(join(ROOT, 'vendor/leaflet/VERSION'), 'utf8').trim();
    const license = readFileSync(join(ROOT, 'vendor/leaflet/LICENSE'), 'utf8');
    assert.equal(version, '1.9.4');
    assert.match(leafletJs, /Leaflet 1\.9\.4/);
    assert.match(leafletJs, /window\.L/);
    assert.match(leafletCss, /leaflet-container/);
    assert.match(license, /BSD 2-Clause/);
    for (const image of ['marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png', 'layers.png', 'layers-2x.png']) {
        assert.ok(readFileSync(join(ROOT, 'vendor/leaflet/images', image)).length > 0, image);
    }
    // Upstream URLs must never be referenced by our own runtime code.
    for (const file of ['src/ui/leaflet-adapter.js', 'src/ui/map.js', 'src/ui/map-panel.js']) {
        const text = readFileSync(join(ROOT, file), 'utf8');
        assert.equal(/unpkg\.com|cdn\.jsdelivr|https?:\/\/[^'"]*leaflet/i.test(text), false, file);
    }
});

test('runtime modules never parse SVG', () => {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    const files = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.js'));
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        assert.equal(text.includes('inkscape:label'), false, file);
        assert.equal(text.includes('DOMParser'), false, file);
    }
});

test('initial layer visibility honours the panel visibility map (fog key)', () => {
    const L = fakeLeaflet();
    const cityMap = createCityMap({
        L,
        container: {},
        viewModel: vm,
        settings: { ...defaultLayerVisibility(), fog: true, labels: false },
    });
    assert.equal(cityMap.map.layers.includes(cityMap.layers.fog), true);
    assert.equal(cityMap.map.layers.includes(cityMap.layers.labels), false);
    cityMap.dispose();
});

test('internal self-transitions do not fire onChange (the panel repaints itself)', () => {
    const changes = [];
    const flow = createMachine({
        name: 'map',
        initial: 'location',
        states: {
            location: {
                on: {
                    SELECT: {
                        target: 'location',
                        internal: true,
                        action: () => {},
                    },
                    CLOSE: 'closed',
                },
            },
            closed: {},
        },
        onChange: (to) => changes.push(to),
    });
    assert.equal(flow.send('SELECT', { id: 'a' }), true);
    assert.equal(flow.state, 'location');
    assert.deepEqual(changes, []);
});
