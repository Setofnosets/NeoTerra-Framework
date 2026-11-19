/**
 * WorldState document migrations.
 *
 * Migrations are pure: they clone the incoming document, preserve unknown
 * keys, and never downgrade a newer document. The reducer and store only ever
 * consume the current version.
 */

export const CURRENT_WORLD_STATE_VERSION = 2;

import { abilitySummaryLines } from '../data/card-facets.js';
import { isPlayerCharacter } from './selectors.js';
const STATUSES = Object.freeze([
    'active',
    'offscreen',
    'captured',
    'corrupted',
    'dead',
    'retired',
    'missing',
    'lost',
    'imprisoned',
]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asObject(value) {
    return isObject(value) ? value : {};
}

function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function asNullableString(value) {
    return typeof value === 'string' ? value : null;
}

function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function asInteger(value, fallback = 0) {
    return Number.isInteger(value) ? value : fallback;
}

function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * Normalize an unversioned (v0) or partially authored document into the v1
 * shape. Unknown keys survive this migration: the spread comes first.
 */
function migrateV0ToV1(raw) {
    const meta = asObject(raw.meta);
    const scene = asObject(raw.scene);
    const ending = asObject(raw.ending);
    const player = asObject(raw.player);
    const stamina = asObject(player.stamina);
    const willpower = asObject(player.willpower);
    const corruption = asObject(player.corruption);
    const playerIdentity = player.identity === 'canon' && typeof player.characterId === 'string'
        ? 'canon'
        : 'custom';

    return {
        ...raw,
        schemaVersion: 1,
        chatId: asString(raw.chatId, ''),
        seasonId: asString(raw.seasonId, 'sandbox'),
        mode: ['director', 'group', 'solo'].includes(raw.mode) ? raw.mode : 'director',
        meta: {
            ...meta,
            turn: Number.isInteger(meta.turn) ? meta.turn : Number(meta.turn) || 0,
            inGameDate: asNullableString(meta.inGameDate),
            timeOfDay: asString(meta.timeOfDay, 'evening'),
            sceneId: asString(meta.sceneId, 'opening'),
            inCombat: asBoolean(meta.inCombat),
            startedAt: Number.isFinite(meta.startedAt) ? meta.startedAt : 0,
        },
        arc: raw.arc === 'post-victory' ? 'post-victory' : 'season',
        ending: {
            ...ending,
            status: ['none', 'epilogue', 'continued', 'ended'].includes(ending.status)
                ? ending.status
                : 'none',
        },
        playerRole: ['hero', 'villain', 'neutral'].includes(raw.playerRole)
            ? raw.playerRole
            : 'neutral',
        player: {
            ...player,
            identity: playerIdentity,
            characterId: playerIdentity === 'canon' ? player.characterId : null,
            personaNotes: asString(player.personaNotes, ''),
            stamina: {
                current: asNumber(stamina.current, 100),
                max: asNumber(stamina.max, 100),
            },
            willpower: {
                current: asNumber(willpower.current, 100),
                max: asNumber(willpower.max, 100),
            },
            corruption: {
                ...corruption,
                stage: Number.isInteger(corruption.stage) ? corruption.stage : 0,
                source: asNullableString(corruption.source),
                progress: Number(corruption.progress) || 0,
            },
        },
        characters: asObject(raw.characters),
        locations: asObject(raw.locations),
        factions: asObject(raw.factions),
        threats: asArray(raw.threats),
        beats: asObject(raw.beats),
        badEnds: asObject(raw.badEnds),
        relationships: asArray(raw.relationships),
        recentEvents: asArray(raw.recentEvents),
        scene: {
            ...scene,
            locationId: asNullableString(scene.locationId),
            present: asArray(scene.present),
            combat: isObject(scene.combat) ? scene.combat : null,
            framing: asString(scene.framing, ''),
        },
        flags: asObject(raw.flags),
        log: asArray(raw.log),
    };
}

/**
 * v1 -> v2: fiction time and the clock hold. A v1 document only knew
 * `meta.turn`, so `storyTurn` starts equal to it. An existing clock block (a
 * document authored after the field was introduced) is preserved, including an
 * active hold.
 */
function migrateV1ToV2(raw) {
    const meta = asObject(raw.meta);
    const flags = asObject(raw.flags);
    const clock = asObject(flags.clock);
    const hold = asObject(clock.hold);
    const turn = Number.isInteger(meta.turn) ? meta.turn : (Number(meta.turn) || 0);
    const inGameDate = asNullableString(meta.inGameDate);
    return {
        ...raw,
        schemaVersion: 2,
        meta: {
            ...meta,
            storyTurn: Number.isInteger(meta.storyTurn) ? meta.storyTurn : turn,
        },
        flags: {
            ...flags,
            clock: {
                ...clock,
                hold: {
                    ...hold,
                    active: asBoolean(hold.active),
                    reason: typeof hold.reason === 'string' ? hold.reason : null,
                    sinceTurn: Number.isInteger(hold.sinceTurn) ? hold.sinceTurn : turn,
                    sinceDate: typeof hold.sinceDate === 'string' || hold.sinceDate === null
                        ? hold.sinceDate
                        : inGameDate,
                },
            },
        },
    };
}

/**
 * Versioned migration table. Keys are the *source* version; each function
 * returns the next version's document.
 */
export const WORLD_STATE_MIGRATIONS = Object.freeze({
    0: migrateV0ToV1,
    1: migrateV1ToV2,
});

function normalizeCharacterFacets(document) {
    if (!isObject(document?.characters)) {
        return document;
    }
    for (const character of Object.values(document.characters)) {
        if (!isObject(character)) {
            continue;
        }
        for (const field of ['abilities', 'skills', 'traits', 'goals', 'aliases', 'tags']) {
            if (!Array.isArray(character[field])) {
                character[field] = [];
            }
        }
        // `goalsSource` is optional. An old document with a non-empty goal list
        // may have been written by a tracker or the player, so it is treated as
        // live and protected from a card swap; only an empty list is certainly
        // card-sourced.
        if (character.goalsSource !== 'live' && character.goalsSource !== 'card') {
            character.goalsSource = Array.isArray(character.goals) && character.goals.length > 0
                ? 'live'
                : 'card';
        }
    }
    return document;
}

/**
 * Fill missing card-derived facets (skills, traits, abilities, goals, aliases,
 * tags) on a stored world from `profiles.json`. Fill-empty only and idempotent:
 * a live/tracker goal is never touched.
 *
 * @param {object} raw
 * @param {Record<string, object>|null} profiles
 * @returns {{ state: object, changed: boolean }}
 */
export function backfillCharacterFacets(raw, profiles) {
    if (!isObject(raw) || !isObject(raw.characters) || !isObject(profiles)) {
        return { state: raw, changed: false };
    }
    let changed = false;
    const characters = { ...raw.characters };
    for (const [id, character] of Object.entries(characters)) {
        if (!isObject(character)) {
            continue;
        }
        const profile = profiles[character.formId] ?? profiles[id] ?? null;
        if (!profile) {
            continue;
        }
        const next = { ...character };
        const fillList = (field, values) => {
            if (!Array.isArray(values) || values.length === 0) {
                return;
            }
            if (!Array.isArray(next[field]) || next[field].length === 0) {
                next[field] = values.slice();
                changed = true;
            }
        };
        fillList('skills', profile.skills);
        fillList('traits', profile.traits);
        fillList('abilities', abilitySummaryLines(profile.abilitySummary));
        fillList('aliases', profile.aliases);
        if (next.goalsSource !== 'live') {
            fillList('goals', profile.goals);
        }
        // An old world has no source marker. A non-empty goal list may be
        // tracker- or player-authored, so it is treated as live and protected;
        // only an empty list is safely card-sourced.
        if (next.goalsSource !== 'card' && next.goalsSource !== 'live') {
            next.goalsSource = Array.isArray(next.goals) && next.goals.length > 0 ? 'live' : 'card';
            changed = true;
        }
        characters[id] = next;
    }
    return {
        state: changed ? { ...raw, characters } : raw,
        changed,
    };
}

/**
 * Remove the played character from every presence array.
 *
 * Presence is NPC-only by construction, so a stored chat authored before that
 * rule may still list the player in `locations[].present` or `scene.present`.
 * This is a fill-only semantic cleanup: it is not a `schemaVersion` bump (the
 * document is already v2), it preserves the order of everything else, and a
 * clean document is returned untouched so a second run is a no-op.
 *
 * @param {object} document
 * @returns {object} the same document when clean, a clone when something changed
 */
export function stripPlayerFromPresence(document) {
    if (!isObject(document)) {
        return document;
    }
    const hasLocations = isObject(document.locations);
    const hasScenePresent = Array.isArray(document.scene?.present);
    if (!hasLocations && !hasScenePresent) {
        return document;
    }
    const changed = (list) => Array.isArray(list)
        && list.length !== list.filter((id) => !isPlayerCharacter(document, id)).length;

    const needsCleanup = (hasLocations
        && Object.values(document.locations).some((location) => changed(location?.present ?? null)))
        || (hasScenePresent && changed(document.scene.present));
    if (!needsCleanup) {
        return document;
    }

    const next = clone(document);
    if (isObject(next.locations)) {
        for (const location of Object.values(next.locations)) {
            if (isObject(location) && Array.isArray(location.present)) {
                location.present = location.present.filter((id) => !isPlayerCharacter(next, id));
            }
        }
    }
    if (isObject(next.scene) && Array.isArray(next.scene.present)) {
        next.scene.present = next.scene.present.filter((id) => !isPlayerCharacter(next, id));
    }
    return next;
}

/**
 * Migrate an arbitrary stored document to the current WorldState version.
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function migrateWorldState(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (!isObject(raw)) {
        throw new Error('Invalid WorldState document');
    }

    const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
    if (version > CURRENT_WORLD_STATE_VERSION) {
        // Same policy as settings: keep a newer document intact. Validation may
        // flag it, but a migration must never destroy user data.
        return clone(raw);
    }

    let document = clone(raw);
    let current = version;
    while (current < CURRENT_WORLD_STATE_VERSION) {
        const migration = WORLD_STATE_MIGRATIONS[current];
        if (typeof migration !== 'function') {
            break;
        }
        document = migration(document);
        current += 1;
        document.schemaVersion = current;
    }

    document.schemaVersion = CURRENT_WORLD_STATE_VERSION;
    document = stripPlayerFromPresence(document);
    return normalizeCharacterFacets(document);
}

/** True when a stored document needs migration. */
export function needsWorldStateMigration(raw) {
    if (!isObject(raw)) {
        return false;
    }
    const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
    return version < CURRENT_WORLD_STATE_VERSION;
}

/** Exposed for tests and future migration helpers. */
export const WORLD_STATE_STATUSES = STATUSES;
