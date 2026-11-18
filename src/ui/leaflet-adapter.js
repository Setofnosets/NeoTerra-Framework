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

export const FOG_REGION_STYLE = Object.freeze({
    unknown: {
        color: '#0b1020',
        fillColor: '#0b1020',
        fillOpacity: 0.95,
        opacity: 1,
        weight: 1,
        dashArray: null,
    },
    rumored: {
        color: '#475569',
        fillColor: '#475569',
        fillOpacity: 0.06,
        opacity: 0.55,
        weight: 1,
        dashArray: '4 4',
    },
});

/** Leaflet style for a region, including fog visibility. */
export function regionLeafletStyle(feature) {
    const visibility = feature?.visibility ?? 'discovered';
    if (visibility === 'unknown') {
        return { ...FOG_REGION_STYLE.unknown };
    }
    if (visibility === 'rumored') {
        return { ...FOG_REGION_STYLE.rumored };
    }
    const color = feature?.color ?? '#5eead4';
    return {
        color,
        weight: 1,
        opacity: 0.5,
        fillColor: color,
        fillOpacity: 0.12,
        dashArray: null,
    };
}

/** Leaflet style for a bridge; an unknown bridge is not drawn at all. */
export function bridgeLeafletStyle(feature) {
    if ((feature?.visibility ?? 'discovered') === 'unknown') {
        return { color: '#0b1020', weight: 0, opacity: 0, dashArray: null };
    }
    const style = BRIDGE_STYLE[feature?.status] ?? BRIDGE_STYLE.open;
    return { ...style };
}

/** True when the feature's name may appear as a DOM label/tooltip. */
export function featureLabelVisible(feature) {
    return feature?.labelHidden !== true
        && (feature?.visibility ?? 'discovered') !== 'unknown';
}

function markerOpacity(feature) {
    const visibility = feature?.visibility ?? 'discovered';
    if (visibility === 'unknown') {
        return 0;
    }
    if (visibility === 'rumored') {
        return 0.55;
    }
    return 1;
}

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
        const baseStyle = regionLeafletStyle(region);
        const polygon = L.polygon(polygonLatLngs(region.geometry, L), {
            ...baseStyle,
            className: 'neoterra-map-region',
        });
        polygon.on('mouseover', () => {
            const current = featureState.get(region.id) ?? region;
            if ((current.visibility ?? 'discovered') === 'discovered') {
                const base = regionLeafletStyle(current);
                polygon.setStyle({ ...base, fillOpacity: 0.26, weight: 2 });
            }
        });
        polygon.on('mouseout', () => {
            const current = featureState.get(region.id) ?? region;
            if ((current.visibility ?? 'discovered') !== 'unknown') {
                polygon.setStyle(regionLeafletStyle(current));
            }
        });
        polygon.on('click', () => onSelect({ kind: 'region', id: region.id }));
        if (featureLabelVisible(region)) {
            polygon.bindTooltip(escapeLabel(region.name), { sticky: true, direction: 'top', className: 'neoterra-map-tooltip' });
        }
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
        const style = bridgeLeafletStyle(bridge);
        const line = L.polyline(
            (bridge.centerline ?? bridge.endpoints ?? []).map((point) => toLatLng(point, L)),
            {
                color: style.color,
                weight: style.weight,
                opacity: style.opacity ?? 1,
                dashArray: style.dashArray,
                className: 'neoterra-map-bridge',
            },
        );
        line.on('click', () => {
            const current = featureState.get(bridge.id) ?? bridge;
            if ((current.visibility ?? 'discovered') === 'unknown') {
                return;
            }
            onSelect({ kind: 'bridge', id: bridge.id });
        });
        if (featureLabelVisible(bridge)) {
            line.bindTooltip(escapeLabel(bridge.name), { sticky: true, className: 'neoterra-map-tooltip' });
        }
        line.addTo(layers.bridges);
        layersById.set(bridge.id, line);
    }

    for (const key of viewModel?.keyLocations ?? []) {
        const dimmed = !key.named;
        const marker = L.circleMarker(toLatLng({ x: key.x, y: key.y }, L), {
            radius: dimmed ? 4 : 6,
            color: dimmed ? '#64748b' : '#5eead4',
            weight: 1.5,
            opacity: markerOpacity(key),
            fillColor: dimmed ? '#1e293b' : '#0f766e',
            fillOpacity: 0.85 * markerOpacity(key),
            className: 'neoterra-map-key',
        });
        marker.on('click', () => onSelect({ kind: 'keyLocation', id: key.id }));
        if (featureLabelVisible(key)) {
            marker.bindTooltip(escapeLabel(key.name), { direction: 'top', className: 'neoterra-map-tooltip' });
        }
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
        const opacity = markerOpacity(location);
        const marker = L.circleMarker(toLatLng({ x: location.x, y: location.y }, L), {
            radius: 7,
            color: '#f8fafc',
            weight: 2,
            opacity,
            fillColor: location.virtual ? '#7c3aed' : '#38bdf8',
            fillOpacity: 0.95 * opacity,
            className: 'neoterra-map-location',
        });
        marker.on('click', () => onSelect({ kind: 'namedLocation', id: location.id }));
        if (featureLabelVisible(location)) {
            marker.bindTooltip(escapeLabel(location.name), { direction: 'top', className: 'neoterra-map-tooltip' });
            marker.bindPopup(
                `<strong>${escapeLabel(location.name)}</strong><br>${escapeLabel(location.status ?? '')}`,
                { className: 'neoterra-map-popup', closeButton: true },
            );
        }
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

    const featureState = new Map();
    for (const feature of [
        ...(viewModel?.regions ?? []),
        ...(viewModel?.bridges ?? []),
        ...(viewModel?.keyLocations ?? []),
        ...(viewModel?.namedLocations ?? []),
    ]) {
        featureState.set(feature.id, feature);
    }

    function labelIcon(feature, kind) {
        const visible = featureLabelVisible(feature);
        const className = kind === 'region'
            ? 'neoterra-map-label neoterra-map-label-region'
            : 'neoterra-map-label neoterra-map-label-key';
        return L.divIcon({
            className,
            html: visible ? `<span>${escapeLabel(feature.name)}</span>` : '',
            iconSize: [0, 0],
        });
    }

    function syncFeatureLabel(feature, kind) {
        const label = labelsById.get(feature.id);
        if (!label) {
            return;
        }
        label.setIcon?.(labelIcon(feature, kind));
        const labelElement = label.getElement?.();
        if (labelElement?.style) {
            labelElement.style.display = featureLabelVisible(feature) ? '' : 'none';
        }
    }

    function syncFeatureTooltip(layer, feature, kind) {
        if (typeof layer?.unbindTooltip === 'function') {
            layer.unbindTooltip();
        }
        if (featureLabelVisible(feature) && typeof layer?.bindTooltip === 'function') {
            layer.bindTooltip(escapeLabel(feature.name), {
                sticky: kind === 'region' || kind === 'bridge',
                direction: 'top',
                className: 'neoterra-map-tooltip',
            });
        }
        if (kind === 'named' && typeof layer?.unbindPopup === 'function') {
            layer.unbindPopup();
            if (featureLabelVisible(feature) && typeof layer?.bindPopup === 'function') {
                layer.bindPopup(
                    `<strong>${escapeLabel(feature.name)}</strong><br>${escapeLabel(feature.status ?? '')}`,
                    { className: 'neoterra-map-popup', closeButton: true },
                );
            }
        }
    }

    function applyFog(nextViewModel, { fogEnabled = false } = {}) {
        const models = [
            ...(nextViewModel?.regions ?? []).map((entry) => ['region', entry]),
            ...(nextViewModel?.bridges ?? []).map((entry) => ['bridge', entry]),
            ...(nextViewModel?.keyLocations ?? []).map((entry) => ['key', entry]),
            ...(nextViewModel?.namedLocations ?? []).map((entry) => ['named', entry]),
        ];
        for (const [kind, feature] of models) {
            featureState.set(feature.id, feature);
            const layer = layersById.get(feature.id);
            if (!layer) {
                continue;
            }
            if (kind === 'region' && layer.setStyle) {
                // With fog on, discovered regions keep whatever the overlay
                // tint painted; only fog states override the fill. With fog
                // off, every region returns to its V1 style.
                if (!fogEnabled || (feature.visibility ?? 'discovered') !== 'discovered') {
                    layer.setStyle(regionLeafletStyle(feature));
                }
            } else if (kind === 'bridge' && layer.setStyle) {
                const style = bridgeLeafletStyle(feature);
                layer.setStyle({
                    color: style.color,
                    weight: style.weight,
                    opacity: style.opacity ?? 1,
                    dashArray: style.dashArray,
                });
            } else if ((kind === 'key' || kind === 'named') && layer.setStyle) {
                const opacity = markerOpacity(feature);
                layer.setStyle({
                    opacity,
                    fillOpacity: (kind === 'key' ? 0.85 : 0.95) * opacity,
                });
                const element = layer.getElement?.();
                if (element?.style) {
                    element.style.pointerEvents = opacity === 0 ? 'none' : '';
                }
            }
            syncFeatureLabel(feature, kind);
            syncFeatureTooltip(layer, feature, kind);
        }
    }

    function highlight(selection) {
        for (const [id, layer] of layersById) {
            const selected = selection && id === selection.id;
            if (typeof layer.setStyle !== 'function') {
                continue;
            }
            const feature = featureState.get(id);
            if ((feature?.visibility ?? 'discovered') === 'unknown') {
                continue;
            }
            if (layer instanceof L.Polygon) {
                // Colour-neutral: fog and the overlay own the fill colour.
                layer.setStyle(selected
                    ? { weight: 3, opacity: 0.95 }
                    : { weight: 1, opacity: 0.5 });
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

    applyFog(viewModel, { fogEnabled: (settings.fog ?? settings.showFogOfWar) === true });

    return {
        map,
        layers,
        layersById,
        labelsById,
        setLayerVisible,
        highlight,
        applyFog,
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
