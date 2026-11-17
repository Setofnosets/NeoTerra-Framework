/**
 * Location registry and map-node helpers.
 *
 * Coordinates are pixel positions on `NeoTerra.png` (2017 x 1512). They are
 * authored manually and must always stay inside the source image.
 */

const LOCATIONS_URL = new URL('../../data/locations.json', import.meta.url);

export const DEFAULT_MAP_IMAGE = Object.freeze({
    path: 'NeoTerra.png',
    width: 2017,
    height: 1512,
});

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
    for (const dimension of ['width', 'height']) {
        if (!Number.isInteger(image[dimension]) || image[dimension] <= 0) {
            add(errors, `image.${dimension}`, 'must be a positive integer');
        }
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
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function loadLocations({ fetchImpl = globalThis.fetch } = {}) {
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
            const validation = validateLocations(document);
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
