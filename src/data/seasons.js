/**
 * Season definition loader and cross-file validator.
 *
 * A season is authored data. The loader fetches one season JSON, validates its
 * shape and every cross-file reference (registry characters, factions, map
 * nodes, canon beats), and only then hands it to world construction.
 *
 * `s5.aux.json` is metadata for an auxiliary lore book. It is parsed so the
 * entry menu can show a disabled notice, but entering it throws a clear
 * "not yet playable" error.
 */

import {
    BEAT_ACTS,
    validateBeat,
    validateBeats,
} from './beats.js';
import { buildFactionIndex, loadFactions, validateFactions } from './factions.js';
import { buildLocationIndex, loadLocations, validateLocations } from './locations.js';
import { buildDistrictIndex, loadDistricts, validateDistricts } from './map.js';
import { buildRegistryIndex, loadRegistry } from './registry.js';
import { validateRegistry } from './schema.js';

export const SEASON_DEFINITION_IDS = Object.freeze([
    's1',
    's1dark',
    's2',
    's3',
    's4',
    'sandbox',
    's5',
]);

export const PLAYABLE_SEASON_IDS = Object.freeze([
    's1',
    's1dark',
    's2',
    's3',
    's4',
    'sandbox',
]);

export const PLAYER_ROLES = Object.freeze(['hero', 'villain', 'neutral']);
export const FAILURE_STATES = Object.freeze(['villain-victory', 'neutral-bad-ending', 'none']);
export const SEASON_FACTION_STATUSES = Object.freeze([
    'active',
    'dormant',
    'disbanded',
    'underground',
    'dominant',
]);
export const THREAT_RANKS = Object.freeze(['main', 'secondary']);

const SEASON_FILES = Object.freeze({
    s1: 's1.json',
    s1dark: 's1dark.json',
    s2: 's2.json',
    s3: 's3.json',
    s4: 's4.json',
    sandbox: 'sandbox.json',
    s5: 's5.aux.json',
});

const SEASON_INDEX_URL = new URL('../../data/seasons/index.json', import.meta.url);

const cache = new Map();
const inFlight = new Map();
let seasonIndex = null;
let seasonIndexInFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

function seasonIdOf(id) {
    return String(id ?? '');
}

/**
 * Validate a season document against its siblings.
 *
 * @param {object} season
 * @param {{ registry?: object, factions?: object, locations?: object, districts?: object }} [context]
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateSeasonDefinition(season, context = {}) {
    const errors = [];
    if (!isObject(season)) {
        add(errors, '$', 'season must be an object');
        return result(errors);
    }

    if (season.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    const knownIds = Array.isArray(context.seasonIds) && context.seasonIds.length > 0
        ? context.seasonIds
        : SEASON_DEFINITION_IDS;
    if (!knownIds.includes(season.id)) {
        add(errors, 'id', `unknown season id "${String(season.id)}"`);
    }
    for (const field of ['title', 'era', 'premise', 'toneNotes']) {
        if (typeof season[field] !== 'string' || season[field].trim().length === 0) {
            add(errors, field, 'must be a non-empty string');
        }
    }
    if (season.anchorDate !== null && typeof season.anchorDate !== 'string') {
        add(errors, 'anchorDate', 'must be a date string or null');
    }
    if (!PLAYER_ROLES.includes(season.playerRole)) {
        add(errors, 'playerRole', `must be one of ${PLAYER_ROLES.join(', ')}`);
    }
    for (const field of ['playable', 'alt', 'sandbox', 'allowAnyCharacter']) {
        if (typeof season[field] !== 'boolean') {
            add(errors, field, 'must be a boolean');
        }
    }
    if (season.defaultPlayerCharacterId !== null && typeof season.defaultPlayerCharacterId !== 'string') {
        add(errors, 'defaultPlayerCharacterId', 'must be a string or null');
    }
    if (season.failureState !== null && !FAILURE_STATES.includes(season.failureState)) {
        add(errors, 'failureState', `must be one of ${FAILURE_STATES.join(', ')}`);
    }

    const registryIndex = context.registry ? buildRegistryIndex(context.registry) : null;
    const factionIndex = context.factions ? buildFactionIndex(context.factions) : null;
    const locationIndex = context.locations ? buildLocationIndex(context.locations) : null;
    const districtIndex = context.districts ? buildDistrictIndex(context.districts) : null;

    const characterIds = new Set(Object.keys(registryIndex?.byId ?? {}));
    const factionIds = new Set(Object.keys(factionIndex?.byId ?? {}));
    const locationIds = new Set(Object.keys(locationIndex?.byId ?? {}));
    const districtIds = new Set(Object.keys(districtIndex?.byId ?? {}));

    // Optional context documents are validated too, so a season check always
    // fails loudly on a broken cross-file dependency. Faction and location
    // references are checked in both directions.
    if (context.registry) {
        const validation = validateRegistry(context.registry);
        for (const error of validation.errors) {
            add(errors, `registry.${error.path}`, error.message);
        }
    }
    if (context.factions) {
        const validation = validateFactions(context.factions, { locationIds });
        for (const error of validation.errors) {
            add(errors, `factions.${error.path}`, error.message);
        }
    }
    if (context.districts) {
        const validation = validateDistricts(context.districts);
        for (const error of validation.errors) {
            add(errors, `districts.${error.path}`, error.message);
        }
    }
    if (context.locations) {
        const validation = validateLocations(context.locations, { factionIds, districtIds });
        for (const error of validation.errors) {
            add(errors, `locations.${error.path}`, error.message);
        }
    }
    const seasonScope = (entry) => !registryIndex || entry?.seasonId === season.id;

    // --- roster -----------------------------------------------------------
    const roster = season.roster;
    const rosterCharacterIds = new Set();
    if (!Array.isArray(roster)) {
        add(errors, 'roster', 'must be an array');
    } else if (season.playable !== false && !season.allowAnyCharacter && roster.length === 0) {
        add(errors, 'roster', 'must declare at least one character unless allowAnyCharacter is true');
    } else {
        roster.forEach((member, index) => {
            const path = `roster[${index}]`;
            if (!isObject(member)) {
                add(errors, path, 'must be an object');
                return;
            }
            const character = registryIndex ? registryIndex.byId[member.characterId] : null;
            const form = registryIndex ? registryIndex.byId[member.formId] : null;
            if (registryIndex && !character) {
                add(errors, `${path}.characterId`, `unresolved character "${String(member.characterId)}"`);
            } else if (character && !seasonScope(character)) {
                add(errors, `${path}.characterId`, `character "${character.id}" belongs to season "${character.seasonId}"`);
            }
            if (registryIndex && !form) {
                add(errors, `${path}.formId`, `unresolved form "${String(member.formId)}"`);
            } else if (form && !seasonScope(form)) {
                add(errors, `${path}.formId`, `form "${form.id}" belongs to season "${form.seasonId}"`);
            }
            if (form && character && form.id !== character.id) {
                const linked = form.altOf === character.id
                    || (form.formGroup && character.formGroup && form.formGroup === character.formGroup);
                if (!linked) {
                    add(errors, `${path}.formId`, `form "${form.id}" is not the character's active form "${character.id}"`);
                }
            }
            if (character && character.bundle === true) {
                add(errors, `${path}.characterId`, 'multi-actor bundles belong in manualOnly, not the roster');
            }
            if (typeof member.characterId === 'string') {
                if (rosterCharacterIds.has(member.characterId)) {
                    add(errors, `${path}.characterId`, `duplicate roster character "${member.characterId}"`);
                }
                rosterCharacterIds.add(member.characterId);
            }
            if (member.locationId !== null && member.locationId !== undefined) {
                if (locationIndex && !locationIds.has(member.locationId)) {
                    add(errors, `${path}.locationId`, `unresolved location "${member.locationId}"`);
                }
            } else if (!Object.hasOwn(member, 'locationId')) {
                add(errors, `${path}.locationId`, 'must be a location id or null');
            }
        });
    }

    if (season.defaultPlayerCharacterId !== null && season.defaultPlayerCharacterId !== undefined) {
        if (registryIndex && !characterIds.has(season.defaultPlayerCharacterId)) {
            add(errors, 'defaultPlayerCharacterId', `unresolved character "${season.defaultPlayerCharacterId}"`);
        } else if (rosterCharacterIds.size > 0 && !rosterCharacterIds.has(season.defaultPlayerCharacterId)) {
            add(errors, 'defaultPlayerCharacterId', 'default player character must be on the roster');
        }
    }

    // --- factions ---------------------------------------------------------
    const factionRefs = season.factions;
    const seenFactions = new Set();
    if (!Array.isArray(factionRefs)) {
        add(errors, 'factions', 'must be an array');
    } else {
        factionRefs.forEach((ref, index) => {
            const path = `factions[${index}]`;
            if (!isObject(ref)) {
                add(errors, path, 'must be an object');
                return;
            }
            if (typeof ref.id !== 'string' || ref.id.length === 0) {
                add(errors, `${path}.id`, 'must be a non-empty string');
            } else {
                if (seenFactions.has(ref.id)) {
                    add(errors, `${path}.id`, `duplicate faction "${ref.id}"`);
                }
                seenFactions.add(ref.id);
                if (factionIndex && !factionIds.has(ref.id)) {
                    add(errors, `${path}.id`, `unresolved faction "${ref.id}"`);
                }
            }
            if (!Number.isInteger(ref.influence) || ref.influence < 0 || ref.influence > 100) {
                add(errors, `${path}.influence`, 'must be an integer from 0 to 100');
            }
            if (!SEASON_FACTION_STATUSES.includes(ref.status)) {
                add(errors, `${path}.status`, `unknown status "${String(ref.status)}"`);
            }
            if (ref.goals !== undefined && !isStringArray(ref.goals)) {
                add(errors, `${path}.goals`, 'must be an array of strings when present');
            }
        });
    }

    // --- threats ----------------------------------------------------------
    const threats = season.threats;
    const threatIds = new Set();
    if (!Array.isArray(threats)) {
        add(errors, 'threats', 'must be an array');
    } else {
        threats.forEach((threat, index) => {
            const path = `threats[${index}]`;
            if (!isObject(threat)) {
                add(errors, path, 'must be an object');
                return;
            }
            if (typeof threat.id !== 'string' || threat.id.length === 0) {
                add(errors, `${path}.id`, 'must be a non-empty string');
            } else {
                if (threatIds.has(threat.id)) {
                    add(errors, `${path}.id`, `duplicate threat "${threat.id}"`);
                }
                threatIds.add(threat.id);
                if (season.id !== 'sandbox' && !threat.id.startsWith(`${season.id}.`)) {
                    add(errors, `${path}.id`, `must start with "${season.id}."`);
                }
            }
            if (typeof threat.name !== 'string' || threat.name.trim().length === 0) {
                add(errors, `${path}.name`, 'must be a non-empty string');
            }
            if (!THREAT_RANKS.includes(threat.rank)) {
                add(errors, `${path}.rank`, `must be one of ${THREAT_RANKS.join(', ')}`);
            }
            if (threat.sourceFactionId !== null && typeof threat.sourceFactionId !== 'string') {
                add(errors, `${path}.sourceFactionId`, 'must be a string or null');
            } else if (threat.sourceFactionId && factionIndex && !factionIds.has(threat.sourceFactionId)) {
                add(errors, `${path}.sourceFactionId`, `unresolved faction "${threat.sourceFactionId}"`);
            }
            if (typeof threat.agenda !== 'string' || threat.agenda.trim().length === 0) {
                add(errors, `${path}.agenda`, 'must be a non-empty string');
            }
            if (!Array.isArray(threat.stages) || threat.stages.length < 2) {
                add(errors, `${path}.stages`, 'must declare at least two escalation stages');
            } else if (!threat.stages.every((stage) => typeof stage === 'string' && stage.length > 0)) {
                add(errors, `${path}.stages`, 'stages must be non-empty strings');
            }
            if (!Number.isInteger(threat.progress) || threat.progress < 0 || threat.progress > 100) {
                add(errors, `${path}.progress`, 'must be an integer from 0 to 100');
            }
            if (threat.locationId !== null && threat.locationId !== undefined) {
                if (locationIndex && !locationIds.has(threat.locationId)) {
                    add(errors, `${path}.locationId`, `unresolved location "${threat.locationId}"`);
                }
            } else if (!Object.hasOwn(threat, 'locationId')) {
                add(errors, `${path}.locationId`, 'must be a location id or null');
            }
        });
    }

    // --- start location and map refs --------------------------------------
    if (typeof season.startLocationId !== 'string') {
        add(errors, 'startLocationId', 'must be a string');
    } else if (locationIndex && !locationIds.has(season.startLocationId)) {
        add(errors, 'startLocationId', `unresolved location "${season.startLocationId}"`);
    } else if (locationIndex) {
        const start = locationIndex.byId[season.startLocationId];
        if (start && !start.mapRef && start.virtual !== true) {
            add(
                errors,
                'startLocationId',
                'the start location must declare a mapRef or be explicitly virtual',
            );
        }
        if (typeof start?.districtId === 'string' && districtIndex && !districtIds.has(start.districtId)) {
            add(errors, 'startLocationId', `unresolved district "${start.districtId}"`);
        }
    }

    // --- canon beats ------------------------------------------------------
    const beats = season.canonBeats ?? [];
    const beatValidation = validateBeats(beats, {
        seasonId: season.id,
        characterIds,
        locationIds,
        factionIds,
        threatIds,
    });
    for (const error of beatValidation.errors) {
        add(errors, error.path, error.message);
    }
    if (season.sandbox === true && beats.length > 0) {
        add(errors, 'canonBeats', 'sandbox must not declare canon beats');
    }
    if (season.sandbox !== true && season.playable !== false && beats.length === 0) {
        add(errors, 'canonBeats', 'a non-sandbox season must declare canon beats');
    }

    const beatIds = new Set(beats.map((beat) => beat?.id).filter(Boolean));
    const opening = season.openingBeats;
    if (!Array.isArray(opening) || !isStringArray(opening)) {
        add(errors, 'openingBeats', 'must be an array of beat ids');
    } else {
        const seen = new Set();
        opening.forEach((beatId, index) => {
            if (!beatIds.has(beatId)) {
                add(errors, `openingBeats[${index}]`, `unresolved beat "${beatId}"`);
                return;
            }
            if (seen.has(beatId)) {
                add(errors, `openingBeats[${index}]`, `duplicate opening beat "${beatId}"`);
            }
            seen.add(beatId);
            const beat = beats.find((candidate) => candidate?.id === beatId);
            if (beat && beat.act !== 'opening') {
                add(errors, `openingBeats[${index}]`, 'openingBeats may only reference opening-act beats');
            }
        });
    }

    // --- post-victory arcs ------------------------------------------------
    if (season.postVictory !== undefined) {
        if (!isObject(season.postVictory)) {
            add(errors, 'postVictory', 'must be an object when present');
        } else {
            for (const path of ['resistance', 'join-villain']) {
                const config = season.postVictory[path];
                if (config === undefined) {
                    continue;
                }
                const pathPrefix = `postVictory.${path}`;
                if (!isObject(config)) {
                    add(errors, pathPrefix, 'must be an object');
                    continue;
                }
                if (config.title !== undefined
                    && (typeof config.title !== 'string' || config.title.trim().length === 0)) {
                    add(errors, `${pathPrefix}.title`, 'must be a non-empty string');
                }
                for (const field of ['victorFactionId', 'resistanceFactionId']) {
                    const factionId = config[field];
                    if (factionId !== undefined && factionId !== null) {
                        if (typeof factionId !== 'string' || !factionIds.has(factionId)) {
                            add(errors, `${pathPrefix}.${field}`, `unresolved faction "${String(factionId)}"`);
                        }
                    }
                }
                if (config.threat !== undefined) {
                    const threat = config.threat;
                    if (!isObject(threat)) {
                        add(errors, `${pathPrefix}.threat`, 'must be an object');
                    } else {
                        if (typeof threat.id !== 'string' || threat.id.length === 0) {
                            add(errors, `${pathPrefix}.threat.id`, 'must be a non-empty string');
                        }
                        if (typeof threat.name !== 'string' || threat.name.trim().length === 0) {
                            add(errors, `${pathPrefix}.threat.name`, 'must be a non-empty string');
                        }
                        if (!THREAT_RANKS.includes(threat.rank)) {
                            add(errors, `${pathPrefix}.threat.rank`, `must be one of ${THREAT_RANKS.join(', ')}`);
                        }
                        if (threat.sourceFactionId !== null && threat.sourceFactionId !== undefined
                            && !factionIds.has(threat.sourceFactionId)) {
                            add(errors, `${pathPrefix}.threat.sourceFactionId`, 'unresolved faction');
                        }
                        if (!Array.isArray(threat.stages) || threat.stages.length < 2) {
                            add(errors, `${pathPrefix}.threat.stages`, 'must declare at least two stages');
                        }
                        if (threat.locationId !== null && threat.locationId !== undefined
                            && !locationIds.has(threat.locationId)) {
                            add(errors, `${pathPrefix}.threat.locationId`, 'unresolved location');
                        }
                    }
                }
                if (config.beats !== undefined) {
                    if (!Array.isArray(config.beats)) {
                        add(errors, `${pathPrefix}.beats`, 'must be an array');
                    } else {
                        const beatIds = new Set(
                            config.beats.map((beat) => beat?.id).filter((id) => typeof id === 'string'),
                        );
                        config.beats.forEach((beat, index) => {
                            const validation = validateBeat(beat, season.id, {
                                characterIds,
                                locationIds,
                                factionIds,
                                threatIds,
                                beatIds,
                            });
                            for (const error of validation.errors) {
                                add(errors, `${pathPrefix}.beats[${index}].${error.path}`, error.message);
                            }
                        });
                    }
                }
            }
        }
    }

    // --- optional villain domain ------------------------------------------
    if (season.domain !== undefined) {
        if (!isObject(season.domain)) {
            add(errors, 'domain', 'must be an object when present');
        } else {
            const domain = season.domain;
            for (const field of ['name', 'factionId']) {
                if (typeof domain[field] !== 'string' || domain[field].trim().length === 0) {
                    add(errors, `domain.${field}`, 'must be a non-empty string');
                }
            }
            if (typeof domain.factionId === 'string' && factionIndex && !factionIds.has(domain.factionId)) {
                add(errors, 'domain.factionId', `unresolved faction "${domain.factionId}"`);
            }
            for (const field of ['description', 'loreText', 'knightFormKind']) {
                if (domain[field] !== undefined && typeof domain[field] !== 'string') {
                    add(errors, `domain.${field}`, 'must be a string when present');
                }
            }
            if (domain.watchDistricts !== undefined) {
                if (!isStringArray(domain.watchDistricts)) {
                    add(errors, 'domain.watchDistricts', 'must be an array of district ids');
                } else if (districtIndex) {
                    domain.watchDistricts.forEach((districtId, index) => {
                        if (!districtIds.has(districtId)) {
                            add(errors, `domain.watchDistricts[${index}]`, `unresolved district "${districtId}"`);
                        }
                    });
                }
            }
            if (domain.resistanceFactionIds !== undefined) {
                if (!isStringArray(domain.resistanceFactionIds)) {
                    add(errors, 'domain.resistanceFactionIds', 'must be an array of faction ids');
                } else if (factionIndex) {
                    domain.resistanceFactionIds.forEach((factionId, index) => {
                        if (!factionIds.has(factionId)) {
                            add(errors, `domain.resistanceFactionIds[${index}]`, `unresolved faction "${factionId}"`);
                        }
                    });
                }
            }
        }
    }

    // --- deadline, failure state, and season-specific rules ---------------
    const deadline = season.finalDeadline;
    if (!isObject(deadline)) {
        add(errors, 'finalDeadline', 'must be an object');
    } else {
        if (deadline.turns !== null && deadline.turns !== undefined) {
            if (!Number.isInteger(deadline.turns) || deadline.turns < 0) {
                add(errors, 'finalDeadline.turns', 'must be a non-negative integer or null');
            }
        }
        if (deadline.date !== null && deadline.date !== undefined && typeof deadline.date !== 'string') {
            add(errors, 'finalDeadline.date', 'must be a date string or null');
        }
        if (deadline.turns == null && deadline.date == null && season.sandbox !== true && season.playable !== false) {
            add(errors, 'finalDeadline.turns', 'a playable season needs a turns or date deadline');
        }
        if (!Object.hasOwn(deadline, 'turns') || !Object.hasOwn(deadline, 'date')) {
            add(errors, 'finalDeadline', 'must declare both turns and date (either may be null)');
        }
    }
    if (season.playable !== false && season.failureState === null) {
        add(errors, 'failureState', 'a playable season must declare a failure state');
    }

    if (season.id === 's1dark') {
        if (season.alt !== true) {
            add(errors, 'alt', 'S1Dark must be marked as an alternate season');
        }
        if (season.altOf !== 's1') {
            add(errors, 'altOf', 'S1Dark must declare altOf "s1"');
        }
        if (season.playerRole !== 'villain') {
            add(errors, 'playerRole', 'S1Dark must be a villain-POV season');
        }
        if (season.defaultPlayerCharacterId !== 's1dark.carol.bleeding-heart') {
            add(errors, 'defaultPlayerCharacterId', 'S1Dark defaults to Carol / Bleeding Heart');
        }
    }

    for (const field of ['manualOnly', 'altFormsAllowed']) {
        const value = season[field];
        if (!Array.isArray(value) || !isStringArray(value)) {
            add(errors, field, 'must be an array of registry ids');
            continue;
        }
        if (registryIndex) {
            value.forEach((id, index) => {
                const entry = registryIndex.byId[id];
                if (!entry) {
                    add(errors, `${field}[${index}]`, `unresolved registry id "${id}"`);
                } else if (entry.seasonId !== season.id) {
                    add(errors, `${field}[${index}]`, `"${id}" belongs to season "${entry.seasonId}"`);
                }
            });
        }
    }

    if (season.playable === false) {
        if (typeof season.auxiliaryBook !== 'string' || season.auxiliaryBook.length === 0) {
            add(errors, 'auxiliaryBook', 'non-playable seasons must name their auxiliary book');
        }
        if (typeof season.notPlayableReason !== 'string' || season.notPlayableReason.length === 0) {
            add(errors, 'notPlayableReason', 'non-playable seasons must explain why');
        }
    }

    return result(errors);
}

/**
 * Human-readable entry-menu view of a season definition.
 */
export function toEntryMenuCard(season) {
    if (!isObject(season)) {
        return null;
    }
    return {
        id: season.id,
        title: season.title,
        era: season.era,
        alt: season.alt === true,
        playable: season.playable !== false,
        playerRole: season.playerRole,
        defaultPlayerCharacterId: season.defaultPlayerCharacterId ?? null,
        premise: season.premise,
        notice: season.playable === false
            ? season.notPlayableReason ?? 'Auxiliary data present — coming later'
            : season.alt === true && season.playerRole === 'villain'
                ? `Villain POV — play as ${season.defaultPlayerCharacterId ?? 'the season villain'}`
                : null,
    };
}

/**
 * Resolve the active roster against the registry.
 *
 * @returns {Array<{ characterId: string, formId: string, character: object, form: object, locationId: string|null }>}
 */
export function resolveSeasonRoster(season, registry) {
    const index = buildRegistryIndex(registry);
    return (season?.roster ?? []).map((member) => {
        const character = index.byId[member.characterId];
        const form = index.byId[member.formId];
        if (!character || !form) {
            throw new Error(
                `Season "${season.id}" references an unresolved roster member "${member.characterId}"`,
            );
        }
        if (member.characterId !== member.formId) {
            const linked = form.altOf === member.characterId
                || (form.formGroup && form.formGroup === character.formGroup);
            if (!linked) {
                throw new Error(
                    `Season "${season.id}" roster form "${member.formId}" does not belong to "${member.characterId}"`,
                );
            }
        }
        return {
            characterId: member.characterId,
            formId: member.formId,
            character,
            form,
            locationId: member.locationId ?? null,
        };
    });
}

/** Season-scoped canon beats keyed by id. */
export function buildBeatIndex(season) {
    const byId = {};
    for (const beat of season?.canonBeats ?? []) {
        byId[beat.id] = beat;
    }
    return { byId, list: season?.canonBeats ?? [] };
}

/** Group a season's canon beats by act, in authored order. */
export function getSeasonBeatsByAct(season) {
    const byAct = Object.fromEntries(BEAT_ACTS.map((act) => [act, []]));
    for (const beat of season?.canonBeats ?? []) {
        byAct[beat.act]?.push(beat);
    }
    for (const act of BEAT_ACTS) {
        byAct[act].sort((a, b) => a.order - b.order);
    }
    return byAct;
}

export function getSeasonFaction(season, factionId) {
    return (season?.factions ?? []).find((faction) => faction.id === factionId) ?? null;
}

export function getSeasonThreats(season, rank = null) {
    const threats = season?.threats ?? [];
    return rank ? threats.filter((threat) => threat.rank === rank) : threats.slice();
}

export function isPlayableSeason(season) {
    return Boolean(season) && season.playable !== false;
}

export function assertPlayableSeason(season) {
    if (!isPlayableSeason(season)) {
        const reason = season?.notPlayableReason ?? 'Auxiliary data present — coming later.';
        throw new Error(`Season "${season?.id ?? 'unknown'}" is not yet playable: ${reason}`);
    }
    return season;
}

function normalizeSeasonIndex(document) {
    if (!isObject(document) || !Array.isArray(document.seasons)) {
        throw new Error('data/seasons/index.json must contain a seasons array');
    }
    const seen = new Set();
    return document.seasons.map((entry, index) => {
        if (!isObject(entry)) {
            throw new Error(`data/seasons/index.json: seasons[${index}] must be an object`);
        }
        const id = seasonIdOf(entry.id);
        if (!id) {
            throw new Error(`data/seasons/index.json: seasons[${index}].id must be non-empty`);
        }
        if (seen.has(id)) {
            throw new Error(`data/seasons/index.json: duplicate season id "${id}"`);
        }
        seen.add(id);
        const file = typeof entry.file === 'string'
            ? entry.file
            : SEASON_FILES[id] ?? `${id}.json`;
        if (file.includes('/') || file.includes('\\') || !file.endsWith('.json')) {
            throw new Error(`data/seasons/index.json: invalid file for season "${id}"`);
        }
        return {
            id,
            file,
            playable: entry.playable !== false,
        };
    });
}

/**
 * Read the generated season manifest.
 *
 * The manifest is written by `tools/build-data.mjs` so a new season appears in
 * the menu after dropping its folder/JSON and regenerating. The hardcoded
 * fallback keeps older installs working if the manifest cannot be fetched.
 */
export async function loadSeasonIndex({ fetchImpl = globalThis.fetch } = {}) {
    if (seasonIndex) {
        return seasonIndex;
    }
    if (seasonIndexInFlight) {
        return seasonIndexInFlight;
    }
    if (typeof fetchImpl !== 'function') {
        seasonIndex = SEASON_DEFINITION_IDS.map((id) => ({
            id,
            file: SEASON_FILES[id] ?? `${id}.json`,
            playable: PLAYABLE_SEASON_IDS.includes(id),
        }));
        return seasonIndex;
    }
    seasonIndexInFlight = (async () => {
        try {
            const response = await fetchImpl(SEASON_INDEX_URL.href);
            if (response && response.ok === false) {
                throw new Error(`HTTP ${response.status ?? 'unknown'}`);
            }
            seasonIndex = normalizeSeasonIndex(await response.json());
        } catch (error) {
            seasonIndex = SEASON_DEFINITION_IDS.map((id) => ({
                id,
                file: SEASON_FILES[id] ?? `${id}.json`,
                playable: PLAYABLE_SEASON_IDS.includes(id),
            }));
        }
        return seasonIndex;
    })().finally(() => {
        seasonIndexInFlight = null;
    });
    return seasonIndexInFlight;
}

async function fetchSeasonDocument(id, { fetchImpl = globalThis.fetch } = {}) {
    const entries = await loadSeasonIndex({ fetchImpl });
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) {
        throw new Error(`Unknown season id "${id}"`);
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadSeason: no fetch implementation is available');
    }
    const url = new URL(`../../data/seasons/${entry.file}`, import.meta.url);
    const response = await fetchImpl(url.href);
    if (response && response.ok === false) {
        throw new Error(`loadSeason("${id}"): HTTP ${response.status ?? 'unknown'}`);
    }
    const document = await response.json();
    return { document, url };
}

async function loadContext({ fetchImpl, registry, factions, locations, districts }) {
    const [loadedRegistry, loadedFactions, loadedLocations, loadedDistricts] = await Promise.all([
        registry ?? loadRegistry({ fetchImpl }),
        factions ?? loadFactions({ fetchImpl }),
        locations ?? loadLocations({ fetchImpl }),
        districts ?? loadDistricts({ fetchImpl }),
    ]);
    return {
        registry: loadedRegistry,
        factions: loadedFactions,
        locations: loadedLocations,
        districts: loadedDistricts,
    };
}

/**
 * Load and validate one season.
 *
 * @param {string} id
 * @param {{ fetchImpl?: typeof fetch, registry?: object, factions?: object, locations?: object }} [options]
 * @returns {Promise<object>}
 */
export async function loadSeason(id, options = {}) {
    const { fetchImpl = globalThis.fetch } = options;
    if (cache.has(id)) {
        const cached = cache.get(id);
        assertPlayableSeason(cached);
        return cached;
    }
    if (!inFlight.has(id)) {
        inFlight.set(
            id,
            (async () => {
                const { document } = await fetchSeasonDocument(id, { fetchImpl });
                const context = await loadContext({ fetchImpl, ...options });
                const index = await loadSeasonIndex({ fetchImpl });
                const validation = validateSeasonDefinition(document, {
                    ...context,
                    seasonIds: index.map((entry) => entry.id),
                });
                if (!validation.ok) {
                    const details = validation.errors
                        .map((error) => `${error.path}: ${error.message}`)
                        .join('; ');
                    throw new Error(`loadSeason("${id}"): invalid season definition (${details})`);
                }
                cache.set(id, document);
                return document;
            })().finally(() => {
                inFlight.delete(id);
            }),
        );
    }
    const season = await inFlight.get(id);
    assertPlayableSeason(season);
    return season;
}

/**
 * Load every season definition, including the non-playable auxiliary entry.
 */
export async function loadSeasonDefinitions(options = {}) {
    const { fetchImpl = globalThis.fetch } = options;
    const index = await loadSeasonIndex({ fetchImpl });
    const results = await Promise.all(
        index.map(async (entry) => {
            if (cache.has(entry.id)) {
                return cache.get(entry.id);
            }
            const { document } = await fetchSeasonDocument(entry.id, options);
            return document;
        }),
    );
    const context = await loadContext(options);
    const byId = {};
    for (const season of results) {
        const validation = validateSeasonDefinition(season, {
            ...context,
            seasonIds: index.map((entry) => entry.id),
        });
        if (!validation.ok) {
            const details = validation.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ');
            throw new Error(`Invalid season definition "${season?.id}" (${details})`);
        }
        byId[season.id] = season;
        cache.set(season.id, season);
    }
    return byId;
}

/**
 * Entry-menu cards: every season in the generated manifest, including the
 * disabled auxiliary notice.
 */
export async function getSeasonEntryMenu(options = {}) {
    const seasons = await loadSeasonDefinitions(options);
    return Object.values(seasons).map(toEntryMenuCard);
}

export function clearSeasonsCache() {
    cache.clear();
    inFlight.clear();
    seasonIndex = null;
    seasonIndexInFlight = null;
}
