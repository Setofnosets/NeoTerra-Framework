/**
 * Top-bar world-clock chip.
 *
 * The model is pure and Node-safe. Mounting is the only DOM work, so tests can
 * import this module without a browser.
 */

import {
    clockEnabled,
    getHoldReason,
    isClockHeld,
} from '../core/world-clock.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object|null} state WorldState
 * @param {object|null} settings extension settings
 * @returns {{
 *   visible: boolean,
 *   enabled: boolean,
 *   held: boolean,
 *   reason: string|null,
 *   dateLabel: string,
 *   timeLabel: string,
 *   label: string,
 *   title: string,
 *   tone: 'held'|'frozen'|'normal',
 * }}
 */
export function buildClockChipModel(state, settings) {
    const visible = isObject(state);
    const enabled = clockEnabled(settings);
    const held = isClockHeld(state);
    const reason = getHoldReason(state);
    const date = state?.meta?.inGameDate;
    const time = state?.meta?.timeOfDay;
    const dateLabel = typeof date === 'string' && date.length > 0 ? date : 'Day';
    const timeLabel = typeof time === 'string' && time.length > 0 ? time : 'evening';
    const label = `${dateLabel} · ${timeLabel}${held ? ' · time frozen' : ''}`;
    const title = held
        ? `Time is frozen${reason ? ` (${reason})` : ''}. Click to release.`
        : 'Click to freeze in-game time.';
    return {
        visible,
        enabled,
        held,
        reason,
        dateLabel,
        timeLabel,
        label,
        title,
        tone: held ? (enabled ? 'frozen' : 'held') : 'normal',
    };
}

/**
 * Mount a single-button time brake into `host`.
 *
 * @param {{
 *   host: HTMLElement,
 *   getState?: () => object|null,
 *   getSettings?: () => object|null,
 *   onToggle?: (context: { held: boolean }) => void,
 * }} options
 * @returns {{ refresh: () => object|null, dispose: () => void }}
 */
export function mountClockChip({ host, getState, getSettings, onToggle } = {}) {
    if (!host || typeof document === 'undefined') {
        return { refresh: () => null, dispose: () => {} };
    }

    let button = host.querySelector?.('.neoterra-clock-chip') ?? null;
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'neoterra-clock-chip';
        host.append(button);
    }

    let model = null;

    function read(key) {
        try {
            return key === 'state'
                ? (typeof getState === 'function' ? getState() : null)
                : (typeof getSettings === 'function' ? getSettings() : null);
        } catch {
            return null;
        }
    }

    function refresh() {
        model = buildClockChipModel(read('state'), read('settings'));
        button.hidden = !model.visible;
        button.textContent = model.label;
        button.title = model.title;
        button.setAttribute('aria-pressed', model.held ? 'true' : 'false');
        button.setAttribute('aria-label', model.title);
        button.dataset.clockHeld = model.held ? 'true' : 'false';
        button.dataset.tone = model.tone;
        return model;
    }

    function onClick() {
        if (typeof onToggle === 'function') {
            onToggle({ held: model?.held === true });
        }
    }

    button.addEventListener('click', onClick);
    refresh();

    return {
        refresh,
        dispose() {
            button.removeEventListener('click', onClick);
            button.remove?.();
            button = null;
            model = null;
        },
    };
}
