import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPreviouslyOn,
    buildSessionHomeView,
    renderSessionHomeMarkup,
} from '../src/ui/session-home.js';
import { readLastTab } from '../src/ui/shell.js';
import { createNewTimeline } from '../src/flows/new-chat.js';
import { DIRECTOR_CARD_NAME } from '../src/flows/season-start.js';

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
        scene: {
            locationId: 'central-plaza',
            present: ['s1.vaiva.vaiva', 's1.aurelia.longshot'],
        },
        locations: { 'central-plaza': { name: 'Central Plaza' } },
        characters: {
            's1.vaiva.vaiva': {
                charId: 's1.vaiva.vaiva',
                displayName: 'Vaiva',
                formId: 's1.vaiva.vaiva',
                status: 'active',
                controlledBy: 'player',
                locationId: 'central-plaza',
            },
            's1.aurelia.longshot': {
                charId: 's1.aurelia.longshot',
                displayName: 'Aurelia Longshot',
                formId: 's1.aurelia.longshot',
                status: 'active',
                controlledBy: 'npc',
                locationId: 'central-plaza',
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
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [
            { turn: 1, summary: 'The season begins.' },
            { turn: 3, summary: 'Vaiva was spotted at the plaza.' },
        ],
        player: {
            identity: 'canon',
            characterId: 's1.vaiva.vaiva',
        },
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

test('buildSessionHomeView summarizes the live world', () => {
    const view = buildSessionHomeView({ state: worldState(), season });

    assert.ok(view);
    assert.equal(view.title, 'Season 1 — Emergence');
    assert.equal(view.era, '2031');
    assert.equal(view.act, 'opening');
    assert.equal(view.beat.title, 'First Move');
    assert.equal(view.turn, 7);
    assert.equal(view.date, '2031-04-12');
    assert.equal(view.timeLabel, 'Evening');
    assert.equal(view.player.name, 'Vaiva');
    assert.equal(view.player.initials, 'V');
    assert.equal(view.player.identity, 'canon');
    assert.equal(view.location.name, 'Central Plaza');
    assert.equal(view.threat.name, 'The Clarity Signal');
    assert.equal(view.threat.stage, 'broadcast');
    assert.equal(view.threat.progress, 42);
    // Deliberate semantic change (step 1): presence is NPC-only, so the played
    // character no longer appears in the Session Home cast list; the fixture
    // now carries a separate NPC and the player is marked "You are here".
    assert.deepEqual(view.present, [
        { id: 's1.aurelia.longshot', name: 'Aurelia Longshot', initials: 'AL' },
    ]);
    assert.deepEqual(view.presentNpcs, view.present);
    assert.equal(view.playerHere, true);
    assert.equal(view.previouslyOn, 'The season begins. Vaiva was spotted at the plaza.');
    assert.deepEqual(
        view.actions.map((action) => action.id),
        ['continue', 'map', 'characters', 'player', 'journal'],
    );
    assert.equal(view.actions.find((action) => action.id === 'journal').disabled, undefined);
    assert.deepEqual(view.secondaryActions.map((action) => action.id), ['new-timeline']);
});

test('buildSessionHomeView returns null without a world', () => {
    assert.equal(buildSessionHomeView({ state: null, season }), null);
    assert.equal(buildSessionHomeView({ state: { seasonId: 's1' }, season }), null);
});

test('previouslyOn falls back to the premise and then a generic line', () => {
    const state = worldState({ recentEvents: [] });
    assert.equal(buildPreviouslyOn(state, season), 'The city wakes up to something new.');
    assert.match(buildPreviouslyOn(state, null), /new Neo Terra timeline/i);
});

test('renderSessionHomeMarkup exposes the primary and secondary actions', () => {
    const view = buildSessionHomeView({ state: worldState(), season });
    const markup = renderSessionHomeMarkup(view);

    assert.match(markup, /data-neoterra-session-home/);
    assert.match(markup, /data-neoterra-home-action="continue"/);
    assert.match(markup, /data-neoterra-home-action="map"/);
    assert.match(markup, /data-neoterra-home-action="new-timeline"/);
    assert.match(markup, /Previously on/);
    assert.match(markup, /The Clarity Signal/);
    assert.match(markup, /Central Plaza/);
    assert.match(renderSessionHomeMarkup(null), /No world is active/);
});

test('the Present card marks the player and never lists them as cast', () => {
    const view = buildSessionHomeView({ state: worldState(), season });
    const markup = renderSessionHomeMarkup(view);
    assert.match(markup, /data-neoterra-home-player-here/);
    assert.match(markup, /You are here/);
    const cast = markup.slice(markup.indexOf('neoterra-home-cast'));
    assert.doesNotMatch(cast, /Vaiva/);
    assert.match(cast, /Aurelia Longshot/);

    // A custom persona whose player.locationId is null falls back to the scene.
    const custom = worldState({
        player: { identity: 'custom', displayName: 'Vex', locationId: null },
        scene: { locationId: 'central-plaza', present: ['s1.vaiva.vaiva'] },
    });
    const customView = buildSessionHomeView({ state: custom, season });
    assert.equal(customView.playerHere, true);
    assert.deepEqual(customView.present, []);
    const emptyMarkup = renderSessionHomeMarkup(customView);
    assert.match(emptyMarkup, /data-neoterra-home-player-here/);
    assert.doesNotMatch(emptyMarkup, /Nobody else is on stage/);

    // The scene is the authority for the player's place (assumption 2): a stale
    // or mismatched mirror `player.locationId` cannot move the marker away from
    // the stage the card is describing. With no scene location there is no
    // place to mark.
    const mirrorMismatch = buildSessionHomeView({
        state: worldState({ player: { identity: 'custom', displayName: 'Vex', locationId: 'elsewhere' } }),
        season,
    });
    assert.equal(mirrorMismatch.playerHere, true);

    const noSceneView = buildSessionHomeView({
        state: worldState({ scene: { locationId: null, present: [] } }),
        season,
    });
    assert.equal(noSceneView.playerHere, false);
    assert.doesNotMatch(renderSessionHomeMarkup(noSceneView), /data-neoterra-home-player-here/);
});

test('readLastTab restores a known tab and rejects unknown values', () => {
    const withTab = (lastTab) => ({ chatMetadata: { neoterra: { ui: { lastTab } } } });
    assert.equal(readLastTab(withTab('map')), 'map');
    assert.equal(readLastTab(withTab('player')), 'player');
    assert.equal(readLastTab(withTab('not-a-tab')), null);
    assert.equal(readLastTab(withTab(undefined)), null);
    assert.equal(readLastTab(null), null);
});

test('createNewTimeline prefers the Director card and reports a new chat', async () => {
    const calls = [];
    let chatId = 'chat-old';
    const ctx = {
        characters: [{ id: 'director-id', name: DIRECTOR_CARD_NAME, avatar: 'director.png' }],
    };
    const result = await createNewTimeline({
        ctx,
        execute: async (command) => {
            calls.push(['execute', command]);
            chatId = 'chat-new';
            return '';
        },
        selectCharacter: async (id) => calls.push(['select', id]),
        getChatId: () => chatId,
    });

    assert.equal(result.ok, true);
    assert.equal(result.usedDirector, true);
    assert.equal(result.characterName, DIRECTOR_CARD_NAME);
    assert.equal(result.chatId, 'chat-new');
    assert.deepEqual(calls, [
        ['select', 'director.png'],
        ['execute', '/newchat'],
    ]);
});

test('createNewTimeline keeps the current card when no Director is installed', async () => {
    let selected = 0;
    let chatId = 'chat-old';
    const result = await createNewTimeline({
        ctx: { characters: [] },
        execute: async () => {
            chatId = 'chat-new';
            return '';
        },
        selectCharacter: async () => {
            selected += 1;
        },
        getChatId: () => chatId,
    });

    assert.equal(result.ok, true);
    assert.equal(result.usedDirector, false);
    assert.equal(selected, 0);
});

test('createNewTimeline fails safely without the chat API and on a thrown command', async () => {
    const noApi = await createNewTimeline({ ctx: { characters: [] } });
    assert.equal(noApi.ok, false);
    assert.equal(noApi.reason, 'no-chat-api');

    const failed = await createNewTimeline({
        ctx: { characters: [] },
        execute: async () => {
            throw new Error('no chat');
        },
        getChatId: () => 'chat-old',
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'chat-create-failed');
    assert.match(failed.message, /could not be created/i);
});

test('createNewTimeline rejects an unchanged chat id and restores the previous card', async () => {
    const selected = [];
    const result = await createNewTimeline({
        ctx: {
            characterId: 'previous-card',
            characters: [{ id: 'director-id', avatar: 'director.png', name: DIRECTOR_CARD_NAME }],
        },
        execute: async () => '',
        selectCharacter: async (id) => selected.push(id),
        getChatId: () => 'chat-same',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'chat-not-created');
    assert.match(result.message, /did not open a new chat/i);
    assert.deepEqual(selected, ['director.png', 'previous-card']);
});
