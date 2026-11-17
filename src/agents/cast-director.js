/**
 * Cast Director.
 *
 * The director is a pure planner: it reads a WorldState and returns reducer
 * events. It never imports `src/state/**` and never mutates the document it is
 * given. The deterministic cast is always available; the optional agent pass can
 * only add arrivals, departures, and offscreen moves that survive normalization.
 */

import {
    buildFormIndex,
    isCastEligible,
    selectExclusiveCast,
} from '../data/forms.js';
import { AgentAbortedError } from './client.js';

export const CAST_DIRECTOR_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['present', 'arrivals', 'departures', 'offscreenMoves', 'rationale'],
    properties: {
        present: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
        },
        arrivals: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
        },
        departures: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
        },
        offscreenMoves: {
            type: 'array',
            maxItems: 10,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['characterId', 'locationId'],
                properties: {
                    characterId: { type: 'string' },
                    locationId: { type: 'string' },
                },
            },
        },
        rationale: { type: 'string', maxLength: 600 },
    },
});

const MAX_PROMPT_POOL = 60;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
    return asArray(value).filter((item) => typeof item === 'string' && item.length > 0);
}

function characterPool(state, season, formIndex, manualPins = []) {
    const playerCharacterId = state?.player?.characterId ?? null;
    const rosterIds = new Set(
        asArray(season?.roster)
            .map((member) => member?.characterId)
            .filter((id) => typeof id === 'string' && id.length > 0),
    );
    const manualIds = new Set(
        asStringArray(state?.flags?.manualCharacters),
    );

    const pool = Object.values(state?.characters ?? {}).filter((character) => (
        isObject(character)
        && isCastEligible(character, { playerCharacterId })
        && (rosterIds.has(character.charId) || manualIds.has(character.charId))
    ));
    pool.sort((a, b) => String(a.charId).localeCompare(String(b.charId)));
    return selectExclusiveCast(pool, formIndex, { prefer: manualPins });
}

function threatNamesAt(state, locationId) {
    const location = state?.locations?.[locationId] ?? null;
    const names = [];
    for (const threat of asArray(state?.threats)) {
        if (!isObject(threat) || typeof threat.name !== 'string') {
            continue;
        }
        const faction = threat.sourceFactionId
            ? state?.factions?.[threat.sourceFactionId] ?? null
            : null;
        const factionHere = threat.status === 'active' && (
            faction?.headquartersLocationId === locationId
            || (location?.factionId && location.factionId === threat.sourceFactionId)
        );
        if (threat.locationId === locationId || factionHere) {
            names.push(threat.name);
        }
    }
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Deterministic, NPC-only cast for one location.
 *
 * @returns {{
 *   present: string[],
 *   residents: object[],
 *   availablePool: object[],
 *   threatsHere: string[],
 *   pinned: string[],
 *   removed: string[],
 *   notes: string[],
 *   locationId: string|null,
 * }}
 */
export function buildDeterministicCast({
    state,
    season,
    formIndex = null,
    locationId = state?.scene?.locationId ?? null,
    manualPins = [],
    manualRemovals = [],
} = {}) {
    const pins = asStringArray(manualPins);
    const removals = new Set(asStringArray(manualRemovals));
    const availablePool = characterPool(state, season, formIndex, pins);
    const poolIds = new Set(availablePool.map((character) => character.charId));
    const pinned = pins.filter((id) => poolIds.has(id));
    const removed = [...removals].filter((id) => poolIds.has(id));
    const residents = locationId
        ? availablePool.filter((character) => character.locationId === locationId)
        : [];

    const presentIds = new Set(
        residents
            .map((character) => character.charId)
            .filter((id) => !removals.has(id)),
    );
    for (const id of pinned) {
        if (!removals.has(id)) {
            presentIds.add(id);
        }
    }

    const presentCharacters = [...presentIds]
        .map((id) => state?.characters?.[id] ?? null)
        .filter((character) => character !== null);
    const present = selectExclusiveCast(presentCharacters, formIndex, { prefer: pins })
        .map((character) => character.charId);

    const notes = [];
    if (pinned.length > 0) {
        notes.push(`pinned: ${pinned.join(', ')}`);
    }
    if (removed.length > 0) {
        notes.push(`removed: ${removed.join(', ')}`);
    }

    return {
        present,
        residents,
        availablePool,
        threatsHere: threatNamesAt(state, locationId),
        pinned,
        removed,
        notes,
        locationId,
    };
}

/** Standalone deterministic fallback used by callers that do not want the factory. */
export function deterministic(request = {}) {
    return buildDeterministicCast({
        state: request.state,
        season: request.season,
        formIndex: request.formIndex ?? null,
        locationId: request.locationId ?? request.state?.scene?.locationId ?? null,
        manualPins: request.manualPins ?? request.state?.flags?.castDirector?.manualPins ?? [],
        manualRemovals: request.manualRemovals
            ?? request.state?.flags?.castDirector?.manualRemovals
            ?? [],
    });
}

function poolCharacters(state, pool) {
    const list = asArray(pool);
    return list
        .map((item) => (typeof item === 'string' ? state?.characters?.[item] ?? null : item))
        .filter((character) => isObject(character));
}

function displayName(character) {
    return character?.displayName ?? character?.charId ?? 'unknown';
}

function locationLabel(state, locationId) {
    const location = state?.locations?.[locationId] ?? null;
    if (!location) {
        return String(locationId ?? 'unknown');
    }
    return location.district ? `${location.name}, ${location.district}` : location.name;
}

/**
 * Deterministic prompt text. No LLM call and no clock use.
 */
export function buildCastDirectorPrompt({
    state,
    season,
    locationId,
    deterministic: deterministicCast,
    pool = null,
    formGroups = null,
    formIndex = null,
    manualPins = [],
    manualRemovals = [],
} = {}) {
    const location = state?.locations?.[locationId] ?? null;
    const characters = poolCharacters(state, pool ?? deterministicCast?.availablePool ?? []);
    const presentIds = asStringArray(deterministicCast?.present);
    const presentNames = presentIds.map((id) => displayName(state?.characters?.[id]));
    const pins = asStringArray(manualPins);
    const removals = asStringArray(manualRemovals);

    const lines = [];
    lines.push(`# Neo Terra Cast Director — ${season?.title ?? season?.id ?? 'Season'}`);
    lines.push('');
    lines.push('## Scene');
    lines.push(`Location: ${locationLabel(state, locationId)} (${String(locationId)})`);
    lines.push(`Time: ${state?.meta?.timeOfDay ?? 'unknown'}${state?.meta?.inGameDate ? ` — ${state.meta.inGameDate}` : ''}`);
    lines.push(`Combat: ${state?.meta?.inCombat === true ? 'yes' : 'no'}`);
    lines.push(`Present now: ${presentNames.length > 0 ? presentNames.join(', ') : 'nobody'}`);
    lines.push('');

    lines.push('## Allowed pool');
    if (characters.length === 0) {
        lines.push('(empty)');
    } else {
        for (const character of characters.slice(0, MAX_PROMPT_POOL)) {
            lines.push([
                character.charId,
                displayName(character),
                character.locationId ?? 'unknown',
                character.status ?? 'unknown',
                character.side ?? 'neutral',
                formIndex?.groupByMemberId?.[character.formId]?.id
                    ?? character.formGroup
                    ?? formGroups?.groupByMemberId?.[character.formId]?.id
                    ?? '-',
            ].join(' — '));
        }
    }
    lines.push('');

    lines.push('## Residents and threats');
    lines.push(`Residents: ${asArray(deterministicCast?.residents)
        .map((character) => displayName(character))
        .join(', ') || 'none'}`);
    lines.push(`Threats here: ${asStringArray(deterministicCast?.threatsHere).join(', ') || 'none'}`);
    lines.push(`Manual pins: ${pins.join(', ') || 'none'}`);
    lines.push(`Manual removals: ${removals.join(', ') || 'none'}`);
    lines.push('');

    lines.push('## Rules');
    lines.push('Only return character ids from the allowed pool.');
    lines.push('Never include the player.');
    lines.push('Never place two active forms from the same form group on stage.');
    lines.push('Every departure must have a matching offscreenMoves destination.');
    lines.push('Arrivals must be plausible from their current location.');
    lines.push('Departures and offscreen moves must name an existing location different from the scene.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(JSON.stringify(CAST_DIRECTOR_SCHEMA));

    return lines.join('\n');
}

function rejection(rejected, characterId, reason) {
    rejected.push({ characterId, reason });
}

function normalizeOffscreenMoves(value) {
    const moves = [];
    for (const move of asArray(value)) {
        if (!isObject(move)) {
            continue;
        }
        if (typeof move.characterId !== 'string' || typeof move.locationId !== 'string') {
            continue;
        }
        moves.push({ characterId: move.characterId, locationId: move.locationId });
    }
    return moves;
}

/**
 * Validate and translate raw director output into reducer events.
 *
 * Bad agent output never throws: out-of-pool ids, unknown locations, and
 * duplicate forms become rejection records. The returned cast is NPC-only.
 */
export function normalizeCastDirectorResult({
    result,
    state,
    season,
    formIndex = null,
    locationId = state?.scene?.locationId ?? null,
    deterministic: deterministicInput = null,
} = {}) {
    const deterministicCast = deterministicInput ?? buildDeterministicCast({
        state,
        season,
        formIndex,
        locationId,
    });
    const output = isObject(result) ? result : {};
    const pool = asArray(deterministicCast.availablePool);
    const poolIds = new Set(
        pool
            .map((item) => (typeof item === 'string' ? item : item?.charId))
            .filter((id) => typeof id === 'string' && id.length > 0),
    );
    const playerCharacterId = state?.player?.characterId ?? null;
    const accepted = [];
    const rejected = [];
    const events = [];
    const movedIds = new Set();
    const pins = asStringArray(deterministicCast.pinned);

    function isPlayer(characterId) {
        return (typeof playerCharacterId === 'string' && characterId === playerCharacterId)
            || state?.characters?.[characterId]?.controlledBy === 'player';
    }

    function locationExists(id) {
        return typeof id === 'string' && Boolean(state?.locations?.[id]);
    }

    function emitMove(characterId, destinationId) {
        if (movedIds.has(characterId)) {
            return false;
        }
        movedIds.add(characterId);
        events.push({
            type: 'MOVE_CHARACTER',
            characterId,
            locationId: destinationId,
        });
        return true;
    }

    const offscreenDestinations = new Map();
    for (const move of normalizeOffscreenMoves(output.offscreenMoves)) {
        if (!offscreenDestinations.has(move.characterId)) {
            offscreenDestinations.set(move.characterId, move.locationId);
        }
    }

    // `present` is advisory. Validate it so out-of-pool and player ids surface
    // as rejections, but the authoritative cast comes from the final events.
    for (const characterId of asStringArray(output.present)) {
        if (isPlayer(characterId)) {
            rejection(rejected, characterId, 'player-controlled');
        } else if (!poolIds.has(characterId) || !state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'not-in-pool');
        }
    }

    for (const characterId of asStringArray(output.arrivals)) {
        if (isPlayer(characterId)) {
            rejection(rejected, characterId, 'player-controlled');
            continue;
        }
        if (asStringArray(deterministicCast.removed).includes(characterId)) {
            rejection(rejected, characterId, 'manually-removed');
            continue;
        }
        if (!poolIds.has(characterId) || !state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'not-in-pool');
            continue;
        }
        if (!locationExists(locationId)) {
            rejection(rejected, characterId, 'unknown-location');
            continue;
        }
        accepted.push(characterId);
        emitMove(characterId, locationId);
    }

    const departureIds = new Set();
    for (const characterId of asStringArray(output.departures)) {
        if (isPlayer(characterId)) {
            rejection(rejected, characterId, 'player-controlled');
            continue;
        }
        if (pins.includes(characterId)) {
            rejection(rejected, characterId, 'pinned');
            continue;
        }
        if (!poolIds.has(characterId) || !state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'not-in-pool');
            continue;
        }
        const currentlyPresent = state.characters[characterId].locationId === locationId
            || asStringArray(deterministicCast.present).includes(characterId);
        if (!currentlyPresent) {
            rejection(rejected, characterId, 'not-present');
            continue;
        }
        const destinationId = offscreenDestinations.get(characterId) ?? null;
        if (!destinationId) {
            rejection(rejected, characterId, 'no-destination');
            continue;
        }
        if (!locationExists(destinationId)) {
            rejection(rejected, characterId, 'unknown-location');
            continue;
        }
        if (destinationId === locationId) {
            rejection(rejected, characterId, 'invalid-destination');
            continue;
        }
        departureIds.add(characterId);
        accepted.push(characterId);
        emitMove(characterId, destinationId);
    }

    for (const move of normalizeOffscreenMoves(output.offscreenMoves)) {
        const { characterId, locationId: destinationId } = move;
        if (departureIds.has(characterId) || movedIds.has(characterId)) {
            continue;
        }
        if (isPlayer(characterId)) {
            rejection(rejected, characterId, 'player-controlled');
            continue;
        }
        if (pins.includes(characterId)) {
            rejection(rejected, characterId, 'pinned');
            continue;
        }
        if (asStringArray(deterministicCast.removed).includes(characterId)) {
            rejection(rejected, characterId, 'manually-removed');
            continue;
        }
        if (!poolIds.has(characterId) || !state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'not-in-pool');
            continue;
        }
        if (!locationExists(destinationId)) {
            rejection(rejected, characterId, 'unknown-location');
            continue;
        }
        if (destinationId === locationId) {
            rejection(rejected, characterId, 'invalid-destination');
            continue;
        }
        if (state.characters[characterId].locationId === locationId) {
            rejection(rejected, characterId, 'not-offscreen');
            continue;
        }
        accepted.push(characterId);
        emitMove(characterId, destinationId);
    }

    // Authoritative present: deterministic base + applied moves + pins, minus
    // manual removals. The player is never part of the NPC cast.
    const presentIds = new Set(
        asStringArray(deterministicCast.present)
            .filter((id) => !asStringArray(deterministicCast.removed).includes(id)),
    );
    for (const event of events) {
        if (event.locationId === locationId) {
            presentIds.add(event.characterId);
        } else {
            presentIds.delete(event.characterId);
        }
    }
    for (const pin of pins) {
        if (poolIds.has(pin)) {
            presentIds.add(pin);
        }
    }
    for (const characterId of asStringArray(deterministicCast.removed)) {
        presentIds.delete(characterId);
    }
    if (typeof playerCharacterId === 'string') {
        presentIds.delete(playerCharacterId);
    }

    const requestedPresent = [...presentIds]
        .map((id) => state?.characters?.[id] ?? null)
        .filter((character) => character !== null);
    const exclusivePresent = selectExclusiveCast(requestedPresent, formIndex, { prefer: pins })
        .map((character) => character.charId);
    const exclusiveSet = new Set(exclusivePresent);
    for (const characterId of presentIds) {
        if (!exclusiveSet.has(characterId)) {
            rejection(rejected, characterId, 'form-exclusive');
        }
    }
    for (const characterId of exclusivePresent) {
        if (!accepted.includes(characterId)) {
            accepted.push(characterId);
        }
    }

    return {
        accepted,
        rejected,
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 600) : '',
        events,
        cast: {
            present: exclusivePresent,
            pinned: pins,
            removed: asStringArray(deterministicCast.removed),
            threatsHere: asStringArray(deterministicCast.threatsHere),
        },
    };
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break a cast plan.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/**
 * Thin runner wrapper. `plan` is synchronous and `run` performs one schema-
 * validated agent pass with a deterministic fallback.
 */
export function createCastDirector({
    runner = null,
    client = null,
    getSettings = null,
    formIndex = null,
    formGroups = null,
    log = null,
    now = Date.now,
} = {}) {
    function requestFormIndex(request) {
        if (request?.formIndex) {
            return request.formIndex;
        }
        if (formIndex) {
            return formIndex;
        }
        if (request?.registry && (request?.formGroups ?? formGroups)) {
            return buildFormIndex(request.registry, request.formGroups ?? formGroups);
        }
        return null;
    }

    function prepare(request = {}) {
        const state = request.state ?? null;
        const season = request.season ?? null;
        const index = requestFormIndex(request);
        const locationId = request.locationId ?? state?.scene?.locationId ?? null;
        const manualPins = request.manualPins
            ?? state?.flags?.castDirector?.manualPins
            ?? [];
        const manualRemovals = request.manualRemovals
            ?? state?.flags?.castDirector?.manualRemovals
            ?? [];
        const cast = buildDeterministicCast({
            state,
            season,
            formIndex: index,
            locationId,
            manualPins,
            manualRemovals,
        });
        const prompt = buildCastDirectorPrompt({
            state,
            season,
            locationId,
            deterministic: cast,
            pool: cast.availablePool,
            formGroups: request.formGroups ?? formGroups,
            formIndex: index,
            manualPins,
            manualRemovals,
        });
        return {
            state,
            season,
            formIndex: index,
            locationId,
            manualPins,
            manualRemovals,
            deterministic: cast,
            prompt,
        };
    }

    function normalize(prepared, result) {
        return normalizeCastDirectorResult({
            result,
            state: prepared.state,
            season: prepared.season,
            formIndex: prepared.formIndex,
            locationId: prepared.locationId,
            deterministic: prepared.deterministic,
        });
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        if (typeof request.propose === 'function') {
            const proposed = request.propose({
                prompt: prepared.prompt,
                schema: CAST_DIRECTOR_SCHEMA,
            });
            return {
                ...normalize(prepared, proposed),
                source: 'agent',
                deterministic: prepared.deterministic,
                prompt: prepared.prompt,
            };
        }
        return {
            ...normalize(prepared, null),
            source: 'deterministic',
            deterministic: prepared.deterministic,
            prompt: prepared.prompt,
        };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        const settings = (typeof getSettings === 'function' ? getSettings() : request.settings) ?? {};
        const enabled = settings?.agents?.castDirector?.enabled !== false;

        if (!enabled || typeof runner?.runAgent !== 'function') {
            return {
                ...normalize(prepared, null),
                source: 'deterministic',
                deterministic: prepared.deterministic,
                prompt: prepared.prompt,
            };
        }

        try {
            const response = await runner.runAgent({
                agentId: 'castDirector',
                prompt: prepared.prompt,
                schema: CAST_DIRECTOR_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            return {
                ...normalize(prepared, result),
                source: 'agent',
                deterministic: prepared.deterministic,
                prompt: prepared.prompt,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Cast Director agent failed; using the deterministic cast', error);
            return {
                ...normalize(prepared, null),
                source: 'deterministic',
                deterministic: prepared.deterministic,
                prompt: prepared.prompt,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, deterministic: buildDeterministicCast };
}
