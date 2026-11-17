/**
 * Travel initiative hook.
 *
 * Step 14 owns the full travel graph. Step 9 only needs the contract that a
 * completed location change notifies the Storyline Tracker. Keeping this small
 * module separate means the final travel flow can call one function without
 * importing agent internals.
 */

/**
 * Build the travel context the Storyline Tracker expects.
 *
 * @param {{
 *   from: string|null,
 *   to: string|null,
 *   path?: string[],
 *   bridges?: string[],
 *   distance?: number,
 *   ability?: string|null,
 * }} travel
 */
export function buildTravelInitiativeContext({
    from = null,
    to = null,
    path = [],
    bridges = [],
    distance = 0,
    ability = null,
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
        distance: Number.isFinite(distance) ? distance : 0,
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
                signal,
            });
            return { ...result, context };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
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
