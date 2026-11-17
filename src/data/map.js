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

/** Expected feature counts from the authored SVG layers. */
export const MAP_FEATURE_COUNTS = Object.freeze({
    districts: 36,
    bridges: 12,
    keyLocations: 22,
});

/**
 * Region kinds produced by `tools/build-map.mjs`. Kept in one place so the
 * validator, the renderer, and tests agree.
 */
export const REGION_KINDS = Object.freeze([
    'residential',
    'highrise',
    'industrial',
    'slum',
    'park',
    'dock',
    'airport',
    'island',
    'water',
    'wilderness',
    'center',
    'unknown',
]);

export const KEY_LOCATION_KINDS = Object.freeze([
    'office',
    'home',
    'safehouse',
    'terminal',
    'dock',
    'stadium',
    'park',
    'industrial',
    'unknown',
]);

/** Water regions never carry faction control or markers of their own. */
export const WATER_REGION_KINDS = Object.freeze(['water']);

/** Canonical draw order for renderer layers. */
export const MAP_LAYER_ORDER = Object.freeze([
    'districts',
    'bridges',
    'keyLocations',
    'namedLocations',
    'labels',
    'fog',
]);

/** Default layer visibility: all art layers on, fog off. */
export const DEFAULT_LAYER_VISIBILITY = Object.freeze({
    districts: true,
    bridges: true,
    keyLocations: true,
    namedLocations: true,
    labels: true,
    fog: false,
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

/* ------------------------------------------------------------------ *
 * Generated data (`data/map/*` from tools/build-map.mjs)
 * ------------------------------------------------------------------ */

const MAP_MANIFEST_URL = new URL('../../data/map/map.json', import.meta.url);
const REGIONS_URL = new URL('../../data/map/regions.geojson', import.meta.url);
const BRIDGES_URL = new URL('../../data/map/bridges.geojson', import.meta.url);
const KEY_LOCATIONS_URL = new URL('../../data/map/key-locations.json', import.meta.url);

const generatedCaches = {
    map: { value: null, inFlight: null },
    regions: { value: null, inFlight: null },
    bridges: { value: null, inFlight: null },
    keyLocations: { value: null, inFlight: null },
};

function isPoint(value) {
    return isObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function isInCanvas(point) {
    return isPoint(point)
        && point.x >= 0 && point.x <= CANONICAL_MAP.width
        && point.y >= 0 && point.y <= CANONICAL_MAP.height;
}

/** Structural + semantic validation of `data/map/map.json`. */
export function validateMapManifest(document) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'map manifest must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!isObject(document.canvas)) {
        add(errors, 'canvas', 'must be an object');
    } else if (document.canvas.width !== CANONICAL_MAP.width || document.canvas.height !== CANONICAL_MAP.height) {
        add(errors, 'canvas', `must be ${CANONICAL_MAP.width}x${CANONICAL_MAP.height}`);
    }
    if (!Array.isArray(document.layers) || document.layers.length === 0) {
        add(errors, 'layers', 'must be a non-empty array');
    }
    if (!isObject(document.counts)) {
        add(errors, 'counts', 'must be an object');
    } else {
        for (const [key, expected] of Object.entries(MAP_FEATURE_COUNTS)) {
            if (document.counts[key] !== expected) {
                add(errors, `counts.${key}`, `must be ${expected}`);
            }
        }
    }
    return result(errors);
}

/** Validate `data/map/regions.geojson`. */
export function validateRegionCollection(document) {
    const errors = [];
    if (!isObject(document) || document.type !== 'FeatureCollection') {
        add(errors, '$', 'must be a GeoJSON FeatureCollection');
        return result(errors);
    }
    if (!Array.isArray(document.features) || document.features.length === 0) {
        add(errors, 'features', 'must be a non-empty array');
        return result(errors);
    }
    const ids = new Set();
    document.features.forEach((feature, index) => {
        const path = `features[${index}]`;
        if (!isObject(feature)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof feature.id !== 'string' || !feature.id.startsWith('region:')) {
            add(errors, `${path}.id`, 'must start with "region:"');
        } else if (ids.has(feature.id)) {
            add(errors, `${path}.id`, `duplicate region id "${feature.id}"`);
        } else {
            ids.add(feature.id);
        }
        if (typeof feature.label !== 'string' || feature.label.length === 0) {
            add(errors, `${path}.label`, 'must be a non-empty string');
        }
        if (feature.layer !== 'district') {
            add(errors, `${path}.layer`, 'must be "district"');
        }
        if (!REGION_KINDS.includes(feature.kind)) {
            add(errors, `${path}.kind`, `unknown kind "${String(feature.kind)}"`);
        }
        const coordinates = feature.geometry?.coordinates?.[0];
        if (!Array.isArray(coordinates) || coordinates.length < 4) {
            add(errors, `${path}.geometry`, 'must be a closed polygon with at least 4 points');
        }
        if (!isInCanvas(feature.centroid)) {
            add(errors, `${path}.centroid`, 'must be inside the canonical canvas');
        }
        if (!Array.isArray(feature.bbox) || feature.bbox.length !== 4) {
            add(errors, `${path}.bbox`, 'must be [minX, minY, maxX, maxY]');
        }
        if (typeof feature.districtId !== 'string' || feature.districtId.length === 0) {
            add(errors, `${path}.districtId`, 'must be a district id');
        }
    });
    if (ids.size !== MAP_FEATURE_COUNTS.districts) {
        add(errors, 'features', `expected ${MAP_FEATURE_COUNTS.districts} regions, found ${ids.size}`);
    }
    return result(errors);
}

/** Validate `data/map/bridges.geojson`. */
export function validateBridgeCollection(document, context = {}) {
    const errors = [];
    if (!isObject(document) || document.type !== 'FeatureCollection') {
        add(errors, '$', 'must be a GeoJSON FeatureCollection');
        return result(errors);
    }
    if (!Array.isArray(document.features) || document.features.length === 0) {
        add(errors, 'features', 'must be a non-empty array');
        return result(errors);
    }
    const ids = new Set();
    const regionIds = context.regionIds ?? null;
    document.features.forEach((feature, index) => {
        const path = `features[${index}]`;
        if (!isObject(feature)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof feature.id !== 'string' || !feature.id.startsWith('bridge:')) {
            add(errors, `${path}.id`, 'must start with "bridge:"');
        } else if (ids.has(feature.id)) {
            add(errors, `${path}.id`, `duplicate bridge id "${feature.id}"`);
        } else {
            ids.add(feature.id);
        }
        if (feature.layer !== 'bridge') {
            add(errors, `${path}.layer`, 'must be "bridge"');
        }
        if (!BRIDGE_STATUSES.includes(feature.status)) {
            add(errors, `${path}.status`, `must be one of ${BRIDGE_STATUSES.join(', ')}`);
        }
        if (!Array.isArray(feature.endpoints) || feature.endpoints.length !== 2
            || !feature.endpoints.every(isInCanvas)) {
            add(errors, `${path}.endpoints`, 'must be two canvas points');
        }
        if (!Array.isArray(feature.connects) || feature.connects.length !== 2) {
            add(errors, `${path}.connects`, 'must name exactly two regions');
        } else {
            for (const regionId of feature.connects) {
                if (typeof regionId !== 'string' || !regionId.startsWith('region:')) {
                    add(errors, `${path}.connects`, `invalid region id "${String(regionId)}"`);
                } else if (regionIds && !regionIds.has(regionId)) {
                    add(errors, `${path}.connects`, `unresolved region "${regionId}"`);
                }
            }
            if (feature.connects[0] === feature.connects[1]) {
                add(errors, `${path}.connects`, 'a bridge must connect two distinct regions');
            }
        }
        if (!Number.isFinite(feature.length) || feature.length <= 0) {
            add(errors, `${path}.length`, 'must be a positive number');
        }
        if (!Array.isArray(feature.centerline) || feature.centerline.length < 2) {
            add(errors, `${path}.centerline`, 'must have at least two points');
        }
    });
    if (ids.size !== MAP_FEATURE_COUNTS.bridges) {
        add(errors, 'features', `expected ${MAP_FEATURE_COUNTS.bridges} bridges, found ${ids.size}`);
    }
    return result(errors);
}

/** Validate `data/map/key-locations.json`. */
export function validateKeyLocationDocument(document, context = {}) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'key-location document must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!Array.isArray(document.keyLocations) || document.keyLocations.length === 0) {
        add(errors, 'keyLocations', 'must be a non-empty array');
        return result(errors);
    }
    const ids = new Set();
    const regionIds = context.regionIds ?? null;
    document.keyLocations.forEach((feature, index) => {
        const path = `keyLocations[${index}]`;
        if (!isObject(feature)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof feature.id !== 'string' || !feature.id.startsWith('key:')) {
            add(errors, `${path}.id`, 'must start with "key:"');
        } else if (ids.has(feature.id)) {
            add(errors, `${path}.id`, `duplicate key-location id "${feature.id}"`);
        } else {
            ids.add(feature.id);
        }
        if (feature.layer !== 'keyLocation') {
            add(errors, `${path}.layer`, 'must be "keyLocation"');
        }
        if (!KEY_LOCATION_KINDS.includes(feature.kind)) {
            add(errors, `${path}.kind`, `unknown kind "${String(feature.kind)}"`);
        }
        if (!isInCanvas({ x: feature.x, y: feature.y })) {
            add(errors, `${path}.x`, 'must be inside the canonical canvas');
        }
        if (feature.regionId === null || feature.regionId === undefined) {
            add(errors, `${path}.regionId`, 'every key location must resolve to a region');
        } else if (regionIds && !regionIds.has(feature.regionId)) {
            add(errors, `${path}.regionId`, `unresolved region "${feature.regionId}"`);
        }
    });
    if (ids.size !== MAP_FEATURE_COUNTS.keyLocations) {
        add(errors, 'keyLocations', `expected ${MAP_FEATURE_COUNTS.keyLocations} key locations, found ${ids.size}`);
    }
    return result(errors);
}

async function loadGenerated(url, cache, validate, label, options) {
    if (options?.refresh) {
        cache.value = null;
    }
    return loadJson(url, cache, validate, label, options);
}

/** @returns {Promise<object>} `data/map/map.json` */
export function loadMapManifest(options = {}) {
    return loadGenerated(MAP_MANIFEST_URL, generatedCaches.map, validateMapManifest, 'loadMapManifest', options);
}

/** @returns {Promise<object>} `data/map/regions.geojson` */
export function loadRegions(options = {}) {
    return loadGenerated(REGIONS_URL, generatedCaches.regions, validateRegionCollection, 'loadRegions', options);
}

/**
 * @param {{ fetchImpl?: typeof fetch, regionIds?: Set<string>, refresh?: boolean }} [options]
 * @returns {Promise<object>} `data/map/bridges.geojson`
 */
export function loadBridges(options = {}) {
    return loadGenerated(
        BRIDGES_URL,
        generatedCaches.bridges,
        (document, context) => validateBridgeCollection(document, context),
        'loadBridges',
        options,
    );
}

/**
 * @param {{ fetchImpl?: typeof fetch, regionIds?: Set<string>, refresh?: boolean }} [options]
 * @returns {Promise<object>} `data/map/key-locations.json`
 */
export function loadKeyLocations(options = {}) {
    return loadGenerated(
        KEY_LOCATIONS_URL,
        generatedCaches.keyLocations,
        (document, context) => validateKeyLocationDocument(document, context),
        'loadKeyLocations',
        options,
    );
}

export function clearGeneratedMapCaches() {
    for (const cache of Object.values(generatedCaches)) {
        cache.value = null;
        cache.inFlight = null;
    }
}

/**
 * Load every generated artifact. Resolves to `null` when the build output is
 * missing or invalid so the UI can fall back to a single-image map.
 */
export async function loadGeneratedMapData(options = {}) {
    try {
        const [map, regions, bridges, keyLocations] = await Promise.all([
            loadMapManifest(options),
            loadRegions(options),
            loadBridges(options),
            loadKeyLocations(options),
        ]);
        return { map, regions, bridges, keyLocations };
    } catch (error) {
        if (options.strict) {
            throw error;
        }
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Geometry + feature indexes
 * ------------------------------------------------------------------ */

/**
 * Convert canonical y-down SVG coordinates to Leaflet `L.CRS.Simple` latlng
 * *values* without importing Leaflet. Data always stays in SVG coordinates;
 * only the renderer converts.
 */
export function toLatLng({ x, y } = {}) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
        throw new Error('toLatLng requires numeric x and y');
    }
    // Adding 0 normalizes -0 to 0 so serialized values stay stable.
    return { lat: -py + 0, lng: px + 0 };
}

/** Inverse of {@link toLatLng}. */
export function toMapPoint(latlng = {}) {
    const lat = Number(latlng.lat);
    const lng = Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('toMapPoint requires numeric lat and lng');
    }
    return { x: lng, y: -lat };
}

/** The Leaflet bounds for `L.CRS.Simple`: `[[-height, 0], [0, width]]`. */
export function mapBounds() {
    return [[-CANONICAL_MAP.height, 0], [0, CANONICAL_MAP.width]];
}

function regionPoints(feature) {
    const ring = feature?.geometry?.coordinates?.[0] ?? [];
    return ring.slice(0, -1).map(([x, y]) => ({ x, y }));
}

/** Ray-casting point-in-polygon for canonical SVG coordinates. */
export function pointInPolygon(point, polygon) {
    if (!isPoint(point) || !Array.isArray(polygon) || polygon.length < 3) {
        return false;
    }
    const { x, y } = point;
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const xi = Number(polygon[index]?.x ?? polygon[index]?.[0]);
        const yi = Number(polygon[index]?.y ?? polygon[index]?.[1]);
        const xj = Number(polygon[previous]?.x ?? polygon[previous]?.[0]);
        const yj = Number(polygon[previous]?.y ?? polygon[previous]?.[1]);
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

export function pointInRegion(point, regionFeature) {
    return pointInPolygon(point, regionPoints(regionFeature));
}

export class MapDataError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MapDataError';
    }
}

/**
 * Index generated features together with the authored overlays. All lookups
 * used by the renderer and the map panel go through here so the two never
 * disagree about which feature a label refers to.
 */
export function buildMapFeatureIndex({
    regions = null,
    bridges = null,
    keyLocations = null,
    overrides = null,
    districts = null,
    locations = null,
} = {}) {
    const regionList = regions?.features ?? [];
    const bridgeList = bridges?.features ?? [];
    const keyList = keyLocations?.keyLocations ?? [];
    const districtIndex = districts ? buildDistrictIndex(districts) : null;
    const overrideIndex = overrides ? buildMapOverrideIndex(overrides) : { regions: {}, bridges: {}, keyLocations: {} };
    const byId = new Map();
    const byLabel = new Map();
    const keyByLocationId = new Map();
    const locationById = new Map((locations?.locations ?? []).map((location) => [location.id, location]));

    for (const region of regionList) {
        byId.set(region.id, region);
        byLabel.set(region.label, region);
    }
    for (const bridge of bridgeList) {
        byId.set(bridge.id, bridge);
        byLabel.set(bridge.label, bridge);
    }
    for (const key of keyList) {
        byId.set(key.id, key);
        byLabel.set(key.label, key);
        if (typeof key.locationId === 'string') {
            keyByLocationId.set(key.locationId, key);
        }
    }

    const regionById = new Map(regionList.map((region) => [region.id, region]));
    const keyLocationsByRegion = new Map();
    for (const key of keyList) {
        if (!key.regionId) {
            continue;
        }
        if (!keyLocationsByRegion.has(key.regionId)) {
            keyLocationsByRegion.set(key.regionId, []);
        }
        keyLocationsByRegion.get(key.regionId).push(key);
    }
    const bridgesByRegion = new Map();
    for (const bridge of bridgeList) {
        for (const regionId of bridge.connects ?? []) {
            if (!bridgesByRegion.has(regionId)) {
                bridgesByRegion.set(regionId, []);
            }
            bridgesByRegion.get(regionId).push(bridge);
        }
    }
    const regionsByDistrict = new Map();
    for (const region of regionList) {
        const districtId = region.districtId ?? districtIndex?.byRegionLabel?.[region.label] ?? null;
        if (!districtId) {
            continue;
        }
        if (!regionsByDistrict.has(districtId)) {
            regionsByDistrict.set(districtId, []);
        }
        regionsByDistrict.get(districtId).push(region);
    }

    return {
        regions: regionList,
        bridges: bridgeList,
        keyLocations: keyList,
        regionById,
        regionsByDistrict,
        keyLocationsByRegion,
        bridgesByRegion,
        keyByLocationId,
        locationById,
        districtIndex,
        overrideIndex,
        get: (id) => byId.get(id) ?? null,
        getByLabel: (label) => byLabel.get(label) ?? null,
        getRegionForLocation(locationId) {
            const key = keyByLocationId.get(locationId);
            if (key?.regionId) {
                return regionById.get(key.regionId) ?? null;
            }
            const location = locationById.get(locationId);
            if (location?.regionId) {
                return regionById.get(location.regionId) ?? null;
            }
            return null;
        },
        getRegionAt(point) {
            for (const region of regionList) {
                if (pointInRegion(point, region)) {
                    return region;
                }
            }
            return null;
        },
        getBridgesForRegion(regionId) {
            return (bridgesByRegion.get(regionId) ?? []).slice();
        },
        getKeyLocationsForRegion(regionId) {
            return (keyLocationsByRegion.get(regionId) ?? []).slice();
        },
    };
}

/**
 * Compose the render/panel view model: generated geometry + authored
 * overrides + named location lore + live `WorldState`.
 *
 * Everything in the result is renderer-agnostic and in canonical SVG
 * coordinates. The Leaflet adapter converts with `toLatLng`; tests assert on
 * this shape.
 */
export function buildMapViewModel({
    regions = null,
    bridges = null,
    keyLocations = null,
    overrides = null,
    districts = null,
    locations = null,
    state = null,
    index = null,
} = {}) {
    const featureIndex = index ?? buildMapFeatureIndex({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
    });

    const stateLocations = state?.locations ?? {};
    const stateFactions = state?.factions ?? {};

    const regionViews = featureIndex.regions.map((region) => {
        const override = featureIndex.overrideIndex.regions?.[region.label] ?? null;
        const districtId = override?.districtId ?? region.districtId ?? null;
        const district = districtId ? featureIndex.districtIndex?.byId?.[districtId] ?? null : null;
        // Live control comes from WorldState location entries whose named
        // location resolves to this region.
        const liveFactionFor = (locationId) => stateLocations[locationId]?.factionId ?? null;
        const namedInRegion = [...featureIndex.locationById.values()]
            .filter((location) => location.regionId === region.id);
        const liveControl = namedInRegion
            .map((location) => liveFactionFor(location.id))
            .find(Boolean) ?? null;
        const factionId = override?.factionId ?? liveControl ?? district?.factionId ?? null;
        const liveStatuses = namedInRegion
            .map((location) => stateLocations[location.id]?.status)
            .filter(Boolean);
        const status = liveStatuses.includes('hostile')
            ? 'hostile'
            : liveStatuses.includes('contested')
                ? 'contested'
                : null;
        return {
            id: region.id,
            kind: 'region',
            label: region.label,
            name: override?.name ?? region.name ?? region.label,
            description: override?.description ?? district?.description ?? null,
            districtId,
            districtName: district?.name ?? null,
            regionKind: region.kind,
            color: district?.color ?? region.sourceColor ?? null,
            sourceColor: region.sourceColor ?? null,
            centroid: region.centroid,
            bbox: region.bbox,
            geometry: region.geometry,
            factionId,
            factionName: factionId ? stateFactions[factionId]?.name ?? factionId : null,
            status,
            keyLocationIds: featureIndex.getKeyLocationsForRegion(region.id).map((key) => key.id),
            bridgeIds: featureIndex.getBridgesForRegion(region.id).map((bridge) => bridge.id),
            labelHidden: false,
        };
    });
    const regionViewById = new Map(regionViews.map((view) => [view.id, view]));

    const bridgeViews = featureIndex.bridges.map((bridge) => {
        const override = featureIndex.overrideIndex.bridges?.[bridge.label] ?? null;
        const [a, b] = bridge.connects ?? [];
        return {
            id: bridge.id,
            kind: 'bridge',
            label: bridge.label,
            name: override?.name ?? bridge.name ?? bridge.label,
            status: override?.status ?? bridge.status ?? 'open',
            endpoints: bridge.endpoints,
            centerline: bridge.centerline,
            geometry: bridge.geometry,
            connects: [a ?? null, b ?? null],
            connectsNames: [a, b].map((regionId) => regionViewById.get(regionId)?.name ?? null),
            length: bridge.length,
            sourceColor: bridge.sourceColor ?? null,
            centroid: bridge.centroid,
            labelHidden: false,
        };
    });
    const bridgeViewById = new Map(bridgeViews.map((view) => [view.id, view]));

    const keyViews = featureIndex.keyLocations.map((key) => {
        const override = featureIndex.overrideIndex.keyLocations?.[key.label] ?? null;
        const namedLocation = key.locationId ? featureIndex.locationById.get(key.locationId) ?? null : null;
        const districtId = override?.districtId ?? key.districtId ?? null;
        return {
            id: key.id,
            kind: 'keyLocation',
            label: key.label,
            name: override?.name ?? key.name ?? key.label,
            locationId: key.locationId ?? null,
            named: Boolean(namedLocation),
            locationKind: key.kind,
            x: key.x,
            y: key.y,
            regionId: key.regionId,
            regionName: key.regionId ? regionViewById.get(key.regionId)?.name ?? null : null,
            districtId,
            factionId: override?.factionId ?? null,
            description: override?.description ?? namedLocation?.description ?? null,
            labelHidden: false,
        };
    });
    const keyViewById = new Map(keyViews.map((view) => [view.id, view]));

    const locationViews = (locations?.locations ?? []).map((location) => {
        const live = stateLocations[location.id] ?? null;
        const key = location.mapRef?.layer === 'keyLocation'
            ? featureIndex.get(location.mapRef.id)
            : null;
        return {
            id: location.id,
            kind: 'namedLocation',
            name: location.name,
            description: location.description,
            locationKind: location.kind,
            x: location.x,
            y: location.y,
            districtId: location.districtId ?? null,
            regionId: location.regionId ?? key?.regionId ?? null,
            regionName: (location.regionId ?? key?.regionId)
                ? regionViewById.get(location.regionId ?? key?.regionId)?.name ?? null
                : null,
            mapRef: location.mapRef ?? null,
            keyLocationId: key?.id ?? null,
            virtual: location.virtual === true,
            travel: Array.isArray(location.travel) ? location.travel.slice() : [],
            factionId: live?.factionId ?? location.factionId ?? null,
            status: live?.status ?? location.defaultStatus ?? 'unknown',
            present: Array.isArray(live?.present) ? live.present.slice() : [],
            visited: live?.visited === true,
            connections: Array.isArray(location.connections) ? location.connections.slice() : [],
            labelHidden: false,
        };
    });

    return {
        canvas: { width: CANONICAL_MAP.width, height: CANONICAL_MAP.height },
        image: CANONICAL_MAP.path,
        bounds: mapBounds(),
        regions: regionViews,
        bridges: bridgeViews,
        keyLocations: keyViews,
        namedLocations: locationViews,
        index: {
            regionById: regionViewById,
            bridgeById: bridgeViewById,
            keyLocationById: keyViewById,
            namedLocationById: new Map(locationViews.map((view) => [view.id, view])),
            keyByLocationId: featureIndex.keyByLocationId,
        },
        counts: {
            regions: regionViews.length,
            bridges: bridgeViews.length,
            keyLocations: keyViews.length,
            namedLocations: locationViews.length,
        },
    };
}

/**
 * A human-readable submenu for one selected map feature.
 *
 * @param {{ kind: string, id: string }} selection
 * @param {object} viewModel from {@link buildMapViewModel}
 * @param {{ state?: object, combat?: boolean }} [options]
 */
export function buildMapSubmenu(selection, viewModel, options = {}) {
    const state = options.state ?? null;
    const combat = Boolean(options.combat ?? state?.scene?.combat);

    let feature = null;
    if (selection?.kind === 'region') {
        feature = viewModel?.index?.regionById?.get(selection.id) ?? null;
    } else if (selection?.kind === 'bridge') {
        feature = viewModel?.index?.bridgeById?.get(selection.id) ?? null;
    } else if (selection?.kind === 'keyLocation') {
        feature = viewModel?.index?.keyLocationById?.get(selection.id) ?? null;
    } else if (selection?.kind === 'namedLocation') {
        feature = viewModel?.index?.namedLocationById?.get(selection.id) ?? null;
    }

    if (!feature) {
        return {
            ok: false,
            selection: selection ?? null,
            error: 'Unknown map selection',
            travel: null,
            feature: null,
        };
    }

    const locationId = feature.kind === 'namedLocation' ? feature.id : feature.locationId ?? null;
    const liveLocation = locationId ? state?.locations?.[locationId] ?? null : null;
    const present = (liveLocation?.present?.length ? liveLocation.present : null)
        ?? (feature.present?.length ? feature.present : null)
        ?? (feature.kind === 'namedLocation' && locationId === state?.scene?.locationId
            ? state?.scene?.present ?? []
            : []);
    const connected = feature.connections ?? (liveLocation?.connections ?? []);
    const travelAllowed = Boolean(locationId) && !combat;

    return {
        ok: true,
        error: null,
        selection,
        feature,
        title: feature.name ?? feature.label ?? feature.id,
        typeLabel: feature.kind,
        districtId: feature.districtId ?? feature.regionId ?? null,
        districtName: feature.districtName ?? feature.regionName ?? null,
        description: feature.description ?? null,
        factionId: feature.factionId ?? null,
        factionName: feature.factionName ?? null,
        status: feature.status ?? null,
        present,
        keyLocationIds: feature.keyLocationIds ?? [],
        bridgeIds: feature.bridgeIds ?? [],
        connects: feature.connects ?? [],
        connectsNames: feature.connectsNames ?? [],
        travel: {
            enabled: travelAllowed,
            reason: !locationId
                ? 'This feature is not a travel node'
                : combat
                    ? 'Travel is disabled during combat'
                    : null,
            locationId,
            connections: connected,
        },
    };
}
