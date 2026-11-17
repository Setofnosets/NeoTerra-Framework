/**
 * Leaflet adapter for the Neo Terra city map.
 *
 * Leaflet is vendored at `vendor/leaflet/` (pinned 1.9.4) and injected on first
 * use, so the map works with no CDN, no npm install, and no other extension's
 * global `L`. The adapter owns:
 *
 * - loading/cleaning the local CSS + JS;
 * - the `L.CRS.Simple` map with the canonical `[[-1536, 0], [0, 2048]]` bounds;
 * - the single `toLatLng({ x, y }) => L.latLng(-y, x)` conversion;
 * - lightweight canvas/SVG layers for regions, bridges, and markers.
 *
 * All data entering this module is in canonical SVG coordinates (y-down).
 * Leaflet lat/lng never leaves it.
 */

import { CANONICAL_MAP, mapBounds } from '../data/map.js';

export const LEAFLET_VERSION = '1.9.4';

const VENDOR_BASE = new URL('../../vendor/leaflet/', import.meta.url);
const CSS_ID = 'neoterra-leaflet-css';
const JS_ID = 'neoterra-leaflet-js';

let leafletPromise = null;
let cssInjected = false;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/** Resolve a vendored Leaflet asset URL. */
export function leafletAssetUrl(path) {
    return new URL(path, VENDOR_BASE).href;
}

function ensureCss() {
    if (!hasDom() || cssInjected) {
        return;
    }
    if (document.getElementById(CSS_ID)) {
        cssInjected = true;
        return;
    }
    const link = document.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = leafletAssetUrl('leaflet.css');
    document.head.appendChild(link);
    cssInjected = true;
}

/**
 * Load the vendored Leaflet ESM module exactly once.
 *
 * The vendored file is the browser UMD build, which sets `window.L`. We import
 * it for its side effect and then read the global, so the extension never
 * needs a bundler and never patches the vendored file.
 */
export function loadLeaflet() {
    if (!hasDom()) {
        return Promise.reject(new Error('Leaflet requires a browser environment'));
    }
    if (window.L?.version) {
        ensureCss();
        return Promise.resolve(window.L);
    }
    if (leafletPromise) {
        return leafletPromise;
    }
    ensureCss();
    leafletPromise = new Promise((resolve, reject) => {
        const fail = (error) => {
            // A failed load must not poison every later mount.
            leafletPromise = null;
            reject(error);
        };
        const existing = document.getElementById(JS_ID);
        if (existing) {
            // The script element may already have finished loading before this
            // listener was attached; check the global before waiting.
            if (window.L?.version) {
                resolve(window.L);
                return;
            }
            existing.addEventListener('load', () => {
                if (window.L?.version) {
                    resolve(window.L);
                    return;
                }
                fail(new Error('Vendored Leaflet loaded but window.L is missing'));
            }, { once: true });
            existing.addEventListener('error', () => fail(new Error('Vendored Leaflet failed to load')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.id = JS_ID;
        script.src = leafletAssetUrl('leaflet.js');
        script.async = true;
        script.addEventListener('load', () => {
            if (window.L?.version) {
                resolve(window.L);
                return;
            }
            fail(new Error('Vendored Leaflet loaded but window.L is missing'));
        }, { once: true });
        script.addEventListener('error', () => fail(new Error('Vendored Leaflet failed to load')), { once: true });
        document.head.appendChild(script);
    });
    return leafletPromise;
}

/** Test/teardown helper: forget the cached loader promise. */
export function resetLeafletLoader() {
    leafletPromise = null;
    cssInjected = false;
}

/**
 * The single coordinate conversion. Every renderer call goes through this.
 *
 * @param {{ x: number, y: number }} point canonical SVG point
 * @param {any} L Leaflet namespace
 */
export function toLatLng(point, L) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('toLatLng requires numeric x and y');
    }
    return L.latLng(-y, x);
}

/** Inverse used by click-to-place editors. */
export function toMapPoint(latlng) {
    return {
        x: Number(latlng.lng),
        y: -Number(latlng.lat),
    };
}

/** GeoJSON polygon coordinates (y-down) -> Leaflet latlng ring. */
function polygonLatLngs(geometry, L) {
    const ring = geometry?.coordinates?.[0] ?? [];
    return ring.map(([x, y]) => toLatLng({ x, y }, L));
}

const BRIDGE_STYLE = Object.freeze({
    open: { color: '#5eead4', dashArray: null, weight: 3 },
    contested: { color: '#fbbf24', dashArray: '6 4', weight: 3 },
    blocked: { color: '#fb7185', dashArray: '2 6', weight: 3 },
    destroyed: { color: '#64748b', dashArray: '1 8', weight: 2 },
});

/**
 * Build the Leaflet map. Returns an object with the map plus the layer groups
 * so the UI can toggle visibility and re-render on state changes.
 */
export function createCityMap({
    L,
    container,
    viewModel,
    onSelect = () => {},
    settings = {},
    imageUrl = null,
} = {}) {
    if (!L || !container) {
        throw new TypeError('createCityMap requires Leaflet and a container element');
    }
    // Single source of truth for the canonical bounds (`[[-height, 0], [0, width]]`).
    const [[south, west], [north, east]] = mapBounds();
    const bounds = L.latLngBounds(toLatLng({ x: west, y: -south }, L), toLatLng({ x: east, y: -north }, L));
    const map = L.map(container, {
        crs: L.CRS.Simple,
        minZoom: -2,
        maxZoom: 4,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        attributionControl: false,
        zoomControl: true,
        maxBounds: bounds.pad(0.15),
        maxBoundsViscosity: 0.8,
        preferCanvas: false,
    }).fitBounds(bounds);

    // Base art: the PNG is stretched into the canonical box (the ~0.15% scale
    // difference against the raw 2017x1512 file is imperceptible).
    const imageName = viewModel?.image ?? CANONICAL_MAP.path;
    const resolvedImage = imageUrl ?? new URL(`../../${imageName}`, import.meta.url).href;
    L.imageOverlay(resolvedImage, bounds, {
        className: 'neoterra-map-base',
        opacity: 0.9,
        interactive: false,
    }).addTo(map);

    const layers = {
        districts: L.layerGroup().addTo(map),
        bridges: L.layerGroup().addTo(map),
        keyLocations: L.layerGroup().addTo(map),
        namedLocations: L.layerGroup().addTo(map),
        labels: L.layerGroup().addTo(map),
        fog: L.layerGroup(),
    };

    const layersById = new Map();
    const labelsById = new Map();

    for (const region of viewModel?.regions ?? []) {
        const polygon = L.polygon(polygonLatLngs(region.geometry, L), {
            color: region.color ?? '#5eead4',
            weight: 1,
            opacity: 0.5,
            fillColor: region.color ?? '#5eead4',
            fillOpacity: 0.12,
            className: 'neoterra-map-region',
        });
        polygon.on('mouseover', () => polygon.setStyle({ fillOpacity: 0.26, weight: 2 }));
        polygon.on('mouseout', () => polygon.setStyle({ fillOpacity: 0.12, weight: 1 }));
        polygon.on('click', () => onSelect({ kind: 'region', id: region.id }));
        polygon.bindTooltip(escapeLabel(region.name), { sticky: true, direction: 'top', className: 'neoterra-map-tooltip' });
        polygon.addTo(layers.districts);
        layersById.set(region.id, polygon);
        if (region.centroid) {
            const label = L.marker(toLatLng(region.centroid, L), {
                interactive: false,
                icon: L.divIcon({
                    className: 'neoterra-map-label neoterra-map-label-region',
                    html: `<span>${escapeLabel(region.name)}</span>`,
                    iconSize: [0, 0],
                }),
            });
            label.addTo(layers.labels);
            labelsById.set(region.id, label);
        }
    }

    for (const bridge of viewModel?.bridges ?? []) {
        const style = BRIDGE_STYLE[bridge.status] ?? BRIDGE_STYLE.open;
        const line = L.polyline(
            (bridge.centerline ?? bridge.endpoints ?? []).map((point) => toLatLng(point, L)),
            {
                color: style.color,
                weight: style.weight,
                dashArray: style.dashArray,
                className: 'neoterra-map-bridge',
            },
        );
        line.on('click', () => onSelect({ kind: 'bridge', id: bridge.id }));
        line.bindTooltip(escapeLabel(bridge.name), { sticky: true, className: 'neoterra-map-tooltip' });
        line.addTo(layers.bridges);
        layersById.set(bridge.id, line);
    }

    for (const key of viewModel?.keyLocations ?? []) {
        const dimmed = !key.named;
        const marker = L.circleMarker(toLatLng({ x: key.x, y: key.y }, L), {
            radius: dimmed ? 4 : 6,
            color: dimmed ? '#64748b' : '#5eead4',
            weight: 1.5,
            fillColor: dimmed ? '#1e293b' : '#0f766e',
            fillOpacity: 0.85,
            className: 'neoterra-map-key',
        });
        marker.on('click', () => onSelect({ kind: 'keyLocation', id: key.id }));
        marker.bindTooltip(escapeLabel(key.name), { direction: 'top', className: 'neoterra-map-tooltip' });
        marker.addTo(layers.keyLocations);
        layersById.set(key.id, marker);
        if (!dimmed) {
            const label = L.marker(toLatLng({ x: key.x, y: key.y }, L), {
                interactive: false,
                icon: L.divIcon({
                    className: 'neoterra-map-label neoterra-map-label-key',
                    html: `<span>${escapeLabel(key.name)}</span>`,
                    iconSize: [0, 0],
                }),
            });
            label.addTo(layers.labels);
            labelsById.set(key.id, label);
        }
    }

    for (const location of viewModel?.namedLocations ?? []) {
        const marker = L.circleMarker(toLatLng({ x: location.x, y: location.y }, L), {
            radius: 7,
            color: '#f8fafc',
            weight: 2,
            fillColor: location.virtual ? '#7c3aed' : '#38bdf8',
            fillOpacity: 0.95,
            className: 'neoterra-map-location',
        });
        marker.on('click', () => onSelect({ kind: 'namedLocation', id: location.id }));
        marker.bindTooltip(escapeLabel(location.name), { direction: 'top', className: 'neoterra-map-tooltip' });
        marker.bindPopup(
            `<strong>${escapeLabel(location.name)}</strong><br>${escapeLabel(location.status ?? '')}`,
            { className: 'neoterra-map-popup', closeButton: true },
        );
        marker.addTo(layers.namedLocations);
        layersById.set(location.id, marker);
    }

    for (const layerName of ['districts', 'bridges', 'keyLocations', 'namedLocations', 'labels', 'fog']) {
        // The panel passes a visibility map (keys `districts…fog`); a settings
        // object uses `showFogOfWar`. Accept both.
        const visible = layerName === 'fog'
            ? (settings.fog ?? settings.showFogOfWar) === true
            : settings[layerName] !== false;
        setLayerVisible(layerName, visible);
    }

    function setLayerVisible(layerName, visible) {
        const group = layers[layerName];
        if (!group) {
            return;
        }
        if (visible) {
            if (!map.hasLayer(group)) {
                group.addTo(map);
            }
        } else if (map.hasLayer(group)) {
            map.removeLayer(group);
        }
    }

    function highlight(selection) {
        for (const [id, layer] of layersById) {
            const selected = selection && id === selection.id;
            if (typeof layer.setStyle !== 'function') {
                continue;
            }
            if (layer instanceof L.Polygon) {
                layer.setStyle(selected
                    ? { weight: 3, opacity: 0.95, fillOpacity: 0.3 }
                    : { weight: 1, opacity: 0.5, fillOpacity: 0.12 });
            } else if (layer instanceof L.Polyline) {
                layer.setStyle({ weight: selected ? 5 : 3 });
            } else if (layer instanceof L.CircleMarker) {
                layer.setStyle({ weight: selected ? 3 : 1.5, radius: selected ? 8 : undefined });
            }
        }
    }

    function focus(point, zoom = 0) {
        if (!point) {
            return;
        }
        map.setView(toLatLng(point, L), zoom);
    }

    return {
        map,
        layers,
        layersById,
        labelsById,
        setLayerVisible,
        highlight,
        focus,
        fitBounds: () => map.fitBounds(bounds),
        dispose() {
            map.remove();
        },
        // Exposed for tests/inspection.
        bounds,
    };
}

function escapeLabel(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
