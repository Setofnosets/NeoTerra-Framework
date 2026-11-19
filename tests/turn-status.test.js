import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TURN_STAGE_ORDER,
    applyTurnStage,
    createStageState,
    renderTurnStatusMarkup,
    summarizeTurnStatus,
} from '../src/ui/turn-status.js';
import { buildErrorToasts, diffWorldState, renderToastMarkup } from '../src/ui/toasts.js';
import { runTurnPipeline } from '../src/agents/state-tracker.js';

function state(overrides = {}) {
    return {
        seasonId: 's1',
        meta: { turn: 1 },
        scene: { present: [] },
        characters: {},
        relationships: [],
        recentEvents: [],
        flags: {},
        player: { identity: 'custom', displayName: 'Hero', stamina: 10, willpower: 5 },
        ...overrides,
    };
}

test('stage events fold into a running/done/failed model', () => {
    let tracker = createStageState();
    tracker = applyTurnStage(tracker, { stage: 'clock', status: 'start' }, 1000);
    assert.equal(tracker.events.clock.status, 'running');
    assert.equal(tracker.startedAt, 1000);
    tracker = applyTurnStage(tracker, { stage: 'clock', status: 'done' }, 1200);
    assert.equal(tracker.events.clock.status, 'done');
    assert.equal(tracker.events.clock.endedAt - tracker.events.clock.startedAt, 200);
    tracker = applyTurnStage(tracker, { stage: 'tracker', status: 'failed', error: 'timeout' }, 1500);
    assert.equal(tracker.events.tracker.status, 'failed');
    assert.equal(tracker.events.tracker.error, 'timeout');
    assert.equal(applyTurnStage(tracker, { stage: 'nope', status: 'start' }, 1), tracker);
});

test('summarizeTurnStatus reports the running stage, failure, and timeout', () => {
    let tracker = createStageState();
    tracker = applyTurnStage(tracker, { stage: 'clock', status: 'start' }, 1000);
    tracker = applyTurnStage(tracker, { stage: 'clock', status: 'done' }, 1100);
    tracker = applyTurnStage(tracker, { stage: 'tracker', status: 'start' }, 1200);
    const running = summarizeTurnStatus(tracker, { now: 1400, timeoutMs: 5000 });
    assert.equal(running.visible, true);
    assert.equal(running.current, 'tracker');
    assert.match(running.detail, /Tracking the world/);
    assert.equal(running.failed, false);

    const failed = summarizeTurnStatus(
        applyTurnStage(tracker, { stage: 'tracker', status: 'failed', error: 'boom' }, 1500),
        { now: 1600 },
    );
    assert.equal(failed.failed, true);
    assert.match(failed.detail, /failed/);

    const stale = summarizeTurnStatus(tracker, { now: 100000, timeoutMs: 5000 });
    assert.equal(stale.stale, true);

    const finished = summarizeTurnStatus(tracker, { now: 2000, finished: true, lingerMs: 1200 });
    assert.equal(finished.visible, true);
    const gone = summarizeTurnStatus(tracker, { now: 5000, finished: true, lingerMs: 1200 });
    assert.equal(gone.visible, false);
});

test('the chip markup never renders when invisible', () => {
    const markup = renderTurnStatusMarkup({
        visible: true,
        title: 'Director is updating',
        detail: 'Tracking the world…',
        stages: [{ id: 'tracker', label: 'Tracking the world', status: 'running' }],
        failed: false,
        stale: false,
    });
    assert.match(markup, /data-neoterra-turn-status/);
    assert.match(markup, /Tracking the world/);
    assert.equal(renderTurnStatusMarkup({ visible: false }), '');
});

test('runTurnPipeline reports skipped stages without a tracker or clock tick', async () => {
    const events = [];
    const result = await runTurnPipeline({
        store: { get: () => state(), dispatch: () => {} },
        tickTurns: 0,
        getSettings: () => ({ pacing: { enabled: false }, agents: { stateTracker: { enabled: false } } }),
        onStage: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    const statuses = Object.fromEntries(events.map((event) => [event.stage, event.status]));
    assert.equal(statuses.clock, 'skipped');
    assert.equal(statuses.pacing, 'skipped');
    assert.equal(statuses.tracker, 'skipped');
    assert.equal(statuses.storyline, 'skipped');
    assert.equal(statuses.cast, 'skipped');
    assert.deepEqual(TURN_STAGE_ORDER.includes('choices'), true);
});

test('a throwing onStage observer never breaks the turn', async () => {
    const result = await runTurnPipeline({
        store: { get: () => state(), dispatch: () => {} },
        tickTurns: 0,
        getSettings: () => ({ pacing: { enabled: false }, agents: { stateTracker: { enabled: false } } }),
        onStage: () => { throw new Error('observer failed'); },
    });
    assert.equal(result.ok, true);
});

test('diffWorldState batches meters, corruption, rumor, cast, form, relationship, and newspaper', () => {
    const before = state({
        player: { identity: 'canon', characterId: 'a' },
        characters: {
            a: { charId: 'a', displayName: 'A', formId: 'a.base', stamina: { current: 8, max: 10 } },
            b: { charId: 'b', displayName: 'B', formId: 'b.base' },
        },
        scene: { present: ['a'] },
        relationships: [{ a: 'a', b: 'b', type: 'rival', affinity: -10, tension: 20 }],
        flags: { newsroom: { editions: [{ date: '2031-01-01' }] } },
    });
    const after = state({
        player: { identity: 'canon', characterId: 'a' },
        characters: {
            a: { charId: 'a', displayName: 'A', formId: 'a.shade', stamina: { current: 4, max: 10 }, corruption: { stage: 2, progress: 40 } },
            b: { charId: 'b', displayName: 'B', formId: 'b.base' },
        },
        scene: { present: ['b'] },
        relationships: [{ a: 'a', b: 'b', type: 'ally', affinity: 10, tension: 5 }],
        recentEvents: [{ turn: 2, summary: 'A rumor spreads.', tags: ['offscreen', 'tick'] }],
        flags: { newsroom: { editions: [{ date: '2031-01-01' }, { date: '2031-01-02' }] } },
    });
    const toasts = diffWorldState(before, after);
    const types = new Set(toasts.map((toast) => toast.type));
    for (const type of ['resource', 'corruption', 'rumor', 'cast-arrival', 'cast-departure', 'form', 'relationship', 'newspaper']) {
        assert.equal(types.has(type), true, `expected a ${type} toast`);
    }
    assert.equal(new Set(toasts.map((toast) => toast.id)).size, toasts.length);
    assert.equal(diffWorldState(before, before).length, 0);
});

test('error toasts and markup are renderable', () => {
    const errors = buildErrorToasts([{ stage: 'tracker', error: 'timeout' }], { detailsHref: '#log' });
    assert.equal(errors.length, 1);
    assert.match(renderToastMarkup(errors[0]), /timeout/);
    assert.match(renderToastMarkup(errors[0]), /href="#log"/);
});
