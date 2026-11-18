/**
 * Deterministic encounter detection.
 *
 * An encounter is a hostile situation at the player's location: at least one
 * living character on the opposing side, or an active threat present in the
 * area. It is derived from the world state, never authored, and it is a *scene*
 * fact — an encounter does not start combat and does not block travel.
 *
 * Pure module: no DOM, no SillyTavern globals, no agent calls.
 */

/** The side that opposes a player side. Neutrals oppose nobody. */
export const OPPOSITE_SIDE = Object.freeze({
    hero: 'villain',
    villain: 'hero',
});

/**
 * Player side for encounter purposes. Only S1Dark's villain POV flips it; a
 * neutral or custom player is treated as a hero, which is the season default.
 */
export function playerSideFor(playerRole) {
    return playerRole === 'villain' ? 'villain' : 'hero';
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when a fight is already running (`scene.combat` or the legacy flag). */
export function isCombatActive(state) {
    return isObject(state?.scene?.combat) || state?.meta?.inCombat === true;
}

function asStringList(value) {
    return Array.isArray(value)
        ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))]
        : [];
}

/**
 * Detect a hostile arrival at the current location.
 *
 * Rule:
 *   active combat                                    -> null
 *   opposing = living characters on the opposite side -> encounter
 *   plus any active threat names at this location
 *   nothing on either list                           -> null
 *
 * @param {{
 *   state: object,
 *   present?: string[]|object[]|null,
 *   threatNames?: string[]|null,
 *   locationId?: string|null,
 *   playerRole?: string|null,
 *   source?: 'travel'|'scene',
 * }} options
 * @returns {null | {
 *   locationId: string|null,
 *   characterIds: string[],
 *   threatNames: string[],
 *   source: 'travel'|'scene',
 * }}
 */
export function detectEncounter({
    state,
    present = null,
    threatNames = null,
    locationId = null,
    playerRole = null,
    source = 'scene',
} = {}) {
    if (!isObject(state) || isCombatActive(state)) {
        return null;
    }
    const ids = Array.isArray(present) ? present : (Array.isArray(state.scene?.present) ? state.scene.present : []);
    const player = state.player ?? {};
    const playerSide = playerSideFor(playerRole ?? state.playerRole);
    const opposingSide = OPPOSITE_SIDE[playerSide] ?? null;
    const characterIds = [];
    for (const entry of ids) {
        const characterId = typeof entry === 'string' ? entry : entry?.charId;
        if (typeof characterId !== 'string' || characterId.length === 0) {
            continue;
        }
        if (characterId === player.characterId) {
            continue;
        }
        const character = state.characters?.[characterId] ?? null;
        if (!character || character.controlledBy === 'player') {
            continue;
        }
        if (character.alive === false) {
            continue;
        }
        if (opposingSide && character.side === opposingSide) {
            characterIds.push(characterId);
        }
    }
    const threats = asStringList(threatNames);
    if (characterIds.length === 0 && threats.length === 0) {
        return null;
    }
    return {
        locationId: locationId ?? state.scene?.locationId ?? null,
        characterIds: [...new Set(characterIds)],
        threatNames: threats,
        source: source === 'travel' ? 'travel' : 'scene',
    };
}

/** Names for an encounter: characters first, then threat names. */
export function encounterNames(state, encounter) {
    if (!isObject(encounter)) {
        return [];
    }
    const names = asStringList(
        Array.isArray(encounter.characterIds)
            ? encounter.characterIds.map((characterId) => (
                state?.characters?.[characterId]?.displayName ?? characterId
            ))
            : [],
    );
    return [...names, ...asStringList(encounter.threatNames)];
}

/**
 * One short, deterministic paragraph for the arrival text. Names and threat
 * names only: no abilities, numbers, or invented outcomes.
 */
/**
 * One short, deterministic paragraph for the arrival text. Names and threat
 * names only: no abilities, numbers, or invented outcomes. An encounter
 * recorded for a different location (a stale record after a failed cast
 * refresh) is ignored so the arrival never names absent hostiles.
 */
export function describeEncounter(state, encounter) {
    if (isObject(encounter)
        && typeof encounter.locationId === 'string'
        && typeof state?.scene?.locationId === 'string'
        && encounter.locationId !== state.scene.locationId) {
        return '';
    }
    const names = encounterNames(state, encounter);
    if (names.length === 0) {
        return '';
    }
    return `Hostile presence: ${names.join(', ')}.`;
}

/** Stable identity for an encounter, used by the UI's "avoided" marker. */
export function encounterKey(encounter) {
    if (!isObject(encounter)) {
        return null;
    }
    const characters = asStringList(encounter.characterIds).slice().sort();
    const threats = asStringList(encounter.threatNames).slice().sort();
    if (characters.length === 0 && threats.length === 0) {
        return null;
    }
    return [
        encounter.locationId ?? 'unknown',
        characters.join(','),
        threats.join(','),
    ].join('|');
}
