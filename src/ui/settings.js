/**
 * Neo Terra settings panel.
 *
 * Mounted inside SillyTavern's extension settings drawer. The panel is a thin
 * view over `src/core/settings.js`; every control writes one dotted path.
 */

import { UI_IDS } from '../core/constants.js';
import {
    DEFAULT_BAD_END_EPILOGUE_PROMPT,
    DEFAULT_BAD_END_PROMPT,
} from '../core/defaults.js';
import { bus, EVENTS } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { getSettings, resetSettings, saveSettings, setByPath } from '../core/settings.js';

const logger = createLogger('settings-ui');

/** Default values restored by the per-prompt reset buttons. */
export const PROMPT_RESET_DEFAULTS = Object.freeze({
    'badEnds.prompt': DEFAULT_BAD_END_PROMPT,
    'badEnds.epiloguePrompt': DEFAULT_BAD_END_EPILOGUE_PROMPT,
});

export function defaultPromptFor(path) {
    return Object.hasOwn(PROMPT_RESET_DEFAULTS, path)
        ? PROMPT_RESET_DEFAULTS[path]
        : null;
}

let panelAbort = null;
let mountedCtx = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function readValue(input) {
    if (input.type === 'checkbox') {
        return input.checked;
    }
    if (input.type === 'number' || input.dataset.neoterraType === 'number') {
        const value = Number(input.value);
        return Number.isFinite(value) ? value : 0;
    }
    return input.value;
}

function writeValue(input, value) {
    if (input.type === 'checkbox') {
        input.checked = Boolean(value);
    } else if (value !== undefined && value !== null) {
        input.value = String(value);
    }
}

/** Paint every `[data-neoterra-path]` control from current settings. */
export function paintSettingsPanel(ctx, root = document) {
    const settings = getSettings(ctx);
    for (const input of root.querySelectorAll('[data-neoterra-path]')) {
        const path = input.dataset.neoterraPath;
        const parts = path.split('.');
        let value = settings;
        for (const part of parts) {
            value = value?.[part];
        }
        writeValue(input, value);
    }
    return settings;
}

function syncDependentFields(root, settings) {
    for (const element of root.querySelectorAll('[data-neoterra-requires]')) {
        const path = element.dataset.neoterraRequires;
        let value = settings;
        for (const part of path.split('.')) {
            value = value?.[part];
        }
        element.classList.toggle('neoterra-disabled', !value);
        for (const control of element.querySelectorAll('input, select, textarea, button')) {
            control.disabled = !value;
        }
    }
}

function onChange(ctx, root, event) {
    const input = event.target.closest?.('[data-neoterra-path]');
    if (!input || !root.contains(input)) {
        return;
    }
    const settings = getSettings(ctx);
    setByPath(settings, input.dataset.neoterraPath, readValue(input));
    const saved = saveSettings(ctx, settings);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, saved);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path: input.dataset.neoterraPath, settings: saved });
}

function onReset(ctx, root) {
    const confirmed = typeof window.confirm === 'function'
        ? window.confirm('Reset all Neo Terra settings to their defaults? This does not reset any chat world.')
        : false;
    if (!confirmed) {
        return;
    }
    const settings = resetSettings(ctx);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, settings);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path: '*', settings });
    logger.info('Settings reset to defaults');
}

function onResetPrompt(ctx, root, path) {
    const value = defaultPromptFor(path);
    if (value === null) {
        return;
    }
    const settings = getSettings(ctx);
    setByPath(settings, path, value);
    const saved = saveSettings(ctx, settings);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, saved);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path, settings: saved });
}

/**
 * Fetch and mount the settings panel into SillyTavern's extension settings.
 * Safe to call on every initialize; duplicate mounts are ignored.
 */
export async function mountSettingsPanel(ctx, { signal: externalSignal } = {}) {
    if (!hasDom() || !ctx) {
        return null;
    }
    const existing = document.getElementById(UI_IDS.SETTINGS_PANEL);
    if (existing) {
        mountedCtx = ctx;
        paintSettingsPanel(ctx, existing);
        return existing;
    }

    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        logger.warn('SillyTavern extension settings host not found; settings panel not mounted');
        return null;
    }

    let html = '';
    try {
        const response = await fetch(new URL('./settings.html', import.meta.url));
        html = await response.text();
    } catch (error) {
        logger.warn('Could not load settings panel template', error);
        return null;
    }

    // The extension may have been disabled while the template was loading.
    if (externalSignal?.aborted) {
        return null;
    }

    host.insertAdjacentHTML('beforeend', html);
    const root = document.getElementById(UI_IDS.SETTINGS_PANEL);
    if (!root) {
        return null;
    }

    mountedCtx = ctx;
    panelAbort?.abort();
    panelAbort = new AbortController();
    const { signal } = panelAbort;

    root.addEventListener('change', event => onChange(ctx, root, event), { signal });
    root.addEventListener('click', event => {
        const promptButton = event.target.closest?.('[data-neoterra-reset-prompt]');
        if (promptButton) {
            onResetPrompt(ctx, root, promptButton.dataset.neoterraResetPrompt);
            return;
        }
        if (event.target.closest?.('[data-neoterra-reset]')) {
            onReset(ctx, root);
        }
    }, { signal });

    paintSettingsPanel(ctx, root);
    syncDependentFields(root, getSettings(ctx));
    return root;
}

/** Remove the settings panel and its listeners. */
export function disposeSettingsPanel() {
    panelAbort?.abort();
    panelAbort = null;
    mountedCtx = null;
    if (!hasDom()) {
        return;
    }
    document.getElementById(UI_IDS.SETTINGS_PANEL)?.remove();
}

/** Re-paint the panel if mounted (used after external settings changes). */
export function refreshSettingsPanel() {
    if (!hasDom() || !mountedCtx) {
        return;
    }
    const root = document.getElementById(UI_IDS.SETTINGS_PANEL);
    if (root) {
        const settings = paintSettingsPanel(mountedCtx, root);
        syncDependentFields(root, settings);
    }
}
