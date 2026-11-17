/**
 * Neo Terra map component.
 *
 * This module is the thin, DOM/Leaflet-facing component. It receives a
 * renderer-agnostic view model from `src/data/map.js` and mounts the vendored
 * Leaflet map (see `leaflet-adapter.js`). The panel (`map-panel.js`) owns the
 * surrounding chrome, state machine, and feature submenu.
 *
 * Data contract: every coordinate here is canonical SVG (2048x1536, y-down).
 * Leaflet conversion happens only inside the adapter.
 */

import { BRIDGE_STATUSES, DEFAULT_LAYER_VISIBILITY, MAP_LAYER_ORDER } from '../data/map.js';
import { createCityMap, loadLeaflet, resetLeafletLoader } from './leaflet-adapter.js';

export const MAP_LAYER_LABELS = Object.freeze({
    districts: 'Districts',
    bridges: 'Bridges',
    keyLocations: 'Key locations',
    namedLocations: 'Named locations',
    labels: 'Labels',
    fog: 'Fog',
});

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function defaultLayerVisibility(settings = {}) {
    return Object.fromEntries(MAP_LAYER_ORDER.map((layer) => {
        if (layer === 'fog') {
            return [layer, settings.showFogOfWar === true || DEFAULT_LAYER_VISIBILITY.fog];
        }
        return [layer, settings[layer] !== false];
    }));
}

export function renderLayerToggles(visibility) {
    return MAP_LAYER_ORDER.map((layer) => `
        <label class="neoterra-map-toggle">
            <input type="checkbox" data-neoterra-map-toggle="${layer}"
                ${visibility[layer] ? 'checked' : ''}>
            <span>${escapeHtml(MAP_LAYER_LABELS[layer] ?? layer)}</span>
        </label>`).join('');
}

/** Bridge status -> the class hook used by `style.css`. */
export function bridgeStatusClass(status) {
    return BRIDGE_STATUSES.includes(status) ? `is-${status}` : 'is-open';
}

/**
 * Mount the Leaflet map on a container.
 *
 * @param {{
 *   container: HTMLElement,
 *   viewModel: object,
 *   visibility?: Record<string, boolean>,
 *   onSelect?: Function,
 *   leaflet?: object|null,
 *   imageUrl?: string|null,
 * }} options
 */
export async function mountCityMap({
    container,
    viewModel,
    visibility = null,
    onSelect = () => {},
    leaflet = null,
    imageUrl = null,
} = {}) {
    if (!container) {
        throw new TypeError('mountCityMap requires a container element');
    }
    if (!viewModel) {
        throw new TypeError('mountCityMap requires a map view model');
    }
    const L = leaflet ?? await loadLeaflet();
    const cityMap = createCityMap({
        L,
        container,
        viewModel,
        settings: visibility ?? defaultLayerVisibility(),
        imageUrl,
        onSelect,
    });
    return {
        ...cityMap,
        setSelection: (selection) => cityMap.highlight(selection),
        setVisibility: (layer, visible) => cityMap.setLayerVisible(layer, visible),
        destroy: () => cityMap.dispose(),
    };
}

/**
 * The single-image fallback used when generated data is missing or invalid:
 * the base PNG plus named-location markers only.
 */
export async function mountFallbackMap({
    container,
    viewModel,
    visibility = null,
    onSelect = () => {},
    leaflet = null,
    imageUrl = null,
} = {}) {
    if (!container) {
        throw new TypeError('mountFallbackMap requires a container element');
    }
    const L = leaflet ?? await loadLeaflet();
    const fallbackModel = {
        ...viewModel,
        regions: [],
        bridges: [],
        keyLocations: [],
        counts: { ...(viewModel?.counts ?? {}), regions: 0, bridges: 0, keyLocations: 0 },
    };
    const cityMap = createCityMap({
        L,
        container,
        viewModel: fallbackModel,
        settings: {
            ...defaultLayerVisibility(),
            ...(visibility ?? {}),
            // Geometry layers are empty in fallback mode; labels/fog stay off.
            labels: false,
            fog: false,
        },
        imageUrl,
        onSelect,
    });
    return {
        ...cityMap,
        setSelection: (selection) => cityMap.highlight(selection),
        setVisibility: () => {},
        destroy: () => cityMap.dispose(),
    };
}

export { loadLeaflet, resetLeafletLoader };
