import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CHARACTER_CREATOR_SCHEMA,
    assembleCardDescription,
    buildCharacterCreatorPrompt,
    buildGeneratedCardEnvelope,
    buildGeneratedCharacter,
    buildGeneratedCharacterEvent,
    buildGeneratedProfile,
    createCharacterCreator,
    normalizeCardName,
    normalizeGeneratedCard,
    slugifyCardName,
    validateGeneratedCard,
} from '../src/agents/character-creator.js';
import { parseCardProfile } from '../src/data/card-profile.js';
import { createWorldState, cloneWorldState, validateWorldState } from '../src/state/world-state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
    return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

const REAL_REGISTRY = readJson('data/characters/index.json');
const REAL_FACTIONS = readJson('data/factions.json');
const REAL_LOCATIONS = readJson('data/locations.json');
const REAL_FORM_GROUPS = readJson('data/form-groups.json');
const REAL_FORM_RULES = readJson('data/form-rules.json');
const REAL_S1 = readJson('data/seasons/s1.json');

const SEASON = {
    id: 's1',
    title: 'Season 1 — Omnilia (Clarity Arc)',
    era: '2037–2040',
    premise: 'Clarity Incorporated controls Neo Terra from the shadows.',
    toneNotes: 'Cyberpunk comic-book melodrama.',
    playerRole: 'hero',
    roster: [{ characterId: 's1.vaiva.colorgarde' }],
    factions: [{ id: 'clarity', influence: 80, status: 'dominant' }],
    threats: [
        {
            id: 's1.threat.clarity',
            name: 'Clarity Incorporated',
            rank: 'main',
            agenda: 'Own Neo Terra.',
        },
    ],
};

const FACTIONS = {
    factions: [
        { id: 'clarity', name: 'Clarity Incorporated', side: 'villain' },
        { id: 'petrabyte', name: 'PetraByte', side: 'hero' },
    ],
};

const DISTRICTS = {
    districts: [
        { id: 'downtown', name: 'Downtown' },
        { id: 'industrial-belt', name: 'Industrial Belt' },
    ],
};

const REGISTRY = {
    entries: [
        { id: 's1.vaiva.colorgarde', displayName: 'Vaiva Colorgarde', aliases: ['Colorgarde'] },
        { id: 's1.claire.atropos', displayName: 'Claire Atropos', aliases: [] },
    ],
};

function validCard(overrides = {}) {
    return {
        name: 'Mara Voss',
        aliases: ['Neon Wraith'],
        identity: 'Pirate-radio host by night; the vigilante known as Neon Wraith.',
        side: 'vigilante',
        threatLevel: 'low',
        gender: 'Female',
        species: 'Human metahuman',
        occupation: 'Night-shift radio host',
        faction: 'Unaffiliated',
        appearance: 'Mara is a lean, tired woman with chopped black hair and grey eyes.',
        attire: 'A matte-black hooded jacket, cut-finger gloves, and a painted welding visor.',
        abilities: 'She can deaden a room to silence and throw her voice, and fire one short concussive burst.',
        personality: 'Mara is exhausted and funny about it, which fools people into thinking she is fine.',
        speech: 'She talks fast and low, with deadpan one-liners and a radio voice she enjoys too much.',
        likes: ['Cheap coffee', 'Quiet stairwells', 'Listeners who call in'],
        dislikes: ['Clarity Incorporated', 'Being thanked'],
        goals: ['Find her brother', 'Warn metahumans before the snatch teams'],
        background: 'She grew up in the Industrial Belt and raised her younger brother after their parents left.',
        combatStyle: 'She fights like a burglar: silence first, one burst to escape.',
        gear: 'A directional microphone and a burner phone.',
        weakness: 'Every burst costs her hearing and leaves a blinding migraine.',
        firstMes: 'The relay tower has not broadcast since 2034. Mara sits cross-legged on a crate, headphones over one ear, and leans into the microphone. "Good morning, Neo Terra."',
        mesExample: '<START>\nMara: "You are early," she says without turning around. The broadcast does not start until two.',
        tags: ['vigilante', 'pirate-radio', 'sound', 'industrial-belt', 'non-powered-backup', 'season-1'],
        canonLinks: {
            threatIds: ['s1.threat.clarity'],
            factionIds: ['petrabyte'],
            characterIds: ['s1.vaiva.colorgarde'],
        },
        ...overrides,
    };
}

test('a good card validates, assembles, and round-trips through the card parser', () => {
    const result = validateGeneratedCard(validCard(), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, true, result.blockedReason ?? '');
    assert.equal(result.value.name, 'Mara Voss');
    assert.equal(result.value.id, 'gen.s1.mara-voss');
    assert.deepEqual(result.value.canonLinks.threatIds, ['s1.threat.clarity']);

    const description = assembleCardDescription(result.value);
    assert.match(description, /^\[\{\{char\}\} is Mara Voss, Pirate-radio host/);
    assert.match(description, /Setting\/World: A massive, well-maintained city called Neo Terra/);
    assert.match(description, /Gender: Female/);
    assert.match(description, /Weakness: Every burst costs her hearing/);

    const profile = parseCardProfile({ data: { name: 'Mara Voss', description } });
    assert.equal(profile.name, 'Mara Voss');
    assert.equal(profile.gender, 'Female');
    assert.equal(profile.species, 'Human metahuman');
    assert.match(profile.appearance, /lean, tired woman/);
    assert.match(profile.attire, /matte-black hooded jacket/);
    assert.match(profile.abilities, /deaden a room/);
    assert.match(profile.personality, /exhausted and funny/);
    assert.match(profile.speech, /talks fast and low/);
    assert.match(profile.background, /Industrial Belt/);
    assert.match(profile.weakness, /costs her hearing/);
    assert.ok(profile.likes.length >= 2);
    // Identity round-trips through the dedicated label, not just the preamble.
    assert.equal(profile.identity, result.value.identity);
    assert.deepEqual(profile.missing, []);
});

test('required sections block the preview', () => {
    const result = validateGeneratedCard(validCard({ background: '' }), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /background is required/);
});

test('a description leaked into firstMes blocks the preview', () => {
    const leaked = validateGeneratedCard(validCard({
        firstMes: '[{{char}} is Mara Voss.\n\nSetting/World: Neo Terra.\n\nAppearance: tired.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(leaked.ok, false);
    assert.match(leaked.blockedReason, /card description instead of a scene/);
});

test('name collisions with the registry block the preview', () => {
    const result = validateGeneratedCard(validCard({ name: 'Claire Atropos' }), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /collides with an existing character/);
});

test('unknown canon ids are dropped with a warning, never kept', () => {
    const result = validateGeneratedCard(validCard({
        canonLinks: {
            threatIds: ['s1.threat.clarity', 's9.threat.unknown'],
            factionIds: ['sensational-sirens'],
            characterIds: ['s1.vaiva.colorgarde', 's3.unknown'],
        },
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.canonLinks.threatIds, ['s1.threat.clarity']);
    assert.deepEqual(result.value.canonLinks.factionIds, []);
    assert.deepEqual(result.value.canonLinks.characterIds, ['s1.vaiva.colorgarde']);
    assert.ok(result.warnings.some((warning) => /dropped unknown faction/.test(warning)));
});

test('the mesExample speaker name is rewritten to {{char}}', () => {
    const result = validateGeneratedCard(validCard({
        mesExample: '<START>\nMara: "You are early."\n\n{{user}}: "Who are you?"',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
    assert.match(result.value.mesExample, /^<START>\n\{\{char\}\}: "You are early\."/);
});

test('over-long fields are clamped at a sentence boundary', () => {
    const long = `${'A long sentence about the character. '.repeat(80)}`;
    const result = validateGeneratedCard(validCard({ appearance: long }), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, true);
    assert.ok(result.value.appearance.length <= 700);
    assert.ok(result.warnings.some((warning) => /appearance was trimmed/.test(warning)));
});

test('meta phrases block the preview', () => {
    const result = validateGeneratedCard(validCard({
        background: 'She knows the player will arrive soon.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /mentions "the player"/);
});

test('future knowledge blocks the preview', () => {
    const result = validateGeneratedCard(validCard({
        background: 'By 2044 she runs the whole district.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /future knowledge/);
});

test('a powered character without a weakness is blocked', () => {
    const result = validateGeneratedCard(validCard({ weakness: '' }), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /must state a weakness/);
});

test('a civilian with no powers needs no weakness', () => {
    const result = validateGeneratedCard(validCard({
        name: 'Lena Park',
        side: 'civilian',
        abilities: 'None.',
        weakness: '',
        identity: 'Noodle-stall owner.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
});

test('an unknown district is a warning, not a rejection', () => {
    const result = validateGeneratedCard(validCard({
        background: 'She grew up in the Kestrel District and never left it.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => /unknown district/.test(warning)));
});

test('buildGeneratedCharacter matches the seeded CharacterState shape', () => {
    const card = validCard();
    const character = buildGeneratedCharacter(card, {
        seasonId: 's1',
        season: SEASON,
        locationId: 'central-plaza',
        turn: 4,
    });
    assert.equal(character.charId, 'gen.s1.mara-voss');
    assert.equal(character.formId, character.charId);
    assert.equal(character.displayName, 'Mara Voss');
    assert.equal(character.controlledBy, 'npc');
    assert.equal(character.locationId, 'central-plaza');
    assert.equal(character.agenda, 'Undermine Clarity Incorporated on your own terms');
    assert.equal(character.personality, card.personality);
    assert.equal(character.speech, card.speech);
    assert.equal(character.notes, card.background);
    assert.ok(Array.isArray(character.abilities));
    assert.equal(character.lastUpdatedTurn, 4);
    assert.deepEqual(character.stamina, { current: 100, max: 100 });
});

test('the profile mirrors the parser shape and the envelope is chara_card_v3', () => {
    const card = validCard();
    const profile = buildGeneratedProfile(card);
    assert.equal(profile.name, 'Mara Voss');
    assert.equal(profile.attire, card.attire);
    assert.deepEqual(profile.likes, card.likes);
    assert.deepEqual(profile.forms, {});

    const envelope = buildGeneratedCardEnvelope(card);
    assert.equal(envelope.spec, 'chara_card_v3');
    assert.equal(envelope.spec_version, '3.0');
    assert.equal(envelope.data.name, 'Mara Voss');
    assert.equal(envelope.data.first_mes, card.firstMes);
    assert.equal(envelope.data.mes_example, card.mesExample);
    assert.match(envelope.data.description, /Personality: Mara is exhausted/);
    assert.equal(envelope.data.extensions.depth_prompt.depth, 0);
});

test('the reducer event carries the character, profile, card, and portrait', () => {
    const event = buildGeneratedCharacterEvent({
        draft: validCard(),
        season: SEASON,
        locationId: 'central-plaza',
        turn: 2,
        now: 1234,
        portrait: 'data:image/png;base64,AAAA',
        model: 'test-model',
        warnings: ['appearance is over the guide'],
    });
    assert.equal(event.type, 'ADD_GENERATED_CHARACTER');
    assert.equal(event.character.charId, 'gen.s1.mara-voss');
    assert.equal(event.character.locationId, 'central-plaza');
    assert.equal(event.profile.name, 'Mara Voss');
    assert.equal(event.card.spec, 'chara_card_v3');
    assert.equal(event.portrait, 'data:image/png;base64,AAAA');
    assert.equal(event.generatedAt, 1234);
    assert.equal(event.model, 'test-model');
    assert.deepEqual(event.warnings, ['appearance is over the guide']);
});

test('the prompt carries the season bible, closed district list, and hard limits', () => {
    const prompt = buildCharacterCreatorPrompt({
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
        locations: { locations: [{ name: 'Central Plaza', district: 'Downtown' }] },
        exemplars: [{ name: 'Vaiva', description: 'Appearance: a hero.' }],
        concept: { name: 'Mara Voss', side: 'vigilante', concept: 'A pirate-radio vigilante.' },
        settings: {},
    });
    assert.match(prompt, /Season 1 — Omnilia/);
    assert.match(prompt, /Clarity Incorporated controls Neo Terra/);
    assert.match(prompt, /Tone notes: Cyberpunk/);
    assert.match(prompt, /Districts \(closed list\): Downtown, Industrial Belt/);
    assert.match(prompt, /Key locations: Central Plaza \(Downtown\)/);
    assert.match(prompt, /EXEMPLAR 1: Vaiva/);
    assert.match(prompt, /firstMes MUST be 400-1400 characters of pure scene prose/);
    assert.match(prompt, /canonLinks may contain ONLY ids/);
    assert.match(prompt, /A pirate-radio vigilante/);
});

test('the schema is a strict object with the required fields', () => {
    assert.equal(CHARACTER_CREATOR_SCHEMA.additionalProperties, false);
    for (const field of ['name', 'side', 'firstMes', 'mesExample', 'background']) {
        assert.ok(CHARACTER_CREATOR_SCHEMA.required.includes(field), field);
    }
});

test('names normalize deterministically for ids and collisions', () => {
    assert.equal(normalizeCardName('Mára  Voss!'), 'mara voss');
    assert.equal(slugifyCardName('Mára  Voss!'), 'mara-voss');
    assert.equal(slugifyCardName('Claire Atropos'), 'claire-atropos');
});

test('the agent retries once with a larger budget and returns the built draft', async () => {
    const calls = [];
    let attempt = 0;
    const runner = {
        async runAgent(request) {
            calls.push(request);
            attempt += 1;
            if (attempt === 1) {
                return { value: { name: 'Mara Voss' } };
            }
            return { value: validCard() };
        },
    };
    const agent = createCharacterCreator({
        runner,
        getSettings: () => ({ agents: { characterCreator: { enabled: true, maxTokens: 4000 } } }),
    });
    const result = await agent.run({
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
        exemplars: [],
        concept: { name: 'Mara Voss', side: 'vigilante', concept: 'Pirate radio.' },
        registry: REGISTRY,
        locationId: 'central-plaza',
        turn: 3,
    });
    assert.equal(result.ok, true, result.blockedReason ?? result.error ?? '');
    assert.equal(result.calls, 2);
    assert.equal(calls[0].agentId, 'characterCreator');
    assert.ok(calls[0].overrides.maxTokens < calls[1].overrides.maxTokens);
    assert.equal(result.character.locationId, 'central-plaza');
    assert.match(result.card.data.description, /\[\{\{char\}\} is Mara Voss/);
});

test('the agent reports failure instead of throwing for model errors', async () => {
    const agent = createCharacterCreator({
        runner: {
            async runAgent() {
                throw new Error('network down');
            },
        },
        getSettings: () => ({ agents: { characterCreator: { enabled: true } } }),
    });
    const result = await agent.run({ season: SEASON, concept: { concept: 'x' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /network down/);
});

test('a disabled agent makes zero runner calls', async () => {
    let calls = 0;
    const agent = createCharacterCreator({
        runner: {
            async runAgent() {
                calls += 1;
                return { value: validCard() };
            },
        },
        getSettings: () => ({ agents: { characterCreator: { enabled: false } } }),
    });
    const result = await agent.run({ season: SEASON, concept: { concept: 'x' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(calls, 0);
});

test('canon links are restricted to the season, even with the global faction document', () => {
    const result = validateGeneratedCard(validCard({
        canonLinks: {
            threatIds: ['s1.threat.clarity'],
            factionIds: ['clarity', 'sensational-sirens'],
            characterIds: [],
        },
    }), {
        registry: REGISTRY,
        season: SEASON,
        factions: REAL_FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.canonLinks.factionIds, ['clarity']);
    assert.ok(result.warnings.some((warning) => /sensational-sirens/.test(warning)));
});

test('a faction label outside the season is set to Unaffiliated', () => {
    const result = validateGeneratedCard(validCard({ faction: 'Sensational Sirens' }), {
        registry: REGISTRY,
        season: SEASON,
        factions: {
            factions: [
                { id: 'clarity', name: 'Clarity Incorporated' },
                { id: 'petrabyte', name: 'PetraByte' },
                { id: 'sensational-sirens', name: 'Sensational Sirens' },
            ],
        },
        districts: DISTRICTS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.faction, 'Unaffiliated');
    assert.ok(result.warnings.some((warning) => /not a season faction/.test(warning)));
});

test('a canonical faction name is kept', () => {
    const result = validateGeneratedCard(validCard({ faction: 'Clarity Incorporated' }), {
        registry: REGISTRY,
        season: SEASON,
        factions: FACTIONS,
        districts: DISTRICTS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.faction, 'Clarity Incorporated');
});

test('goals, attire, and other list fields are scanned for meta and future text', () => {
    const goals = validateGeneratedCard(validCard({ goals: ["Win the player's trust"] }), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    assert.equal(goals.ok, false);
    assert.match(goals.blockedReason, /mentions "the player"/);

    const attire = validateGeneratedCard(validCard({ attire: 'A 2044 Clarity prototype jacket.' }), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    assert.equal(attire.ok, false);
    assert.match(attire.blockedReason, /future knowledge/);

    const tags = validateGeneratedCard(validCard({
        tags: ['vigilante', 'radio', 'sound', 'industrial', 'night', 'you feel seen'],
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(tags.ok, false);
    assert.match(tags.blockedReason, /mentions "you feel"/);
});

test('a valid district is not flagged and an invented one is named', () => {
    const valid = validateGeneratedCard(validCard({
        background: 'She works out of the Downtown District and rarely leaves it.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(valid.ok, true);
    assert.equal(valid.warnings.some((warning) => /unknown district/.test(warning)), false);

    const invented = validateGeneratedCard(validCard({
        background: 'She grew up in the Kestrel District and never left it.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(invented.ok, true);
    assert.ok(invented.warnings.some((warning) => /unknown district "kestrel"/.test(warning)));
});

test('an unpowered villain with no weakness is accepted', () => {
    const result = validateGeneratedCard(validCard({
        name: 'Dominic Ferraro',
        side: 'villain',
        abilities: 'No metahuman powers; he reads ledgers and people with equal precision and has friends in every department.',
        weakness: '',
        identity: 'The Ledger.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true, result.blockedReason ?? '');
});

test('a trimmed field ends at a sentence boundary', () => {
    const result = validateGeneratedCard(validCard({
        weakness: 'A cost that is paid every time. '.repeat(20),
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
    assert.ok(result.value.weakness.length <= 260);
    assert.match(result.value.weakness, /\.$/);
});

test('the mesExample rewrite leaves {{user}} and other speakers alone', () => {
    const result = validateGeneratedCard(validCard({
        mesExample: '<START> Mara: "Lock the door."\n{{user}}: "Who is there?"\nNarrator: The rain stops.',
    }), { registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS });
    assert.equal(result.ok, true);
    assert.match(result.value.mesExample, /^<START> \{\{char\}\}: "Lock the door\."/);
    assert.match(result.value.mesExample, /\{\{user\}\}: "Who is there\?"/);
    assert.match(result.value.mesExample, /Narrator: The rain stops\./);
});

test('an alias-only collision blocks', () => {
    const result = validateGeneratedCard(validCard({ aliases: ['Colorgarde'] }), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockedReason, /collides with an existing character/);
});

test('non-object input and a missing firstMes are reported, not thrown', () => {
    const object = validateGeneratedCard(null, {});
    assert.equal(object.ok, false);
    assert.match(object.blockedReason, /did not return a card object/);

    const missing = validateGeneratedCard(validCard({ firstMes: '' }), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.blockedReason, /firstMes is required/);
});

test('validation and assembly are deterministic', () => {
    const first = validateGeneratedCard(validCard(), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    const second = validateGeneratedCard(validCard(), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    });
    assert.deepEqual(first, second);
    assert.equal(assembleCardDescription(first.value), assembleCardDescription(second.value));
    assert.deepEqual(normalizeGeneratedCard(validCard(), {
        registry: REGISTRY, season: SEASON, factions: FACTIONS, districts: DISTRICTS,
    }), first.value);
});

test('both attempts failing reports the attempts and the last reason', async () => {
    let calls = 0;
    const agent = createCharacterCreator({
        runner: {
            async runAgent() {
                calls += 1;
                return { value: { name: 'Mara Voss' } };
            },
        },
        getSettings: () => ({ agents: { characterCreator: { enabled: true, maxTokens: 4000 } } }),
    });
    const result = await agent.run({ season: SEASON, concept: { concept: 'x' } });
    assert.equal(result.ok, false);
    assert.equal(result.calls, 2);
    assert.equal(calls, 2);
    assert.match(result.blockedReason, /required/);
});

test('a canon rejection is final and is not retried', async () => {
    let calls = 0;
    const agent = createCharacterCreator({
        runner: {
            async runAgent() {
                calls += 1;
                return { value: validCard({ name: 'Claire Atropos' }) };
            },
        },
        getSettings: () => ({ agents: { characterCreator: { enabled: true } } }),
    });
    const result = await agent.run({ season: SEASON, registry: REGISTRY });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.match(result.blockedReason, /collides/);
});

test('the generated CharacterState validates against the world-state contract', () => {
    const state = createWorldState({
        season: REAL_S1,
        registry: REAL_REGISTRY,
        factions: REAL_FACTIONS,
        locations: REAL_LOCATIONS,
        formGroups: REAL_FORM_GROUPS,
        formRules: REAL_FORM_RULES,
        chatId: 'creator-contract',
        now: 1,
    });
    const character = buildGeneratedCharacter(validCard(), {
        seasonId: REAL_S1.id,
        season: REAL_S1,
        locationId: 'central-plaza',
        turn: 0,
    });
    const probe = cloneWorldState(state);
    probe.characters[character.charId] = character;
    assert.deepEqual(validateWorldState(probe).errors, []);

    const seeded = Object.values(state.characters)[0];
    const seededKeys = new Set(Object.keys(seeded));
    for (const key of Object.keys(character)) {
        assert.ok(seededKeys.has(key) || key === 'personality' || key === 'speech', `unexpected key ${key}`);
    }
});

