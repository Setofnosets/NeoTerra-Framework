import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRelationshipGraph,
    normalizeRelationshipType,
    relationshipsForNode,
} from '../src/ui/relationship-graph.js';
import {
    renderRelationshipFilters,
    renderRelationshipGraphSvg,
    renderRelationshipsMarkup,
} from '../src/ui/relationships.js';
import { SHELL_TABS } from '../src/core/constants.js';

function character(id, overrides = {}) {
    return {
        charId: id,
        formId: id,
        displayName: overrides.displayName ?? id.toUpperCase(),
        side: overrides.side ?? 'neutral',
        status: overrides.status ?? 'active',
        locationId: overrides.locationId ?? 'central-plaza',
        corruption: { stage: overrides.corruptionStage ?? 0, progress: 0 },
        ...overrides,
    };
}

function makeState({ identity = 'custom', playerId = 'player', relationships = [], characters = {}, present = ['c1'] } = {}) {
    const player = identity === 'canon'
        ? {
            identity: 'canon',
            characterId: playerId,
            displayName: characters[playerId]?.displayName ?? playerId,
            relationships: [],
        }
        : { identity: 'custom', displayName: 'The Player', relationships: [], charId: 'player', side: 'neutral' };
    return {
        player,
        playerRole: 'hero',
        characters,
        relationships,
        scene: { locationId: 'central-plaza', present },
        badEnds: {},
        flags: {},
        meta: { turn: 10, storyTurn: 10, inGameDate: '2037-03-01', timeOfDay: 'evening' },
    };
}

test('a null state produces the empty model instead of throwing', () => {
    const graph = buildRelationshipGraph({ state: null });
    assert.equal(graph.empty, true);
    assert.equal(graph.hasRelationships, false);
    assert.deepEqual(graph.nodes, []);
    assert.equal(renderRelationshipsMarkup(graph).includes('No relationships yet'), true);
});

test('a lone player renders one node and no edges', () => {
    const state = makeState({ characters: {}, present: [] });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].isPlayer, true);
    assert.equal(graph.edges.length, 0);
    assert.equal(renderRelationshipGraphSvg(graph).includes('marker-end'), false);
});

test('the player appears exactly once for a custom persona', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 }],
    });
    const graph = buildRelationshipGraph({ state });
    const players = graph.nodes.filter((node) => node.isPlayer);
    assert.equal(players.length, 1);
    assert.equal(players[0].id, 'player');
});

test('the player appears exactly once for a canon identity', () => {
    const state = makeState({
        identity: 'canon',
        playerId: 'c1',
        characters: { c1: character('c1'), c2: character('c2') },
        present: ['c1', 'c2'],
        relationships: [{ a: 'c1', b: 'c2', type: 'rival', affinity: -30, tension: 40 }],
    });
    const graph = buildRelationshipGraph({ state });
    const players = graph.nodes.filter((node) => node.isPlayer);
    assert.equal(players.length, 1);
    assert.equal(players[0].id, 'c1');
    assert.equal(graph.nodes.filter((node) => node.id === 'c1').length, 1);
});

test('player mirror duplicates are deduped by unordered pair', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'ally', affinity: 10, tension: 0 }],
    });
    state.player.relationships = [{ withCharacterId: 'c1', type: 'ally', affinity: 40, tension: 5 }];
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.edges.length, 1);
    // The stronger signal wins, and no second parallel edge is drawn.
    assert.equal(graph.edges[0].affinity, 40);
    assert.equal(renderRelationshipGraphSvg(graph).match(/neoterra-graph-edge"/g).length, 1);
});

test('only owner/servant edges are directed and carry an arrowhead', () => {
    const state = makeState({
        characters: { c1: character('c1'), c2: character('c2') },
        relationships: [
            { a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 },
            { a: 'player', b: 'c2', type: 'owner/servant', affinity: 60, tension: 10 },
        ],
    });
    const graph = buildRelationshipGraph({ state });
    const directed = graph.edges.filter((edge) => edge.directed);
    assert.equal(directed.length, 1);
    assert.equal(directed[0].type, 'owner/servant');
    const svg = renderRelationshipGraphSvg(graph);
    assert.equal(svg.match(/marker-end=/g).length, 1);
});

test('positions are deterministic and stay inside the declared bounds', () => {
    const state = makeState({
        characters: {
            c1: character('c1', { side: 'villain' }),
            c2: character('c2', { side: 'hero' }),
            c3: character('c3', { side: 'neutral' }),
        },
        present: ['c1', 'c2'],
        relationships: [
            { a: 'player', b: 'c1', type: 'rival', affinity: -20, tension: 10 },
            { a: 'c1', b: 'c2', type: 'ally', affinity: 30, tension: 0 },
            { a: 'c2', b: 'c3', type: 'family', affinity: 50, tension: 0 },
        ],
    });
    const first = buildRelationshipGraph({ state, settings: { width: 640, height: 480 } });
    const second = buildRelationshipGraph({ state, settings: { width: 640, height: 480 } });
    for (const node of first.nodes) {
        assert.ok(node.x >= 0 && node.x <= 640, `${node.id} x ${node.x}`);
        assert.ok(node.y >= 0 && node.y <= 480, `${node.id} y ${node.y}`);
    }
    assert.deepEqual(
        first.nodes.map((node) => [node.id, node.x, node.y]),
        second.nodes.map((node) => [node.id, node.x, node.y]),
    );
    const player = first.nodes.find((node) => node.isPlayer);
    assert.equal(player.x, 320);
    assert.equal(player.y, 240);
});

test('sixty-six nodes stay readable through label thinning', () => {
    const characters = {};
    const relationships = [];
    for (let i = 0; i < 65; i += 1) {
        const id = `c${i}`;
        characters[id] = character(id, { side: i % 2 ? 'hero' : 'villain' });
        relationships.push({
            a: 'player',
            b: id,
            type: i === 0 ? 'lover' : 'neutral',
            affinity: i === 0 ? 70 : 0,
            tension: 0,
        });
    }
    const state = makeState({ characters, present: ['c1'], relationships });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.nodes.length, 66);
    const visible = graph.nodes.filter((node) => node.labelVisible);
    assert.ok(visible.length < graph.nodes.length);
    assert.equal(graph.nodes.find((node) => node.id === 'player').labelVisible, true);
    assert.equal(graph.nodes.find((node) => node.id === 'c1').labelVisible, true);
    assert.equal(graph.nodes.find((node) => node.id === 'c0').labelVisible, true);
});

test('filters change node and edge counts as expected', () => {
    const state = makeState({
        characters: {
            c1: character('c1', { side: 'villain' }),
            c2: character('c2', { side: 'hero' }),
            c3: character('c3', { side: 'neutral' }),
        },
        present: ['c1'],
        relationships: [
            { a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 },
            { a: 'player', b: 'c2', type: 'rival', affinity: -40, tension: 10 },
            { a: 'c2', b: 'c3', type: 'family', affinity: 15, tension: 0 },
        ],
    });
    assert.equal(buildRelationshipGraph({ state }).edges.length, 3);
    assert.equal(buildRelationshipGraph({ state, filters: { type: 'ally' } }).edges.length, 1);
    assert.equal(buildRelationshipGraph({ state, filters: { side: 'hero' } }).edges.length, 1);
    assert.equal(buildRelationshipGraph({ state, filters: { minAffinity: 0 } }).edges.length, 2);
    const present = buildRelationshipGraph({ state, filters: { presentOnly: true } });
    assert.equal(present.edges.length, 1);
    assert.equal(present.nodes.some((node) => node.id === 'c3'), false);
});

test('the detail list names the other end of each edge', () => {
    const state = makeState({
        characters: { c1: character('c1'), c2: character('c2') },
        relationships: [
            { a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 },
            { a: 'c1', b: 'c2', type: 'rival', affinity: -10, tension: 30 },
        ],
    });
    const graph = buildRelationshipGraph({ state });
    const rows = relationshipsForNode(graph, 'c1');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.otherName).sort(), ['C2', 'The Player']);
});

test('the model never mutates the incoming state', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 }],
    });
    const before = JSON.parse(JSON.stringify(state));
    const graph = buildRelationshipGraph({ state });
    // Mutating the model result must not reach the document either.
    graph.nodes[0].name = 'changed';
    assert.deepEqual(state, before);
});

test('graph markup is keyboard reachable and uses theme tokens', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'ally', affinity: 20, tension: 0 }],
    });
    const graph = buildRelationshipGraph({ state });
    const markup = renderRelationshipsMarkup(graph, { selectedId: 'c1' });
    assert.match(markup, /role="button"/);
    assert.match(markup, /tabindex="0"/);
    assert.match(markup, /data-neoterra-graph-node="c1"/);
    assert.match(markup, /neoterra-relation-row/);
    assert.match(markup, /aria-live="polite"/);
    const filters = renderRelationshipFilters();
    assert.match(filters, /data-neoterra-graph-filter="presentOnly"/);
    assert.match(filters, /data-neoterra-graph-filter="minAffinity"/);
});

test('agent relationship vocabulary maps onto the legend categories', () => {
    assert.equal(normalizeRelationshipType('likes'), 'ally');
    assert.equal(normalizeRelationshipType('dislikes'), 'rival');
    assert.equal(normalizeRelationshipType('rivalry'), 'rival');
    assert.equal(normalizeRelationshipType('attraction'), 'lover');
    assert.equal(normalizeRelationshipType('owner/servant'), 'owner/servant');
    assert.equal(normalizeRelationshipType('made-up'), 'neutral');
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'attraction', affinity: 50, tension: 0 }],
    });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.edges[0].type, 'lover');
    assert.equal(buildRelationshipGraph({ state, filters: { type: 'lover' } }).edges.length, 1);
});

test('a real state with no relationships shows the empty state', () => {
    const state = makeState({ characters: { c1: character('c1') } });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.hasRelationships, false);
    assert.equal(graph.nodes.length, 2);
    assert.match(renderRelationshipsMarkup(graph), /No relationships yet/);
    assert.doesNotMatch(renderRelationshipsMarkup(graph), /No relationships match the filters/);
});

test('a canon player mirror duplicate is deduped too', () => {
    const state = makeState({
        identity: 'canon',
        playerId: 'c1',
        characters: { c1: character('c1'), c2: character('c2') },
        present: ['c1'],
        relationships: [{ a: 'c1', b: 'c2', type: 'ally', affinity: 10, tension: 0 }],
    });
    state.player.relationships = [{ withCharacterId: 'c2', type: 'ally', affinity: 10, tension: 0 }];
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes.filter((node) => node.id === 'c1').length, 1);
});

test('presentOnly keeps only edges between present characters and the player', () => {
    const state = makeState({
        characters: { c1: character('c1'), c2: character('c2'), c3: character('c3') },
        present: ['c1'],
        relationships: [
            { a: 'player', b: 'c1', type: 'ally', affinity: 10, tension: 0 },
            { a: 'player', b: 'c3', type: 'ally', affinity: 10, tension: 0 },
            { a: 'c2', b: 'c3', type: 'ally', affinity: 10, tension: 0 },
        ],
    });
    const graph = buildRelationshipGraph({ state, filters: { presentOnly: true } });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes.some((node) => node.id === 'c3'), false);
});

test('a narrow canvas keeps every node inside the bounds', () => {
    const state = makeState({
        characters: { c1: character('c1'), c2: character('c2') },
        relationships: [
            { a: 'player', b: 'c1', type: 'ally', affinity: 10, tension: 0 },
            { a: 'player', b: 'c2', type: 'ally', affinity: 10, tension: 0 },
        ],
    });
    const graph = buildRelationshipGraph({ state, settings: { width: 200, height: 160 } });
    for (const node of graph.nodes) {
        assert.ok(node.x - node.r >= 0 && node.x + node.r <= 200, `${node.id} x ${node.x}`);
        assert.ok(node.y - node.r >= 0 && node.y + node.r <= 160, `${node.id} y ${node.y}`);
    }
});

test('directed lines stop short of the target circle', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [{ a: 'player', b: 'c1', type: 'owner/servant', affinity: 50, tension: 0 }],
    });
    const graph = buildRelationshipGraph({ state, settings: { width: 400, height: 300 } });
    const edge = graph.edges[0];
    const from = graph.nodes.find((node) => node.id === edge.a);
    const to = graph.nodes.find((node) => node.id === edge.b);
    const svg = renderRelationshipGraphSvg(graph);
    const match = svg.match(/<line[^>]*x2="([\d.]+)"[^>]*y2="([\d.]+)"/);
    assert.ok(match, 'expected a rendered line');
    const x2 = Number(match[1]);
    const y2 = Number(match[2]);
    const distance = Math.hypot(to.x - x2, to.y - y2);
    assert.ok(distance > to.r + 2, `arrow tip ${distance}px from the target centre`);
    assert.ok(Math.hypot(from.x - x2, from.y - y2) > from.r);
});

test('invalid relationship records and unknown types are tolerated', () => {
    const state = makeState({
        characters: { c1: character('c1') },
        relationships: [
            null,
            { a: 'player' },
            { a: 'player', b: 'c1', type: 42, affinity: 'lots' },
        ],
    });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].type, 'neutral');
    assert.equal(graph.edges[0].affinity, 0);
});

test('a custom player reads role, corruption, and presence from state', () => {
    const state = makeState({ characters: {}, present: [] });
    state.playerRole = 'villain';
    state.player.corruption = { stage: 3, progress: 20 };
    state.player.side = 'villain';
    const graph = buildRelationshipGraph({ state });
    const player = graph.nodes.find((node) => node.isPlayer);
    assert.equal(player.side, 'villain');
    assert.equal(player.corruptionStage, 3);
    assert.equal(player.isPresent, true);
});

test('registry sides outside the legacy set are normalized and filterable', () => {
    const state = makeState({
        characters: { c1: character('c1', { side: 'vigilante' }) },
        relationships: [{ a: 'player', b: 'c1', type: 'ally', affinity: 10, tension: 0 }],
    });
    const graph = buildRelationshipGraph({ state });
    assert.equal(graph.nodes.find((node) => node.id === 'c1').side, 'vigilante');
    assert.equal(buildRelationshipGraph({ state, filters: { side: 'vigilante' } }).edges.length, 1);
});

test('the Relations tab sits between Characters and Player', () => {
    const ids = SHELL_TABS.map((tab) => tab.id);
    assert.equal(ids.indexOf('relations'), ids.indexOf('characters') + 1);
    assert.ok(ids.indexOf('relations') < ids.indexOf('player'));
});
