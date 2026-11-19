/**
 * Internal event bus.
 *
 * Feature modules talk to each other through this bus instead of importing UI
 * modules directly.
 */

export const EVENTS = Object.freeze({
    SHELL_OPENED: 'shell:opened',
    SHELL_CLOSED: 'shell:closed',
    TAB_CHANGED: 'shell:tab-changed',
    SETTINGS_CHANGED: 'settings:changed',
    MAP_UPDATED: 'map:updated',
    JOURNAL_OPENED: 'journal:opened',
    WINDOW_OPENED: 'window:opened',
    TURN_STAGE: 'turn:stage',
    TOAST: 'ui:toast',
});

export function createEventBus() {
    const listeners = new Map();

    function on(type, handler) {
        if (typeof handler !== 'function') {
            return () => {};
        }
        if (!listeners.has(type)) {
            listeners.set(type, new Set());
        }
        listeners.get(type).add(handler);
        return () => off(type, handler);
    }

    function off(type, handler) {
        listeners.get(type)?.delete(handler);
    }

    function emit(type, payload) {
        const handlers = listeners.get(type);
        if (!handlers) {
            return 0;
        }
        let count = 0;
        for (const handler of [...handlers]) {
            try {
                handler(payload);
                count += 1;
            } catch (error) {
                console.warn(`[Neo Terra] Event handler failed for ${type}`, error);
            }
        }
        return count;
    }

    function clear() {
        listeners.clear();
    }

    return { on, off, emit, clear };
}

export const bus = createEventBus();
