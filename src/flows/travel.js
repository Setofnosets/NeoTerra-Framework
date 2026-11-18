/**
 * Travel flow.
 *
 * Step 9 only needed the contract that a completed location change notifies the
 * Storyline Tracker. Step 14 owns the real flow: validate the destination
 * against the bridge/region graph, compute a shortest path, advance in-game
 * time, move the player, notify the tracker with a travel context, recompute
 * the present cast, and build the location intro.
 *
 * The move itself is atomic: every reducer event (time, location, journal) is
 * applied through one `store.replace`, so a failed tracker pass can never leave
 * a half-moved world. Tracker failure is non-fatal by design.
 */

import {
    MAX_TRAVEL_HISTORY,
    buildTravelGraph,
    detectTravelAbilities,
    findTravelPath,
} from '../data/map.js';
import { buildClockTick, isClockHeld } from '../core/world-clock.js';
import { applyEventBatch } from './initiative.js';
import { buildLocationIntro } from './scene.js';

export const TRAVEL_EVENT_TAG = 'travel';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block travel.
    }
}

function isAbortError(error) {
    return error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED';
}

/**
 * Build the travel context the Storyline Tracker expects.
 *
 * @param {{
 *   from: string|null,
 *   to: string|null,
 *   path?: string[],
 *   bridges?: string[],
 *   bridgeNames?: string[],
 *   distance?: number,
 *   ability?: string|null,
 *   turns?: number,
 *   modes?: string[],
 * }} travel
 */
export function buildTravelInitiativeContext({
    from = null,
    to = null,
    path = [],
    bridges = [],
    bridgeNames = [],
    distance = 0,
    ability = null,
    turns = 0,
    modes = [],
} = {}) {
    const normalizedPath = Array.isArray(path)
        ? path.filter((id) => typeof id === 'string')
        : [];
    return {
        type: 'travel',
        from,
        to,
        path: normalizedPath,
        bridges: Array.isArray(bridges)
            ? bridges.filter((id) => typeof id === 'string')
            : [],
        // Display names for the same spans, so the arrival intro never shows
        // raw `bridge:` ids. Blank entries are dropped: a name is only useful
        // when it is non-empty.
        bridgeNames: Array.isArray(bridgeNames)
            ? bridgeNames.filter((name) => typeof name === 'string' && name.length > 0)
            : [],
        distance: Number.isFinite(distance) ? distance : 0,
        turns: Number.isFinite(turns) ? turns : 0,
        modes: Array.isArray(modes) ? modes.filter((mode) => typeof mode === 'string') : [],
        ability: typeof ability === 'string' ? ability : null,
        crossRegion: from !== null && to !== null && from !== to,
    };
}

/**
 * Create the hook used by the travel flow.
 *
 * `initiative` is `createInitiative(...)` from `./initiative.js`. A missing
 * initiative is not an error: travel still works without an agent pass.
 */
export function createTravelInitiativeHook({
    initiative = null,
    log = null,
} = {}) {
    function warn(message, error) {
        logWarning(log, message, error);
    }

    /**
     * Called after the move has been applied and the scene location updated.
     * Never throws: a tracker failure leaves the completed move intact.
     */
    async function afterTravel(travel = {}, { signal = null } = {}) {
        const context = buildTravelInitiativeContext(travel);
        if (!initiative || typeof initiative.afterLocationChange !== 'function') {
            return { ran: false, reason: 'no-initiative', context };
        }
        try {
            const result = await initiative.afterLocationChange({
                from: context.from,
                to: context.to,
                path: context.path,
                travel: context,
                signal,
            });
            return { ...result, context };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            warn('Travel initiative failed; the move stands', error);
            return {
                ran: false,
                reason: 'failed',
                error: error?.message ?? String(error),
                context,
            };
        }
    }

    return { afterTravel, buildContext: buildTravelInitiativeContext };
}

/**
 * Standalone helper for callers that already have an initiative but only want
 * a one-line hook.
 */
export async function notifyTravel(initiative, travel = {}, options = {}) {
    return createTravelInitiativeHook({ initiative }).afterTravel(travel, options);
}

/** Combat state check that accepts both `meta.inCombat` and `scene.combat`. */
export function isTravelBlockedByCombat(state) {
    return state?.meta?.inCombat === true || isObject(state?.scene?.combat);
}

function asStringList(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/**
 * Abilities the player may use to bypass a blocked ground route. A canonical
 * player is mirrored in `state.player`, so reading the mirror covers both the
 * custom persona and the played character.
 */
export function getPlayerTravelAbilities(state) {
    const player = state?.player ?? {};
    return detectTravelAbilities({
        abilities: asStringList(player.abilities),
        skills: asStringList(player.skills),
        traits: asStringList(player.traits),
    });
}

function travelSummary({ fromName, toName, turns, bridges, ability }) {
    const parts = [`Travelled from ${fromName} to ${toName}`];
    if (bridges.length > 0) {
        parts.push(`via ${bridges.join(', ')}`);
    }
    if (ability) {
        parts.push(`by ${ability}`);
    }
    parts.push(`(${turns} turn${turns === 1 ? '' : 's'})`);
    return `${parts.join(' ')}.`;
}

/**
 * @param {{
 *   store: object,
 *   season?: object,
 *   scene?: object|null,
 *   sources?: object|null,
 *   loadSources?: Function|null,
 *   initiative?: object|null,
 *   getSettings?: Function|null,
 *   now?: Function,
 *   log?: Function|object|null,
 * }} options
 */
export function createTravelFlow({
    store,
    season = null,
    scene = null,
    sources = null,
    loadSources = null,
    initiative = null,
    getSettings = null,
    now = Date.now,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('createTravelFlow requires a WorldState store');
    }
    const clock = typeof now === 'function' ? now : Date.now;
    const hook = createTravelInitiativeHook({ initiative, log });

    function readState() {
        const state = store.get();
        if (!isObject(state)) {
            throw new Error('Travel requires a seeded WorldState');
        }
        return state;
    }

    async function resolveSources() {
        if (sources) {
            return sources;
        }
        if (typeof loadSources === 'function') {
            return loadSources();
        }
        throw new Error('Travel requires map sources (locations, bridges, regions, overrides)');
    }

    /**
     * Build a fresh graph on every call. The graph is cheap (dozens of nodes)
     * and per-chat bridge overrides change between trips, so caching would
     * only risk a stale route.
     */
    async function getGraph() {
        const loaded = await resolveSources();
        return buildTravelGraph({
            locations: loaded?.locations ?? null,
            bridges: loaded?.generated?.bridges ?? loaded?.bridges ?? null,
            regions: loaded?.generated?.regions ?? loaded?.regions ?? null,
            overrides: loaded?.overrides ?? null,
            state: store.get(),
        });
    }

    /**
     * Plan (never apply) a trip. Returns `{ ok, reason, path, bridges, turns }`.
     */
    async function planTravel({ to = null, ability = null } = {}) {
        const state = readState();
        const from = state.scene?.locationId ?? null;
        if (!from) {
            return { ok: false, reason: 'no-origin', path: [], bridges: [], turns: 0 };
        }
        // Built per plan: a bridge destroyed in this chat between two trips
        // must gate the next one.
        const graph = await getGraph();
        const abilities = ability ? [ability] : getPlayerTravelAbilities(state);
        const plan = findTravelPath(graph, from, to, { abilities });
        return {
            ...plan,
            from,
            to,
            graph,
            fromName: graph.getNode(from)?.name ?? from,
            toName: graph.getNode(to)?.name ?? to,
        };
    }

    function applyMove({ plan, fromNode, toNode, turn }) {
        const state = readState();
        const canonPlayerId = state.player?.identity === 'canon' ? state.player.characterId : null;
        const events = [];

        // Leaving a scene releases any hold before time advances; a zero-turn
        // trip still releases it.
        events.push({ type: 'SET_CLOCK_HOLD', active: false, reason: 'travel' });
        if (plan.turns > 0) {
            let settingsNow = {};
            try {
                settingsNow = (typeof getSettings === 'function' ? getSettings() : null) ?? {};
            } catch (error) {
                logWarning(log, 'Could not read settings for the travel clock', error);
            }
            events.push(buildClockTick({ state, settings: settingsNow, turns: plan.turns }));
        }
        events.push({
            type: 'SET_LOCATION',
            locationId: plan.to,
            ...(canonPlayerId ? { characterId: canonPlayerId } : {}),
        });
        events.push({
            type: 'ADD_EVENT',
            summary: travelSummary({
                fromName: fromNode?.name ?? plan.from,
                toName: toNode?.name ?? plan.to,
                turns: plan.turns,
                bridges: plan.bridgeNames ?? [],
                ability: plan.ability,
            }),
            locationId: plan.to,
            tags: [TRAVEL_EVENT_TAG, ...(plan.bridges.length > 0 ? ['bridge'] : [])],
        });

        const applied = applyEventBatch(store, events, {
            log,
            patch: (next) => ({
                ...next,
                flags: {
                    ...(next.flags ?? {}),
                    travel: {
                        lastFrom: plan.from,
                        lastTo: plan.to,
                        lastPath: plan.path.slice(),
                        lastBridges: plan.bridges.slice(),
                        lastTurns: plan.turns,
                        lastAbility: plan.ability ?? null,
                        lastAt: turn,
                        history: [
                            ...(Array.isArray(next.flags?.travel?.history) ? next.flags.travel.history : []),
                            {
                                from: plan.from,
                                to: plan.to,
                                path: plan.path.slice(),
                                bridges: plan.bridges.slice(),
                                turns: plan.turns,
                                ability: plan.ability ?? null,
                                at: turn,
                            },
                        ].slice(-MAX_TRAVEL_HISTORY),
                    },
                },
            }),
        });
        return applied;
    }

    /**
     * Travel to a named location. Rejects (never throws) for an invalid trip:
     * combat, unknown nodes, blocked/disconnected routes, or a failed
     * validation. A successful move is committed before the tracker runs.
     */
    async function travel({ to = null, ability = null, signal = null, runTracker = true } = {}) {
        const state = readState();
        if (isTravelBlockedByCombat(state)) {
            return { ok: false, reason: 'in-combat', to, message: 'Travel is disabled during combat.' };
        }
        const from = state.scene?.locationId ?? null;
        // An explicit ability must be one the player actually has: never a free
        // teleport through the public API.
        if (ability !== null && ability !== undefined) {
            const known = getPlayerTravelAbilities(state);
            if (!known.includes(ability)) {
                return {
                    ok: false,
                    reason: 'ability-unavailable',
                    from,
                    to,
                    path: [],
                    bridges: [],
                    message: `The player cannot use "${String(ability)}".`,
                };
            }
        }
        const plan = await planTravel({ to, ability });
        if (!plan.ok) {
            return {
                ok: false,
                reason: plan.reason,
                from,
                to,
                path: plan.path ?? [],
                bridges: plan.bridges ?? [],
                blockedBridges: plan.blockedBridges ?? [],
                message: describeTravelFailure(plan),
            };
        }
        if (plan.alreadyThere) {
            if (isClockHeld(readState())) {
                try {
                    store.dispatch({ type: 'SET_CLOCK_HOLD', active: false, reason: 'travel' });
                } catch (error) {
                    logWarning(log, 'Could not release the clock hold on a no-op trip', error);
                }
            }
            return {
                ok: true,
                alreadyThere: true,
                from,
                to,
                fromName: plan.fromName ?? from,
                toName: plan.toName ?? to,
                path: [to],
                bridges: [],
                turns: 0,
                state: readState(),
                message: 'You are already there.',
            };
        }

        const fromNode = plan.graph.getNode(from);
        const toNode = plan.graph.getNode(to);
        const applied = applyMove({ plan, fromNode, toNode, turn: clock() });
        if (!applied.ok) {
            return {
                ok: false,
                reason: 'apply-failed',
                from,
                to,
                path: plan.path,
                bridges: plan.bridges,
                message: applied.error ?? 'The move could not be applied.',
            };
        }

        const travelContext = buildTravelInitiativeContext({
            from,
            to,
            path: plan.path,
            bridges: plan.bridges,
            bridgeNames: plan.bridgeNames ?? [],
            distance: plan.distance,
            turns: plan.turns,
            modes: plan.modes,
            ability: plan.ability,
        });

        let tracker = { ran: false, reason: 'disabled' };
        if (runTracker) {
            try {
                tracker = await hook.afterTravel(travelContext, { signal });
            } catch (error) {
                if (!isAbortError(error)) {
                    throw error;
                }
                // The chat changed mid-pass. The move is already committed and
                // valid, so report the abort instead of losing the trip.
                tracker = { ran: false, reason: 'aborted', error: error?.message ?? 'aborted' };
            }
        } else if (signal?.aborted) {
            tracker = { ran: false, reason: 'aborted' };
        }

        let cast = null;
        if (scene && typeof scene.refreshCast === 'function') {
            try {
                cast = await scene.refreshCast({
                    runDirector: false,
                    signal,
                    // The persisted encounter records that the player arrived.
                    encounterSource: 'travel',
                });
            } catch (error) {
                if (isAbortError(error)) {
                    cast = null;
                } else {
                    logWarning(log, 'Cast refresh failed after travel; keeping the deterministic cast', error);
                }
            }
        }

        const after = store.get();
        const intro = buildLocationIntro({
            state: after,
            season,
            from: { id: from, name: fromNode?.name ?? from },
            travel: travelContext,
        });

        return {
            ok: true,
            alreadyThere: false,
            from,
            to,
            fromName: fromNode?.name ?? from,
            toName: toNode?.name ?? to,
            path: plan.path,
            bridges: plan.bridges,
            bridgeNames: plan.bridgeNames ?? [],
            distance: plan.distance,
            turns: plan.turns,
            modes: plan.modes,
            ability: plan.ability ?? null,
            bypass: plan.bypass ?? null,
            tracker,
            cast,
            intro,
            messageExtra: buildTravelMessageExtra({ travelContext, plan, intro }),
            state: after,
        };
    }

    return {
        travel,
        planTravel,
        getGraph,
        buildContext: buildTravelInitiativeContext,
    };
}

/** A human reason for a rejected trip (used by the UI and tests). */
export function describeTravelFailure(plan = {}) {
    if (plan.reason === 'unknown-destination') {
        return 'That destination is not part of the travel network.';
    }
    if (plan.reason === 'unknown-origin') {
        return 'The current location is not part of the travel network.';
    }
    if (plan.reason === 'blocked') {
        const names = (plan.blockedBridges ?? []).map((bridge) => bridge.name ?? bridge.label ?? bridge.id);
        return names.length > 0
            ? `Every route crosses a blocked bridge (${names.join(', ')}).`
            : 'Every route is blocked.';
    }
    if (plan.reason === 'no-route') {
        return 'No open route connects these locations.';
    }
    if (plan.reason === 'no-graph') {
        return 'The travel graph is unavailable.';
    }
    if (plan.reason === 'ability-unavailable') {
        return 'The player does not have that travel ability.';
    }
    return 'That trip is not possible right now.';
}

/**
 * Attach a travel record to a chat message (`message.extra.neoterra.travel`).
 * The narrator/turn pipeline owns messages; this is the one write helper so the
 * shape stays in one place. Returns the same message object.
 */
export function attachTravelToMessage(message, travelExtra) {
    if (!isObject(message) || !isObject(travelExtra)) {
        return message;
    }
    message.extra = isObject(message.extra) ? message.extra : {};
    message.extra.neoterra = {
        ...(isObject(message.extra.neoterra) ? message.extra.neoterra : {}),
        travel: travelExtra,
    };
    return message;
}

/**
 * The per-message travel record: stored on `message.extra.neoterra.travel` so a
 * swipe/reload can show where the player came from without replaying events.
 */
export function buildTravelMessageExtra({ travelContext = null, plan = null, intro = null } = {}) {
    if (!travelContext) {
        return null;
    }
    return {
        from: travelContext.from,
        to: travelContext.to,
        path: travelContext.path.slice(),
        bridges: travelContext.bridges.slice(),
        turns: travelContext.turns,
        ability: travelContext.ability,
        distance: travelContext.distance,
        at: Date.now(),
        intro: intro?.text ?? null,
        bypass: plan?.bypass ?? null,
    };
}
