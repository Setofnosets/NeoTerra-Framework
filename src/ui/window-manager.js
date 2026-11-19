/**
 * Floating window layer.
 *
 * Gameplay surfaces (Map, Codex, Relations, Journal) live in draggable and
 * resizable windows over the chat instead of inside the modal shell. The chat
 * stays scrollable and the send form stays usable: the layer is a sibling of
 * the shell and only its windows take pointer events.
 *
 * Geometry persistence is per chat and per window. On mobile the same windows
 * become full-screen sheets; their stored desktop geometry is kept untouched.
 */

import { createLogger } from '../core/logger.js';

const logger = createLogger('windows');

export const WINDOW_MIN_WIDTH = 360;
export const WINDOW_MIN_HEIGHT = 240;
export const WINDOW_MARGIN = 8;
export const WINDOW_SHEET_BREAKPOINT = 720;
export const WINDOW_LAYER_ID = 'neoterra-window-layer';

function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    if (max < min) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

function viewportOf(viewport = {}) {
    return {
        width: Number(viewport?.width) > 0 ? Number(viewport.width) : 1280,
        height: Number(viewport?.height) > 0 ? Number(viewport.height) : 800,
    };
}

/**
 * Clamp a window rectangle into the viewport. A window restored from a larger
 * screen is pulled inside instead of being lost off-canvas.
 */
export function clampWindowGeometry(geometry = {}, viewport = {}, options = {}) {
    const size = viewportOf(viewport);
    const margin = Number.isFinite(options.margin) ? options.margin : WINDOW_MARGIN;
    const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : WINDOW_MIN_WIDTH;
    const minHeight = Number.isFinite(options.minHeight) ? options.minHeight : WINDOW_MIN_HEIGHT;
    const availableWidth = Math.max(120, size.width - margin * 2);
    const availableHeight = Math.max(120, size.height - margin * 2);
    const width = clamp(Number(geometry.width) || 720, Math.min(minWidth, availableWidth), availableWidth);
    const height = clamp(Number(geometry.height) || 480, Math.min(minHeight, availableHeight), availableHeight);
    const x = clamp(Number(geometry.x) || margin, margin, Math.max(margin, size.width - width - margin));
    const y = clamp(Number(geometry.y) || margin, margin, Math.max(margin, size.height - height - margin));
    return { x, y, width, height };
}

/** Merge saved geometry over defaults, then clamp to the live viewport. */
export function restoreWindowGeometry(saved = null, viewport = {}, defaults = {}) {
    return clampWindowGeometry({ ...defaults, ...(saved ?? {}) }, viewport, defaults.options ?? {});
}

/**
 * Move `id` to the top of the focus stack. A new window is appended; focusing
 * an open one only reorders, so there is never a duplicate.
 */
export function nextStack(stack = [], id = null) {
    const list = Array.isArray(stack) ? stack.filter((entry) => entry !== id) : [];
    if (!id) {
        return list;
    }
    list.push(id);
    return list;
}

/** Geometry frame index (top window last) mapped to a stable z-index. */
export function windowZIndex(index = 0) {
    return 3600 + Math.max(0, Number(index) || 0);
}

export function isSheetViewport(viewport = {}) {
    const width = Number(viewport?.width) > 0 ? Number(viewport.width) : (typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1280);
    return width <= WINDOW_SHEET_BREAKPOINT;
}

export function windowMarkup({
    id,
    title = 'Window',
    minimized = false,
    active = false,
    geometry = {},
    zIndex = windowZIndex(0),
}) {
    return `
    <section class="neoterra-window" id="neoterra-window-${id}" data-neoterra-window="${id}"
        data-active="${active ? 'true' : 'false'}" data-minimized="${minimized ? 'true' : 'false'}"
        role="dialog" aria-modal="false" aria-label="${escapeHtml(title)}"
        style="left:${geometry.x ?? WINDOW_MARGIN}px;top:${geometry.y ?? WINDOW_MARGIN}px;width:${geometry.width ?? 720}px;height:${geometry.height ?? 480}px;z-index:${zIndex}">
        <header class="neoterra-window-bar" data-neoterra-window-drag>
            <h3 class="neoterra-window-title">${escapeHtml(title)}</h3>
            <div class="neoterra-window-controls">
                <button type="button" class="neoterra-icon-button" data-neoterra-window-minimize
                    aria-label="Minimize ${escapeHtml(title)}" title="Minimize">
                    <i class="fa-solid fa-minus" aria-hidden="true"></i>
                </button>
                <button type="button" class="neoterra-icon-button" data-neoterra-window-close
                    aria-label="Close ${escapeHtml(title)}" title="Close">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
        </header>
        <div class="neoterra-window-body" data-neoterra-window-body></div>
        <span class="neoterra-window-resize" data-neoterra-window-resize aria-hidden="true"></span>
    </section>`;
}

function escapeHtml(value) {
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

function safeStorage(storage) {
    if (storage !== undefined) {
        return storage;
    }
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/**
 * Create (or return) the window manager. Without a DOM this returns null; all
 * shell callers fall back to the tabbed modal.
 */
export function createWindowManager({
    getScope = () => 'global',
    storage = undefined,
    getViewport = () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
} = {}) {
    if (!hasDom()) {
        return null;
    }
    const store = safeStorage(storage);
    let layer = document.getElementById(WINDOW_LAYER_ID);
    if (!layer) {
        layer = document.createElement('div');
        layer.id = WINDOW_LAYER_ID;
        layer.className = 'neoterra-window-layer';
        document.body.append(layer);
    }
    const windows = new Map();
    let order = [];
    let disposed = false;

    const scopeKey = (id) => `neoterra.window.${getScope?.() ?? 'global'}.${id}`;

    const readGeometry = (id, defaults) => {
        let saved = null;
        try {
            const raw = store?.getItem?.(scopeKey(id));
            saved = raw ? JSON.parse(raw) : null;
        } catch (error) {
            logger.debug('Could not read saved window geometry', error);
        }
        return restoreWindowGeometry(saved, getViewport(), defaults);
    };

    const writeGeometry = (id, geometry) => {
        try {
            store?.setItem?.(scopeKey(id), JSON.stringify(geometry));
        } catch (error) {
            logger.debug('Could not save window geometry', error);
        }
    };

    const applySheet = () => {
        const sheet = isSheetViewport(getViewport());
        layer.dataset.layout = sheet ? 'sheet' : 'window';
        for (const entry of windows.values()) {
            entry.element.dataset.layout = sheet ? 'sheet' : 'window';
        }
    };

    const paintStack = () => {
        order.forEach((id, index) => {
            const entry = windows.get(id);
            if (!entry) {
                return;
            }
            const top = index === order.length - 1;
            entry.element.dataset.active = top ? 'true' : 'false';
            entry.element.style.zIndex = String(windowZIndex(index));
        });
        layer.dataset.count = String(order.length);
    };

    const focus = (id) => {
        if (!windows.has(id)) {
            return false;
        }
        order = nextStack(order, id);
        paintStack();
        return true;
    };

    const place = (entry) => {
        if (isSheetViewport(getViewport())) {
            return;
        }
        const geometry = clampWindowGeometry(entry.geometry, getViewport());
        entry.geometry = geometry;
        entry.element.style.left = `${geometry.x}px`;
        entry.element.style.top = `${geometry.y}px`;
        entry.element.style.width = `${geometry.width}px`;
        entry.element.style.height = `${geometry.height}px`;
    };

    const attachDrag = (entry) => {
        const bar = entry.element.querySelector('[data-neoterra-window-drag]');
        const handle = entry.element.querySelector('[data-neoterra-window-resize]');
        if (!bar || !handle) {
            return;
        }
        bar.addEventListener('pointerdown', (event) => {
            if (event.target.closest?.('button')) {
                return;
            }
            if (isSheetViewport(getViewport())) {
                return;
            }
            const start = { x: event.clientX, y: event.clientY, left: entry.geometry.x, top: entry.geometry.y };
            bar.setPointerCapture?.(event.pointerId);
            const move = (moveEvent) => {
                entry.geometry = clampWindowGeometry({
                    ...entry.geometry,
                    x: start.left + (moveEvent.clientX - start.x),
                    y: start.top + (moveEvent.clientY - start.y),
                }, getViewport());
                place(entry);
            };
            const end = () => {
                bar.releasePointerCapture?.(event.pointerId);
                writeGeometry(entry.id, entry.geometry);
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                window.removeEventListener('pointercancel', end);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end, { once: true });
            window.addEventListener('pointercancel', end, { once: true });
        });

        handle.addEventListener('pointerdown', (event) => {
            if (isSheetViewport(getViewport())) {
                return;
            }
            const start = { x: event.clientX, y: event.clientY, width: entry.geometry.width, height: entry.geometry.height };
            handle.setPointerCapture?.(event.pointerId);
            const move = (moveEvent) => {
                entry.geometry = clampWindowGeometry({
                    ...entry.geometry,
                    width: start.width + (moveEvent.clientX - start.x),
                    height: start.height + (moveEvent.clientY - start.y),
                }, getViewport());
                place(entry);
            };
            const end = () => {
                handle.releasePointerCapture?.(event.pointerId);
                writeGeometry(entry.id, entry.geometry);
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                window.removeEventListener('pointercancel', end);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end, { once: true });
            window.addEventListener('pointercancel', end, { once: true });
        });
    };

    const close = (id, { silent = false } = {}) => {
        const entry = windows.get(id);
        if (!entry) {
            return false;
        }
        windows.delete(id);
        order = order.filter((entryId) => entryId !== id);
        try {
            entry.mountResult?.dispose?.();
        } catch (error) {
            logger.debug('Window cleanup failed', error);
        }
        entry.element?.remove?.();
        paintStack();
        if (!silent) {
            try {
                entry.onClose?.();
            } catch (error) {
                logger.debug('Window onClose failed', error);
            }
        }
        return true;
    };

    const open = ({ id, title = 'Window', mount = null, initial = {}, onClose = null } = {}) => {
        if (disposed || !id) {
            return null;
        }
        const existing = windows.get(id);
        if (existing) {
            focus(id);
            return existing.handle;
        }
        const geometry = readGeometry(id, initial);
        const entry = {
            id,
            title,
            geometry,
            onClose,
            element: null,
            mountResult: null,
            handle: null,
        };
        const wrapper = document.createElement('div');
        wrapper.innerHTML = windowMarkup({
            id,
            title,
            geometry,
            zIndex: windowZIndex(order.length),
        });
        const element = wrapper.firstElementChild;
        layer.append(element);
        entry.element = element;
        windows.set(id, entry);
        order = nextStack(order, id);
        paintStack();
        applySheet();
        place(entry);
        attachDrag(entry);

        element.addEventListener('pointerdown', () => focus(id), { capture: true });
        element.addEventListener('click', (event) => {
            if (event.target.closest?.('[data-neoterra-window-close]')) {
                close(id);
                return;
            }
            if (event.target.closest?.('[data-neoterra-window-minimize]')) {
                const minimized = element.dataset.minimized === 'true';
                element.dataset.minimized = minimized ? 'false' : 'true';
                focus(id);
            }
        });

        const body = element.querySelector('[data-neoterra-window-body]');
        entry.handle = {
            id,
            element,
            body,
            focus: () => focus(id),
            close: () => close(id),
            refresh: () => {
                try {
                    entry.mountResult?.refresh?.();
                } catch (error) {
                    logger.debug('Window refresh failed', error);
                }
            },
            getGeometry: () => ({ ...entry.geometry }),
        };
        if (typeof mount === 'function') {
            try {
                const result = mount(body);
                if (result && typeof result.then === 'function') {
                    result.then((mountedResult) => {
                        if (windows.get(id) === entry) {
                            entry.mountResult = mountedResult ?? null;
                        } else {
                            // The window closed while its mount was loading;
                            // nobody else owns the controller, so release it.
                            mountedResult?.dispose?.();
                        }
                    }).catch((error) => {
                        logger.warn('Could not mount a window', error);
                        body.innerHTML = '<p class="neoterra-error" role="alert">This window could not be mounted.</p>';
                    });
                } else {
                    entry.mountResult = result ?? null;
                }
            } catch (error) {
                logger.warn('Could not mount a window', error);
                body.innerHTML = '<p class="neoterra-error" role="alert">This window could not be mounted.</p>';
            }
        }
        return entry.handle;
    };

    const closeTop = () => {
        const top = order[order.length - 1];
        return top ? close(top) : false;
    };

    const onKeydown = (event) => {
        if (event.key !== 'Escape' || order.length === 0) {
            return;
        }
        event.stopPropagation();
        closeTop();
    };
    document.addEventListener('keydown', onKeydown);

    const onResize = () => {
        applySheet();
        for (const entry of windows.values()) {
            place(entry);
        }
    };
    window.addEventListener('resize', onResize);

    applySheet();

    return {
        layer,
        open,
        close,
        focus,
        closeTop,
        isOpen: (id) => windows.has(id),
        list: () => [...order],
        get: (id) => windows.get(id)?.handle ?? null,
        refresh: (id) => windows.get(id)?.handle?.refresh?.(),
        dispose: () => {
            disposed = true;
            for (const id of [...order]) {
                close(id, { silent: true });
            }
            document.removeEventListener('keydown', onKeydown);
            window.removeEventListener('resize', onResize);
            layer?.remove?.();
            layer = null;
        },
    };
}
