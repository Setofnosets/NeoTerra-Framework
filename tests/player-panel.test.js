import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlayerSheet, renderPlayerPanelMarkup } from '../src/ui/player-panel.js';

function customState(overrides = {}) {
    return {
        schemaVersion: 2,
        seasonId: 's1',
        playerRole: 'hero',
        meta: { turn: 3 },
        scene: { locationId: 'central-plaza' },
        locations: { 'central-plaza': { name: 'Central Plaza' } },
        characters: {},
        relationships: [],
        player: {
            identity: 'custom',
            displayName: 'Alex Mercer',
            stamina: { current: 80, max: 100 },
            willpower: { current: 4, max: 6 },
            status: 'active',
            skills: ['Parkour'],
            traits: ['Stubborn'],
            goals: ['Find the truth'],
            corruption: { stage: 1, progress: 25 },
            formId: null,
            ...overrides.player,
        },
        flags: {},
        ...overrides,
    };
}

test('buildPlayerSheet renders a custom persona sheet', () => {
    const sheet = buildPlayerSheet({
        state: customState(),
        season: { title: 'Season 1 — Emergence' },
        registry: { entries: [] },
    });

    assert.ok(sheet);
    assert.equal(sheet.identity, 'custom');
    assert.equal(sheet.displayName, 'Alex Mercer');
    assert.equal(sheet.initials, 'AM');
    assert.equal(sheet.playingAs, 'Playing as your custom persona');
    assert.equal(sheet.roleLabel, 'Hero');
    assert.equal(sheet.seasonTitle, 'Season 1 — Emergence');
    assert.equal(sheet.location, 'Central Plaza');
    assert.deepEqual(sheet.resources.map((resource) => [resource.id, resource.current, resource.max]), [
        ['stamina', 80, 100],
        ['willpower', 4, 6],
    ]);
    assert.equal(sheet.corruption.stage, 1);
    assert.equal(sheet.corruption.progress, 25);
    assert.deepEqual(sheet.skills, ['Parkour']);
    assert.deepEqual(sheet.goals, ['Find the truth']);
});

test('buildPlayerSheet renders a canon identity from the world characters', () => {
    const characterId = 's1.vaiva.vaiva';
    const state = customState({
        characters: {
            [characterId]: {
                charId: characterId,
                displayName: 'Vaiva',
                formId: characterId,
                formGroup: 'vaiva',
                status: 'active',
                stamina: { current: 55, max: 90 },
                willpower: { current: 2, max: 5 },
                corruption: { stage: 2, progress: 60 },
                skills: ['Entropy touch'],
            },
        },
        player: {
            identity: 'canon',
            characterId,
            displayName: 'Alex Mercer',
            stamina: { current: 80, max: 100 },
        },
    });

    const sheet = buildPlayerSheet({
        state,
        season: { title: 'Season 1' },
        registry: {
            entries: [
                { id: characterId, displayName: 'Vaiva', avatar: 'vaiva.png' },
            ],
        },
    });

    assert.equal(sheet.identity, 'canon');
    assert.equal(sheet.characterId, characterId);
    assert.equal(sheet.displayName, 'Vaiva');
    assert.equal(sheet.playingAs, 'Playing as Vaiva');
    assert.equal(sheet.portrait, 'vaiva.png');
    assert.equal(sheet.form.id, characterId);
    assert.equal(sheet.form.group, 'vaiva');
    assert.equal(sheet.form.label, 'Vaiva');
    assert.deepEqual(sheet.resources.map((resource) => resource.current), [55, 2]);
    assert.equal(sheet.corruption.stage, 2);
});

test('buildPlayerSheet returns null without a player', () => {
    assert.equal(buildPlayerSheet({ state: { player: null } }), null);
    assert.equal(buildPlayerSheet({}), null);
});

test('renderPlayerPanelMarkup exposes live values and manual-edit controls', () => {
    const sheet = buildPlayerSheet({ state: customState(), season: { title: 'Season 1' } });
    const markup = renderPlayerPanelMarkup(sheet);

    assert.match(markup, /data-neoterra-player-sheet/);
    assert.match(markup, /Alex Mercer/);
    assert.match(markup, /80\/100/);
    assert.match(markup, /4\/6/);
    assert.match(markup, /data-neoterra-player-edit/);
    assert.match(markup, /data-neoterra-player-input="stamina.current"/);

    assert.match(renderPlayerPanelMarkup(null), /No player world is active/);
});
