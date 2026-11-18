/**
 * Fog-of-war exploration rules.
 *
 * Pure functions used by the seed, the reducer, the map view transform, and
 * travel gating. Nothing here touches the DOM, authored geometry, or a store.
 *
 * Stored shape (inside `WorldState.flags.map.exploration`):
 *   { regions: { [regionId]: {state, turn, source} },
 *     keyLocations: { [id]: {state, turn, source} },
 *     updatedAt: number }
 */

export const EXPLORATION_STATES = Object.freeze(['unknown', 'rumored', 'discovered']);
export const EXPLORATION_SOURCES = Object.freeze(['start', 'travel', 'storyline', 'editor']);
export const DEFAULT_FOG_MODE = 'rumors';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryState(entry) {
    return isObject(entry) && EXPLORATION_STATES.includes(entry.state) ? entry.state : 'unknown';
}

/** Read `flags.map.exploration`; null when the world predates fog. */
export function getExploration(state) {
    const value = state?.flags?.map?.exploration;
    return isObject(value) ? normalizeExploration(value) : null;
}

/** Normalize a stored exploration document; unknown keys survive. */
export function normalizeExploration(raw) {
    if (!isObject(raw)) {
        return null;
    }
    const regions = {};
    for (const [regionId, entry] of Object.entries(isObject(raw.regions) ? raw.regions : {})) {
        if (!isObject(entry)) {
            continue;
        }
        const state = entryState(entry);
        if (state === 'unknown') {
            continue;
        }
        regions[regionId] = {
            state,
            turn: Number.isInteger(entry.turn) ? entry.turn : 0,
            source: typeof entry.source === 'string' ? entry.source : null,
        };
    }
    const keyLocations = {};
    for (const [id, entry] of Object.entries(isObject(raw.keyLocations) ? raw.keyLocations : {})) {
        if (!isObject(entry)) {
            continue;
        }
        const state = entryState(entry);
        if (state === 'unknown') {
            continue;
        }
        keyLocations[id] = {
            state,
            turn: Number.isInteger(entry.turn) ? entry.turn : 0,
            source: typeof entry.source === 'string' ? entry.source : null,
        };
    }
    return {
        ...raw,
        regions,
        keyLocations,
        updatedAt: Number.isInteger(raw.updatedAt) ? raw.updatedAt : 0,
    };
}

/** Region id for an authored named location, or null (virtual nodes included). */
export function regionIdForLocation(locations, locationId) {
    if (!locationId) {
        return null;
    }
    const list = Array.isArray(locations?.locations) ? locations.locations : [];
    const entry = list.find((location) => location?.id === locationId) ?? null;
    return typeof entry?.regionId === 'string' ? entry.regionId : null;
}

/**
 * Seed the exploration document: the start location's region is discovered.
 * Rumored neighbors are derived at render/travel time from the bridge graph,
 * so the stored document stays minimal and old worlds can be seeded later.
 */
export function seedExplorationFor({ locations = null, startLocationId = null, turn = 0 } = {}) {
    const regionId = regionIdForLocation(locations, startLocationId);
    return {
        regions: regionId
            ? { [regionId]: { state: 'discovered', turn, source: 'start' } }
            : {},
        keyLocations: {},
        updatedAt: Number.isInteger(turn) ? turn : 0,
    };
}

/** One region's stored state, defaulting to unknown. */
export function regionState(exploration, regionId) {
    if (!regionId || !isObject(exploration)) {
        return 'unknown';
    }
    return entryState(exploration.regions?.[regionId]);
}

/**
 * Effective visibility for every region known to the map. Discovered regions
 * mark their bridge-adjacent peers rumored in `rumors` mode.
 *
 * @returns {Map<string, 'unknown'|'rumored'|'discovered'>}
 */
export function computeRegionVisibility({
    exploration = null,
    regions = [],
    bridges = [],
    mode = DEFAULT_FOG_MODE,
    revealNeighbors = true,
} = {}) {
    const visibility = new Map();
    if (!isObject(exploration)) {
        return visibility;
    }
    for (const region of Array.isArray(regions) ? regions : []) {
        const id = typeof region === 'string' ? region : region?.id;
        if (typeof id === 'string') {
            visibility.set(id, regionState(exploration, id));
        }
    }
    for (const [regionId, entry] of Object.entries(exploration.regions ?? {})) {
        if (entryState(entry) !== 'unknown' && !visibility.has(regionId)) {
            visibility.set(regionId, entryState(entry));
        }
    }
    if (mode === 'hard' || revealNeighbors === false) {
        return visibility;
    }
    for (const bridge of Array.isArray(bridges) ? bridges : []) {
        const [a, b] = Array.isArray(bridge?.connects) ? bridge.connects : [];
        if (!a || !b) {
            continue;
        }
        const aState = visibility.get(a) ?? regionState(exploration, a);
        const bState = visibility.get(b) ?? regionState(exploration, b);
        if (aState === 'discovered' && (visibility.get(b) ?? 'unknown') === 'unknown') {
            visibility.set(b, 'rumored');
        }
        if (bState === 'discovered' && (visibility.get(a) ?? 'unknown') === 'unknown') {
            visibility.set(a, 'rumored');
        }
    }
    return visibility;
}

/**
 * Regions a completed trip discovers: every path node's region plus both ends
 * of every bridge used.
 */
export function collectTravelRegions({ graph = null, path = [], bridges = [] } = {}) {
    const found = new Set();
    for (const locationId of Array.isArray(path) ? path : []) {
        const node = graph?.getNode?.(locationId) ?? null;
        if (node?.regionId) {
            found.add(node.regionId);
        }
    }
    for (const bridgeId of Array.isArray(bridges) ? bridges : []) {
        const bridge = graph?.bridgeById?.get?.(bridgeId) ?? null;
        for (const regionId of bridge?.connects ?? []) {
            if (regionId) {
                found.add(regionId);
            }
        }
    }
    return [...found];
}

/**
 * Fog decision for a destination. Pure so travel and tests agree.
 *
 * @returns {{ allowed: boolean, blind: boolean, reason: string|null }}
 */
export function destinationVisibility({
    exploration = null,
    regionId = null,
    virtual = false,
    connections = [],
    visitedLocationIds = [],
    gateTravel = true,
    mode = DEFAULT_FOG_MODE,
    revealNeighbors = true,
    bridges = [],
} = {}) {
    if (!isObject(exploration)) {
        return { allowed: true, blind: false, reason: null };
    }
    if (virtual) {
        // A virtual node has no polygon and is reachable through an authored
        // connection from a location the player has already visited. This rule
        // wins over an uncharted region: the node is not on the map anyway.
        const visited = new Set(Array.isArray(visitedLocationIds) ? visitedLocationIds : []);
        const reachable = (Array.isArray(connections) ? connections : []).some((id) => visited.has(id));
        if (reachable) {
            return { allowed: true, blind: true, reason: null };
        }
        if (!regionId) {
            return { allowed: false, blind: false, reason: 'uncharted' };
        }
    }
    if (!regionId) {
        return { allowed: true, blind: false, reason: null };
    }
    const visibility = computeRegionVisibility({
        exploration,
        regions: [regionId],
        bridges,
        mode,
        revealNeighbors,
    });
    const state = visibility.get(regionId) ?? regionState(exploration, regionId);
    if (state === 'discovered') {
        return { allowed: true, blind: false, reason: null };
    }
    if (state === 'rumored') {
        return { allowed: true, blind: true, reason: null };
    }
    if (gateTravel) {
        return { allowed: false, blind: false, reason: 'uncharted' };
    }
    return { allowed: true, blind: true, reason: null };
}
