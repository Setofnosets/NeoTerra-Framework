import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_DESCRIPTION_LENGTH,
    MAX_SENSORY,
    SCENE_DESCRIBER_SCHEMA,
    buildSceneDescriptionPrompt,
    createSceneDescriber,
    normalizeSceneDescription,
} from '../src/agents/scene-describer.js';

function sceneState(overrides = {}) {
    return {
        chatId: 'scene-chat',
        meta: { turn: 4, inGameDate: '2042-05-04', timeOfDay: 'night' },
        player: { identity: 'custom', characterId: null },
        characters: {
            'c.villain': {
                charId: 'c.villain',
                displayName: 'Claire',
                side: 'villain',
                mood: 'hostile',
                appearance: 'A tall figure in a wet coat.',
                controlledBy: 'npc',
            },
        },
        locations: {
            'loc.a': {
                id: 'loc.a',
                name: 'Maple Heights',
                district: 'West',
                status: 'hostile',
                factionId: 'f.iron',
                notes: 'Rain-slick rooftops and a dead neon sign.',
            },
        },
        factions: { 'f.iron': { id: 'f.iron', name: 'Iron Syndicate' } },
        scene: {
            locationId: 'loc.a',
            present: ['c.villain'],
            encounter: { locationId: 'loc.a', characterIds: ['c.villain'], threatNames: [] },
        },
        ...overrides,
    };
}

const season = {
    id: 's2',
    title: 'Long Live the Queen',
    toneNotes: 'Grim, romantic cyberpunk',
    premise: 'The city has a new queen.',
};

test('the prompt carries the location, time, cast, and encounter facts', () => {
    const prompt = buildSceneDescriptionPrompt({
        state: sceneState(),
        season,
        notice: { noticedFirst: true, ambush: true, actorName: 'Claire' },
        settings: {},
    });
    assert.match(prompt, /Maple Heights/);
    assert.match(prompt, /Iron Syndicate/);
    assert.match(prompt, /2042-05-04/);
    assert.match(prompt, /Claire/);
    assert.match(prompt, /Rain-slick rooftops/);
    assert.match(prompt, /"ambush":true/);
    assert.match(prompt, /Grim, romantic cyberpunk/);
    assert.doesNotMatch(prompt, /\[NEOTERRA_/);
});

test('a valid response is clamped and a broken one yields null', () => {
    const long = normalizeSceneDescription({
        description: 'x'.repeat(700),
        sensory: ['rain', 'neon', '', 'cold', 'too many'],
    });
    assert.equal(long.description.length, MAX_DESCRIPTION_LENGTH);
    assert.equal(long.sensory.length, MAX_SENSORY);
    assert.ok(long.sensory.every((entry) => entry.length <= 40));

    assert.equal(normalizeSceneDescription(null), null);
    assert.equal(normalizeSceneDescription({}), null);
    assert.equal(normalizeSceneDescription({ description: '   ', sensory: [] }), null);
    // Context blocks never survive into a frame.
    const stripped = normalizeSceneDescription({
        description: 'You arrive. [NEOTERRA_SCENE] secret state [/NEOTERRA_SCENE]',
        sensory: [],
    });
    assert.doesNotMatch(stripped.description, /\[NEOTERRA_/);
});

test('the agent returns prose, skips when disabled, and never throws on failure', async () => {
    let calls = 0;
    const runner = {
        runAgent: async ({ prompt, schema }) => {
            calls += 1;
            assert.equal(schema, SCENE_DESCRIBER_SCHEMA);
            assert.match(prompt, /Maple Heights/);
            return { value: { description: 'You step into the rain.', sensory: ['rain'] } };
        },
    };
    const agent = createSceneDescriber({ runner, getSettings: () => ({}) });
    const result = await agent.run({ state: sceneState(), season });
    assert.equal(result.ok, true);
    assert.equal(result.description, 'You step into the rain.');
    assert.deepEqual(result.sensory, ['rain']);

    const disabled = createSceneDescriber({
        runner,
        getSettings: () => ({ agents: { sceneDescriber: { enabled: false } } }),
    });
    const skipped = await disabled.run({ state: sceneState(), season });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.equal(calls, 1);

    const failing = createSceneDescriber({
        runner: { runAgent: async () => { throw new Error('model down'); } },
        getSettings: () => ({}),
    });
    const failed = await failing.run({ state: sceneState(), season });
    assert.equal(failed.ok, false);
    assert.equal(failed.description, null);

    const noRunner = createSceneDescriber({ runner: null, getSettings: () => ({}) });
    const none = await noRunner.run({ state: sceneState(), season });
    assert.equal(none.ok, false);
});
