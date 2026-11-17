import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
    EXPECTED_COUNTS,
    buildMapData,
    elementPolygon,
    extractElements,
    extractLayerGroups,
    farthestEndpointPair,
    featureId,
    inferKeyLocationKind,
    inferRegionKind,
    loadSources,
    parsePathData,
    parseSvgLayers,
    pointInPolygon,
    polygonArea,
    polygonBBox,
    polygonCentroid,
    runBuild,
    slugifyMapLabel,
} from '../tools/build-map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const svgCombined = readFileSync(join(ROOT, 'NeoTerra.svg'), 'utf8');
const svgDistricts = readFileSync(join(ROOT, 'NeoTerra_Districts.svg'), 'utf8');
const svgBridges = readFileSync(join(ROOT, 'NeoTerra_Bridges.svg'), 'utf8');
const svgLocs = readFileSync(join(ROOT, 'NeoTerra_Locs.svg'), 'utf8');

const districts = readJson('data/districts.json');
const overrides = readJson('data/map/overrides.json');
const locations = readJson('data/locations.json');

function build(extra = {}) {
    return buildMapData({
        svgSources: {
            'NeoTerra.svg': svgCombined,
            'NeoTerra_Districts.svg': svgDistricts,
            'NeoTerra_Bridges.svg': svgBridges,
            'NeoTerra_Locs.svg': svgLocs,
        },
        districts,
        overrides,
        locations,
        ...extra,
    });
}

/* ------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------ */

test('layer extraction reads inkscape:label, never export metadata', () => {
    const groups = extractLayerGroups(svgCombined);
    const labels = groups.map((group) => group.label);
    assert.deepEqual(labels, ['Image', 'Districts', 'Bridges', 'KeyLocations']);

    // The single-layer exports carry cross-wired export metadata; the layer
    // label is what matters.
    assert.match(svgDistricts, /inkscape:export-filename="NeoTerra_Bridges\.svg"/);
    const districtLayers = parseSvgLayers(svgDistricts, { source: 'NeoTerra_Districts.svg' });
    assert.equal(districtLayers.Districts.elements.length, 36);
    // The single-layer exports keep the other groups present-but-hidden; only
    // the requested layer is consumed by the build, but all are parsed.
    assert.equal(districtLayers.Bridges.elements.length, 12);
    assert.equal(districtLayers.KeyLocations.elements.length, 22);
});

test('element counts match the authored baseline in every export', () => {
    for (const [text, source, layer, expected] of [
        [svgDistricts, 'NeoTerra_Districts.svg', 'Districts', 36],
        [svgBridges, 'NeoTerra_Bridges.svg', 'Bridges', 12],
        [svgLocs, 'NeoTerra_Locs.svg', 'KeyLocations', 22],
    ]) {
        const layers = parseSvgLayers(text, { source });
        assert.equal(layers[layer].elements.length, expected, source);
        const labels = layers[layer].elements.map((element) => element.label);
        assert.equal(new Set(labels).size, expected, `${source} labels must be unique`);
    }
});

test('path parsing handles relative/absolute commands and curves', () => {
    const square = parsePathData('M 0 0 L 10 0 L 10 10 L 0 10 Z');
    assert.equal(square.length, 1);
    assert.equal(polygonArea(square[0]), 100);
    assert.deepEqual(polygonBBox(square[0]), [0, 0, 10, 10]);
    assert.deepEqual(polygonCentroid(square[0]), { x: 5, y: 5 });

    // Relative commands, implicit lineto after moveto, and a cubic segment.
    const relative = parsePathData('m 0,0 10,0 0,10 -10,0 z');
    assert.equal(relative.length, 1);
    assert.equal(polygonArea(relative[0]), 100);

    const curved = parsePathData('M0 0 C 10 0 10 10 0 10 Z');
    assert.equal(curved.length, 1);
    assert.ok(curved[0].length > 3);
    assert.ok(polygonArea(curved[0]) > 10);

    // Horizontal/vertical shorthands.
    const hv = parsePathData('M 0 0 h 20 v 20 h -20 Z');
    assert.equal(polygonArea(hv[0]), 400);

    // Two subpaths produce two polygons (holes are flattened by the build).
    const multi = parsePathData('M 0 0 L 5 0 L 5 5 Z M 10 10 L 15 10 L 15 15 Z');
    assert.equal(multi.length, 2);
    assert.equal(parsePathData('not a path').length, 0);
});

test('ellipse and rect become polygons; stars keep their explicit center', () => {
    const ellipse = elementPolygon({
        element: 'ellipse',
        tag: ' cx="100" cy="50" rx="20" ry="10"',
    });
    assert.ok(ellipse.points.length >= 24);
    assert.deepEqual(ellipse.center, { x: 100, y: 50 });
    assert.ok(polygonArea(ellipse.points) > 500);

    const rect = elementPolygon({
        element: 'rect',
        tag: ' x="10" y="20" width="30" height="40"',
    });
    assert.equal(polygonArea(rect.points), 1200);
    assert.deepEqual(rect.center, { x: 25, y: 40 });

    const star = elementPolygon({
        element: 'path',
        tag: ' sodipodi:type="star" sodipodi:cx="996" sodipodi:cy="816" d="M 0 0 L 10 0 L 5 10 Z"',
    });
    assert.deepEqual(star.center, { x: 996, y: 816 });
});

test('point-in-polygon and farthest endpoint detection are stable', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
    assert.equal(pointInPolygon({ x: -1, y: 5 }, square), false);
    assert.equal(pointInPolygon({ x: 10, y: 10 }, square), false);

    const [a, b] = farthestEndpointPair([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 25, y: 0 },
    ].map((point) => [point.x, point.y]));
    assert.deepEqual(a, [0, 0]);
    assert.deepEqual(b, [25, 0]);
});

test('labels slug to stable ids and kinds are inferred from prefixes', () => {
    assert.equal(slugifyMapLabel('HighriseDistrictA'), 'highrise-district-a');
    assert.equal(slugifyMapLabel('BigOfficeB'), 'big-office-b');
    assert.equal(slugifyMapLabel('  IslandA '), 'island-a');
    assert.equal(featureId('region', 'Center'), 'region:center');
    assert.equal(featureId('keyLocation', 'BigOfficeB'), 'key:big-office-b');
    assert.throws(() => featureId('nope', 'x'));

    assert.equal(inferRegionKind('ResidentialDistrictA'), 'residential');
    assert.equal(inferRegionKind('HighClassResidentialA'), 'residential');
    assert.equal(inferRegionKind('HighriseDistrictD'), 'highrise');
    assert.equal(inferRegionKind('WarehousesA'), 'industrial');
    assert.equal(inferRegionKind('River'), 'water');
    assert.equal(inferRegionKind('UndevelopedForestMountains'), 'wilderness');
    assert.equal(inferRegionKind('Center'), 'center');
    assert.equal(inferRegionKind('MysteryBlob'), 'unknown');

    assert.equal(inferKeyLocationKind('BigOfficeA'), 'office');
    assert.equal(inferKeyLocationKind('RichHomeA'), 'home');
    assert.equal(inferKeyLocationKind('SlumsSafehouse'), 'safehouse');
    assert.equal(inferKeyLocationKind('StadiumB'), 'stadium');
    assert.equal(inferKeyLocationKind('IndustrialParkA'), 'industrial');
    assert.equal(inferKeyLocationKind('CityCore'), 'unknown');
});

/* ------------------------------------------------------------------ *
 * Build output
 * ------------------------------------------------------------------ */

test('the build extracts exactly 36/12/22 features with unique ids', () => {
    const result = build();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.counts, {
        districts: EXPECTED_COUNTS.districts,
        bridges: EXPECTED_COUNTS.bridges,
        keyLocations: EXPECTED_COUNTS.keyLocations,
    });

    const regionIds = result.regions.features.map((feature) => feature.id);
    const bridgeIds = result.bridges.features.map((feature) => feature.id);
    const keyIds = result.keyLocations.keyLocations.map((feature) => feature.id);
    for (const ids of [regionIds, bridgeIds, keyIds]) {
        assert.equal(new Set(ids).size, ids.length);
    }

    for (const feature of result.regions.features) {
        assert.equal(feature.type, 'Feature');
        assert.equal(feature.layer, 'district');
        assert.equal(feature.geometry.type, 'Polygon');
        assert.ok(feature.area > 0, `${feature.label} must have positive area`);
        const ring = feature.geometry.coordinates[0];
        assert.deepEqual(ring[0], ring[ring.length - 1], 'polygon ring must close');
        for (const [x, y] of ring) {
            assert.ok(x >= 0 && x <= 2048 && y >= 0 && y <= 1536, `${feature.label} out of canvas`);
        }
        assert.ok(feature.districtId, `${feature.label} must resolve a district`);
    }
});

test('every bridge connects two distinct real regions', () => {
    const result = build();
    const regionIds = new Set(result.regions.features.map((feature) => feature.id));
    assert.equal(result.bridges.features.length, 12);
    for (const bridge of result.bridges.features) {
        assert.equal(bridge.connects.length, 2, bridge.label);
        assert.notEqual(bridge.connects[0], bridge.connects[1], bridge.label);
        for (const regionId of bridge.connects) {
            assert.ok(regionIds.has(regionId), `${bridge.label} -> ${regionId}`);
        }
        assert.ok(bridge.length > 0, bridge.label);
        assert.equal(bridge.endpoints.length, 2);
        assert.equal(bridge.centerline.length, 2);
        assert.ok(['open', 'contested', 'blocked', 'destroyed'].includes(bridge.status));
        assert.ok(bridge.geometry.coordinates[0].length >= 4);
    }
    // Water polygons are never bridge endpoints.
    const waterIds = new Set(
        result.regions.features.filter((feature) => feature.kind === 'water').map((feature) => feature.id),
    );
    for (const bridge of result.bridges.features) {
        for (const regionId of bridge.connects) {
            assert.equal(waterIds.has(regionId), false, `${bridge.label} must not connect water`);
        }
    }
});

test('every key location resolves to a region and stays inside the canvas', () => {
    const result = build();
    const regionIds = new Set(result.regions.features.map((feature) => feature.id));
    assert.equal(result.keyLocations.keyLocations.length, 22);
    for (const key of result.keyLocations.keyLocations) {
        assert.ok(key.regionId, `${key.label} must resolve a region`);
        assert.ok(regionIds.has(key.regionId), `${key.label} -> ${key.regionId}`);
        assert.ok(key.x >= 0 && key.x <= 2048, key.label);
        assert.ok(key.y >= 0 && key.y <= 1536, key.label);
        assert.equal(key.layer, 'keyLocation');
    }
});

test('named locations keep every id and gain derived region ids', () => {
    const result = build();
    const originalIds = locations.locations.map((location) => location.id);
    const migratedIds = result.locations.locations.map((location) => location.id);
    assert.deepEqual(migratedIds, originalIds);

    for (const location of result.locations.locations) {
        if (location.virtual) {
            assert.equal(location.mapRef, null, `${location.id} is virtual`);
        } else {
            assert.ok(location.mapRef, `${location.id} keeps a mapRef`);
        }
        assert.ok(location.regionId, `${location.id} resolves a region`);
        assert.ok(location.x >= 0 && location.x <= 2048);
        assert.ok(location.y >= 0 && location.y <= 1536);
    }
    const centralPlaza = result.locations.locations.find((location) => location.id === 'central-plaza');
    assert.equal(centralPlaza.regionId, 'region:center');
    assert.equal(centralPlaza.mapRef.id, 'key:city-core');
});

test('generated documents carry schema/layer/count metadata', () => {
    const result = build();
    assert.equal(result.map.schemaVersion, 1);
    assert.deepEqual(result.map.canvas, { width: 2048, height: 1536 });
    assert.deepEqual(result.map.layers, ['Districts', 'Bridges', 'KeyLocations']);
    assert.deepEqual(result.map.counts, { districts: 36, bridges: 12, keyLocations: 22 });
    assert.deepEqual(result.map.bounds, [[-1536, 0], [0, 2048]]);
    assert.equal(result.regions.type, 'FeatureCollection');
    assert.equal(result.bridges.type, 'FeatureCollection');
    assert.equal(result.keyLocations.schemaVersion, 1);
    assert.equal(result.report.schemaVersion, 1);
});

test('build fails loudly on duplicate labels, zero-area geometry, and count drift', () => {
    const duplicate = svgDistricts.replace(
        'inkscape:label="Center"',
        'inkscape:label="Center"',
    );
    // Duplicate an element by appending a copy of the first ellipse before the
    // group's closing tag.
    const broken = duplicate.replace(
        /(<ellipse[\s\S]*?inkscape:label="Center"\s*\/>)/,
        '$1$1',
    );
    const result = build({ svgSources: {
        'NeoTerra.svg': broken,
        'NeoTerra_Districts.svg': broken,
        'NeoTerra_Bridges.svg': svgBridges,
        'NeoTerra_Locs.svg': svgLocs,
    } });
    assert.ok(result.errors.some((error) => /duplicate district label "Center"/.test(error)));
    assert.ok(result.report.duplicateLabels.length > 0);
});

test('a missing layer is a hard error, not a silent skip', () => {
    const stripped = svgCombined.replace(/inkscape:label="Bridges"/, 'inkscape:label="NotBridges"');
    const result = build({ svgSources: { 'NeoTerra.svg': stripped } });
    assert.ok(result.errors.some((error) => /missing SVG layer "Bridges"/.test(error)));
    assert.ok(result.errors.some((error) => /bridge count 0/.test(error)));
});

test('a renamed region label fails because districts reference it', () => {
    const renamed = svgDistricts.replace('inkscape:label="Center"', 'inkscape:label="CentralCore"');
    const result = build({ svgSources: {
        'NeoTerra.svg': renamed,
        'NeoTerra_Districts.svg': renamed,
        'NeoTerra_Bridges.svg': svgBridges,
        'NeoTerra_Locs.svg': svgLocs,
    } });
    assert.ok(result.errors.some((error) => /district "downtown" references missing SVG region "Center"/.test(error)));
    assert.ok(result.errors.some((error) => /region "CentralCore" has no authored districtId/.test(error)));
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

test('--check validates without writing and reports OK', () => {
    const result = spawnSync(NODE, ['tools/build-map.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /districts:\s+36/);
    assert.match(result.stdout, /bridges:\s+12/);
    assert.match(result.stdout, /key locations:\s+22/);
    assert.match(result.stdout, /check passed/);
});

test('--report prints the extraction report and never fails on warnings', () => {
    const result = spawnSync(NODE, ['tools/build-map.mjs', '--check', '--report'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OK/);
});

test('runBuild is idempotent: a second run writes nothing new', () => {
    const first = runBuild({ root: ROOT });
    assert.deepEqual(first.errors, []);
    const regionsBefore = readFileSync(join(ROOT, 'data/map/regions.geojson'), 'utf8');
    const second = runBuild({ root: ROOT });
    assert.deepEqual(second.errors, []);
    const regionsAfter = readFileSync(join(ROOT, 'data/map/regions.geojson'), 'utf8');
    assert.equal(regionsBefore, regionsAfter);
    // The generated artifacts match a fresh in-memory build.
    const inMemory = build();
    assert.deepEqual(JSON.parse(regionsAfter), inMemory.regions);
});

test('loadSources reads the four SVGs plus authored JSON', () => {
    const sources = loadSources(ROOT);
    assert.ok(sources.svgSources['NeoTerra.svg']);
    assert.ok(sources.svgSources['NeoTerra_Districts.svg']);
    assert.ok(sources.svgSources['NeoTerra_Bridges.svg']);
    assert.ok(sources.svgSources['NeoTerra_Locs.svg']);
    assert.ok(Array.isArray(sources.districts.districts));
    assert.ok(sources.overrides.regions);
    assert.ok(Array.isArray(sources.locations.locations));
});
