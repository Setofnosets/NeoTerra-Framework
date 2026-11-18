import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NEWSPAPER_SCHEMA,
    buildNewspaperPrompt,
    createNewspaperAgent,
} from '../src/agents/newspaper.js';
import { DEFAULT_AGENT_PROMPTS } from '../src/agents/prompts.js';
import { AGENT_IDS } from '../src/core/constants.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { migrateSettings } from '../src/core/migrations.js';
import { buildDeterministicEdition } from '../src/data/newsroom.js';

function stateWithEvents() {
    const events = [
        { turn: 1, date: '2037-03-02', summary: 'A patrol vanishes.', tags: ['crime'], actors: [], locationId: 'central-plaza' },
        { turn: 2, date: '2037-03-02', summary: 'Clarity ships arms.', tags: ['faction'], actors: [], locationId: 'neon-docks' },
        { turn: 3, date: '2037-03-03', summary: 'A hero is seen.', tags: ['hero'], actors: [], locationId: 'petrabyte-tower' },
    ];
    return {
        seasonId: 's4',
        playerRole: 'hero',
        meta: { turn: 3, inGameDate: '2037-03-03', timeOfDay: 'evening' },
        scene: { locationId: 'central-plaza', present: [] },
        factions: {
            clarity: { id: 'clarity', name: 'Clarity Incorporated', side: 'villain', influence: 70, status: 'active' },
        },
        threats: [
            { id: 't', name: 'The Cold Front', rank: 'main', status: 'active', progress: 30, stage: 1 },
        ],
        recentEvents: [
            { turn: 0, date: '2037-03-01', summary: 'Season begins.', tags: ['season-start'], actors: [], locationId: 'central-plaza' },
            ...events,
        ],
        flags: {},
    };
}

const SETTINGS = {
    newspaper: { enabled: true, style: 'auto' },
    agents: { newspaper: { enabled: true } },
    contentGate: 'full',
};

test('newspaper is registered with defaults and a prompt in the same document', () => {
    assert.ok(AGENT_IDS.includes('newspaper'));
    assert.ok(DEFAULT_SETTINGS.agents.newspaper);
    assert.equal(typeof DEFAULT_AGENT_PROMPTS.newspaper, 'string');
    assert.ok(DEFAULT_AGENT_PROMPTS.newspaper.length > 20);
    // The normalizeAgents landmine: an old settings doc must not throw.
    const migrated = migrateSettings({ schemaVersion: 1, agents: { storyline: { enabled: false } } });
    assert.ok(migrated.agents.newspaper);
    assert.equal(migrated.agents.newspaper.enabled, true);
});

test('the prompt is grounded in events and world facts and respects the gate', () => {
    const state = stateWithEvents();
    const prompt = buildNewspaperPrompt({
        state,
        season: { id: 's4', title: 'The Cold Front', toneNotes: 'Cyberpunk melodrama.' },
        settings: SETTINGS,
        events: state.recentEvents.slice(1),
    });
    assert.match(prompt, /newspaper/);
    assert.match(prompt, /A patrol vanishes\./);
    assert.match(prompt, /Clarity Incorporated/);
    assert.match(prompt, /The Cold Front/);
    assert.match(prompt, /Title <= 90/);
    assert.match(prompt, /Response shape/);
    assert.ok(prompt.includes(JSON.stringify(NEWSPAPER_SCHEMA)));
});

test('plan uses the propose seam and falls back deterministically', () => {
    const state = stateWithEvents();
    const fallback = buildDeterministicEdition({ state, settings: SETTINGS });
    assert.ok(fallback);

    const agent = createNewspaperAgent({ getSettings: () => SETTINGS });
    const planned = agent.plan({
        state,
        season: null,
        propose: () => ({
            masthead: 'THE NEO TERRA GAZETTE',
            dateline: 'NEO TERRA — EVENING EDITION',
            headlines: [{ title: 'PATROL VANISHES', section: 'crime', lede: 'No trace.' }],
        }),
    });
    assert.equal(planned.source, 'agent');
    assert.equal(planned.calls, 1);
    assert.equal(planned.edition.headlines[0].title, 'PATROL VANISHES');

    const deterministic = agent.plan({ state, season: null, fallback });
    assert.equal(deterministic.source, 'deterministic');
    assert.equal(deterministic.calls, 0);
    assert.deepEqual(deterministic.edition, fallback);
});

test('run falls back when disabled, without a runner, or on failure', async () => {
    const state = stateWithEvents();
    const fallback = buildDeterministicEdition({ state, settings: SETTINGS });

    const disabled = createNewspaperAgent({ getSettings: () => ({ ...SETTINGS, agents: { newspaper: { enabled: false } } }) });
    const disabledResult = await disabled.run({ state, fallback });
    assert.equal(disabledResult.source, 'deterministic');
    assert.equal(disabledResult.calls, 0);

    const noRunner = createNewspaperAgent({ getSettings: () => SETTINGS });
    const noRunnerResult = await noRunner.run({ state, fallback });
    assert.equal(noRunnerResult.source, 'deterministic');

    const failing = createNewspaperAgent({
        getSettings: () => SETTINGS,
        runner: { runAgent: async () => { throw new Error('timeout'); } },
    });
    const failed = await failing.run({ state, fallback });
    assert.equal(failed.source, 'deterministic');
    assert.equal(failed.calls, 1);
    assert.match(failed.error, /timeout/);
    assert.deepEqual(failed.edition, fallback);
});

test('run returns the agent value on success', async () => {
    const state = stateWithEvents();
    const runner = {
        runAgent: async ({ agentId, schema }) => {
            assert.equal(agentId, 'newspaper');
            assert.ok(schema);
            return {
                masthead: 'THE WONDERLAND GAZETTE',
                dateline: 'NEO TERRA — EVENING EDITION',
                headlines: [{ title: 'KNIGHTS PATROL', section: 'faction', lede: 'The city watches.' }],
            };
        },
    };
    const agent = createNewspaperAgent({ runner, getSettings: () => SETTINGS });
    const result = await agent.run({ state });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'agent');
    assert.equal(result.edition.headlines[0].title, 'KNIGHTS PATROL');
});
