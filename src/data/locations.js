/**
 * Named-location lore registry and map-node helpers.
 *
 * Coordinates use the canonical SVG map space (2048 x 1536, y-down). The base
 * PNG was authored at 2017 x 1512 and is stretched to the canonical box; the
 * legacy coordinates were scaled once. SVG extraction and feature ids live in
 * `src/data/map.js`; this module owns the authored lore locations that seasons
 * reference by stable id.
 */

import {
    CANONICAL_MAP,
    isValidMapRef,
    resolveMapRef,
} from './map.js';

const LOCATIONS_URL = new URL('../../data/locations.json', import.meta.url);

export const DEFAULT_MAP_IMAGE = Object.freeze({
    path: CANONICAL_MAP.path,
    width: CANONICAL_MAP.width,
    height: CANONICAL_MAP.height,
    sourceWidth: CANONICAL_MAP.sourceWidth,
    sourceHeight: CANONICAL_MAP.sourceHeight,
});

export const TRAVEL_MODES = Object.freeze(['walk', 'bridge', 'flight', 'secret']);

export const LOCATION_KINDS = Object.freeze([
    'landmark',
    'base',
    'district',
    'venue',
    'facility',
    'hideout',
    'wilderness',
]);

export const LOCATION_STATUSES = Object.freeze([
    'peaceful',
    'patrolled',
    'contested',
    'hostile',
    'locked',
    'unknown',
]);

let cached = null;
let inFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

/** True when a pixel coordinate lies inside the map image. */
export function isCoordinateInImage(x, y, image = DEFAULT_MAP_IMAGE) {
    return (
        Number.isFinite(x)
        && Number.isFinite(y)
        && x >= 0
        && y >= 0
        && x <= image.width
        && y <= image.height
    );
}

/** Euclidean pixel distance between two nodes. */
export function distanceBetween(a, b) {
    if (!a || !b) {
        return null;
    }
    return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

/**
 * @param {unknown} document
 * @param {{ factionIds?: Set<string> }} [context] optional cross-file refs
 */
export function validateLocations(document, context = {}) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'locations document must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }

    const image = isObject(document.image) ? document.image : DEFAULT_MAP_IMAGE;
    if (typeof image.path !== 'string' || image.path.length === 0) {
        add(errors, 'image.path', 'must be a non-empty string');
    }
    if (image.path !== CANONICAL_MAP.path) {
        add(errors, 'image.path', `must be "${CANONICAL_MAP.path}"`);
    }
    if (image.width !== CANONICAL_MAP.width || image.height !== CANONICAL_MAP.height) {
        add(
            errors,
            'image',
            `canonical map space must be ${CANONICAL_MAP.width}x${CANONICAL_MAP.height}`,
        );
    }
    if (image.sourceWidth !== undefined && image.sourceWidth !== CANONICAL_MAP.sourceWidth) {
        add(errors, 'image.sourceWidth', `must be ${CANONICAL_MAP.sourceWidth}`);
    }
    if (image.sourceHeight !== undefined && image.sourceHeight !== CANONICAL_MAP.sourceHeight) {
        add(errors, 'image.sourceHeight', `must be ${CANONICAL_MAP.sourceHeight}`);
    }

    if (!Array.isArray(document.locations) || document.locations.length === 0) {
        add(errors, 'locations', 'must be a non-empty array');
        return result(errors);
    }

    const ids = new Set();
    document.locations.forEach((location, index) => {
        const path = `locations[${index}]`;
        if (!isObject(location)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof location.id !== 'string' || location.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (ids.has(location.id)) {
            add(errors, `${path}.id`, `duplicate location id "${location.id}"`);
        } else {
            ids.add(location.id);
        }
        if (typeof location.name !== 'string' || location.name.trim().length === 0) {
            add(errors, `${path}.name`, 'must be a non-empty string');
        }
        if (typeof location.description !== 'string' || location.description.trim().length === 0) {
            add(errors, `${path}.description`, 'must be a non-empty string');
        }
        if (!isCoordinateInImage(location.x, location.y, image)) {
            add(errors, `${path}.x`, 'coordinates must fall inside the map image');
        }
        if (typeof location.district !== 'string' || location.district.length === 0) {
            add(errors, `${path}.district`, 'must be a non-empty string');
        }
        if (!LOCATION_KINDS.includes(location.kind)) {
            add(errors, `${path}.kind`, `unknown kind "${String(location.kind)}"`);
        }
        if (location.factionId !== null && typeof location.factionId !== 'string') {
            add(errors, `${path}.factionId`, 'must be a string or null');
        } else if (
            typeof location.factionId === 'string'
            && context.factionIds
            && !context.factionIds.has(location.factionId)
        ) {
            add(errors, `${path}.factionId`, `unresolved faction "${location.factionId}"`);
        }
        if (!Number.isInteger(location.capacity) || location.capacity <= 0) {
            add(errors, `${path}.capacity`, 'must be a positive integer');
        }
        if (!LOCATION_STATUSES.includes(location.defaultStatus)) {
            add(errors, `${path}.defaultStatus`, `unknown status "${String(location.defaultStatus)}"`);
        }
        if (!Array.isArray(location.connections) || !location.connections.every((id) => typeof id === 'string')) {
            add(errors, `${path}.connections`, 'must be an array of strings');
        }
        if (!Array.isArray(location.tags) || !location.tags.every((tag) => typeof tag === 'string')) {
            add(errors, `${path}.tags`, 'must be an array of strings');
        }

        // --- canonical map binding -------------------------------------
        if (typeof location.districtId !== 'string' || location.districtId.length === 0) {
            add(errors, `${path}.districtId`, 'must be a canonical district id');
        } else if (context.districtIds && !context.districtIds.has(location.districtId)) {
            add(errors, `${path}.districtId`, `unresolved district "${location.districtId}"`);
        }
        if (location.regionId !== null && typeof location.regionId !== 'string') {
            add(errors, `${path}.regionId`, 'must be an SVG region id or null');
        } else if (
            typeof location.regionId === 'string'
            && context.regionIds
            && !context.regionIds.has(location.regionId)
        ) {
            add(errors, `${path}.regionId`, `unresolved region "${location.regionId}"`);
        }
        if (typeof location.virtual !== 'boolean') {
            add(errors, `${path}.virtual`, 'must be a boolean');
        }
        if (location.mapRef !== null && location.mapRef !== undefined) {
            if (!isValidMapRef(location.mapRef)) {
                add(errors, `${path}.mapRef`, 'must be a valid { layer, id } map reference');
            } else {
                if (location.virtual === true) {
                    add(errors, `${path}.mapRef`, 'virtual locations cannot also bind to an SVG feature');
                }
                if (context.mapFeatures) {
                    const resolved = resolveMapRef(location.mapRef, context.mapFeatures);
                    if (!resolved.ok && resolved.error) {
                        add(errors, `${path}.mapRef`, resolved.error);
                    }
                }
            }
        } else if (location.virtual !== true) {
            add(errors, `${path}.mapRef`, 'a location must declare a mapRef or be explicitly virtual');
        }
        if (!Array.isArray(location.travel) || location.travel.length === 0) {
            add(errors, `${path}.travel`, 'must be a non-empty array of travel modes');
        } else {
            const unknown = location.travel.filter((mode) => !TRAVEL_MODES.includes(mode));
            if (unknown.length > 0) {
                add(errors, `${path}.travel`, `unknown travel mode "${unknown[0]}"`);
            }
        }
    });

    for (const location of document.locations) {
        if (!isObject(location) || !Array.isArray(location.connections)) {
            continue;
        }
        for (const connectionId of location.connections) {
            if (!ids.has(connectionId)) {
                add(errors, `locations.${location.id}.connections`, `unresolved location "${connectionId}"`);
                continue;
            }
            if (connectionId === location.id) {
                add(errors, `locations.${location.id}.connections`, 'a location cannot connect to itself');
                continue;
            }
            const other = document.locations.find((candidate) => candidate?.id === connectionId);
            if (other && Array.isArray(other.connections) && !other.connections.includes(location.id)) {
                add(
                    errors,
                    `locations.${location.id}.connections`,
                    `connection to "${connectionId}" must be declared on both nodes`,
                );
            }
        }
    }

    if (document.locations.length > 0) {
        const districts = new Set(document.locations.map((location) => location?.district).filter(Boolean));
        if (districts.size < 3) {
            add(errors, 'locations', 'must cover at least three districts');
        }
    }

    return result(errors);
}

/**
 * @param {{ fetchImpl?: typeof fetch, context?: object }} [options]
 * @returns {Promise<object>}
 */
export async function loadLocations({ fetchImpl = globalThis.fetch, context = {} } = {}) {
    if (cached) {
        return cached;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadLocations: no fetch implementation is available');
    }
    if (!inFlight) {
        inFlight = (async () => {
            const response = await fetchImpl(LOCATIONS_URL.href);
            if (response && response.ok === false) {
                throw new Error(`loadLocations: HTTP ${response.status ?? 'unknown'}`);
            }
            const document = await response.json();
            const validation = validateLocations(document, context);
            if (!validation.ok) {
                const details = validation.errors
                    .map((error) => `${error.path}: ${error.message}`)
                    .join('; ');
                throw new Error(`loadLocations: invalid location data (${details})`);
            }
            cached = document;
            return document;
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

export function clearLocationsCache() {
    cached = null;
    inFlight = null;
}

const indexCache = new WeakMap();

export function buildLocationIndex(document) {
    if (indexCache.has(document)) {
        return indexCache.get(document);
    }
    const byId = {};
    const byDistrict = {};
    for (const location of document?.locations ?? []) {
        byId[location.id] = location;
        if (!byDistrict[location.district]) {
            byDistrict[location.district] = [];
        }
        byDistrict[location.district].push(location);
    }
    const index = {
        byId,
        byDistrict,
        list: document?.locations ?? [],
        image: document?.image ?? DEFAULT_MAP_IMAGE,
    };
    indexCache.set(document, index);
    return index;
}

export function getLocation(document, id) {
    return buildLocationIndex(document).byId[id] ?? null;
}

export function getConnectedLocations(document, id) {
    const index = buildLocationIndex(document);
    const location = index.byId[id];
    if (!location) {
        return [];
    }
    return (location.connections ?? []).map((connectionId) => index.byId[connectionId]).filter(Boolean);
}

export function areLocationsAdjacent(document, fromId, toId) {
    return getConnectedLocations(document, fromId).some((location) => location.id === toId);
}

export function findLocationsByTag(document, tag) {
    return (document?.locations ?? []).filter((location) => location.tags?.includes(tag));
}

/* ------------------------------------------------------------------ *
 * MapRef / region helpers (Step 13)
 * ------------------------------------------------------------------ */

/**
 * Group named locations by the generated SVG region they resolve to.
 * Virtual nodes with no region are grouped under `null` so the UI can list
 * them separately.
 */
export function buildLocationsByRegion(document) {
    const groups = new Map();
    for (const location of document?.locations ?? []) {
        const key = location.regionId ?? null;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(location);
    }
    return groups;
}

/** Every named location bound to a generated key-location feature id. */
export function findLocationByMapRef(document, mapRef) {
    if (!mapRef || typeof mapRef.id !== 'string') {
        return null;
    }
    return (document?.locations ?? []).find(
        (location) => location.mapRef && location.mapRef.layer === mapRef.layer && location.mapRef.id === mapRef.id,
    ) ?? null;
}

/** Every named location resolved to one generated region id. */
export function findLocationsInRegion(document, regionId) {
    return (document?.locations ?? []).filter((location) => location.regionId === regionId);
}

/**
 * Validate that every non-virtual location's `mapRef` points at a generated
 * feature and that its `regionId` agrees with the generated assignment.
 *
 * @param {object} document `data/locations.json`
 * @param {{
 *   regions?: { features: object[] } | null,
 *   keyLocations?: { keyLocations: object[] } | null,
 *   bridges?: { features: object[] } | null,
 * }} generated
 */
export function validateLocationMapBindings(document, generated = {}) {
    const errors = [];
    const regionIds = new Set((generated.regions?.features ?? []).map((feature) => feature.id));
    const bridgeIds = new Set((generated.bridges?.features ?? []).map((feature) => feature.id));
    const keyIds = new Set((generated.keyLocations?.keyLocations ?? []).map((feature) => feature.id));
    const keyRegions = new Map(
        (generated.keyLocations?.keyLocations ?? []).map((feature) => [feature.id, feature.regionId ?? null]),
    );

    for (const location of document?.locations ?? []) {
        const path = `locations.${location?.id ?? '?'}`;
        if (!isObject(location)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (location.virtual === true) {
            if (location.mapRef !== null && location.mapRef !== undefined) {
                add(errors, `${path}.mapRef`, 'virtual locations cannot bind to generated geometry');
            }
            continue;
        }
        if (!isValidMapRef(location.mapRef)) {
            add(errors, `${path}.mapRef`, 'non-virtual locations need a valid mapRef');
            continue;
        }
        const known = location.mapRef.layer === 'region'
            ? regionIds
            : location.mapRef.layer === 'bridge'
                ? bridgeIds
                : keyIds;
        if (!known.has(location.mapRef.id)) {
            add(errors, `${path}.mapRef`, `unresolved generated feature "${location.mapRef.id}"`);
        }
        if (location.mapRef.layer === 'keyLocation' && keyRegions.has(location.mapRef.id)) {
            const derived = keyRegions.get(location.mapRef.id);
            if (location.regionId !== derived) {
                add(
                    errors,
                    `${path}.regionId`,
                    `must be "${derived}" to match its key-location marker`,
                );
            }
        }
        if (location.regionId !== null && typeof location.regionId === 'string' && !regionIds.has(location.regionId)) {
            add(errors, `${path}.regionId`, `unresolved region "${location.regionId}"`);
        }
    }
    return result(errors);
}
