/**
 * Agent initiative / cadence flow.
 *
 * The initiative owns *when* agents run. Agents stay pure planners: this module
 * applies their reducer events atomically through one `store.replace`, so a
 * failed or aborted pass leaves the previous WorldState byte-identical.
 */

import { applyWorldEvents } from '../state/reducer.js';
import { validateWorldState } from '../state/world-state.js';
import { isClockHeld } from '../core/world-clock.js';
import { getCurrentAct } from '../data/beats.js';

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

/** Per-agent bookkeeping stored under `state.flags[agentId]`. */
function agentFlags(state, agentId) {
    const flags = isObject(state?.flags) ? state.flags : {};
    return isObject(flags[agentId]) ? flags[agentId] : {};
}

/** True when the agent's block is present and not explicitly disabled. */
function agentConfigured(settings, agentId) {
    return isObject(settings?.agents?.[agentId]);
}

/**
 * Cast Director cadence. Travel/arrival always passes `trigger:'location'`;
 * ordinary turns follow `cadence: 'sceneChange'` (location change or every
 * `everyNTurns`) or a pure `everyNTurns` schedule.
 */
export function shouldRunCastDirector({
    state,
    settings,
    trigger = 'turn',
    force = false,
    turn = state?.meta?.turn ?? 0,
} = {}) {
    if (!agentConfigured(settings, 'castDirector')) {
        return { run: false, reason: 'not-configured' };
    }
    const cadence = getAgentCadence(settings, 'castDirector');
    if (!cadence.enabled) {
        return { run: false, reason: 'disabled' };
    }
    if (force) {
        return { run: true, reason: 'forced' };
    }
    if (trigger === 'location') {
        return { run: true, reason: 'location-change' };
    }
    const flags = agentFlags(state, 'castDirector');
    if (!Number.isInteger(flags.lastRunTurn)) {
        return { run: true, reason: 'never-run' };
    }
    if (cadence.cadence === 'everyNTurns') {
        const elapsed = Number(turn) - flags.lastRunTurn;
        return elapsed >= cadence.everyNTurns
            ? { run: true, reason: `every-${cadence.everyNTurns}-turns` }
            : { run: false, reason: 'not-due' };
    }
    if (flags.lastLocationId && flags.lastLocationId !== state?.scene?.locationId) {
        return { run: true, reason: 'scene-change' };
    }
    const elapsed = Number(turn) - flags.lastRunTurn;
    return elapsed >= cadence.everyNTurns
        ? { run: true, reason: `every-${cadence.everyNTurns}-turns` }
        : { run: false, reason: 'not-due' };
}

/**
 * Lore cadence: every `everyNTurns` turns, or whenever the act boundary moves.
 */
export function shouldRunLore({
    state,
    settings,
    season = null,
    trigger = 'turn',
    force = false,
    turn = state?.meta?.turn ?? 0,
} = {}) {
    if (!agentConfigured(settings, 'lore')) {
        return { run: false, reason: 'not-configured' };
    }
    const cadence = getAgentCadence(settings, 'lore');
    if (!cadence.enabled) {
        return { run: false, reason: 'disabled' };
    }
    if (force) {
        return { run: true, reason: 'forced' };
    }
    if (trigger === 'act') {
        return { run: true, reason: 'act-change' };
    }
    const flags = agentFlags(state, 'lore');
    const act = getCurrentAct(state, season);
    if (flags.lastRunAct && act !== flags.lastRunAct) {
        return { run: true, reason: 'act-change' };
    }
    if (!Number.isInteger(flags.lastRunTurn)) {
        return { run: true, reason: 'never-run' };
    }
    const elapsed = Number(turn) - flags.lastRunTurn;
    return elapsed >= cadence.everyNTurns
        ? { run: true, reason: `every-${cadence.everyNTurns}-turns` }
        : { run: false, reason: 'not-due' };
}

/**
 * Auditor cadence: act boundaries by default, with an `everyNTurns` fallback.
 */
export function shouldRunAuditor({
    state,
    settings,
    season = null,
    trigger = 'turn',
    force = false,
    turn = state?.meta?.turn ?? 0,
} = {}) {
    if (!agentConfigured(settings, 'auditor')) {
        return { run: false, reason: 'not-configured' };
    }
    const cadence = getAgentCadence(settings, 'auditor');
    if (!cadence.enabled) {
        return { run: false, reason: 'disabled' };
    }
    if (force) {
        return { run: true, reason: 'forced' };
    }
    const flags = agentFlags(state, 'auditor');
    const act = getCurrentAct(state, season);
    if (trigger === 'act' || (flags.lastRunAct && act !== flags.lastRunAct)) {
        return { run: true, reason: 'act-change' };
    }
    if (!Number.isInteger(flags.lastRunTurn)) {
        return { run: true, reason: 'never-run' };
    }
    if (cadence.cadence === 'actChange') {
        return { run: false, reason: 'not-act-boundary' };
    }
    const elapsed = Number(turn) - flags.lastRunTurn;
    return elapsed >= cadence.everyNTurns
        ? { run: true, reason: `every-${cadence.everyNTurns}-turns` }
        : { run: false, reason: 'not-due' };
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
        // Idempotent events return the exact input document. Replacing it would
        // still schedule a metadata save and a WAL write for no change.
        if (next !== base) {
            store.replace(next);
        }
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
 * Recap text for the Journal: the agent may supply `recap`; otherwise the
 * most recent entries are rendered deterministically. Never empty when entries
 * exist, so the Journal always has something to show.
 */
function buildLoreRecap(result, entries, state, season) {
    const supplied = typeof result?.recap === 'string' ? result.recap.trim() : '';
    if (supplied) {
        return supplied.slice(0, 1200);
    }
    const list = Array.isArray(entries) ? entries.slice(-4) : [];
    if (list.length === 0) {
        const rationale = typeof result?.rationale === 'string' ? result.rationale.trim() : '';
        return rationale ? rationale.slice(0, 1200) : '';
    }
    const title = season?.title ?? state?.seasonId ?? 'the story';
    const lines = list.map((entry) => {
        const text = typeof entry?.content === 'string' ? entry.content.trim() : '';
        const label = typeof entry?.title === 'string' ? entry.title.trim() : '';
        return [label, text].filter(Boolean).join(': ');
    }).filter(Boolean);
    return `Previously in ${title}: ${lines.join(' ')}`.slice(0, 1200);
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
    lore = null,
    ending = null,
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
        if (trigger === 'turn' && force !== true && isClockHeld(current)) {
            // A held world never advances its forecast on ordinary turns;
            // location/beat/manual triggers still run.
            return { ran: false, reason: 'time-held', events: [] };
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
            let endingResult = null;
            if (applied.ok && ending && typeof ending.trigger === 'function'
                && applied.state?.ending?.status === 'epilogue'
                && typeof applied.state.ending.epilogueText !== 'string') {
                try {
                    endingResult = await ending.trigger({ force: true });
                } catch (error) {
                    if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                        throw error;
                    }
                    logWarning(log, 'Ending epilogue failed; the deterministic fallback is retried next pass', error);
                }
            }
            return {
                ran: applied.ok,
                reason: applied.ok ? null : 'apply-failed',
                events: applied.ok ? result.events : [],
                source: result.source,
                rejected: result.rejected ?? [],
                notes: result.notes ?? [],
                rationale: result.rationale ?? '',
                ending: result.ending === true,
                endingResult,
                error: applied.error,
                state: endingResult?.state ?? applied.state,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Storyline pass failed; state unchanged', error);
            return { ran: false, reason: 'failed', events: [], error: error?.message ?? String(error) };
        }
    }

    async function runAudit({ recentProse = '', recentMessages = [], signal = null, force = false, trigger = 'turn' } = {}) {
        if (!auditor || typeof auditor.run !== 'function') {
            return { ran: false, reason: 'no-auditor', findings: [] };
        }
        const current = state();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', findings: [] };
        }
        const settingsNow = settings();
        const decision = shouldRunAuditor({
            state: current,
            settings: settingsNow,
            season,
            trigger,
            force,
            turn: current.meta?.turn ?? 0,
        });
        if (!decision.run) {
            return { ran: false, reason: decision.reason, findings: [] };
        }
        const act = getCurrentAct(current, season);
        try {
            const result = await auditor.run({
                state: current,
                season,
                recentProse,
                recentMessages,
                settings: settingsNow,
                signal,
            });
            const findings = Array.isArray(result.findings) ? result.findings : [];
            const summary = result.summary ?? { errors: 0, warnings: 0, info: 0 };
            const applied = applyEventBatch(store, [], {
                context: context(),
                log,
                patch: (next) => ({
                    ...next,
                    flags: {
                        ...(next.flags ?? {}),
                        auditor: {
                            act,
                            lastRunAct: act,
                            lastRunTurn: next.meta?.turn ?? 0,
                            findings,
                            summary,
                            source: result.source ?? 'deterministic',
                            ranAt: clock(),
                        },
                    },
                }),
            });
            return {
                ran: applied.ok,
                reason: applied.ok ? null : 'apply-failed',
                findings,
                summary,
                source: result.source,
                error: applied.error ?? result.error ?? null,
                state: applied.state,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Auditor pass failed; no findings reported', error);
            return { ran: false, reason: 'failed', findings: [], error: error?.message ?? String(error) };
        }
    }

    /**
     * Lore cadence pass. The recap written to `flags.lore.recap` is what the
     * Journal and Session Home read; the agent's entries are kept alongside it
     * so an export or a future world-book pass can reuse them.
     */
    async function runLore({
        recentProse = '',
        recentMessages = [],
        existingEntries = [],
        candidates = [],
        signal = null,
        force = false,
        trigger = 'turn',
    } = {}) {
        if (!lore || typeof lore.run !== 'function') {
            return { ran: false, reason: 'no-lore', entries: [] };
        }
        const current = state();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', entries: [] };
        }
        const settingsNow = settings();
        const decision = shouldRunLore({
            state: current,
            settings: settingsNow,
            season,
            trigger,
            force,
            turn: current.meta?.turn ?? 0,
        });
        if (!decision.run) {
            return { ran: false, reason: decision.reason, entries: [] };
        }
        const act = getCurrentAct(current, season);
        try {
            const result = await lore.run({
                state: current,
                season,
                recentProse,
                recentMessages,
                existingEntries: Array.isArray(current?.flags?.lore?.entries)
                    ? current.flags.lore.entries
                    : existingEntries,
                candidates,
                settings: settingsNow,
                signal,
            });
            if (result?.enabled === false) {
                return { ran: false, reason: 'disabled', entries: [] };
            }
            if (result?.ran === false && typeof result?.reason === 'string') {
                return { ran: false, reason: result.reason, entries: [] };
            }
            const entries = Array.isArray(result?.entries) ? result.entries : [];
            const recap = buildLoreRecap(result, entries, current, season);
            const previousLore = isObject(current?.flags?.lore) ? current.flags.lore : {};
            const appliedKeys = new Set(
                Array.isArray(previousLore.appliedRelationshipKeys)
                    ? previousLore.appliedRelationshipKeys
                    : [],
            );
            const relationshipEvents = [];
            for (const event of Array.isArray(result?.relationshipEvents)
                ? result.relationshipEvents
                : []) {
                if (!isObject(event)) {
                    continue;
                }
                const key = typeof event.idempotencyKey === 'string' ? event.idempotencyKey : null;
                if (key && appliedKeys.has(key)) {
                    continue;
                }
                if (key) {
                    appliedKeys.add(key);
                }
                // `idempotencyKey` is a planner marker, not a reducer field.
                const { idempotencyKey: _ignored, ...clean } = event;
                relationshipEvents.push(clean);
            }
            const nextKeys = [...appliedKeys].slice(-200);
            const applied = applyEventBatch(store, relationshipEvents, {
                context: context(),
                log,
                patch: (next) => ({
                    ...next,
                    flags: {
                        ...(next.flags ?? {}),
                        lore: {
                            ...(isObject(next.flags?.lore) ? next.flags.lore : {}),
                            recap: recap || (isObject(next.flags?.lore) && typeof next.flags.lore.recap === 'string'
                                ? next.flags.lore.recap
                                : ''),
                            entries: entries.length > 0
                                ? entries
                                : (isObject(next.flags?.lore) && Array.isArray(next.flags.lore.entries)
                                    ? next.flags.lore.entries
                                    : []),
                            appliedRelationshipKeys: nextKeys,
                            lastRunAct: act,
                            lastRunTurn: next.meta?.turn ?? 0,
                            source: result.source ?? 'agent',
                            ranAt: clock(),
                        },
                    },
                }),
            });
            return {
                ran: applied.ok,
                reason: applied.ok ? null : 'apply-failed',
                entries,
                recap,
                source: result.source ?? 'agent',
                error: applied.error ?? result.error ?? null,
                state: applied.state,
            };
        } catch (error) {
            if (error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED') {
                throw error;
            }
            logWarning(log, 'Lore pass failed; no journal recap written', error);
            return { ran: false, reason: 'failed', entries: [], error: error?.message ?? String(error) };
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
        runAuditor: runAudit,
        runLore,
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
