/**
 * Pure arrival summary for the travel feedback cues.
 *
 * The summary is derived from `WorldState` alone so it survives the map panel
 * being disposed and remounted (close → reopen, tab switch). A fresh travel
 * `result` may be supplied right after the move; without one the last travel
 * recorded in `flags.travel` is used.
 *
 * No DOM, no store access, no clocks: the caller passes the state it already
 * holds.
 */

import { describeEncounter, encounterKey, encounterNames } from '../flows/encounter.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function capitalise(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }
    return value[0].toUpperCase() + value.slice(1);
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {{
 *   result?: object|null,
 *   state?: object|null,
 *   season?: object|null,
 * }} options
 * @returns {null | {
 *   key: string,
 *   fromId: string|null,
 *   toId: string,
 *   destination: string,
 *   district: string|null,
 *   timeSlot: string|null,
 *   turns: number,
 *   encounterKey: string|null,
 *   hostiles: string[],
 *   hasEncounter: boolean,
 *   text: string,
 * }}
 */
export function buildArrivalSummary({ result = null, state = null } = {}) {
    if (!isObject(state)) {
        return null;
    }
    const fresh = result !== null && result !== undefined;
    // A rejected travel or an `alreadyThere` no-op is not an arrival. When a
    // result is supplied it is authoritative: never fall back to an older
    // arrival recorded in the state.
    if (fresh && (!isObject(result) || result.ok !== true || result.alreadyThere === true)) {
        return null;
    }
    if (fresh && !result.to) {
        return null;
    }
    // Prefer the post-travel state carried by a fresh result so a caller that
    // still holds the pre-travel state cannot mix the old scene into the card.
    const sourceState = fresh && isObject(result.state) ? result.state : state;
    const travel = isObject(sourceState.flags?.travel) ? sourceState.flags.travel : null;
    const toId = fresh ? result.to : travel?.lastTo ?? null;
    if (!toId) {
        return null;
    }
    // Only trust a flags record that describes this arrival; a previous trip's
    // timestamp must not become the key for a malformed fresh result.
    const travelMatches = isObject(travel) && travel.lastTo === toId;
    const fromId = (fresh ? result.from : null) ?? (travelMatches ? travel.lastFrom : null) ?? null;
    const location = sourceState.locations?.[toId] ?? null;
    const destination = (fresh ? result.toName : null) ?? location?.name ?? toId;
    const district = location?.district ?? null;
    const timeSlot = capitalise(sourceState.meta?.timeOfDay ?? null);
    const turns = fresh
        ? finiteNumber(result.turns, 0)
        : finiteNumber(travel?.lastTurns, 0);
    // `flags.travel.lastAt` is the durable arrival identity (`Date.now` at the
    // move), so it wins on both the fresh and remount paths. `meta.turn` is the
    // fallback when a state predates the flags record.
    const keyTurn = (travelMatches ? travel.lastAt : null)
        ?? sourceState.meta?.turn
        ?? state.meta?.turn
        ?? '';
    const key = `travel:${fromId ?? ''}:${toId}:${keyTurn}`;

    // `describeEncounter` already blanks an encounter recorded for a different
    // location (a stale record after a failed cast refresh). Reuse that guard
    // instead of reading `scene.encounter` raw.
    const encounter = sourceState.scene?.encounter ?? null;
    const hasEncounter = describeEncounter(sourceState, encounter).length > 0;
    const hostiles = hasEncounter ? encounterNames(sourceState, encounter) : [];
    const encounterId = hasEncounter ? encounterKey(encounter) : null;

    const slotPhrase = timeSlot ? `during the ${timeSlot.toLowerCase()}` : 'now';
    const heading = district ? `${destination}, ${district}` : destination;
    const encounterSentence = hasEncounter
        ? `${hostiles.join(', ')} ${hostiles.length === 1 ? 'is' : 'are'} present.`
        : 'No hostiles detected.';
    const text = `You arrive at ${heading}${district ? ',' : ''} ${slotPhrase}. ${encounterSentence}`;

    return {
        key,
        fromId: fromId ?? null,
        toId,
        destination,
        district,
        timeSlot,
        turns,
        encounterKey: encounterId,
        hostiles,
        hasEncounter,
        text,
    };
}
