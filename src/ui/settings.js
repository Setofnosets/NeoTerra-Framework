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
    UI_PRESETS,
    applyUiPreset,
} from '../core/defaults.js';
import {
    applyAgentPreset,
    deleteAgentPreset,
    listAgentPresets,
    saveAgentPreset,
} from '../core/agent-presets.js';
import {
    AGENT_CADENCES,
    AGENT_CADENCE_EXTRAS,
    DEFAULT_AGENT_PROMPTS,
} from '../agents/prompts.js';
import { testAgentConnection } from '../agents/client.js';
import { loadRegistry } from '../data/registry.js';
import { bus, EVENTS } from '../core/events.js';
import { readLiveContext, resolveActiveChatId } from '../core/live-context.js';
import { createLogger } from '../core/logger.js';
import {
    getByPath,
    getSettings,
    resetSettings,
    saveSettings,
    setByPath,
} from '../core/settings.js';
import { downloadJson } from './download.js';
import { createWorldStateStore } from '../state/store.js';
import { migrateWorldState } from '../state/migrations.js';
import { cloneWorldState, validateWorldState } from '../state/world-state.js';
import { seasonWorldBookName } from '../flows/season-start.js';
import { directorCardStatus, downloadDirectorCard } from './director-card.js';
import {
    buildSyncedManifest,
    buildSyncOverrides,
    loadAvatarManifest,
    writeAvatarOverrides,
} from '../data/avatars.js';
import { initAvatars, refreshAvatarContext } from './avatar.js';

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
    newspaper: 'Newspaper editor',
    formArchitect: 'Form architect',
    characterCreator: 'Character creator',
    goalInference: 'Goal inference',
    sceneDescriber: 'Scene describer',
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
let activeTestAbort = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export const WORLD_BUNDLE_KIND = 'neoterra-world';
export const WORLD_BUNDLE_VERSION = 1;

export const CARD_IMPORT_SEASONS = Object.freeze({
    s1: 'S1',
    s1dark: 'S1Dark',
    s2: 'S2',
    s3: 'S3',
    s4: 'S4',
    others: 'Others',
});

/** Mirrors the registry slug in tools/build-data.mjs. */
export function slugifyCardName(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

function baseLabelFromFilename(filename) {
    const stem = String(filename ?? '').replace(/\.json$/i, '');
    const withoutForm = stem.replace(/\([^()]*\)\s*$/, '').replace(/\)+\s*$/, '');
    return withoutForm
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function seasonFolderForId(seasonId) {
    const key = String(seasonId ?? '');
    if (Object.hasOwn(CARD_IMPORT_SEASONS, key)) {
        return CARD_IMPORT_SEASONS[key];
    }
    return key ? key[0].toUpperCase() + key.slice(1) : '';
}

/**
 * Turn dropped character-card files into `data/characters/overrides.json`
 * entries. Nothing is written to disk: the caller downloads the merged
 * override file and re-runs `npm run build:data`.
 */
export function buildCardImportOverrides(cards, {
    seasonId,
    folder = null,
    existingOverrides = null,
    existingIds = [],
    overwrite = false,
} = {}) {
    const season = String(seasonId ?? '').trim();
    if (!season) {
        throw new Error('buildCardImportOverrides requires a season id');
    }
    if (!Array.isArray(cards)) {
        throw new Error('buildCardImportOverrides requires a cards array');
    }
    const seasonDir = folder || seasonFolderForId(season);
    const base = existingOverrides && typeof existingOverrides === 'object'
        ? {
            ...existingOverrides,
            entries: {
                ...(existingOverrides.entries && typeof existingOverrides.entries === 'object'
                    ? existingOverrides.entries
                    : {}),
            },
        }
        : { schemaVersion: 1, entries: {} };

    const report = { added: [], skipped: [], invalid: [] };
    const knownIds = new Set(
        Array.isArray(existingIds) ? existingIds.filter((id) => typeof id === 'string') : [],
    );
    for (const entry of Object.values(base.entries)) {
        if (typeof entry?.id === 'string') {
            knownIds.add(entry.id);
        }
    }

    for (const card of cards) {
        const rawName = card?.name ?? card?.file ?? '';
        const filename = String(rawName).split(/[\\/]/).pop() ?? '';
        if (!filename.toLowerCase().endsWith('.json')) {
            report.invalid.push({ file: String(rawName), reason: 'not a .json card file' });
            continue;
        }
        const data = card?.data && typeof card.data === 'object' ? card.data : card?.raw?.data;
        if (!data || typeof data !== 'object') {
            report.invalid.push({ file: filename, reason: 'card has no data{} payload' });
            continue;
        }
        if (typeof data.name !== 'string' || data.name.trim().length === 0) {
            report.invalid.push({ file: filename, reason: 'card data.name is missing' });
            continue;
        }

        const stem = filename.replace(/\.json$/i, '');
        const id = `${season}.${slugifyCardName(stem)}`;
        const displayName = baseLabelFromFilename(filename) || data.name.trim();
        const key = `Chars/${seasonDir}/${filename}`;

        if (Object.hasOwn(base.entries, key) && !overwrite) {
            report.skipped.push({ key, id, reason: 'override already exists' });
            continue;
        }
        if (knownIds.has(id)) {
            report.invalid.push({ file: filename, reason: `duplicate registry id "${id}"` });
            continue;
        }

        base.entries[key] = { id, displayName };
        knownIds.add(id);
        report.added.push({ key, id, displayName });
    }

    return { overrides: base, report };
}

/** Build a portable, chat-independent world bundle. */
export function buildWorldBundle(metadata, { now = Date.now() } = {}) {
    const root = metadata?.neoterra;
    if (!root?.worldState) {
        throw new Error('This chat has no Neo Terra world to export');
    }
    const state = migrateWorldState(cloneWorldState(root.worldState));
    const validation = validateWorldState(state);
    if (!validation.ok) {
        throw new Error(`Cannot export an invalid world: ${validation.errors[0]?.path}: ${validation.errors[0]?.message}`);
    }
    return {
        kind: WORLD_BUNDLE_KIND,
        schemaVersion: WORLD_BUNDLE_VERSION,
        exportedAt: new Date(now).toISOString(),
        seasonId: root.seasonId ?? state.seasonId ?? null,
        seasonDefinition: root.seasonDefinition ?? null,
        registry: root.registry ?? null,
        castMode: root.castMode ?? state.mode ?? 'director',
        playerIdentity: root.playerIdentity ?? null,
        worldBook: root.worldBook ?? null,
        worldState: state,
    };
}

function checkImportedSeasonShape(season, seasonId) {
    if (!season || typeof season !== 'object' || Array.isArray(season)) {
        throw new Error('World bundle seasonDefinition must be an object');
    }
    const requiredStrings = ['id', 'title', 'era', 'premise'];
    for (const field of requiredStrings) {
        if (typeof season[field] !== 'string' || season[field].trim().length === 0) {
            throw new Error(`Imported season definition is invalid: ${field} must be a non-empty string`);
        }
    }
    if (seasonId && season.id !== seasonId) {
        throw new Error(
            `World bundle season mismatch ("${String(season.id)}" vs "${String(seasonId)}")`,
        );
    }
    const playerRoles = ['hero', 'villain', 'neutral'];
    if (season.playerRole !== undefined && !playerRoles.includes(season.playerRole)) {
        throw new Error('Imported season definition is invalid: playerRole');
    }
    if (season.playable !== undefined && typeof season.playable !== 'boolean') {
        throw new Error('Imported season definition is invalid: playable must be a boolean');
    }
    for (const field of ['roster', 'factions', 'threats', 'canonBeats', 'openingBeats']) {
        if (season[field] !== undefined && !Array.isArray(season[field])) {
            throw new Error(`Imported season definition is invalid: ${field} must be an array`);
        }
    }
    for (const [index, member] of (season.roster ?? []).entries()) {
        if (!member || typeof member !== 'object'
            || typeof member.characterId !== 'string' || typeof member.formId !== 'string') {
            throw new Error(`Imported season definition is invalid: roster[${index}]`);
        }
    }
    for (const [index, faction] of (season.factions ?? []).entries()) {
        if (!faction || typeof faction !== 'object' || typeof faction.id !== 'string') {
            throw new Error(`Imported season definition is invalid: factions[${index}]`);
        }
    }
    for (const [index, threat] of (season.threats ?? []).entries()) {
        if (!threat || typeof threat !== 'object'
            || typeof threat.id !== 'string' || typeof threat.name !== 'string'
            || !Array.isArray(threat.stages)) {
            throw new Error(`Imported season definition is invalid: threats[${index}]`);
        }
    }
    for (const [index, beat] of (season.canonBeats ?? []).entries()) {
        if (!beat || typeof beat !== 'object'
            || typeof beat.id !== 'string' || typeof beat.act !== 'string') {
            throw new Error(`Imported season definition is invalid: canonBeats[${index}]`);
        }
    }
    if (typeof season.startLocationId !== 'string' || season.startLocationId.length === 0) {
        throw new Error('Imported season definition is invalid: startLocationId');
    }
    if (season.finalDeadline !== undefined
        && (typeof season.finalDeadline !== 'object' || season.finalDeadline === null)) {
        throw new Error('Imported season definition is invalid: finalDeadline must be an object');
    }
    return season;
}

/**
 * Validate an imported bundle and rebind its `chatId` to the target chat.
 * Returns a normalized bundle; throws on a wrong kind, future schema, or an
 * invalid WorldState.
 */
export function normalizeWorldBundle(parsed, { chatId = null } = {}) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('World import must be a JSON object');
    }
    if (parsed.kind !== WORLD_BUNDLE_KIND) {
        throw new Error(`Not a Neo Terra world bundle (kind="${String(parsed.kind)}")`);
    }
    const bundleVersion = Number(parsed.schemaVersion);
    if (!Number.isInteger(bundleVersion) || bundleVersion < 1) {
        throw new Error('World bundle needs an integer schemaVersion >= 1');
    }
    if (bundleVersion > WORLD_BUNDLE_VERSION) {
        throw new Error(`World bundle schema ${parsed.schemaVersion} is newer than this extension supports`);
    }
    let state = migrateWorldState(parsed.worldState);
    if (!state) {
        throw new Error('World bundle has no worldState document');
    }
    if (typeof chatId === 'string' && chatId.length > 0) {
        state = { ...state, chatId };
    }
    const validation = validateWorldState(state);
    if (!validation.ok) {
        const error = validation.errors[0];
        throw new Error(`Imported WorldState is invalid: ${error?.path}: ${error?.message}`);
    }

    const seasonId = parsed.seasonId ?? state.seasonId ?? null;
    const seasonDefinition = parsed.seasonDefinition ?? null;
    if (seasonDefinition !== null) {
        checkImportedSeasonShape(seasonDefinition, seasonId);
    }
    if (parsed.registry !== null && parsed.registry !== undefined) {
        if (!parsed.registry || typeof parsed.registry !== 'object' || !Array.isArray(parsed.registry.entries)) {
            throw new Error('World bundle registry must contain an entries array');
        }
        for (const [index, entry] of parsed.registry.entries.entries()) {
            if (!entry || typeof entry !== 'object'
                || typeof entry.id !== 'string' || typeof entry.seasonId !== 'string') {
                throw new Error(`World bundle registry.entries[${index}] is invalid`);
            }
        }
    }
    if (parsed.worldBook !== null && parsed.worldBook !== undefined) {
        if (!parsed.worldBook || typeof parsed.worldBook !== 'object'
            || typeof parsed.worldBook.name !== 'string'
            || parsed.worldBook.name.trim().length === 0) {
            throw new Error('World bundle worldBook must contain a name');
        }
    }
    if (parsed.playerIdentity !== null && parsed.playerIdentity !== undefined
        && (typeof parsed.playerIdentity !== 'object' || Array.isArray(parsed.playerIdentity))) {
        throw new Error('World bundle playerIdentity must be an object or null');
    }

    return {
        ...parsed,
        schemaVersion: WORLD_BUNDLE_VERSION,
        seasonId,
        castMode: parsed.castMode ?? state.mode ?? 'director',
        worldState: state,
    };
}

/** Write an imported bundle into `chatMetadata.neoterra` (no save side effect). */
export function writeWorldBundleToMetadata(metadata, bundle, { chatId = null, now = Date.now() } = {}) {
    if (!metadata || typeof metadata !== 'object') {
        throw new Error('writeWorldBundleToMetadata requires chat metadata');
    }
    const normalized = normalizeWorldBundle(bundle, { chatId });
    const existing = metadata.neoterra && typeof metadata.neoterra === 'object'
        ? metadata.neoterra
        : {};
    let worldBook = normalized.worldBook ?? existing.worldBook ?? null;
    if (normalized.seasonDefinition && typeof chatId === 'string' && chatId.length > 0) {
        worldBook = {
            ...(worldBook && typeof worldBook === 'object' ? worldBook : {}),
            name: seasonWorldBookName(normalized.seasonDefinition, chatId),
        };
    }
    metadata.neoterra = {
        ...existing,
        schemaVersion: 1,
        seasonId: normalized.seasonId ?? normalized.seasonDefinition?.id ?? null,
        seasonDefinition: normalized.seasonDefinition ?? existing.seasonDefinition ?? null,
        registry: normalized.registry ?? existing.registry ?? null,
        castMode: normalized.castMode ?? existing.castMode ?? 'director',
        playerIdentity: normalized.playerIdentity ?? existing.playerIdentity ?? null,
        worldBook,
        updatedAt: now,
        worldState: normalized.worldState,
        savedAt: now,
    };
    return metadata.neoterra;
}

function readValue(input) {
    if (input.type === 'checkbox') {
        return input.checked;
    }
    if (input.type === 'number' || input.dataset.neoterraType === 'number') {
        const value = Number(input.value);
        return Number.isFinite(value) ? value : 0;
    }
    if (input.dataset.neoterraType === 'boolean') {
        return input.value === 'true';
    }
    return input.value;
}

function writeValue(input, value) {
    if (input.type === 'checkbox') {
        input.checked = Boolean(value);
    } else if (input.dataset.neoterraType === 'boolean') {
        input.value = String(value === true);
    } else if (value !== undefined && value !== null) {
        const text = String(value);
        if (input.tagName === 'SELECT') {
            // Preserve a stored value the option list does not know (older
            // cadences, custom profile ids) instead of silently blanking it.
            const options = typeof input.options?.length === 'number' ? [...input.options] : [];
            if (!options.some((option) => option.value === text)) {
                const option = input.ownerDocument?.createElement?.('option');
                if (option) {
                    option.value = text;
                    option.textContent = text;
                    input.appendChild(option);
                }
            }
        }
        input.value = text;
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

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize `ConnectionManagerRequestService.getSupportedProfiles()` output:
 * drop entries without an id/api, drop disabled profiles, dedupe by id.
 */
export function normalizeConnectionProfiles(profiles) {
    const list = Array.isArray(profiles) ? profiles : [];
    const seen = new Set();
    const out = [];
    for (const profile of list) {
        if (!isRecord(profile)) {
            continue;
        }
        const id = typeof profile.id === 'string' ? profile.id.trim() : '';
        if (!id || seen.has(id) || profile.disabled === true || !profile.api) {
            continue;
        }
        seen.add(id);
        out.push({
            id,
            name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : id,
            model: typeof profile.model === 'string' ? profile.model.trim() : '',
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read the connection profiles available to the picker. Never throws: when the
 * Connection Manager is absent or disabled, callers get the fallback shape.
 */
export function readConnectionProfiles(ctx) {
    const service = ctx?.ConnectionManagerRequestService;
    if (typeof service?.getSupportedProfiles !== 'function') {
        return { available: false, profiles: [] };
    }
    try {
        return { available: true, profiles: normalizeConnectionProfiles(service.getSupportedProfiles()) };
    } catch (error) {
        logger.debug('Could not read connection profiles', error);
        return { available: false, profiles: [] };
    }
}

/** Read the picker state (profiles + current main model) from a live context. */
export function readAgentPickerContext(ctx) {
    const connection = readConnectionProfiles(ctx);
    let currentModel = '';
    try {
        if (typeof ctx?.getChatCompletionModel === 'function') {
            const value = ctx.getChatCompletionModel();
            currentModel = typeof value === 'string' ? value : '';
        }
    } catch {
        // The model getter is best-effort; the combobox still accepts free text.
    }
    return { ...connection, currentModel };
}

export const MAX_MODEL_SUGGESTIONS = 20;

/**
 * Merge model suggestions for the combobox: the current main model, every
 * stored agent model, every selected profile's model, and the models saved in
 * presets. Stable order, deduped, capped.
 */
export function buildModelSuggestions(settings, { profiles = [], currentModel = '', cap = MAX_MODEL_SUGGESTIONS } = {}) {
    const byId = new Map((Array.isArray(profiles) ? profiles : []).map((profile) => [profile.id, profile]));
    const values = [];
    const add = (value) => {
        const text = String(value ?? '').trim();
        if (text && !values.includes(text)) {
            values.push(text);
        }
    };
    add(currentModel);
    const addAgent = (agent) => {
        if (!isRecord(agent)) {
            return;
        }
        add(agent.model);
        const profile = byId.get(agent.connectionProfileId);
        if (profile?.model) {
            add(profile.model);
        }
    };
    for (const agent of Object.values(isRecord(settings?.agents) ? settings.agents : {})) {
        addAgent(agent);
    }
    for (const preset of Object.values(isRecord(settings?.agentPresets?.items) ? settings.agentPresets.items : {})) {
        for (const agent of Object.values(isRecord(preset?.agents) ? preset.agents : {})) {
            addAgent(agent);
        }
    }
    return values.slice(0, Math.max(1, cap));
}

/**
 * Options for one agent's connection-profile select. A stored id that is not
 * in the profile list is preserved as a selected "Custom id…" option.
 */
export function buildAgentProfileOptionsMarkup(profiles, storedValue = '') {
    const list = Array.isArray(profiles) ? profiles : [];
    const value = String(storedValue ?? '');
    const custom = value !== '' && !list.some((profile) => profile.id === value);
    const options = [
        `<option value="" ${value === '' ? 'selected' : ''}>Main connection</option>`,
    ];
    for (const profile of list) {
        const label = profile.model ? `${profile.name} (${profile.model})` : profile.name;
        options.push(
            `<option value="${escapeHtml(profile.id)}" ${profile.id === value ? 'selected' : ''}>${escapeHtml(label)}</option>`,
        );
    }
    options.push(
        `<option value="__custom__" ${custom ? 'selected' : ''}>Custom id…</option>`,
    );
    return options.join('');
}

/** Cadence options an agent actually honours (default first). */
export function cadenceOptionsForAgent(agentId) {
    const defaults = DEFAULT_SETTINGS.agents[agentId] ?? {};
    const values = [];
    const add = (value) => {
        if (typeof value === 'string' && value && AGENT_CADENCES.includes(value) && !values.includes(value)) {
            values.push(value);
        }
    };
    add(defaults.cadence);
    for (const value of AGENT_CADENCE_EXTRAS[agentId] ?? []) {
        add(value);
    }
    return values;
}

function buildCadenceOptionsMarkup(agentId) {
    return cadenceOptionsForAgent(agentId)
        .map((cadence) => `<option value="${cadence}">${cadence}</option>`)
        .join('');
}

/** Markup for one agent's routing/prompt/cadence row. Exported for tests. */
export function buildAgentConfigMarkup() {
    const rows = AGENT_IDS.map((id) => {
        const defaults = DEFAULT_SETTINGS.agents[id] ?? {};
        const prompt = DEFAULT_AGENT_PROMPTS[id] ?? '';
        const path = `agents.${id}.connectionProfileId`;
        const cadenceExtra = Object.hasOwn(defaults, 'everyNTurns')
            ? `<label class="neoterra-field">
                    <span>Every N turns</span>
                    <input type="number" min="1" max="100" step="1" data-neoterra-path="agents.${id}.everyNTurns"
                        title="1-100 turns, default ${escapeHtml(defaults.everyNTurns)}">
                </label>`
            : '';
        const locationExtra = Object.hasOwn(defaults, 'onLocationChange')
            ? `<label class="neoterra-check">
                    <input type="checkbox" data-neoterra-path="agents.${id}.onLocationChange">
                    <span>Run on location change</span>
                </label>`
            : '';
        const seasonStartExtra = Object.hasOwn(defaults, 'seasonStart')
            ? `<label class="neoterra-check">
                    <input type="checkbox" data-neoterra-path="agents.${id}.seasonStart">
                    <span>Run once at season start</span>
                </label>`
            : '';
        return `<section class="neoterra-agent-row" data-neoterra-agent="${id}">
            <header class="neoterra-agent-head">
                <label class="neoterra-check">
                    <input type="checkbox" data-neoterra-path="agents.${id}.enabled">
                    <span><strong>${escapeHtml(AGENT_LABELS[id] ?? id)}</strong></span>
                </label>
                <div class="neoterra-settings-actions">
                    <button type="button" class="menu_button" data-neoterra-test-agent="${id}">
                        Test connection
                    </button>
                    <button type="button" class="menu_button" data-neoterra-reset-prompt="agents.${id}.prompt">
                        Reset prompt
                    </button>
                </div>
            </header>
            <div class="neoterra-settings-grid">
                <label class="neoterra-field">
                    <span>Connection profile</span>
                    <select data-neoterra-profile-select="${path}">
                        <option value="">Main connection</option>
                        <option value="__custom__">Custom id…</option>
                    </select>
                </label>
                <label class="neoterra-field" data-neoterra-profile-custom="${path}" hidden>
                    <span>Custom profile id</span>
                    <input type="text" data-neoterra-path="${path}">
                </label>
                <p class="neoterra-hint" data-neoterra-profile-hint="${path}" hidden></p>
                <label class="neoterra-field">
                    <span>Model</span>
                    <input type="text" list="neoterra-model-options" data-neoterra-path="agents.${id}.model"
                        placeholder="Default model">
                </label>
                <div class="neoterra-settings-actions">
                    <button type="button" class="menu_button" data-neoterra-fetch-models="${id}">
                        Refresh model suggestions
                    </button>
                </div>
                <p class="neoterra-hint" data-neoterra-model-status="${id}" role="status"></p>
                <label class="neoterra-field">
                    <span>Temperature</span>
                    <input type="number" min="0" max="2" step="0.05" data-neoterra-path="agents.${id}.temperature"
                        title="0-2, default ${escapeHtml(defaults.temperature)}">
                </label>
                <label class="neoterra-field">
                    <span>Max tokens</span>
                    <input type="number" min="64" max="65536" step="64" data-neoterra-path="agents.${id}.maxTokens"
                        title="64-65536 tokens, default ${escapeHtml(defaults.maxTokens)}">
                </label>
                <label class="neoterra-field">
                    <span>Cadence</span>
                    <select data-neoterra-path="agents.${id}.cadence">
                        ${buildCadenceOptionsMarkup(id)}
                    </select>
                </label>
                ${cadenceExtra}
                ${locationExtra}
                ${seasonStartExtra}
            </div>
            <label class="neoterra-field neoterra-field-wide">
                <span>System prompt (blank = built-in)</span>
                <textarea rows="3" data-neoterra-path="agents.${id}.prompt"
                    placeholder="${escapeHtml(prompt)}"></textarea>
            </label>
            <p class="neoterra-hint" data-neoterra-test-status="${id}" role="status"></p>
        </section>`;
    }).join('');
    return `<datalist id="neoterra-model-options" data-neoterra-model-options></datalist>${rows}`;
}

let agentPickerState = { available: false, profiles: [], currentModel: '' };

/** Repaint the profile selects, custom-id inputs, and the shared model list. */
export function syncAgentPickers(root, settings, pickerState = agentPickerState) {
    const state = isRecord(pickerState) ? pickerState : { available: false, profiles: [], currentModel: '' };
    const profiles = Array.isArray(state.profiles) ? state.profiles : [];
    for (const select of root.querySelectorAll('[data-neoterra-profile-select]')) {
        const path = select.dataset.neoterraProfileSelect;
        const stored = String(getByPath(settings, path) ?? '');
        select.innerHTML = buildAgentProfileOptionsMarkup(profiles, stored);
        select.hidden = state.available === false;
        select.disabled = state.available === false;
        const customHost = root.querySelector(`[data-neoterra-profile-custom="${path}"]`);
        const isCustom = stored !== '' && !profiles.some((profile) => profile.id === stored);
        if (customHost) {
            customHost.hidden = state.available !== false && !isCustom;
        }
        const hint = root.querySelector(`[data-neoterra-profile-hint="${path}"]`);
        if (hint) {
            hint.hidden = state.available !== false;
            hint.textContent = state.available === false
                ? 'Connection Manager is not available; type the profile id manually.'
                : '';
        }
    }
    const datalist = root.querySelector('[data-neoterra-model-options]');
    if (datalist) {
        const suggestions = buildModelSuggestions(settings, {
            profiles,
            currentModel: state.currentModel,
        });
        datalist.innerHTML = suggestions
            .map((model) => `<option value="${escapeHtml(model)}"></option>`)
            .join('');
    }
}

/**
 * Options for the agent preset select. Value scheme:
 * `preset:<id>` = a saved snapshot of the `agents` block;
 * `ui:<id>` = one of the recommended whole-settings presets.
 * Exported for tests.
 */
export function buildAgentPresetOptionsMarkup(settings) {
    const presets = listAgentPresets(settings);
    const activeId = settings?.agentPresets?.activeId ?? '';
    const saved = presets.map((preset) => (
        `<option value="preset:${escapeHtml(preset.id)}" ${preset.id === activeId ? 'selected' : ''}>${escapeHtml(preset.name)}</option>`
    )).join('');
    const recommended = UI_PRESETS.map((preset) => (
        `<option value="ui:${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`
    )).join('');
    return [
        '<option value="">None</option>',
        saved ? `<optgroup label="Saved">${saved}</optgroup>` : '',
        `<optgroup label="Recommended">${recommended}</optgroup>`,
    ].join('');
}

function setPresetStatus(root, text) {
    const host = root.querySelector('[data-neoterra-preset-status]');
    if (host) {
        host.textContent = text;
    }
}

function readPresetSelection(root) {
    const select = root.querySelector('[data-neoterra-preset-select]');
    return String(select?.value ?? '');
}

function applyPresetSelection(ctx, root, value) {
    const settings = getSettings(ctx);
    if (!value) {
        // "None" means no saved preset is active; clearing the marker stops
        // the next repaint from re-selecting a stale preset.
        const cleared = saveSettings(ctx, {
            ...settings,
            agentPresets: { ...(settings.agentPresets ?? {}), activeId: '' },
        });
        setPresetStatus(root, 'Preset selection cleared.');
        paintSettingsPanel(ctx, root);
        syncDependentFields(root, cleared);
        bus.emit(EVENTS.SETTINGS_CHANGED, { path: 'agentPresets', settings: cleared });
        return cleared;
    }
    let saved = null;
    const changedPath = value.startsWith('ui:') ? '*' : 'agents';
    try {
        if (value.startsWith('ui:')) {
            const id = value.slice(3);
            const next = applyUiPreset(settings, id);
            // A whole-settings preset is not the snapshot the saved preset
            // marker refers to; clear it so Update cannot overwrite the latter.
            next.agentPresets = { ...(next.agentPresets ?? {}), activeId: '' };
            saved = saveSettings(ctx, next);
            const label = UI_PRESETS.find((preset) => preset.id === id)?.label ?? id;
            setPresetStatus(root, `Applied the recommended ${label} preset.`);
        } else if (value.startsWith('preset:')) {
            const id = value.slice(7);
            saved = saveSettings(ctx, applyAgentPreset(settings, id));
            const preset = listAgentPresets(saved).find((item) => item.id === id);
            const nameInput = root.querySelector('[data-neoterra-preset-name]');
            if (nameInput && preset) {
                nameInput.value = preset.name;
            }
            setPresetStatus(
                root,
                `Applied preset ${preset?.name ?? id} to ${Object.keys(saved.agents ?? {}).length} agents.`,
            );
        } else {
            setPresetStatus(root, 'Unknown preset selection.');
            return null;
        }
    } catch (error) {
        setPresetStatus(root, `Preset failed: ${error?.message ?? error}`);
        return null;
    }
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, saved);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path: changedPath, settings: saved });
    return saved;
}

function handlePresetAction(ctx, root, button) {
    const selection = readPresetSelection(root);
    const presetId = selection.startsWith('preset:') ? selection.slice(7) : null;
    const nameInput = root.querySelector('[data-neoterra-preset-name]');
    const typedName = String(nameInput?.value ?? '').trim();
    const settings = getSettings(ctx);
    let next = null;
    try {
        if (button.matches('[data-neoterra-preset-save]')) {
            // "Save as…" always creates a new preset; "Update" edits the
            // selected one in place.
            next = saveAgentPreset(settings, typedName);
            setPresetStatus(root, `Saved preset ${listAgentPresets(next).find((item) => item.id === next.agentPresets.activeId)?.name ?? typedName} with ${Object.keys(next.agents ?? {}).length} agents.`);
        } else if (button.matches('[data-neoterra-preset-update]')) {
            if (!presetId) {
                setPresetStatus(root, 'Select a saved preset before choosing Update.');
                return;
            }
            const existing = listAgentPresets(settings).find((item) => item.id === presetId);
            next = saveAgentPreset(settings, typedName || existing?.name || '', { id: presetId });
            setPresetStatus(root, `Updated preset ${existing?.name ?? presetId}.`);
        } else if (button.matches('[data-neoterra-preset-delete]')) {
            if (!presetId) {
                setPresetStatus(root, 'Select a saved preset before choosing Delete.');
                return;
            }
            const existing = listAgentPresets(settings).find((item) => item.id === presetId);
            next = deleteAgentPreset(settings, presetId);
            setPresetStatus(root, `Deleted preset ${existing?.name ?? presetId}.`);
        } else if (button.matches('[data-neoterra-preset-apply]')) {
            applyPresetSelection(ctx, root, selection);
            return;
        }
    } catch (error) {
        setPresetStatus(root, `${error?.message ?? error}`);
        return;
    }
    if (!next) {
        return;
    }
    const saved = saveSettings(ctx, next);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, saved);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path: 'agentPresets', settings: saved });
}

function handleProfileSelect(ctx, root, select) {
    const path = select.dataset.neoterraProfileSelect;
    if (String(select.value) === '__custom__') {
        const customHost = root.querySelector(`[data-neoterra-profile-custom="${path}"]`);
        const input = customHost?.querySelector?.('input') ?? null;
        // Never leave a stale profile id behind the "Custom id…" label: the
        // stored value becomes whatever the text input currently holds.
        const settings = getSettings(ctx);
        setByPath(settings, path, String(input?.value ?? '').trim());
        const saved = saveSettings(ctx, settings);
        if (customHost) {
            customHost.hidden = false;
        }
        if (!String(input?.value ?? '').trim()) {
            // Empty custom id === main connection until the user types one.
            select.value = '';
        }
        input?.focus?.();
        syncDependentFields(root, saved);
        bus.emit(EVENTS.SETTINGS_CHANGED, { path, settings: saved });
        return;
    }
    const settings = getSettings(ctx);
    setByPath(settings, path, String(select.value));
    const saved = saveSettings(ctx, settings);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, saved);
    bus.emit(EVENTS.SETTINGS_CHANGED, { path, settings: saved });
}

/**
 * Best-effort model list. SillyTavern exposes no stable cross-provider model
 * API, so this only fills the datalist from data we already have and tells the
 * user to type a model id otherwise. Never throws.
 */
function handleFetchModels(ctx, root, agentId) {
    const status = root.querySelector(`[data-neoterra-model-status="${agentId}"]`);
    const settings = getSettings(ctx);
    const storedId = String(settings.agents?.[agentId]?.connectionProfileId ?? '');
    const profiles = Array.isArray(agentPickerState.profiles) ? agentPickerState.profiles : [];
    const profile = profiles.find((item) => item.id === storedId);
    const models = [];
    const collect = (list) => {
        for (const value of Array.isArray(list) ? list : []) {
            if (typeof value === 'string' && value.trim() && !models.includes(value.trim())) {
                models.push(value.trim());
            }
        }
    };
    if (profile) {
        collect(profile.models);
        collect(profile.modelList);
    }
    if (models.length === 0 && agentPickerState.currentModel) {
        models.push(agentPickerState.currentModel);
    }
    const suggestions = buildModelSuggestions(settings, {
        profiles,
        currentModel: agentPickerState.currentModel,
    });
    collect(suggestions);
    const datalist = root.querySelector('[data-neoterra-model-options]');
    if (datalist) {
        datalist.innerHTML = models
            .slice(0, MAX_MODEL_SUGGESTIONS)
            .map((model) => `<option value="${escapeHtml(model)}"></option>`)
            .join('');
    }
    if (status) {
        status.textContent = models.length > 0
            ? `Refreshed ${models.length} model suggestion(s). Pick one or type a model id.`
            : 'No model list is available for this provider — type a model id.';
    }
}

function formatTestStatus(result) {
    if (!result?.ok) {
        return `Failed · ${result?.error ?? 'unknown error'}`;
    }
    const parts = ['OK', result.route ?? 'route'];
    if (result.profileName) {
        parts.push(result.profileName);
    }
    if (result.model) {
        parts.push(result.model);
    }
    parts.push(`${(Math.max(0, Number(result.latencyMs) || 0) / 1000).toFixed(1)} s`);
    return parts.join(' · ');
}

async function runAgentTest(ctx, root, agentId, { signal = null } = {}) {
    const button = root.querySelector(`[data-neoterra-test-agent="${agentId}"]`);
    const status = root.querySelector(`[data-neoterra-test-status="${agentId}"]`);
    const controller = signal ? null : new AbortController();
    if (controller) {
        activeTestAbort?.abort();
        activeTestAbort = controller;
    }
    const requestSignal = signal ?? controller.signal;
    const live = resolveWorldContext(ctx);
    const chatId = resolveActiveChatId(live);
    if (button) {
        button.disabled = true;
    }
    if (status) {
        status.textContent = 'Testing…';
    }
    try {
        const result = await testAgentConnection({
            ctx: live,
            settings: getSettings(live),
            agentId,
            timeoutMs: 20000,
            signal: requestSignal,
        });
        // A closed panel or a chat switch makes the result stale: drop it
        // instead of writing into a detached panel or the wrong chat.
        if (requestSignal.aborted || resolveActiveChatId(resolveWorldContext(ctx)) !== chatId) {
            return { ...result, ok: false, aborted: true, error: 'cancelled' };
        }
        if (status) {
            status.textContent = formatTestStatus(result);
        }
        return result;
    } finally {
        if (button) {
            button.disabled = false;
        }
        if (controller && activeTestAbort === controller) {
            activeTestAbort = null;
        }
    }
}

async function handleTestAllAgents(ctx, root) {
    const button = root.querySelector('[data-neoterra-test-all-agents]');
    const summary = root.querySelector('[data-neoterra-test-all-status]');
    if (button?.disabled) {
        return;
    }
    activeTestAbort?.abort();
    const controller = new AbortController();
    activeTestAbort = controller;
    if (button) {
        button.disabled = true;
    }
    const live = resolveWorldContext(ctx);
    const chatId = resolveActiveChatId(live);
    let completed = 0;
    let ok = 0;
    try {
        for (const agentId of AGENT_IDS) {
            if (controller.signal.aborted) {
                break;
            }
            const current = resolveWorldContext(ctx);
            if (resolveActiveChatId(current) !== chatId) {
                if (summary) {
                    summary.textContent = `Chat changed; test run cancelled after ${completed} of ${AGENT_IDS.length}.`;
                }
                return;
            }
            if (summary) {
                summary.textContent = `Testing ${completed + 1}/${AGENT_IDS.length}…`;
            }
            const result = await runAgentTest(current, root, agentId, {
                signal: controller.signal,
            });
            completed += 1;
            if (result?.ok) {
                ok += 1;
            }
        }
        if (summary) {
            summary.textContent = controller.signal.aborted
                ? `Cancelled after ${completed} of ${AGENT_IDS.length}.`
                : `${ok}/${AGENT_IDS.length} agents OK.`;
        }
    } finally {
        if (button) {
            button.disabled = false;
        }
        if (activeTestAbort === controller) {
            activeTestAbort = null;
        }
    }
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

function ensureAgentConfig(root, ctx = null) {
    const host = root.querySelector('[data-neoterra-agent-config]');
    if (!host) {
        return;
    }
    if (host.dataset.built !== 'true') {
        host.innerHTML = buildAgentConfigMarkup();
        host.dataset.built = 'true';
    }
    agentPickerState = readAgentPickerContext(ctx);
    syncAgentPickers(root, getSettings(ctx), agentPickerState);
}

/**
 * Resolve the context used for chat-scoped settings actions (world export,
 * import, character limits). Always prefer the live SillyTavern context: the
 * object captured at mount time can point at a previous chat's metadata.
 */
export function resolveWorldContext(ctx = null) {
    return readLiveContext(ctx) ?? ctx;
}

export async function ensureCharacterLimits(ctx, root, signal = null) {
    const host = root.querySelector('[data-neoterra-character-limits]');
    if (!host) {
        return;
    }
    const live = resolveWorldContext(ctx);
    const metadata = live?.chatMetadata?.neoterra ?? null;
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
    host.innerHTML = buildCharacterLimitMarkup(list, getSettings(live));
    host.dataset.builtKey = builtKey;
    paintSettingsPanel(live, root);
}

function refreshNarratorStatus(root, ctx = null) {
    if (!root) {
        return;
    }
    const statusHost = root.querySelector('[data-neoterra-narrator-status]');
    if (!statusHost) {
        return;
    }
    const status = directorCardStatus(resolveWorldContext(ctx));
    statusHost.textContent = status.installed
        ? `Installed: ${status.name}`
        : 'Not installed. Download it, then import it via Characters → Import character.';
    const button = root.querySelector('[data-neoterra-download-director]');
    if (button) {
        button.disabled = status.installed;
    }
}

async function handleDirectorDownload(root) {
    const statusHost = root.querySelector('[data-neoterra-narrator-status]');
    const button = root.querySelector('[data-neoterra-download-director]');
    if (button?.disabled) {
        return;
    }
    if (button) {
        button.disabled = true;
    }
    if (statusHost) {
        statusHost.textContent = 'Preparing the Director card…';
    }
    try {
        await downloadDirectorCard();
        if (statusHost) {
            statusHost.textContent = 'Downloaded. Import it via Characters → Import character.';
        }
    } catch (error) {
        logger.warn('Could not download the Director card', error);
        if (statusHost) {
            statusHost.textContent = `Download failed: ${error?.message ?? error}`;
        }
    } finally {
        if (button) {
            button.disabled = directorCardStatus(resolveWorldContext()).installed;
        }
    }
}

function exportSettings(ctx) {
    return downloadJson('neoterra-settings.json', getSettings(ctx));
}

function portraitStatusHost(root) {
    return root?.querySelector?.('[data-neoterra-portrait-status]') ?? null;
}

async function syncPortraits(ctx, root) {
    const statusHost = portraitStatusHost(root);
    const button = root?.querySelector?.('[data-neoterra-sync-portraits]');
    if (button) {
        button.disabled = true;
    }
    try {
        const live = resolveWorldContext(ctx);
        const registry = await loadRegistry();
        const characters = Array.isArray(live?.characters) ? live.characters : [];
        const manifest = await loadAvatarManifest().catch(() => null);
        const result = buildSyncOverrides(registry, characters, { manifest });
        writeAvatarOverrides(result.overrides);
        refreshAvatarContext({ registry, ctx: live, characters });
        initAvatars({ registry, ctx: live, characters }).catch(() => {});
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('neoterra:avatars-updated'));
        }
        if (statusHost) {
            const extra = result.ambiguous.length > 0
                ? ` ${result.ambiguous.length} ambiguous name(s) need a manual override.`
                : '';
            statusHost.textContent = `Synced ${result.matched} portrait(s) from installed cards.${extra}`;
        }
        return result;
    } catch (error) {
        logger.warn('Could not sync portraits', error);
        if (statusHost) {
            statusHost.textContent = `Sync failed: ${error?.message ?? error}`;
        }
        return null;
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

async function downloadAvatarManifest(ctx, root) {
    const statusHost = portraitStatusHost(root);
    try {
        const live = resolveWorldContext(ctx);
        const registry = await loadRegistry();
        const characters = Array.isArray(live?.characters) ? live.characters : [];
        const manifest = await loadAvatarManifest().catch(() => null);
        const merged = buildSyncedManifest(registry, characters, { manifest });
        downloadJson('neoterra-avatars.json', merged);
        if (statusHost) {
            statusHost.textContent = `Downloaded a mergeable manifest with ${merged.counts.matched} portrait(s).`;
        }
        return merged;
    } catch (error) {
        logger.warn('Could not build the avatar manifest', error);
        if (statusHost) {
            statusHost.textContent = `Manifest download failed: ${error?.message ?? error}`;
        }
        return null;
    }
}

async function paintPortraitStatus(root) {
    const statusHost = portraitStatusHost(root);
    if (!statusHost) {
        return;
    }
    try {
        const registry = await loadRegistry();
        const manifest = await loadAvatarManifest().catch(() => null);
        const live = resolveWorldContext(mountedCtx);
        const characters = Array.isArray(live?.characters) ? live.characters : [];
        const installed = buildSyncOverrides(registry, characters, { manifest });
        const manifestCount = manifest ? Object.keys(manifest.avatars ?? {}).length : 0;
        statusHost.textContent = `Manifest: ${manifestCount} portrait(s). Installed cards: ${installed.matched} match(es).`;
    } catch (error) {
        statusHost.textContent = 'Portrait status unavailable.';
    }
}

function exportWorld(ctx) {
    try {
        const live = resolveWorldContext(ctx);
        const bundle = buildWorldBundle(live?.chatMetadata);
        const chatId = String(resolveActiveChatId(live) ?? live?.chatId ?? bundle.worldState.chatId ?? 'world')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .slice(0, 60);
        downloadJson(`neoterra-world-${chatId || 'world'}.json`, bundle);
        return true;
    } catch (error) {
        logger.warn('Could not export the world', error);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert(`Neo Terra export failed: ${error?.message ?? error}`);
        }
        return false;
    }
}

async function importWorld(ctx, root, file) {
    const live = resolveWorldContext(ctx);
    if (!file || !live?.chatMetadata) {
        return false;
    }
    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch (error) {
        logger.warn('Could not parse world JSON', error);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert(`Neo Terra import failed: ${error?.message ?? error}`);
        }
        return false;
    }
    let bundle;
    try {
        bundle = normalizeWorldBundle(parsed, { chatId: resolveActiveChatId(live) ?? live.chatId ?? null });
    } catch (error) {
        logger.warn('Rejected world bundle', error);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert(`Neo Terra import failed: ${error?.message ?? error}`);
        }
        return false;
    }
    const hasWorld = Boolean(live.chatMetadata.neoterra?.worldState);
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const message = hasWorld
            ? 'Replace this chat\'s Neo Terra world with the imported world? The current world state will be overwritten.'
            : 'Import this Neo Terra world into the current chat?';
        if (!window.confirm(message)) {
            return false;
        }
    }
    try {
        writeWorldBundleToMetadata(live.chatMetadata, bundle, { chatId: resolveActiveChatId(live) ?? live.chatId ?? null });
        const store = createWorldStateStore({
            metadata: live.chatMetadata,
            saveMetadataDebounced: () => live?.saveMetadataDebounced?.(),
        });
        store.replace(live.chatMetadata.neoterra.worldState);
        store.flush();
        live?.saveMetadataDebounced?.();
    } catch (error) {
        logger.warn('Could not write the imported world', error);
        return false;
    }
    if (typeof globalThis.NeoTerra?.refreshWorld === 'function') {
        globalThis.NeoTerra.refreshWorld();
    } else {
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'world-import' });
    }
    void ensureCharacterLimits(live, root, panelAbort?.signal);
    return true;
}

/**
 * Ordered actions that reveal the settings panel inside SillyTavern's
 * extensions drawer. Pure so the ST DOM contract stays testable: the caller
 * maps each action onto a DOM call.
 *
 * @param {{ drawerPresent?: boolean, drawerOpen?: boolean, panelPresent?: boolean,
 *           panelExpanded?: boolean }} state
 * @returns {Array<'open-drawer'|'expand-panel'|'scroll-panel'|'warn-missing'>}
 */
export function planSettingsReveal({
    drawerPresent = false,
    drawerOpen = false,
    panelPresent = false,
    panelExpanded = false,
} = {}) {
    if (!drawerPresent || !panelPresent) {
        return ['warn-missing'];
    }
    const actions = [];
    // Never toggle: clicking an open drawer's toggle would close it.
    if (!drawerOpen) {
        actions.push('open-drawer');
    }
    if (!panelExpanded) {
        actions.push('expand-panel');
    }
    actions.push('scroll-panel');
    return actions;
}

/** Human-readable reason for a `warn-missing` reveal plan. */
export function describeMissingSettingsHost({ drawerPresent, panelPresent } = {}) {
    if (!drawerPresent && !panelPresent) {
        return 'The SillyTavern extensions drawer and the Neo Terra settings panel are not available. Reload the page, then try again.';
    }
    if (!drawerPresent) {
        return 'The SillyTavern extensions drawer (#rm_extensions_block) was not found. Reload the page, then try again.';
    }
    return 'The Neo Terra settings panel is not mounted yet. Reload the page, then try again.';
}

function isDrawerOpen(drawer) {
    if (!drawer?.classList) {
        return false;
    }
    return drawer.classList.contains('openDrawer');
}

function isPanelExpanded(content) {
    if (!content) {
        return false;
    }
    if (content.classList?.contains('closedDrawer')) {
        return false;
    }
    if (content.classList?.contains('openDrawer')) {
        return true;
    }
    // The inline-drawer template ships with `.inline-drawer-content.hidden`;
    // check the computed style last because it needs a layout.
    if (content.hidden === true || content.classList?.contains('hidden')) {
        return false;
    }
    if (typeof getComputedStyle === 'function') {
        try {
            return getComputedStyle(content).display !== 'none';
        } catch {
            return true;
        }
    }
    return true;
}

/**
 * Close the shell, open SillyTavern's extensions drawer, expand the Neo Terra
 * panel, and scroll it into view. Returns `{ ok: true }` or
 * `{ ok: false, reason }`; never throws.
 *
 * `deps` exists for tests: `{ doc, requestFrame }`.
 */
export function revealSettingsPanel({ deps = {}, ctx = null } = {}) {
    const doc = deps.doc ?? (hasDom() ? document : null);
    const requestFrame = deps.requestFrame
        ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    if (!doc) {
        return { ok: false, reason: 'no-dom' };
    }
    if (mountedCtx) {
        refreshSettingsPanel();
    } else {
        const live = resolveWorldContext(ctx);
        void ensureCharacterLimits(live, doc, panelAbort?.signal);
        refreshNarratorStatus(doc, live);
    }

    const drawer = doc.getElementById('rm_extensions_block');
    const panel = doc.getElementById(UI_IDS.SETTINGS_PANEL);
    const actions = planSettingsReveal({
        drawerPresent: Boolean(drawer),
        drawerOpen: isDrawerOpen(drawer),
        panelPresent: Boolean(panel),
        panelExpanded: isPanelExpanded(panel?.querySelector('.inline-drawer-content')),
    });

    for (const action of actions) {
        if (action === 'warn-missing') {
            // The caller owns logging and the visible status message.
            return { ok: false, reason: 'missing-host' };
        }
        if (action === 'open-drawer') {
            const toggle = doc.querySelector('#extensions-settings-button .drawer-toggle')
                ?? drawer?.querySelector('.drawer-toggle');
            if (!toggle) {
                return { ok: false, reason: 'missing-host' };
            }
            toggle.click?.();
        }
        if (action === 'expand-panel') {
            panel.querySelector('.inline-drawer-toggle')?.click?.();
        }
    }

    const scroll = () => panel?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (actions.includes('scroll-panel')) {
        scroll();
        // The drawer animates open; scroll once more after the first frame.
        if (typeof requestFrame === 'function') {
            requestFrame(() => scroll());
        }
    }
    return { ok: true };
}

async function ensureCardSeasonOptions(root, signal = null) {
    const select = root.querySelector('[data-neoterra-card-season]');
    if (!select) {
        return;
    }
    try {
        const response = await fetch(new URL('../../data/seasons/index.json', import.meta.url));
        if (response.ok === false) {
            return;
        }
        const index = await response.json();
        if (signal?.aborted) {
            return;
        }
        const options = (index.seasons ?? [])
            .filter((season) => season.folder && season.playable !== false)
            .map((season) => `<option value="${escapeHtml(season.id)}" data-folder="${escapeHtml(season.folder)}">${escapeHtml(season.folder)} (${escapeHtml(season.id)})</option>`);
        if (!options.some((option) => option.includes('value="others"'))) {
            options.push('<option value="others" data-folder="Others">Others (out of V1 scope)</option>');
        }
        if (options.length > 0) {
            select.innerHTML = options.join('');
        }
    } catch (error) {
        logger.debug('Could not load the season manifest for card import', error);
    }
}

async function importCards(ctx, root, files) {
    const list = Array.from(files ?? []);
    if (list.length === 0) {
        return false;
    }
    const seasonSelect = root.querySelector('[data-neoterra-card-season]');
    const selectedOption = seasonSelect?.selectedOptions?.[0] ?? null;
    const seasonId = String(seasonSelect?.value ?? '').trim();
    const folder = String(selectedOption?.dataset?.folder ?? '').trim() || seasonFolderForId(seasonId);
    if (!seasonId) {
        logger.warn('Choose a season folder before importing cards');
        return false;
    }
    const cards = [];
    const invalid = [];
    for (const file of list) {
        try {
            const parsed = JSON.parse(await file.text());
            cards.push({ name: file.name, data: parsed?.data ?? null, raw: parsed });
        } catch (error) {
            invalid.push({ file: file.name, reason: error?.message ?? String(error) });
        }
    }
    let existing = null;
    try {
        const response = await fetch(new URL('../../data/characters/overrides.json', import.meta.url));
        if (response.ok !== false) {
            existing = await response.json();
        }
    } catch (error) {
        logger.debug('Could not load existing overrides; starting a fresh document', error);
    }
    let existingIds = [];
    try {
        const registry = await loadRegistry();
        existingIds = (registry?.entries ?? []).map((entry) => entry.id).filter(Boolean);
    } catch (error) {
        logger.debug('Could not load the registry for duplicate-id checking', error);
    }
    let result;
    try {
        result = buildCardImportOverrides(cards, {
            seasonId,
            folder,
            existingOverrides: existing,
            existingIds,
        });
    } catch (error) {
        logger.warn('Could not build card overrides', error);
        return false;
    }
    result.report.invalid.push(...invalid);
    const reportHost = root.querySelector('[data-neoterra-card-import-report]');
    if (reportHost) {
        const lines = [];
        if (result.report.added.length > 0) {
            lines.push(`Add these cards to Chars/${folder}/ and re-run npm run build:data:`);
            for (const item of result.report.added) {
                lines.push(`  + ${item.key} -> ${item.id} (${item.displayName})`);
            }
        }
        for (const item of result.report.skipped) {
            lines.push(`  = ${item.key} already has an override`);
        }
        for (const item of result.report.invalid) {
            lines.push(`  ! ${item.file}: ${item.reason}`);
        }
        reportHost.textContent = lines.join('\n') || 'No card files were recognized.';
        reportHost.hidden = false;
    }
    if (result.report.added.length > 0) {
        downloadJson('neoterra-character-overrides.json', result.overrides);
    }
    return result.report.added.length > 0;
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
    ensureAgentConfig(root, ctx);
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
    for (const select of root.querySelectorAll('[data-neoterra-preset-select]')) {
        select.innerHTML = buildAgentPresetOptionsMarkup(settings);
        const wanted = settings.agentPresets?.activeId
            ? `preset:${settings.agentPresets.activeId}`
            : '';
        if ([...select.options].some((option) => option.value === wanted)) {
            select.value = wanted;
        }
    }
    syncAgentPickers(root, settings, agentPickerState);
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
        ensureAgentConfig(existing, ctx);
        paintSettingsPanel(ctx, existing);
        refreshNarratorStatus(existing, ctx);
        void ensureCharacterLimits(ctx, existing, externalSignal);
        void ensureCardSeasonOptions(existing, externalSignal);
        void paintPortraitStatus(existing);
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
        if (event.target.matches?.('[data-neoterra-import-world-file]')) {
            void importWorld(ctx, root, event.target.files?.[0]);
            event.target.value = '';
            return;
        }
        if (event.target.matches?.('[data-neoterra-card-import-file]')) {
            void importCards(ctx, root, event.target.files);
            event.target.value = '';
            return;
        }
        if (event.target.matches?.('[data-neoterra-preset-select]')) {
            // Selecting a saved/recommended preset applies it immediately.
            applyPresetSelection(ctx, root, event.target.value);
            return;
        }
        if (event.target.matches?.('[data-neoterra-profile-select]')) {
            handleProfileSelect(ctx, root, event.target);
            return;
        }
        onChange(ctx, root, event);
    }, { signal });
    root.addEventListener('click', event => {
        // Collapsing the extensions panel ends any in-flight connection test.
        if (event.target.closest?.('.inline-drawer-toggle')) {
            activeTestAbort?.abort();
        }
        const promptButton = event.target.closest?.('[data-neoterra-reset-prompt]');
        if (promptButton) {
            onResetPrompt(ctx, root, promptButton.dataset.neoterraResetPrompt);
            return;
        }
        const presetButton = event.target.closest?.(
            '[data-neoterra-preset-save],[data-neoterra-preset-update],[data-neoterra-preset-delete],[data-neoterra-preset-apply]',
        );
        if (presetButton) {
            handlePresetAction(ctx, root, presetButton);
            return;
        }
        const fetchModelsButton = event.target.closest?.('[data-neoterra-fetch-models]');
        if (fetchModelsButton) {
            handleFetchModels(ctx, root, fetchModelsButton.dataset.neoterraFetchModels);
            return;
        }
        const testAgentButton = event.target.closest?.('[data-neoterra-test-agent]');
        if (testAgentButton) {
            void runAgentTest(ctx, root, testAgentButton.dataset.neoterraTestAgent);
            return;
        }
        if (event.target.closest?.('[data-neoterra-test-all-agents]')) {
            void handleTestAllAgents(ctx, root);
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
        if (event.target.closest?.('[data-neoterra-export-world]')) {
            exportWorld(ctx);
            return;
        }
        if (event.target.closest?.('[data-neoterra-import-world]')) {
            root.querySelector('[data-neoterra-import-world-file]')?.click?.();
            return;
        }
        if (event.target.closest?.('[data-neoterra-import-cards]')) {
            root.querySelector('[data-neoterra-card-import-file]')?.click?.();
            return;
        }
        if (event.target.closest?.('[data-neoterra-download-director]')) {
            void handleDirectorDownload(root);
            return;
        }
        if (event.target.closest?.('[data-neoterra-sync-portraits]')) {
            void syncPortraits(ctx, root);
            return;
        }
        if (event.target.closest?.('[data-neoterra-download-avatars]')) {
            void downloadAvatarManifest(ctx, root);
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
    root.addEventListener('dragover', event => {
        const zone = event.target.closest?.('[data-neoterra-world-drop], [data-neoterra-card-drop]');
        if (zone) {
            event.preventDefault();
            zone.classList.add('neoterra-drop-active');
        }
    }, { signal });
    root.addEventListener('dragleave', event => {
        const zone = event.target.closest?.('[data-neoterra-world-drop], [data-neoterra-card-drop]');
        if (zone && !zone.contains(event.relatedTarget)) {
            zone.classList.remove('neoterra-drop-active');
        }
    }, { signal });
    root.addEventListener('drop', event => {
        const worldZone = event.target.closest?.('[data-neoterra-world-drop]');
        const cardZone = event.target.closest?.('[data-neoterra-card-drop]');
        if (!worldZone && !cardZone) {
            return;
        }
        event.preventDefault();
        (worldZone ?? cardZone).classList.remove('neoterra-drop-active');
        const files = event.dataTransfer?.files;
        if (worldZone) {
            void importWorld(ctx, root, files?.[0]);
        } else {
            void importCards(ctx, root, files);
        }
    }, { signal });

    ensureAgentConfig(root, ctx);
    paintSettingsPanel(ctx, root);
    syncDependentFields(root, getSettings(ctx));
    refreshNarratorStatus(root, ctx);
    void ensureCharacterLimits(ctx, root, signal);
    void ensureCardSeasonOptions(root, signal);
    void paintPortraitStatus(root);
    return root;
}

/** Remove the settings panel and its listeners. */
export function disposeSettingsPanel() {
    panelAbort?.abort();
    panelAbort = null;
    activeTestAbort?.abort();
    activeTestAbort = null;
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
    // Repaint from the live context so a chat switch never leaves stale values.
    const live = resolveWorldContext(mountedCtx);
    const root = document.getElementById(UI_IDS.SETTINGS_PANEL);
    if (root) {
        agentPickerState = readAgentPickerContext(live);
        const settings = paintSettingsPanel(live, root);
        syncDependentFields(root, settings);
        refreshNarratorStatus(root, live);
        void ensureCharacterLimits(live, root, panelAbort?.signal);
        void ensureCardSeasonOptions(root, panelAbort?.signal);
        void paintPortraitStatus(root);
    }
}
