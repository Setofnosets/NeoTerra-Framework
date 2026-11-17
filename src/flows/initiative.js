/**
 * Agent initiative / cadence flow.
 *
 * The initiative owns *when* agents run. Agents stay pure planners: this module
 * applies their reducer events atomically through one `store.replace`, so a
 * failed or aborted pass leaves the previous WorldState byte-identical.
 */

import { applyWorldEvents } from '../state/reducer.js';
import { validateWorldState } from '../state/world-state.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatErrors(validation) {
    return validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
}

function flagsFor(state) {
    return isObject(state?.flags?.storyline) ? state.flags.storyline : {};
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a pass.
    }
}

/** Cadence settings for one agent, tolerant of missing or partial settings. */
export function getAgentCadence(settings, agentId) {
    const agent = settings?.agents?.[agentId];
    return {
        enabled: agent?.enabled !== false,
        cadence: agent?.cadence ?? (agentId === 'storyline' ? 'everyNTurns' : 'once'),
        everyNTurns: Number.isInteger(agent?.everyNTurns) && agent.everyNTurns > 0
            ? agent.everyNTurns
            : 6,
        onLocationChange: agent?.onLocationChange !== false,
    };
}

/**
 * Decide whether the Storyline Tracker should run.
 *
 * @param {{
 *   state: object,
 *   settings?: object,
 *   trigger?: 'turn'|'location'|'beat'|'manual',
 *   force?: boolean,
 *   turn?: number,
 * }} options
 */
export function shouldRunStoryline({
    state,
    settings,
    trigger = 'turn',
    force = false,
    turn = state?.meta?.turn ?? 0,
} = {}) {
    if (force) {
        return { run: true, reason: 'forced' };
    }
    const cadence = getAgentCadence(settings, 'storyline');
    if (!cadence.enabled) {
        return { run: false, reason: 'disabled' };
    }
    if (state?.ending?.status === 'epilogue' || state?.ending?.status === 'ended') {
        // The ending screen owns the next pass; a continued post-victory arc
        // resumes the same beat-ledger machinery.
        return { run: false, reason: 'ending' };
    }
    if (trigger === 'location') {
        return cadence.onLocationChange
            ? { run: true, reason: 'location-change' }
            : { run: false, reason: 'location-change-disabled' };
    }
    if (trigger === 'beat') {
        return { run: true, reason: 'beat' };
    }
    if (trigger === 'manual') {
        return { run: true, reason: 'manual' };
    }

    const flags = flagsFor(state);
    if (!Number.isInteger(flags.lastRunTurn)) {
        return { run: true, reason: 'never-run' };
    }
    const elapsed = Number(turn) - flags.lastRunTurn;
    if (elapsed >= cadence.everyNTurns) {
        return { run: true, reason: `every-${cadence.everyNTurns}-turns` };
    }
    return { run: false, reason: 'not-due' };
}

/**
 * Atomically apply a batch of events plus an optional state patch.
 * Returns `{ ok, state, error }` and never leaves a partial document.
 */
export function applyEventBatch(store, events, {
    patch = null,
    context = {},
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('applyEventBatch requires a WorldState store');
    }
    const base = store.get();
    if (!isObject(base)) {
        return { ok: false, state: null, error: 'No seeded WorldState', applied: [] };
    }
    try {
        let next = applyWorldEvents(base, Array.isArray(events) ? events : [], context);
        if (typeof patch === 'function') {
            next = patch(next);
        } else if (isObject(patch)) {
            next = { ...next, ...patch };
        }
        const validation = validateWorldState(next);
        if (!validation.ok) {
            throw new Error(`Invalid WorldState after agent pass (${formatErrors(validation)})`);
        }
        store.replace(next);
        return { ok: true, state: next, error: null, applied: Array.isArray(events) ? events.length : 0 };
    } catch (error) {
        logWarning(log, 'Agent pass rejected atomically; state unchanged', error);
        return {
            ok: false,
            state: base,
            error: error?.message ?? String(error),
            applied: 0,
        };
    }
}

/**
 * Create the initiative flow. Every agent dependency is optional so the flow
 * can be used with only the Storyline Tracker, or only the Architect.
 */
export function createInitiative({
    store,
    season = null,
    registry = null,
    formGroups = null,
    formRules = null,
    architect = null,
    storyline = null,
    auditor = null,
    getSettings = null,
    log = null,
    now = Date.now,
} = {}) {
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('createInitiative requires a WorldState store');
    }
    const clock = typeof now === 'function' ? now : Date.now;
    const context = () => ({ registry, formGroups, formRules });

    function settings() {
        return typeof getSettings === 'function' ? getSettings() : {};
    }

    function state() {
        return store.get();
    }

    async function runArchitect({ signal = null } = {}) {
        if (!architect || typeof architect.run !== 'function') {
            return { ran: false, reason: 'no-architect', events: [] };
        }
        const current = state();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', events: [] };
        }
        try {
            const result = await architect.run({ state: current, season, signal });
            const applied = applyEventBatch(store, result.events, {
                context: context(),
                log,
                patch: (next) => ({
                    ...next,
                    flags: {
                        ...(next.flags ?? {}),
                        architect: {
                            ranAtTurn: next.meta?.turn ?? 0,
                            ranAt: clock(),
                            source: result.source ?? 'deterministic',
                        },
                    },
                }),
            });
            return {
                ran: applied.ok,
                reason: applied.ok ? null : 'apply-failed',
                events: applied.ok ? result.events : [],
                source: result.source,
                rejected: result.rejected ?? [],
                error: applied.error,
                state: applied.state,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Architect pass failed; state unchanged', error);
            return { ran: false, reason: 'failed', events: [], error: error?.message ?? String(error) };
        }
    }

    async function runStoryline({
        trigger = 'turn',
        force = false,
        signal = null,
        recentProse = '',
        travel = null,
    } = {}) {
        if (!storyline || typeof storyline.run !== 'function') {
            return { ran: false, reason: 'no-storyline', events: [] };
        }
        const current = state();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', events: [] };
        }
        const settingsNow = settings();
        const decision = shouldRunStoryline({
            state: current,
            settings: settingsNow,
            trigger,
            force,
            turn: current.meta?.turn ?? 0,
        });
        if (!decision.run) {
            return { ran: false, reason: decision.reason, events: [] };
        }

        try {
            const result = await storyline.run({
                state: current,
                season,
                formRules,
                pressure: settingsNow?.beatDeadlinePressure ?? 'standard',
                recentProse,
                travel,
                settings: settingsNow,
                signal,
            });
            const applied = applyEventBatch(store, result.events, {
                context: context(),
                log,
                patch: (next) => ({
                    ...next,
                    flags: {
                        ...(next.flags ?? {}),
                        storyline: {
                            lastRunTurn: next.meta?.turn ?? 0,
                            lastLocationId: next.scene?.locationId ?? null,
                            lastRunAt: clock(),
                            lastSource: result.source ?? 'deterministic',
                            act: result.act ?? null,
                        },
                    },
                }),
            });
            return {
                ran: applied.ok,
                reason: applied.ok ? null : 'apply-failed',
                events: applied.ok ? result.events : [],
                source: result.source,
                rejected: result.rejected ?? [],
                notes: result.notes ?? [],
                rationale: result.rationale ?? '',
                ending: result.ending === true,
                error: applied.error,
                state: applied.state,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Storyline pass failed; state unchanged', error);
            return { ran: false, reason: 'failed', events: [], error: error?.message ?? String(error) };
        }
    }

    async function runAudit({ recentProse = '', recentMessages = [], signal = null } = {}) {
        if (!auditor || typeof auditor.run !== 'function') {
            return { ran: false, reason: 'no-auditor', findings: [] };
        }
        const current = state();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', findings: [] };
        }
        try {
            const result = await auditor.run({
                state: current,
                season,
                recentProse,
                recentMessages,
                signal,
            });
            return {
                ran: true,
                findings: result.findings ?? [],
                summary: result.summary ?? { errors: 0, warnings: 0, info: 0 },
                source: result.source,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Auditor pass failed; no findings reported', error);
            return { ran: false, reason: 'failed', findings: [], error: error?.message ?? String(error) };
        }
    }

    /** Convenience: the per-turn hook used by the narrator/turn flow. */
    async function afterTurn({ recentProse = '', turn = null, signal = null } = {}) {
        // The caller owns TICK_TIME. Cadence reads state.meta.turn on the next
        // pass; `turn` is accepted only for forward-compatible call sites.
        void turn;
        return runStoryline({ trigger: 'turn', signal, recentProse });
    }

    async function afterLocationChange({
        from = null,
        to = null,
        path = [],
        travel = null,
        signal = null,
    } = {}) {
        const current = state();
        if (to && current?.scene?.locationId !== to) {
            return {
                ran: false,
                reason: 'scene-not-updated',
                events: [],
                from,
                to,
                path,
            };
        }
        return runStoryline({ trigger: 'location', signal, travel });
    }

    return {
        runArchitect,
        runStoryline,
        runAudit,
        afterTurn,
        afterLocationChange,
        getCadence: () => getAgentCadence(settings(), 'storyline'),
        shouldRunStoryline: (options = {}) => shouldRunStoryline({
            state: state(),
            settings: settings(),
            ...options,
        }),
    };
}
