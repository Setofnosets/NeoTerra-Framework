import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneDefaults } from '../src/core/defaults.js';
import {
    applyContentGate,
    applyContentGateToPrompt,
} from '../src/core/content-gate.js';
import {
    BLOCK_PRIORITY,
    applyTokenBudget,
    estimateTokens,
    truncateToTokens,
} from '../src/context/budget.js';
import {
    BLOCK_HEADINGS,
    renderContext,
    renderContextText,
} from '../src/context/renderer.js';
import {
    buildCastProfiles,
    buildCharacterProfile,
} from '../src/context/worldbook.js';
import {
    CONTEXT_MARKER,
    createGenerationInterceptor,
    injectContextPrompt,
    isContextMessage,
    neoTerraGenerateInterceptor,
    stripContextPrompt,
} from '../src/context/interceptor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HERO = 's1.vaiva.colorgarde';
const VILLAIN = 's1.claire.atropos';

function makeCharacter(id, overrides = {}) {
    return {
        charId: id,
        formId: id,
        formGroup: null,
        displayName: id,
        side: 'neutral',
        controlledBy: 'npc',
        status: 'active',
        badEndType: null,
        locationId: 'plaza',
        alive: true,
        threatLevel: null,
        stamina: { current: 100, max: 100 },
        willpower: { current: 100, max: 100 },
        agenda: '',
        goals: [],
        mood: '',
        allegiance: 'neutral',
        appearance: '',
        outfit: '',
        abilities: [],
        skills: [],
        traits: [],
        likes: [],
        dislikes: [],
        relationships: [],
        corruption: { stage: 0, source: null, progress: 0 },
        lastUpdatedTurn: 0,
        notes: '',
        ...overrides,
    };
}

function makeState(overrides = {}) {
    return {
        schemaVersion: 1,
        chatId: 'chat-context',
        seasonId: 's1',
        mode: 'director',
        meta: {
            turn: 4,
            inGameDate: '2037-03-05',
            timeOfDay: 'night',
            sceneId: 's1.scene',
            inCombat: false,
            startedAt: 0,
        },
        arc: 'season',
        ending: { status: 'none' },
        playerRole: 'hero',
        player: {
            identity: 'custom',
            characterId: null,
            displayName: 'Rook',
            personaNotes: 'A street-level investigator.',
            charId: null,
            formId: null,
            status: 'active',
            stamina: { current: 70, max: 100 },
            willpower: { current: 60, max: 100 },
            corruption: { stage: 1, source: 'fear', progress: 25 },
            agenda: 'Find the missing metahumans',
            goals: ['Locate the lab'],
            outfit: 'Rain coat',
            appearance: 'Tired',
        },
        characters: {
            [HERO]: makeCharacter(HERO, {
                displayName: 'Vaiva Colorgarde',
                side: 'hero',
                threatLevel: 'High',
                agenda: 'Oppose Clarity',
                goals: ['Protect the city'],
                mood: 'determined',
                outfit: 'Colorgarde suit',
                appearance: 'Silver hair',
                abilities: ['Light blasts'],
                traits: ['Earnest'],
            }),
            [VILLAIN]: makeCharacter(VILLAIN, {
                displayName: 'Claire Atropos',
                side: 'villain',
                agenda: 'Convert metahumans',
                goals: ['Own the city'],
                mood: 'amused',
            }),
        },
        locations: {
            plaza: {
                id: 'plaza',
                name: 'Central Plaza',
                district: 'Downtown',
                kind: 'landmark',
                factionId: 'petrabyte',
                status: 'patrolled',
                capacity: 200,
                present: [HERO, VILLAIN],
                tags: [],
                visited: true,
                notes: 'A broad square.',
            },
        },
        factions: {
            petrabyte: {
                id: 'petrabyte',
                name: 'PetraByte',
                side: 'hero',
                influence: 65,
                status: 'active',
                goals: ['Protect the city'],
                description: '',
                headquartersLocationId: null,
            },
        },
        threats: [
            {
                id: 's1.clarity',
                name: 'Clarity Incorporated',
                rank: 'main',
                sourceFactionId: 'clarity',
                agenda: 'Convert metahumans',
                stages: ['Recruitment', 'Abductions', 'Open control'],
                progress: 40,
                stage: 1,
                status: 'active',
                locationId: 'plaza',
            },
        ],
        beats: {
            's1.b1': {
                status: 'open',
                resolvedTurn: null,
                adaptedFrom: null,
                adaptedTo: null,
                reason: null,
                deferredUntilTurn: null,
            },
        },
        badEnds: {},
        relationships: [
            {
                a: HERO,
                b: VILLAIN,
                type: 'rivalry',
                affinity: -30,
                tension: 60,
                notes: 'Old colleagues',
                sinceTurn: 1,
            },
        ],
        recentEvents: [
            {
                turn: 1,
                date: '2037-03-05',
                summary: 'A patrol vanished.',
                actors: [],
                locationId: 'plaza',
                tags: ['mystery'],
                headline: 'PATROL VANISHES',
            },
        ],
        scene: {
            locationId: 'plaza',
            present: [HERO, VILLAIN],
            combat: null,
            framing: 'Rain drums on the plaza screens.',
        },
        flags: {},
        log: [],
        ...overrides,
    };
}

const SEASON = {
    id: 's1',
    canonBeats: [
        {
            id: 's1.b1',
            order: 1,
            act: 'opening',
            title: 'First Abduction',
            description: 'A hero disappears from the plaza.',
            deadlineConsequence: 'Threat progress rises.',
            flexibility: 'adaptable',
            conditions: {},
            completion: { type: 'event', predicates: [{ kind: 'event-tag', tag: 'abduction' }] },
        },
    ],
};

function settingsWith(overrides = {}) {
    const settings = cloneDefaults();
    return {
        ...settings,
        ...overrides,
        context: { ...settings.context, ...(overrides.context ?? {}) },
        tokenBudget: { ...settings.tokenBudget, ...(overrides.tokenBudget ?? {}) },
    };
}

function blockById(result, id) {
    return result.blocks.find((block) => block.id === id) ?? null;
}

test('every block is rendered with a stable heading and exact snapshot text', () => {
    const state = makeState();
    const result = renderContext(state, {
        settings: settingsWith(),
        season: SEASON,
        blocks: { lore: false },
    });

    assert.equal(result.blocks.length, 4);
    assert.equal(result.blocks.map((block) => block.id).join(','), 'scene,cast,player,world');

    assert.equal(
        blockById(result, 'scene').text,
        [
            '[NEOTERRA_SCENE]',
            'Location: Central Plaza — Downtown',
            'Control: PetraByte (patrolled)',
            'Time: 2037-03-05, night',
            'Present: Vaiva Colorgarde, Claire Atropos',
            'Framing: Rain drums on the plaza screens.',
        ].join('\n'),
    );

    assert.equal(
        blockById(result, 'cast').text,
        [
            '[NEOTERRA_CAST]',
            'Vaiva Colorgarde — hero, active, threat High',
            'Location: Central Plaza',
            'Agenda: Oppose Clarity',
            'Goals: Protect the city',
            'Mood: determined',
            'Outfit: Colorgarde suit',
            'Appearance: Silver hair',
            'Abilities: Light blasts',
            'Traits: Earnest',
            'Resources: stamina 100/100; willpower 100/100',
            'Claire Atropos — villain, active',
            'Location: Central Plaza',
            'Agenda: Convert metahumans',
            'Goals: Own the city',
            'Mood: amused',
            'Resources: stamina 100/100; willpower 100/100',
        ].join('\n'),
    );

    assert.equal(
        blockById(result, 'player').text,
        [
            '[NEOTERRA_PLAYER]',
            'Name: Rook',
            'Identity: custom persona',
            'Role: hero',
            'Status: active',
            'Resources: stamina 70/100; willpower 60/100',
            'Corruption: stage 1 (25%)',
            'Agenda: Find the missing metahumans',
            'Goals: Locate the lab',
            'Outfit: Rain coat',
            'Appearance: Tired',
            'Persona: A street-level investigator.',
        ].join('\n'),
    );

    assert.equal(
        blockById(result, 'world').text,
        [
            '[NEOTERRA_WORLD]',
            'Factions:',
            '- PetraByte — hero, influence 65, active',
            '  Goals: Protect the city',
            'Threats:',
            '- Clarity Incorporated — main, active, stage 2/3: Abductions, 40%',
            '  Agenda: Convert metahumans',
            'Headlines:',
            '- PATROL VANISHES',
        ].join('\n'),
    );
});

test('continuity and lore blocks render when their data exists', () => {
    const state = makeState({
        ending: { status: 'epilogue', epilogueText: 'The city falls.', firedTurn: 4 },
        arc: 'season',
        badEnds: {
            [HERO]: {
                type: 'imprisonment',
                cause: 'Captured by Clarity',
                epilogueText: 'Vaiva was taken beneath Clarity HQ. She waits.',
            },
        },
    });
    const result = renderContext(state, { settings: settingsWith(), season: SEASON });

    assert.equal(
        blockById(result, 'continuity').text,
        [
            '[NEOTERRA_CONTINUITY]',
            'Ending: epilogue',
            'Ending fired at turn 4',
            'Bad ends:',
            '- Vaiva Colorgarde: imprisonment — Captured by Clarity',
            '  Vaiva was taken beneath Clarity HQ.',
        ].join('\n'),
    );

    assert.equal(
        blockById(result, 'lore').text,
        [
            '[NEOTERRA_LORE]',
            'Open story beats:',
            '- [opening] First Abduction — A hero disappears from the plaza.',
            '  If missed: Threat progress rises.',
            'Relationships:',
            '- Vaiva Colorgarde ↔ Claire Atropos — rivalry, affinity -30, tension 60: Old colleagues',
        ].join('\n'),
    );
});

test('empty state renders no headings and no text', () => {
    const result = renderContext({}, { settings: settingsWith() });
    assert.deepEqual(result.blocks, []);
    assert.equal(result.text, '');
    assert.equal(result.tokens, 0);
    assert.equal(renderContextText({}, { settings: settingsWith() }), '');
});

test('block toggles and the global context switch suppress blocks', () => {
    const state = makeState();
    const noCast = settingsWith();
    noCast.context.blocks.cast = false;
    const result = renderContext(state, { settings: noCast, season: SEASON });
    assert.equal(blockById(result, 'cast'), null);
    assert.ok(blockById(result, 'scene'));

    const disabled = settingsWith();
    disabled.context.enabled = false;
    assert.equal(renderContext(state, { settings: disabled, season: SEASON }).text, '');

    const perCall = renderContext(state, {
        settings: settingsWith(),
        season: SEASON,
        blocks: { world: false },
    });
    assert.equal(blockById(perCall, 'world'), null);
});

test('the player-controlled character never appears in the cast block', () => {
    const state = makeState({
        characters: {
            [HERO]: makeCharacter(HERO, {
                controlledBy: 'player',
                displayName: 'Vaiva Colorgarde',
            }),
            [VILLAIN]: makeCharacter(VILLAIN, { displayName: 'Claire Atropos' }),
        },
    });
    const result = renderContext(state, { settings: settingsWith(), season: SEASON });
    const cast = blockById(result, 'cast');
    assert.match(cast.text, /Claire Atropos/);
    assert.doesNotMatch(cast.text, /Vaiva Colorgarde/);
});

test('content gate applies to every block and casts hard limits win', () => {
    const state = makeState();
    state.scene.framing = 'They had explicit sex. Rain fell.';
    state.player.personaNotes = 'They had explicit sex. Then they ran.';
    state.characters[VILLAIN].appearance = 'Graphic violence everywhere.';

    const strict = renderContext(state, {
        settings: settingsWith({ contentGate: 'strict' }),
        season: SEASON,
    });
    assert.doesNotMatch(strict.text, /explicit sex|graphic violence/i);
    assert.equal(renderContextText(state, {
        settings: settingsWith({ contentGate: 'full' }),
        season: SEASON,
        gateLevel: 'strict',
    }).includes('explicit sex'), false);

    const limited = settingsWith({ contentGate: 'full' });
    limited.contentLimits.characters[VILLAIN] = 'strict';
    const result = renderContext(state, { settings: limited, season: SEASON });
    assert.doesNotMatch(blockById(result, 'cast').text, /graphic violence/i);
});

test('budget enforces per-block caps and the total ceiling', () => {
    const state = makeState();
    state.scene.framing = 'x'.repeat(40000);
    state.player.personaNotes = 'y'.repeat(40000);
    state.factions.petrabyte.goals = ['z'.repeat(40000)];

    const result = renderContext(state, {
        settings: settingsWith(),
        season: SEASON,
        tokenBudget: {
            total: 200,
            scene: 120,
            cast: 60,
            player: 60,
            world: 60,
            continuity: 40,
            lore: 40,
            characterProfile: 40,
        },
        loreEntries: ['q'.repeat(40000)],
    });

    assert.ok(result.totalTokens <= 200, `total ${result.totalTokens} exceeded 200`);
    assert.ok(result.tokens <= 200);
    assert.ok(blockById(result, 'scene'), 'the highest-priority block survives');
    assert.ok(result.dropped.includes('lore'), 'lowest-priority block drops first');
    const caps = { scene: 120, cast: 60, player: 60, world: 60, continuity: 40, lore: 40 };
    for (const block of result.blocks) {
        assert.ok(block.tokens <= caps[block.id], `${block.id} exceeded its cap`);
    }
});

test('budget truncates a single oversized block to the ceiling', () => {
    const block = {
        id: 'scene',
        heading: '[NEOTERRA_SCENE]',
        body: 'a'.repeat(10000),
        priority: BLOCK_PRIORITY.scene,
    };
    const result = applyTokenBudget([block], {
        total: 50,
        scene: 1000,
    });
    assert.ok(result.totalTokens <= 50);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].tokens <= 50);
    assert.equal(result.text, result.blocks[0].text);
    assert.ok(result.truncated.includes('scene'));
});

test('token helpers are deterministic and never overrun', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);

    const cut = truncateToTokens('word '.repeat(100), 10);
    assert.equal(cut.truncated, true);
    assert.ok(estimateTokens(cut.text) <= 10);
    assert.match(cut.text, /…$/);
    assert.equal(truncateToTokens('short', 10).text, 'short');
    assert.equal(truncateToTokens('short', 0).text, '');
});

test('character profiles are trimmed and optionally gated', () => {
    const character = makeCharacter(HERO, {
        displayName: 'Vaiva Colorgarde',
        appearance: 'A'.repeat(6000),
        agenda: 'They had explicit sex. Protect the city.',
    });
    const profile = buildCharacterProfile({
        entry: { id: HERO, displayName: 'Vaiva Colorgarde', side: 'hero', formKind: 'base' },
        character,
        maxTokens: 80,
        gateLevel: 'strict',
    });
    assert.equal(profile.characterId, HERO);
    assert.ok(profile.tokens <= 80);
    assert.equal(profile.truncated, true);
    assert.doesNotMatch(profile.text, /explicit sex/i);

    const profiles = buildCastProfiles([character, makeCharacter(VILLAIN)], {
        maxTokens: 120,
        totalTokens: 100,
    });
    assert.equal(profiles.length, 2);
    for (const entry of profiles) {
        assert.ok(entry.tokens <= 50);
    }
});

test('the scene block ignores an encounter recorded for another location', () => {
    const state = {
        chatId: 'c1',
        seasonId: 's1',
        playerRole: 'hero',
        player: { identity: 'custom', displayName: 'Player', characterId: null },
        characters: { 'c.v': { charId: 'c.v', displayName: 'Claire', side: 'villain', controlledBy: 'npc', alive: true } },
        locations: { 'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Hub', factionId: null, status: 'quiet' } },
        factions: {},
        threats: [],
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [],
        scene: {
            locationId: 'loc.a',
            present: ['c.v'],
            combat: null,
            framing: '',
            encounter: { locationId: 'loc.other', characterIds: ['c.v'], threatNames: ['Glass Cartel'], source: 'travel' },
        },
        meta: { turn: 1, inGameDate: '2038-01-01', timeOfDay: 'night', sceneId: 'opening', inCombat: false },
        flags: {},
        log: [],
    };
    const result = renderContext(state, { settings: cloneDefaults() });
    const scene = result.blocks.find((block) => block.id === 'scene');
    assert.ok(scene);
    assert.doesNotMatch(scene.body, /Encounter:/);
    assert.doesNotMatch(scene.body, /Threats here:/);
});

test('the scene block drops the encounter lines with the block', () => {
    const state = {
        chatId: 'c1',
        seasonId: 's1',
        playerRole: 'hero',
        player: { identity: 'custom', displayName: 'Player', characterId: null },
        characters: { 'c.v': { charId: 'c.v', displayName: 'Claire', side: 'villain', controlledBy: 'npc', alive: true } },
        locations: { 'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Hub', factionId: null, status: 'quiet' } },
        factions: {},
        threats: [],
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [],
        scene: {
            locationId: 'loc.a',
            present: ['c.v'],
            combat: null,
            framing: '',
            encounter: { locationId: 'loc.a', characterIds: ['c.v'], threatNames: ['Glass Cartel'], source: 'travel' },
        },
        meta: { turn: 1, inGameDate: '2038-01-01', timeOfDay: 'night', sceneId: 'opening', inCombat: false },
        flags: {},
        log: [],
    };
    const settings = cloneDefaults();
    const result = renderContext(state, { settings });
    const scene = result.blocks.find((block) => block.id === 'scene');
    assert.ok(scene);
    assert.match(scene.body, /Encounter: Claire/);
    assert.match(scene.body, /Threats here: Glass Cartel/);
    assert.ok(scene.tokens <= result.totalTokens);

    // Token budget: a scene block granted no tokens is dropped, not leaked.
    const tiny = { ...settings, tokenBudget: { ...settings.tokenBudget, scene: 0 } };
    const squeezed = renderContext(state, { settings: tiny });
    assert.equal(squeezed.blocks.some((block) => block.id === 'scene'), false);
    assert.equal(squeezed.dropped.includes('scene'), true);
    assert.doesNotMatch(squeezed.text, /Threats here/);
});

test('interceptor injects exactly one tagged message and is idempotent', async () => {
    const settings = settingsWith();
    const state = makeState();
    const chat = [
        { name: 'User', mes: 'Hello', is_user: true },
        { name: 'Neo Terra', mes: 'Old block', is_user: false, extra: { neoterra: { context: true } } },
        { name: 'Assistant', mes: 'Welcome', is_user: false },
    ];
    const intercept = createGenerationInterceptor({
        getContext: () => ({ chatMetadata: { neoterra: { worldState: state, season: SEASON } } }),
        getSettings: () => settings,
    });

    await intercept(chat, 4096, () => {}, 'normal');
    assert.equal(chat.filter(isContextMessage).length, 1);
    const message = chat.find(isContextMessage);
    assert.equal(message.extra.type, 'narrator');
    assert.equal(message.extra.neoterra.context, true);
    assert.match(message.mes, /\[NEOTERRA_SCENE\]/);
    assert.ok(message.mes.includes('[NEOTERRA_PLAYER]'));
    assert.equal(message.is_user, false);

    await intercept(chat, 4096, () => {}, 'swipe');
    assert.equal(chat.filter(isContextMessage).length, 1, 'a second run replaces, not duplicates');
});

test('interceptor inserts at the configured depth and strips stale blocks', async () => {
    const settings = settingsWith();
    settings.context.depth = 2;
    const chat = [
        { name: 'a', mes: '1', is_user: true },
        { name: 'b', mes: '2', is_user: false },
        { name: 'Neo Terra', mes: 'stale', is_user: false, extra: { neoterra: { context: true } } },
        { name: 'c', mes: '3', is_user: true },
    ];
    const intercept = createGenerationInterceptor({
        getContext: () => ({ chatMetadata: { neoterra: { worldState: makeState(), season: SEASON } } }),
        getSettings: () => settings,
    });
    await intercept(chat, 4096, () => {}, 'normal');
    assert.equal(chat.filter(isContextMessage).length, 1);
    assert.equal(chat.indexOf(chat.find(isContextMessage)), 1);
    assert.equal(chat.filter((message) => message.mes === 'stale').length, 0);

    const off = settingsWith();
    off.context.enabled = false;
    const disabledIntercept = createGenerationInterceptor({
        getContext: () => ({ chatMetadata: { neoterra: { worldState: makeState(), season: SEASON } } }),
        getSettings: () => off,
    });
    await disabledIntercept(chat, 4096, () => {}, 'normal');
    assert.equal(chat.filter(isContextMessage).length, 0);
});

test('interceptor is a safe no-op without state and never throws', async () => {
    const settings = settingsWith();
    const chat = [
        { name: 'User', mes: 'Hello', is_user: true },
        { name: 'Neo Terra', mes: 'stale', is_user: false, extra: { neoterra: { context: true } } },
    ];
    const intercept = createGenerationInterceptor({
        getContext: () => ({}),
        getSettings: () => settings,
        getWorldState: () => null,
    });
    await intercept(chat, 4096, () => {}, 'normal');
    assert.equal(chat.length, 1);
    assert.equal(chat.filter(isContextMessage).length, 0);

    const throwing = createGenerationInterceptor({
        getContext: () => ({}),
        getSettings: () => settings,
        getWorldState: () => makeState(),
        render: () => {
            throw new Error('boom');
        },
    });
    await assert.doesNotReject(throwing(chat, 4096, () => {}, 'normal'));
    assert.equal(chat.filter(isContextMessage).length, 0);
});

test('injectContextPrompt and stripContextPrompt are defensive and idempotent', () => {
    assert.throws(() => injectContextPrompt(null, 'text'), TypeError);
    const chat = [];
    assert.equal(injectContextPrompt(chat, ''), null);
    assert.equal(chat.length, 0);

    injectContextPrompt(chat, 'one');
    injectContextPrompt(chat, 'two');
    assert.equal(chat.length, 1);
    assert.equal(chat[0].mes, 'two');
    assert.equal(stripContextPrompt(chat), 1);
    assert.equal(stripContextPrompt(chat), 0);
    assert.equal(stripContextPrompt(null), 0);
});

test('interceptor registration and manifest avoid setExtensionPrompt double injection', () => {
    assert.equal(typeof neoTerraGenerateInterceptor, 'function');
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal(manifest.generate_interceptor, 'neoTerraGenerateInterceptor');

    const source = readFileSync(join(ROOT, 'src/context/interceptor.js'), 'utf8');
    assert.doesNotMatch(source, /setExtensionPrompt\s*\(/);
});

test('renderer accepts registry data and never leaks map coordinates', () => {
    const state = makeState();
    const registry = {
        entries: [
            {
                id: HERO,
                displayName: 'Vaiva Colorgarde',
                aliases: [],
                side: 'hero',
                threatLevel: 'High',
                formRole: 'base',
                altOf: null,
                formKind: 'base',
                formGroup: null,
                tags: [],
                bundle: false,
                actors: null,
                npcEligible: true,
                seasonId: 's1',
            },
        ],
    };
    const result = renderContext(state, {
        settings: settingsWith(),
        season: SEASON,
        registry,
    });
    const text = result.text;
    assert.doesNotMatch(text, /\b(?:x|y)\s*[:=]\s*\d+/);
    assert.doesNotMatch(text, /2017|1512|NeoTerra\.png/);
    assert.match(text, /Vaiva Colorgarde/);
});

test('content gate prompt helper is re-exported from the renderer surface', () => {
    assert.match(applyContentGateToPrompt('Prompt', 'strict'), /Content gate|CONTENT_GATE/);
    assert.equal(applyContentGate('unchanged', 'full'), 'unchanged');
    assert.equal(BLOCK_HEADINGS.cast, '[NEOTERRA_CAST]');
    assert.equal(CONTEXT_MARKER, 'neoterra.context');
});
