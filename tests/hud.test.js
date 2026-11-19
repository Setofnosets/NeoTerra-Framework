import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    HUD_ACTIONS,
    HUD_MIN_HEIGHT,
    buildHudView,
    clampHudGeometry,
    renderHudMarkup,
    resolveHudMode,
} from '../src/ui/hud.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');

function worldState(overrides = {}) {
    return {
        schemaVersion: 2,
        seasonId: 's1',
        playerRole: 'hero',
        meta: {
            turn: 7,
            storyTurn: 5,
            inGameDate: '2031-04-12',
            timeOfDay: 'evening',
            inCombat: false,
        },
        scene: { locationId: 'central-plaza', present: ['s1.vaiva.vaiva', 's1.kai'] },
        locations: { 'central-plaza': { name: 'Central Plaza' } },
        characters: {
            's1.vaiva.vaiva': {
                charId: 's1.vaiva.vaiva',
                displayName: 'Vaiva',
                formId: 's1.vaiva.vaiva',
                status: 'active',
                stamina: { current: 8, max: 10 },
                willpower: { current: 3, max: 6 },
                corruption: { stage: 1, progress: 30 },
            },
            's1.kai': {
                charId: 's1.kai',
                displayName: 'Kai',
                status: 'active',
            },
        },
        threats: [
            {
                id: 's1.main.clarity',
                name: 'The Clarity Signal',
                rank: 'main',
                status: 'active',
                stage: 1,
                stages: ['whisper', 'broadcast', 'dominion'],
                progress: 42,
            },
        ],
        beats: { 's1.opening.first-move': { status: 'open', deadlineTurns: 9 } },
        badEnds: {},
        relationships: [],
        recentEvents: [{ turn: 3, summary: 'Vaiva was spotted at the plaza.' }],
        player: { identity: 'canon', characterId: 's1.vaiva.vaiva' },
        flags: {},
        ...overrides,
    };
}

const season = {
    id: 's1',
    title: 'Season 1 — Emergence',
    era: '2031',
    premise: 'The city wakes up to something new.',
    canonBeats: [
        { id: 's1.opening.first-move', title: 'First Move', act: 'opening', order: 10 },
    ],
};

test('buildHudView summarizes the live world and hides on no world', () => {
    const view = buildHudView({ state: worldState(), season });
    assert.ok(view);
    assert.equal(view.visible, true);
    assert.equal(view.title, 'Season 1 — Emergence');
    assert.equal(view.act, 'opening');
    assert.equal(view.location.name, 'Central Plaza');
    assert.equal(view.player.name, 'Vaiva');
    assert.equal(view.threat.name, 'The Clarity Signal');
    assert.equal(view.beat.title, 'First Move');
    assert.equal(view.beat.deadline.label, '4 turns left');
    assert.deepEqual(view.resources.map((resource) => resource.id), ['stamina', 'willpower']);
    assert.equal(view.resources[0].percent, 80);
    assert.equal(view.corruption.progress, 30);
    assert.deepEqual(view.present.map((entry) => entry.name), ['Kai']);

    assert.equal(buildHudView({ state: null, season }), null);
});

test('the HUD exposes gameplay actions only', () => {
    const view = buildHudView({ state: worldState(), season });
    const ids = view.actions.map((action) => action.id);
    assert.deepEqual(ids, ['map', 'characters', 'player', 'journal', 'newspaper']);
    for (const forbidden of ['settings', 'export', 'import', 'agents', 'diagnostics']) {
        assert.equal(ids.includes(forbidden), false, `${forbidden} must not be a HUD action`);
    }
    assert.equal(HUD_ACTIONS.length, 5);
    assert.deepEqual(
        view.downtimeActions.map((action) => action.id),
        ['rest', 'train', 'patrol', 'investigate', 'socialize', 'work'],
    );
});

test('collapsed state comes from settings', () => {
    const view = buildHudView({
        state: worldState(),
        season,
        settings: { ui: { hudCollapsed: true } },
    });
    assert.equal(view.collapsed, true);
});

test('clampHudGeometry keeps the rail on screen', () => {
    const tall = clampHudGeometry({ top: 900, height: 900 }, { width: 1280, height: 800 });
    assert.equal(tall.height <= 800, true);
    assert.equal(tall.top + tall.height <= 800, true);

    const short = clampHudGeometry({ top: -50, height: 100 }, { width: 1280, height: 800 });
    assert.equal(short.top >= 0, true);
    assert.equal(short.height >= HUD_MIN_HEIGHT, true);
    assert.equal(short.top + short.height <= 800, true);
});

test('resolveHudMode uses the rail on desktop and a sheet on mobile', () => {
    assert.equal(resolveHudMode({ width: 1440 }), 'rail');
    assert.equal(resolveHudMode({ width: 390 }), 'sheet');
});

test('renderHudMarkup renders meters, threat, present cast, and actions', () => {
    const view = buildHudView({ state: worldState(), season });
    const markup = renderHudMarkup(view);
    assert.match(markup, /data-neoterra-hud-toggle/);
    assert.match(markup, /data-neoterra-hud-meter="stamina"/);
    assert.match(markup, /The Clarity Signal/);
    assert.match(markup, /data-neoterra-hud-action="map"/);
    assert.match(markup, /data-neoterra-hud-action="newspaper"/);
    assert.doesNotMatch(markup, /data-neoterra-hud-action="settings"/);
    assert.doesNotMatch(markup, /Reset Neo Terra settings/);
});

test('missing player and malformed meters degrade without throwing', () => {
    assert.equal(buildHudView({ state: { meta: {}, scene: {} }, season }), null);
    const malformed = worldState();
    malformed.characters['s1.vaiva.vaiva'].stamina = { current: 'x', max: null };
    const view = buildHudView({ state: malformed, season });
    assert.ok(view);
    assert.equal(Number.isFinite(view.resources[0].percent), true);
});

test('beat deadlines use the fiction turn and handle passed/date-only beats', () => {
    const passed = worldState({ meta: { ...worldState().meta, storyTurn: 12 } });
    assert.equal(buildHudView({ state: passed, season }).beat.deadline.label, 'Deadline passed');

    const dated = worldState({
        beats: { 's1.opening.first-move': { status: 'open', deadlineDate: '2031-05-01' } },
    });
    assert.equal(buildHudView({ state: dated, season }).beat.deadline.label, 'By 2031-05-01');
});

test('clampHudGeometry tolerates a tiny or missing viewport', () => {
    const tiny = clampHudGeometry({ top: 900, height: 900 }, { width: 320, height: 180 });
    assert.equal(tiny.top >= 0, true);
    assert.equal(tiny.height > 0, true);
    assert.equal(tiny.top + tiny.height <= 180, true);

    const fallback = clampHudGeometry({}, {});
    assert.equal(Number.isFinite(fallback.top), true);
    assert.equal(Number.isFinite(fallback.height), true);
});

test('the HUD view filters the player out of the present row', () => {
    const view = buildHudView({ state: worldState(), season });
    assert.deepEqual(view.present.map((entry) => entry.name), ['Kai']);
    assert.deepEqual(view.presentIds, ['s1.kai']);
});

test('the HUD stylesheet ships rail, sheet, and collapsed rules', () => {
    assert.match(css, /\.neoterra-hud\s*\{/);
    assert.match(css, /\.neoterra-hud-inner\[data-collapsed='true'\] \.neoterra-hud-body\s*\{[^}]*display:\s*none/);
    assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.neoterra-hud\s*\{/);
});
