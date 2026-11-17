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
const context = { registry, factions, locations };
const registryIndex = buildRegistryIndex(registry);
const factionIndex = buildFactionIndex(factions);

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
        assert.ok(locations.locations.some((location) => location.id === season.startLocationId), id);

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

test('map nodes stay inside the image and connections are symmetric', () => {
    const image = locations.image;
    assert.equal(image.width, 2017);
    assert.equal(image.height, 1512);

    for (const location of locations.locations) {
        assert.equal(isCoordinateInImage(location.x, location.y, image), true, location.id);
        assert.equal(getLocation(locations, location.id).id, location.id);
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
});

test('faction and location loaders validate and cache', async () => {
    clearFactionsCache();
    const loadedFactions = await loadFactions({ fetchImpl: fileFetch });
    assert.equal(loadedFactions.factions.length, factions.factions.length);
    assert.equal(getFaction(loadedFactions, 'petrabyte').name, 'PetraByte');

    clearLocationsCache();
    const loadedLocations = await loadLocations({ fetchImpl: fileFetch });
    assert.equal(loadedLocations.locations.length, locations.locations.length);
    assert.equal(getLocation(loadedLocations, 'central-plaza').district, 'Downtown');
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
