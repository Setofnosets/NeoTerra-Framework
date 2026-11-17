import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BEAT_ACTS,
    canTransitionBeat,
    getOpenBeats,
    isBeatCompleted,
    isBeatEligible,
    listBeatsByAct,
    nextBeatStatus,
    validateBeat,
    validateBeats,
} from '../src/data/beats.js';
import {
    buildFactionIndex,
    clearFactionsCache,
    getFaction,
    loadFactions,
    validateFactions,
} from '../src/data/factions.js';
import {
    areLocationsAdjacent,
    clearLocationsCache,
    distanceBetween,
    getConnectedLocations,
    getLocation,
    isCoordinateInImage,
    loadLocations,
    validateLocations,
} from '../src/data/locations.js';
import {
    CANONICAL_MAP,
    buildDistrictIndex,
    buildMapOverrideIndex,
    clearMapCaches,
    featureId,
    getBridgeOverride,
    getDistrict,
    getDistrictForRegionLabel,
    getKeyLocationOverride,
    isValidMapRef,
    legacyToCanonical,
    loadDistricts,
    scaleMapPoint,
    loadMapOverrides,
    validateDistricts,
    validateMapOverrides,
} from '../src/data/map.js';
import {
    PLAYABLE_SEASON_IDS,
    SEASON_DEFINITION_IDS,
    assertPlayableSeason,
    buildBeatIndex,
    clearSeasonsCache,
    getSeasonBeatsByAct,
    getSeasonEntryMenu,
    getSeasonThreats,
    isPlayableSeason,
    loadSeason,
    loadSeasonDefinitions,
    resolveSeasonRoster,
    toEntryMenuCard,
    validateSeasonDefinition,
} from '../src/data/seasons.js';
import { buildRegistryIndex } from '../src/data/registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON_DIR = join(ROOT, 'data', 'seasons');

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readSeason(id) {
    const file = id === 's5' ? 's5.aux.json' : `${id}.json`;
    return readJson(join(SEASON_DIR, file));
}

/** Fetch stub that serves local repo files for any file:// URL. */
function fileFetch(url) {
    const parsed = new URL(url);
    let path = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(path)) {
        path = path.slice(1);
    }
    return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(readFileSync(path, 'utf8')),
    };
}

const registry = readJson(join(ROOT, 'data', 'characters', 'index.json'));
const factions = readJson(join(ROOT, 'data', 'factions.json'));
const locations = readJson(join(ROOT, 'data', 'locations.json'));
const districts = readJson(join(ROOT, 'data', 'districts.json'));
const mapOverrides = readJson(join(ROOT, 'data', 'map', 'overrides.json'));
const context = { registry, factions, locations, districts };
const registryIndex = buildRegistryIndex(registry);
const factionIndex = buildFactionIndex(factions);
const districtIndex = buildDistrictIndex(districts);

const seasons = Object.fromEntries(
    SEASON_DEFINITION_IDS.map((id) => [id, readSeason(id)]),
);

function clone(value) {
    return structuredClone(value);
}

test('every season definition validates, including the S5 auxiliary entry', () => {
    for (const id of SEASON_DEFINITION_IDS) {
        const validation = validateSeasonDefinition(seasons[id], context);
        assert.equal(validation.ok, true, `${id}: ${JSON.stringify(validation.errors)}`);
    }
    assert.equal(seasons.s5.playable, false);
    assert.equal(isPlayableSeason(seasons.s5), false);
    assert.throws(() => assertPlayableSeason(seasons.s5), /not yet playable/i);

    for (const id of PLAYABLE_SEASON_IDS) {
        assert.equal(isPlayableSeason(seasons[id]), true, id);
    }
});

test('S5 parses through loadSeasonDefinitions but loadSeason rejects it clearly', async () => {
    clearSeasonsCache();
    const definitions = await loadSeasonDefinitions({ fetchImpl: fileFetch });
    assert.equal(Object.keys(definitions).length, 7);
    assert.equal(definitions.s5.auxiliaryBook, 'Chars/lorebooks/NeoTerra-Season5(EnvyArc)Auxiliary.json');

    await assert.rejects(
        () => loadSeason('s5', { fetchImpl: fileFetch }),
        /not yet playable: Only an auxiliary lore book/i,
    );

    clearSeasonsCache();
    const s1 = await loadSeason('s1', { fetchImpl: fileFetch });
    assert.equal(s1.id, 's1');
    assert.equal(s1.canonBeats.length >= 4, true);

    await assert.rejects(() => loadSeason('nope', { fetchImpl: fileFetch }), /Unknown season id/);
    clearSeasonsCache();
});

test('entry menu exposes six playable entries plus a disabled S5 notice', async () => {
    clearSeasonsCache();
    const menu = await getSeasonEntryMenu({ fetchImpl: fileFetch });
    assert.equal(menu.length, 7);
    assert.equal(menu.filter((entry) => entry.playable).length, 6);

    const s5 = menu.find((entry) => entry.id === 's5');
    assert.equal(s5.playable, false);
    assert.match(s5.notice, /not yet playable/i);

    const dark = menu.find((entry) => entry.id === 's1dark');
    assert.equal(dark.alt, true);
    assert.match(dark.notice, /Villain POV/);
    assert.equal(dark.defaultPlayerCharacterId, 's1dark.carol.bleeding-heart');

    const card = toEntryMenuCard(seasons.s1);
    assert.equal(card.playable, true);
    assert.equal(card.notice, null);
    clearSeasonsCache();
});

test('every roster id resolves in the registry and stays inside its season', () => {
    for (const id of PLAYABLE_SEASON_IDS) {
        const season = seasons[id];
        if (season.allowAnyCharacter) {
            assert.equal(season.roster.length, 0, id);
            continue;
        }
        const resolved = resolveSeasonRoster(season, registry);
        assert.equal(resolved.length, season.roster.length, id);
        assert.ok(resolved.length > 0, id);

        for (const member of resolved) {
            assert.equal(member.character.seasonId, id, `${id} ${member.characterId}`);
            assert.equal(member.form.seasonId, id, `${id} ${member.formId}`);
            assert.equal(member.form.bundle, false, `${id} ${member.formId}`);
        }
    }

    assert.equal(
        resolveSeasonRoster(seasons.s1dark, registry)
            .some((member) => member.characterId === 's1dark.carol.bleeding-heart'),
        true,
    );
    assert.equal(
        resolveSeasonRoster(seasons.s4, registry).filter((member) => member.formId === member.characterId).length >= 10,
        true,
    );
});

test('season faction, location, threat, and beat references all resolve', () => {
    for (const id of PLAYABLE_SEASON_IDS) {
        const season = seasons[id];
        for (const factionRef of season.factions) {
            assert.ok(factionIndex.byId[factionRef.id], `${id} faction ${factionRef.id}`);
            assert.ok(factionRef.influence >= 0 && factionRef.influence <= 100);
        }
        const start = locations.locations.find((location) => location.id === season.startLocationId);
        assert.ok(start, id);
        assert.equal(
            start.mapRef !== null || start.virtual === true,
            true,
            `${id} start location must be mapped or virtual`,
        );
        assert.ok(districtIndex.byId[start.districtId], `${id} start district`);
        for (const member of season.roster) {
            if (member.locationId) {
                const location = locations.locations.find((candidate) => candidate.id === member.locationId);
                assert.ok(location, `${id} roster location ${member.locationId}`);
                assert.ok(districtIndex.byId[location.districtId], `${id} ${location.id} district`);
            }
        }

        const threatIds = new Set(season.threats.map((threat) => threat.id));
        for (const threat of season.threats) {
            if (threat.sourceFactionId) {
                assert.ok(factionIndex.byId[threat.sourceFactionId], `${id} ${threat.id}`);
            }
            if (threat.locationId) {
                assert.ok(locations.locations.some((location) => location.id === threat.locationId), `${id} ${threat.id}`);
            }
        }

        const beats = buildBeatIndex(season);
        assert.equal(Object.keys(beats.byId).length, season.canonBeats.length);
        for (const beatId of season.openingBeats) {
            assert.ok(beats.byId[beatId], `${id} ${beatId}`);
        }
        for (const beat of season.canonBeats) {
            for (const locationId of beat.conditions.locationIds ?? []) {
                assert.ok(locations.locations.some((location) => location.id === locationId), `${beat.id} ${locationId}`);
            }
            const referencedThreats = (beat.completion.predicates ?? [])
                .map((predicate) => predicate.threatId)
                .filter(Boolean);
            for (const threatId of referencedThreats) {
                assert.ok(threatIds.has(threatId), `${beat.id} ${threatId}`);
            }
        }
    }
});

test('S4 declares at least two main threats and S1Dark is a villain-POV alternate', () => {
    assert.equal(getSeasonThreats(seasons.s4, 'main').length >= 2, true);

    assert.equal(seasons.s1dark.alt, true);
    assert.equal(seasons.s1dark.altOf, 's1');
    assert.equal(seasons.s1dark.playerRole, 'villain');
    assert.equal(seasons.s1dark.defaultPlayerCharacterId, 's1dark.carol.bleeding-heart');
});

test('every non-sandbox season has a beat per act and every beat has a deadline consequence', () => {
    for (const id of PLAYABLE_SEASON_IDS) {
        const season = seasons[id];
        if (season.sandbox) {
            assert.equal(season.canonBeats.length, 0);
            continue;
        }
        const byAct = getSeasonBeatsByAct(season);
        for (const act of BEAT_ACTS) {
            assert.ok(byAct[act].length >= 1, `${id} ${act}`);
        }
        for (const beat of season.canonBeats) {
            assert.ok(typeof beat.deadlineConsequence === 'string' && beat.deadlineConsequence.length > 0, beat.id);
            assert.ok(beat.deadlineTurns !== null || beat.deadlineDate !== null, beat.id);
        }
    }

    for (const id of PLAYABLE_SEASON_IDS) {
        assert.ok(seasons[id].finalDeadline, id);
        assert.ok(
            ['villain-victory', 'neutral-bad-ending', 'none'].includes(seasons[id].failureState),
            id,
        );
        if (!seasons[id].sandbox) {
            assert.ok(
                seasons[id].finalDeadline.turns !== null || seasons[id].finalDeadline.date !== null,
                id,
            );
        }
    }
});

test('map schema documents the canonical counts and bindings', () => {
    const schema = readJson(join(ROOT, 'data', 'schemas', 'map.schema.json'));
    assert.equal(schema.$defs.canvas.properties.width.const, 2048);
    assert.equal(schema.$defs.canvas.properties.height.const, 1536);
    assert.equal(schema.$defs.mapManifest.properties.counts.properties.districts.const, 36);
    assert.equal(schema.$defs.mapManifest.properties.counts.properties.bridges.const, 12);
    assert.equal(schema.$defs.mapManifest.properties.counts.properties.keyLocations.const, 22);
    assert.equal(schema.$defs.mapRef.properties.layer.enum.length, 3);
    assert.equal(schema.$defs.namedLocation.properties.x.maximum, 2048);
    assert.equal(schema.$defs.namedLocation.properties.districtId.type, 'string');
});

test('districts and map overrides validate against canonical map bindings', () => {
    assert.equal(validateDistricts(districts).ok, true);
    assert.equal(validateMapOverrides(mapOverrides, {
        districtIds: new Set(Object.keys(districtIndex.byId)),
        locationIds: new Set(locations.locations.map((location) => location.id)),
        districts,
        locations,
        regionLabels: new Set(
            districts.districts.flatMap((district) => district.regionLabels),
        ),
    }).ok, true);

    assert.equal(districts.districts.length, 10);
    assert.equal(districtIndex.byId.downtown.name, 'Downtown');
    assert.equal(getDistrictForRegionLabel(districts, 'Center'), 'downtown');
    assert.equal(getDistrictForRegionLabel(districts, 'HighriseDistrictD'), 'fashion-row');
    assert.equal(getDistrict(districts, 'underground').virtual, true);

    const overrideIndex = buildMapOverrideIndex(mapOverrides);
    assert.equal(Object.keys(overrideIndex.regions).length, 36);
    assert.equal(Object.keys(overrideIndex.bridges).length, 12);
    assert.equal(Object.keys(overrideIndex.keyLocations).length, 22);
    assert.equal(getBridgeOverride(mapOverrides, 'BridgeA').status, 'open');
    assert.equal(getKeyLocationOverride(mapOverrides, 'CityCore').locationId, 'central-plaza');

    const overrideByKeyId = new Map(
        Object.entries(overrideIndex.keyLocations)
            .map(([label, override]) => [featureId('keyLocation', label), override]),
    );
    for (const location of locations.locations) {
        if (!location.mapRef) {
            assert.equal(location.virtual, true, location.id);
            continue;
        }
        assert.equal(location.mapRef.layer, 'keyLocation', location.id);
        assert.equal(
            overrideByKeyId.get(location.mapRef.id)?.locationId,
            location.id,
            `${location.id} ${location.mapRef.id}`,
        );
    }

    assert.equal(featureId('keyLocation', 'BigOfficeA'), 'key:big-office-a');
    assert.equal(isValidMapRef({ layer: 'bridge', id: 'bridge:bridge-a' }), true);
    assert.equal(isValidMapRef({ layer: 'region', id: 'key:wrong' }), false);
    assert.deepEqual(legacyToCanonical({ x: 2017, y: 1512 }), { x: 2048, y: 1536 });
    assert.deepEqual(scaleMapPoint({ x: 100, y: 200 }), { x: 100, y: 200 });
});

test('map nodes stay inside the canonical map and connections are symmetric', () => {
    const image = locations.image;
    assert.equal(image.width, CANONICAL_MAP.width);
    assert.equal(image.height, CANONICAL_MAP.height);
    assert.equal(image.sourceWidth, CANONICAL_MAP.sourceWidth);
    assert.equal(image.sourceHeight, CANONICAL_MAP.sourceHeight);

    for (const location of locations.locations) {
        assert.equal(isCoordinateInImage(location.x, location.y, image), true, location.id);
        assert.equal(getLocation(locations, location.id).id, location.id);
        assert.ok(getDistrict(districts, location.districtId), `${location.id} district`);
        assert.equal(typeof location.virtual, 'boolean', location.id);
        assert.ok(
            location.mapRef !== null || location.virtual === true,
            `${location.id} needs a mapRef or virtual: true`,
        );
        if (location.mapRef !== null) {
            assert.equal(isValidMapRef(location.mapRef), true, location.id);
            assert.equal(location.virtual, false, location.id);
        }
        for (const connected of getConnectedLocations(locations, location.id)) {
            assert.equal(
                connected.connections.includes(location.id),
                true,
                `${location.id} <-> ${connected.id} must be symmetric`,
            );
        }
    }

    assert.equal(areLocationsAdjacent(locations, 'central-plaza', 'petrabyte-tower'), true);
    assert.equal(areLocationsAdjacent(locations, 'central-plaza', 'neon-docks'), false);
    assert.ok(distanceBetween(
        getLocation(locations, 'central-plaza'),
        getLocation(locations, 'petrabyte-tower'),
    ) > 0);
});

test('validators reject broken references, coordinates, and beat deadlines', () => {
    const brokenRoster = clone(seasons.s1);
    brokenRoster.roster[0].characterId = 's1.does.not.exist';
    assert.equal(validateSeasonDefinition(brokenRoster, context).ok, false);

    const brokenFaction = clone(seasons.s1);
    brokenFaction.factions[0].id = 'does-not-exist';
    assert.equal(validateSeasonDefinition(brokenFaction, context).ok, false);

    const brokenLocation = clone(seasons.s1);
    brokenLocation.startLocationId = 'nowhere';
    assert.equal(validateSeasonDefinition(brokenLocation, context).ok, false);

    const brokenThreat = clone(seasons.s4);
    brokenThreat.threats[0].sourceFactionId = 'not-a-faction';
    assert.equal(validateSeasonDefinition(brokenThreat, context).ok, false);

    const brokenBeat = clone(seasons.s1);
    brokenBeat.canonBeats[0].conditions.locationIds = ['nowhere'];
    assert.equal(validateSeasonDefinition(brokenBeat, context).ok, false);

    const noDeadline = clone(seasons.s1.canonBeats[0]);
    noDeadline.deadlineTurns = null;
    noDeadline.deadlineDate = null;
    assert.equal(validateBeat(noDeadline, 's1').ok, false);

    const duplicateBeat = clone(seasons.s1.canonBeats.slice(0, 2));
    duplicateBeat[1].id = duplicateBeat[0].id;
    assert.equal(validateBeats(duplicateBeat, { seasonId: 's1' }).ok, false);

    const darkBroken = clone(seasons.s1dark);
    darkBroken.defaultPlayerCharacterId = null;
    assert.equal(validateSeasonDefinition(darkBroken, context).ok, false);

    const badCoordinates = clone(locations);
    badCoordinates.locations[0].x = 5000;
    assert.equal(validateLocations(badCoordinates).ok, false);

    const badFactions = clone(factions);
    badFactions.factions.push(clone(badFactions.factions[0]));
    assert.equal(validateFactions(badFactions).ok, false);

    const locationIds = new Set(locations.locations.map((location) => location.id));
    const factionIds = new Set(factions.factions.map((faction) => faction.id));

    const badFactionHq = clone(factions);
    badFactionHq.factions[0].headquartersLocationId = 'nowhere';
    assert.equal(validateFactions(badFactionHq, { locationIds }).ok, false);

    const badLocationFaction = clone(locations);
    badLocationFaction.locations[0].factionId = 'nowhere';
    assert.equal(validateLocations(badLocationFaction, { factionIds }).ok, false);

    const badLocationDistrict = clone(locations);
    badLocationDistrict.locations[0].districtId = 'nowhere';
    assert.equal(
        validateLocations(badLocationDistrict, {
            factionIds,
            districtIds: new Set(districts.districts.map((district) => district.id)),
        }).ok,
        false,
    );

    const badLocationMapRef = clone(locations);
    badLocationMapRef.locations[0].mapRef = { layer: 'region', id: 'key:wrong' };
    assert.equal(validateLocations(badLocationMapRef).ok, false);

    const badLocationUnbound = clone(locations);
    badLocationUnbound.locations[0].mapRef = null;
    badLocationUnbound.locations[0].virtual = false;
    assert.equal(validateLocations(badLocationUnbound).ok, false);

    const badDistrict = clone(districts);
    badDistrict.districts[0].regionLabels = ['Center'];
    badDistrict.districts[1].regionLabels = ['Center'];
    assert.equal(validateDistricts(badDistrict).ok, false);

    const overrideContext = {
        districtIds: new Set(districts.districts.map((district) => district.id)),
        locationIds: new Set(locations.locations.map((location) => location.id)),
        districts,
        locations,
        regionLabels: new Set(districts.districts.flatMap((district) => district.regionLabels)),
    };
    const badOverrides = clone(mapOverrides);
    badOverrides.keyLocations.CityCore.locationId = 'nowhere';
    assert.equal(validateMapOverrides(badOverrides, overrideContext).ok, false);

    const duplicateLocationOverride = clone(mapOverrides);
    duplicateLocationOverride.keyLocations.HomeA.locationId = 'central-plaza';
    assert.equal(validateMapOverrides(duplicateLocationOverride, overrideContext).ok, false);

    const brokenRoundTrip = clone(mapOverrides);
    brokenRoundTrip.keyLocations.CityCore.locationId = 'petrabyte-tower';
    assert.equal(validateMapOverrides(brokenRoundTrip, overrideContext).ok, false);

    const missingRegionOverride = clone(mapOverrides);
    delete missingRegionOverride.regions.Center;
    assert.equal(validateMapOverrides(missingRegionOverride, overrideContext).ok, false);

    const badCrossFileSeason = clone(seasons.s1);
    assert.equal(
        validateSeasonDefinition(badCrossFileSeason, {
            registry,
            factions: badFactionHq,
            locations,
        }).ok,
        false,
    );
    assert.equal(
        validateSeasonDefinition(badCrossFileSeason, {
            registry,
            factions,
            locations: badLocationFaction,
        }).ok,
        false,
    );
});

test('loaders fail cleanly on HTTP errors', async () => {
    const failingFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

    clearSeasonsCache();
    await assert.rejects(() => loadSeason('s2', { fetchImpl: failingFetch }), /HTTP 503/);
    clearSeasonsCache();

    clearFactionsCache();
    await assert.rejects(() => loadFactions({ fetchImpl: failingFetch }), /HTTP 503/);
    clearFactionsCache();

    clearLocationsCache();
    await assert.rejects(() => loadLocations({ fetchImpl: failingFetch }), /HTTP 503/);
    clearLocationsCache();

    clearMapCaches();
    await assert.rejects(() => loadDistricts({ fetchImpl: failingFetch }), /HTTP 503/);
    await assert.rejects(() => loadMapOverrides({ fetchImpl: failingFetch }), /HTTP 503/);
    clearMapCaches();
});

test('faction, location, district, and map-override loaders validate and cache', async () => {
    clearFactionsCache();
    const loadedFactions = await loadFactions({ fetchImpl: fileFetch });
    assert.equal(loadedFactions.factions.length, factions.factions.length);
    assert.equal(getFaction(loadedFactions, 'petrabyte').name, 'PetraByte');

    clearMapCaches();
    const loadedDistricts = await loadDistricts({ fetchImpl: fileFetch });
    assert.equal(loadedDistricts.districts.length, districts.districts.length);
    const loadedOverrides = await loadMapOverrides({ fetchImpl: fileFetch });
    assert.equal(Object.keys(loadedOverrides.keyLocations).length, 22);

    clearLocationsCache();
    const loadedLocations = await loadLocations({
        fetchImpl: fileFetch,
        context: { districtIds: new Set(loadedDistricts.districts.map((district) => district.id)) },
    });
    assert.equal(loadedLocations.locations.length, locations.locations.length);
    assert.equal(getLocation(loadedLocations, 'central-plaza').district, 'Downtown');
    assert.equal(getLocation(loadedLocations, 'central-plaza').districtId, 'downtown');
});

test('beat ledger helpers enforce monotonic status transitions and eligibility', () => {
    assert.equal(canTransitionBeat('open', 'resolved'), true);
    assert.equal(canTransitionBeat('resolved', 'open'), false);
    assert.equal(canTransitionBeat('adapted', 'deferred'), false);
    assert.equal(canTransitionBeat('deferred', 'open'), true);
    assert.equal(nextBeatStatus('open', 'adapted'), 'adapted');
    assert.throws(() => nextBeatStatus('short-circuited', 'open'), /Illegal beat status transition/);
    assert.throws(() => nextBeatStatus('open', 'bogus'), /Unknown beat status/);

    const s1 = seasons.s1;
    const byAct = listBeatsByAct(s1.canonBeats);
    assert.equal(byAct.opening.length, 2);
    assert.equal(byAct.climax.length, 1);

    const open = getOpenBeats(s1.canonBeats, {
        's1.opening.arms-deal': { status: 'resolved' },
        's1.opening.beast-rumors': { status: 'deferred' },
    }, 'opening');
    assert.deepEqual(open.map((beat) => beat.id), ['s1.opening.beast-rumors']);

    const beat = s1.canonBeats[0];
    assert.equal(isBeatEligible(beat, { turn: 5, statuses: {} }), true);
    assert.equal(isBeatEligible(beat, { turn: 50, statuses: {} }), false);

    assert.equal(
        isBeatCompleted(beat, { recentEvents: [{ tags: ['arms-deal'] }] }),
        true,
    );
    assert.equal(
        isBeatCompleted(beat, { recentEvents: [{ tags: ['something-else'] }] }),
        false,
    );

    const conversion = s1.canonBeats.find((candidate) => candidate.id === 's1.escalation.first-conversion');
    assert.equal(
        isBeatCompleted(conversion, {
            characters: {
                's1.aurelia.longshot': { formId: 's1.redraw.corrupted.longshot' },
            },
        }),
        true,
    );
});

test('map coordinate spike --check passes without touching locations.json', () => {
    const before = readFileSync(join(ROOT, 'data', 'locations.json'), 'utf8');
    const result = spawnSync(process.execPath, ['tools/map-coords.mjs', '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK: \d+ locations/);
    assert.equal(readFileSync(join(ROOT, 'data', 'locations.json'), 'utf8'), before);
});
