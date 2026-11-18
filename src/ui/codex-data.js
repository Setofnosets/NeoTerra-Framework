/**
 * Data loading for the character codex.
 *
 * The codex mounts from two different registry sources: the chat-scoped roster
 * slice stored by season start, or the full generated registry (sandbox). Only
 * the display roster is chat-scoped: form rules are a global document and must
 * not be validated against a partial registry slice, because those ids resolve
 * against every season.
 *
 * This module keeps the loading order explicit and injectable so the shell and
 * the tests share one implementation.
 */

import { loadFormGroups, loadFormRules } from '../data/forms.js';
import { loadProfiles } from '../data/profiles.js';
import { loadRegistry } from '../data/registry.js';

/**
 * Fetch the character profiles artifact when a loader is supplied.
 *
 * Profiles are optional for the codex: a stale install without
 * `data/characters/profiles.json` must still mount with live state, so a
 * missing or rejected loader degrades to an empty map.
 */
async function loadOptionalProfiles(loadProfiles) {
    if (typeof loadProfiles !== 'function') {
        return {};
    }
    try {
        const profiles = await loadProfiles();
        return profiles && typeof profiles === 'object' ? profiles : {};
    } catch {
        return {};
    }
}

/**
 * Resolve the codex registry for a chat.
 *
 * Season start stores a roster slice. Sandbox seasons have an empty roster, so
 * their slice is truthy but empty; the full registry is used there.
 *
 * @param {{ neoterra?: { seasonDefinition?: object|null, registry?: object|null } }|null} metadata
 * @param {() => Promise<object>} loadFullRegistry
 * @returns {{ season: object|null, registry: object|Promise<object>, usesChatSlice: boolean }}
 */
export function resolveCodexRegistry(metadata, loadFullRegistry = loadRegistry) {
    const season = metadata?.neoterra?.seasonDefinition ?? null;
    const metadataRegistry = metadata?.neoterra?.registry ?? null;
    const hasEntries = Array.isArray(metadataRegistry?.entries)
        && metadataRegistry.entries.length > 0;
    const usesChatSlice = hasEntries && season?.allowAnyCharacter !== true;
    return {
        season,
        usesChatSlice,
        registry: usesChatSlice ? metadataRegistry : loadFullRegistry(),
    };
}

/**
 * Load everything the codex needs to mount.
 *
 * `loadFormRules` is called without a registry on purpose: rules define ids
 * across every season, and the codex only needs the structural check.
 *
 * @param {{
 *   metadata?: object|null,
 *   loadFullRegistry?: () => Promise<object>,
 *   loadFormGroups?: () => Promise<object>,
 *   loadFormRules?: () => Promise<object>,
 *   loadProfiles?: (() => Promise<object>) | null,
 * }} [options]
 * @returns {Promise<{
 *   season: object|null,
 *   registry: object,
 *   formGroups: object,
 *   formRules: object,
 *   profiles: object,
 * }>}
 */
export async function loadCodexData({
    metadata = null,
    loadFullRegistry = loadRegistry,
    loadFormGroups: loadGroups = loadFormGroups,
    loadFormRules: loadRules = loadFormRules,
    loadProfiles: loadProfileData = loadProfiles,
} = {}) {
    const resolved = resolveCodexRegistry(metadata, loadFullRegistry);
    const registry = await resolved.registry;

    const [formGroups, formRules, profiles] = await Promise.all([
        loadGroups(),
        loadRules(),
        loadOptionalProfiles(loadProfileData),
    ]);

    return {
        season: resolved.season,
        registry,
        formGroups,
        formRules,
        profiles,
    };
}
