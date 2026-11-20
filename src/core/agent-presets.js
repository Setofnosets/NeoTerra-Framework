/**
 * Saved agent presets.
 *
 * A preset snapshots the live `agents` block only (not the whole settings
 * document) so users can swap model/profile/cadence routing without touching
 * content, map, or UI settings. Every helper is pure: it returns a new
 * settings document and never mutates the input.
 */

import { DEFAULT_SETTINGS } from './defaults.js';

export const MAX_AGENT_PRESETS = 20;
export const MAX_AGENT_PRESET_NAME = 60;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presetItems(settings) {
    const items = settings?.agentPresets?.items;
    return isPlainObject(items) ? items : {};
}

function presetName(name) {
    const text = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!text) {
        throw new Error('Enter a preset name first');
    }
    if (text.length > MAX_AGENT_PRESET_NAME) {
        throw new Error(`Preset names must be at most ${MAX_AGENT_PRESET_NAME} characters`);
    }
    return text;
}

function cloneItems(settings) {
    const out = {};
    for (const [id, preset] of Object.entries(presetItems(settings))) {
        if (isPlainObject(preset)) {
            out[id] = structuredClone(preset);
        }
    }
    return out;
}

function presetBlock(settings, { activeId, items }) {
    const source = isPlainObject(settings?.agentPresets) ? settings.agentPresets : {};
    return { ...source, activeId, items };
}

function withPresets(settings, agentPresets) {
    const base = isPlainObject(settings)
        ? structuredClone(settings)
        : structuredClone(DEFAULT_SETTINGS);
    base.agentPresets = agentPresets;
    return base;
}

function makePresetId(items, now) {
    const stem = `preset-${Number(now).toString(36)}`;
    let id = stem;
    let index = 2;
    while (Object.hasOwn(items, id)) {
        id = `${stem}-${index}`;
        index += 1;
    }
    return id;
}

/** Snapshot of the live agent document, including any user prompts. */
export function snapshotAgents(settings) {
    const agents = isPlainObject(settings?.agents) ? settings.agents : DEFAULT_SETTINGS.agents;
    return structuredClone(agents);
}

/** Saved presets, oldest first, with their agent count. */
export function listAgentPresets(settings) {
    return Object.entries(presetItems(settings))
        .filter(([, preset]) => isPlainObject(preset))
        .map(([id, preset]) => ({
            id,
            name: typeof preset.name === 'string' && preset.name.trim()
                ? preset.name.trim()
                : id,
            createdAt: Number(preset.createdAt) || 0,
            agentCount: isPlainObject(preset.agents)
                ? Object.keys(preset.agents).length
                : 0,
        }))
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

/**
 * Save the current `agents` block under `name`. Pass `id` to update an
 * existing preset in place (its name is renamed too); omit it to create a new
 * one. Throws when the name is empty or the 20-preset cap is reached.
 */
export function saveAgentPreset(settings, name, { id = null, now = Date.now() } = {}) {
    const cleanName = presetName(name);
    const items = cloneItems(settings);
    // An explicitly supplied id must exist: silently creating a new preset
    // would hide a stale Update click.
    if (typeof id === 'string' && id && !Object.hasOwn(items, id)) {
        throw new Error('That agent preset no longer exists');
    }
    let presetId = typeof id === 'string' && id ? id : null;

    if (presetId) {
        items[presetId] = {
            ...items[presetId],
            name: cleanName,
            agents: snapshotAgents(settings),
        };
    } else {
        if (Object.keys(items).length >= MAX_AGENT_PRESETS) {
            throw new Error(`At most ${MAX_AGENT_PRESETS} agent presets can be saved`);
        }
        presetId = makePresetId(items, now);
        items[presetId] = {
            name: cleanName,
            createdAt: Number(now) || Date.now(),
            agents: snapshotAgents(settings),
        };
    }

    return withPresets(settings, presetBlock(settings, { activeId: presetId, items }));
}

/**
 * Apply a preset: replace the live `agents` block with the snapshot, filling
 * any agent fields the preset predates from the current defaults.
 */
export function applyAgentPreset(settings, id) {
    const preset = presetItems(settings)[id];
    if (!isPlainObject(preset)) {
        throw new Error('That agent preset no longer exists');
    }
    const agents = structuredClone(DEFAULT_SETTINGS.agents);
    const saved = isPlainObject(preset.agents) ? preset.agents : {};
    for (const [agentId, config] of Object.entries(saved)) {
        if (!isPlainObject(config)) {
            continue;
        }
        agents[agentId] = {
            ...(isPlainObject(agents[agentId]) ? agents[agentId] : {}),
            ...structuredClone(config),
        };
    }
    const next = withPresets(settings, presetBlock(settings, {
        activeId: id,
        items: cloneItems(settings),
    }));
    next.agents = agents;
    return next;
}

/** Delete a preset. The live `agents` document is left untouched. */
export function deleteAgentPreset(settings, id) {
    if (!Object.hasOwn(presetItems(settings), id)) {
        throw new Error('That agent preset no longer exists');
    }
    const items = cloneItems(settings);
    delete items[id];
    const activeId = settings?.agentPresets?.activeId === id ? '' : (settings?.agentPresets?.activeId ?? '');
    return withPresets(settings, presetBlock(settings, { activeId, items }));
}

/** Rename a preset without changing its snapshot. */
export function renameAgentPreset(settings, id, name) {
    if (!Object.hasOwn(presetItems(settings), id)) {
        throw new Error('That agent preset no longer exists');
    }
    const cleanName = presetName(name);
    const items = cloneItems(settings);
    items[id] = { ...items[id], name: cleanName };
    return withPresets(settings, presetBlock(settings, {
        activeId: settings?.agentPresets?.activeId ?? '',
        items,
    }));
}
