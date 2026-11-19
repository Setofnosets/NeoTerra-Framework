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
import { loadFactions } from '../data/factions.js';
import { loadLocations } from '../data/locations.js';
import { loadDistricts } from '../data/map.js';

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
 * Optional world documents for the character creator. A stale or partial
 * install must still mount the codex, so a failed load degrades to `{}`.
 */
async function loadOptionalDocument(loader) {
    if (typeof loader !== 'function') {
        return {};
    }
    try {
        const document = await loader();
        return document && typeof document === 'object' ? document : {};
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
 *   loadFactions?: () => Promise<object>,
 *   loadLocations?: () => Promise<object>,
 *   loadDistricts?: () => Promise<object>,
 * }} [options]
 * @returns {Promise<{
 *   season: object|null,
 *   registry: object,
 *   formGroups: object,
 *   formRules: object,
 *   profiles: object,
 *   factions: object,
 *   locations: object,
 *   districts: object,
 * }>}
 */
export async function loadCodexData({
    metadata = null,
    loadFullRegistry = loadRegistry,
    loadFormGroups: loadGroups = loadFormGroups,
    loadFormRules: loadRules = loadFormRules,
    loadProfiles: loadProfileData = loadProfiles,
    loadFactions: loadFactionData = loadFactions,
    loadLocations: loadLocationData = loadLocations,
    loadDistricts: loadDistrictData = loadDistricts,
} = {}) {
    const resolved = resolveCodexRegistry(metadata, loadFullRegistry);
    const registry = await resolved.registry;

    const [formGroups, formRules, profiles, factions, locations, districts] = await Promise.all([
        loadGroups(),
        loadRules(),
        loadOptionalProfiles(loadProfileData),
        loadOptionalDocument(loadFactionData),
        loadOptionalDocument(loadLocationData),
        loadOptionalDocument(loadDistrictData),
    ]);

    return {
        season: resolved.season,
        registry,
        formGroups,
        formRules,
        profiles,
        factions,
        locations,
        districts,
    };
}

/* ------------------------------------------------------------------ */
/* Character creator exemplars                                         */
/* ------------------------------------------------------------------ */

const EXEMPLAR_CACHE = new Map();
const MAX_EXEMPLAR_CHARS = 8000;
const DEFAULT_EXEMPLAR_COUNT = 3;

/**
 * Load the full card descriptions used as house-style exemplars.
 *
 * The registry entry drives the file path; a failed fetch is skipped, so the
 * creator degrades to "fewer exemplars" rather than failing to open.
 *
 * @param {{ registry?: object|null, seasonId?: string|null, max?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Array<{ name: string, description: string }>>}
 */
export async function loadCardExemplars({
    registry = null,
    seasonId = null,
    max = DEFAULT_EXEMPLAR_COUNT,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!registry || typeof seasonId !== 'string' || seasonId.length === 0) {
        return [];
    }
    if (typeof fetchImpl !== 'function') {
        return [];
    }
    const entries = (registry.entries ?? [])
        .filter((entry) => entry
            && entry.seasonId === seasonId
            && entry.formKind === 'base'
            && entry.bundle !== true
            && typeof entry.cardPath === 'string')
        .slice(0, Math.max(0, max));
    const key = `${seasonId}:${max}:${entries.map((entry) => entry.id).join(',')}`;
    if (EXEMPLAR_CACHE.has(key)) {
        return EXEMPLAR_CACHE.get(key);
    }
    const exemplars = (await Promise.all(entries.map(async (entry) => {
        try {
            const url = new URL(`../../${entry.cardPath}`, import.meta.url);
            const response = await fetchImpl(url.href);
            if (!response || response.ok === false) {
                return null;
            }
            const card = await response.json();
            const description = card?.data?.description;
            if (typeof description !== 'string' || description.trim().length === 0) {
                return null;
            }
            return {
                name: card.data.name ?? entry.displayName ?? entry.id,
                description: description.slice(0, MAX_EXEMPLAR_CHARS),
            };
        } catch {
            // A missing PNG/JSON twin must not block the creator.
            return null;
        }
    }))).filter(Boolean);
    EXEMPLAR_CACHE.set(key, exemplars);
    return exemplars;
}

/** Clear the exemplar cache (tests and after regenerating characters). */
export function clearCardExemplarCache() {
    EXEMPLAR_CACHE.clear();
}

/**
 * Build the generated-forms export payload. Kept pure so the export button and
 * the regression suite share one contract.
 */
export function buildGeneratedFormsExport(state) {
    const all = state?.flags?.generatedForms ?? {};
    return {
        kind: 'neoterra-generated-forms',
        schemaVersion: 1,
        chatId: state?.chatId ?? null,
        generatedForms: all,
    };
}
