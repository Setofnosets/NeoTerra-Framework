/**
 * Read and query the generated character registry.
 *
 * This module is intentionally browser-safe: no UI imports, no SillyTavern
 * globals, and `fetch` can be injected for Node tests.
 */

import { validateRegistry } from './schema.js';

const REGISTRY_URL = new URL('../../data/characters/index.json', import.meta.url);

let cachedRegistry = null;
let inFlight = null;

/**
 * Fetch, validate, and cache `data/characters/index.json`.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function loadRegistry({ fetchImpl = globalThis.fetch } = {}) {
    if (cachedRegistry) {
        return cachedRegistry;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadRegistry: no fetch implementation is available');
    }
    if (!inFlight) {
        inFlight = (async () => {
            const response = await fetchImpl(REGISTRY_URL.href);
            if (response && response.ok === false) {
                throw new Error(
                    `loadRegistry: failed to load ${REGISTRY_URL.href} (HTTP ${response.status ?? 'unknown'})`,
                );
            }
            const registry = await response.json();
            const validation = validateRegistry(registry);
            if (!validation.ok) {
                const details = validation.errors
                    .map((error) => `${error.path}: ${error.message}`)
                    .join('; ');
                throw new Error(`loadRegistry: invalid character registry (${details})`);
            }
            cachedRegistry = registry;
            return registry;
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

/** Clear the module-level cache (useful in tests and after regeneration). */
export function clearRegistryCache() {
    cachedRegistry = null;
    inFlight = null;
}

const indexCache = new WeakMap();

/**
 * Build lookup tables: by id, by season, and by form group.
 */
export function buildRegistryIndex(registry) {
    if (indexCache.has(registry)) {
        return indexCache.get(registry);
    }

    const byId = {};
    const bySeason = {};
    const byGroup = {};

    for (const entry of registry?.entries ?? []) {
        byId[entry.id] = entry;
        if (!bySeason[entry.seasonId]) {
            bySeason[entry.seasonId] = [];
        }
        bySeason[entry.seasonId].push(entry);

        if (entry.formGroup) {
            if (!byGroup[entry.formGroup]) {
                byGroup[entry.formGroup] = [];
            }
            byGroup[entry.formGroup].push(entry);
        }
    }

    const index = { byId, bySeason, byGroup };
    indexCache.set(registry, index);
    return index;
}

export function getCharacter(registry, id) {
    return buildRegistryIndex(registry).byId[id] ?? null;
}

export function getSeasonCharacters(registry, seasonId) {
    return buildRegistryIndex(registry).bySeason[seasonId] ?? [];
}

export function isBundle(entry) {
    return Boolean(entry && entry.bundle === true);
}

/** Characters that can be cast as NPCs in a season (bundles excluded). */
export function getNpcPool(registry, seasonId) {
    return getSeasonCharacters(registry, seasonId).filter(
        (entry) => entry.npcEligible !== false && !isBundle(entry),
    );
}

export function getAliases(entry) {
    return Array.isArray(entry?.aliases) ? entry.aliases.slice() : [];
}
