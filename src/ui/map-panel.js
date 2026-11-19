/**
 * Neo Terra city map panel.
 *
 * The panel owns the map tab:
 * - loads generated map geometry plus the authored overlays and lore registry;
 * - builds the renderer-agnostic view model (`buildMapViewModel`);
 * - mounts the vendored Leaflet map (`mountCityMap`, fallback `mountFallbackMap`);
 * - renders layer toggles and the feature submenu, with live `WorldState`;
 * - keeps a small state machine `closed -> open -> location -> travel`;
 * - remembers its draggable/resizable geometry in localStorage.
 *
 * Travel is validated and reported only; Step 14 owns the actual move.
 */

import { EVENTS, bus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { createMachine } from '../core/machine.js';
import { avatarMarkup, avatarStripMarkup, characterNameFor, initAvatars } from './avatar.js';
import {
    MAP_LAYER_ORDER,
    addChatVirtualNode,
    buildMapFeatureIndex,
    buildMapSubmenu,
    buildMapViewModel,
    buildWorldOverlay,
    applyMapFog,
    clearGeneratedMapCaches,
    exportMapOverrides,
    getChatMapOverrides,
    loadDistricts,
    loadGeneratedMapData,
    loadMapOverrides,
    parseMapOverrides,
    removeChatMapOverride,
    removeChatVirtualNode,
    resetChatMapOverrides,
    setChatMapOverride,
    updateChatVirtualNode,
} from '../data/map.js';
import { loadLocations } from '../data/locations.js';
import { buildNewspaperView } from '../data/newsroom.js';
import { loadWorldStateFromMetadata } from '../state/store.js';
import { getExploration } from '../state/exploration.js';
import {
    applyEditorPatch,
    buildDirectorCard,
    buildEditorSchema,
    deleteEditorOverride,
    renderMapEditor,
    renderVirtualNodeForm,
    renderWorldOverlayMarkup,
    resetEditorOverride,
    validateEditorPatch,
} from './overlay.js';
import { mountCityMap, mountFallbackMap } from './map.js';
import { mountNewspaperReader } from './newspaper.js';
import { createPacingFlow } from '../flows/pacing.js';

const logger = createLogger('map-panel');

const STORAGE_KEY = 'neoterra:map:panel';
/**
 * Global (authored) override edits made in the browser. Browsers cannot write
 * `data/map/overrides.json`, so edits are kept here and exported with the
 * editor's "Export overrides" button for committing to the repo.
 */
const OVERRIDES_KEY = 'neoterra:map:overrides';
/** Bumped when the geometry storage shape changes. */
export const GEOMETRY_VERSION = 2;
const DEFAULT_GEOMETRY = Object.freeze({ x: null, y: null, width: 1080, height: 820 });
/**
 * The v1 default. A stored geometry that still equals it was never chosen by
 * the user: it is the value the old code wrote on every clamp, so it must not
 * defeat the taller v2 default. Any other stored size is preserved.
 */
const LEGACY_DEFAULT_GEOMETRY = Object.freeze({ width: 1080, height: 700 });
const MIN_WIDTH = 360;
const MIN_HEIGHT = 300;

let mounted = null;

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function safeLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Panel geometry
 * ------------------------------------------------------------------ */

export function clampPanelGeometry(geometry, viewport = { width: 1920, height: 1080 }) {
    const viewWidth = Math.max(MIN_WIDTH, Number(viewport?.width) || 1920);
    const viewHeight = Math.max(MIN_HEIGHT, Number(viewport?.height) || 1080);
    // When the viewport is shorter than the minimum, the minimum wins (and
    // may overflow) instead of producing a negative clamp range.
    const maxWidth = Math.max(MIN_WIDTH, viewWidth - 24);
    const maxHeight = Math.max(MIN_HEIGHT, viewHeight - 24);
    const width = Math.min(
        Math.max(Number(geometry?.width) || DEFAULT_GEOMETRY.width, MIN_WIDTH),
        maxWidth,
    );
    const height = Math.min(
        Math.max(Number(geometry?.height) || DEFAULT_GEOMETRY.height, MIN_HEIGHT),
        maxHeight,
    );
    const maxX = Math.max(12, viewWidth - width - 12);
    const maxY = Math.max(12, viewHeight - height - 12);
    const rawX = Number(geometry?.x);
    const rawY = Number(geometry?.y);
    return {
        x: Number.isFinite(rawX) ? Math.min(Math.max(rawX, 12), maxX) : Math.max(12, Math.round((viewWidth - width) / 2)),
        y: Number.isFinite(rawY) ? Math.min(Math.max(rawY, 12), maxY) : Math.max(12, Math.round((viewHeight - height) / 2)),
        width,
        height,
    };
}

function isLegacyDefaultGeometry(parsed) {
    if (parsed?.geometryVersion >= GEOMETRY_VERSION) {
        return false;
    }
    // The v1 code always persisted the clamped geometry, so a legacy record
    // always carries finite x/y. Only the *size* identifies the untouched
    // default; positions are re-clamped (or re-centered) on load anyway.
    return Number(parsed?.width) === LEGACY_DEFAULT_GEOMETRY.width
        && Number(parsed?.height) === LEGACY_DEFAULT_GEOMETRY.height;
}

/**
 * Read the persisted panel geometry. Storage written before
 * `GEOMETRY_VERSION` that still holds the old 1080×700 default is treated as
 * unset; any other stored size is preserved and re-clamped on load.
 */
export function loadPanelGeometry(storage = null) {
    if (!storage) {
        return { ...DEFAULT_GEOMETRY };
    }
    try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object') {
            return { ...DEFAULT_GEOMETRY };
        }
        if (isLegacyDefaultGeometry(parsed)) {
            return { ...DEFAULT_GEOMETRY };
        }
        return {
            x: Number.isFinite(parsed.x) ? parsed.x : null,
            y: Number.isFinite(parsed.y) ? parsed.y : null,
            width: Number(parsed.width) || DEFAULT_GEOMETRY.width,
            height: Number(parsed.height) || DEFAULT_GEOMETRY.height,
        };
    } catch (error) {
        logger.warn('Could not read stored map panel geometry', error);
        return { ...DEFAULT_GEOMETRY };
    }
}

export function savePanelGeometry(storage, geometry) {
    if (!storage) {
        return false;
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ ...geometry, geometryVersion: GEOMETRY_VERSION }));
        return true;
    } catch (error) {
        logger.warn('Could not persist map panel geometry', error);
        return false;
    }
}

const VISIBILITY_KEY = 'neoterra:map:layers';

/** Read the remembered layer visibility (per user, not per chat). */
export function loadLayerVisibility(storage = null, settings = {}) {
    const defaults = buildLayerToggleState(settings);
    if (!storage) {
        return defaults;
    }
    try {
        const parsed = JSON.parse(storage.getItem(VISIBILITY_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object') {
            return defaults;
        }
        return Object.fromEntries(MAP_LAYER_ORDER.map((layer) => [
            layer,
            typeof parsed[layer] === 'boolean' ? parsed[layer] : defaults[layer],
        ]));
    } catch (error) {
        logger.warn('Could not read stored map layer visibility', error);
        return defaults;
    }
}

export function saveLayerVisibility(storage, visibility) {
    if (!storage) {
        return false;
    }
    try {
        storage.setItem(VISIBILITY_KEY, JSON.stringify(visibility));
        return true;
    } catch (error) {
        logger.warn('Could not persist map layer visibility', error);
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * Layer toggles
 * ------------------------------------------------------------------ */

export function buildLayerToggleState(settings = {}) {
    return Object.fromEntries(MAP_LAYER_ORDER.map((layer) => [
        layer,
        layer === 'fog' ? settings.showFogOfWar === true : settings[layer] !== false,
    ]));
}

/* ------------------------------------------------------------------ *
 * Submenu
 * ------------------------------------------------------------------ */

export function renderSubmenuMarkup(submenu) {
    if (!submenu?.ok) {
        return `
        <div class="neoterra-map-submenu neoterra-map-submenu-empty" data-neoterra-map-submenu>
            <p class="neoterra-placeholder">${escapeHtml(submenu?.error ?? 'Select a district, bridge, or location.')}</p>
        </div>`;
    }
    const facts = [
        ['Type', submenu.typeLabel],
        ['District', submenu.districtName ?? submenu.districtId],
        ['Faction', submenu.factionName ?? submenu.factionId],
        ['Status', submenu.status],
    ].filter(([, value]) => value);
    const present = (submenu.present ?? []).filter(Boolean);
    const connects = (submenu.connects ?? [])
        .map((id, index) => submenu.connectsNames?.[index] ?? id)
        .filter(Boolean);
    const travel = submenu.travel ?? { enabled: false };

    return `
    <div class="neoterra-map-submenu" data-neoterra-map-submenu
        data-neoterra-map-selection="${escapeHtml(submenu.selection?.id ?? '')}">
        <header class="neoterra-map-submenu-header">
            <h4>${escapeHtml(submenu.title)}</h4>
            <button type="button" class="neoterra-icon-button" data-neoterra-map-clear
                aria-label="Clear selection">&times;</button>
        </header>
        ${submenu.description ? `<p class="neoterra-map-description">${escapeHtml(submenu.description)}</p>` : ''}
        <dl class="neoterra-map-facts">
            ${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        </dl>
        ${present.length > 0
            ? `<div class="neoterra-map-present"><strong>Present:</strong>
                ${avatarStripMarkup(present, { size: 'sm' })}
                <span class="neoterra-map-present-names">${present.map((id) => escapeHtml(characterNameFor(id))).join(', ')}</span>
            </div>`
            : ''}
        ${connects.length > 0
            ? `<p class="neoterra-map-connects"><strong>Connects:</strong> ${connects.map(escapeHtml).join(' &harr; ')}</p>`
            : ''}
        <div class="neoterra-map-actions">
            <button type="button" class="menu_button" data-neoterra-map-travel
                ${travel.enabled ? '' : 'disabled'}
                title="${escapeHtml(travel.reason ?? 'Travel to this location')}">Travel</button>
            ${travel.enabled ? '' : `<span class="neoterra-map-hint">${escapeHtml(travel.reason ?? '')}</span>`}
        </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

/**
 * Load every map input. A missing/invalid generated build resolves to
 * `generated: null` so the panel can fall back to the single-image map.
 */
export async function loadMapSources({ fetchImpl = globalThis.fetch } = {}) {
    const [generated, districts, overrides, locations] = await Promise.all([
        loadGeneratedMapData({ fetchImpl }),
        loadDistricts({ fetchImpl }),
        loadMapOverrides({ fetchImpl }),
        loadLocations({ fetchImpl }),
    ]);
    return { generated, districts, overrides, locations };
}

/** Build the view model from sources plus live state. */
export function buildPanelViewModel(sources, state = null, settings = {}) {
    const { generated, districts, overrides, locations } = sources ?? {};
    const viewModel = buildMapViewModel({
        regions: generated?.regions ?? null,
        bridges: generated?.bridges ?? null,
        keyLocations: generated?.keyLocations ?? null,
        overrides,
        districts,
        locations,
        state,
    });
    if (settings?.showFogOfWar !== true) {
        return viewModel;
    }
    return applyMapFog(viewModel, getExploration(state), {
        mode: settings?.fog?.mode ?? 'rumors',
        revealNeighbors: settings?.fog?.revealNeighbors !== false,
        showRumoredLabels: settings?.fog?.showRumoredLabels !== false,
    });
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   root: HTMLElement,
 *   ctx?: object|null,
 *   store?: object|null,
 *   season?: object|null,
 *   settings?: object,
 *   storage?: object|null,
 *   loadSources?: Function,
 *   leaflet?: object|null,
 *   onTravel?: Function|null,
 *   onClose?: Function|null,
 *   onMapStateChange?: Function|null,
 * }} options
 */
export async function mountMapPanel(options = {}) {
    if (!hasDom()) {
        return null;
    }
    const { root, ctx = null, settings = {}, onTravel = null, onClose = null } = options;
    if (!root) {
        throw new TypeError('mountMapPanel requires a root element');
    }

    disposeMapPanel();

    const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    const state = {
        root,
        ctx,
        store: options.store ?? null,
        settings,
        storage,
        controller: new AbortController(),
        sources: null,
        viewModel: null,
        submenu: null,
        cityMap: null,
        error: null,
        loading: true,
        geometry: loadPanelGeometry(storage),
        toggles: loadLayerVisibility(storage, settings),
        fogOverride: null,
        loadSources: options.loadSources ?? loadMapSources,
        leaflet: options.leaflet ?? null,
        onTravel,
        // The X closes the map *window*; the host (the shell) decides what that
        // means outside the panel. Without it the button was dead: the state
        // machine reached `closed` but nothing was hidden.
        onClose: typeof onClose === 'function' ? onClose : null,
        onMapStateChange: options.onMapStateChange ?? null,
        getSettings: typeof options.getSettings === 'function' ? options.getSettings : null,
        onFogChange: typeof options.onFogChange === 'function' ? options.onFogChange : null,
        season: options.season ?? null,
        flow: null,
        overlay: null,
        editor: null,
        editorError: null,
        globalOverrides: null,
        pacing: options.pacing ?? null,
        pacingError: null,
        newspaperReader: null,
    };
    mounted = state;
    void initAvatars({ registry: options.registry ?? null, ctx }).then(() => paintSide()).catch(() => {});
    // The layer toggle is the on/off switch. A stored toggle wins over the
    // saved setting so fog survives reload without writing global settings.
    state.fogOverride = state.toggles.fog === true;
    if (state.settings && typeof state.settings === 'object') {
        state.settings.showFogOfWar = state.fogOverride;
    }

    if (!state.pacing && state.store && typeof state.store.get === 'function') {
        try {
            state.pacing = createPacingFlow({
                store: state.store,
                season: options.season ?? null,
                scene: options.scene ?? null,
                initiative: options.initiative ?? null,
                getSettings: typeof state.getSettings === 'function' ? state.getSettings : null,
                log: (message, error) => logger.warn(message, error),
            });
        } catch (error) {
            logger.warn('Could not create the pacing flow', error);
            state.pacing = null;
        }
    }

    state.flow = createMachine({
        name: 'map',
        initial: 'closed',
        context: { selection: null, travel: null },
        states: {
            closed: { on: { OPEN: 'open' } },
            open: { on: { SELECT: 'location', CLOSE: 'closed' } },
            location: {
                on: {
                    SELECT: {
                        target: 'location',
                        internal: true,
                        action: (context, payload) => { context.selection = payload; },
                    },
                    OPEN_TRAVEL: 'travel',
                    CLEAR: { target: 'open', action: (context) => { context.selection = null; } },
                    CLOSE: 'closed',
                },
            },
            travel: {
                on: {
                    CONFIRM_TRAVEL: { target: 'location', action: (context) => { context.travel = null; } },
                    CANCEL_TRAVEL: { target: 'location', action: (context) => { context.travel = null; } },
                    SELECT: {
                        target: 'location',
                        action: (context, payload) => {
                            context.selection = payload;
                            context.travel = null;
                        },
                    },
                    CLEAR: {
                        target: 'open',
                        action: (context) => {
                            context.selection = null;
                            context.travel = null;
                        },
                    },
                    CLOSE: 'closed',
                },
            },
        },
        onChange: (to) => {
            if (mounted !== state) {
                return;
            }
            paintSide();
        },
    });

    root.innerHTML = renderShellMarkup(state);
    applyGeometry(state);

    root.addEventListener('click', (event) => {
        if (mounted !== state) {
            return;
        }
        const toggle = event.target.closest?.('[data-neoterra-map-toggle]');
        if (toggle) {
            const layer = toggle.dataset.neoterraMapToggle;
            state.toggles[layer] = !state.toggles[layer];
            if (layer === 'fog') {
                if (!state.generated) {
                    state.toggles.fog = false;
                    toggle.checked = false;
                    state.error = 'Fog of war needs the generated map; the single-image fallback cannot mask districts.';
                    paintSide();
                    return;
                }
                state.fogOverride = state.toggles.fog;
                state.settings.showFogOfWar = state.fogOverride;
                try {
                    state.onFogChange?.(state.fogOverride);
                } catch (error) {
                    logger.warn('Could not persist the fog toggle', error);
                }
            } else {
                state.settings[layer] = state.toggles[layer];
            }
            saveLayerVisibility(state.storage, state.toggles);
            state.cityMap?.setVisibility?.(layer, state.toggles[layer]);
            if (layer === 'fog') {
                refreshMapPanel();
            }
            return;
        }
        if (event.target.closest?.('[data-neoterra-map-clear]')) {
            selectFeature(state, null);
            return;
        }
        if (event.target.closest?.('[data-neoterra-map-return]')) {
            state.flow.send('CLOSE');
            if (!runCloseHandler(state.onClose)) {
                logger.debug('The map close callback failed');
            }
            return;
        }
        if (event.target.closest?.('[data-neoterra-map-close]')) {
            state.flow.send('CLOSE');
            if (!runCloseHandler(state.onClose)) {
                logger.debug('The map close callback failed');
            }
            return;
        }
        if (event.target.closest?.('[data-neoterra-map-travel]')) {
            void openTravel(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-map-recenter]')) {
            state.cityMap?.fitBounds?.();
        }
        if (event.target.closest?.('[data-neoterra-intro-dismiss]')) {
            state.lastIntro = null;
            paintSide();
            return;
        }
        if (event.target.closest?.('[data-neoterra-overlay-toggle]')) {
            state.overlayCollapsed = !state.overlayCollapsed;
            paintSide();
            return;
        }
        if (event.target.closest?.('[data-neoterra-pacing-cut]')) {
            void handlePacingCut(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-pacing-snooze]')) {
            handlePacingSnooze(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-pacing-release]')) {
            void handlePacingRelease(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-newspaper-open]')) {
            openNewspaperReader(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-save]')) {
            handleEditorSave(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-reset]')) {
            handleEditorReset(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-delete]')) {
            handleEditorDelete(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-export]')) {
            handleEditorExport(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-import]')) {
            state.root.querySelector('[data-neoterra-editor-import-input]')?.click?.();
            return;
        }
        if (event.target.closest?.('[data-neoterra-editor-reset-chat]')) {
            handleChatMapReset(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-exploration-reveal]')) {
            handleExplorationReveal(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-exploration-reset]')) {
            handleExplorationReset(state);
            return;
        }
        if (event.target.closest?.('[data-neoterra-node-add]')) {
            handleAddVirtualNode(state);
        }
    }, { signal: state.controller.signal });

    root.addEventListener('change', (event) => {
        if (mounted !== state) {
            return;
        }
        const input = event.target.closest?.('[data-neoterra-editor-import-input]');
        if (input && input.files?.length > 0) {
            void handleEditorImport(state, input.files[0]);
        }
    }, { signal: state.controller.signal });

    const onTab = (payload) => {
        if (payload?.tab === 'map' && mounted === state) {
            refreshMapPanel();
        }
    };
    bus.on(EVENTS.TAB_CHANGED, onTab);
    const onMapUpdate = (payload) => {
        if (mounted !== state) {
            return;
        }
        const result = payload?.travel ?? null;
        if (result?.ok) {
            state.lastTravel = result;
            if (result.intro?.text) {
                state.lastIntro = result.intro;
            }
        }
        refreshMapPanel();
    };
    bus.on(EVENTS.MAP_UPDATED, onMapUpdate);
    state.controller.signal.addEventListener('abort', () => {
        bus.off?.(EVENTS.TAB_CHANGED, onTab);
        bus.off?.(EVENTS.MAP_UPDATED, onMapUpdate);
    }, { once: true });

    state.flow.send('OPEN');
    void loadAndMount(state);
    return {
        refresh: refreshMapPanel,
        dispose: disposeMapPanel,
        getState: () => state.flow?.state ?? 'closed',
        getViewModel: () => state.viewModel,
        getSubmenu: () => state.submenu,
        getSources: () => state.sources,
        getOverlay: () => state.overlay,
        select: (selection) => selectFeature(state, selection),
    };
}

/**
 * Invoke the host's map-close callback without letting a host error break the
 * panel. Exported so the guard is testable without a DOM.
 */
export function runCloseHandler(handler) {
    if (typeof handler !== 'function') {
        return false;
    }
    try {
        handler();
        return true;
    } catch (error) {
        logger.debug('The map close callback threw', error);
        return false;
    }
}

function renderShellMarkup(state) {
    const toggles = MAP_LAYER_ORDER.map((layer) => `
        <label class="neoterra-map-toggle">
            <input type="checkbox" data-neoterra-map-toggle="${layer}"
                ${state.toggles[layer] ? 'checked' : ''}>
            <span>${escapeHtml(layerLabel(layer))}</span>
        </label>`).join('');
    return `
    <div class="neoterra-map" data-neoterra-map>
        <header class="neoterra-map-toolbar" data-neoterra-map-drag>
            <div class="neoterra-map-toggles" role="group" aria-label="Map layers">${toggles}</div>
            <div class="neoterra-map-buttons">
                <button type="button" class="menu_button" data-neoterra-map-recenter>Recenter</button>
                <button type="button" class="menu_button" data-neoterra-map-return>Return to chat</button>
                <button type="button" class="neoterra-icon-button" data-neoterra-map-close aria-label="Close map">&times;</button>
            </div>
        </header>
        <div class="neoterra-map-body">
            <div class="neoterra-map-canvas" data-neoterra-map-canvas aria-label="Neo Terra city map"></div>
            <aside class="neoterra-map-side" data-neoterra-map-side>
                <p class="neoterra-placeholder">Loading map data…</p>
            </aside>
        </div>
        <span class="neoterra-map-resize" data-neoterra-map-resize aria-hidden="true"></span>
    </div>`;
}

function layerLabel(layer) {
    if (layer === 'keyLocations') return 'Key locations';
    if (layer === 'namedLocations') return 'Named locations';
    return layer[0].toUpperCase() + layer.slice(1);
}

/** The fallback image cannot mask districts: disable the fog control. */
function syncFogControl(state) {
    const input = state.root?.querySelector?.('[data-neoterra-map-toggle="fog"]');
    if (!input) {
        return;
    }
    const disabled = state.generated !== true;
    input.disabled = disabled;
    const label = input.closest?.('label');
    if (label) {
        label.title = disabled
            ? 'Fog of war needs the generated map; the single-image fallback cannot mask districts.'
            : '';
    }
    if (disabled) {
        state.toggles.fog = false;
        input.checked = false;
        state.fogOverride = false;
    }
}

/**
 * The panel is positioned inside `.neoterra-map-host`, so every clamp (initial
 * placement, drag, and resize) must use the host's box. Clamping to the window
 * while placing inside the host is what let the panel be dragged out of the
 * shell and clipped.
 */
function viewportSize(element) {
    const host = element?.parentElement;
    const rect = host?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return {
        width: (typeof window !== 'undefined' && window.innerWidth) || 1920,
        height: (typeof window !== 'undefined' && window.innerHeight) || 1080,
    };
}

/** Clamp the current geometry to the panel's host (shared by drag and resize). */
function clampToHost(state) {
    if (!hasDom()) {
        return state.geometry;
    }
    const element = state.root?.querySelector?.('[data-neoterra-map]');
    state.geometry = clampPanelGeometry(state.geometry, viewportSize(element));
    return state.geometry;
}

function applyGeometry(state) {
    if (!hasDom()) {
        return;
    }
    const element = state.root.querySelector('[data-neoterra-map]');
    if (!element) {
        return;
    }
    clampToHost(state);
    element.style.left = `${state.geometry.x}px`;
    element.style.top = `${state.geometry.y}px`;
    element.style.width = `${state.geometry.width}px`;
    element.style.height = `${state.geometry.height}px`;
}

function persistGeometry(state) {
    const element = state.root.querySelector('[data-neoterra-map]');
    clampToHost(state);
    savePanelGeometry(state.storage, state.geometry);
}

function selectFeature(state, selection) {
    if (!selection) {
        state.submenu = null;
        state.editor = null;
        state.editorError = null;
        state.cityMap?.setSelection?.(null);
        state.flow.send('CLEAR');
        return;
    }
    const worldState = readState(state);
    state.submenu = buildMapSubmenu(selection, state.viewModel, { state: worldState });
    state.editor = state.settings?.editorEnabled === false
        ? null
        : buildEditorSchema(state.submenu?.feature, {
            factions: Object.values(worldState?.factions ?? {}),
            districts: state.sources?.districts?.districts ?? [],
            virtual: state.submenu?.feature?.chatOnly === true,
        });
    state.editorError = null;
    state.cityMap?.setSelection?.(selection);
    // `location.SELECT` is an internal self-transition, so the machine does not
    // fire `onChange`; repaint here or the side panel keeps the first feature.
    state.flow.send('SELECT', selection);
    paintSide();
}

async function openTravel(state) {
    if (!state.submenu?.selection) {
        return false;
    }
    // Rebuild against live state first: combat may have started since the
    // feature was selected, and travel must be blocked the moment it does.
    const liveState = readState(state);
    state.submenu = buildMapSubmenu(state.submenu.selection, state.viewModel, { state: liveState });
    paintSide();
    const submenu = state.submenu;
    if (!submenu?.travel?.enabled) {
        return false;
    }
    const travel = {
        from: liveState?.scene?.locationId ?? null,
        to: submenu.travel.locationId,
        featureId: submenu.selection?.id ?? null,
        connections: submenu.travel.connections ?? [],
        combat: Boolean(liveState?.scene?.combat || liveState?.meta?.inCombat),
    };
    state.flow.send('OPEN_TRAVEL', travel);
    state.flow.context.travel = travel;
    let handled = false;
    try {
        if (typeof state.onTravel === 'function') {
            handled = Boolean(await state.onTravel(travel));
        }
    } catch (error) {
        logger.warn('Travel request failed', error);
    }
    // Without a travel flow (Step 14) the panel returns to the location view
    // instead of parking in an unreachable state.
    if (!handled && mounted === state && state.flow?.state === 'travel') {
        state.flow.send('CANCEL_TRAVEL');
    }
    return handled;
}

/* ------------------------------------------------------------------ *
 * Editor + per-chat overrides
 * ------------------------------------------------------------------ */

function collectEditorValues(state) {
    const values = {};
    for (const input of state.root?.querySelectorAll?.('[data-neoterra-editor-field]') ?? []) {
        values[input.dataset.neoterraEditorField] = input.value;
    }
    return values;
}

function persistWorldState(state, next) {
    if (state.store && typeof state.store.replace === 'function') {
        state.store.replace(next);
        return true;
    }
    const metadata = state.ctx?.chatMetadata;
    if (!metadata) {
        return false;
    }
    const slot = metadata.neoterra ?? {};
    metadata.neoterra = {
        ...slot,
        worldState: next,
        savedAt: Date.now(),
    };
    state.ctx?.saveMetadataDebounced?.();
    return true;
}

function readStoredGlobalOverrides(storage) {
    if (!storage) {
        return null;
    }
    try {
        const raw = storage.getItem(OVERRIDES_KEY);
        return raw ? parseMapOverrides(raw).document : null;
    } catch (error) {
        logger.warn('Could not read stored map overrides', error);
        return null;
    }
}

function writeStoredGlobalOverrides(storage, document) {
    if (!storage) {
        return false;
    }
    try {
        storage.setItem(OVERRIDES_KEY, exportMapOverrides(document));
        return true;
    } catch (error) {
        logger.warn('Could not persist map overrides', error);
        return false;
    }
}

function rebuildAfterMapChange(state, worldState) {
    state.sources = {
        ...(state.sources ?? {}),
        overrides: state.globalOverrides ?? state.sources?.overrides ?? null,
    };
    state.viewModel = buildPanelViewModel(state.sources, worldState, state.settings ?? {});
    state.overlay = buildWorldOverlay({
        state: worldState,
        season: state.season ?? null,
        viewModel: state.viewModel,
        settings: state.settings ?? {},
    });
    if (state.submenu?.selection) {
        state.submenu = buildMapSubmenu(state.submenu.selection, state.viewModel, { state: worldState });
        state.editor = state.settings?.editorEnabled === false
            ? null
            : buildEditorSchema(state.submenu?.feature, {
                factions: Object.values(worldState?.factions ?? {}),
                districts: state.sources?.districts?.districts ?? [],
                virtual: state.submenu?.feature?.chatOnly === true,
            });
    }
    refreshMapLayers(state);
    paintSide();
    if (typeof state.onMapStateChange === 'function') {
        try {
            state.onMapStateChange({ state: worldState, viewModel: state.viewModel, overlay: state.overlay });
        } catch (error) {
            logger.warn('Map state listener failed', error);
        }
    }
}

function refreshMapLayers(state) {
    const cityMap = state.cityMap;
    if (!cityMap || !state.viewModel) {
        return;
    }
    for (const style of state.overlay?.regionStyles ?? []) {
        const layer = cityMap.layersById?.get?.(style.id);
        if (layer?.setStyle) {
            layer.setStyle({
                color: style.color,
                fillColor: style.color,
                fillOpacity: style.fillOpacity,
                weight: style.weight,
                dashArray: style.dashArray,
            });
        }
    }
    for (const style of state.overlay?.bridgeStyles ?? []) {
        const layer = cityMap.layersById?.get?.(style.id);
        if (layer?.setStyle) {
            const visual = BRIDGE_VISUALS[style.status] ?? BRIDGE_VISUALS.open;
            layer.setStyle({ color: visual.color, weight: visual.weight, dashArray: visual.dashArray });
        }
    }
    // Fog wins over faction/status tint: hidden and rumoured features must not
    // be repainted by the overlay pass.
    cityMap.applyFog?.(state.viewModel, {
        fogEnabled: state.settings?.showFogOfWar === true,
    });
}

const BRIDGE_VISUALS = Object.freeze({
    open: { color: '#5eead4', dashArray: null, weight: 3 },
    contested: { color: '#fbbf24', dashArray: '6 4', weight: 3 },
    blocked: { color: '#fb7185', dashArray: '2 6', weight: 3 },
    destroyed: { color: '#64748b', dashArray: '1 8', weight: 2 },
});

function editorScope(state) {
    const radio = state.root?.querySelector?.('[data-neoterra-editor-scope]:checked');
    return radio?.value === 'global' ? 'global' : 'chat';
}

function persistChatEditorPatch(state, schema, values, scope) {
    const validation = validateEditorPatch(schema, values);
    if (!validation.ok) {
        state.editorError = validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ');
        paintSide();
        return false;
    }
    const worldState = readState(state);
    const chatLayer = schema.chatLayer ?? 'namedLocations';
    const chatKey = schema.chatKey ?? schema.key;
    let next = worldState;
    try {
        // Timeline facts are per chat for every feature kind: a destroyed
        // bridge or captured district changes this world only.
        const chatPatch = {};
        for (const field of ['status', 'x', 'y', 'name', 'description', 'factionId', 'connections']) {
            if (Object.hasOwn(validation.patch, field)) {
                chatPatch[field] = validation.patch[field];
            }
        }
        if (Object.keys(chatPatch).length > 0) {
            next = setChatMapOverride(next, { layer: chatLayer, key: chatKey, patch: chatPatch });
        }

        if (chatLayer === 'namedLocations' && next.locations?.[chatKey]) {
            const isVirtual = next.locations[chatKey].tags?.includes?.('virtual-node');
            if (isVirtual && Object.hasOwn(chatPatch, 'connections')) {
                next = updateChatVirtualNode(next, chatKey, {
                    connections: chatPatch.connections,
                });
            }
            next = structuredClone(next);
            const location = next.locations[chatKey];
            if (Object.hasOwn(chatPatch, 'status')) {
                location.status = chatPatch.status;
            }
            if (Object.hasOwn(chatPatch, 'factionId')) {
                location.factionId = chatPatch.factionId;
            }
        }
    } catch (error) {
        state.editorError = error?.message ?? String(error);
        paintSide();
        return false;
    }
    if (!persistWorldState(state, next)) {
        state.editorError = 'No chat world is available to store this override.';
        paintSide();
        return false;
    }
    state.editorError = null;
    rebuildAfterMapChange(state, next);
    return true;
}

function handleEditorSave(state) {
    const schema = state.editor;
    if (!schema) {
        return;
    }
    const values = collectEditorValues(state);
    const scope = schema.scope === 'chat' ? 'chat' : editorScope(state);
    if (scope === 'chat') {
        persistChatEditorPatch(state, schema, values, scope);
        return;
    }

    const base = state.globalOverrides ?? state.sources?.overrides ?? null;
    const applied = applyEditorPatch(base, schema, values);
    if (!applied.ok) {
        state.editorError = applied.errors.map((error) => `${error.field}: ${error.message}`).join('; ');
        paintSide();
        return;
    }
    if (!writeStoredGlobalOverrides(state.storage, applied.document)) {
        state.editorError = 'Could not store the override. Copy the exported JSON instead.';
        paintSide();
        return;
    }
    state.globalOverrides = applied.document;
    state.editorError = null;
    rebuildAfterMapChange(state, readState(state));
}

function handleEditorReset(state) {
    const schema = state.editor;
    if (!schema) {
        return;
    }
    const scope = schema.scope === 'chat' ? 'chat' : editorScope(state);
    if (scope === 'chat') {
        const worldState = readState(state);
        const chatLayer = schema.chatLayer ?? 'namedLocations';
        const chatKey = schema.chatKey ?? schema.key;
        let next;
        try {
            next = removeChatMapOverride(worldState, { layer: chatLayer, key: chatKey });
            // Named locations also carry live status/control; restore the
            // authored default so a reset is a real reset.
            if (chatLayer === 'namedLocations' && next.locations?.[chatKey]) {
                const authored = (state.sources?.locations?.locations ?? [])
                    .find((entry) => entry.id === chatKey) ?? null;
                next = structuredClone(next);
                next.locations[chatKey].status = authored?.defaultStatus ?? 'unknown';
                next.locations[chatKey].factionId = authored?.factionId ?? null;
            }
        } catch (error) {
            state.editorError = error?.message ?? String(error);
            paintSide();
            return;
        }
        if (!persistWorldState(state, next)) {
            state.editorError = 'No chat world is available.';
            paintSide();
            return;
        }
        state.editorError = null;
        rebuildAfterMapChange(state, next);
        return;
    }
    const base = state.globalOverrides ?? state.sources?.overrides ?? null;
    const result = resetEditorOverride(base, schema);
    if (!result.ok) {
        state.editorError = result.error ?? 'Could not reset this override.';
        paintSide();
        return;
    }
    writeStoredGlobalOverrides(state.storage, result.document);
    state.globalOverrides = result.document;
    state.editorError = null;
    rebuildAfterMapChange(state, readState(state));
}

function handleEditorDelete(state) {
    const schema = state.editor;
    if (!schema) {
        return;
    }
    const scope = schema.scope === 'chat' ? 'chat' : editorScope(state);
    if (scope === 'chat') {
        const worldState = readState(state);
        const chatLayer = schema.chatLayer ?? 'namedLocations';
        const chatKey = schema.chatKey ?? schema.key;
        let next;
        try {
            if (chatLayer === 'namedLocations' && worldState.locations?.[chatKey]?.tags?.includes?.('virtual-node')) {
                // A chat-only node is deleted entirely, not just un-overridden.
                next = removeChatVirtualNode(worldState, chatKey);
            } else {
                next = removeChatMapOverride(worldState, { layer: chatLayer, key: chatKey });
            }
        } catch (error) {
            state.editorError = error?.message ?? String(error);
            paintSide();
            return;
        }
        if (persistWorldState(state, next)) {
            state.editorError = null;
            state.submenu = null;
            state.editor = null;
            rebuildAfterMapChange(state, next);
        }
        return;
    }
    const base = state.globalOverrides ?? state.sources?.overrides ?? null;
    const result = deleteEditorOverride(base, schema);
    if (!result.ok) {
        state.editorError = result.error ?? 'Could not delete this override.';
        paintSide();
        return;
    }
    writeStoredGlobalOverrides(state.storage, result.document);
    state.globalOverrides = result.document;
    state.editorError = null;
    rebuildAfterMapChange(state, readState(state));
}

function handleEditorExport(state) {
    const overridesDocument = state.globalOverrides ?? state.sources?.overrides ?? null;
    if (!overridesDocument) {
        return null;
    }
    const text = exportMapOverrides(overridesDocument);
    if (typeof document === 'undefined' || typeof Blob === 'undefined') {
        return text;
    }
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.download = 'neoterra-map-overrides.json';
        anchor.click?.();
        URL.revokeObjectURL(url);
    } catch (error) {
        logger.warn('Could not download the overrides file', error);
    }
    return text;
}

async function handleEditorImport(state, file) {
    try {
        const text = typeof file?.text === 'function' ? await file.text() : String(file ?? '');
        const parsed = parseMapOverrides(text);
        if (!parsed.ok) {
            state.editorError = parsed.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
            paintSide();
            return;
        }
        writeStoredGlobalOverrides(state.storage, parsed.document);
        state.globalOverrides = parsed.document;
        state.editorError = null;
        rebuildAfterMapChange(state, readState(state));
    } catch (error) {
        state.editorError = error?.message ?? String(error);
        paintSide();
    }
}

function handleChatMapReset(state) {
    const worldState = readState(state);
    let next;
    try {
        next = resetChatMapOverrides(worldState);
    } catch (error) {
        state.editorError = error?.message ?? String(error);
        paintSide();
        return;
    }
    if (!persistWorldState(state, next)) {
        state.editorError = 'No chat world is available.';
        paintSide();
        return;
    }
    state.submenu = null;
    state.editor = null;
    state.editorError = null;
    rebuildAfterMapChange(state, next);
}

function selectedRegionId(state, worldState) {
    const feature = state.submenu?.feature ?? null;
    if (!feature) {
        return null;
    }
    if (feature.kind === 'region') {
        return feature.id;
    }
    if (typeof feature.regionId === 'string' && feature.regionId.length > 0) {
        return feature.regionId;
    }
    if (feature.kind === 'bridge' && Array.isArray(feature.connects)) {
        return feature.connects.find((id) => typeof id === 'string') ?? null;
    }
    if (feature.kind === 'namedLocation') {
        const live = worldState?.locations?.[feature.id] ?? null;
        return typeof live?.regionId === 'string' ? live.regionId : null;
    }
    return null;
}

function applyExplorationEvent(state, event) {
    if (!state.store || typeof state.store.dispatch !== 'function') {
        state.editorError = 'This chat has no world state to store fog edits.';
        paintSide();
        return false;
    }
    try {
        state.store.dispatch(event);
    } catch (error) {
        state.editorError = error?.message ?? String(error);
        paintSide();
        return false;
    }
    state.editorError = null;
    rebuildAfterMapChange(state, readState(state));
    return true;
}

function handleExplorationReveal(state) {
    const worldState = readState(state);
    const regionId = selectedRegionId(state, worldState);
    if (!regionId) {
        state.editorError = 'Select a district, location, or bridge with a known district first.';
        paintSide();
        return;
    }
    applyExplorationEvent(state, {
        type: 'REVEAL_REGION',
        regionId,
        source: 'editor',
    });
}

function handleExplorationReset(state) {
    const worldState = readState(state);
    // Reset restores the seed, which is anchored on the season's start
    // location, not wherever the player currently is.
    const startLocationId = state.season?.startLocationId
        ?? worldState?.scene?.locationId
        ?? null;
    const startRegion = startLocationId
        ? (state.viewModel?.index?.namedLocationById?.get?.(startLocationId)?.regionId ?? null)
        : null;
    applyExplorationEvent(state, {
        type: 'RESET_EXPLORATION',
        regionIds: startRegion ? [startRegion] : [],
        source: 'editor',
    });
}

function handleAddVirtualNode(state) {
    const values = {};
    for (const input of state.root?.querySelectorAll?.('[data-neoterra-node-field]') ?? []) {
        values[input.dataset.neoterraNodeField] = input.value;
    }
    const worldState = readState(state);
    let next;
    try {
        const connections = String(values.connections ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        const x = Number(values.x);
        const y = Number(values.y);
        if (String(values.x ?? '').trim() === '' || String(values.y ?? '').trim() === ''
            || !Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('A virtual node requires numeric X and Y coordinates.');
        }
        next = addChatVirtualNode(worldState, {
            name: values.name,
            x,
            y,
            connections,
        });
    } catch (error) {
        state.editorError = error?.message ?? String(error);
        paintSide();
        return;
    }
    if (!persistWorldState(state, next)) {
        state.editorError = 'No chat world is available.';
        paintSide();
        return;
    }
    state.editorError = null;
    rebuildAfterMapChange(state, next);
}

/* ------------------------------------------------------------------ *
 * Pacing director card
 * ------------------------------------------------------------------ */

async function handlePacingCut(state) {
    if (!state.pacing) {
        return;
    }
    state.pacingError = null;
    let result;
    try {
        // No reason: the framing is authored by the flow, not an internal id.
        result = await state.pacing.cutScene({ reason: null });
    } catch (error) {
        logger.warn('Pacing cut failed', error);
        result = { ok: false, message: error?.message ?? String(error) };
    }
    if (result?.ok !== true) {
        state.pacingError = result?.message ?? 'The cut was refused.';
    } else {
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'pacing-cut', turn: result.turn ?? null });
    }
    refreshMapPanel();
}

function handlePacingSnooze(state) {
    if (!state.pacing) {
        return;
    }
    const result = state.pacing.snooze();
    if (result?.ok !== true) {
        state.pacingError = 'Could not snooze the director.';
    } else {
        state.pacingError = null;
    }
    refreshMapPanel();
}

async function handlePacingRelease(state) {
    if (!state.pacing) {
        return;
    }
    let result;
    try {
        result = await state.pacing.releaseTime({ reason: 'director-card' });
    } catch (error) {
        logger.warn('Releasing time failed', error);
        result = { ok: false };
    }
    if (result?.ok !== true) {
        state.pacingError = 'Could not release time.';
    } else {
        state.pacingError = null;
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'clock-release' });
    }
    refreshMapPanel();
}

export {
    handlePacingCut,
    handlePacingSnooze,
    handlePacingRelease,
};

function openNewspaperReader(state) {
    if (state.newspaperReader) {
        state.newspaperReader.refresh();
        return state.newspaperReader;
    }
    const reader = mountNewspaperReader({
        getState: () => readState(state),
        getSettings: () => state.settings ?? {},
        onClose: () => {
            state.newspaperReader = null;
        },
    });
    if (reader) {
        state.newspaperReader = reader;
    }
    return reader;
}

/** Close the reader from the shell teardown path. */
export function disposeNewspaperReader() {
    const state = mounted;
    if (!state) {
        return;
    }
    state.newspaperReader?.dispose?.();
    state.newspaperReader = null;
}

function readState(state) {
    if (state.store && typeof state.store.get === 'function') {
        return state.store.get();
    }
    return loadWorldStateFromMetadata(state.ctx?.chatMetadata ?? null);
}

function paintSide() {
    const state = mounted;
    if (!state?.root?.isConnected) {
        return;
    }
    const side = state.root.querySelector('[data-neoterra-map-side]');
    if (!side) {
        return;
    }
    if (state.loading) {
        side.innerHTML = '<p class="neoterra-placeholder">Loading map data…</p>';
        return;
    }
    const error = state.error
        ? `<p class="neoterra-error" role="alert">${escapeHtml(state.error)}</p>
           <p class="neoterra-placeholder">Showing the single-image fallback with named-location markers.</p>`
        : '';
    const counts = state.viewModel
        ? `<footer class="neoterra-map-counts">
                <span>${state.viewModel.counts.regions} districts</span>
                <span>${state.viewModel.counts.bridges} bridges</span>
                <span>${state.viewModel.counts.keyLocations} key locations</span>
           </footer>`
        : '';
    const worldState = readState(state);
    const overlayEnabled = state.settings?.showOverlay !== false;
    const director = overlayEnabled && worldState
        ? buildDirectorCard(worldState, state.settings ?? {})
        : null;
    if (!director?.visible) {
        state.pacingError = null;
    }
    const newspaper = overlayEnabled && worldState
        ? {
            ...buildNewspaperView(worldState, state.settings ?? {}),
            showHeadlines: state.settings?.showHeadlines !== false,
        }
        : null;
    const overlay = overlayEnabled && state.viewModel
        ? renderWorldOverlayMarkup(
            state.overlay ?? buildWorldOverlay({
                state: worldState,
                season: state.season ?? null,
                viewModel: state.viewModel,
                settings: state.settings ?? {},
            }),
            { collapsed: state.overlayCollapsed === true, director, newspaper },
        )
        : '';
    const editorEnabled = state.settings?.editorEnabled !== false;
    const editor = editorEnabled && state.editor
        ? `${state.editorError ? `<p class="neoterra-error" role="alert">${escapeHtml(state.editorError)}</p>` : ''}
           ${renderMapEditor(state.editor, {
                globalOverrides: state.globalOverrides,
                chat: getChatMapOverrides(worldState),
            })}`
        : '';
    const addNode = editorEnabled ? renderVirtualNodeForm() : '';
    const intro = state.lastIntro?.text
        ? `<section class="neoterra-map-intro" data-neoterra-map-intro>
                <header>
                    <h5>Arrival</h5>
                    <button type="button" class="neoterra-icon-button" data-neoterra-intro-dismiss
                        aria-label="Dismiss arrival">&times;</button>
                </header>
                <p>${escapeHtml(state.lastIntro.text).replaceAll('\n', '<br>')}</p>
           </section>`
        : '';
    const threats = Array.isArray(state.overlay?.threats) ? state.overlay.threats : [];
    const activeThreat = threats.find((threat) => threat.status === 'active' && threat.rank === 'main')
        ?? threats.find((threat) => threat.status === 'active')
        ?? null;
    const threatBadge = activeThreat
        ? `<div class="neoterra-map-threat" data-neoterra-map-threat>
                <span class="neoterra-map-threat-name">${escapeHtml(activeThreat.name)}</span>
                ${activeThreat.stageLabel
                    ? `<span class="neoterra-overlay-chip is-stage">${escapeHtml(activeThreat.stageLabel)}</span>`
                    : ''}
                <span class="neoterra-map-threat-progress">${Number.isFinite(activeThreat.progress) ? activeThreat.progress : 0}%</span>
           </div>`
        : '';
    side.innerHTML = `${error}${threatBadge}${intro}${state.pacingError ? `<p class="neoterra-error" role="alert">${escapeHtml(state.pacingError)}</p>` : ''}${overlay}${renderSubmenuMarkup(state.submenu)}${editor}${addNode}${counts}`;
}

async function loadAndMount(state) {
    try {
        const sources = await state.loadSources({ fetchImpl: globalThis.fetch });
        if (mounted !== state) {
            return;
        }
        state.sources = sources;
        // Global edits made in this browser layer over the shipped file; the
        // export button produces the file to commit.
        state.globalOverrides = readStoredGlobalOverrides(state.storage) ?? sources.overrides ?? null;
        if (state.globalOverrides && state.globalOverrides !== sources.overrides) {
            state.sources = { ...sources, overrides: state.globalOverrides };
        }
        state.generated = Boolean(sources.generated);
        if (!state.generated) {
            // The single-image fallback cannot mask districts: fog must be off
            // before the view model is built, not after the first paint.
            state.toggles.fog = false;
            state.fogOverride = false;
            if (state.settings && typeof state.settings === 'object') {
                state.settings.showFogOfWar = false;
            }
            saveLayerVisibility(state.storage, state.toggles);
        }
        state.viewModel = buildPanelViewModel(state.sources, readState(state), state.settings ?? {});
        state.overlay = buildWorldOverlay({
            state: readState(state),
            season: state.season ?? null,
            viewModel: state.viewModel,
            settings: state.settings ?? {},
        });
        state.loading = false;
        syncFogControl(state);
        paintSide();

        const container = state.root.querySelector('[data-neoterra-map-canvas]');
        if (!container || !state.viewModel) {
            return;
        }
        const mount = state.generated ? mountCityMap : mountFallbackMap;
        const cityMap = await mount({
            container,
            viewModel: state.viewModel,
            visibility: state.toggles,
            leaflet: state.leaflet,
            onSelect: (selection) => selectFeature(state, selection),
        });
        if (mounted !== state) {
            cityMap?.destroy?.();
            return;
        }
        state.cityMap = cityMap;
        if (state.generated && !state.cityMap) {
            state.error = 'The map renderer is unavailable.';
            paintSide();
        }
        mountDragResize(state);
    } catch (error) {
        if (mounted !== state) {
            return;
        }
        logger.warn('Could not load the city map', error);
        state.loading = false;
        state.error = error?.message ?? String(error);
        state.generated = false;
        syncFogControl(state);
        paintSide();
    }
}

function mountDragResize(state) {
    if (!hasDom()) {
        return;
    }
    const element = state.root.querySelector('[data-neoterra-map]');
    const dragHandle = state.root.querySelector('[data-neoterra-map-drag]');
    const resizeHandle = state.root.querySelector('[data-neoterra-map-resize]');
    if (!element || !dragHandle || !resizeHandle) {
        return;
    }
    const signal = state.controller.signal;

    dragHandle.addEventListener('pointerdown', (event) => {
        if (event.target.closest?.('button, input, label')) {
            return;
        }
        const start = { x: event.clientX, y: event.clientY, left: state.geometry.x, top: state.geometry.y };
        dragHandle.setPointerCapture?.(event.pointerId);
        const move = (moveEvent) => {
            state.geometry = {
                ...state.geometry,
                x: start.left + (moveEvent.clientX - start.x),
                y: start.top + (moveEvent.clientY - start.y),
            };
            // Same host-aware clamp as the initial placement, never the window.
            clampToHost(state);
            applyGeometry(state);
        };
        const end = () => {
            dragHandle.releasePointerCapture?.(event.pointerId);
            persistGeometry(state);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
        };
        window.addEventListener('pointermove', move, { signal });
        window.addEventListener('pointerup', end, { signal, once: true });
    }, { signal });

    resizeHandle.addEventListener('pointerdown', (event) => {
        const start = { x: event.clientX, y: event.clientY, width: state.geometry.width, height: state.geometry.height };
        resizeHandle.setPointerCapture?.(event.pointerId);
        const move = (moveEvent) => {
            state.geometry = {
                ...state.geometry,
                width: start.width + (moveEvent.clientX - start.x),
                height: start.height + (moveEvent.clientY - start.y),
            };
            clampToHost(state);
            applyGeometry(state);
        };
        const end = () => {
            resizeHandle.releasePointerCapture?.(event.pointerId);
            persistGeometry(state);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
        };
        window.addEventListener('pointermove', move, { signal });
        window.addEventListener('pointerup', end, { signal, once: true });
    }, { signal });
}

/**
 * Rebuild the view model from the latest `WorldState` without reloading static
 * data. Safe to call on every state change.
 */
export function refreshMapPanel() {
    const state = mounted;
    if (!state?.sources || !state.viewModel) {
        return null;
    }
    // Settings can change mid-chat (including the content gate); re-read them so
    // a repaint never renders with stale gating or visibility.
    if (typeof state.getSettings === 'function') {
        try {
            const next = state.getSettings();
            if (next && typeof next === 'object') {
                state.settings = {
                    ...next,
                    // A fog toggle in this panel is a live per-user override; the
                    // settings getter would otherwise reset it on every refresh.
                    showFogOfWar: state.fogOverride === true,
                };
            }
        } catch {
            // A settings read failure keeps the last known map settings.
        }
    }
    const worldState = readState(state);
    state.viewModel = buildPanelViewModel(state.sources, worldState, state.settings ?? {});
    state.overlay = buildWorldOverlay({
        state: worldState,
        season: state.season ?? null,
        viewModel: state.viewModel,
        settings: state.settings ?? {},
    });
    refreshMapLayers(state);
    if (state.submenu?.selection) {
        state.submenu = buildMapSubmenu(state.submenu.selection, state.viewModel, { state: worldState });
    }
    paintSide();
    // Leaflet computes its size at mount; when the tab was hidden it needs a
    // nudge after becoming visible.
    state.cityMap?.map?.invalidateSize?.();
    return state.viewModel;
}

export function disposeMapPanel() {
    if (!mounted) {
        return;
    }
    const state = mounted;
    mounted = null;
    state.controller?.abort();
    state.newspaperReader?.dispose?.();
    state.newspaperReader = null;
    state.cityMap?.destroy?.();
    if (state.root?.isConnected) {
        state.root.innerHTML = '';
    }
}

/** Force the next mount to re-read the generated build. */
export function resetMapDataCaches() {
    clearGeneratedMapCaches();
}

export { buildMapFeatureIndex };
