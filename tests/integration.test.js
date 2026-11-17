import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildWorldBundle,
    buildCardImportOverrides,
    normalizeWorldBundle,
    writeWorldBundleToMetadata,
} from '../src/ui/settings.js';
import { createEmptyWorldState, validateWorldState } from '../src/state/world-state.js';

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
    ]) {
        assert.equal(existsSync(join(ROOT, doc)), true, doc);
    }
    const smoke = run('tools/smoke-test.mjs');
    assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
    assert.match(smoke.stdout, /Smoke test OK/);
});
