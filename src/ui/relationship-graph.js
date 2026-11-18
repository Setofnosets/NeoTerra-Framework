/**
 * Deterministic relationship-graph model.
 *
 * Pure and Node-safe: no DOM, no state writes, no network. The UI renders the
 * returned nodes/edges as SVG; tests assert coordinates, dedupe, and filtering.
 *
 * Layout is deliberately dependency-free: the player sits at the centre,
 * present characters on an inner ring, everyone else on an outer ring. Rings
 * are sorted by side then name, so the same state always produces the same
 * snapshot.
 */

import { buildRegistryIndex } from '../data/registry.js';
import { selectPresentCast } from '../state/selectors.js';

export const RELATIONSHIP_TYPES = Object.freeze([
    'ally',
    'rival',
    'lover',
    'family',
    'owner/servant',
    'neutral',
]);

/**
 * Agents write a wider vocabulary than the six legend categories. Normalize
 * every known alias so a stored `likes` edge is drawn and filtered as `ally`
 * instead of silently collapsing to `neutral`.
 */
export const RELATIONSHIP_TYPE_ALIASES = Object.freeze({
    likes: 'ally',
    dislikes: 'rival',
    rivalry: 'rival',
    attraction: 'lover',
    family: 'family',
    'owner/servant': 'owner/servant',
    ally: 'ally',
    rival: 'rival',
    lover: 'lover',
    neutral: 'neutral',
});

export const RELATIONSHIP_SIDES = Object.freeze([
    'villain',
    'hero',
    'vigilante',
    'civilian',
    'neutral',
    'unknown',
]);

export function normalizeRelationshipType(type) {
    const key = String(type ?? '').trim().toLowerCase();
    return RELATIONSHIP_TYPE_ALIASES[key] ?? 'neutral';
}

const TYPE_STYLE = Object.freeze({
    ally: { color: 'var(--nt-success)', dashed: false },
    rival: { color: 'var(--nt-danger)', dashed: false },
    lover: { color: 'var(--nt-accent)', dashed: false },
    family: { color: 'var(--nt-warning)', dashed: false },
    'owner/servant': { color: 'var(--nt-accent-strong)', dashed: false },
    neutral: { color: 'var(--nt-text-faint)', dashed: true },
});

const SIDE_ORDER = Object.freeze({
    villain: 0,
    hero: 1,
    vigilante: 2,
    civilian: 3,
    neutral: 4,
    unknown: 5,
});

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 520;
const PADDING = 52;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function compareText(a, b) {
    const left = String(a ?? '').toLowerCase();
    const right = String(b ?? '').toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function normalizeSide(side, fallback = 'unknown') {
    const key = String(side ?? '').trim().toLowerCase();
    return RELATIONSHIP_SIDES.includes(key) ? key : fallback;
}

function playerIdentity(state) {
    const player = isObject(state?.player) ? state.player : null;
    if (!player) {
        return { id: null, name: 'The Player', isCanon: false };
    }
    const isCanon = player.identity === 'canon' && typeof player.characterId === 'string';
    return {
        id: isCanon ? player.characterId : 'player',
        name: player.displayName ?? (isCanon ? state?.characters?.[player.characterId]?.displayName : null) ?? 'The Player',
        isCanon,
    };
}

function registryIndex(registry) {
    if (!registry) {
        return null;
    }
    if (isObject(registry.byId)) {
        return registry;
    }
    return buildRegistryIndex(registry);
}

function registryEntry(index, id) {
    return index?.byId?.[id] ?? null;
}

function presentSet(state) {
    return new Set(selectPresentCast(state).map((character) => character.charId));
}

/**
 * Merge stored relationships with the player mirror.
 *
 * `state.relationships` uses `{a,b}`; `state.player.relationships` uses
 * `{withCharacterId}`. A pair present in both is deduped by unordered pair,
 * keeping the richer affinity/tension and a directed type when either side
 * declares one.
 */
function collectEdges(state, playerId) {
    const edges = [];
    const byPair = new Map();
    const playerMirror = Array.isArray(state?.player?.relationships)
        ? state.player.relationships
        : [];

    const add = (raw) => {
        const a = typeof raw?.a === 'string' ? raw.a : (typeof raw?.withCharacterId === 'string' ? playerId : null);
        const b = typeof raw?.b === 'string' ? raw.b : (typeof raw?.withCharacterId === 'string' ? raw.withCharacterId : null);
        if (!a || !b || a === b) {
            return;
        }
        const type = normalizeRelationshipType(raw.type);
        const affinity = clamp(finiteNumber(raw.affinity), -100, 100);
        const tension = clamp(finiteNumber(raw.tension), -100, 100);
        const key = [a, b].sort().join('\u0000');
        const existing = byPair.get(key);
        if (existing) {
            // Prefer the record with the stronger signal, and never lose a
            // directed owner/servant declaration to a symmetric duplicate.
            if (Math.abs(affinity) > Math.abs(existing.affinity)) {
                existing.affinity = affinity;
            }
            if (Math.abs(tension) > Math.abs(existing.tension)) {
                existing.tension = tension;
            }
            if (type === 'owner/servant' && existing.type !== 'owner/servant') {
                existing.type = type;
                existing.directed = true;
                existing.a = a;
                existing.b = b;
            }
            return;
        }
        const edge = {
            a,
            b,
            type,
            affinity,
            tension,
            directed: type === 'owner/servant',
            notes: typeof raw.notes === 'string' ? raw.notes : '',
        };
        byPair.set(key, edge);
        edges.push(edge);
    };

    for (const relationship of Array.isArray(state?.relationships) ? state.relationships : []) {
        if (isObject(relationship)) {
            add(relationship);
        }
    }
    for (const relationship of playerMirror) {
        if (isObject(relationship)) {
            add({ ...relationship, a: playerId, b: relationship.withCharacterId });
        }
    }
    return edges;
}

function nodeStyle(edge) {
    const style = TYPE_STYLE[edge.type] ?? TYPE_STYLE.neutral;
    return {
        color: style.color,
        dashed: style.dashed || edge.tension >= 50,
        width: Number((1 + Math.min(3, Math.abs(edge.affinity) / 34)).toFixed(2)),
        label: edge.type,
    };
}

/**
 * Build the relationship graph.
 *
 * @param {{
 *   state: object|null,
 *   registry?: object|null,
 *   settings?: object,
 *   filters?: {presentOnly?: boolean, side?: string, type?: string, minAffinity?: number},
 * }} options
 * @returns {{
 *   nodes: object[],
 *   edges: object[],
 *   bounds: {width:number,height:number},
 *   legend: object[],
 *   empty: boolean,
 *   hasRelationships: boolean,
 *   filters: object,
 *   playerId: string|null,
 * }}
 */
export function buildRelationshipGraph({
    state = null,
    registry = null,
    settings = {},
    filters = {},
} = {}) {
    const width = Number.isFinite(settings?.width) ? settings.width : DEFAULT_WIDTH;
    const height = Number.isFinite(settings?.height) ? settings.height : DEFAULT_HEIGHT;
    const emptyGraph = {
        nodes: [],
        edges: [],
        bounds: { width, height },
        legend: legend(),
        empty: true,
        hasRelationships: false,
        filters: { ...filters },
        playerId: null,
    };
    if (!isObject(state)) {
        return emptyGraph;
    }

    const player = playerIdentity(state);
    const present = presentSet(state);
    const index = registryIndex(registry);
    const characters = isObject(state.characters) ? state.characters : {};

    const characterNode = (id) => {
        const live = characters[id] ?? null;
        const entry = registryEntry(index, id) ?? null;
        const isPlayer = id === player.id;
        const customPlayer = isPlayer && !player.isCanon;
        const roleSide = isPlayer
            ? (state.playerRole === 'villain' || state.playerRole === 'hero' ? state.playerRole : null)
            : null;
        const side = normalizeSide(
            live?.side ?? entry?.side ?? roleSide,
            customPlayer ? 'neutral' : 'unknown',
        );
        return {
            id,
            name: live?.displayName ?? entry?.displayName ?? (isPlayer ? player.name : id),
            side,
            status: live?.status ?? (isPlayer ? 'active' : 'unknown'),
            formKind: entry?.formKind ?? null,
            isPlayer,
            isPresent: isPlayer || present.has(id),
            corruptionStage: finiteNumber(
                customPlayer ? state.player?.corruption?.stage : live?.corruption?.stage,
                0,
            ),
            badEnd: Boolean(state?.badEnds?.[id]),
            badEndType: state?.badEnds?.[id]?.type ?? live?.badEndType ?? null,
            x: 0,
            y: 0,
            r: 10,
            labelVisible: true,
            maxAffinity: 0,
        };
    };

    const rawEdges = collectEdges(state, player.id);

    // Edge filters first; nodes are derived from what survives, so a filter
    // can never leave an orphan edge pointing at a removed node.
    const sideFilter = typeof filters.side === 'string' && filters.side !== 'all' ? filters.side : null;
    const typeFilter = typeof filters.type === 'string' && filters.type !== 'all' ? filters.type : null;
    const minAffinity = Number.isFinite(Number(filters.minAffinity)) ? Number(filters.minAffinity) : null;
    const presentOnly = filters.presentOnly === true;

    const passesNode = (id) => {
        if (!sideFilter) {
            return true;
        }
        if (id === player.id) {
            return true;
        }
        const live = characters[id];
        const entry = registryEntry(index, id);
        const roleSide = id === player.id
            && (state.playerRole === 'villain' || state.playerRole === 'hero')
            ? state.playerRole
            : null;
        return normalizeSide(live?.side ?? entry?.side ?? roleSide) === sideFilter;
    };
    const visibleCast = new Set(present);
    if (player.id) {
        visibleCast.add(player.id);
    }

    const edges = rawEdges
        .filter((edge) => (presentOnly ? visibleCast.has(edge.a) && visibleCast.has(edge.b) : true))
        .filter((edge) => (typeFilter ? edge.type === typeFilter : true))
        .filter((edge) => (minAffinity === null ? true : edge.affinity >= minAffinity))
        .filter((edge) => passesNode(edge.a) && passesNode(edge.b))
        .map((edge) => ({ ...edge, ...nodeStyle(edge) }));

    const nodeIds = new Set();
    for (const edge of edges) {
        nodeIds.add(edge.a);
        nodeIds.add(edge.b);
    }
    if (player.id) {
        nodeIds.add(player.id);
    }
    // Present cast stays visible even without a declared relationship.
    for (const character of Object.values(characters)) {
        if (character?.charId && present.has(character.charId) && passesNode(character.charId)) {
            nodeIds.add(character.charId);
        }
    }
    if (player.id) {
        nodeIds.add(player.id);
    }

    const nodes = [...nodeIds]
        .filter((id) => typeof id === 'string' && id.length > 0)
        .map(characterNode);

    const maxAffinity = new Map();
    for (const edge of edges) {
        maxAffinity.set(edge.a, Math.max(maxAffinity.get(edge.a) ?? 0, Math.abs(edge.affinity)));
        maxAffinity.set(edge.b, Math.max(maxAffinity.get(edge.b) ?? 0, Math.abs(edge.affinity)));
    }
    for (const node of nodes) {
        node.maxAffinity = maxAffinity.get(node.id) ?? 0;
    }

    if (nodes.length === 0) {
        return { ...emptyGraph, filters: { ...filters }, playerId: player.id };
    }

    layout(nodes, { width, height, playerId: player.id });

    const crowded = nodes.length > 30;
    for (const node of nodes) {
        node.labelVisible = !crowded
            || node.isPlayer
            || node.isPresent
            || node.maxAffinity >= 40;
    }

    return {
        nodes,
        edges,
        bounds: { width, height },
        legend: legend(),
        empty: false,
        hasRelationships: edges.length > 0,
        filters: {
            presentOnly,
            side: sideFilter ?? 'all',
            type: typeFilter ?? 'all',
            minAffinity: minAffinity ?? null,
        },
        playerId: player.id,
    };
}

function layout(nodes, { width, height, playerId }) {
    const centerX = width / 2;
    const centerY = height / 2;
    const player = playerId ? nodes.find((node) => node.id === playerId) ?? null : null;
    const others = nodes.filter((node) => node !== player);
    const inner = others.filter((node) => node.isPresent);
    const outer = others.filter((node) => !node.isPresent);

    const maxRadius = Math.max(0, Math.min(width, height) / 2 - PADDING - 14);

    if (player) {
        player.x = centerX;
        player.y = centerY;
        player.r = nodes.length > 30 ? 14 : 18;
    }

    const count = Math.max(1, others.length);
    // Ring radii scale with node count so 60+ nodes do not overlap the hub.
    // Never clamp upward past the declared canvas: a small viewport shrinks
    // the rings instead of placing nodes outside `bounds`.
    const innerRadius = inner.length === 0 ? 0 : maxRadius * 0.55;
    const outerRadius = outer.length === 0 ? 0 : maxRadius;
    const baseRadius = clamp(maxRadius / Math.sqrt(count) * 0.5, 4, 16);

    const placeRing = (ring, radius) => {
        const sorted = [...ring].sort((a, b) => (SIDE_ORDER[a.side] ?? 9) - (SIDE_ORDER[b.side] ?? 9)
            || compareText(a.name, b.name)
            || compareText(a.id, b.id));
        const step = (Math.PI * 2) / Math.max(1, sorted.length);
        sorted.forEach((node, i) => {
            const angle = -Math.PI / 2 + step * i;
            node.x = centerX + Math.cos(angle) * radius;
            node.y = centerY + Math.sin(angle) * radius;
            node.r = node.isPlayer ? node.r : clamp(baseRadius, 6, 14);
        });
    };

    placeRing(inner, innerRadius);
    placeRing(outer, outerRadius);
    if (player) {
        player.x = centerX;
        player.y = centerY;
    }
}

function legend() {
    return RELATIONSHIP_TYPES.map((type) => ({
        type,
        label: type,
        color: TYPE_STYLE[type].color,
        dashed: TYPE_STYLE[type].dashed,
        directed: type === 'owner/servant',
    }));
}

/** One node's incident edges, with the other end named. */
export function relationshipsForNode(graph, nodeId) {
    if (!graph || typeof nodeId !== 'string') {
        return [];
    }
    const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
    return (graph.edges ?? [])
        .filter((edge) => edge.a === nodeId || edge.b === nodeId)
        .map((edge) => {
            const otherId = edge.a === nodeId ? edge.b : edge.a;
            return {
                ...edge,
                otherId,
                otherName: byId.get(otherId)?.name ?? otherId,
            };
        });
}
