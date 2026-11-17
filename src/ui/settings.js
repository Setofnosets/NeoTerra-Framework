/**
 * Neo Terra settings panel.
 *
 * Mounted inside SillyTavern's extension settings drawer. The panel is a thin
 * view over `src/core/settings.js`; every control writes one dotted path.
 */

import { AGENT_IDS, UI_IDS } from '../core/constants.js';
import {
    DEFAULT_BAD_END_EPILOGUE_PROMPT,
    DEFAULT_BAD_END_PROMPT,
    DEFAULT_SETTINGS,
} from '../core/defaults.js';
import { DEFAULT_AGENT_PROMPTS } from '../agents/prompts.js';
import { loadRegistry } from '../data/registry.js';
import { bus, EVENTS } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { getSettings, resetSettings, saveSettings, setByPath } from '../core/settings.js';

const logger = createLogger('settings-ui');

export const AGENT_LABELS = Object.freeze({
    architect: 'Architect',
    storyline: 'Storyline tracker',
    stateTracker: 'Player state tracker',
    castDirector: 'Cast director',
    lore: 'Lore agent',
    auditor: 'Continuity auditor',
    epilogue: 'Epilogue writer',
    choices: 'Choices agent',
    badEnd: 'Bad-end detector',
});

/** Default values restored by the per-prompt reset buttons. */
export const PROMPT_RESET_DEFAULTS = Object.freeze({
    'badEnds.prompt': DEFAULT_BAD_END_PROMPT,
    'badEnds.epiloguePrompt': DEFAULT_BAD_END_EPILOGUE_PROMPT,
    ...Object.fromEntries(AGENT_IDS.map((id) => [`agents.${id}.prompt`, DEFAULT_AGENT_PROMPTS[id]])),
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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function limitOptions(selected) {
    const options = [
        ['', 'Inherit global gate'],
        ['full', 'Full (no reduction)'],
        ['reduced', 'Reduced'],
        ['mature-only', 'Mature only'],
        ['strict', 'Strict'],
    ];
    return options.map(([value, label]) => (
        `<option value="${value}" ${String(selected ?? '') === value ? 'selected' : ''}>${label}</option>`
    )).join('');
}

/** Markup for one agent's routing/prompt/cadence row. Exported for tests. */
export function buildAgentConfigMarkup() {
    return AGENT_IDS.map((id) => {
        const defaults = DEFAULT_SETTINGS.agents[id] ?? {};
        const prompt = DEFAULT_AGENT_PROMPTS[id] ?? '';
        const cadenceExtra = Object.hasOwn(defaults, 'everyNTurns')
            ? `<label class="neoterra-field">
                    <span>Every N turns</span>
                    <input type="number" min="1" max="100" step="1" data-neoterra-path="agents.${id}.everyNTurns">
                </label>`
            : '';
        const locationExtra = Object.hasOwn(defaults, 'onLocationChange')
            ? `<label class="neoterra-check">
                    <input type="checkbox" data-neoterra-path="agents.${id}.onLocationChange">
                    <span>Run on location change</span>
                </label>`
            : '';
        return `<section class="neoterra-agent-row" data-neoterra-agent="${id}">
            <header class="neoterra-agent-head">
                <label class="neoterra-check">
                    <input type="checkbox" data-neoterra-path="agents.${id}.enabled">
                    <span><strong>${escapeHtml(AGENT_LABELS[id] ?? id)}</strong></span>
                </label>
                <button type="button" class="menu_button" data-neoterra-reset-prompt="agents.${id}.prompt">
                    Reset prompt
                </button>
            </header>
            <div class="neoterra-settings-grid">
                <label class="neoterra-field">
                    <span>Connection profile ID</span>
                    <input type="text" data-neoterra-path="agents.${id}.connectionProfileId"
                        placeholder="Main connection">
                </label>
                <label class="neoterra-field">
                    <span>Model override</span>
                    <input type="text" data-neoterra-path="agents.${id}.model" placeholder="Default model">
                </label>
                <label class="neoterra-field">
                    <span>Temperature</span>
                    <input type="number" min="0" max="2" step="0.05" data-neoterra-path="agents.${id}.temperature">
                </label>
                <label class="neoterra-field">
                    <span>Max tokens</span>
                    <input type="number" min="64" max="65536" step="64" data-neoterra-path="agents.${id}.maxTokens">
                </label>
                <label class="neoterra-field">
                    <span>Cadence</span>
                    <input type="text" data-neoterra-path="agents.${id}.cadence">
                </label>
                ${cadenceExtra}
                ${locationExtra}
            </div>
            <label class="neoterra-field neoterra-field-wide">
                <span>System prompt (blank = built-in)</span>
                <textarea rows="3" data-neoterra-path="agents.${id}.prompt"
                    placeholder="${escapeHtml(prompt)}"></textarea>
            </label>
        </section>`;
    }).join('');
}

/**
 * Markup for one character hard-limit select. Exported for tests.
 *
 * Character ids are dotted (e.g. `s1dark.carol.bleeding-heart`), so they cannot
 * travel through the generic dotted-path writer. The raw id lives in
 * `data-neoterra-limit-character` and is written directly to
 * `contentLimits.characters[id]`.
 */
export function buildCharacterLimitMarkup(entries, settings) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) {
        return '<p class="neoterra-hint">No current-season characters are available in this chat.</p>';
    }
    const limits = settings?.contentLimits?.characters ?? {};
    return list.map((entry) => `<label class="neoterra-field">
        <span>${escapeHtml(entry.displayName ?? entry.id)}</span>
        <select data-neoterra-limit-character="${escapeHtml(entry.id)}">
            ${limitOptions(limits[entry.id])}
        </select>
    </label>`).join('');
}

function ensureAgentConfig(root) {
    const host = root.querySelector('[data-neoterra-agent-config]');
    if (!host || host.dataset.built === 'true') {
        return;
    }
    host.innerHTML = buildAgentConfigMarkup();
    host.dataset.built = 'true';
}

export async function ensureCharacterLimits(ctx, root, signal = null) {
    const host = root.querySelector('[data-neoterra-character-limits]');
    if (!host) {
        return;
    }
    const metadata = ctx?.chatMetadata?.neoterra ?? null;
    const season = metadata?.seasonDefinition ?? null;
    const roster = Array.isArray(season?.roster) ? season.roster : [];
    const sandbox = season?.sandbox === true || season?.allowAnyCharacter === true;
    const builtKey = [
        metadata?.seasonId ?? season?.id ?? 'none',
        roster.map((member) => member.characterId).join(','),
        sandbox ? 'sandbox' : 'roster',
    ].join('|');
    if (host.dataset.builtKey === builtKey) {
        return;
    }
    if (!season) {
        host.innerHTML = '<p class="neoterra-hint">Start or load a chat world to list its cast.</p>';
        host.dataset.builtKey = builtKey;
        return;
    }
    let entries = Array.isArray(metadata?.registry?.entries)
        ? metadata.registry.entries
        : [];
    if (entries.length === 0 || sandbox) {
        try {
            const registry = await loadRegistry();
            if (signal?.aborted) {
                return;
            }
            entries = registry?.entries ?? [];
        } catch (error) {
            logger.debug('Could not load the registry for character limits', error);
            return;
        }
    }
    const wanted = new Set(roster.map((member) => member.characterId).filter(Boolean));
    const list = entries
        .filter((entry) => entry && entry.bundle !== true)
        .filter((entry) => sandbox || wanted.size === 0 || wanted.has(entry.id))
        .sort((a, b) => String(a.displayName ?? a.id).localeCompare(String(b.displayName ?? b.id)));
    if (signal?.aborted) {
        return;
    }
    host.innerHTML = buildCharacterLimitMarkup(list, getSettings(ctx));
    host.dataset.builtKey = builtKey;
    paintSettingsPanel(ctx, root);
}

function exportSettings(ctx) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return false;
    }
    const payload = JSON.stringify(getSettings(ctx), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'neoterra-settings.json';
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
}

async function importSettings(ctx, root, file) {
    if (!file) {
        return false;
    }
    let parsed = null;
    try {
        parsed = JSON.parse(await file.text());
    } catch (error) {
        logger.warn('Could not parse settings JSON', error);
        return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn('Imported settings JSON is not an object');
        return false;
    }
    const unknown = Object.keys(parsed).filter(
        (key) => !Object.hasOwn(DEFAULT_SETTINGS, key),
    );
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const warning = unknown.length > 0
            ? ` Unknown top-level keys will be preserved: ${unknown.join(', ')}.`
            : '';
        const confirmed = window.confirm(
            `Replace Neo Terra settings with the imported JSON?${warning}`,
        );
        if (!confirmed) {
            return false;
        }
    }
    saveSettings(ctx, parsed);
    ensureAgentConfig(root);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, getSettings(ctx));
    bus.emit(EVENTS.SETTINGS_CHANGED, { path: '*', settings: getSettings(ctx) });
    return true;
}

async function resetChatWorld(ctx, onResetWorld) {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const confirmed = window.confirm(
            "Reset this chat's Neo Terra world? The world state, season link, and generated world book for this chat are removed. Other chats and global settings are untouched.",
        );
        if (!confirmed) {
            return false;
        }
    }
    if (typeof onResetWorld === 'function') {
        return onResetWorld();
    }
    if (globalThis.NeoTerra?.resetWorld) {
        return globalThis.NeoTerra.resetWorld();
    }
    return false;
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
    for (const input of root.querySelectorAll('[data-neoterra-limit-character]')) {
        writeValue(input, settings.contentLimits?.characters?.[input.dataset.neoterraLimitCharacter] ?? '');
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
    const limitInput = event.target.closest?.('[data-neoterra-limit-character]');
    if (limitInput && root.contains(limitInput)) {
        const settings = getSettings(ctx);
        const characterId = limitInput.dataset.neoterraLimitCharacter;
        settings.contentLimits = settings.contentLimits ?? {};
        settings.contentLimits.characters = settings.contentLimits.characters ?? {};
        const value = readValue(limitInput);
        if (value) {
            settings.contentLimits.characters[characterId] = value;
        } else {
            delete settings.contentLimits.characters[characterId];
        }
        const saved = saveSettings(ctx, settings);
        paintSettingsPanel(ctx, root);
        syncDependentFields(root, saved);
        bus.emit(EVENTS.SETTINGS_CHANGED, {
            path: 'contentLimits.characters',
            characterId,
            settings: saved,
        });
        return;
    }
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
export async function mountSettingsPanel(ctx, {
    signal: externalSignal,
    onResetWorld = null,
} = {}) {
    if (!hasDom() || !ctx) {
        return null;
    }
    const existing = document.getElementById(UI_IDS.SETTINGS_PANEL);
    if (existing) {
        mountedCtx = ctx;
        ensureAgentConfig(existing);
        paintSettingsPanel(ctx, existing);
        void ensureCharacterLimits(ctx, existing, externalSignal);
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

    root.addEventListener('change', event => {
        if (event.target.matches?.('[data-neoterra-import-file]')) {
            void importSettings(ctx, root, event.target.files?.[0]);
            event.target.value = '';
            return;
        }
        onChange(ctx, root, event);
    }, { signal });
    root.addEventListener('click', event => {
        const promptButton = event.target.closest?.('[data-neoterra-reset-prompt]');
        if (promptButton) {
            onResetPrompt(ctx, root, promptButton.dataset.neoterraResetPrompt);
            return;
        }
        if (event.target.closest?.('[data-neoterra-export-settings]')) {
            exportSettings(ctx);
            return;
        }
        if (event.target.closest?.('[data-neoterra-import-settings]')) {
            root.querySelector('[data-neoterra-import-file]')?.click?.();
            return;
        }
        if (event.target.closest?.('[data-neoterra-reset-world]')) {
            void resetChatWorld(ctx, onResetWorld);
            return;
        }
        if (event.target.closest?.('[data-neoterra-reset]')) {
            onReset(ctx, root);
        }
    }, { signal });

    ensureAgentConfig(root);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, getSettings(ctx));
    void ensureCharacterLimits(ctx, root, signal);
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
        void ensureCharacterLimits(mountedCtx, root, panelAbort?.signal);
    }
}
