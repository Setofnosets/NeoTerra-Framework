import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AGENDAS_URL,
    DEFAULT_AGENDAS,
    clearAgendasCache,
    formatTemplate,
    loadAgendas,
    pickDeterministic,
    resolveAgenda,
    validateAgendas,
} from '../src/data/agendas.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const agendas = readJson('data/agendas.json');
const seasonIndex = readJson('data/seasons/index.json');
const seasonFiles = Object.fromEntries(seasonIndex.seasons.map((entry) => [entry.id, entry.file]));

const NUMERIC_DEFAULTS = [
    'factionInfluencePerDay',
    'mainThreatProgressPerDay',
    'secondaryThreatProgressPerDay',
    'maxFactionDeltaPerTick',
    'maxNpcMovesPerTick',
    'maxDaysPerTick',
    'rumorsPerTick',
];

const INTEGER_DEFAULTS = [
    'maxFactionDeltaPerTick',
    'maxNpcMovesPerTick',
    'maxDaysPerTick',
    'rumorsPerTick',
];

const ALLOWED_PLACEHOLDERS = new Set(['faction', 'location', 'threat']);

function placeholders(template) {
    return [...template.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]);
}

function allTemplates(document) {
    const templates = [...(document.defaults?.rumorTemplates ?? [])];
    for (const season of Object.values(document.seasons ?? {})) {
        if (Array.isArray(season?.rumorTemplates)) {
            templates.push(...season.rumorTemplates);
        }
    }
    return templates;
}

test('the committed agenda document is valid', () => {
    const validation = validateAgendas(agendas);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    assert.equal(AGENDAS_URL instanceof URL, true);
});

test('every numeric default is finite and non-negative; integer defaults are integers', () => {
    for (const key of NUMERIC_DEFAULTS) {
        const value = agendas.defaults[key];
        assert.equal(Number.isFinite(value), true, `${key} must be finite`);
        assert.ok(value >= 0, `${key} must be >= 0`);
    }
    for (const key of INTEGER_DEFAULTS) {
        assert.equal(Number.isInteger(agendas.defaults[key]), true, `${key} must be an integer`);
    }
    assert.ok(agendas.defaults.maxDaysPerTick >= 1);
    assert.ok(Array.isArray(agendas.defaults.rumorTemplates));
    assert.ok(agendas.defaults.rumorTemplates.length > 0);
});

test('every agenda season and cross-reference exists in the authored season data', () => {
    for (const seasonId of Object.keys(agendas.seasons)) {
        const file = seasonFiles[seasonId];
        assert.ok(file, `agenda season "${seasonId}" is missing from data/seasons/index.json`);
        assert.notEqual(seasonId, 's5', 'the auxiliary s5 entry is not a playable season');

        const season = readJson(join('data', 'seasons', file));
        const factionIds = new Set((season.factions ?? []).map((faction) => faction.id));
        const threatIds = new Set((season.threats ?? []).map((threat) => threat.id));
        const agenda = agendas.seasons[seasonId];

        for (const factionId of Object.keys(agenda.factionAgendas ?? {})) {
            assert.ok(
                factionIds.has(factionId),
                `agenda "${seasonId}" references unknown faction "${factionId}"`,
            );
        }
        for (const threatId of Object.keys(agenda.threatPace ?? {})) {
            assert.ok(
                threatIds.has(threatId),
                `agenda "${seasonId}" references unknown threat "${threatId}"`,
            );
        }
        for (const [factionId, entry] of Object.entries(agenda.factionAgendas ?? {})) {
            if (entry.rumorTags !== undefined) {
                assert.ok(
                    Array.isArray(entry.rumorTags)
                    && entry.rumorTags.every((tag) => typeof tag === 'string'),
                    `${seasonId}.${factionId}.rumorTags must be strings`,
                );
            }
        }
    }
});

test('every rumor template uses only the allowed placeholders', () => {
    for (const template of allTemplates(agendas)) {
        assert.equal(typeof template, 'string');
        assert.ok(template.trim().length > 0);
        for (const placeholder of placeholders(template)) {
            assert.ok(
                ALLOWED_PLACEHOLDERS.has(placeholder),
                `template uses unknown placeholder "{${placeholder}}"`,
            );
        }
    }
});

test('formatTemplate fills known placeholders, keeps unknown braces, and collapses whitespace', () => {
    assert.equal(
        formatTemplate('Meet {faction} in {location} about {threat}.', {
            faction: 'Clarity',
            location: 'Neon Docks',
            threat: 'the cold',
        }),
        'Meet Clarity in Neon Docks about the cold.',
    );
    assert.equal(
        formatTemplate('A {mystery} at {location}', { location: 'Rust Yard' }),
        'A {mystery} at Rust Yard',
    );
    assert.equal(formatTemplate('  a\n  b\t c  ', {}), 'a b c');
    assert.equal(formatTemplate(null, {}), '');
});

test('pickDeterministic is stable, in range, and null for empty input', () => {
    const list = ['a', 'b', 'c', 'd'];
    assert.equal(pickDeterministic([], 'seed'), null);
    assert.equal(pickDeterministic(null, 'seed'), null);
    for (let index = 0; index < 20; index += 1) {
        const seed = `seed-${index}`;
        const first = pickDeterministic(list, seed);
        assert.equal(pickDeterministic(list, seed), first);
        assert.ok(list.includes(first));
    }
});

test('resolveAgenda merges defaults and never throws on missing or unknown seasons', () => {
    const missing = resolveAgenda(null, 's1');
    assert.deepEqual(missing.defaults, DEFAULT_AGENDAS);
    assert.deepEqual(missing.season, {});
    assert.deepEqual(missing.factionAgendas, {});
    assert.deepEqual(missing.threatPace, {});
    assert.deepEqual(missing.rumorTemplates, DEFAULT_AGENDAS.rumorTemplates);

    const unknown = resolveAgenda(agendas, 'not-a-season');
    assert.deepEqual(unknown.season, {});
    assert.equal(unknown.defaults.factionInfluencePerDay, agendas.defaults.factionInfluencePerDay);
    assert.equal(unknown.rumorTemplates.length, agendas.defaults.rumorTemplates.length);

    const s1 = resolveAgenda(agendas, 's1');
    assert.equal(s1.factionAgendas.clarity.influencePerDay, 0.3);
    assert.deepEqual(s1.rumorTemplates, agendas.seasons.s1.rumorTemplates);

    const sandbox = resolveAgenda(agendas, 'sandbox');
    assert.deepEqual(sandbox.factionAgendas, {});
    assert.deepEqual(sandbox.threatPace, {});
});

test('DEFAULT_AGENDAS is deep-frozen and usable without loading', () => {
    assert.equal(Object.isFrozen(DEFAULT_AGENDAS), true);
    assert.equal(Object.isFrozen(DEFAULT_AGENDAS.rumorTemplates), true);
    assert.ok(DEFAULT_AGENDAS.rumorTemplates.length > 0);
});

test('loadAgendas caches a valid document and rejects a malformed one', async () => {
    clearAgendasCache();
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return { ok: true, json: async () => agendas };
    };
    const first = await loadAgendas({ fetchImpl });
    const second = await loadAgendas({ fetchImpl });
    assert.equal(first, second);
    assert.equal(calls, 1);
    clearAgendasCache();

    let invalidCalls = 0;
    const invalidFetch = async () => {
        invalidCalls += 1;
        return {
            ok: true,
            json: async () => ({ schemaVersion: 2, defaults: {}, seasons: {} }),
        };
    };
    await assert.rejects(
        () => loadAgendas({ fetchImpl: invalidFetch }),
        /loadAgendas: invalid agenda data/,
    );
    assert.equal(invalidCalls, 1);
    // A failed load is not cached.
    await assert.rejects(
        () => loadAgendas({ fetchImpl: invalidFetch }),
        /loadAgendas: invalid agenda data/,
    );
    assert.equal(invalidCalls, 2);
    clearAgendasCache();
});

test('validateAgendas rejects bad shapes with a path and message', () => {
    const invalid = structuredClone(agendas);
    invalid.defaults.maxDaysPerTick = 0;
    invalid.defaults.rumorsPerTick = 1.5;
    invalid.seasons.s1.factionAgendas.clarity.influencePerDay = 'fast';
    invalid.seasons.s1.threatPace['s1.threat.clarity'].progressPerDay = null;
    const validation = validateAgendas(invalid);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.path === 'defaults.maxDaysPerTick'));
    assert.ok(validation.errors.some((error) => error.path === 'defaults.rumorsPerTick'));
    assert.ok(validation.errors.some(
        (error) => error.path === 'seasons.s1.factionAgendas.clarity.influencePerDay',
    ));
    assert.ok(validation.errors.some(
        (error) => error.path === 'seasons.s1.threatPace.s1.threat.clarity.progressPerDay',
    ));
});
