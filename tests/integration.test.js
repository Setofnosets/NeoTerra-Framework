import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareGeneratedFile } from '../tools/build-data.mjs';

import {
    buildWorldBundle,
    buildCardImportOverrides,
    normalizeWorldBundle,
    writeWorldBundleToMetadata,
} from '../src/ui/settings.js';
import { createEmptyWorldState, validateWorldState } from '../src/state/world-state.js';
import { createWorldStateStore } from '../src/state/store.js';
import { buildClockTick, buildClockTurn, advanceClock } from '../src/core/world-clock.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { createWorldTick } from '../src/flows/world-tick.js';
import { analyzePacing } from '../src/flows/pacing.js';
import { editionDue, createNewsroomFlow } from '../src/flows/newsroom.js';
import { applyMapFog } from '../src/data/map.js';
import { buildRelationshipGraph } from '../src/ui/relationship-graph.js';
import { buildDomainView } from '../src/data/domain.js';
import { renderContext } from '../src/context/renderer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function run(script, args = []) {
    return spawnSync(process.execPath, [join(ROOT, script), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120000,
    });
}

test('generated data and the shipped map are current', () => {
    const data = run('tools/build-data.mjs', ['--check']);
    assert.equal(data.status, 0, `${data.stdout}\n${data.stderr}`);
    assert.match(data.stdout, /Registry is up to date/);

    const map = run('tools/build-map.mjs', ['--check']);
    assert.equal(map.status, 0, `${map.stdout}\n${map.stderr}`);
    assert.match(map.stdout, /check passed/);
});

test('a stale generated artifact fails the freshness comparison', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neoterra-profiles-'));
    const file = join(dir, 'profiles.json');
    try {
        writeFileSync(file, '{"profiles":{}}\n');
        const errors = [];
        compareGeneratedFile(file, '{"profiles":{"s1.vaiva.colorgarde":{}}}\n', 'character profiles', errors);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /character profiles out of date; run node tools\/build-data\.mjs/);

        const current = [];
        compareGeneratedFile(file, '{"profiles":{}}\n', 'character profiles', current);
        assert.deepEqual(current, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the season manifest is generated from the season files', () => {
    const index = readJson('data/seasons/index.json');
    const ids = index.seasons.map((entry) => entry.id);
    assert.deepEqual(ids, ['s1', 's1dark', 's2', 's3', 's4', 's5', 'sandbox']);
    const s5 = index.seasons.find((entry) => entry.id === 's5');
    assert.equal(s5.file, 's5.aux.json');
    assert.equal(s5.playable, false);
    assert.equal(index.seasons.filter((entry) => entry.playable).length, 6);
    for (const season of index.seasons) {
        assert.equal(existsSync(join(ROOT, 'data', 'seasons', season.file)), true, season.file);
    }
});

test('the map extraction keeps the canonical counts and graph', () => {
    const map = readJson('data/map/map.json');
    const regions = readJson('data/map/regions.geojson');
    const bridges = readJson('data/map/bridges.geojson');
    const keys = readJson('data/map/key-locations.json');
    assert.deepEqual(map.canvas, { width: 2048, height: 1536 });
    assert.equal(regions.features.length, 36);
    assert.equal(bridges.features.length, 12);
    assert.equal(keys.keyLocations.length, 22);

    const regionIds = new Set(regions.features.map((feature) => feature.id));
    for (const bridge of bridges.features) {
        assert.equal(bridge.connects.length, 2, bridge.id);
        for (const regionId of bridge.connects) {
            assert.equal(regionIds.has(regionId), true, `${bridge.id} -> ${regionId}`);
        }
    }
    for (const key of keys.keyLocations) {
        assert.equal(typeof key.regionId, 'string');
    }
});

test('a world bundle round-trips into another chat', () => {
    const state = createEmptyWorldState({ chatId: 'source-chat' });
    state.meta.turn = 7;
    state.recentEvents.push({
        turn: 7,
        date: '2043-01-01',
        summary: 'A test event',
        actors: [],
        locationId: null,
        tags: ['test'],
    });
    assert.equal(validateWorldState(state).ok, true);

    const metadata = {
        neoterra: {
            schemaVersion: 1,
            seasonId: 'sandbox',
            seasonDefinition: readJson('data/seasons/sandbox.json'),
            registry: { entries: [] },
            castMode: 'director',
            playerIdentity: { identity: 'custom' },
            worldBook: { name: 'Neo Terra — Sandbox — source-chat' },
            worldState: state,
        },
    };
    const bundle = buildWorldBundle(metadata, { now: Date.UTC(2026, 10, 17) });
    const json = JSON.stringify(bundle);

    const target = { neoterra: {} };
    writeWorldBundleToMetadata(target, JSON.parse(json), { chatId: 'target-chat', now: 99 });

    assert.equal(target.neoterra.worldState.chatId, 'target-chat');
    assert.equal(target.neoterra.worldState.meta.turn, 7);
    assert.equal(target.neoterra.worldState.recentEvents.at(-1).summary, 'A test event');
    assert.equal(
        target.neoterra.worldBook.name,
        'Neo Terra — Sandbox — Neo Terra Free Play — target-chat',
    );
    assert.equal(target.neoterra.castMode, 'director');
    assert.equal(target.neoterra.playerIdentity.identity, 'custom');
    // The source document must not be mutated by export or import.
    assert.equal(metadata.neoterra.worldState.chatId, 'source-chat');

    const again = normalizeWorldBundle(JSON.parse(json), { chatId: 'third-chat' });
    assert.equal(again.worldState.chatId, 'third-chat');
});

test('world import rejects wrong kinds and future schemas', () => {
    assert.throws(() => normalizeWorldBundle({ kind: 'something-else' }), /Not a Neo Terra world bundle/);
    const state = createEmptyWorldState({ chatId: 'a' });
    assert.throws(
        () => normalizeWorldBundle({ kind: 'neoterra-world', schemaVersion: 99, worldState: state }),
        /newer than this extension supports/,
    );
    assert.throws(
        () => normalizeWorldBundle({ kind: 'neoterra-world', schemaVersion: 1 }),
        /no worldState/,
    );
    assert.throws(
        () => normalizeWorldBundle({ kind: 'neoterra-world', worldState: state }),
        /integer schemaVersion/,
    );
});

test('dropped cards generate mergeable registry overrides', () => {
    const existing = {
        schemaVersion: 1,
        entries: {
            'Chars/S4/Old Hero.json': { id: 's4.old.hero', displayName: 'Old Hero' },
        },
    };
    const { overrides, report } = buildCardImportOverrides([
        { name: 'New Hero (Corrupted).json', data: { name: 'New Hero' } },
        { name: 'Broken.json', data: null },
    ], {
        seasonId: 's4',
        existingOverrides: existing,
    });

    assert.equal(overrides.entries['Chars/S4/Old Hero.json'].displayName, 'Old Hero');
    assert.deepEqual(overrides.entries['Chars/S4/New Hero (Corrupted).json'], {
        id: 's4.new.hero.corrupted',
        displayName: 'New Hero',
    });
    assert.equal(report.added.length, 1);
    assert.equal(report.invalid.length, 1);
    assert.match(report.invalid[0].reason, /data\{\}/);

    const again = buildCardImportOverrides([
        { name: 'New Hero (Corrupted).json', data: { name: 'New Hero' } },
    ], { seasonId: 's4', existingOverrides: overrides });
    assert.equal(again.report.added.length, 0);
    assert.equal(again.report.skipped.length, 1);
    assert.match(again.report.skipped[0].reason, /already exists/);
});

test('the six living-city features compose on one villain fixture world', async () => {
    const registry = readJson('data/characters/index.json');
    const factions = readJson('data/factions.json');
    const locations = readJson('data/locations.json');
    const districts = readJson('data/districts.json');
    const formGroups = readJson('data/form-groups.json');
    const formRules = readJson('data/form-rules.json');
    const season = readJson('data/seasons/s1dark.json');
    const agendas = readJson('data/agendas.json');
    const chatId = 'integration-living-city';
    const store = createWorldStateStore({
        metadata: {},
        chatId,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: { registry, formGroups, formRules, factions, locations },
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId,
        player: { identity: 'canon' },
        now: 0,
    });
    const tick = createWorldTick({
        store,
        getSeason: () => season,
        getSettings: () => DEFAULT_SETTINGS,
        loadData: async () => ({ agendas, locations }),
        log: () => {},
    });

    // --- clock + tick -----------------------------------------------------
    await tick.run(); // records the baseline only
    const start = store.get();
    assert.equal(start.meta.storyTurn, 0);
    // Drive the production clock builder: one automatic turn plus a four-turn
    // explicit block is exactly one day.
    store.dispatch(buildClockTurn({ state: store.get(), settings: DEFAULT_SETTINGS }));
    store.dispatch(buildClockTick({ state: store.get(), settings: DEFAULT_SETTINGS, turns: 4 }));
    assert.notEqual(store.get().meta.inGameDate, start.meta.inGameDate, 'five slots must cross a day');
    assert.equal(store.get().meta.storyTurn, 5);
    const tickResult = await tick.run();
    assert.equal(tickResult.ran, true);
    assert.ok(tickResult.events.length > 0, 'a full day must move the world');
    assert.equal(store.get().meta.inGameDate, advanceClock({
        date: start.meta.inGameDate,
        timeOfDay: start.meta.timeOfDay,
        turns: 5,
    }).date);

    // --- pacing -----------------------------------------------------------
    const pacing = analyzePacing({ state: store.get(), settings: DEFAULT_SETTINGS });
    assert.ok(['ok', 'nudge', 'cut', 'stalled'].includes(pacing.level));

    // --- time brake -------------------------------------------------------
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'integration' });
    const held = store.get();
    for (let index = 0; index < 10; index += 1) {
        store.dispatch({ type: 'TICK_TIME', turns: 1, storyTurns: 0 });
    }
    const afterHold = store.get();
    assert.equal(afterHold.meta.turn, held.meta.turn + 10);
    assert.equal(afterHold.meta.storyTurn, held.meta.storyTurn);
    assert.equal(afterHold.meta.inGameDate, held.meta.inGameDate);
    assert.equal((await tick.run()).reason, 'time-held');
    const newsSettings = {
        ...DEFAULT_SETTINGS,
        newspaper: { ...DEFAULT_SETTINGS.newspaper, enabled: true },
    };
    assert.equal(editionDue(afterHold, newsSettings).reason, 'time-held');
    const heldPacing = analyzePacing({ state: afterHold, settings: DEFAULT_SETTINGS });
    assert.equal(heldPacing.held, true);
    assert.equal(heldPacing.canCut, false);
    store.dispatch({ type: 'SET_CLOCK_HOLD', active: false, reason: 'integration-release' });

    // --- newspaper --------------------------------------------------------
    store.dispatch({
        type: 'ADD_EVENT',
        summary: 'A patrol sweep closes three streets near the old subway.',
        headline: 'PATROL SWEEP SHUTS DOWNTOWN',
        tags: ['crime', 'faction'],
    });
    const publishSettings = {
        ...newsSettings,
        newspaper: { ...newsSettings.newspaper, minEvents: 1 },
    };
    const newsroom = createNewsroomFlow({
        store,
        getSeason: () => season,
        getSettings: () => publishSettings,
        agent: null,
        now: () => 1,
        log: () => {},
    });
    const report = await newsroom.publish({ chatId });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.edition.source, 'deterministic');
    assert.ok(report.edition.headlines.length >= 1 && report.edition.headlines.length <= 6);
    assert.equal(store.get().flags.newsroom.editions.length, 1);
    // The same in-game date never publishes twice (the second call is a no-op,
    // whether it stops at the cadence or at the date dedupe).
    const duplicate = await newsroom.publish({ chatId });
    assert.equal(duplicate.ok, false);
    assert.ok(['duplicate-date', 'no-events'].includes(duplicate.reason), duplicate.reason);
    assert.equal(store.get().flags.newsroom.editions.length, 1);

    // --- fog --------------------------------------------------------------
    const exploration = store.get().flags.map?.exploration;
    assert.ok(exploration, 'season start seeds exploration');
    assert.ok(Object.values(exploration.regions).some((entry) => entry.state === 'discovered'));
    const fogged = applyMapFog({
        regions: [
            { id: 'region:a', name: 'Alpha', description: 'Visible.' },
            { id: 'region:b', name: 'Beta', description: 'Hidden.' },
        ],
        bridges: [],
        keyLocations: [],
        namedLocations: [],
    }, {
        regions: {
            'region:a': { state: 'discovered' },
            'region:b': { state: 'rumored' },
        },
        keyLocations: {},
        updatedAt: 0,
    }, { mode: 'rumors', showRumoredLabels: true });
    assert.equal(fogged.regions.find((region) => region.id === 'region:a').description, 'Visible.');
    const beta = fogged.regions.find((region) => region.id === 'region:b');
    assert.equal(beta.name, 'Beta');
    assert.equal(beta.description, null);

    // --- relationships ----------------------------------------------------
    store.dispatch({
        type: 'PLAYER_RELATIONSHIP_DELTA',
        withCharacterId: 's1dark.akui.koden.cyber.sakura',
        relationshipType: 'ally',
        affinityDelta: 25,
    });
    const graph = buildRelationshipGraph({ state: store.get(), registry });
    assert.equal(graph.nodes.filter((node) => node.isPlayer).length, 1);
    assert.ok(graph.edges.length >= 1);
    assert.equal(graph.edges[0].type, 'ally');

    // --- domain -----------------------------------------------------------
    const domain = buildDomainView({
        state: store.get(),
        season,
        registry,
        locations,
        districts,
    });
    assert.equal(domain.active, true);
    assert.equal(domain.wonderland.name, 'Wonderland');
    assert.ok(domain.knights.length >= 3);
    assert.ok(domain.resistance.length >= 1);
    assert.ok(domain.territory.counts.districts > 0);
    assert.ok(Array.isArray(domain.feed));

    // --- prompt blocks ----------------------------------------------------
    const rendered = renderContext(store.get(), {
        season,
        registry,
        settings: newsSettings,
    });
    const headings = rendered.blocks.map((block) => block.heading);
    assert.ok(headings.includes('[NEOTERRA_DOMAIN]'), 'domain block expected');
    assert.ok(headings.includes('[NEOTERRA_NEWS]'), 'news block expected');
    assert.match(rendered.text, /Wonderland/);
    assert.match(rendered.text, /PATROL SWEEP/);
});

test('each living-city feature can be switched off without errors', async () => {
    const registry = readJson('data/characters/index.json');
    const factions = readJson('data/factions.json');
    const locations = readJson('data/locations.json');
    const formGroups = readJson('data/form-groups.json');
    const formRules = readJson('data/form-rules.json');
    const season = readJson('data/seasons/s1dark.json');
    const agendas = readJson('data/agendas.json');
    const store = createWorldStateStore({
        metadata: {},
        chatId: 'integration-disable-matrix',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: { registry, formGroups, formRules, factions, locations },
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'integration-disable-matrix',
        player: { identity: 'canon' },
        now: 0,
    });
    store.dispatch({ type: 'TICK_TIME', turns: 1, storyTurns: 1 });
    const off = {
        ...DEFAULT_SETTINGS,
        clock: { ...DEFAULT_SETTINGS.clock, enabled: false },
        worldTick: { ...DEFAULT_SETTINGS.worldTick, enabled: false },
        pacing: { ...DEFAULT_SETTINGS.pacing, enabled: false },
        newspaper: { ...DEFAULT_SETTINGS.newspaper, enabled: false },
        map: { ...DEFAULT_SETTINGS.map, showFogOfWar: false },
    };
    const state = store.get();

    // Clock off: a V1 tick carries no date/slot, and story turns follow turns.
    const clockEvent = buildClockTurn({ state, settings: off });
    assert.equal(clockEvent.type, 'TICK_TIME');
    assert.equal(clockEvent.date, undefined);
    assert.equal(clockEvent.storyTurns, undefined);

    const tick = createWorldTick({
        store,
        getSeason: () => season,
        getSettings: () => off,
        loadData: async () => ({ agendas, locations }),
        log: () => {},
    });
    assert.equal((await tick.run()).reason, 'disabled');

    assert.equal(analyzePacing({ state, settings: off }).reason, 'disabled');
    assert.equal(editionDue(state, off).reason, 'disabled');

    const vm = {
        regions: [{ id: 'region:a', name: 'Alpha' }],
        bridges: [],
        keyLocations: [],
        namedLocations: [],
    };
    const exploration = { regions: { 'region:a': { state: 'discovered' } }, keyLocations: {}, updatedAt: 0 };
    assert.equal(applyMapFog(vm, exploration, { enabled: false }), vm);

    // The graph is always available and read-only; the domain is season-gated.
    assert.equal(buildRelationshipGraph({ state, registry }).empty, false);
    assert.equal(buildDomainView({
        state,
        season: { ...season, playerRole: 'hero' },
        registry,
        locations,
    }).active, false);
});

test('release docs and smoke-test inputs are present', () => {
    for (const doc of [
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
        'docs/data-schema.md',
        'docs/adding-a-season.md',
        'docs/canon-beats.md',
        'docs/endings.md',
        'docs/bad-ends.md',
        'docs/cyoa.md',
        'docs/map-authoring.md',
        'docs/world-clock.md',
        'docs/world-tick.md',
        'docs/newspaper.md',
        'docs/pacing.md',
        'docs/fog-of-war.md',
        'docs/relationships.md',
        'docs/sensorium.md',
    ]) {
        assert.equal(existsSync(join(ROOT, doc)), true, doc);
    }
    const smoke = run('tools/smoke-test.mjs');
    assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
    assert.match(smoke.stdout, /Smoke test OK/);
});
