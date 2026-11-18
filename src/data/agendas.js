/**
 * Off-screen agenda data loaded from `data/agendas.json`.
 *
 * The document holds the global per-day rates plus optional per-season faction
 * and threat pacing. It is pure data: nothing here touches the DOM, the store,
 * or an LLM. `DEFAULT_AGENDAS` is the always-usable fallback, so the world tick
 * still runs when the document cannot be loaded.
 */

export const AGENDAS_URL = new URL('../../data/agendas.json', import.meta.url);

/** Placeholders a rumor template may use. */
export const AGENDA_TEMPLATE_PLACEHOLDERS = Object.freeze(['faction', 'location', 'threat']);

const NUMERIC_DEFAULTS = Object.freeze([
    'factionInfluencePerDay',
    'mainThreatProgressPerDay',
    'secondaryThreatProgressPerDay',
    'maxFactionDeltaPerTick',
    'maxNpcMovesPerTick',
    'maxDaysPerTick',
    'rumorsPerTick',
]);

const INTEGER_DEFAULTS = Object.freeze([
    'maxFactionDeltaPerTick',
    'maxNpcMovesPerTick',
    'maxDaysPerTick',
    'rumorsPerTick',
]);

const DEFAULT_RUMOR_TEMPLATES = Object.freeze([
    'Word around {location}: {faction} is making a move.',
    'Rumours say {threat} is gaining ground near {location}.',
    '{faction} pressure is felt in {location} tonight.',
    'People in {location} are talking about {threat}.',
    '{faction} activity reported around {location}.',
]);

function freezeDeep(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            freezeDeep(child);
        }
    }
    return value;
}

/** Global fallback agenda; usable without loading anything. */
export const DEFAULT_AGENDAS = freezeDeep({
    factionInfluencePerDay: 0.5,
    mainThreatProgressPerDay: 1.0,
    secondaryThreatProgressPerDay: 0.5,
    maxFactionDeltaPerTick: 5,
    maxNpcMovesPerTick: 2,
    maxDaysPerTick: 14,
    rumorsPerTick: 2,
    rumorTemplates: [...DEFAULT_RUMOR_TEMPLATES],
});

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

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateTemplates(errors, templates, path) {
    if (!Array.isArray(templates) || templates.length === 0) {
        add(errors, path, 'must be a non-empty array of template strings');
        return;
    }
    templates.forEach((template, index) => {
        if (typeof template !== 'string' || template.trim().length === 0) {
            add(errors, `${path}[${index}]`, 'must be a non-empty string');
        }
    });
}

/**
 * Validate one agenda document. This is a shape check only: season faction and
 * threat ids are cross-file references and are verified by the data tests.
 *
 * @param {unknown} document
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateAgendas(document) {
    const errors = [];
    if (!isObject(document)) {
        add(errors, '$', 'agenda document must be an object');
        return result(errors);
    }
    if (document.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }

    const defaults = document.defaults;
    if (!isObject(defaults)) {
        add(errors, 'defaults', 'must be an object');
    } else {
        for (const key of NUMERIC_DEFAULTS) {
            const value = defaults[key];
            if (!Number.isFinite(value)) {
                add(errors, `defaults.${key}`, 'must be a finite number');
                continue;
            }
            if (value < 0) {
                add(errors, `defaults.${key}`, 'must be greater than or equal to 0');
            }
            if (INTEGER_DEFAULTS.includes(key) && !Number.isInteger(value)) {
                add(errors, `defaults.${key}`, 'must be an integer');
            }
        }
        if (Number.isFinite(defaults.maxDaysPerTick) && defaults.maxDaysPerTick < 1) {
            add(errors, 'defaults.maxDaysPerTick', 'must be at least 1');
        }
        validateTemplates(errors, defaults.rumorTemplates, 'defaults.rumorTemplates');
    }

    if (!isObject(document.seasons)) {
        add(errors, 'seasons', 'must be an object');
        return result(errors);
    }

    for (const [seasonId, season] of Object.entries(document.seasons)) {
        const path = `seasons.${seasonId}`;
        if (!isObject(season)) {
            add(errors, path, 'must be an object');
            continue;
        }
        if (season.factionAgendas !== undefined) {
            if (!isObject(season.factionAgendas)) {
                add(errors, `${path}.factionAgendas`, 'must be an object when present');
            } else {
                for (const [factionId, agenda] of Object.entries(season.factionAgendas)) {
                    const agendaPath = `${path}.factionAgendas.${factionId}`;
                    if (!isObject(agenda)) {
                        add(errors, agendaPath, 'must be an object');
                        continue;
                    }
                    if (agenda.influencePerDay !== undefined && !Number.isFinite(agenda.influencePerDay)) {
                        add(errors, `${agendaPath}.influencePerDay`, 'must be a finite number when present');
                    }
                    if (agenda.rumorTags !== undefined && !isStringArray(agenda.rumorTags)) {
                        add(errors, `${agendaPath}.rumorTags`, 'must be an array of strings when present');
                    }
                }
            }
        }
        if (season.threatPace !== undefined) {
            if (!isObject(season.threatPace)) {
                add(errors, `${path}.threatPace`, 'must be an object when present');
            } else {
                for (const [threatId, pace] of Object.entries(season.threatPace)) {
                    const pacePath = `${path}.threatPace.${threatId}`;
                    if (!isObject(pace)) {
                        add(errors, pacePath, 'must be an object');
                        continue;
                    }
                    if (pace.progressPerDay !== undefined && !Number.isFinite(pace.progressPerDay)) {
                        add(errors, `${pacePath}.progressPerDay`, 'must be a finite number when present');
                    }
                }
            }
        }
        if (season.rumorTemplates !== undefined) {
            validateTemplates(errors, season.rumorTemplates, `${path}.rumorTemplates`);
        }
    }

    return result(errors);
}

/**
 * Fetch, validate, and cache the agenda document.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function loadAgendas({ fetchImpl = globalThis.fetch } = {}) {
    if (cached) {
        return cached;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadAgendas: no fetch implementation is available');
    }
    if (!inFlight) {
        inFlight = (async () => {
            const response = await fetchImpl(AGENDAS_URL.href);
            if (response && response.ok === false) {
                throw new Error(`loadAgendas: HTTP ${response.status ?? 'unknown'}`);
            }
            const document = await response.json();
            const validation = validateAgendas(document);
            if (!validation.ok) {
                const details = validation.errors
                    .map((error) => `${error.path}: ${error.message}`)
                    .join('; ');
                throw new Error(`loadAgendas: invalid agenda data (${details})`);
            }
            cached = document;
            return document;
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

export function clearAgendasCache() {
    cached = null;
    inFlight = null;
}

/**
 * Merge the global defaults with one season's agenda. Never throws: a missing
 * or partial document yields `DEFAULT_AGENDAS` and an empty season.
 *
 * @param {object|null|undefined} document
 * @param {string|null|undefined} seasonId
 * @returns {{
 *   defaults: object,
 *   season: object,
 *   factionAgendas: object,
 *   threatPace: object,
 *   rumorTemplates: string[],
 * }}
 */
export function resolveAgenda(document, seasonId) {
    const source = isObject(document) ? document : null;
    const documentDefaults = source && isObject(source.defaults) ? source.defaults : {};
    const defaults = {
        ...DEFAULT_AGENDAS,
        ...documentDefaults,
        rumorTemplates: Array.isArray(documentDefaults.rumorTemplates)
            && documentDefaults.rumorTemplates.length > 0
            ? documentDefaults.rumorTemplates.slice()
            : [...DEFAULT_AGENDAS.rumorTemplates],
    };
    const seasons = source && isObject(source.seasons) ? source.seasons : {};
    const season = typeof seasonId === 'string' && isObject(seasons[seasonId])
        ? seasons[seasonId]
        : {};
    const factionAgendas = isObject(season.factionAgendas) ? season.factionAgendas : {};
    const threatPace = isObject(season.threatPace) ? season.threatPace : {};
    const rumorTemplates = Array.isArray(season.rumorTemplates) && season.rumorTemplates.length > 0
        ? season.rumorTemplates.slice()
        : defaults.rumorTemplates;
    return { defaults, season, factionAgendas, threatPace, rumorTemplates };
}

/**
 * Stable FNV-1a pick from a list. `null` for an empty or non-array input.
 *
 * @param {unknown} list
 * @param {unknown} seed
 * @returns {unknown|null}
 */
export function pickDeterministic(list, seed) {
    if (!Array.isArray(list) || list.length === 0) {
        return null;
    }
    const text = String(seed);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return list[hash % list.length];
}

/**
 * Fill the three allowed placeholders, leave every unknown brace untouched,
 * then collapse whitespace and trim.
 *
 * @param {unknown} template
 * @param {{ faction?: string, location?: string, threat?: string }} [values]
 * @returns {string}
 */
export function formatTemplate(template, values = {}) {
    if (typeof template !== 'string') {
        return '';
    }
    const source = isObject(values) ? values : {};
    const filled = template.replace(/\{(faction|location|threat)\}/g, (match, key) => {
        const value = source[key];
        return typeof value === 'string' && value.length > 0 ? value : match;
    });
    return filled.replace(/\s+/g, ' ').trim();
}
