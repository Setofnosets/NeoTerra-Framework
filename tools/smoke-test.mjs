#!/usr/bin/env node
/**
 * Release smoke test.
 *
 * Verifies the shipped layout, manifest, generated counts, season manifest,
 * docs, and that tracked files contain no local absolute paths. It is read-only
 * and safe to run from CI or a clean clone.
 *
 * Usage: node tools/smoke-test.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_FILES = [
    'manifest.json',
    'index.js',
    'style.css',
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    '.gitignore',
    'NeoTerra.png',
    'NeoTerra.svg',
    'NeoTerra_Districts.svg',
    'NeoTerra_Bridges.svg',
    'NeoTerra_Locs.svg',
    'data/characters/index.json',
    'data/characters/overrides.json',
    'data/seasons/index.json',
    'data/locations.json',
    'data/districts.json',
    'data/factions.json',
    'data/form-groups.json',
    'data/form-rules.json',
    'data/map/map.json',
    'data/map/regions.geojson',
    'data/map/bridges.geojson',
    'data/map/key-locations.json',
    'data/map/overrides.json',
    'data/map/report.json',
    'docs/data-schema.md',
    'docs/adding-a-season.md',
    'docs/canon-beats.md',
    'docs/endings.md',
    'docs/bad-ends.md',
    'docs/cyoa.md',
    'docs/map-authoring.md',
    'tools/build-data.mjs',
    'tools/build-map.mjs',
    'tools/map-coords.mjs',
    'vendor/leaflet/leaflet.js',
    'vendor/leaflet/leaflet.css',
    'vendor/leaflet/LICENSE',
    'vendor/leaflet/VERSION',
];

const REQUIRED_SEASONS = ['s1', 's1dark', 's2', 's3', 's4', 'sandbox', 's5'];
const PLAYABLE_SEASONS = ['s1', 's1dark', 's2', 's3', 's4', 'sandbox'];

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function fail(errors, message) {
    errors.push(message);
}

function checkFiles(errors) {
    for (const file of REQUIRED_FILES) {
        if (!existsSync(join(ROOT, file))) {
            fail(errors, `missing required file: ${file}`);
        }
    }
}

function checkManifest(errors) {
    const manifest = readJson('manifest.json');
    const pkg = readJson('package.json');
    for (const field of ['display_name', 'version', 'js', 'css', 'loading_order', 'minimum_client_version', 'homePage']) {
        if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
            fail(errors, `manifest.json: missing ${field}`);
        }
    }
    if (manifest.js !== 'index.js' || manifest.css !== 'style.css') {
        fail(errors, 'manifest.json: js/css must point at index.js and style.css');
    }
    if (manifest.minimum_client_version !== '1.19.0') {
        fail(errors, `manifest.json: minimum_client_version must be 1.19.0 (found ${manifest.minimum_client_version})`);
    }
    if (manifest.homePage !== 'https://github.com/Setofnosets/NeoTerra-Framework') {
        fail(errors, 'manifest.json: homePage must point at the public repository');
    }
    if (manifest.auto_update !== false) {
        fail(errors, 'manifest.json: auto_update must be false');
    }
    if (String(manifest.version) !== String(pkg.version)) {
        fail(errors, `manifest/package version mismatch (${manifest.version} vs ${pkg.version})`);
    }
    if (!pkg.scripts || !pkg.scripts['build:data'] || !pkg.scripts['build:map'] || !pkg.scripts.check) {
        fail(errors, 'package.json: build:data, build:map, and check scripts are required');
    }
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        fail(errors, 'package.json: runtime dependencies must stay empty');
    }
}

function checkRegistry(errors) {
    const registry = readJson('data/characters/index.json');
    if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
        fail(errors, 'registry has no entries');
        return;
    }
    const ids = new Set();
    for (const entry of registry.entries) {
        if (ids.has(entry.id)) {
            fail(errors, `registry duplicate id: ${entry.id}`);
        }
        ids.add(entry.id);
        if (!entry.id.startsWith(`${entry.seasonId}.`)) {
            fail(errors, `registry id ${entry.id} does not start with its season`);
        }
    }
    if (registry.counts?.total !== registry.entries.length) {
        fail(errors, 'registry counts.total does not match entries.length');
    }
}

function checkSeasons(errors) {
    const index = readJson('data/seasons/index.json');
    const files = readdirSync(join(ROOT, 'data', 'seasons'))
        .filter((name) => name.endsWith('.json') && name !== 'index.json');
    const ids = new Set();
    for (const entry of index.seasons ?? []) {
        ids.add(entry.id);
        if (!entry.file || !files.includes(entry.file)) {
            fail(errors, `season index references missing file for "${entry.id}"`);
        }
    }
    for (const id of REQUIRED_SEASONS) {
        if (!ids.has(id)) {
            fail(errors, `season index missing "${id}"`);
        }
    }
    for (const id of PLAYABLE_SEASONS) {
        const entry = (index.seasons ?? []).find((candidate) => candidate.id === id);
        if (!entry?.playable) {
            fail(errors, `season "${id}" must be playable`);
        }
    }
    const s5 = (index.seasons ?? []).find((candidate) => candidate.id === 's5');
    if (s5?.playable !== false) {
        fail(errors, 'season s5 must remain non-playable in V1');
    }
    if (files.length !== (index.seasons ?? []).length) {
        fail(errors, 'data/seasons contains files that are not in the generated index');
    }
}

function checkMap(errors) {
    const map = readJson('data/map/map.json');
    const regions = readJson('data/map/regions.geojson');
    const bridges = readJson('data/map/bridges.geojson');
    const keys = readJson('data/map/key-locations.json');
    if (map.canvas?.width !== 2048 || map.canvas?.height !== 1536) {
        fail(errors, 'map canvas must be 2048x1536');
    }
    if (map.counts?.districts !== 36 || regions.features?.length !== 36) {
        fail(errors, `expected 36 districts (map=${map.counts?.districts}, file=${regions.features?.length})`);
    }
    if (map.counts?.bridges !== 12 || bridges.features?.length !== 12) {
        fail(errors, `expected 12 bridges (map=${map.counts?.bridges}, file=${bridges.features?.length})`);
    }
    if (map.counts?.keyLocations !== 22 || keys.keyLocations?.length !== 22) {
        fail(errors, `expected 22 key locations (map=${map.counts?.keyLocations}, file=${keys.keyLocations?.length})`);
    }
    const regionIds = new Set((regions.features ?? []).map((feature) => feature.id));
    for (const feature of bridges.features ?? []) {
        for (const regionId of feature.connects ?? []) {
            if (!regionIds.has(regionId)) {
                fail(errors, `bridge ${feature.id} connects unknown region ${regionId}`);
            }
        }
    }
}

function checkLicense(errors) {
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    if (!/^MIT License/m.test(license) || !/Copyright/i.test(license)) {
        fail(errors, 'LICENSE must contain the MIT license and a copyright line');
    }
}

function checkTrackedPaths(errors) {
    const result = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
        console.log('  (git unavailable; skipping tracked-path scan)');
        return;
    }
    const files = result.stdout.split(/\r?\n/).filter(Boolean);
    const suspicious = /(^|["'\s])(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/home\/|\/Users\/)/;
    const textExtensions = /\.(?:js|mjs|json|md|css|html|txt|yml|yaml|svg)$/i;
    for (const file of files) {
        if (!textExtensions.test(file)) {
            continue;
        }
        let text = '';
        try {
            text = readFileSync(join(ROOT, file), 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split(/\r?\n/)) {
            if (suspicious.test(line)) {
                fail(errors, `${file}: contains a local absolute path`);
                break;
            }
        }
    }
    for (const ignored of ['data/locations.draft.json', 'NeoTerra_backup.svg', 'plans/briefs/']) {
        if (files.includes(ignored)) {
            fail(errors, `${ignored} must not be tracked`);
        }
    }
}

export function runSmokeTest() {
    const errors = [];
    checkFiles(errors);
    if (errors.length === 0) {
        checkManifest(errors);
        checkRegistry(errors);
        checkSeasons(errors);
        checkMap(errors);
        checkLicense(errors);
        checkTrackedPaths(errors);
    }
    return { ok: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { ok, errors } = runSmokeTest();
    if (!ok) {
        for (const error of errors) {
            console.error(`[smoke] ${error}`);
        }
        process.exitCode = 1;
    } else {
        console.log('Smoke test OK: layout, manifest, registry, seasons, map, docs, license, and tracked paths.');
        console.log(`  files checked: ${REQUIRED_FILES.length}`);
        console.log(`  seasons: ${REQUIRED_SEASONS.join(', ')}`);
        console.log('  map: 36 districts / 12 bridges / 22 key locations');
    }
}
