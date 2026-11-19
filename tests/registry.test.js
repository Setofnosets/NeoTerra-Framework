import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildRegistry,
    classifyFilename,
    parseAliases,
    parseCard,
    parseSide,
    parseThreatLevel,
    slugify,
} from '../tools/build-data.mjs';
import {
    validateCardSource,
    validateFormGroups,
    validateFormRules,
    validateRegistry,
} from '../src/data/schema.js';
import {
    buildRegistryIndex,
    clearRegistryCache,
    getAliases,
    getCharacter,
    getNpcPool,
    getSeasonCharacters,
    isBundle,
    loadRegistry,
} from '../src/data/registry.js';
import {
    assertFormExclusivity,
    buildFormIndex,
    findFormRule,
    getActiveForm,
    getAlternateForms,
    getBaseForm,
    getFormGroup,
    getReversibleRules,
    isLegalTransform,
} from '../src/data/forms.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const REGISTRY_PATH = join(ROOT, 'data', 'characters', 'index.json');

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

const registry = readJson(REGISTRY_PATH);
const formGroups = readJson(join(ROOT, 'data', 'form-groups.json'));
const formRules = readJson(join(ROOT, 'data', 'form-rules.json'));
const byCardPath = new Map(registry.entries.map((entry) => [entry.cardPath, entry]));
const byId = new Map(registry.entries.map((entry) => [entry.id, entry]));

test('counts cover all 78 cards and every season', () => {
    assert.equal(registry.entries.length, 78);
    assert.deepEqual(registry.counts, {
        s1: 11,
        s1dark: 10,
        s2: 13,
        s3: 19,
        s4: 21,
        others: 4,
        total: 78,
    });

    const actual = {};
    for (const entry of registry.entries) {
        actual[entry.seasonId] = (actual[entry.seasonId] ?? 0) + 1;
    }
    assert.equal(actual.s1, 11);
    assert.equal(actual.s1dark, 10);
    assert.equal(actual.s2, 13);
    assert.equal(actual.s3, 19);
    assert.equal(actual.s4, 21);
    assert.equal(actual.others, 4);
});

test('data.* is authoritative and legacy top-level card fields are ignored', () => {
    const raw = readJson(join(FIXTURES, 'v3-legacy-name.json'));
    assert.equal(validateCardSource(raw).ok, true);

    const entry = parseCard(raw, { file: 'Chars/S1/Test Hero.json', seasonId: 's1' });
    assert.equal(entry.dataName, 'Data Name');
    assert.notEqual(entry.dataName, raw.name);
    assert.equal(entry.displayName, 'Test Hero');
    assert.equal(entry.id, 's1.test.hero');
    assert.equal(entry.side, 'hero');
    assert.equal(entry.threatLevel, 'S');
    assert.match(entry.threatLevelRaw, /^S \(A\+ without the suit\)$/);
    assert.deepEqual(entry.tags, ['Hero', 'Superhero', 'Female']);
    assert.deepEqual(entry.aliases, ['Golden Gun', 'Data Name']);
});

test('v2 cards parse and malformed cards are rejected', () => {
    const v2 = readJson(join(FIXTURES, 'v2-card.json'));
    assert.equal(validateCardSource(v2).ok, true);
    const entry = parseCard(v2, { file: 'Chars/Others/V2 Hero.json', seasonId: 'others' });
    assert.equal(entry.dataName, 'V2 Hero');
    assert.equal(entry.side, 'hero');
    assert.equal(entry.threatLevel, 'EX+');
    assert.deepEqual(entry.aliases, ['Blue Comet']);

    for (const fixture of ['missing-data.json', 'invalid-data-name.json']) {
        const malformed = readJson(join(FIXTURES, fixture));
        const validation = validateCardSource(malformed);
        assert.equal(validation.ok, false, fixture);
        assert.ok(validation.errors.length > 0, fixture);
        assert.throws(
            () => parseCard(malformed, { file: `Chars/S1/${fixture}`, seasonId: 's1' }),
            /invalid character card/,
            fixture,
        );
    }
});

test('slugify, classifyFilename, parseAliases, parseSide, and parseThreatLevel are pure helpers', () => {
    assert.equal(slugify('Petrauskaitė'), 'petrauskaite');
    assert.equal(slugify("Claire & Co.'s Place"), 'claire.and.co.s.place');
    assert.equal(slugify('Leila Renya.json'), 'leila.renya.json');

    assert.deepEqual(classifyFilename('Claire Lachesis (Cleansed Claire Atropos).json'), {
        formKind: 'cleansed',
        baseLabel: 'Claire Lachesis',
        formLabel: 'Cleansed Claire Atropos',
    });
    assert.equal(classifyFilename('Vaiva Petrauskait-Colorgarde (Season 2 ver.).json').formKind, 'alt-version');
    assert.equal(classifyFilename('Selina Cross-Umbra (Vampire).json').formKind, 'alt-version');
    assert.equal(classifyFilename('Claire Atropos (Recorrupted).json').formKind, 'corrupted');
    assert.equal(classifyFilename('Evelyn Yukon (Silent Whisp).json').formKind, 'base');

    assert.deepEqual(
        parseAliases(
            'Aliases: Bleeding Heart (supervillain name). Carol Fate (civilian name). ' +
                'Her Majesty (from Wonderland\'s Knights).\n\nAppearance: prose follows.',
        ),
        ['Bleeding Heart', 'Carol Fate', 'Her Majesty'],
    );
    assert.deepEqual(parseAliases('Aliases:  "A long quoted paragraph, not an alias." '), []);

    assert.equal(parseSide('', 'corrupted', []), 'villain');
    assert.equal(parseSide('', 'cleansed', []), 'hero');
    assert.equal(parseSide('', 'base', ['Villain', 'Hero']), 'villain');
    assert.equal(parseSide('', 'base', ['🦸 Hero']), 'hero');
    assert.equal(parseSide('', 'base', ['vigilante']), 'vigilante');
    assert.equal(parseSide('Side: Neo Terra Crisis Coalition', 'base', []), 'hero');
    assert.equal(parseSide("Side: Noah's army", 'base', ['Hero']), 'villain');

    assert.deepEqual(parseThreatLevel('Threat Level: OMEGA (EX without enhancements)'), {
        level: 'OMEGA',
        raw: 'OMEGA (EX without enhancements)',
    });
    assert.deepEqual(parseThreatLevel('No threat line'), { level: null, raw: null });
});

test('registry IDs are unique, season-scoped, and include the required corrections', () => {
    const ids = new Set();
    for (const entry of registry.entries) {
        assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
        ids.add(entry.id);
        assert.ok(entry.id.startsWith(`${entry.seasonId}.`), entry.id);
    }

    assert.ok(byId.has('s1dark.carol.bleeding-heart'));
    assert.ok(byId.has('s2.leila.renya'));
    assert.equal(byCardPath.get('Chars/S2/Leila Renya.json').id, 's2.leila.renya');
    assert.equal(
        registry.entries.filter((entry) => entry.dataName === 'Leila' && entry.seasonId === 's3').length,
        0,
    );

    assert.equal(
        byCardPath.get('Chars/S3/Selina Cross-Umbra.json').id,
        's3.selina.cross.umbra',
    );
    assert.equal(
        byCardPath.get('Chars/S4/Pink Icicle (Coldhearted Pink Power).json').id,
        's4.pink.icicle.coldhearted-pink-power',
    );
    assert.equal(
        byCardPath.get('Chars/S3/Crazy Cupid (Treat Zara Embarr).json').id,
        's3.crazy.cupid.treated.zara.embarr',
    );
    assert.equal(
        byCardPath.get('Chars/S3/Crazy Cupid (Treat Zara Embarr).json').formKind,
        'treated',
    );
    assert.equal(
        byCardPath.get('Chars/S4/Vaiva Petrauskaite-Colorgarde (Season 4 ver.).json').displayName,
        'Vaiva Petrauskaite',
    );
    assert.equal(
        byCardPath.get('Chars/S1Dark/Aurelia(Season Dark Version).json').id,
        's1dark.aurelia.season-dark-version',
    );
    assert.equal(
        byCardPath.get('Chars/S1Dark/Aurelia(Season Dark Version).json').displayName,
        'Aurelia (Dark)',
    );
});

test('every form group has exactly one base and resolves every member', () => {
    assert.equal(formGroups.groups.length, 30);
    assert.equal(validateFormGroups(formGroups).ok, true);

    for (const group of formGroups.groups) {
        const members = group.members.map((member) => byCardPath.get(`Chars/${member}`));
        assert.ok(members.every(Boolean), `${group.id} has unresolved members`);

        const bases = members.filter((entry) => entry.formRole === 'base');
        assert.equal(bases.length, 1, `${group.id} must have exactly one base`);
        assert.equal(bases[0].cardPath, `Chars/${group.base}`);

        for (const member of members) {
            assert.equal(member.formGroup, group.id);
            if (member.id === bases[0].id) {
                assert.equal(member.altOf, null);
            } else {
                assert.equal(member.formRole, 'alt');
                assert.equal(member.altOf, bases[0].id);
            }
        }
    }

    for (const [path, id] of [
        ['Chars/S1/Twisting Fate (Corrupted Carol Fate).json', 's1.carol'],
        ['Chars/S3/Blood Bound (Corrupted Emeral Allure).json', 's3.emerald-allure'],
        ['Chars/S4/Claire Atropos (Recorrupted).json', 's4.claire'],
    ]) {
        const entry = byCardPath.get(path);
        assert.equal(entry.formRole, 'base', path);
        assert.equal(entry.formKind, 'corrupted', path);
        assert.equal(entry.formGroup, id, path);
    }

    // Regression: the S2 Vaiva group's corrupted alternate must not be left
    // stranded as a standalone "base" entry.
    const stygian = byCardPath.get('Chars/S2/Stygian Stalker (Corrupted Colorgarde).json');
    assert.equal(stygian.formGroup, 's2.vaiva');
    assert.equal(stygian.formRole, 'alt');
    assert.equal(stygian.altOf, byCardPath.get('Chars/S2/Vaiva Petrauskait-Colorgarde (Season 2 ver.).json').id);
});

test('multi-actor bundles stay bundles and never become form groups', () => {
    for (const displayName of ['Atropos Couple', 'The Sensational Sirens']) {
        const entry = registry.entries.find((candidate) => candidate.displayName === displayName);
        assert.ok(entry, displayName);
        assert.equal(entry.bundle, true);
        assert.equal(entry.npcEligible, false);
        assert.equal(entry.formGroup, null);
        assert.equal(entry.formRole, 'base');
        assert.equal(entry.actors.length, 2);
        assert.ok(entry.actors.every((actor) => typeof actor.name === 'string' && actor.name.length > 0));
    }

    const npcPool = getNpcPool(registry, 's1');
    assert.equal(npcPool.some((entry) => entry.displayName === 'Atropos Couple'), false);
});

test('generated profiles cover every registry entry and point at its card', () => {
    const profiles = readJson(join(ROOT, 'data', 'characters', 'profiles.json'));
    assert.equal(profiles.schemaVersion, 1);
    assert.equal(profiles.generatedBy, 'tools/build-data.mjs');
    assert.equal(profiles.counts.profiles, registry.entries.length);
    assert.equal(Object.keys(profiles.profiles).length, registry.entries.length);

    for (const entry of registry.entries) {
        const profile = profiles.profiles[entry.id];
        assert.ok(profile, `${entry.id} has no generated profile`);
        assert.equal(profile.source.cardPath, entry.cardPath, entry.id);
        assert.equal(profile.source.file, entry.file, entry.id);
        assert.ok(Array.isArray(profile.missing), entry.id);
        assert.equal(typeof profile.name, 'string', entry.id);
    }

    const missingAppearance = Object.values(profiles.profiles)
        .filter((profile) => profile.missing.includes('appearance')).length;
    assert.equal(profiles.counts.missingAppearance, missingAppearance);
});

test('form rules cover every alternate and stay within a form group', () => {
    assert.equal(validateFormRules(formRules, registry).ok, true);
    assert.ok(formRules.rules.length >= 33);

    for (const entry of registry.entries.filter((candidate) => candidate.formRole === 'alt')) {
        assert.ok(
            formRules.rules.some((rule) => rule.to === entry.id),
            `${entry.id} has no inbound rule`,
        );
    }

    for (const rule of formRules.rules) {
        const from = byId.get(rule.from);
        const to = byId.get(rule.to);
        assert.ok(from, `unresolved from ${rule.from}`);
        assert.ok(to, `unresolved to ${rule.to}`);
        // Cross-season packs are allowed; a rule may not jump between groups.
        assert.equal(from.formGroup, to.formGroup, `${rule.id} crosses form groups`);
    }

    for (const rule of formRules.rules) {
        if (!['cleansed', 'infected', 'poisoned', 'alt-version', 'coldhearted'].includes(rule.trigger)) {
            continue;
        }
        assert.ok(
            formRules.rules.some((candidate) => candidate.from === rule.to && candidate.to === rule.from),
            `${rule.id} has no reverse rule`,
        );
    }
});

test('registry and form helper lookups behave on a mini fixture', () => {
    const minimRegistry = {
        entries: [
            {
                id: 's1.hero.base',
                file: 'Chars/S1/Hero Base.json',
                cardPath: 'Chars/S1/Hero Base.json',
                seasonId: 's1',
                formGroup: 's1.hero',
                formRole: 'base',
                altOf: null,
                formKind: 'base',
            },
            {
                id: 's1.hero.alt',
                file: 'Chars/S1/Hero Alt (Corrupted Base).json',
                cardPath: 'Chars/S1/Hero Alt (Corrupted Base).json',
                seasonId: 's1',
                formGroup: 's1.hero',
                formRole: 'alt',
                altOf: 's1.hero.base',
                formKind: 'corrupted',
            },
        ],
    };
    const miniGroups = {
        schemaVersion: 1,
        groups: [
            {
                id: 's1.hero',
                seasonId: 's1',
                label: 'Hero / Corrupted Hero',
                base: 'S1/Hero Base.json',
                members: ['S1/Hero Base.json', 'S1/Hero Alt (Corrupted Base).json'],
            },
        ],
    };
    const miniRules = {
        schemaVersion: 1,
        rules: [
            {
                id: 'rule.s1.hero.corrupted',
                from: 's1.hero.base',
                to: 's1.hero.alt',
                trigger: 'corrupted',
                reversibleBy: null,
                permanent: true,
            },
            {
                id: 'rule.s1.hero.corrupted.reverse',
                from: 's1.hero.alt',
                to: 's1.hero.base',
                trigger: 'cure',
                reversibleBy: 'cure',
                permanent: false,
            },
        ],
    };

    const registryIndex = buildRegistryIndex(minimRegistry);
    assert.equal(getCharacter(minimRegistry, 's1.hero.base').id, 's1.hero.base');
    assert.equal(getSeasonCharacters(minimRegistry, 's1').length, 2);
    assert.equal(getAliases({ aliases: ['A'] }).length, 1);
    assert.equal(isBundle({ bundle: false }), false);

    const formIndex = buildFormIndex(minimRegistry, miniGroups);
    assert.equal(getFormGroup(formIndex, 's1.hero').id, 's1.hero');
    assert.equal(getFormGroup(formIndex, 's1.hero.alt').id, 's1.hero');
    assert.equal(getBaseForm(formIndex, 's1.hero.alt').id, 's1.hero.base');
    assert.deepEqual(
        getAlternateForms(formIndex, 's1.hero.base').map((entry) => entry.id),
        ['s1.hero.alt'],
    );

    assert.equal(getActiveForm(formIndex, { 's1.hero.base': 'active' }, 's1.hero').id, 's1.hero.base');
    assert.equal(
        getActiveForm(
            formIndex,
            { 's1.hero.base': 'active', 's1.hero.alt': 'active' },
            's1.hero',
        ),
        null,
    );
    assert.equal(getActiveForm(formIndex, {}, 's1.hero'), null);

    assert.equal(findFormRule(miniRules, 's1.hero.base', 's1.hero.alt').id, 'rule.s1.hero.corrupted');
    assert.equal(isLegalTransform(miniRules, 's1.hero.base', 's1.hero.alt'), true);
    assert.equal(isLegalTransform(miniRules, 's1.hero.alt', 's1.hero.base'), true);
    assert.deepEqual(
        getReversibleRules(miniRules, 's1.hero.alt').map((rule) => rule.id),
        ['rule.s1.hero.corrupted.reverse'],
    );

    assert.equal(assertFormExclusivity(formIndex, ['s1.hero.base']), true);
    assert.equal(assertFormExclusivity(formIndex, { 's1.hero.base': 'active' }), true);
    assert.throws(
        () => assertFormExclusivity(formIndex, ['s1.hero.base', 's1.hero.alt']),
        /form exclusivity violated/,
    );
    assert.throws(
        () =>
            assertFormExclusivity(formIndex, {
                's1.hero.base': 'active',
                's1.hero.alt': 'active',
            }),
        /form exclusivity violated/,
    );
});

test('buildRegistry applies overrides and sorts entries deterministically', () => {
    const cards = [
        { file: 'Chars/S2/Leila Renya.json', seasonId: 's2', raw: readJson(join(FIXTURES, 'v2-card.json')) },
        { file: 'Chars/S1/Test Hero.json', seasonId: 's1', raw: readJson(join(FIXTURES, 'v3-legacy-name.json')) },
    ];
    // Both fixtures carry their own data; only the S2 card needs an ID override.
    const built = buildRegistry({
        cards: cards.map((card, index) => ({
            ...card,
            file: index === 0 ? 'Chars/S2/Leila Renya.json' : 'Chars/S1/Test Hero.json',
        })),
        overrides: {
            entries: {
                'S2/Leila Renya.json': { id: 's2.leila.renya' },
            },
        },
        formGroups: { groups: [] },
    });

    assert.deepEqual(
        built.entries.map((entry) => entry.id),
        ['s1.test.hero', 's2.leila.renya'],
    );
    assert.equal(built.counts.s1, 1);
    assert.equal(built.counts.s2, 1);
});

test('loadRegistry validates through an injected fetch and caches the result', async () => {
    clearRegistryCache();
    let calls = 0;
    const loaded = await loadRegistry({
        fetchImpl: async (url) => {
            calls += 1;
            assert.match(url, /\/data\/characters\/index\.json$/);
            return { ok: true, json: async () => registry };
        },
    });
    assert.equal(loaded.entries.length, 78);
    assert.equal(loaded, registry);

    const cached = await loadRegistry({
        fetchImpl: async () => {
            throw new Error('cache should prevent a second fetch');
        },
    });
    assert.equal(cached, loaded);
    assert.equal(calls, 1);
    clearRegistryCache();
});

test('the --check gate passes and does not rewrite index.json', () => {
    const before = readFileSync(REGISTRY_PATH, 'utf8');
    const result = spawnSync(process.execPath, ['tools/build-data.mjs', '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const after = readFileSync(REGISTRY_PATH, 'utf8');
    assert.equal(after, before);
});
