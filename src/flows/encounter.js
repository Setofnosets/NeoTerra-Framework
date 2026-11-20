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

import { rollD20 } from '../combat/resolver.js';

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

/* ------------------------------------------------------------------ */
/* Notice and ambush (deterministic perception check)                  */
/* ------------------------------------------------------------------ */

/**
 * Ambush's entire mechanical penalty: the first combat round only offers
 * defensive/escape actions. The engine resolves no hostile action on its own.
 */
export const SURPRISED_COMBAT_ACTIONS = Object.freeze([
    'defend',
    'retreat',
    'talk-down',
    'surrender',
]);

/** True on the opening round of an ambush (`scene.combat.opening`). */
export function isSurprisedCombat(state) {
    const combat = state?.scene?.combat;
    return isObject(combat)
        && combat.opening === 'hostile'
        && (Number.isInteger(combat.round) ? combat.round : 0) === 0;
}

const THREAT_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
const AMBUSH_STATUSES = Object.freeze(['hostile', 'contested']);
const STEALTH_PATTERN = /stealth|sneak|shadow|silent|cloak|invisib|conceal|prowl/i;

/** A character's threat rank, used before the stable id tie-break. */
export function threatRank(character) {
    const level = typeof character?.threatLevel === 'string'
        ? character.threatLevel.trim().toLowerCase()
        : '';
    return THREAT_RANK[level] ?? 0;
}

/** Does a name/list of abilities, skills, or traits code for stealth? */
export function hasStealthCoding(values) {
    return Array.isArray(values)
        && values.some((value) => typeof value === 'string' && STEALTH_PATTERN.test(value));
}

/**
 * Did the player arrive quietly? An explicit `stealth` flag wins; otherwise the
 * played character's abilities/skills/traits and the last travel ability are
 * scanned for a stealth keyword. No model and no hidden state: this is data.
 */
export function playerArrivedStealthy(state, stealth = null) {
    if (typeof stealth === 'boolean') {
        return stealth;
    }
    if (typeof stealth === 'number') {
        return stealth > 0;
    }
    const player = state?.player ?? {};
    if (hasStealthCoding(player.abilities)
        || hasStealthCoding(player.skills)
        || hasStealthCoding(player.traits)) {
        return true;
    }
    const lastAbility = state?.flags?.travel?.lastAbility;
    return typeof lastAbility === 'string' && STEALTH_PATTERN.test(lastAbility);
}

/** How much the player's stealth shifts the hostile perception roll (0-4). */
export function stealthBonus(state, stealth = null) {
    if (stealth === true) {
        return 4;
    }
    if (typeof stealth === 'number' && Number.isFinite(stealth)) {
        return Math.max(0, Math.min(4, Math.round(stealth)));
    }
    let bonus = 0;
    const player = state?.player ?? {};
    const lists = [player.abilities, player.skills, player.traits];
    for (const list of lists) {
        if (hasStealthCoding(list)) {
            bonus += 2;
        }
    }
    if (typeof state?.flags?.travel?.lastAbility === 'string'
        && STEALTH_PATTERN.test(state.flags.travel.lastAbility)) {
        bonus += 2;
    }
    return Math.min(4, bonus);
}

/**
 * The most threatening hostile in the encounter. Ties are broken by character
 * id (ascending, locale-independent) so a reload always names the same actor.
 * Threat-only encounters (no character ids) never notice: there is no actor.
 */
export function noticeActor(state, encounter) {
    const playerId = state?.player?.characterId ?? null;
    const ids = asStringList(Array.isArray(encounter?.characterIds) ? encounter.characterIds : [])
        .filter((id) => id !== playerId && id !== 'player')
        .filter((id) => {
            const character = state?.characters?.[id];
            return character
                && character.controlledBy !== 'player'
                && character.alive !== false;
        });
    if (ids.length === 0) {
        return null;
    }
    const ranked = ids.map((id) => ({
        id,
        rank: threatRank(state.characters?.[id]),
        side: state.characters?.[id]?.side ?? '',
    })).sort((left, right) => (
        right.rank - left.rank
        || (left.side < right.side ? -1 : left.side > right.side ? 1 : 0)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ));
    return ranked[0];
}

/**
 * Deterministic perception check for an arrival.
 *
 * - No encounter, active combat, `noticeFirst:false`, or a threat-only
 *   encounter -> null.
 * - The actor is the most threatening living hostile (threatLevel, then id).
 * - `die = rollD20(seed)`; `margin = die + threatRank - (8 + stealthBonus)`.
 * - `margin < 0`  -> the player gets the drop; no notice frame (null).
 * - `margin >= 0` -> `noticedFirst`.
 * - `margin >= 5` and the location is hostile/contested and `ambush` is on
 *   and the player did not arrive stealthily -> `ambush`.
 *
 * The seed is derived from chat, turn, and encounter identity by default, so a
 * reload of the same arrival reproduces the identical outcome.
 *
 * @returns {null | {
 *   noticedFirst: boolean, ambush: boolean, actorId: string,
 *   actorName: string, margin: number, tier: string, die: number,
 * }}
 */
export function detectNotice({
    state,
    encounter = null,
    seed = null,
    stealth = null,
    noticeFirst = true,
    ambush = true,
} = {}) {
    if (!isObject(state) || isCombatActive(state) || noticeFirst === false) {
        return null;
    }
    // An explicitly passed `null` means "no encounter"; only `undefined`
    // falls back to the persisted scene record.
    const target = encounter === undefined ? state.scene?.encounter ?? null : encounter;
    if (!isObject(target)) {
        return null;
    }
    const actor = noticeActor(state, target);
    if (!actor) {
        return null;
    }
    const stealthy = playerArrivedStealthy(state, stealth);
    if (stealthy) {
        return null;
    }
    const playerId = state.player?.characterId ?? 'player';
    const resolvedSeed = seed !== null && seed !== undefined
        ? seed
        : `${state.chatId ?? 'chat'}:${state.meta?.turn ?? 0}:${encounterKey(target)}`;
    const die = rollD20({
        seed: resolvedSeed,
        round: 0,
        actorId: actor.id,
        targetId: playerId,
        action: 'notice',
    });
    const margin = die + actor.rank - (8 + stealthBonus(state, stealth));
    const location = state.locations?.[state.scene?.locationId ?? ''] ?? null;
    const locationStatus = typeof location?.status === 'string' ? location.status : '';
    const strongSuccess = margin >= 5 || die === 20;
    const isAmbush = ambush !== false
        && strongSuccess
        && AMBUSH_STATUSES.includes(locationStatus);
    const tier = die === 20
        ? 'critical-success'
        : die === 1
            ? 'critical-fail'
            : margin >= 5
                ? 'strong-success'
                : margin >= 0
                    ? 'success'
                    : 'fail';
    if (margin < 0 && die !== 20) {
        return null;
    }
    return {
        noticedFirst: true,
        ambush: isAmbush,
        actorId: actor.id,
        actorName: state.characters?.[actor.id]?.displayName ?? actor.id,
        margin,
        die,
        tier,
        locationStatus,
    };
}

/**
 * One deterministic notice/ambush frame. Names and positions only: no numbers,
 * no outcomes, no state. The caller content-gates and posts it once.
 */
export function buildNoticeFrameText({ state, notice } = {}) {
    if (!isObject(notice) || !notice.noticedFirst) {
        return '';
    }
    const actor = notice.actorName ?? 'Someone';
    const location = state?.locations?.[state?.scene?.locationId ?? ''] ?? null;
    const place = location?.name ?? 'this place';
    if (notice.ambush) {
        return `${actor} springs the ambush before you can move at ${place}.`;
    }
    const cover = notice.locationStatus === 'hostile'
        ? `They already hold ${place}.`
        : notice.locationStatus === 'contested'
            ? `The ground at ${place} is contested, and they saw you first.`
            : `They catch sight of you near ${place}.`;
    return `${actor} spots you before you can act. ${cover}`;
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
