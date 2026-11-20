import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createInitiative,
    shouldRunAuditor,
    shouldRunCastDirector,
    shouldRunLore,
} from '../src/flows/initiative.js';
import { runTurnPipeline } from '../src/agents/state-tracker.js';
import { createSceneFlow } from '../src/flows/scene.js';
import { createTravelFlow } from '../src/flows/travel.js';
import { createBadEndFlow } from '../src/flows/bad-end.js';
import { createWorldStateStore } from '../src/state/store.js';
import { AGENT_IDS } from '../src/core/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const regions = readJson('data/map/regions.geojson');
const bridges = readJson('data/map/bridges.geojson');
const overrides = readJson('data/map/overrides.json');
const season = readJson('data/seasons/s1.json');
const CONTEXT = { registry, factions, locations, formGroups, formRules };
const SOURCES = { locations, generated: { regions, bridges }, overrides };

function makeStore() {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: 'agent-wiring-test-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
        now: () => NOW,
    });
    store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'agent-wiring-test-chat',
        player: { identity: 'custom', displayName: 'Alex' },
        now: NOW,
    });
    return store;
}

function settingsWith(agentId, overrides = {}) {
    return {
        agents: {
            [agentId]: { enabled: true, ...overrides },
        },
    };
}

/* ------------------------------------------------------------------ */
/* Cadence helpers                                                     */
/* ------------------------------------------------------------------ */

test('cast director cadence runs on first use, scene changes, and every N turns', () => {
    const state = makeStore().get();
    const settings = settingsWith('castDirector', { cadence: 'sceneChange', everyNTurns: 4 });

    assert.equal(shouldRunCastDirector({ state, settings }).run, true);
    assert.equal(shouldRunCastDirector({ state, settings, trigger: 'location' }).run, true);

    const fresh = {
        ...state,
        meta: { ...state.meta, turn: 2 },
        flags: {
            ...state.flags,
            castDirector: { lastRunTurn: 2, lastLocationId: state.scene.locationId },
        },
    };
    assert.equal(shouldRunCastDirector({ state: fresh, settings, turn: 3 }).run, false);
    assert.equal(shouldRunCastDirector({ state: fresh, settings, turn: 6 }).run, true);

    const moved = {
        ...fresh,
        scene: { ...fresh.scene, locationId: 'maple-heights' },
    };
    assert.equal(shouldRunCastDirector({ state: moved, settings, turn: 3 }).run, true);
    assert.equal(shouldRunCastDirector({
        state: fresh,
        settings: settingsWith('castDirector', { enabled: false }),
        turn: 99,
    }).run, false);
});

test('lore cadence runs every N turns and on an act change', () => {
    const state = makeStore().get();
    const settings = settingsWith('lore', { everyNTurns: 10 });

    assert.equal(shouldRunLore({ state, settings, season }).run, true);

    const fresh = {
        ...state,
        meta: { ...state.meta, turn: 5 },
        flags: { ...state.flags, lore: { lastRunTurn: 5, lastRunAct: 'opening' } },
    };
    assert.equal(shouldRunLore({ state: fresh, settings, season, turn: 9 }).run, false);
    assert.equal(shouldRunLore({ state: fresh, settings, season, turn: 15 }).run, true);

    const movedAct = {
        ...fresh,
        flags: { ...fresh.flags, lore: { lastRunTurn: 5, lastRunAct: 'climax' } },
    };
    assert.equal(shouldRunLore({ state: movedAct, settings, season, turn: 6 }).run, true);
    assert.equal(shouldRunLore({
        state: fresh,
        settings: settingsWith('lore', { enabled: false }),
        season,
        turn: 99,
    }).run, false);
});

test('auditor cadence runs at act boundaries and then waits', () => {
    const state = makeStore().get();
    const settings = settingsWith('auditor', { cadence: 'actChange' });

    assert.equal(shouldRunAuditor({ state, settings, season }).run, true);

    const fresh = {
        ...state,
        flags: { ...state.flags, auditor: { lastRunAct: 'opening', lastRunTurn: 3 } },
    };
    assert.equal(shouldRunAuditor({ state: fresh, settings, season, turn: 50 }).run, false);
    assert.equal(shouldRunAuditor({ state: fresh, settings, season, trigger: 'act' }).run, true);
    assert.equal(shouldRunAuditor({
        state: fresh,
        settings: settingsWith('auditor', { enabled: false }),
        season,
        trigger: 'act',
    }).run, false);
});

/* ------------------------------------------------------------------ */
/* Initiative: Lore and Auditor                                        */
/* ------------------------------------------------------------------ */

test('a Lore pass writes a journal recap and skips before its cadence is due', async () => {
    const store = makeStore();
    let calls = 0;
    const lore = {
        run: async () => {
            calls += 1;
            return {
                entries: [{ title: 'The Docks', content: 'A deal went wrong.' }],
                recap: 'Previously: a deal went wrong at the docks.',
                selections: [],
                relationshipEvents: [],
                source: 'agent',
            };
        },
    };
    const initiative = createInitiative({
        store,
        season,
        lore,
        getSettings: () => settingsWith('lore', { everyNTurns: 10 }),
        now: () => NOW,
    });

    const first = await initiative.runLore({ recentProse: 'The docks burned.' });
    assert.equal(first.ran, true);
    assert.equal(calls, 1);
    assert.equal(
        store.get().flags.lore.recap,
        'Previously: a deal went wrong at the docks.',
    );
    assert.equal(store.get().flags.lore.lastRunTurn, store.get().meta.turn);

    const second = await initiative.runLore({ recentProse: 'Still at the docks.' });
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'not-due');
    assert.equal(calls, 1);
});

test('Lore never calls the agent when disabled', async () => {
    const store = makeStore();
    let calls = 0;
    const initiative = createInitiative({
        store,
        season,
        lore: { run: async () => { calls += 1; return { entries: [] }; } },
        getSettings: () => settingsWith('lore', { enabled: false }),
        now: () => NOW,
    });
    const result = await initiative.runLore({ force: true });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(calls, 0);
    assert.equal(store.get().flags.lore?.recap ?? null, null);
});

test('an Auditor pass records findings at the act boundary and is independently disableable', async () => {
    const store = makeStore();
    let calls = 0;
    const auditor = {
        run: async () => {
            calls += 1;
            return {
                findings: [{ severity: 'warning', code: 'continuity', message: 'A suspect timeline.' }],
                summary: { errors: 0, warnings: 1, info: 0 },
                source: 'agent',
            };
        },
    };
    const initiative = createInitiative({
        store,
        season,
        auditor,
        getSettings: () => settingsWith('auditor', { cadence: 'actChange' }),
        now: () => NOW,
    });

    const first = await initiative.runAudit({ recentProse: 'The act turns.' });
    assert.equal(first.ran, true);
    assert.equal(calls, 1);
    assert.equal(store.get().flags.auditor.findings.length, 1);
    assert.equal(store.get().flags.auditor.lastRunAct, 'opening');

    const second = await initiative.runAudit({ recentProse: 'Still opening.' });
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'not-act-boundary');
    assert.equal(calls, 1);

    const disabled = createInitiative({
        store,
        season,
        auditor: { run: async () => { calls += 1; return { findings: [] }; } },
        getSettings: () => settingsWith('auditor', { enabled: false }),
        now: () => NOW,
    });
    const skipped = await disabled.runAudit({ trigger: 'act' });
    assert.equal(skipped.ran, false);
    assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ */
/* Scene + travel wiring                                               */
/* ------------------------------------------------------------------ */

test('the scene flow calls the Cast Director when asked and records the pass', async () => {
    const store = makeStore();
    let calls = 0;
    const director = {
        run: async ({ state }) => {
            calls += 1;
            assert.ok(state, 'the director receives the current WorldState');
            return { events: [], rejected: [], source: 'agent' };
        },
    };
    const scene = createSceneFlow({
        store,
        season,
        director,
        getSettings: () => ({}),
        now: () => NOW,
    });

    await scene.refreshCast({ runDirector: true });
    assert.equal(calls, 1);
    const flags = store.get().flags.castDirector;
    assert.equal(flags.lastRunTurn, store.get().meta.turn);
    assert.equal(flags.lastLocationId, store.get().scene.locationId);

    // A second pass with the director disabled must not advance the marker.
    const marker = { ...flags };
    await scene.refreshCast({ runDirector: false });
    assert.equal(calls, 1);
    assert.equal(store.get().flags.castDirector.lastRunTurn, marker.lastRunTurn);
    assert.equal(store.get().flags.castDirector.lastLocationId, marker.lastLocationId);
});

test('travel asks the scene for a director pass when the agent is enabled and configured', async () => {
    const store = makeStore();
    let calls = 0;
    const director = {
        run: async () => {
            calls += 1;
            return { events: [], rejected: [], source: 'agent' };
        },
    };
    const scene = createSceneFlow({
        store,
        season,
        director,
        getSettings: () => ({}),
        now: () => NOW,
    });
    const travel = createTravelFlow({
        store,
        season,
        scene,
        sources: SOURCES,
        getSettings: () => settingsWith('castDirector'),
        now: () => NOW,
    });

    const result = await travel.travel({ to: 'maple-heights' });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal(store.get().flags.castDirector.lastRunTurn, store.get().meta.turn);

    // Disabled means zero calls even on arrival.
    const secondStore = makeStore();
    let secondCalls = 0;
    const secondScene = createSceneFlow({
        store: secondStore,
        season,
        director: { run: async () => { secondCalls += 1; return { events: [], rejected: [], source: 'agent' }; } },
        getSettings: () => ({}),
        now: () => NOW,
    });
    const secondTravel = createTravelFlow({
        store: secondStore,
        season,
        scene: secondScene,
        sources: SOURCES,
        getSettings: () => settingsWith('castDirector', { enabled: false }),
        now: () => NOW,
    });
    const second = await secondTravel.travel({ to: 'maple-heights' });
    assert.equal(second.ok, true);
    assert.equal(secondCalls, 0);
});

test('the turn pipeline requests a director pass only on its cadence', async () => {
    const seen = [];
    const store = makeStore();
    const result = await runTurnPipeline({
        store,
        tickTurns: 0,
        getSettings: () => ({
            pacing: { enabled: false },
            agents: {
                stateTracker: { enabled: false },
                castDirector: { enabled: true, cadence: 'sceneChange', everyNTurns: 4 },
            },
        }),
        scene: {
            refreshCast: async ({ runDirector }) => {
                seen.push(runDirector);
                return { applied: [] };
            },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [true]);
    assert.equal(result.castDirector.run, true);
});

test('a disabled bad-end flow makes zero detector calls', async () => {
    const store = makeStore();
    let calls = 0;
    const flow = createBadEndFlow({
        store,
        detector: {
            run: async () => {
                calls += 1;
                return { records: [] };
            },
        },
        getSettings: () => ({ badEnds: { enabled: false } }),
        now: () => NOW,
    });
    const report = await flow.detectAndRecord({ message: 'Nothing terminal happens.' });
    assert.equal(report.enabled, false);
    assert.equal(calls, 0);
    assert.equal(store.get().badEnds ? Object.keys(store.get().badEnds).length : 0, 0);
});

test('a bad-end agent toggle stops detection even when the feature is enabled', async () => {
    const store = makeStore();
    let calls = 0;
    const flow = createBadEndFlow({
        store,
        detector: { run: async () => { calls += 1; return { records: [] }; } },
        getSettings: () => ({ badEnds: { enabled: true }, agents: { badEnd: { enabled: false } } }),
        now: () => NOW,
    });
    const report = await flow.detectAndRecord({ message: 'Still nothing terminal.' });
    assert.equal(report.enabled, false);
    assert.equal(report.reason, 'agent-disabled');
    assert.equal(calls, 0);
});

test('an empty Lore pass preserves the previous journal recap', async () => {
    const store = makeStore();
    let call = 0;
    const lore = {
        run: async () => {
            call += 1;
            return call === 1
                ? { entries: [], recap: 'The first recap survives.', source: 'agent' }
                : { entries: [], recap: '', source: 'agent' };
        },
    };
    const initiative = createInitiative({
        store,
        season,
        lore,
        getSettings: () => settingsWith('lore', { everyNTurns: 10 }),
        now: () => NOW,
    });
    await initiative.runLore({ force: true });
    assert.equal(store.get().flags.lore.recap, 'The first recap survives.');
    await initiative.runLore({ force: true });
    assert.equal(store.get().flags.lore.recap, 'The first recap survives.');
});

test('the turn pipeline runs Lore and Auditor stages and reports them', async () => {
    const seen = [];
    const result = await runTurnPipeline({
        store: makeStore(),
        tickTurns: 0,
        getSettings: () => ({ pacing: { enabled: false } }),
        onStage: (event) => seen.push(`${event.stage}:${event.status}`),
        initiative: {
            runLore: async () => ({ ran: true, recap: 'A recap from the pipeline.' }),
            runAudit: async () => ({
                ran: true,
                findings: [{ severity: 'warning', message: 'A suspect timeline.' }],
                summary: { errors: 0, warnings: 1, info: 0 },
            }),
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.lore.ran, true);
    assert.equal(result.auditor.ran, true);
    assert.equal(result.auditor.findings.length, 1);
    assert.ok(seen.includes('lore:start'));
    assert.ok(seen.includes('lore:done'));
    assert.ok(seen.includes('auditor:start'));
    assert.ok(seen.includes('auditor:done'));
});

test('the Architect season-start pass is opt-in', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/core/defaults.js');
    assert.equal(DEFAULT_SETTINGS.agents.architect.seasonStart, false);
});

test('the scene describer is a registered, enabled, travel-cadenced agent', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/core/defaults.js');
    assert.ok(AGENT_IDS.includes('sceneDescriber'));
    const agent = DEFAULT_SETTINGS.agents.sceneDescriber;
    assert.equal(agent.enabled, true);
    assert.equal(agent.cadence, 'onTravel');
    assert.equal(agent.timeoutMs, 12000);
    assert.equal(agent.maxTokens, 320);
    assert.equal(agent.temperature, 0.85);
});


