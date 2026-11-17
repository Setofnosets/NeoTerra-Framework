/**
 * Canonical map geometry and authored overlay metadata.
 *
 * SVG layers are the geometry source of truth, extracted by
 * `tools/build-map.mjs` into `data/map/*`. The runtime never parses SVG. This
 * module owns the coordinate contract shared by the SVG build, the named
 * location registry, WorldState, and the Leaflet renderer:
 *
 * - canonical canvas: 2048 x 1536, y-down, origin top-left;
 * - legacy named-location data was authored on the 2017 x 1512 PNG and is
 *   scaled once into the canonical space;
 * - feature ids are `region:<slug>`, `bridge:<slug>`, `key:<slug>`.
 *
 * Browser-safe: `fetch` is injectable for Node tests; no DOM access.
 */

export const CANONICAL_MAP = Object.freeze({
    path: 'NeoTerra.png',
    width: 2048,
    height: 1536,
    sourceWidth: 2017,
    sourceHeight: 1512,
    svg: {
        combined: 'NeoTerra.svg',
        districts: 'NeoTerra_Districts.svg',
        bridges: 'NeoTerra_Bridges.svg',
        keyLocations: 'NeoTerra_Locs.svg',
    },
});

/**
 * `mapRef.layer` values. Note: generated GeoJSON features use the drawing
 * layer name `district` for regions (`RegionFeature.layer = 'district'`), but
 * location references use `region` to mean the same polygon. The two vocabularies
 * are intentional: one describes generated features, the other describes a
 * reference target. Do not conflate them in the renderer.
 */
export const MAP_LAYERS = Object.freeze(['region', 'bridge', 'keyLocation']);

export const MAP_REF_PREFIXES = Object.freeze({
    region: 'region',
    bridge: 'bridge',
    keyLocation: 'key',
});

export const BRIDGE_STATUSES = Object.freeze(['open', 'contested', 'blocked', 'destroyed']);

export const CANONICAL_DISTRICT_IDS = Object.freeze([
    'downtown',
    'harbor',
    'maple-heights',
    'fashion-row',
    'civic-center',
    'industrial-belt',
    'coast',
    'old-hills',
    'outskirts',
    'underground',
]);

export const MAP_DATA_PATHS = Object.freeze({
    map: 'data/map/map.json',
    regions: 'data/map/regions.geojson',
    bridges: 'data/map/bridges.geojson',
    keyLocations: 'data/map/key-locations.json',
    overrides: 'data/map/overrides.json',
    report: 'data/map/report.json',
});

export const MAP_PATHS = Object.freeze({
    districts: 'data/districts.json',
    overrides: 'data/map/overrides.json',
});

const DISTRICTS_URL = new URL('../../data/districts.json', import.meta.url);
const OVERRIDES_URL = new URL('../../data/map/overrides.json', import.meta.url);

const districtCache = { value: null, inFlight: null };
const overridesCache = { value: null, inFlight: null };

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

/** Stable slug for an Inkscape label (`HighriseDistrictA` -> `highrise-district-a`). */
export function slugifyMapLabel(label) {
    return String(label ?? '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

/** `featureId('keyLocation','BigOfficeA')` -> `key:big-office-a`. */
export function featureId(layer, label) {
    if (!Object.hasOwn(MAP_REF_PREFIXES, layer)) {
        throw new Error(`Unknown map layer "${String(layer)}"`);
    }
    const slug = slugifyMapLabel(label);
    if (!slug) {
        throw new Error('featureId requires a non-empty label');
    }
    return `${MAP_REF_PREFIXES[layer]}:${slug}`;
}

/** Build a `mapRef` object for an SVG feature. */
export function mapRefFor(layer, label) {
    return { layer, id: featureId(layer, label) };
}

/** Structural check for a `mapRef` stored on a named location. */
export function isValidMapRef(ref) {
    return Boolean(
        isObject(ref)
        && Object.hasOwn(MAP_REF_PREFIXES, ref.layer)
        && typeof ref.id === 'string'
        && ref.id.startsWith(`${MAP_REF_PREFIXES[ref.layer]}:`)
        && ref.id.length > MAP_REF_PREFIXES[ref.layer].length + 1,
    );
}

/**
 * Scale a point between two pixel spaces. The defaults are the canonical
 * canvas itself, so the no-argument call is an identity (not a stretch).
 */
export function scaleMapPoint(
    point,
    from = { sourceWidth: CANONICAL_MAP.width, sourceHeight: CANONICAL_MAP.height },
    to = { width: CANONICAL_MAP.width, height: CANONICAL_MAP.height },
) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('scaleMapPoint requires numeric x and y');
    }
    return {
        x: Math.round((x / from.sourceWidth) * to.width),
        y: Math.round((y / from.sourceHeight) * to.height),
    };
}

export function legacyToCanonical(point) {
    return scaleMapPoint(
        point,
        { sourceWidth: CANONICAL_MAP.sourceWidth, sourceHeight: CANONICAL_MAP.sourceHeight },
        { width: CANONICAL_MAP.width, height: CANONICAL_MAP.height },
    );
}

export function canonicalToLegacy(point) {
    return scaleMapPoint(
        point,
        { sourceWidth: CANONICAL_MAP.width, sourceHeight: CANONICAL_MAP.height },
        { width: CANONICAL_MAP.sourceWidth, height: CANONICAL_MAP.sourceHeight },
    );
}

/**
 * Resolve a mapRef against generated feature data.
 *
 * @param {{ layer: string, id: string }} ref
 * @param {{ regions?: object[], bridges?: object[], keyLocations?: object[] } | null} [features]
 * @returns {{ ok: boolean, resolved: boolean, feature: object|null, error: string|null }}
 */
export function resolveMapRef(ref, features = null) {
    if (!isValidMapRef(ref)) {
        return { ok: false, resolved: false, feature: null, error: 'invalid mapRef' };
    }
    if (!features) {
        return { ok: true, resolved: false, feature: null, error: null };
    }
    const list = ref.layer === 'region'
        ? features.regions
        : ref.layer === 'bridge'
            ? features.bridges
            : features.keyLocations;
    const feature = (list ?? []).find((entry) => entry?.id === ref.id) ?? null;
    return {
        ok: feature !== null,
        resolved: feature !== null,
        feature,
        error: feature ? null : `unresolved mapRef "${ref.id}"`,
    };
}

/** Validate `data/districts.json`. */
export function validateDistricts(document, context = {}) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'districts document must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!isObject(document.canvas)) {
        add(errors, 'canvas', 'must be an object');
    } else {
        if (document.canvas.width !== CANONICAL_MAP.width) {
            add(errors, 'canvas.width', `must be ${CANONICAL_MAP.width}`);
        }
        if (document.canvas.height !== CANONICAL_MAP.height) {
            add(errors, 'canvas.height', `must be ${CANONICAL_MAP.height}`);
        }
    }
    if (!Array.isArray(document.districts) || document.districts.length === 0) {
        add(errors, 'districts', 'must be a non-empty array');
        return result(errors);
    }

    const ids = new Set();
    const regionLabels = new Map();

    document.districts.forEach((district, index) => {
        const path = `districts[${index}]`;
        if (!isObject(district)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof district.id !== 'string' || district.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (ids.has(district.id)) {
            add(errors, `${path}.id`, `duplicate district id "${district.id}"`);
        } else {
            ids.add(district.id);
        }
        if (typeof district.name !== 'string' || district.name.trim().length === 0) {
            add(errors, `${path}.name`, 'must be a non-empty string');
        }
        if (typeof district.description !== 'string' || district.description.trim().length === 0) {
            add(errors, `${path}.description`, 'must be a non-empty string');
        }
        if (typeof district.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(district.color)) {
            add(errors, `${path}.color`, 'must be a #RRGGBB color');
        }
        if (typeof district.virtual !== 'boolean') {
            add(errors, `${path}.virtual`, 'must be a boolean');
        }
        if (!isStringArray(district.regionLabels)) {
            add(errors, `${path}.regionLabels`, 'must be an array of strings');
        } else {
            for (const label of district.regionLabels) {
                if (regionLabels.has(label)) {
                    add(
                        errors,
                        `${path}.regionLabels`,
                        `label "${label}" already belongs to district "${regionLabels.get(label)}"`,
                    );
                } else {
                    regionLabels.set(label, district.id);
                }
            }
            if (district.virtual === true && district.regionLabels.length > 0) {
                add(errors, `${path}.regionLabels`, 'virtual districts cannot own SVG regions');
            }
        }
        if (!isStringArray(district.tags)) {
            add(errors, `${path}.tags`, 'must be an array of strings');
        }
    });

    for (const districtId of CANONICAL_DISTRICT_IDS) {
        if (!ids.has(districtId)) {
            add(errors, 'districts', `missing canonical district "${districtId}"`);
        }
    }

    return result(errors);
}

/** Validate `data/map/overrides.json`. */
export function validateMapOverrides(document, context = {}) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'map overrides must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!isObject(document.canvas)) {
        add(errors, 'canvas', 'must be an object');
    } else {
        if (document.canvas.width !== CANONICAL_MAP.width) {
            add(errors, 'canvas.width', `must be ${CANONICAL_MAP.width}`);
        }
        if (document.canvas.height !== CANONICAL_MAP.height) {
            add(errors, 'canvas.height', `must be ${CANONICAL_MAP.height}`);
        }
    }

    for (const layer of ['regions', 'bridges', 'keyLocations']) {
        if (!isObject(document[layer])) {
            add(errors, layer, 'must be an object keyed by SVG label');
        }
    }

    // Region overrides must cover exactly the labels authored on districts
    // (and, when Step 13 supplies them, exactly the labels extracted from SVG).
    const overrideRegionLabels = new Set(Object.keys(document.regions ?? {}));
    if (context.districts) {
        const authored = new Set(
            (context.districts.districts ?? []).flatMap((district) => district.regionLabels ?? []),
        );
        for (const label of authored) {
            if (!overrideRegionLabels.has(label)) {
                add(errors, 'regions', `district region "${label}" has no override`);
            }
        }
        for (const label of overrideRegionLabels) {
            if (!authored.has(label)) {
                add(errors, `regions.${label}`, 'region label is not declared by any district');
            }
        }
    }
    if (context.regionLabels) {
        for (const label of context.regionLabels) {
            if (!overrideRegionLabels.has(label)) {
                add(errors, 'regions', `SVG region "${label}" has no override`);
            }
        }
        for (const label of overrideRegionLabels) {
            if (!context.regionLabels.has(label)) {
                add(errors, `regions.${label}`, 'override label does not exist in the SVG layers');
            }
        }
    }

    for (const [label, override] of Object.entries(document.regions ?? {})) {
        const path = `regions.${label}`;
        if (!label) {
            add(errors, path, 'label must be non-empty');
        }
        if (!isObject(override)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (typeof override.districtId !== 'string' || override.districtId.length === 0) {
            add(errors, `${path}.districtId`, 'must be a district id');
        } else if (context.districtIds && !context.districtIds.has(override.districtId)) {
            add(errors, `${path}.districtId`, `unresolved district "${override.districtId}"`);
        }
        for (const field of ['name', 'description', 'factionId']) {
            if (override[field] !== undefined && override[field] !== null && typeof override[field] !== 'string') {
                add(errors, `${path}.${field}`, 'must be a string when present');
            }
        }
    }

    for (const [label, override] of Object.entries(document.bridges ?? {})) {
        const path = `bridges.${label}`;
        if (!label) {
            add(errors, path, 'label must be non-empty');
        }
        if (!isObject(override)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (override.name !== undefined && typeof override.name !== 'string') {
            add(errors, `${path}.name`, 'must be a string when present');
        }
        if (override.status !== undefined && !BRIDGE_STATUSES.includes(override.status)) {
            add(errors, `${path}.status`, `must be one of ${BRIDGE_STATUSES.join(', ')}`);
        }
    }

    const locationById = context.locations
        ? new Map((context.locations.locations ?? []).map((location) => [location.id, location]))
        : null;
    const claimedLocationIds = new Map();

    for (const [label, override] of Object.entries(document.keyLocations ?? {})) {
        const path = `keyLocations.${label}`;
        if (!label) {
            add(errors, path, 'label must be non-empty');
        }
        if (!isObject(override)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (override.locationId !== undefined && override.locationId !== null && typeof override.locationId !== 'string') {
            add(errors, `${path}.locationId`, 'must be a location id or null');
        }
        if (
            typeof override.locationId === 'string'
            && context.locationIds
            && !context.locationIds.has(override.locationId)
        ) {
            add(errors, `${path}.locationId`, `unresolved location "${override.locationId}"`);
        }
        if (typeof override.locationId === 'string') {
            if (claimedLocationIds.has(override.locationId)) {
                add(
                    errors,
                    `${path}.locationId`,
                    `location "${override.locationId}" is already claimed by "${claimedLocationIds.get(override.locationId)}"`,
                );
            } else {
                claimedLocationIds.set(override.locationId, label);
            }
            const location = locationById?.get(override.locationId);
            if (locationById && !location) {
                add(errors, `${path}.locationId`, `unresolved location "${override.locationId}"`);
            } else if (location) {
                const expectedId = featureId('keyLocation', label);
                if (!location.mapRef || location.mapRef.id !== expectedId) {
                    add(
                        errors,
                        `${path}.locationId`,
                        `location "${override.locationId}" must bind back to "${expectedId}"`,
                    );
                }
            }
        }
        if (override.districtId !== undefined && typeof override.districtId !== 'string') {
            add(errors, `${path}.districtId`, 'must be a district id when present');
        }
        if (override.districtId && context.districtIds && !context.districtIds.has(override.districtId)) {
            add(errors, `${path}.districtId`, `unresolved district "${override.districtId}"`);
        }
        for (const field of ['name', 'description', 'factionId']) {
            if (override[field] !== undefined && override[field] !== null && typeof override[field] !== 'string') {
                add(errors, `${path}.${field}`, 'must be a string when present');
            }
        }
    }

    return result(errors);
}

async function loadJson(url, cache, validate, label, { fetchImpl = globalThis.fetch, context = {} } = {}) {
    if (cache.value) {
        return cache.value;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error(`${label}: no fetch implementation is available`);
    }
    if (!cache.inFlight) {
        cache.inFlight = (async () => {
            const response = await fetchImpl(url.href);
            if (response && response.ok === false) {
                throw new Error(`${label}: HTTP ${response.status ?? 'unknown'}`);
            }
            const document = await response.json();
            const validation = validate(document, context);
            if (!validation.ok) {
                const details = validation.errors
                    .map((error) => `${error.path}: ${error.message}`)
                    .join('; ');
                throw new Error(`${label}: invalid data (${details})`);
            }
            cache.value = document;
            return document;
        })().finally(() => {
            cache.inFlight = null;
        });
    }
    return cache.inFlight;
}

/** @returns {Promise<object>} `data/districts.json` */
export function loadDistricts(options = {}) {
    return loadJson(DISTRICTS_URL, districtCache, validateDistricts, 'loadDistricts', options);
}

/** @returns {Promise<object>} `data/map/overrides.json` */
export function loadMapOverrides(options = {}) {
    return loadJson(OVERRIDES_URL, overridesCache, validateMapOverrides, 'loadMapOverrides', options);
}

export function clearMapCaches() {
    districtCache.value = null;
    districtCache.inFlight = null;
    overridesCache.value = null;
    overridesCache.inFlight = null;
}

const districtIndexCache = new WeakMap();
const overrideIndexCache = new WeakMap();

export function buildDistrictIndex(document) {
    if (districtIndexCache.has(document)) {
        return districtIndexCache.get(document);
    }
    const byId = {};
    const byRegionLabel = {};
    for (const district of document?.districts ?? []) {
        byId[district.id] = district;
        for (const label of district.regionLabels ?? []) {
            byRegionLabel[label] = district.id;
        }
    }
    const index = { byId, byRegionLabel, list: document?.districts ?? [] };
    districtIndexCache.set(document, index);
    return index;
}

export function getDistrict(document, id) {
    return buildDistrictIndex(document).byId[id] ?? null;
}

export function getDistrictForRegionLabel(document, label) {
    return buildDistrictIndex(document).byRegionLabel[label] ?? null;
}

export function buildMapOverrideIndex(document) {
    if (overrideIndexCache.has(document)) {
        return overrideIndexCache.get(document);
    }
    const index = {
        regions: { ...(document?.regions ?? {}) },
        bridges: { ...(document?.bridges ?? {}) },
        keyLocations: { ...(document?.keyLocations ?? {}) },
    };
    overrideIndexCache.set(document, index);
    return index;
}

export function getRegionOverride(document, label) {
    return buildMapOverrideIndex(document).regions[label] ?? null;
}

export function getBridgeOverride(document, label) {
    return buildMapOverrideIndex(document).bridges[label] ?? null;
}

export function getKeyLocationOverride(document, label) {
    return buildMapOverrideIndex(document).keyLocations[label] ?? null;
}

/** Labels that still have no authored name beyond their generic SVG label. */
export function listUnauthoredKeyLocations(overridesDocument) {
    return Object.entries(overridesDocument?.keyLocations ?? {})
        .filter(([, override]) => !override?.name)
        .map(([label]) => label);
}
