/**
 * Faction registry loaded from `data/factions.json`.
 *
 * Seasons reference these ids and may override influence/goals per timeline.
 * Browser-safe: `fetch` is injectable for Node tests.
 */

import { SIDES } from './schema.js';

const FACTIONS_URL = new URL('../../data/factions.json', import.meta.url);

export const FACTION_STATUSES = Object.freeze([
    'active',
    'dormant',
    'disbanded',
    'underground',
    'dominant',
]);

let cached = null;
let inFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

/**
 * @param {unknown} document
 * @param {{ locationIds?: Set<string> }} [context] optional cross-file refs
 */
export function validateFactions(document, context = {}) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'factions document must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!Array.isArray(document.factions) || document.factions.length === 0) {
        add(errors, 'factions', 'must be a non-empty array');
        return result(errors);
    }

    const ids = new Set();
    document.factions.forEach((faction, index) => {
        const path = `factions[${index}]`;
        if (!isObject(faction)) {
            add(errors, path, 'must be an object');
            return;
        }
        if (typeof faction.id !== 'string' || faction.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (ids.has(faction.id)) {
            add(errors, `${path}.id`, `duplicate faction id "${faction.id}"`);
        } else {
            ids.add(faction.id);
        }
        if (typeof faction.name !== 'string' || faction.name.trim().length === 0) {
            add(errors, `${path}.name`, 'must be a non-empty string');
        }
        if (!SIDES.includes(faction.side)) {
            add(errors, `${path}.side`, `unknown side "${String(faction.side)}"`);
        }
        if (typeof faction.description !== 'string' || faction.description.trim().length === 0) {
            add(errors, `${path}.description`, 'must be a non-empty string');
        }
        if (
            !Array.isArray(faction.goals)
            || faction.goals.length === 0
            || !faction.goals.every((goal) => typeof goal === 'string' && goal.length > 0)
        ) {
            add(errors, `${path}.goals`, 'must be a non-empty array of strings');
        }
        if (!Number.isInteger(faction.influence) || faction.influence < 0 || faction.influence > 100) {
            add(errors, `${path}.influence`, 'must be an integer from 0 to 100');
        }
        if (faction.headquartersLocationId !== null && typeof faction.headquartersLocationId !== 'string') {
            add(errors, `${path}.headquartersLocationId`, 'must be a string or null');
        } else if (
            typeof faction.headquartersLocationId === 'string'
            && context.locationIds
            && !context.locationIds.has(faction.headquartersLocationId)
        ) {
            add(
                errors,
                `${path}.headquartersLocationId`,
                `unresolved location "${faction.headquartersLocationId}"`,
            );
        }
        if (faction.aliases !== undefined && (!Array.isArray(faction.aliases) || !faction.aliases.every((alias) => typeof alias === 'string'))) {
            add(errors, `${path}.aliases`, 'must be an array of strings when present');
        }
        if (faction.tags !== undefined && (!Array.isArray(faction.tags) || !faction.tags.every((tag) => typeof tag === 'string'))) {
            add(errors, `${path}.tags`, 'must be an array of strings when present');
        }
    });

    return result(errors);
}

/**
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function loadFactions({ fetchImpl = globalThis.fetch } = {}) {
    if (cached) {
        return cached;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadFactions: no fetch implementation is available');
    }
    if (!inFlight) {
        inFlight = (async () => {
            const response = await fetchImpl(FACTIONS_URL.href);
            if (response && response.ok === false) {
                throw new Error(`loadFactions: HTTP ${response.status ?? 'unknown'}`);
            }
            const document = await response.json();
            const validation = validateFactions(document);
            if (!validation.ok) {
                const details = validation.errors
                    .map((error) => `${error.path}: ${error.message}`)
                    .join('; ');
                throw new Error(`loadFactions: invalid faction data (${details})`);
            }
            cached = document;
            return document;
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

export function clearFactionsCache() {
    cached = null;
    inFlight = null;
}

const indexCache = new WeakMap();

export function buildFactionIndex(document) {
    if (indexCache.has(document)) {
        return indexCache.get(document);
    }
    const byId = {};
    for (const faction of document?.factions ?? []) {
        byId[faction.id] = faction;
    }
    const index = { byId, list: document?.factions ?? [] };
    indexCache.set(document, index);
    return index;
}

export function getFaction(document, id) {
    return buildFactionIndex(document).byId[id] ?? null;
}

export function getFactionGoalOverride(seasonFaction) {
    return Array.isArray(seasonFaction?.goals) && seasonFaction.goals.length > 0
        ? seasonFaction.goals.slice()
        : null;
}
