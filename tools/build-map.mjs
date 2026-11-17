#!/usr/bin/env node
/**
 * SVG map build pipeline.
 *
 * The four `NeoTerra*.svg` layers are the authoring source of truth for map
 * geometry. This tool reads them by `inkscape:label` (never by
 * `sodipodi:docname` / `inkscape:export-filename`, which are cross-wired),
 * extracts the 36 districts, 12 bridges, and 22 key locations, derives the
 * bridge/region graph, merges the authored overrides, fills the derived
 * `regionId` values on `data/locations.json`, and writes `data/map/*`.
 *
 * Usage:
 *   node tools/build-map.mjs            # regenerate data/map/* and locations.json
 *   node tools/build-map.mjs --check    # validate only; never write
 *   node tools/build-map.mjs --report   # regenerate, then print the report
 *
 * The runtime never parses SVG: it consumes the generated JSON.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CANVAS = Object.freeze({ width: 2048, height: 1536 });

export const EXPECTED_COUNTS = Object.freeze({
    districts: 36,
    bridges: 12,
    keyLocations: 22,
});

export const LAYER_SOURCES = Object.freeze({
    Districts: {
        primary: 'NeoTerra_Districts.svg',
        combined: 'NeoTerra.svg',
        collection: 'regions',
    },
    Bridges: {
        primary: 'NeoTerra_Bridges.svg',
        combined: 'NeoTerra.svg',
        collection: 'bridges',
    },
    KeyLocations: {
        primary: 'NeoTerra_Locs.svg',
        combined: 'NeoTerra.svg',
        collection: 'keyLocations',
    },
});

const CURVE_STEPS = 10;
/**
 * Districts authored as lore groupings rather than as an SVG polygon. Their
 * facilities are key locations whose `districtId` override wins over the
 * polygon-derived region. Everything else must own at least one region.
 */
const POLYGONLESS_DISTRICTS = Object.freeze(['civic-center']);
/**
 * A bridge endpoint that falls outside every land polygon may still be
 * assigned to the nearest one, but only within this many canvas units. The
 * choice is recorded in `report.json` so a human can review it instead of the
 * build silently guessing.
 */
const NEAREST_THRESHOLD = 130;

/* ------------------------------------------------------------------ *
 * SVG parsing
 * ------------------------------------------------------------------ */

function attribute(tag, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:/g, ':');
    const match = new RegExp(`${escaped}="([^"]*)"`).exec(tag);
    return match ? match[1] : null;
}

function numericAttribute(tag, name) {
    const value = attribute(tag, name);
    if (value === null || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** Find every `<g inkscape:label="…">` block with its balanced body. */
export function extractLayerGroups(svgText) {
    const groups = [];
    const re = /<g\b[^>]*inkscape:label="([^"]+)"[^>]*>/g;
    let match;
    while ((match = re.exec(svgText))) {
        const start = match.index;
        let index = start;
        let depth = 0;
        let end = svgText.length;
        while (index < svgText.length) {
            const open = svgText.indexOf('<g', index);
            const close = svgText.indexOf('</g>', index);
            if (open !== -1 && (close === -1 || open < close)) {
                depth += 1;
                index = open + 2;
            } else if (close !== -1) {
                depth -= 1;
                index = close + 4;
                if (depth === 0) {
                    end = index;
                    break;
                }
            } else {
                break;
            }
        }
        groups.push({ label: match[1], body: svgText.slice(start, end) });
    }
    return groups;
}

/** Elements directly inside a group body, with their parsed attributes. */
export function extractElements(body) {
    const elements = [];
    const re = /<(ellipse|rect|path)\b([\s\S]*?)\/>/g;
    let match;
    while ((match = re.exec(body))) {
        const tag = match[2];
        const label = attribute(tag, 'inkscape:label');
        if (!label) {
            continue;
        }
        elements.push({
            element: match[1],
            label: label.trim(),
            id: attribute(tag, 'id'),
            tag,
        });
    }
    return elements;
}

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/** The art is drawn slightly past the page edge in a few places; clamp to it. */
function clampToCanvas(value, max) {
    if (!Number.isFinite(value)) {
        return value;
    }
    return Math.min(Math.max(value, 0), max);
}

/**
 * Parse an SVG path `d` attribute into one or more closed polygons.
 * Supports absolute/relative m l h v c s q t a z; curves are flattened.
 */
export function parsePathData(d) {
    const tokens = String(d ?? '').match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
    const polygons = [];
    let polygon = [];
    let index = 0;
    let command = null;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    let previousControl = null;

    const push = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const last = polygon[polygon.length - 1];
        if (last && Math.abs(last[0] - x) < 1e-6 && Math.abs(last[1] - y) < 1e-6) {
            return;
        }
        polygon.push([x, y]);
    };
    const cubic = (p0, p1, p2, p3) => {
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
            const t = step / CURVE_STEPS;
            const u = 1 - t;
            push(
                u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            );
        }
    };
    const quadratic = (p0, p1, p2) => {
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
            const t = step / CURVE_STEPS;
            const u = 1 - t;
            push(
                u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
            );
        }
    };
    const arc = (p0, rx, ry, rotation, largeArc, sweep, x, y) => {
        // Arc geometry is approximated with a small circular sweep. The map
        // art uses arcs only for decorative borders, never for districts that
        // need sub-pixel fidelity.
        const steps = Math.max(8, CURVE_STEPS);
        const midX = (p0[0] + x) / 2;
        const midY = (p0[1] + y) / 2;
        const dx = x - p0[0];
        const dy = y - p0[1];
        const chord = Math.hypot(dx, dy);
        const radius = Math.max(1e-6, Math.abs(rx || 0), Math.abs(ry || 0));
        const sagitta = sweep === largeArc ? 0 : Math.min(radius, chord / 2) * 0.25;
        const normalX = chord === 0 ? 0 : -dy / chord;
        const normalY = chord === 0 ? 0 : dx / chord;
        const direction = (largeArc ? 1 : -1) * (signOf(rotation) || 1);
        const controlX = midX + normalX * sagitta * direction;
        const controlY = midY + normalY * sagitta * direction;
        quadratic(p0, [controlX, controlY], [x, y]);
    };

    const next = () => {
        const value = Number(tokens[index]);
        index += 1;
        return value;
    };

    while (index < tokens.length) {
        const token = tokens[index];
        if (/[a-zA-Z]/.test(token)) {
            command = token;
            index += 1;
        }
        if (!command) {
            break;
        }
        const relative = command === command.toLowerCase();
        const upper = command.toUpperCase();

        if (upper === 'Z') {
            if (polygon.length > 0) {
                polygons.push(polygon);
                polygon = [];
            }
            cx = sx;
            cy = sy;
            command = null;
            previousControl = null;
            continue;
        }
        if (upper === 'M') {
            const x = next();
            const y = next();
            cx = relative ? cx + x : x;
            cy = relative ? cy + y : y;
            if (polygon.length > 0) {
                polygons.push(polygon);
                polygon = [];
            }
            sx = cx;
            sy = cy;
            push(cx, cy);
            command = relative ? 'l' : 'L';
            previousControl = null;
            continue;
        }
        if (upper === 'L') {
            const x = next();
            const y = next();
            cx = relative ? cx + x : x;
            cy = relative ? cy + y : y;
            push(cx, cy);
            previousControl = null;
            continue;
        }
        if (upper === 'H') {
            const x = next();
            cx = relative ? cx + x : x;
            push(cx, cy);
            previousControl = null;
            continue;
        }
        if (upper === 'V') {
            const y = next();
            cy = relative ? cy + y : y;
            push(cx, cy);
            previousControl = null;
            continue;
        }
        if (upper === 'C') {
            const x1 = next();
            const y1 = next();
            const x2 = next();
            const y2 = next();
            const x = next();
            const y = next();
            const p1 = [relative ? cx + x1 : x1, relative ? cy + y1 : y1];
            const p2 = [relative ? cx + x2 : x2, relative ? cy + y2 : y2];
            const p3 = [relative ? cx + x : x, relative ? cy + y : y];
            cubic([cx, cy], p1, p2, p3);
            cx = p3[0];
            cy = p3[1];
            previousControl = p2;
            continue;
        }
        if (upper === 'S') {
            const x2 = next();
            const y2 = next();
            const x = next();
            const y = next();
            const p1 = previousControl
                ? [2 * cx - previousControl[0], 2 * cy - previousControl[1]]
                : [cx, cy];
            const p2 = [relative ? cx + x2 : x2, relative ? cy + y2 : y2];
            const p3 = [relative ? cx + x : x, relative ? cy + y : y];
            cubic([cx, cy], p1, p2, p3);
            cx = p3[0];
            cy = p3[1];
            previousControl = p2;
            continue;
        }
        if (upper === 'Q') {
            const x1 = next();
            const y1 = next();
            const x = next();
            const y = next();
            const p1 = [relative ? cx + x1 : x1, relative ? cy + y1 : y1];
            const p2 = [relative ? cx + x : x, relative ? cy + y : y];
            quadratic([cx, cy], p1, p2);
            cx = p2[0];
            cy = p2[1];
            previousControl = p1;
            continue;
        }
        if (upper === 'T') {
            const x = next();
            const y = next();
            const p1 = previousControl
                ? [2 * cx - previousControl[0], 2 * cy - previousControl[1]]
                : [cx, cy];
            const p2 = [relative ? cx + x : x, relative ? cy + y : y];
            quadratic([cx, cy], p1, p2);
            cx = p2[0];
            cy = p2[1];
            previousControl = p1;
            continue;
        }
        if (upper === 'A') {
            const rx = next();
            const ry = next();
            const rotation = next();
            const largeArc = next();
            const sweep = next();
            const x = next();
            const y = next();
            const target = [relative ? cx + x : x, relative ? cy + y : y];
            arc([cx, cy], rx, ry, rotation, largeArc, sweep, target[0], target[1]);
            cx = target[0];
            cy = target[1];
            previousControl = null;
            continue;
        }
        index += 1;
    }
    if (polygon.length > 0) {
        polygons.push(polygon);
    }
    return polygons
        .filter((points) => points.length >= 3)
        .map((points) => points.map(([x, y]) => [
            round(clampToCanvas(x, CANVAS.width)),
            round(clampToCanvas(y, CANVAS.height)),
        ]));
}

function signOf(value) {
    if (!Number.isFinite(value) || value === 0) {
        return 1;
    }
    return value > 0 ? 1 : -1;
}

/** Polygon approximation of a supported SVG element. */
export function elementPolygon(parsed) {
    const { element, tag } = parsed;
    if (element === 'ellipse') {
        const cx = numericAttribute(tag, 'cx') ?? 0;
        const cy = numericAttribute(tag, 'cy') ?? 0;
        const rx = numericAttribute(tag, 'rx') ?? 0;
        const ry = numericAttribute(tag, 'ry') ?? 0;
        const points = [];
        for (let step = 0; step < 48; step += 1) {
            const angle = (2 * Math.PI * step) / 48;
            points.push([round(cx + rx * Math.cos(angle)), round(cy + ry * Math.sin(angle))]);
        }
        return { points, center: { x: round(cx), y: round(cy) } };
    }
    if (element === 'rect') {
        const x = numericAttribute(tag, 'x') ?? 0;
        const y = numericAttribute(tag, 'y') ?? 0;
        const width = numericAttribute(tag, 'width') ?? 0;
        const height = numericAttribute(tag, 'height') ?? 0;
        return {
            points: [
                [round(x), round(y)],
                [round(x + width), round(y)],
                [round(x + width), round(y + height)],
                [round(x), round(y + height)],
            ],
            center: { x: round(x + width / 2), y: round(y + height / 2) },
        };
    }
    const polygons = parsePathData(attribute(tag, 'd'));
    const points = polygons.flat();
    const star = attribute(tag, 'sodipodi:type') === 'star';
    const starCenter = {
        x: numericAttribute(tag, 'sodipodi:cx'),
        y: numericAttribute(tag, 'sodipodi:cy'),
    };
    const center = star && starCenter.x !== null && starCenter.y !== null
        ? { x: round(starCenter.x), y: round(starCenter.y) }
        : null;
    return { points, center, polygons };
}

export function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) {
        return 0;
    }
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[(index + 1) % points.length];
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
}

export function polygonBBox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return [round(minX), round(minY), round(maxX), round(maxY)];
}

export function polygonCentroid(points) {
    if (!Array.isArray(points) || points.length < 3) {
        return { x: 0, y: 0 };
    }
    let signedArea = 0;
    let cx = 0;
    let cy = 0;
    for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[(index + 1) % points.length];
        const factor = x1 * y2 - x2 * y1;
        signedArea += factor;
        cx += (x1 + x2) * factor;
        cy += (y1 + y2) * factor;
    }
    signedArea /= 2;
    if (!(Math.abs(signedArea) > 0)) {
        const [minX, minY, maxX, maxY] = polygonBBox(points);
        return { x: round((minX + maxX) / 2), y: round((minY + maxY) / 2) };
    }
    return {
        x: round(cx / (6 * signedArea)),
        y: round(cy / (6 * signedArea)),
    };
}

export function pointInPolygon(point, points) {
    if (!point || !Array.isArray(points) || points.length < 3) {
        return false;
    }
    const x = Number(point.x ?? point[0]);
    const y = Number(point.y ?? point[1]);
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
        const [xi, yi] = Array.isArray(points[index]) ? points[index] : [points[index].x, points[index].y];
        const [xj, yj] = Array.isArray(points[previous]) ? points[previous] : [points[previous].x, points[previous].y];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/** Distance from a point to the nearest edge of a closed polygon. */
function pointToPolygonDistance(point, points) {
    let best = Infinity;
    for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[(index + 1) % points.length];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared > 0
            ? Math.min(1, Math.max(0, ((point.x - x1) * dx + (point.y - y1) * dy) / lengthSquared))
            : 0;
        const distance = Math.hypot(point.x - (x1 + t * dx), point.y - (y1 + t * dy));
        if (distance < best) {
            best = distance;
        }
    }
    return best;
}

export function farthestEndpointPair(points) {
    let best = [points[0], points[points.length - 1]];
    let bestDistance = -1;
    for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
            const distance = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);
            if (distance > bestDistance) {
                bestDistance = distance;
                best = [points[a], points[b]];
            }
        }
    }
    return best;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

const REGION_KIND_PREFIXES = Object.freeze([
    ['Residential', 'residential'],
    ['UpperMiddleResidential', 'residential'],
    ['HighClassResidential', 'residential'],
    ['Highrise', 'highrise'],
    ['Industrial', 'industrial'],
    ['Warehouses', 'industrial'],
    ['Slum', 'slum'],
    ['Park', 'park'],
    ['LakePark', 'park'],
    ['Dock', 'dock'],
    ['MajorDock', 'dock'],
    ['Airport', 'airport'],
    ['SmallAirport', 'airport'],
    ['Island', 'island'],
    ['River', 'water'],
    ['Bay', 'water'],
    ['Undeveloped', 'wilderness'],
    ['Forest', 'wilderness'],
    ['Center', 'center'],
]);

const KEY_LOCATION_KINDS = Object.freeze([
    ['BigOffice', 'office'],
    ['Home', 'home'],
    ['RichHome', 'home'],
    ['SlumsSafehouse', 'safehouse'],
    ['AirportTerminal', 'terminal'],
    ['BiggestDock', 'dock'],
    ['Stadium', 'stadium'],
    ['LakeParkIsland', 'park'],
    ['IndustrialPark', 'industrial'],
    ['Warehouse', 'industrial'],
]);

export function inferRegionKind(label) {
    for (const [prefix, kind] of REGION_KIND_PREFIXES) {
        if (String(label).startsWith(prefix)) {
            return kind;
        }
    }
    return 'unknown';
}

export function inferKeyLocationKind(label) {
    for (const [prefix, kind] of KEY_LOCATION_KINDS) {
        if (String(label).startsWith(prefix)) {
            return kind;
        }
    }
    return 'unknown';
}

export function slugifyMapLabel(label) {
    return String(label ?? '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

const PREFIXES = Object.freeze({ region: 'region', bridge: 'bridge', keyLocation: 'key' });

export function featureId(layer, label) {
    if (!Object.hasOwn(PREFIXES, layer)) {
        throw new Error(`Unknown map layer "${String(layer)}"`);
    }
    const slug = slugifyMapLabel(label);
    if (!slug) {
        throw new Error('featureId requires a non-empty label');
    }
    return `${PREFIXES[layer]}:${slug}`;
}

function collectionForLayer(layer) {
    if (layer === 'region') return 'regions';
    if (layer === 'bridge') return 'bridges';
    return 'keyLocations';
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/**
 * Extract raw features from one SVG document.
 *
 * @param {string} svgText
 * @param {{ source?: string }} [options]
 * @returns {{ layers: Record<string, { label: string, elements: object[] }>, featureCounts: object }}
 */
export function parseSvgLayers(svgText, options = {}) {
    const groups = extractLayerGroups(svgText);
    const layers = {};
    for (const [label, config] of Object.entries(LAYER_SOURCES)) {
        const group = groups.find((candidate) => candidate.label === label);
        if (!group) {
            continue;
        }
        layers[label] = {
            label,
            collection: config.collection,
            source: options.source ?? null,
            elements: extractElements(group.body),
        };
    }
    return layers;
}

export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * Build the complete generated map document set.
 *
 * @param {{
 *   svgSources: Record<string, string>,
 *   districts: object,
 *   overrides: object,
 *   locations: object,
 * }} input
 */
export function buildMapData({ svgSources, districts, overrides, locations }) {
    const errors = [];
    const warnings = [];
    const duplicateLabels = [];

    const layersByLabel = {};
    const sourceHashes = {};
    for (const [label, config] of Object.entries(LAYER_SOURCES)) {
        const primaryText = svgSources[config.primary];
        const combinedText = svgSources[config.combined];
        const primaryLayers = primaryText ? parseSvgLayers(primaryText, { source: config.primary }) : {};
        if (primaryLayers[label]) {
            layersByLabel[label] = primaryLayers[label];
            sourceHashes[config.primary] = sha256(primaryText);
            continue;
        }
        if (combinedText) {
            const combinedLayers = parseSvgLayers(combinedText, { source: config.combined });
            if (combinedLayers[label]) {
                layersByLabel[label] = combinedLayers[label];
                sourceHashes[config.combined] = sha256(combinedText);
                continue;
            }
        }
        errors.push(`missing SVG layer "${label}" (looked in ${config.primary} and ${config.combined})`);
    }

    const expectedCounts = {
        districts: EXPECTED_COUNTS.districts,
        bridges: EXPECTED_COUNTS.bridges,
        keyLocations: EXPECTED_COUNTS.keyLocations,
    };

    /* ---- districts ---- */
    const regionFeatures = [];
    const seenRegionIds = new Set();
    for (const element of layersByLabel.Districts?.elements ?? []) {
        if (!element.label) {
            errors.push('empty district label');
            continue;
        }
        const id = featureId('region', element.label);
        if (seenRegionIds.has(id)) {
            duplicateLabels.push({ layer: 'district', label: element.label, id, elementId: element.id });
            errors.push(`duplicate district label "${element.label}" (${element.id})`);
            continue;
        }
        seenRegionIds.add(id);
        const geometry = elementPolygon(element);
        const points = geometry.points;
        if (!Array.isArray(points) || points.length < 3) {
            errors.push(`unparsable district geometry "${element.label}" (${element.id})`);
            continue;
        }
        const area = round(polygonArea(points));
        if (!(area > 0)) {
            errors.push(`zero-area district "${element.label}" (${element.id})`);
            continue;
        }
        const override = overrides?.regions?.[element.label] ?? null;
        regionFeatures.push({
            type: 'Feature',
            id,
            label: element.label,
            layer: 'district',
            kind: inferRegionKind(element.label),
            sourceColor: (/fill:\s*(#[0-9a-fA-F]{6})/.exec(element.tag) ?? [])[1] ?? null,
            geometry: {
                type: 'Polygon',
                coordinates: [[...points, points[0]]],
            },
            centroid: geometry.center ?? polygonCentroid(points),
            bbox: polygonBBox(points),
            area,
            districtId: override?.districtId ?? null,
            name: override?.name ?? element.label,
            factionId: override?.factionId ?? null,
            status: null,
            points,
        });
    }

    /* ---- key locations ---- */
    const keyLocationFeatures = [];
    const seenKeyIds = new Set();
    for (const element of layersByLabel.KeyLocations?.elements ?? []) {
        if (!element.label) {
            errors.push('empty key-location label');
            continue;
        }
        const id = featureId('keyLocation', element.label);
        if (seenKeyIds.has(id)) {
            duplicateLabels.push({ layer: 'keyLocation', label: element.label, id, elementId: element.id });
            errors.push(`duplicate key-location label "${element.label}" (${element.id})`);
            continue;
        }
        seenKeyIds.add(id);
        const geometry = elementPolygon(element);
        const point = geometry.center ?? polygonCentroid(geometry.points);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            errors.push(`unparsable key-location position "${element.label}" (${element.id})`);
            continue;
        }
        const override = overrides?.keyLocations?.[element.label] ?? null;
        keyLocationFeatures.push({
            id,
            label: element.label,
            layer: 'keyLocation',
            kind: inferKeyLocationKind(element.label),
            x: round(point.x),
            y: round(point.y),
            regionId: null,
            locationId: override?.locationId ?? null,
            districtId: override?.districtId ?? null,
            name: override?.name ?? element.label,
            factionId: override?.factionId ?? null,
            sourceColor: (/fill:\s*(#[0-9a-fA-F]{6})/.exec(element.tag) ?? [])[1] ?? null,
            points: geometry.points,
        });
    }

    /* ---- bridges ---- */
    const waterRegionIds = new Set(
        regionFeatures.filter((region) => region.kind === 'water').map((region) => region.id),
    );
    const findRegion = (point, { exclude = new Set() } = {}) => {
        for (const region of regionFeatures) {
            if (exclude.has(region.id) || waterRegionIds.has(region.id)) {
                continue;
            }
            if (pointInPolygon(point, region.points)) {
                return { region, distance: 0 };
            }
        }
        let best = null;
        let bestDistance = Infinity;
        for (const region of regionFeatures) {
            if (exclude.has(region.id) || waterRegionIds.has(region.id)) {
                continue;
            }
            const distance = pointToPolygonDistance(point, region.points);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = region;
            }
        }
        return best ? { region: best, distance: bestDistance } : null;
    };

    const bridgeFeatures = [];
    const seenBridgeIds = new Set();
    const unassignedBridges = [];
    const nearestBridgeAssignments = [];
    for (const element of layersByLabel.Bridges?.elements ?? []) {
        if (!element.label) {
            errors.push('empty bridge label');
            continue;
        }
        const id = featureId('bridge', element.label);
        if (seenBridgeIds.has(id)) {
            duplicateLabels.push({ layer: 'bridge', label: element.label, id, elementId: element.id });
            errors.push(`duplicate bridge label "${element.label}" (${element.id})`);
            continue;
        }
        seenBridgeIds.add(id);
        const geometry = elementPolygon(element);
        const points = geometry.points;
        if (!Array.isArray(points) || points.length < 3) {
            errors.push(`unparsable bridge geometry "${element.label}" (${element.id})`);
            continue;
        }
        const area = round(polygonArea(points));
        if (!(area > 0)) {
            errors.push(`zero-area bridge "${element.label}" (${element.id})`);
            continue;
        }
        const [first, second] = farthestEndpointPair(points);
        const endpointA = { x: round(first[0]), y: round(first[1]) };
        const endpointB = { x: round(second[0]), y: round(second[1]) };
        const hitA = findRegion(endpointA);
        const hitB = findRegion(endpointB, { exclude: new Set(hitA ? [hitA.region.id] : []) });
        let reason = null;
        if (!hitA || !hitB) {
            reason = 'endpoint falls in no district';
        } else if (Math.max(hitA.distance, hitB.distance) > NEAREST_THRESHOLD) {
            reason = 'nearest district is beyond the assignment threshold';
        }
        if (reason) {
            unassignedBridges.push({
                label: element.label,
                id,
                endpoints: [endpointA, endpointB],
                reason,
            });
        }
        const nearestReview = [
            { endpoint: endpointA, hit: hitA },
            { endpoint: endpointB, hit: hitB },
        ]
            .filter((entry) => entry.hit && entry.hit.distance > 0)
            .map((entry) => ({
                label: element.label,
                endpoint: entry.endpoint,
                regionId: entry.hit.region.id,
                distance: round(entry.hit.distance),
            }));
        nearestBridgeAssignments.push(...nearestReview);
        const override = overrides?.bridges?.[element.label] ?? null;
        const centerline = [endpointA, endpointB];
        const length = round(Math.hypot(endpointB.x - endpointA.x, endpointB.y - endpointA.y));
        bridgeFeatures.push({
            type: 'Feature',
            id,
            label: element.label,
            layer: 'bridge',
            name: override?.name ?? element.label,
            status: override?.status ?? 'open',
            sourceColor: (/fill:\s*(#[0-9a-fA-F]{6})/.exec(element.tag) ?? [])[1] ?? null,
            geometry: {
                type: 'Polygon',
                coordinates: [[...points, points[0]]],
            },
            centerline,
            endpoints: [endpointA, endpointB],
            connects: hitA && hitB ? [hitA.region.id, hitB.region.id] : [],
            connectorRegions: hitA && hitB
                ? [
                    { id: hitA.region.id, label: hitA.region.label, strategy: hitA.distance === 0 ? 'contains' : 'nearest' },
                    { id: hitB.region.id, label: hitB.region.label, strategy: hitB.distance === 0 ? 'contains' : 'nearest' },
                ]
                : [],
            nearestReview,
            length,
            bbox: polygonBBox(points),
            centroid: geometry.center ?? polygonCentroid(points),
            points,
        });
    }

    /* ---- key-location region assignment ---- */
    const unassignedKeyLocations = [];
    for (const feature of keyLocationFeatures) {
        const hit = findRegion({ x: feature.x, y: feature.y });
        if (hit) {
            feature.regionId = hit.region.id;
            feature.regionAssignment = hit.distance === 0 ? 'contains' : 'nearest';
        }
        if (!feature.regionId) {
            unassignedKeyLocations.push({ label: feature.label, id: feature.id, x: feature.x, y: feature.y });
        }
    }

    /* ---- named-location migration ---- */
    const regionById = new Map(regionFeatures.map((region) => [region.id, region]));
    const locationIssues = [];
    const migratedLocations = (locations?.locations ?? []).map((location) => {
        const next = { ...location };
        if (next.virtual === true) {
            if (next.mapRef !== null && next.mapRef !== undefined) {
                locationIssues.push(`${next.id}: virtual location still declares a mapRef`);
            }
        } else if (!next.mapRef) {
            locationIssues.push(`${next.id}: non-virtual location has no mapRef`);
        } else {
            const collection = collectionForLayer(next.mapRef.layer);
            const sourceList = collection === 'regions'
                ? regionFeatures
                : collection === 'bridges'
                    ? bridgeFeatures
                    : keyLocationFeatures;
            if (!sourceList.some((feature) => feature.id === next.mapRef.id)) {
                locationIssues.push(`${next.id}: mapRef "${next.mapRef.id}" does not exist in the SVG layers`);
            }
        }
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y)
            || next.x < 0 || next.y < 0 || next.x > CANVAS.width || next.y > CANVAS.height) {
            locationIssues.push(`${next.id}: coordinates fall outside ${CANVAS.width}x${CANVAS.height}`);
        }
        const region = findRegion({ x: next.x, y: next.y });
        const derived = region?.region.id ?? null;
        if (next.regionId !== derived) {
            next.regionId = derived;
        }
        if (!next.regionId) {
            warnings.push(`location "${next.id}" resolves to no region`);
        }
        return next;
    });
    for (const issue of locationIssues) {
        errors.push(`locations: ${issue}`);
    }

    const districtsById = new Map((districts?.districts ?? []).map((district) => [district.id, district]));
    const regionLabels = new Set(regionFeatures.map((region) => region.label));
    for (const region of regionFeatures) {
        if (!region.districtId) {
            errors.push(`region "${region.label}" has no authored districtId override`);
        } else if (!districtsById.has(region.districtId)) {
            errors.push(`region "${region.label}" points at unknown district "${region.districtId}"`);
        }
        const district = districtsById.get(region.districtId);
        if (district && Array.isArray(district.regionLabels) && !district.regionLabels.includes(region.label)) {
            errors.push(`district "${district.id}" does not list region "${region.label}"`);
        }
    }
    for (const district of districts?.districts ?? []) {
        for (const label of district.regionLabels ?? []) {
            if (!regionLabels.has(label)) {
                errors.push(`district "${district.id}" references missing SVG region "${label}"`);
            }
        }
        const hasRegions = (district.regionLabels ?? []).length > 0;
        if (district.virtual === true && hasRegions) {
            errors.push(`virtual district "${district.id}" owns SVG regions`);
        }
        if (district.virtual !== true && !hasRegions && !POLYGONLESS_DISTRICTS.includes(district.id)) {
            errors.push(`district "${district.id}" has no SVG region and is not virtual`);
        }
    }
    for (const feature of keyLocationFeatures) {
        const override = overrides?.keyLocations?.[feature.label] ?? null;
        if (!override) {
            errors.push(`key location "${feature.label}" has no authored override`);
            continue;
        }
        if (override.locationId) {
            const location = (locations?.locations ?? []).find((entry) => entry.id === override.locationId);
            if (!location) {
                errors.push(`key location "${feature.label}" binds unknown location "${override.locationId}"`);
            } else if (!location.mapRef || location.mapRef.id !== feature.id) {
                errors.push(`key location "${feature.label}" is not referenced by location "${override.locationId}"`);
            }
        }
        if (override.districtId && !districtsById.has(override.districtId)) {
            errors.push(`key location "${feature.label}" points at unknown district "${override.districtId}"`);
        }
    }

    const areaValues = regionFeatures.map((region) => region.area).sort((a, b) => a - b);
    const median = areaValues.length > 0 ? areaValues[Math.floor(areaValues.length / 2)] : 0;
    const areaOutliers = regionFeatures
        .filter((region) => median > 0 && (region.area < median / 20 || region.area > median * 20))
        .map((region) => ({ label: region.label, area: region.area }));

    const counts = {
        districts: regionFeatures.length,
        bridges: bridgeFeatures.length,
        keyLocations: keyLocationFeatures.length,
    };
    if (counts.districts !== expectedCounts.districts) {
        errors.push(`district count ${counts.districts}, expected ${expectedCounts.districts}`);
    }
    if (counts.bridges !== expectedCounts.bridges) {
        errors.push(`bridge count ${counts.bridges}, expected ${expectedCounts.bridges}`);
    }
    if (counts.keyLocations !== expectedCounts.keyLocations) {
        errors.push(`key-location count ${counts.keyLocations}, expected ${expectedCounts.keyLocations}`);
    }

    const cleanRegions = regionFeatures.map(({ points, ...feature }) => feature);
    const cleanBridges = bridgeFeatures.map(({ points, ...feature }) => feature);
    const cleanKeyLocations = keyLocationFeatures.map(({ points, ...feature }) => feature);

    const mapDocument = {
        schemaVersion: 1,
        canvas: { width: CANVAS.width, height: CANVAS.height },
        source: {
            files: Object.entries(LAYER_SOURCES).map(([layer, config]) => ({
                layer,
                primary: config.primary,
                fallback: config.combined,
                resolved: layersByLabel[layer]?.source ?? null,
                sha256: sourceHashes[layersByLabel[layer]?.source] ?? null,
            })),
        },
        layers: Object.keys(LAYER_SOURCES),
        expectedCounts,
        counts,
        bounds: [[-CANVAS.height, 0], [0, CANVAS.width]],
    };

    const regionCollection = {
        type: 'FeatureCollection',
        schemaVersion: 1,
        canvas: { width: CANVAS.width, height: CANVAS.height },
        features: cleanRegions,
    };
    const bridgeCollection = {
        type: 'FeatureCollection',
        schemaVersion: 1,
        canvas: { width: CANVAS.width, height: CANVAS.height },
        features: cleanBridges,
    };
    const keyLocationDocument = {
        schemaVersion: 1,
        canvas: { width: CANVAS.width, height: CANVAS.height },
        keyLocations: cleanKeyLocations,
    };
    const report = {
        schemaVersion: 1,
        counts,
        expectedCounts,
        duplicateLabels,
        unassignedBridges,
        unassignedKeyLocations,
        nearestBridgeAssignments,
        nearestKeyLocationAssignments: keyLocationFeatures
            .filter((feature) => feature.regionAssignment === 'nearest')
            .map((feature) => ({
                label: feature.label,
                regionId: feature.regionId,
                x: feature.x,
                y: feature.y,
            })),
        areaOutliers,
        missingRegionOverrides: regionFeatures
            .filter((region) => !overrides?.regions?.[region.label])
            .map((region) => region.label),
        warnings,
        errors,
    };

    return {
        map: mapDocument,
        regions: regionCollection,
        bridges: bridgeCollection,
        keyLocations: keyLocationDocument,
        report,
        locations: { ...locations, locations: migratedLocations },
        errors,
        regionById,
        counts,
        features: {
            regions: cleanRegions,
            bridges: cleanBridges,
            keyLocations: cleanKeyLocations,
        },
    };
}

/* ------------------------------------------------------------------ *
 * Filesystem + CLI
 * ------------------------------------------------------------------ */

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readTextIfExists(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function serialize(document) {
    return `${JSON.stringify(document, null, 2)}\n`;
}

function writeJson(path, document) {
    const text = serialize(document);
    try {
        if (readFileSync(path, 'utf8') === text) {
            return false;
        }
    } catch {
        // New file.
    }
    writeFileSync(path, text, 'utf8');
    return true;
}

export function loadSources(root = ROOT) {
    const svgNames = [
        'NeoTerra.svg',
        'NeoTerra_Districts.svg',
        'NeoTerra_Bridges.svg',
        'NeoTerra_Locs.svg',
    ];
    const svgSources = {};
    for (const name of svgNames) {
        const text = readTextIfExists(join(root, name));
        if (text) {
            svgSources[name] = text;
        }
    }
    return {
        svgSources,
        districts: readJson(join(root, 'data', 'districts.json')),
        overrides: readJson(join(root, 'data', 'map', 'overrides.json')),
        locations: readJson(join(root, 'data', 'locations.json')),
    };
}

export function runBuild({ root = ROOT, check = false, report = false } = {}) {
    const sources = loadSources(root);
    const result = buildMapData(sources);

    if (!check && result.errors.length === 0) {
        const mapDir = join(root, 'data', 'map');
        writeJson(join(mapDir, 'map.json'), result.map);
        writeJson(join(mapDir, 'regions.geojson'), result.regions);
        writeJson(join(mapDir, 'bridges.geojson'), result.bridges);
        writeJson(join(mapDir, 'key-locations.json'), result.keyLocations);
        writeJson(join(mapDir, 'report.json'), result.report);
        writeJson(join(root, 'data', 'locations.json'), result.locations);
    }

    return { ...result, wrote: !check && result.errors.length === 0, reportRequested: report };
}

function printReport(result) {
    const { report } = result;
    console.log('Neo Terra map build');
    console.log(`  districts:     ${report.counts.districts}`);
    console.log(`  bridges:       ${report.counts.bridges}`);
    console.log(`  key locations: ${report.counts.keyLocations}`);
    if (report.duplicateLabels.length > 0) {
        console.log('  duplicate labels:', report.duplicateLabels.map((entry) => entry.label).join(', '));
    }
    if (report.unassignedBridges.length > 0) {
        console.log('  unassigned bridges:', report.unassignedBridges.map((entry) => entry.label).join(', '));
    }
    if (report.unassignedKeyLocations.length > 0) {
        console.log('  unassigned key locations:', report.unassignedKeyLocations.map((entry) => entry.label).join(', '));
    }
    if (report.missingRegionOverrides.length > 0) {
        console.log('  missing region overrides:', report.missingRegionOverrides.join(', '));
    }
    for (const warning of report.warnings) {
        console.log(`  warning: ${warning}`);
    }
    if (result.errors.length > 0) {
        console.log(`  ERRORS (${result.errors.length}):`);
        for (const error of result.errors) {
            console.log(`    - ${error}`);
        }
    } else {
        console.log('  OK');
    }
}

const invokedDirectly = process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    const args = new Set(process.argv.slice(2));
    const check = args.has('--check');
    const report = args.has('--report');
    try {
        const result = runBuild({ check, report });
        printReport(result);
        if (result.errors.length > 0) {
            process.exitCode = 1;
        } else if (result.wrote) {
            console.log('  wrote data/map/* and data/locations.json');
        } else if (check) {
            console.log('  check passed (no files written)');
        }
    } catch (error) {
        console.error('build-map failed:', error?.message ?? error);
        process.exitCode = 1;
    }
}
