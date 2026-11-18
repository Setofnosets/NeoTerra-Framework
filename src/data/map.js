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

import {
    getBeatStatus,
    getCurrentAct,
    getUpcomingBeats,
    isFinalDeadlinePassed,
    summarizeBeatLedger,
} from './beats.js';
import { applyContentGate } from '../core/content-gate.js';
import { computeRegionVisibility, regionState } from '../state/exploration.js';

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
    // `namedLocations` is the named-location override layer (keyed by location
    // id). It is optional so existing authored documents stay valid.
    if (document.namedLocations !== undefined && !isObject(document.namedLocations)) {
        add(errors, 'namedLocations', 'must be an object keyed by location id');
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

    for (const [locationId, override] of Object.entries(document.namedLocations ?? {})) {
        const path = `namedLocations.${locationId}`;
        if (!isObject(override)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (context.locationIds && !context.locationIds.has(locationId)) {
            add(errors, path, `unresolved location "${locationId}"`);
        }
        if (override.status !== undefined && !MAP_LOCATION_STATUSES.includes(override.status)) {
            add(errors, `${path}.status`, `must be one of ${MAP_LOCATION_STATUSES.join(', ')}`);
        }
        if (override.x !== undefined && override.x !== null && !Number.isFinite(override.x)) {
            add(errors, `${path}.x`, 'must be a number');
        }
        if (override.y !== undefined && override.y !== null && !Number.isFinite(override.y)) {
            add(errors, `${path}.y`, 'must be a number');
        }
        for (const field of ['name', 'description', 'factionId']) {
            if (override[field] !== undefined && override[field] !== null && typeof override[field] !== 'string') {
                add(errors, `${path}.${field}`, 'must be a string when present');
            }
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
    // Per-chat overrides win over the authored/global document: a district
    // captured or a bridge destroyed in this timeline never changes another.
    const chat = getChatMapOverrides(state);

    const regionViews = featureIndex.regions.map((region) => {
        const override = {
            ...(featureIndex.overrideIndex.regions?.[region.label] ?? null),
            ...(chat.regions[region.label] ?? {}),
        };
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
        // An explicit district-status override (chat or authored) wins over
        // the worst live status among the district's named locations.
        const status = typeof override?.status === 'string' && override.status.length > 0
            ? override.status
            : liveStatuses.includes('hostile')
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
        const override = {
            ...(featureIndex.overrideIndex.bridges?.[bridge.label] ?? null),
            ...(chat.bridges[bridge.label] ?? {}),
        };
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
        const override = {
            ...(featureIndex.overrideIndex.keyLocations?.[key.label] ?? null),
            ...(chat.keyLocations[key.label] ?? {}),
        };
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
            x: Number.isFinite(override?.x) ? override.x : key.x,
            y: Number.isFinite(override?.y) ? override.y : key.y,
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
        const override = chat.namedLocations[location.id] ?? null;
        const key = location.mapRef?.layer === 'keyLocation'
            ? featureIndex.get(location.mapRef.id)
            : null;
        return {
            id: location.id,
            kind: 'namedLocation',
            name: override?.name ?? live?.name ?? location.name,
            description: override?.description ?? location.description,
            locationKind: location.kind,
            x: Number.isFinite(override?.x) ? override.x : location.x,
            y: Number.isFinite(override?.y) ? override.y : location.y,
            districtId: location.districtId ?? null,
            regionId: location.regionId ?? key?.regionId ?? null,
            regionName: (location.regionId ?? key?.regionId)
                ? regionViewById.get(location.regionId ?? key?.regionId)?.name ?? null
                : null,
            mapRef: location.mapRef ?? null,
            keyLocationId: key?.id ?? null,
            virtual: location.virtual === true,
            travel: Array.isArray(location.travel) ? location.travel.slice() : [],
            // Live `LocationState` is the authority for status/control (it is
            // already per chat and the storyline writes it); the presentation
            // override is only a fallback.
            factionId: live?.factionId ?? override?.factionId ?? location.factionId ?? null,
            status: live?.status ?? override?.status ?? location.defaultStatus ?? 'unknown',
            present: Array.isArray(live?.present) ? live.present.slice() : [],
            visited: live?.visited === true,
            connections: Array.isArray(location.connections) ? location.connections.slice() : [],
            labelHidden: false,
        };
    });

    // Chat-only virtual nodes exist in `WorldState.locations` but not in the
    // authored registry; the overlay/editor still renders them.
    for (const node of chat.virtualNodes) {
        if (!isObject(node) || typeof node.id !== 'string') {
            continue;
        }
        const live = stateLocations[node.id] ?? null;
        locationViews.push({
            id: node.id,
            kind: 'namedLocation',
            name: node.name ?? node.id,
            description: node.description ?? '',
            locationKind: 'venue',
            x: node.x,
            y: node.y,
            districtId: node.districtId ?? null,
            regionId: node.regionId ?? null,
            regionName: node.regionId ? regionViewById.get(node.regionId)?.name ?? null : null,
            mapRef: null,
            keyLocationId: null,
            virtual: true,
            travel: Array.isArray(node.travel) ? node.travel.slice() : ['walk'],
            factionId: live?.factionId ?? null,
            status: live?.status ?? 'unknown',
            present: Array.isArray(live?.present) ? live.present.slice() : [],
            visited: live?.visited === true,
            connections: Array.isArray(node.connections) ? node.connections.slice() : [],
            chatOnly: true,
            labelHidden: false,
        });
    }

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
const FOG_UNCHARTED = 'Uncharted';

function blankFogFeature(feature, visibility, { showRumoredLabels = true, isBridge = false } = {}) {
    if (!feature) {
        return feature;
    }
    const blanked = { ...feature, visibility };
    if (visibility === 'discovered') {
        return blanked;
    }
    const showName = visibility === 'rumored' && showRumoredLabels && !isBridge;
    if (!isBridge) {
        blanked.name = showName ? feature.name : FOG_UNCHARTED;
    } else {
        blanked.name = FOG_UNCHARTED;
    }
    blanked.labelHidden = !showName;
    blanked.description = null;
    blanked.factionId = null;
    blanked.factionName = null;
    blanked.status = null;
    blanked.present = [];
    blanked.regionName = null;
    blanked.label = null;
    blanked.districtName = null;
    blanked.districtId = null;
    if (isBridge) {
        blanked.connectsNames = [null, null];
    } else {
        blanked.travel = [];
    }
    return blanked;
}

/**
 * Apply fog of war to a map view model. Returns a new document; the input is
 * never mutated. Hidden features keep their id/geometry (so the renderer can
 * mask them) but lose every authored or live string.
 *
 * `exploration` null means the chat predates fog: the view model is returned
 * unchanged rather than masking the whole map.
 */
export function applyMapFog(viewModel, exploration, {
    mode = 'rumors',
    revealNeighbors = true,
    showRumoredLabels = true,
    enabled = true,
} = {}) {
    if (!viewModel || !isObject(exploration) || enabled === false) {
        return viewModel;
    }
    const visibility = computeRegionVisibility({
        exploration,
        regions: viewModel.regions ?? [],
        bridges: viewModel.bridges ?? [],
        mode,
        revealNeighbors,
    });
    const regionVisibility = (regionId) => (
        regionId ? (visibility.get(regionId) ?? regionState(exploration, regionId)) : 'unknown'
    );

    const regions = (viewModel.regions ?? []).map((region) => blankFogFeature(
        region,
        regionVisibility(region.id),
        { showRumoredLabels },
    ));
    const bridges = (viewModel.bridges ?? []).map((bridge) => {
        const [a, b] = Array.isArray(bridge.connects) ? bridge.connects : [];
        const discovered = regionVisibility(a) === 'discovered' || regionVisibility(b) === 'discovered';
        return blankFogFeature(bridge, discovered ? 'discovered' : 'unknown', { showRumoredLabels, isBridge: true });
    });
    const keyLocations = (viewModel.keyLocations ?? []).map((key) => blankFogFeature(
        key,
        regionVisibility(key.regionId),
        { showRumoredLabels },
    ));
    const namedLocations = (viewModel.namedLocations ?? []).map((location) => {
        if (location.visited === true) {
            return { ...location, visibility: 'discovered' };
        }
        // A discovered district does not reveal its venues: named locations are
        // visible only once visited, otherwise they are a rumour (name at
        // most) or masked with the region.
        const visibilityState = regionVisibility(location.regionId);
        return blankFogFeature(
            location,
            visibilityState === 'discovered' ? 'rumored' : visibilityState,
            { showRumoredLabels },
        );
    });

    return {
        ...viewModel,
        regions,
        bridges,
        keyLocations,
        namedLocations,
        index: {
            regionById: new Map(regions.map((entry) => [entry.id, entry])),
            bridgeById: new Map(bridges.map((entry) => [entry.id, entry])),
            keyLocationById: new Map(keyLocations.map((entry) => [entry.id, entry])),
            namedLocationById: new Map(namedLocations.map((entry) => [entry.id, entry])),
            keyByLocationId: viewModel.index?.keyByLocationId ?? new Map(),
        },
    };
}

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
    const visibility = feature.visibility ?? 'discovered';
    const uncharted = visibility === 'unknown';
    // A fogged feature must not re-read live presence from raw state: the view
    // model already blanked it for rumoured/unknown features.
    const present = visibility === 'discovered'
        ? (liveLocation?.present?.length ? liveLocation.present : null)
            ?? (feature.present?.length ? feature.present : null)
            ?? (feature.kind === 'namedLocation' && locationId === state?.scene?.locationId
                ? state?.scene?.present ?? []
                : [])
        : [];
    const connected = feature.connections ?? (liveLocation?.connections ?? []);
    // A virtual node has no polygon: it stays reachable through an authored
    // connection from the current location even when its region is uncharted.
    const virtualReachable = feature.virtual === true
        && typeof state?.scene?.locationId === 'string'
        && connected.includes(state.scene.locationId);
    const travelAllowed = Boolean(locationId) && !combat && (!uncharted || virtualReachable);
    const travelReason = !locationId
        ? 'This feature is not a travel node'
        : combat
            ? 'Travel is disabled during combat'
            : uncharted && !virtualReachable
                ? 'Uncharted destination'
                : null;

    return {
        ok: true,
        error: null,
        selection,
        feature,
        visibility,
        title: feature.name ?? feature.label ?? feature.id,
        typeLabel: feature.kind,
        districtId: visibility === 'discovered' ? (feature.districtId ?? feature.regionId ?? null) : null,
        districtName: visibility === 'discovered'
            ? (feature.districtName ?? feature.regionName ?? null)
            : null,
        description: feature.description ?? null,
        factionId: feature.factionId ?? null,
        factionName: feature.factionName ?? null,
        status: feature.status ?? null,
        present,
        keyLocationIds: visibility === 'discovered' ? (feature.keyLocationIds ?? []) : [],
        bridgeIds: visibility === 'discovered' ? (feature.bridgeIds ?? []) : [],
        connects: feature.connects ?? [],
        connectsNames: feature.connectsNames ?? [],
        travel: {
            enabled: travelAllowed,
            blindTrip: (visibility === 'rumored' || virtualReachable) && travelAllowed,
            reason: travelReason,
            locationId,
            connections: connected,
        },
    };
}

/* ------------------------------------------------------------------ *
 * Per-chat map layer (WorldState.flags.map) and overlay helpers (Step 15)
 * ------------------------------------------------------------------ */

/**
 * Named-location, region, and bridge overrides come from two places:
 * the authored/global document (`data/map/overrides.json`, or its exported
 * replacement) and a per-chat layer stored in `WorldState.flags.map`.
 *
 * `WorldState.locations` keeps live per-chat status/control/presence. Bridges
 * and districts have no `LocationState` of their own, so the per-chat bridge
 * status and district override live in `flags.map`; everything stays inside
 * the chat's `WorldState`, so one timeline can never leak into another.
 */
export const MAP_OVERRIDE_LAYERS = Object.freeze(['regions', 'bridges', 'keyLocations', 'namedLocations']);

/**
 * Travel modes accepted by authored locations. Mirrored here (not imported)
 * because `locations.js` imports this module; the two lists are asserted equal
 * in `tests/travel.test.js`.
 */
export const MAP_TRAVEL_MODES = Object.freeze(['walk', 'bridge', 'flight', 'secret']);

/**
 * Named-location statuses accepted by an override. Mirrored from
 * `src/data/locations.js` (which imports this module) and asserted equal in
 * `tests/overlay.test.js`.
 */
export const MAP_LOCATION_STATUSES = Object.freeze([
    'peaceful',
    'patrolled',
    'contested',
    'hostile',
    'locked',
    'unknown',
]);

export const OVERLAY_SIDE_COLORS = Object.freeze({
    villain: '#f43f5e',
    hero: '#38bdf8',
    vigilante: '#a78bfa',
    civilian: '#94a3b8',
    neutral: '#fbbf24',
});

export const OVERLAY_DEFAULT_SETTINGS = Object.freeze({
    showThreats: true,
    showFactions: true,
    showRumors: true,
    showHeadlines: true,
    showFactionTint: true,
    // Off-screen city activity from the deterministic world tick (no LLM).
    showOffscreen: true,
    maxHeadlines: 5,
    maxOffscreen: 4,
    // Render-time text gate; the shell forwards the live values.
    contentGate: 'full',
    contentLimits: {},
    editorEnabled: true,
});

/** Canvas units travelled per in-game turn, and the clamp for one trip. */
export const TRAVEL_TUNING = Object.freeze({
    unitsPerTurn: 400,
    minEdgeWeight: 60,
    maxTurns: 8,
    sameRegionTurns: 1,
});

/** Travel journal entries kept in `flags.travel.history` (newest last). */
export const MAX_TRAVEL_HISTORY = 20;

const BYPASS_COST = Object.freeze({ teleport: 1, flight: 2, swim: 3 });

const TRAVEL_ABILITY_PATTERNS = Object.freeze([
    ['teleport', /teleport|portal|blink|warp|phase/i],
    ['flight', /flight|flying|fly\b|wing|aerial|hover|flight-capable/i],
    ['swim', /swim|aquatic|amphib|water.?breath|submersible/i],
]);

function clampNumber(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

/** Empty per-chat map layer. */
export function emptyChatMapOverrides() {
    return {
        regions: {},
        bridges: {},
        keyLocations: {},
        namedLocations: {},
        virtualNodes: [],
        updatedAt: null,
    };
}

/** Read (and normalize) the per-chat map layer from a `WorldState`. */
export function getChatMapOverrides(state) {
    const raw = isObject(state?.flags?.map) ? state.flags.map : null;
    if (!raw) {
        return emptyChatMapOverrides();
    }
    const readLayer = (layer) => (isObject(raw[layer]) ? { ...raw[layer] } : {});
    return {
        regions: readLayer('regions'),
        bridges: readLayer('bridges'),
        keyLocations: readLayer('keyLocations'),
        namedLocations: readLayer('namedLocations'),
        virtualNodes: Array.isArray(raw.virtualNodes) ? raw.virtualNodes.filter(isObject).map((node) => ({ ...node })) : [],
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    };
}

function withChatMap(state, mutate) {
    if (!isObject(state)) {
        throw new TypeError('A map override requires a WorldState object');
    }
    const next = structuredClone(state);
    const current = getChatMapOverrides(next);
    const map = {
        ...(isObject(next.flags?.map) ? next.flags.map : {}),
        regions: { ...current.regions },
        bridges: { ...current.bridges },
        keyLocations: { ...current.keyLocations },
        namedLocations: { ...current.namedLocations },
        virtualNodes: current.virtualNodes.map((node) => ({ ...node })),
    };
    mutate(map);
    map.updatedAt = Date.now();
    next.flags = { ...(next.flags ?? {}), map };
    return next;
}

/**
 * Write one per-chat override. Returns a new `WorldState`; the caller persists
 * it through the store (`store.replace`).
 *
 * @param {object} state
 * @param {{ layer: string, key: string, patch: object }} override
 */
export function setChatMapOverride(state, { layer, key, patch } = {}) {
    if (!MAP_OVERRIDE_LAYERS.includes(layer)) {
        throw new Error(`Unknown map override layer "${String(layer)}"`);
    }
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('setChatMapOverride requires a non-empty key');
    }
    if (!isObject(patch)) {
        throw new Error('setChatMapOverride requires a patch object');
    }
    return withChatMap(state, (map) => {
        map[layer][key] = { ...(map[layer][key] ?? {}), ...patch };
    });
}

/** Remove one per-chat override (a reset back to the generated/global value). */
export function removeChatMapOverride(state, { layer, key } = {}) {
    if (!MAP_OVERRIDE_LAYERS.includes(layer)) {
        throw new Error(`Unknown map override layer "${String(layer)}"`);
    }
    return withChatMap(state, (map) => {
        delete map[layer][key];
    });
}

/** Drop every per-chat map override and every chat-only virtual node. */
export function resetChatMapOverrides(state) {
    if (!isObject(state)) {
        throw new TypeError('resetChatMapOverrides requires a WorldState object');
    }
    const next = structuredClone(state);
    const map = isObject(next.flags?.map) ? { ...next.flags.map } : null;
    if (map) {
        delete map.regions;
        delete map.bridges;
        delete map.keyLocations;
        delete map.namedLocations;
        delete map.virtualNodes;
        delete map.updatedAt;
    }
    next.flags = { ...(next.flags ?? {}) };
    if (map && Object.keys(map).length > 0) {
        next.flags.map = map;
    } else {
        delete next.flags.map;
    }
    for (const [locationId, location] of Object.entries(next.locations ?? {})) {
        if (Array.isArray(location?.tags) && location.tags.includes('virtual-node')) {
            delete next.locations[locationId];
        }
    }
    return next;
}

function virtualNodeId(name) {
    const slug = slugifyMapLabel(name);
    return slug.length > 0 ? `chat:${slug}` : '';
}

/**
 * Add a chat-only virtual travel node. It becomes a real `LocationState` (so
 * the player can travel to it and it survives export/import) plus a marker in
 * `flags.map.virtualNodes`.
 */
export function addChatVirtualNode(state, {
    id = null,
    name,
    x,
    y,
    regionId = null,
    districtId = 'outskirts',
    district = null,
    description = '',
    connections = [],
    travel = ['walk'],
    now = null,
} = {}) {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('addChatVirtualNode requires a name');
    }
    const point = { x: Number(x), y: Number(y) };
    if (!isInCanvas(point)) {
        throw new Error('addChatVirtualNode requires a point inside the 2048x1536 canvas');
    }
    const locationId = typeof id === 'string' && id.length > 0 ? id : virtualNodeId(name);
    if (!locationId) {
        throw new Error('addChatVirtualNode could not derive an id');
    }
    if (state?.locations?.[locationId]) {
        throw new Error(`A location with id "${locationId}" already exists`);
    }
    // Unresolved ids are kept: the authored registry supplies most nodes and
    // the travel graph resolves the edge at build time (an unknown id is
    // simply ignored there).
    const linked = [...new Set(
        (Array.isArray(connections) ? connections : []).filter((id) => typeof id === 'string' && id.length > 0),
    )];
    const modes = (Array.isArray(travel) ? travel : ['walk']).filter((mode) => MAP_TRAVEL_MODES.includes(mode));
    const timestamp = Number.isFinite(now) ? now : Date.now();

    const next = withChatMap(state, (map) => {
        map.virtualNodes.push({
            id: locationId,
            name: name.trim(),
            x: point.x,
            y: point.y,
            regionId,
            districtId,
            description: typeof description === 'string' ? description : '',
            connections: linked.slice(),
            travel: modes.length > 0 ? modes : ['walk'],
            createdAt: timestamp,
        });
    });
    // A virtual node is a real location for travel, presence, and validation.
    next.locations[locationId] = {
        id: locationId,
        name: name.trim(),
        district: typeof district === 'string' && district.length > 0
            ? district
            : districtId === 'outskirts' ? 'Outskirts' : String(districtId),
        districtId,
        kind: 'venue',
        factionId: null,
        status: 'unknown',
        capacity: 10,
        present: [],
        tags: ['virtual-node'],
        visited: false,
        notes: typeof description === 'string' ? description : '',
        regionId,
        mapRef: null,
        virtual: true,
        x: point.x,
        y: point.y,
        travel: modes.length > 0 ? modes : ['walk'],
        connections: linked.slice(),
    };
    return next;
}

/** Patch a chat-only virtual node (marker record and `LocationState`). */
export function updateChatVirtualNode(state, locationId, patch = {}) {
    if (!isObject(state) || typeof locationId !== 'string') {
        throw new Error('updateChatVirtualNode requires a WorldState and a node id');
    }
    if (!isObject(patch)) {
        throw new Error('updateChatVirtualNode requires a patch object');
    }
    if (Object.hasOwn(patch, 'x') || Object.hasOwn(patch, 'y')) {
        const node = getChatMapOverrides(state).virtualNodes.find((entry) => entry.id === locationId) ?? null;
        const point = {
            x: Object.hasOwn(patch, 'x') ? Number(patch.x) : Number(node?.x),
            y: Object.hasOwn(patch, 'y') ? Number(patch.y) : Number(node?.y),
        };
        if (!isInCanvas(point)) {
            throw new Error('updateChatVirtualNode requires a point inside the 2048x1536 canvas');
        }
    }
    let found = false;
    const next = withChatMap(state, (map) => {
        map.virtualNodes = map.virtualNodes.map((node) => {
            if (node.id !== locationId) {
                return node;
            }
            found = true;
            return { ...node, ...patch };
        });
    });
    if (!found) {
        throw new Error(`No chat virtual node "${locationId}"`);
    }
    const location = next.locations?.[locationId];
    if (location) {
        for (const field of ['name', 'x', 'y', 'regionId', 'districtId', 'description', 'connections', 'travel']) {
            if (Object.hasOwn(patch, field) && patch[field] !== null && patch[field] !== undefined) {
                location[field] = patch[field];
            }
        }
    }
    return next;
}

/** Remove a chat-only virtual node and its `LocationState` entry. */
export function removeChatVirtualNode(state, locationId) {
    if (!isObject(state) || typeof locationId !== 'string') {
        return state;
    }
    const next = withChatMap(state, (map) => {
        map.virtualNodes = map.virtualNodes.filter((node) => node.id !== locationId);
    });
    delete next.locations[locationId];
    return next;
}

/** Serialize every per-chat map override for export. */
export function exportChatMapOverrides(state) {
    return JSON.stringify(getChatMapOverrides(state), null, 2);
}

/* -------------------------- overlay view model -------------------------- */

/** Faction id -> deterministic overlay colour (by side, stable per id). */
export function factionOverlayColor(faction = null) {
    if (!faction) {
        return OVERLAY_SIDE_COLORS.neutral;
    }
    return OVERLAY_SIDE_COLORS[faction.side] ?? OVERLAY_SIDE_COLORS.neutral;
}

function overlaySettings(settings = {}) {
    return { ...OVERLAY_DEFAULT_SETTINGS, ...(isObject(settings) ? settings : {}) };
}

/** Threat cards for the overlay: stage labels plus a numeric bar (2+ threats supported). */
export function buildThreatViews(state) {
    return (Array.isArray(state?.threats) ? state.threats : [])
        .filter(isObject)
        .map((threat) => {
            const stages = Array.isArray(threat.stages) ? threat.stages.filter((stage) => typeof stage === 'string') : [];
            const stageIndex = Math.round(clampNumber(threat.stage, 0, Math.max(0, stages.length - 1), 0));
            const progress = Math.round(clampNumber(threat.progress, 0, 100, 0));
            return {
                id: threat.id,
                name: threat.name ?? threat.id,
                rank: threat.rank ?? 'secondary',
                status: threat.status ?? 'active',
                progress,
                stage: stageIndex,
                stageCount: Math.max(1, stages.length),
                stageLabel: stages[stageIndex] ?? `Stage ${stageIndex + 1}`,
                agenda: threat.agenda ?? '',
                locationId: threat.locationId ?? null,
                sourceFactionId: threat.sourceFactionId ?? null,
                sourceFactionName: threat.sourceFactionId
                    ? state?.factions?.[threat.sourceFactionId]?.name ?? threat.sourceFactionId
                    : null,
                defeated: threat.status === 'defeated' || threat.status === 'contained',
            };
        })
        .sort((a, b) => {
            if (a.rank !== b.rank) {
                return a.rank === 'main' ? -1 : 1;
            }
            return b.progress - a.progress;
        });
}

/** Faction cards with goals/influence; disbanded factions are hidden by default. */
export function buildFactionViews(state, { includeDisbanded = false } = {}) {
    return Object.values(state?.factions ?? {})
        .filter((faction) => isObject(faction))
        .filter((faction) => includeDisbanded || faction.status !== 'disbanded')
        .map((faction) => ({
            id: faction.id,
            name: faction.name ?? faction.id,
            side: faction.side ?? 'neutral',
            status: faction.status ?? 'active',
            influence: Math.round(clampNumber(faction.influence, 0, 100, 0)),
            goals: Array.isArray(faction.goals) ? faction.goals.slice(0, 5) : [],
            description: faction.description ?? '',
            headquartersLocationId: faction.headquartersLocationId ?? null,
            color: factionOverlayColor(faction),
            dominant: faction.status === 'dominant' || Number(faction.influence) >= 80,
        }))
        .sort((a, b) => b.influence - a.influence);
}

/**
 * Canon-beat display: current act, next 1-2 beats as rumours, and a divergence
 * indicator covering adapted, short-circuited, and deferred beats.
 */
export function buildBeatViews(state, season = null) {
    const records = Object.entries(state?.beats ?? {}).map(([beatId, record]) => ({
        id: beatId,
        status: record?.status ?? 'open',
        reason: record?.reason ?? null,
        adaptedFrom: record?.adaptedFrom ?? null,
        adaptedTo: record?.adaptedTo ?? null,
        resolvedTurn: record?.resolvedTurn ?? null,
    }));
    const byStatus = (statuses) => records.filter((record) => statuses.includes(record.status)).map((record) => record.id);
    const adapted = byStatus(['adapted']);
    const shortCircuited = byStatus(['short-circuited']);
    const deferred = byStatus(['deferred']);
    const divergence = {
        adapted,
        shortCircuited,
        deferred,
        hasDivergence: adapted.length + shortCircuited.length + deferred.length > 0,
        label: adapted.length + shortCircuited.length + deferred.length === 0
            ? 'On the canon track'
            : `${adapted.length} adapted · ${shortCircuited.length} short-circuited · ${deferred.length} deferred`,
    };

    if (!season) {
        return {
            act: null,
            rumors: [],
            ledger: null,
            divergence,
            records,
            finalDeadlinePassed: false,
        };
    }
    const rumors = getUpcomingBeats(state, season, 2).map((beat) => ({
        id: beat.id,
        title: beat.title ?? beat.id,
        act: beat.act ?? null,
        status: getBeatStatus(state, beat.id),
        deadlineConsequence: beat.deadlineConsequence ?? null,
    }));
    return {
        act: getCurrentAct(state, season),
        rumors,
        ledger: summarizeBeatLedger(state, season),
        divergence,
        records,
        finalDeadlinePassed: isFinalDeadlinePassed(season, state),
    };
}

/** Latest events, newest first, with a newspaper-style headline fallback. */
export function buildHeadlineViews(state, { limit = 5, contentGate = 'full', contentLimits = {} } = {}) {
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    const gate = (text) => applyContentGate(
        String(text ?? ''),
        contentGate,
        contentLimits,
        { isPlayer: true },
    );
    return events
        .slice(-Math.max(0, limit))
        .reverse()
        .map((event) => {
            const summary = gate(event?.summary);
            const headline = gate(
                typeof event?.headline === 'string' && event.headline.length > 0
                    ? event.headline
                    : event?.summary,
            );
            return {
                turn: event?.turn ?? 0,
                date: event?.date ?? null,
                summary,
                headline,
                locationId: event?.locationId ?? null,
                tags: Array.isArray(event?.tags) ? event.tags.slice() : [],
                beatId: event?.beatId ?? null,
            };
        })
        .filter((entry) => entry.headline.length > 0 || entry.summary.length > 0);
}

function latestEventByLocation(state) {
    const latest = new Map();
    for (const event of Array.isArray(state?.recentEvents) ? state.recentEvents : []) {
        const locationId = event?.locationId;
        if (typeof locationId === 'string' && !latest.has(locationId)) {
            latest.set(locationId, event);
        }
    }
    return latest;
}

/**
 * Region styling for the Leaflet layer: faction tint, status outline, and the
 * chat override precedence (chat > global > generated > lore district).
 */
export function buildRegionOverlayStyles(viewModel, state = null, settings = {}, factionViews = null) {
    const config = overlaySettings(settings);
    const factions = factionViews ?? buildFactionViews(state);
    const factionById = new Map(factions.map((faction) => [faction.id, faction]));
    return (viewModel?.regions ?? []).map((region) => {
        const faction = region.factionId ? factionById.get(region.factionId) ?? null : null;
        const baseColor = faction?.color ?? region.color ?? region.sourceColor ?? '#5eead4';
        const status = region.status ?? null;
        return {
            id: region.id,
            factionId: region.factionId ?? null,
            factionName: faction?.name ?? region.factionName ?? null,
            status,
            color: config.showFactionTint ? baseColor : region.color ?? '#5eead4',
            fillOpacity: config.showFactionTint && faction ? 0.22 : 0.12,
            dashArray: status === 'hostile' ? '4 4' : status === 'contested' ? '8 4' : null,
            weight: status ? 2 : 1,
        };
    });
}

/** Bridge styling for the overlay (per-chat status wins). */
export function buildBridgeOverlayStyles(viewModel) {
    return (viewModel?.bridges ?? []).map((bridge) => ({
        id: bridge.id,
        label: bridge.label,
        name: bridge.name,
        status: bridge.status ?? 'open',
        connects: Array.isArray(bridge.connects) ? bridge.connects.slice() : [],
        connectsNames: Array.isArray(bridge.connectsNames) ? bridge.connectsNames.slice() : [],
        length: Number(bridge.length) || 0,
    }));
}

/**
 * Latest off-screen city activity from the world tick, newest first.
 *
 * Deterministic and LLM-free: it reads the `offscreen`-tagged events the tick
 * already wrote. The actor faction travels as a `faction:<id>` tag; the
 * location's controller is carried separately as `controlledBy*` so a row never
 * claims the controller is the actor. Unknown ids degrade to the raw id. Text
 * passes through the content gate, including per-player hard limits.
 */
export function buildOffscreenFeed(state, {
    limit = 4,
    contentGate = 'full',
    contentLimits = {},
} = {}) {
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    const cap = Math.max(1, Math.min(4, Number.isInteger(limit) ? limit : 4));
    const gate = (text) => applyContentGate(
        String(text ?? ''),
        contentGate,
        contentLimits,
        { isPlayer: true },
    );
    const feed = [];
    for (let index = events.length - 1; index >= 0 && feed.length < cap; index -= 1) {
        const event = events[index];
        if (!isObject(event) || !Array.isArray(event.tags) || !event.tags.includes('offscreen')) {
            continue;
        }
        const locationId = typeof event.locationId === 'string' && event.locationId.length > 0
            ? event.locationId
            : null;
        const location = locationId ? state?.locations?.[locationId] ?? null : null;
        const factionTag = event.tags.find(
            (tag) => typeof tag === 'string' && tag.startsWith('faction:'),
        );
        const factionId = factionTag ? factionTag.slice('faction:'.length) : null;
        const factionName = factionId
            ? String(state?.factions?.[factionId]?.name ?? factionId)
            : null;
        const controllerId = typeof location?.factionId === 'string' && location.factionId.length > 0
            ? location.factionId
            : null;
        const controllerName = controllerId && controllerId !== factionId
            ? String(state?.factions?.[controllerId]?.name ?? controllerId)
            : null;
        const locationName = locationId
            ? String(location?.name ?? locationId)
            : null;
        const summary = gate(event.summary);
        const headline = gate(
            typeof event.headline === 'string' && event.headline.length > 0
                ? event.headline
                : event.summary,
        );
        if (summary.length === 0 && headline.length === 0) {
            continue;
        }
        feed.push({
            id: `${event.turn ?? 0}:${event.date ?? ''}:${locationId ?? ''}:${feed.length}`,
            turn: Number.isInteger(event.turn) ? event.turn : 0,
            date: event.date ?? null,
            summary,
            headline,
            text: headline || summary,
            factionId,
            factionName,
            controlledByFactionId: controllerName ? controllerId : null,
            controlledByFactionName: controllerName,
            locationId,
            locationName,
            tags: event.tags.slice(),
        });
    }
    return feed;
}

/**
 * The whole "where am I in the story" model. Pure and renderer-agnostic; the
 * overlay UI and the map panel both consume it.
 */
export function buildWorldOverlay({
    state = null,
    season = null,
    viewModel = null,
    settings = {},
} = {}) {
    const config = overlaySettings(settings);
    const factions = config.showFactions ? buildFactionViews(state) : [];
    const threats = config.showThreats ? buildThreatViews(state) : [];
    const beats = buildBeatViews(state, season);
    if (!config.showRumors) {
        // The divergence indicator survives: it is a fact about the ledger,
        // not a spoiler.
        beats.rumors = [];
    }
    const headlines = config.showHeadlines
        ? buildHeadlineViews(state, {
            limit: config.maxHeadlines,
            contentGate: config.contentGate,
            contentLimits: config.contentLimits,
        })
        : [];
    const offscreen = config.showOffscreen
        ? buildOffscreenFeed(state, {
            limit: config.maxOffscreen,
            contentGate: config.contentGate,
            contentLimits: config.contentLimits,
        })
        : [];
    const gateText = (text) => applyContentGate(
        String(text ?? ''),
        config.contentGate,
        config.contentLimits,
        { isPlayer: true },
    );
    const latestByLocation = latestEventByLocation(state);
    const keyActivity = (viewModel?.keyLocations ?? []).map((key) => {
        const event = key.locationId ? latestByLocation.get(key.locationId) ?? null : null;
        return {
            id: key.id,
            name: key.name,
            locationId: key.locationId ?? null,
            headline: event ? gateText(event.headline ?? event.summary) || null : null,
            turn: event?.turn ?? null,
        };
    });
    const namedActivity = (viewModel?.namedLocations ?? []).map((location) => {
        const event = latestByLocation.get(location.id) ?? null;
        return {
            id: location.id,
            name: location.name,
            headline: event ? gateText(event.headline ?? event.summary) || null : null,
            turn: event?.turn ?? null,
        };
    });
    return {
        hasWorld: isObject(state),
        act: beats.act,
        threats,
        factions,
        beats,
        headlines,
        offscreen,
        regionStyles: buildRegionOverlayStyles(viewModel, state, config, factions),
        bridgeStyles: buildBridgeOverlayStyles(viewModel),
        keyActivity,
        namedActivity,
        counts: {
            factions: factions.length,
            threats: threats.length,
            rumors: beats.rumors.length,
            headlines: headlines.length,
            offscreen: offscreen.length,
        },
    };
}

/* --------------------- global override editing (authored) --------------------- */

function cloneMapOverrideDocument(document) {
    const next = isObject(document) ? structuredClone(document) : {};
    next.schemaVersion = 1;
    next.canvas = next.canvas ?? { width: CANONICAL_MAP.width, height: CANONICAL_MAP.height };
    for (const layer of MAP_OVERRIDE_LAYERS) {
        if (!isObject(next[layer])) {
            next[layer] = {};
        }
    }
    return next;
}

/**
 * Apply a global (authored) override to a copy of the overrides document.
 * Layer keys follow the file: region/bridge/key-location overrides are keyed by
 * SVG label; named-location overrides are keyed by location id.
 */
export function applyMapOverride(document, { layer, label, patch } = {}) {
    if (!MAP_OVERRIDE_LAYERS.includes(layer)) {
        throw new Error(`Unknown map override layer "${String(layer)}"`);
    }
    if (typeof label !== 'string' || label.length === 0) {
        throw new Error('applyMapOverride requires a non-empty label');
    }
    if (!isObject(patch)) {
        throw new Error('applyMapOverride requires a patch object');
    }
    const next = cloneMapOverrideDocument(document);
    next[layer][label] = { ...(next[layer][label] ?? {}), ...patch };
    return next;
}

/**
 * Reset one override to its generated default. Structural bindings are kept
 * (a region keeps its `districtId`, a key location keeps its `locationId`);
 * only authored presentation/assignment fields are dropped.
 */
export function resetMapOverride(document, { layer, label } = {}) {
    if (!MAP_OVERRIDE_LAYERS.includes(layer)) {
        throw new Error(`Unknown map override layer "${String(layer)}"`);
    }
    if (typeof label !== 'string' || label.length === 0) {
        throw new Error('resetMapOverride requires a non-empty label');
    }
    const next = cloneMapOverrideDocument(document);
    const current = next[layer][label] ?? null;
    if (!current) {
        return next;
    }
    if (layer === 'regions') {
        next[layer][label] = current.districtId ? { districtId: current.districtId } : {};
        if (!next[layer][label].districtId) {
            delete next[layer][label];
        }
        return next;
    }
    if (layer === 'keyLocations') {
        next[layer][label] = current.locationId ? { locationId: current.locationId } : {};
        if (!next[layer][label].locationId) {
            delete next[layer][label];
        }
        return next;
    }
    delete next[layer][label];
    return next;
}

/** Remove one override entirely (including structural bindings). */
export function deleteMapOverride(document, { layer, label } = {}) {
    if (!MAP_OVERRIDE_LAYERS.includes(layer)) {
        throw new Error(`Unknown map override layer "${String(layer)}"`);
    }
    if (typeof label !== 'string' || label.length === 0) {
        throw new Error('deleteMapOverride requires a non-empty label');
    }
    const next = cloneMapOverrideDocument(document);
    delete next[layer][label];
    return next;
}

/** Pretty-print an overrides document for download/commit. */
export function exportMapOverrides(document) {
    return `${JSON.stringify(cloneMapOverrideDocument(document), null, 2)}\n`;
}

/** Parse an imported overrides document (plain JSON, fences tolerated). */
export function parseMapOverrides(text) {
    const source = String(text ?? '').trim();
    if (source.length === 0) {
        return { ok: false, document: null, errors: [{ path: '$', message: 'empty document' }] };
    }
    const fenced = source.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(fenced);
    } catch (error) {
        return { ok: false, document: null, errors: [{ path: '$', message: error?.message ?? 'invalid JSON' }] };
    }
    const validation = validateMapOverrides(parsed);
    if (!validation.ok) {
        return { ok: false, document: null, errors: validation.errors };
    }
    return { ok: true, document: cloneMapOverrideDocument(parsed), errors: [] };
}

/* ------------------------------ travel graph ------------------------------ */

/** Abilities that can bypass a blocked ground route. */
export function detectTravelAbilities(source) {
    const texts = [];
    if (typeof source === 'string') {
        texts.push(source);
    } else if (Array.isArray(source)) {
        texts.push(...source.filter((entry) => typeof entry === 'string'));
    } else if (isObject(source)) {
        for (const field of ['abilities', 'skills', 'traits', 'powers']) {
            if (Array.isArray(source[field])) {
                texts.push(...source[field].filter((entry) => typeof entry === 'string'));
            }
        }
    }
    const found = [];
    for (const [ability, pattern] of TRAVEL_ABILITY_PATTERNS) {
        if (texts.some((text) => pattern.test(text))) {
            found.push(ability);
        }
    }
    return found;
}

/** Bridge status with chat > global > generated precedence. */
export function resolveBridgeStatus(bridge, { overrides = null, chat = null } = {}) {
    const label = bridge?.label;
    const id = bridge?.id;
    const chatStatus = (label ? chat?.bridges?.[label]?.status : null)
        ?? (id ? chat?.bridges?.[id]?.status : null);
    if (BRIDGE_STATUSES.includes(chatStatus)) {
        return chatStatus;
    }
    const globalStatus = label ? overrides?.bridges?.[label]?.status : null;
    if (BRIDGE_STATUSES.includes(globalStatus)) {
        return globalStatus;
    }
    return BRIDGE_STATUSES.includes(bridge?.status) ? bridge.status : 'open';
}

function nodeFromLocation(location, override = null, { preferOverrideConnections = false } = {}) {
    const x = Number.isFinite(override?.x) ? Number(override.x) : Number(location.x);
    const y = Number.isFinite(override?.y) ? Number(override.y) : Number(location.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    const overrideConnections = Array.isArray(override?.connections) ? override.connections : null;
    return {
        id: location.id,
        name: override?.name ?? location.name ?? location.id,
        x,
        y,
        regionId: override?.regionId ?? location.regionId ?? null,
        districtId: override?.districtId ?? location.districtId ?? null,
        district: override?.district ?? location.district ?? null,
        virtual: override?.virtual ?? location.virtual === true,
        travel: Array.isArray(location.travel) ? location.travel.slice() : ['walk'],
        connections: preferOverrideConnections && overrideConnections
            ? overrideConnections.filter((id) => typeof id === 'string')
            : Array.isArray(location.connections)
                ? location.connections.slice()
                : [],
        factionId: override?.factionId ?? location.factionId ?? null,
        status: override?.status ?? location.status ?? location.defaultStatus ?? 'unknown',
        source: location.tags?.includes?.('virtual-node') ? 'chat' : 'registry',
    };
}

function distanceBetweenPoints(a, b) {
    return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function pickEdgeMode(a, b) {
    const modes = new Set([...(a.travel ?? []), ...(b.travel ?? [])]);
    if (modes.has('secret')) {
        return 'secret';
    }
    if (modes.has('bridge')) {
        return 'bridge';
    }
    return 'walk';
}

/**
 * Build the travel graph: named locations (plus chat virtual nodes) as nodes;
 * same-region short hops, authored `connections` edges, and bridge edges as
 * network edges. Bridge edges carry their status so pathfinding can avoid
 * blocked and destroyed spans.
 */
export function buildTravelGraph({
    locations = null,
    bridges = null,
    regions = null,
    overrides = null,
    state = null,
} = {}) {
    const chat = getChatMapOverrides(state);
    const nodes = new Map();

    for (const location of locations?.locations ?? []) {
        if (!isObject(location) || typeof location.id !== 'string') {
            continue;
        }
        const node = nodeFromLocation(location, chat.namedLocations[location.id] ?? null);
        if (node) {
            nodes.set(node.id, node);
        }
    }
    // Chat virtual nodes are `LocationState` entries plus a marker record in
    // `flags.map.virtualNodes`; the marker carries the graph edges, so it is
    // the authority for coordinates/connections.
    const virtualById = new Map(chat.virtualNodes.map((node) => [node.id, node]));
    for (const location of Object.values(state?.locations ?? {})) {
        if (!isObject(location) || typeof location.id !== 'string' || nodes.has(location.id)) {
            continue;
        }
        const virtual = virtualById.get(location.id) ?? null;
        const namedOverride = chat.namedLocations[location.id] ?? null;
        const node = nodeFromLocation(
            virtual
                ? {
                    ...location,
                    ...virtual,
                    connections: (virtual.connections ?? []).length > 0
                        ? virtual.connections
                        : location.connections ?? [],
                    travel: (virtual.travel ?? []).length > 0 ? virtual.travel : location.travel ?? ['walk'],
                }
                : location,
            namedOverride,
            { preferOverrideConnections: Boolean(virtual) },
        );
        if (node) {
            node.source = 'chat';
            nodes.set(node.id, node);
        }
    }
    for (const virtual of chat.virtualNodes) {
        if (typeof virtual.id !== 'string' || nodes.has(virtual.id)) {
            continue;
        }
        const node = nodeFromLocation({ ...virtual, connections: virtual.connections ?? [], travel: virtual.travel ?? ['walk'] });
        if (node) {
            node.source = 'chat';
            node.virtual = true;
            nodes.set(node.id, node);
        }
    }

    const regionDistrict = new Map();
    for (const region of (Array.isArray(regions) ? regions : regions?.features) ?? []) {
        if (isObject(region) && typeof region.id === 'string') {
            const districtId = region.districtId
                ?? overrides?.regions?.[region.label]?.districtId
                ?? null;
            if (districtId) {
                regionDistrict.set(region.id, districtId);
            }
        }
    }
    const pairKey = (a, b) => [a, b].filter(Boolean).sort().join('::');
    const districtOf = (node) => node.districtId ?? (node.regionId ? regionDistrict.get(node.regionId) ?? null : null);

    const edges = [];
    const edgeKeys = new Set();
    const addEdge = (from, to, mode, weight, extra = {}) => {
        if (!from || !to || from.id === to.id) {
            return;
        }
        const key = [from.id, to.id].sort().join('|') + `|${mode}|${extra.bridgeId ?? ''}`;
        if (edgeKeys.has(key)) {
            return;
        }
        edgeKeys.add(key);
        edges.push({
            from: from.id,
            to: to.id,
            mode,
            weight: Math.max(TRAVEL_TUNING.minEdgeWeight, Math.round(weight)),
            distance: Math.round(distanceBetweenPoints(from, to)),
            bridgeId: extra.bridgeId ?? null,
            bridgeLabel: extra.bridgeLabel ?? null,
            bridgeStatus: extra.bridgeStatus ?? null,
        });
    };

    const byRegion = new Map();
    const byDistrict = new Map();
    for (const node of nodes.values()) {
        if (node.regionId) {
            if (!byRegion.has(node.regionId)) {
                byRegion.set(node.regionId, []);
            }
            byRegion.get(node.regionId).push(node);
        }
        // A node with no region has no ground footprint: it is only reachable
        // through its authored connections (a virtual bunker, a subway spur).
        const districtKey = node.regionId ? districtOf(node) : null;
        if (districtKey) {
            if (!byDistrict.has(districtKey)) {
                byDistrict.set(districtKey, []);
            }
            byDistrict.get(districtKey).push(node);
        }
    }
    // Local mesh: two sites in the same district are a short walk apart. This
    // is deliberately district-scoped, not region-scoped: a site whose SVG
    // marker sits across a river must still cross a bridge to reach the other
    // side.
    for (const group of byDistrict.values()) {
        for (let i = 0; i < group.length; i += 1) {
            for (let j = i + 1; j < group.length; j += 1) {
                addEdge(group[i], group[j], 'walk', distanceBetweenPoints(group[i], group[j]));
            }
        }
    }

    const bridgeList = Array.isArray(bridges)
        ? bridges
        : Array.isArray(bridges?.features)
            ? bridges.features
            : [];
    const bridgeNodes = [];
    // Bridges are the gate between districts. Every cross-district edge must
    // name an open bridge (or a declared secret/flight mode); a blocked span
    // removes the edge, so pathfinding must detour or reject.
    const bridgesByRegionPair = new Map();
    for (const bridge of bridgeList) {
        if (!isObject(bridge) || !Array.isArray(bridge.connects)) {
            continue;
        }
        const [regionA, regionB] = bridge.connects;
        const status = resolveBridgeStatus(bridge, { overrides, chat });
        const entry = {
            id: bridge.id,
            label: bridge.label,
            name: overrides?.bridges?.[bridge.label]?.name
                ?? chat.bridges[bridge.label]?.name
                ?? bridge.label
                ?? bridge.id,
            connects: [regionA, regionB],
            districts: [regionDistrict.get(regionA) ?? null, regionDistrict.get(regionB) ?? null],
            length: Number(bridge.length) || 0,
            status,
            blocked: status === 'blocked' || status === 'destroyed',
        };
        bridgeNodes.push(entry);
        const key = pairKey(entry.districts[0], entry.districts[1]);
        if (!bridgesByRegionPair.has(key)) {
            bridgesByRegionPair.set(key, []);
        }
        bridgesByRegionPair.get(key).push(entry);
    }

    const usableBridgeFor = (a, b) => {
        const candidates = bridgesByRegionPair.get(pairKey(districtOf(a), districtOf(b))) ?? [];
        return candidates.find((bridge) => !bridge.blocked) ?? null;
    };
    const anyBridgeFor = (a, b) => (bridgesByRegionPair.get(pairKey(districtOf(a), districtOf(b))) ?? []);
    const allBridgesBlockedFor = (a, b) => {
        const candidates = anyBridgeFor(a, b);
        return candidates.length > 0 && candidates.every((bridge) => bridge.blocked);
    };

    for (const node of nodes.values()) {
        for (const connectionId of node.connections) {
            const other = nodes.get(connectionId);
            if (!other) {
                continue;
            }
            // An authored connection on or to a chat-only virtual node is an
            // explicit edge: the user drew it on purpose, so the district and
            // bridge rules do not apply. Registry-defined virtual sites still
            // obey the bridge graph.
            if (node.source === 'chat' || other.source === 'chat') {
                addEdge(node, other, pickEdgeMode(node, other), distanceBetweenPoints(node, other));
                continue;
            }
            const sameDistrict = districtOf(node) !== null && districtOf(node) === districtOf(other);
            const sameRegion = Boolean(node.regionId) && node.regionId === other.regionId;
            const declared = new Set([...(node.travel ?? []), ...(other.travel ?? [])]);
            const mutualSecret = (node.travel ?? []).includes('secret')
                && (other.travel ?? []).includes('secret');
            // Same district or same SVG region: the two sites share ground, so
            // the connection is a plain walk (no bridge needed).
            if (sameDistrict || sameRegion) {
                addEdge(node, other, pickEdgeMode(node, other), distanceBetweenPoints(node, other));
                continue;
            }
            // A secret back channel crosses districts only when both ends
            // declare it. One-sided "secret" describes the site's own exits,
            // not a bypass between districts.
            if (mutualSecret) {
                addEdge(node, other, 'secret', distanceBetweenPoints(node, other));
                continue;
            }
            if (allBridgesBlockedFor(node, other)) {
                // The only spans between these districts are down: no edge.
                continue;
            }
            const bridge = usableBridgeFor(node, other);
            if (bridge) {
                addEdge(node, other, 'bridge', distanceBetweenPoints(node, other), {
                    bridgeId: bridge.id,
                    bridgeLabel: bridge.label,
                    bridgeStatus: bridge.status,
                });
                continue;
            }
            // No bridge joins these districts and no secret route is declared.
            // Flight-capable locations may still cross (checked at planning).
            if (declared.has('flight')) {
                addEdge(node, other, 'flight', distanceBetweenPoints(node, other));
            }
        }
    }

    for (const bridge of bridgeNodes) {
        const [districtA, districtB] = bridge.districts ?? [];
        const groupA = byDistrict.get(districtA) ?? [];
        const groupB = byDistrict.get(districtB) ?? [];
        if (groupA.length === 0 || groupB.length === 0) {
            continue;
        }
        for (const from of groupA) {
            for (const to of groupB) {
                addEdge(from, to, 'bridge', distanceBetweenPoints(from, to) + bridge.length, {
                    bridgeId: bridge.id,
                    bridgeLabel: bridge.label,
                    bridgeStatus: bridge.status,
                });
            }
        }
    }

    const adjacency = new Map();
    for (const node of nodes.keys()) {
        adjacency.set(node, []);
    }
    for (const edge of edges) {
        adjacency.get(edge.from)?.push({ ...edge, from: edge.from, to: edge.to });
        adjacency.get(edge.to)?.push({ ...edge, from: edge.to, to: edge.from });
    }

    const bridgeById = new Map(bridgeNodes.map((bridge) => [bridge.id, bridge]));
    const regionById = new Map((Array.isArray(regions) ? regions : regions?.features ?? [])
        .filter(isObject)
        .map((region) => [region.id, region]));

    return {
        nodes,
        nodeList: [...nodes.values()],
        edges,
        adjacency,
        bridges: bridgeNodes,
        bridgeById,
        regionById,
        byRegion,
        chat,
        overrides,
        getNode: (id) => nodes.get(id) ?? null,
        blockedBridges: bridgeNodes.filter((bridge) => bridge.blocked),
    };
}

/** Turns needed for a path; same-region hops are a single short turn. */
export function travelTurnsForDistance(distance, { sameRegion = false, bypass = null } = {}) {
    if (bypass && Number.isFinite(BYPASS_COST[bypass])) {
        return BYPASS_COST[bypass];
    }
    if (sameRegion) {
        return TRAVEL_TUNING.sameRegionTurns;
    }
    const number = Number(distance);
    if (!Number.isFinite(number) || number <= 0) {
        return TRAVEL_TUNING.sameRegionTurns;
    }
    return Math.min(
        TRAVEL_TUNING.maxTurns,
        Math.max(1, Math.ceil(number / TRAVEL_TUNING.unitsPerTurn)),
    );
}

function shortestPath(graph, fromId, toId, { ignoreBridgeStatus = false } = {}) {
    const start = graph.getNode(fromId);
    const goal = graph.getNode(toId);
    if (!start || !goal) {
        return null;
    }
    if (fromId === toId) {
        return { path: [fromId], edges: [], distance: 0 };
    }
    const dist = new Map([[fromId, 0]]);
    const previous = new Map();
    const visited = new Set();
    const queue = [{ id: fromId, cost: 0 }];

    while (queue.length > 0) {
        queue.sort((a, b) => a.cost - b.cost);
        const current = queue.shift();
        if (visited.has(current.id)) {
            continue;
        }
        visited.add(current.id);
        if (current.id === toId) {
            break;
        }
        for (const edge of graph.adjacency.get(current.id) ?? []) {
            if (!ignoreBridgeStatus && edge.bridgeId) {
                const bridge = graph.bridgeById.get(edge.bridgeId);
                if (bridge?.blocked || edge.bridgeStatus === 'blocked' || edge.bridgeStatus === 'destroyed') {
                    continue;
                }
            }
            const cost = current.cost + edge.weight;
            if (cost < (dist.get(edge.to) ?? Infinity)) {
                dist.set(edge.to, cost);
                previous.set(edge.to, { id: current.id, edge });
                queue.push({ id: edge.to, cost });
            }
        }
    }

    if (!dist.has(toId)) {
        return null;
    }
    const path = [toId];
    const usedEdges = [];
    let cursor = toId;
    while (cursor !== fromId) {
        const step = previous.get(cursor);
        if (!step) {
            return null;
        }
        usedEdges.unshift(step.edge);
        cursor = step.id;
        path.unshift(cursor);
    }
    return {
        path,
        edges: usedEdges,
        distance: usedEdges.reduce((sum, edge) => sum + edge.distance, 0),
        cost: dist.get(toId),
    };
}

/**
 * Shortest travel path over the bridge/location graph. Never straight-line:
 * the result lists the bridges used and the route nodes.
 *
 * @param {object} graph from {@link buildTravelGraph}
 * @param {string} fromId
 * @param {string} toId
 * @param {{ abilities?: string[], allowBypass?: boolean }} [options]
 */
export function findTravelPath(graph, fromId, toId, { abilities = [], allowBypass = true } = {}) {
    const from = graph?.getNode?.(fromId) ?? null;
    const to = graph?.getNode?.(toId) ?? null;
    if (!graph) {
        return { ok: false, reason: 'no-graph', path: [], bridges: [], distance: 0, turns: 0 };
    }
    if (!from) {
        return { ok: false, reason: 'unknown-origin', path: [], bridges: [], distance: 0, turns: 0 };
    }
    if (!to) {
        return { ok: false, reason: 'unknown-destination', path: [], bridges: [], distance: 0, turns: 0 };
    }
    if (fromId === toId) {
        return {
            ok: true,
            reason: 'already-there',
            alreadyThere: true,
            path: [fromId],
            bridges: [],
            distance: 0,
            turns: 0,
            sameRegion: true,
            modes: [],
            ability: null,
        };
    }

    const direct = shortestPath(graph, fromId, toId);
    if (direct) {
        const bridges = [...new Set(direct.edges.map((edge) => edge.bridgeId).filter(Boolean))];
        const sameRegion = from.regionId !== null && from.regionId === to.regionId && bridges.length === 0;
        const modes = [...new Set(direct.edges.map((edge) => edge.mode))];
        return {
            ok: true,
            reason: null,
            alreadyThere: false,
            path: direct.path,
            bridges,
            bridgeNames: bridges.map((bridgeId) => graph.bridgeById.get(bridgeId)?.name ?? bridgeId),
            distance: Math.round(direct.distance),
            turns: travelTurnsForDistance(direct.distance, { sameRegion }),
            sameRegion,
            modes,
            ability: null,
            bypass: null,
        };
    }

    // No ground route. Distinguish "blocked" (a route exists if bridges were
    // open) from "disconnected".
    const ignored = shortestPath(graph, fromId, toId, { ignoreBridgeStatus: true });
    const blockedBridges = graph.blockedBridges.map((bridge) => ({
        id: bridge.id,
        label: bridge.label,
        name: bridge.name,
        status: bridge.status,
    }));
    const onlyBlocked = Boolean(ignored);
    const blockedReason = onlyBlocked ? 'blocked' : 'no-route';

    const bypassCandidates = Array.isArray(abilities)
        ? abilities.filter((ability) => NUMBERED_ABILITIES.includes(ability))
        : [];
    if (allowBypass && bypassCandidates.length > 0) {
        const ability = bypassCandidates.sort(
            (a, b) => (BYPASS_COST[a] ?? 99) - (BYPASS_COST[b] ?? 99),
        )[0];
        const distance = Math.round(distanceBetweenPoints(from, to));
        return {
            ok: true,
            reason: null,
            alreadyThere: false,
            path: [fromId, toId],
            bridges: [],
            bridgeNames: [],
            distance,
            turns: travelTurnsForDistance(distance, { bypass: ability }),
            sameRegion: false,
            modes: [ability],
            ability,
            bypass: { ability, cost: BYPASS_COST[ability], distance },
            groundReason: blockedReason,
            blockedBridges,
        };
    }

    return {
        ok: false,
        reason: blockedReason,
        path: [],
        bridges: [],
        bridgeNames: [],
        distance: 0,
        turns: 0,
        sameRegion: false,
        modes: [],
        ability: null,
        bypass: null,
        blockedBridges,
        ignoredPath: ignored?.path ?? [],
    };
}

const NUMBERED_ABILITIES = Object.freeze(Object.keys(BYPASS_COST));

/** Nodes reachable from one node without crossing a blocked bridge. */
export function reachableNodes(graph, fromId) {
    const start = graph?.getNode?.(fromId) ?? null;
    if (!start) {
        return [];
    }
    const seen = new Set([fromId]);
    const queue = [fromId];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const edge of graph.adjacency.get(current) ?? []) {
            if (edge.bridgeId) {
                const bridge = graph.bridgeById.get(edge.bridgeId);
                if (bridge?.blocked) {
                    continue;
                }
            }
            if (!seen.has(edge.to)) {
                seen.add(edge.to);
                queue.push(edge.to);
            }
        }
    }
    return [...seen];
}
