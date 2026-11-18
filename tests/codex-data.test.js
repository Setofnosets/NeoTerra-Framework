import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCodexData } from '../src/ui/codex-data.js';
import { clearFormsCache, loadFormRules } from '../src/data/forms.js';
import { clearProfilesCache, loadProfiles } from '../src/data/profiles.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const s1 = readJson('data/seasons/s1.json');
const profileArtifact = readJson('data/characters/profiles.json');

// The roster slice season start writes for S1: ten castable cards.
const slice = {
    entries: registry.entries.filter((entry) => entry.seasonId === 's1' && entry.bundle !== true),
};

function jsonFetch(body) {
    return async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
}

const okGroups = async () => formGroups;

test('loadProfiles validates the envelope and caches the map', async () => {
    clearProfilesCache();
    const profiles = await loadProfiles({ fetchImpl: jsonFetch(profileArtifact) });
    assert.match(profiles['s1.vaiva.colorgarde'].appearance, /captivating/);

    const cached = await loadProfiles({
        fetchImpl: async () => {
            throw new Error('network used');
        },
    });
    assert.equal(cached, profiles);

    clearProfilesCache();
    await assert.rejects(
        loadProfiles({
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ schemaVersion: 2, profiles: {} }),
            }),
        }),
        /schemaVersion must be 1/,
    );
    clearProfilesCache();
    await assert.rejects(
        loadProfiles({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
        /HTTP 404/,
    );
    clearProfilesCache();
});

test('a chat slice loads the global form rules without id cross-validation', async () => {
    clearFormsCache();
    assert.equal(slice.entries.length, 10);

    const data = await loadCodexData({
        metadata: {
            neoterra: { seasonDefinition: s1, registry: slice },
        },
        loadFullRegistry: async () => {
            throw new Error('full registry must not be loaded for a season slice');
        },
        loadFormGroups: okGroups,
        loadFormRules: () => loadFormRules({ fetchImpl: jsonFetch(formRules) }),
        loadProfiles: async () => ({ 's1.vaiva.colorgarde': { name: 'Vaiva' } }),
    });

    assert.equal(data.registry, slice);
    assert.equal(data.season, s1);
    assert.deepEqual(data.formRules, formRules);
    assert.deepEqual(data.formGroups, formGroups);
    assert.deepEqual(data.profiles, { 's1.vaiva.colorgarde': { name: 'Vaiva' } });
    clearFormsCache();
});

test('registry id validation is opt-in and rejects a chat slice', async () => {
    clearFormsCache();
    await assert.rejects(
        loadFormRules({
            fetchImpl: jsonFetch(formRules),
            registry: slice,
            validateRegistryIds: true,
        }),
        /loadFormRules: invalid form rules .*unresolved registry id/,
    );
    clearFormsCache();

    // The complete registry still passes the opt-in check.
    const rules = await loadFormRules({
        fetchImpl: jsonFetch(formRules),
        registry,
        validateRegistryIds: true,
    });
    assert.equal(rules.rules.length, formRules.rules.length);

    // Asking for id resolution without a registry must not silently pass.
    await assert.rejects(
        loadFormRules({ fetchImpl: jsonFetch(formRules), validateRegistryIds: true }),
        /validateRegistryIds requires the complete character registry/,
    );
    clearFormsCache();
});

test('malformed rules and failed fetches still reject', async () => {
    clearFormsCache();
    await assert.rejects(
        loadFormRules({
            fetchImpl: jsonFetch({ schemaVersion: 1, rules: 'not-an-array' }),
        }),
        /loadFormRules: invalid form rules .*rules.*must be an array/,
    );
    clearFormsCache();

    await assert.rejects(
        loadFormRules({
            fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
        }),
        /HTTP 404/,
    );
    clearFormsCache();
});

test('no slice falls back to the full registry and a failed profile loader degrades to {}', async () => {
    clearFormsCache();
    let fullRegistryCalls = 0;
    let ruleCallArgs = null;

    const data = await loadCodexData({
        metadata: {
            neoterra: { seasonDefinition: s1, registry: { entries: [] } },
        },
        loadFullRegistry: async () => {
            fullRegistryCalls += 1;
            return registry;
        },
        loadFormGroups: okGroups,
        loadFormRules: (...args) => {
            ruleCallArgs = args;
            return Promise.resolve(formRules);
        },
        loadProfiles: async () => {
            throw new Error('profiles.json is missing');
        },
    });

    assert.equal(fullRegistryCalls, 1);
    assert.equal(data.registry, registry);
    assert.deepEqual(data.profiles, {});
    assert.deepEqual(ruleCallArgs, [], 'form rules must load without a registry');
    clearFormsCache();
});

test('sandbox seasons use the full registry even when a roster slice exists', async () => {
    const sandbox = readJson('data/seasons/sandbox.json');
    const data = await loadCodexData({
        metadata: {
            neoterra: { seasonDefinition: sandbox, registry: slice },
        },
        loadFullRegistry: async () => registry,
        loadFormGroups: okGroups,
        loadFormRules: async () => formRules,
    });

    assert.equal(data.registry, registry);
    assert.deepEqual(data.profiles, {});
});
