/**
 * Scene helpers.
 *
 * Step 7 uses this module to describe a constructed world and to build the
 * deterministic opening scene from the chosen POV. Step 8 extends the same
 * module with scene transitions and cast direction.
 *
 * Everything here is pure and browser-safe: no DOM, no SillyTavern globals.
 */

import { buildDeterministicCast } from '../agents/cast-director.js';
import {
    assertStateFormExclusivity,
    buildFormIndex,
    selectExclusiveCast,
} from '../data/forms.js';
import { describeEncounter, detectEncounter } from './encounter.js';
import { validateWorldState } from '../state/world-state.js';

export const POV_LABELS = Object.freeze({
    hero: 'Hero POV',
    villain: 'Villain POV',
    neutral: 'Neutral POV',
});

export const PLAYER_ROLE_LABELS = Object.freeze({
    hero: 'Hero',
    villain: 'Villain',
    neutral: 'Neutral',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human label for a player role, tolerant of unknown values. */
export function getPovLabel(playerRole) {
    return POV_LABELS[playerRole] ?? POV_LABELS.neutral;
}

export function getPlayerRoleLabel(playerRole) {
    return PLAYER_ROLE_LABELS[playerRole] ?? PLAYER_ROLE_LABELS.neutral;
}

/** Name of the player's current identity (custom persona or canon character). */
export function getPlayerDisplayName(state) {
    const player = state?.player ?? {};
    if (player.displayName) {
        return player.displayName;
    }
    if (player.identity === 'canon' && typeof player.characterId === 'string') {
        return state?.characters?.[player.characterId]?.displayName ?? player.characterId;
    }
    return 'The Player';
}

/** NPC names on stage; the player-controlled character is never listed as cast. */
export function getSceneCastNames(state) {
    const present = Array.isArray(state?.scene?.present) ? state.scene.present : [];
    return present
        .filter((characterId) => characterId !== state?.player?.characterId)
        .map((characterId) => state?.characters?.[characterId]?.displayName ?? characterId);
}

/**
 * Build the opening scene text and its structured facts.
 *
 * The text is deterministic: the same state and season always produce the same
 * opening. The narrator may elaborate on it, but this is the canonical frame
 * written when a season starts.
 *
 * @param {{ state: object, season: object }} options
 */
export function buildOpeningScene({ state, season } = {}) {
    if (!isObject(state) || !isObject(season)) {
        throw new TypeError('buildOpeningScene requires a WorldState and a season definition');
    }

    const locationId = state.scene?.locationId ?? season.startLocationId ?? null;
    const location = locationId ? state.locations?.[locationId] ?? null : null;
    const playerRole = state.playerRole ?? season.playerRole ?? 'neutral';
    const povLabel = getPovLabel(playerRole);
    const playerName = getPlayerDisplayName(state);
    const nonCanon = state.flags?.nonCanon === true;
    const guest = state.flags?.guestCharacter ?? null;
    const castNames = getSceneCastNames(state);

    const heading = `${season.title} - ${season.era}`;
    const locationLine = location
        ? `Opening: ${location.name}${location.district ? `, ${location.district}` : ''}`
        : 'Opening: an unrecorded part of the city';
    let povSuffix = '';
    if (nonCanon) {
        povSuffix = ' - non-canon character: canon beats disabled';
    } else if (guest?.characterId) {
        povSuffix = ` - guest character: home season ${guest.homeSeasonId ?? 'unknown'} - canon beats adapt`;
    }
    const povLine = `POV: ${playerName} (${povLabel})${povSuffix}`;

    const lines = [heading, locationLine, povLine, ''];
    if (typeof season.premise === 'string' && season.premise.trim().length > 0) {
        lines.push(season.premise.trim());
        lines.push('');
    }
    if (castNames.length > 0) {
        lines.push(`Present: ${castNames.join(', ')}`);
        lines.push('');
    }
    const framing = state.scene?.framing;
    if (typeof framing === 'string' && framing.trim().length > 0 && framing.trim() !== season.premise) {
        lines.push(framing.trim());
        lines.push('');
    }
    lines.push(`The story begins on ${state.meta?.inGameDate ?? season.anchorDate ?? 'an unrecorded day'}.`);

    return {
        text: lines.join('\n').trim(),
        title: season.title,
        era: season.era,
        seasonId: season.id,
        locationId,
        locationName: location?.name ?? null,
        district: location?.district ?? null,
        playerRole,
        povLabel,
        playerName,
        playerIdentity: state.player?.identity ?? 'custom',
        playerCharacterId: state.player?.characterId ?? null,
        castNames,
        nonCanon,
        guest: guest?.characterId
            ? { characterId: guest.characterId, homeSeasonId: guest.homeSeasonId ?? null }
            : null,
    };
}

/**
 * Short human summary of the current scene for the shell/UI (not the prompt).
 */
export function describeScene(state) {
    if (!isObject(state)) {
        return null;
    }
    const locationId = state.scene?.locationId ?? null;
    const location = locationId ? state.locations?.[locationId] ?? null : null;
    return {
        turn: state.meta?.turn ?? 0,
        locationId,
        locationName: location?.name ?? null,
        district: location?.district ?? null,
        inCombat: state.meta?.inCombat === true,
        present: Array.isArray(state.scene?.present) ? state.scene.present.slice() : [],
        castNames: getSceneCastNames(state),
        framing: state.scene?.framing ?? '',
    };
}

/**
 * Deterministic arrival text for a location change (Step 14).
 *
 * The narrator may elaborate on this, but the frame is canonical: it names the
 * location and parent district, how the player got there, the bridges used, and
 * who is present. It never invents characters the cast does not contain.
 *
 * @param {{
 *   state: object,
 *   season?: object|null,
 *   from?: { id: string, name?: string }|null,
 *   travel?: { path?: string[], bridges?: string[], bridgeNames?: string[], turns?: number, ability?: string|null },
 * }} options
 */
export function buildLocationIntro({ state, season = null, from = null, travel = null } = {}) {
    if (!isObject(state)) {
        throw new TypeError('buildLocationIntro requires a WorldState');
    }
    const locationId = state.scene?.locationId ?? null;
    const location = locationId ? state.locations?.[locationId] ?? null : null;
    const name = location?.name ?? locationId ?? 'an unknown location';
    const district = location?.district ?? null;
    const factionId = location?.factionId ?? null;
    const factionName = factionId ? state.factions?.[factionId]?.name ?? factionId : null;
    const status = location?.status ?? null;
    const castNames = getSceneCastNames(state);
    const playerName = getPlayerDisplayName(state);
    const bridges = Array.isArray(travel?.bridgeNames) && travel.bridgeNames.length > 0
        ? travel.bridgeNames
        : Array.isArray(travel?.bridges)
            ? travel.bridges
            : [];
    const turns = Number.isFinite(travel?.turns) ? travel.turns : 0;
    const ability = typeof travel?.ability === 'string' ? travel.ability : null;
    // `arrival` is a move; `description` is the same text used for a first
    // look at a place (no origin).
    const reason = from?.id ? 'arrival' : 'description';

    const lines = [];
    const heading = district ? `${name}, ${district}` : name;
    const fromName = from?.name ?? (from?.id ? state.locations?.[from.id]?.name ?? from.id : null);
    if (fromName && fromName !== name) {
        const how = ability === 'teleport'
            ? 'by teleport'
            : ability === 'flight'
                ? 'by air'
                : ability === 'swim'
                    ? 'by water'
                    : bridges.length > 0
                        ? `across ${bridges.join(' and ')}`
                        : 'on foot';
        lines.push(`${playerName} arrives at ${heading} ${how} from ${fromName}.`);
    } else {
        lines.push(`${playerName} arrives at ${heading}.`);
    }
    if (turns > 0) {
        lines.push(`The trip takes ${turns} turn${turns === 1 ? '' : 's'}${bridges.length > 0 ? ` (via ${bridges.join(', ')})` : ''}.`);
    }
    if (status && status !== 'unknown') {
        lines.push(`The area is ${status}${factionName ? ` and controlled by ${factionName}` : ''}.`);
    } else if (factionName) {
        lines.push(`${factionName} holds this place.`);
    }
    if (castNames.length > 0) {
        lines.push(`Present: ${castNames.join(', ')}.`);
    } else {
        lines.push('Present: nobody you recognise.');
    }
    const encounterLine = describeEncounter(state, state.scene?.encounter);
    if (encounterLine.length > 0) {
        lines.push(encounterLine);
    }
    // A recorded perception fact is neutral prose: who saw the player first.
    const ambush = state.scene?.ambush;
    if (ambush && typeof ambush === 'object') {
        const actor = ambush.actorName ?? ambush.actorId ?? 'A hostile';
        lines.push(`${actor} sprang the ambush before you could move.`);
    } else if (state.scene?.noticed) {
        const noticed = state.scene.noticed;
        const actor = typeof noticed === 'object'
            ? noticed.actorName ?? noticed.actorId ?? 'A hostile'
            : String(noticed);
        lines.push(`${actor} noticed you first.`);
    }
    const framing = state.scene?.framing;
    if (typeof framing === 'string' && framing.trim().length > 0) {
        lines.push('');
        lines.push(framing.trim());
    }
    const seasonTitle = season?.title ?? state.seasonId ?? null;
    if (seasonTitle) {
        lines.push('');
        lines.push(`— ${seasonTitle}`);
    }

    return {
        text: lines.join('\n').trim(),
        reason,
        locationId,
        locationName: location?.name ?? null,
        district,
        factionId,
        factionName,
        status,
        castNames,
        playerName,
        from: from?.id ?? travel?.from ?? null,
        fromName,
        path: Array.isArray(travel?.path) ? travel.path.slice() : [],
        bridges: bridges.slice(),
        turns,
        ability,
    };
}

/* ------------------------------------------------------------------ */
/* Scene transitions and cast direction                                */
/* ------------------------------------------------------------------ */

function defaultWorldBookName(season, chatId) {
    const title = season?.title ?? season?.id ?? 'Neo Terra';
    const chat = typeof chatId === 'string' && chatId.length > 0 ? chatId : 'unlinked-chat';
    return `Neo Terra — ${title} — ${chat}`;
}

function isAbortError(error) {
    return error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED';
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a scene transition.
    }
}

function flagsFor(state) {
    return isObject(state?.flags?.castDirector) ? state.flags.castDirector : {};
}

/**
 * Scene transition flow.
 *
 * Applies cast events through the store, then persists the cast-director flags
 * back into `WorldState.flags` so pins and removals survive reloads. The world
 * book is best-effort: a failure never blocks a scene.
 */
export function createSceneFlow({
    store,
    season = null,
    registry = null,
    formIndex = null,
    formGroups = null,
    formRules = null,
    director = null,
    worldBook = null,
    getSettings = null,
    now = Date.now,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.dispatch !== 'function') {
        throw new TypeError('createSceneFlow requires a WorldState store');
    }

    const worldBookAdapter = worldBook;
    const clock = typeof now === 'function' ? now : Date.now;
    const resolvedFormIndex = formIndex
        ?? (registry && formGroups ? buildFormIndex(registry, formGroups) : null);

    function readState() {
        const state = store.get();
        if (!isObject(state)) {
            throw new Error('Scene flow requires a seeded WorldState');
        }
        return state;
    }

    function checkExclusivity(state) {
        try {
            assertStateFormExclusivity(state, resolvedFormIndex);
        } catch (error) {
            logWarning(log, 'Form exclusivity conflict; selecting one form deterministically', error);
        }
    }

    function deterministicCast(state, locationId, flags = flagsFor(state)) {
        return buildDeterministicCast({
            state,
            season,
            formIndex: resolvedFormIndex,
            locationId,
            manualPins: flags.manualPins ?? [],
            manualRemovals: flags.manualRemovals ?? [],
        });
    }

    function persistFlags(state, patch) {
        const current = flagsFor(state);
        const next = {
            ...state,
            flags: {
                ...(state.flags ?? {}),
                castDirector: {
                    ...current,
                    ...patch,
                },
            },
        };
        const validation = validateWorldState(next);
        if (!validation.ok) {
            const details = validation.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ');
            throw new Error(`Scene flow produced an invalid WorldState (${details})`);
        }
        return store.replace(next);
    }

    function castStateFrom(state) {
        const flags = flagsFor(state);
        const locationId = state.scene?.locationId ?? null;
        const cast = deterministicCast(state, locationId, flags);
        const poolIds = new Set(cast.availablePool.map((character) => character.charId));
        return {
            locationId,
            present: (Array.isArray(state.scene?.present) ? state.scene.present : [])
                .filter((characterId) => (
                    characterId !== state.player?.characterId
                    && poolIds.has(characterId)
                )),
            manualPins: Array.isArray(flags.manualPins) ? flags.manualPins.slice() : [],
            manualRemovals: Array.isArray(flags.manualRemovals) ? flags.manualRemovals.slice() : [],
            source: flags.source ?? 'deterministic',
            threatsHere: cast.threatsHere,
            encounter: isObject(state.scene?.encounter) ? state.scene.encounter : null,
        };
    }

    async function directorPass({
        state,
        locationId,
        runDirector = true,
        signal = null,
    }) {
        checkExclusivity(state);
        const flags = flagsFor(state);
        const manualPins = Array.isArray(flags.manualPins) ? flags.manualPins : [];
        const manualRemovals = Array.isArray(flags.manualRemovals) ? flags.manualRemovals : [];
        const fallback = deterministicCast(state, locationId, { manualPins, manualRemovals });

        if (runDirector === true && director && typeof director.run === 'function') {
            try {
                const result = await director.run({
                    state,
                    season,
                    formIndex: resolvedFormIndex,
                    registry,
                    formGroups,
                    formRules,
                    locationId,
                    manualPins,
                    manualRemovals,
                    signal,
                });
                if (isObject(result)) {
                    return {
                        events: Array.isArray(result.events) ? result.events : [],
                        rejected: Array.isArray(result.rejected) ? result.rejected : [],
                        source: typeof result.source === 'string' ? result.source : 'agent',
                        deterministic: result.deterministic ?? fallback,
                        directorRan: true,
                    };
                }
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                logWarning(log, 'Cast Director failed; using the deterministic cast', error);
            }
        }

        return {
            events: [],
            rejected: [],
            source: 'deterministic',
            deterministic: fallback,
            directorRan: false,
        };
    }

    function applyEvents(state, events) {
        let next = state;
        const applied = [];
        const failed = [];
        for (const event of Array.isArray(events) ? events : []) {
            if (!isObject(event) || event.type !== 'MOVE_CHARACTER') {
                continue;
            }
            try {
                next = store.dispatch(event);
                applied.push(event);
            } catch (error) {
                failed.push({ event, error: error?.message ?? String(error) });
                logWarning(log, `Could not apply cast event for "${event.characterId}"`, error);
            }
        }
        return { state: next, applied, failed };
    }

    function finalize({
        state,
        locationId,
        source,
        rejected = [],
        applied = [],
        encounterSource = 'scene',
        directorRan = false,
    }) {
        checkExclusivity(state);
        const flags = flagsFor(state);
        const manualPins = Array.isArray(flags.manualPins) ? flags.manualPins : [];
        const manualRemovals = Array.isArray(flags.manualRemovals) ? flags.manualRemovals : [];
        const cast = deterministicCast(state, locationId, { manualPins, manualRemovals });
        const poolIds = new Set(cast.availablePool.map((character) => character.charId));

        // `scene.present` is location-derived. Pins must physically be in the
        // scene and removals must physically leave it, or they would leak into
        // the rendered cast block on the next turn.
        let working = state;
        const appliedEvents = Array.isArray(applied) ? applied.slice() : [];
        const fallbackDestination = Object.keys(working.locations ?? {})
            .filter((id) => id !== locationId)
            .sort()[0] ?? null;

        for (const characterId of manualPins) {
            const character = working.characters?.[characterId];
            if (!character || character.locationId === locationId) {
                continue;
            }
            try {
                const event = { type: 'MOVE_CHARACTER', characterId, locationId };
                working = store.dispatch(event);
                appliedEvents.push(event);
            } catch (error) {
                logWarning(log, `Could not move pinned character "${characterId}"`, error);
            }
        }

        if (fallbackDestination) {
            for (const characterId of manualRemovals) {
                const character = working.characters?.[characterId];
                if (!character || character.locationId !== locationId) {
                    continue;
                }
                try {
                    const event = {
                        type: 'MOVE_CHARACTER',
                        characterId,
                        locationId: fallbackDestination,
                    };
                    working = store.dispatch(event);
                    appliedEvents.push(event);
                } catch (error) {
                    logWarning(log, `Could not move removed character "${characterId}"`, error);
                }
            }
        }

        const rawPresent = (Array.isArray(working.scene?.present) ? working.scene.present : [])
            .filter((characterId) => (
                characterId !== working.player?.characterId
                && poolIds.has(characterId)
                && !manualRemovals.includes(characterId)
            ))
            .map((characterId) => working.characters?.[characterId] ?? null)
            .filter(Boolean);
        const present = selectExclusiveCast(rawPresent, resolvedFormIndex, {
            prefer: manualPins,
        }).map((character) => character.charId);

        // The encounter is derived from the refreshed cast, not authored. It is
        // written in the same validated replace as the cast flags so a reload
        // (and the next prompt) sees the same situation.
        const encounter = detectEncounter({
            state: working,
            present,
            threatNames: cast.threatsHere,
            locationId,
            playerRole: working.playerRole ?? season?.playerRole ?? null,
            source: encounterSource,
        });
        const withEncounter = {
            ...working,
            scene: {
                ...(working.scene ?? {}),
                encounter,
            },
        };

        const persisted = persistFlags(withEncounter, {
            sceneId: working.meta?.sceneId ?? 'opening',
            locationId,
            turn: working.meta?.turn ?? 0,
            manualPins,
            manualRemovals,
            lastRunAt: clock(),
            source,
            // Only a real director pass advances the cadence markers; a plain
            // deterministic refresh must not make the next turn look "not due".
            ...(directorRan === true
                ? {
                    lastRunTurn: working.meta?.turn ?? 0,
                    lastLocationId: locationId,
                }
                : {}),
        });
        return {
            state: persisted,
            cast: {
                present,
                pinned: cast.pinned,
                removed: cast.removed,
                threatsHere: cast.threatsHere,
                encounter,
            },
            events: appliedEvents,
            rejected,
            source,
        };
    }

    async function initialize({ materialize = true } = {}) {
        const state = readState();
        const locationId = state.scene?.locationId ?? null;
        const flags = flagsFor(state);

        let worldBookResult = null;
        if (materialize && worldBookAdapter && typeof worldBookAdapter.ensure === 'function') {
            try {
                const settings = typeof getSettings === 'function' ? getSettings() : null;
                worldBookResult = await worldBookAdapter.ensure({
                    name: defaultWorldBookName(season, state.chatId),
                    season,
                    registry,
                    state,
                    settings,
                });
            } catch (error) {
                logWarning(log, 'World-book materialization failed during initialize', error);
            }
        }

        const result = finalize({
            state,
            locationId,
            source: flags.source ?? 'deterministic',
        });
        return { ...result, worldBook: worldBookResult };
    }

    async function enterScene({
        locationId,
        characterId = null,
        runDirector = true,
        signal = null,
    } = {}) {
        const initial = readState();
        if (!isObject(initial.locations?.[locationId])) {
            throw new Error(`Unknown scene location "${String(locationId)}"`);
        }

        const flags = flagsFor(initial);
        if (initial.scene?.locationId === locationId && runDirector !== true) {
            return {
                state: initial,
                cast: castStateFrom(initial),
                events: [],
                rejected: [],
                source: flags.source ?? 'deterministic',
            };
        }

        const canonPlayerId = initial.player?.identity === 'canon'
            ? initial.player.characterId
            : null;
        const moveCharacterId = characterId && canonPlayerId && characterId === canonPlayerId
            ? characterId
            : canonPlayerId;
        store.dispatch({
            type: 'SET_LOCATION',
            locationId,
            ...(moveCharacterId ? { characterId: moveCharacterId } : {}),
        });

        const state = store.get();
        const result = await directorPass({
            state,
            locationId,
            runDirector: runDirector === true,
            signal,
        });
        const applied = applyEvents(state, result.events);
        return finalize({
            state: applied.state,
            locationId,
            source: result.source,
            rejected: result.rejected,
            applied: applied.applied,
            directorRan: result.directorRan === true,
        });
    }

    async function refreshCast({ runDirector = false, signal = null, encounterSource = 'scene' } = {}) {
        const state = readState();
        const locationId = state.scene?.locationId ?? null;
        const result = await directorPass({
            state,
            locationId,
            runDirector: runDirector === true,
            signal,
        });
        const applied = applyEvents(state, result.events);
        return finalize({
            state: applied.state,
            locationId,
            source: result.source,
            rejected: result.rejected,
            applied: applied.applied,
            encounterSource,
            directorRan: result.directorRan === true,
        });
    }

    function validatePoolIds(state, ids, locationId) {
        const flags = flagsFor(state);
        const cast = deterministicCast(state, locationId, flags);
        const poolIds = new Set(cast.availablePool.map((character) => character.charId));
        const requested = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
        const valid = [...new Set(requested)].filter((id) => poolIds.has(id));
        const invalid = requested.filter((id) => !poolIds.has(id));
        if (invalid.length > 0) {
            logWarning(log, `Ignoring ids outside the cast pool: ${invalid.join(', ')}`);
        }
        return valid;
    }

    function setManualPins(ids) {
        const state = readState();
        const locationId = state.scene?.locationId ?? null;
        const flags = flagsFor(state);
        const pins = validatePoolIds(state, ids, locationId);
        const manualRemovals = (Array.isArray(flags.manualRemovals) ? flags.manualRemovals : [])
            .filter((id) => !pins.includes(id));
        let next = persistFlags(state, { manualPins: pins, manualRemovals });

        for (const characterId of pins) {
            if (next.characters?.[characterId]?.locationId === locationId) {
                continue;
            }
            try {
                next = store.dispatch({
                    type: 'MOVE_CHARACTER',
                    characterId,
                    locationId,
                });
            } catch (error) {
                logWarning(log, `Could not move pinned character "${characterId}"`, error);
            }
        }

        return finalize({
            state: next,
            locationId,
            source: flags.source ?? 'deterministic',
        });
    }

    function setManualRemovals(ids) {
        const state = readState();
        const locationId = state.scene?.locationId ?? null;
        const flags = flagsFor(state);
        const removals = validatePoolIds(state, ids, locationId);
        const manualPins = (Array.isArray(flags.manualPins) ? flags.manualPins : [])
            .filter((id) => !removals.includes(id));
        let next = persistFlags(state, { manualPins, manualRemovals: removals });

        const destinations = Object.keys(state.locations ?? {})
            .filter((id) => id !== locationId)
            .sort();
        const destinationId = destinations[0] ?? null;
        if (destinationId) {
            for (const characterId of removals) {
                if (next.characters?.[characterId]?.locationId !== locationId) {
                    continue;
                }
                try {
                    next = store.dispatch({
                        type: 'MOVE_CHARACTER',
                        characterId,
                        locationId: destinationId,
                    });
                } catch (error) {
                    logWarning(log, `Could not move removed character "${characterId}"`, error);
                }
            }
        }

        return finalize({
            state: next,
            locationId,
            source: flags.source ?? 'deterministic',
        });
    }

    function getCastState() {
        const state = store.get();
        if (!isObject(state)) {
            return {
                locationId: null,
                present: [],
                manualPins: [],
                manualRemovals: [],
                source: 'deterministic',
            };
        }
        return castStateFrom(state);
    }

    return {
        enterScene,
        refreshCast,
        initialize,
        setManualPins,
        setManualRemovals,
        getCastState,
    };
}
