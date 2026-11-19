/**
 * Neo Terra Player State Tracker.
 *
 * Player-only, per-turn tracker. It reads the played character (custom persona
 * or canon) and returns reducer-shaped events. It never edits NPC state and
 * never narrates choices. Manual sheet edits are marked in
 * `state.flags.playerTracker.manualEdits`; a matching tracker change is
 * suppressed for exactly one pass, then the marker is cleared.
 */

import { AgentAbortedError } from './client.js';
import {
    buildClockTick,
    buildClockTurn,
    effectiveStoryTurn,
    isClockHeld,
} from '../core/world-clock.js';
import { applyWorldEvents } from '../state/reducer.js';
import { validateWorldState } from '../state/world-state.js';
import { analyzePacing, recordPacing } from '../flows/pacing.js';
import { shouldRunCastDirector } from '../flows/initiative.js';

export const PLAYER_TRACKER_PATHS = Object.freeze([
    'stamina.current',
    'stamina.max',
    'willpower.current',
    'willpower.max',
    'status',
    'outfit',
    'mood',
    'notes',
    'corruption.stage',
    'corruption.progress',
    'skills',
    'traits',
    'injuries',
    'allegiance',
    'agenda',
    'goals',
]);

const NUMERIC_PATHS = Object.freeze([
    'stamina.current',
    'stamina.max',
    'willpower.current',
    'willpower.max',
    'corruption.stage',
    'corruption.progress',
]);

const ARRAY_PATHS = Object.freeze(['skills', 'traits', 'injuries', 'goals']);

/** Resources the combat engine owns while a conflict is active. */
export const COMBAT_ENGINE_OWNED_PATHS = Object.freeze([
    'stamina.current',
    'stamina.max',
    'willpower.current',
    'willpower.max',
    'corruption.stage',
    'corruption.progress',
]);

function isCombatActive(state) {
    return state?.meta?.inCombat === true || isObject(state?.scene?.combat);
}

const STRING_PATHS = Object.freeze([
    'status',
    'outfit',
    'mood',
    'notes',
    'allegiance',
    'agenda',
]);

const CHARACTER_STATUSES = Object.freeze([
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

const MAX_LABEL = 120;

export const STATE_TRACKER_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['changes', 'relationships', 'rationale'],
    properties: {
        changes: {
            type: 'array',
            maxItems: 24,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'value', 'reason'],
                properties: {
                    path: { type: 'string', enum: [...PLAYER_TRACKER_PATHS] },
                    value: {
                        anyOf: [
                            { type: 'number' },
                            { type: 'string' },
                            {
                                type: 'array',
                                maxItems: 12,
                                items: { type: 'string', maxLength: MAX_LABEL },
                            },
                        ],
                    },
                    reason: { type: 'string', maxLength: 240 },
                },
            },
        },
        relationships: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['withCharacterId'],
                properties: {
                    withCharacterId: { type: 'string' },
                    type: { type: 'string', maxLength: 80 },
                    affinityDelta: { type: 'number', minimum: -100, maximum: 100 },
                    tensionDelta: { type: 'number', minimum: -100, maximum: 100 },
                    notes: { type: 'string', maxLength: 240 },
                },
            },
        },
        rationale: { type: 'string', maxLength: 600 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function characterName(state, characterId) {
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function playerView(state) {
    const player = state?.player;
    if (!isObject(player)) {
        return null;
    }
    const character = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    return {
        player,
        character,
        name: character?.displayName ?? player.displayName ?? 'The Player',
        identity: player.identity ?? 'custom',
        characterId: player.characterId ?? null,
        role: character ?? player,
    };
}

function manualEdits(state) {
    const edits = state?.flags?.playerTracker?.manualEdits;
    return isObject(edits) ? edits : {};
}

/** Paths protected by a manual edit for the next tracker pass. */
export function getManualEditPaths(state) {
    return Object.keys(manualEdits(state));
}

export function isManualEditProtected(state, path) {
    return Object.hasOwn(manualEdits(state), path);
}

function formatErrors(validation) {
    return validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
}

/** Deterministic prompt for the player-only tracker. */
export function buildStateTrackerPrompt({ state, message = '', recentMessages = [] } = {}) {
    const view = playerView(state);
    const role = view?.role ?? {};
    const locationId = role.locationId ?? state?.scene?.locationId ?? null;
    const location = locationId ? state?.locations?.[locationId] ?? null : null;
    const others = asArray(state?.scene?.present)
        .filter((characterId) => characterId !== view?.characterId)
        .map((characterId) => characterName(state, characterId));

    const lines = [];
    lines.push(`# Neo Terra Player State Tracker — ${view?.name ?? 'Player'}`);
    lines.push('');
    lines.push('## Player');
    lines.push(`Identity: ${view?.identity ?? 'custom'}${view?.characterId ? ` (${view.characterId})` : ''}`);
    lines.push(`Role: ${state?.playerRole ?? 'neutral'}`);
    lines.push(`Name: ${view?.name ?? 'The Player'}`);
    lines.push(`Form: ${role.formId ?? 'custom persona'}`);
    lines.push(`Status: ${role.status ?? 'active'}`);
    lines.push(`Location: ${location ? `${location.name}${location.district ? `, ${location.district}` : ''}` : 'unknown'}`);
    lines.push(`Stamina: ${role.stamina?.current ?? '?'}/${role.stamina?.max ?? '?'}`);
    lines.push(`Willpower: ${role.willpower?.current ?? '?'}/${role.willpower?.max ?? '?'}`);
    lines.push(`Corruption: stage ${role.corruption?.stage ?? 0} (${role.corruption?.progress ?? 0}%)`);
    lines.push(`Outfit: ${role.outfit || '(none)'}`);
    lines.push(`Agenda: ${role.agenda || '(none)'}`);
    lines.push(`Goals: ${asArray(role.goals).join('; ') || '(none)'}`);
    lines.push(`Skills: ${asArray(role.skills).join(', ') || '(none)'}`);
    lines.push(`Traits: ${asArray(role.traits).join(', ') || '(none)'}`);
    lines.push(`Injuries: ${asArray(role.injuries).join(', ') || '(none)'}`);
    lines.push('');
    lines.push('## Scene cast (NPCs)');
    lines.push(others.length > 0 ? others.join(', ') : '(nobody)');
    lines.push('');
    if (isCombatActive(state)) {
        const combat = isObject(state?.scene?.combat) ? state.scene.combat : {};
        const actions = Array.isArray(combat.actions) ? combat.actions : [];
        const last = actions.length > 0 ? actions[actions.length - 1] : null;
        lines.push('## Combat');
        lines.push(`Round: ${Number.isInteger(combat.round) ? combat.round : 0}/${Number.isInteger(combat.maxRounds) ? combat.maxRounds : 8}`);
        if (typeof combat.stakes === 'string' && combat.stakes.length > 0) {
            lines.push(`Stakes: ${combat.stakes}`);
        }
        if (last) {
            lines.push(`Last outcome: ${last.tier ?? 'unknown'}${last.contract ? ` — ${last.contract}` : ''}`);
        }
        lines.push('The combat resolver owns stamina, willpower, and corruption during a conflict. Do not report those resources.');
        lines.push('');
    }
    lines.push('## Manual paths protected this pass');
    lines.push(getManualEditPaths(state).join(', ') || '(none)');
    lines.push('');
    lines.push('## Latest assistant message');
    lines.push(String(message ?? '').slice(0, 6000) || '(none)');
    lines.push('');
    if (asArray(recentMessages).length > 0) {
        lines.push('## Recent messages');
        for (const entry of asArray(recentMessages).slice(-4)) {
            lines.push(String(entry).slice(0, 1200));
        }
        lines.push('');
    }
    lines.push('## Rules');
    lines.push('Report only the player character. Never change NPCs, locations, factions, or threats.');
    lines.push('A status change may only use a declared character status.');
    lines.push('Do not invent skills, injuries, or relationship changes that the prose does not support.');
    lines.push('Agenda is what the character is doing now; goals are what they are steering toward.');
    lines.push('Emit goals only when the prose shows the character choosing or abandoning a course.');
    lines.push('When you emit goals, return the complete new list (up to 5). It replaces the stored list; never invent a goal the prose does not support.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(JSON.stringify(STATE_TRACKER_SCHEMA));
    return lines.join('\n');
}

function normalizeNumber(path, value, role) {
    if (!Number.isFinite(value)) {
        return { ok: false, reason: 'not-a-number' };
    }
    if (path === 'stamina.current') {
        return { ok: true, value: clamp(value, 0, Number(role?.stamina?.max ?? value)) };
    }
    if (path === 'willpower.current') {
        return { ok: true, value: clamp(value, 0, Number(role?.willpower?.max ?? value)) };
    }
    if (path === 'stamina.max' || path === 'willpower.max') {
        return { ok: true, value: Math.max(0, value) };
    }
    if (path === 'corruption.stage') {
        if (!Number.isInteger(value) || value < 0) {
            return { ok: false, reason: 'invalid-stage' };
        }
        return { ok: true, value };
    }
    if (path === 'corruption.progress') {
        return { ok: true, value: clamp(value, 0, 100) };
    }
    return { ok: true, value };
}

function normalizeString(path, value) {
    if (typeof value !== 'string') {
        return { ok: false, reason: 'not-a-string' };
    }
    if (path === 'status') {
        return CHARACTER_STATUSES.includes(value)
            ? { ok: true, value }
            : { ok: false, reason: 'unknown-status' };
    }
    return { ok: true, value: value.slice(0, 1200) };
}

function normalizeArray(value) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return { ok: false, reason: 'not-a-string-array' };
    }
    return {
        ok: true,
        value: [...new Set(value.map((item) => item.trim()).filter(Boolean))]
            .slice(0, 12)
            .map((item) => item.slice(0, MAX_LABEL)),
    };
}

/**
 * Validate tracker output against the current player. NPC edits are impossible:
 * the schema has no character selector, and only player paths are accepted.
 */
export function normalizeStateTrackerResult({ result, state } = {}) {
    const output = isObject(result) ? result : {};
    const view = playerView(state);
    if (!view) {
        return {
            events: [],
            suppressed: [],
            rejected: [{ path: '$', reason: 'no-player' }],
            changedPaths: [],
            rationale: '',
        };
    }
    const protectedPaths = new Set(getManualEditPaths(state));
    const events = [];
    const suppressed = [];
    const rejected = [];
    const changedPaths = [];
    const seenPaths = new Set();

    for (const change of asArray(output.changes).slice(0, 24)) {
        if (!isObject(change) || typeof change.path !== 'string') {
            continue;
        }
        const { path } = change;
        if (!PLAYER_TRACKER_PATHS.includes(path)) {
            rejected.push({ path, reason: 'unknown-path' });
            continue;
        }
        if (isCombatActive(state) && COMBAT_ENGINE_OWNED_PATHS.includes(path)) {
            // The resolver already applied the combat delta; a tracker pass
            // would double-apply it.
            suppressed.push({ path, reason: 'combat-engine-owned' });
            continue;
        }
        if (protectedPaths.has(path)) {
            suppressed.push({ path, reason: 'manual-edit' });
            continue;
        }
        if (seenPaths.has(path)) {
            rejected.push({ path, reason: 'duplicate-path' });
            continue;
        }

        let normalized;
        if (NUMERIC_PATHS.includes(path)) {
            normalized = normalizeNumber(path, change.value, view.role);
        } else if (ARRAY_PATHS.includes(path)) {
            normalized = normalizeArray(change.value, path);
        } else if (STRING_PATHS.includes(path)) {
            normalized = normalizeString(path, change.value);
        } else {
            normalized = { ok: false, reason: 'unsupported-path' };
        }
        if (!normalized.ok) {
            rejected.push({ path, reason: normalized.reason });
            continue;
        }

        // Goals are a replacement list. Returning the current list is a no-op
        // and must not produce an event (or a manual-edit marker).
        if (path === 'goals') {
            const current = asArray(view.role?.goals).map((item) => String(item).trim().toLowerCase());
            const next = normalized.value.map((item) => item.trim().toLowerCase());
            if (current.length === next.length && current.every((item, index) => item === next[index])) {
                continue;
            }
        }

        seenPaths.add(path);
        changedPaths.push(path);

        if (path === 'stamina.current' || path === 'stamina.max'
            || path === 'willpower.current' || path === 'willpower.max'
            || path === 'corruption.stage' || path === 'corruption.progress') {
            events.push({ type: 'SET_PLAYER_STAT', path, value: normalized.value });
        } else if (path === 'outfit' || path === 'mood' || path === 'notes') {
            events.push({ type: 'SET_PLAYER_STAT', path, value: normalized.value });
        } else {
            events.push({ type: 'SET_PLAYER_FIELDS', [path]: normalized.value });
        }
    }

    for (const relationship of asArray(output.relationships).slice(0, 8)) {
        if (!isObject(relationship) || typeof relationship.withCharacterId !== 'string') {
            continue;
        }
        const targetId = relationship.withCharacterId;
        if (targetId === view.characterId) {
            rejected.push({ path: 'relationships', reason: 'self-target' });
            continue;
        }
        if (!state?.characters?.[targetId]) {
            rejected.push({ path: 'relationships', reason: `unknown-character:${targetId}` });
            continue;
        }
        const affinityDelta = Number.isFinite(relationship.affinityDelta)
            ? relationship.affinityDelta
            : 0;
        const tensionDelta = Number.isFinite(relationship.tensionDelta)
            ? relationship.tensionDelta
            : 0;
        if (affinityDelta === 0 && tensionDelta === 0
            && typeof relationship.notes !== 'string'
            && typeof relationship.type !== 'string') {
            continue;
        }
        if (view.characterId) {
            events.push({
                type: 'RELATIONSHIP_DELTA',
                a: view.characterId,
                b: targetId,
                affinityDelta,
                tensionDelta,
                ...(typeof relationship.type === 'string'
                    ? { relationshipType: relationship.type }
                    : {}),
                ...(typeof relationship.notes === 'string' ? { notes: relationship.notes } : {}),
            });
        } else {
            events.push({
                type: 'PLAYER_RELATIONSHIP_DELTA',
                withCharacterId: targetId,
                affinityDelta,
                tensionDelta,
                ...(typeof relationship.type === 'string'
                    ? { relationshipType: relationship.type }
                    : {}),
                ...(typeof relationship.notes === 'string' ? { notes: relationship.notes } : {}),
            });
        }
    }

    return {
        events,
        suppressed,
        rejected,
        changedPaths,
        protectedPaths: [...protectedPaths],
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 600) : '',
    };
}

/**
 * Atomically apply tracker events and clear the manual markers that protected
 * them for this pass. A malformed batch is discarded with no state change.
 */
export function applyStateTrackerResult(store, result, { context = {}, log = null } = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('applyStateTrackerResult requires a WorldState store');
    }
    const base = store.get();
    if (!isObject(base)) {
        return { ok: false, state: null, error: 'No seeded WorldState' };
    }
    try {
        const events = asArray(result?.events);
        const suppressed = asArray(result?.suppressed);
        if (events.length === 0 && suppressed.length === 0) {
            // A malformed or empty response is a no-op: not even tracker
            // metadata is written.
            return { ok: true, state: base, error: null, cleared: 0 };
        }
        let next = applyWorldEvents(base, events, context);
        const manual = { ...manualEdits(next) };
        let removed = 0;
        for (const entry of suppressed) {
            if (entry?.path && Object.hasOwn(manual, entry.path)) {
                delete manual[entry.path];
                removed += 1;
            }
        }
        next = {
            ...next,
            flags: {
                ...(next.flags ?? {}),
                playerTracker: {
                    ...(isObject(next.flags?.playerTracker) ? next.flags.playerTracker : {}),
                    manualEdits: manual,
                    lastRunTurn: next.meta?.turn ?? 0,
                    lastRunAt: Date.now(),
                },
            },
        };
        const validation = validateWorldState(next);
        if (!validation.ok) {
            throw new Error(`Invalid WorldState after player tracker (${formatErrors(validation)})`);
        }
        store.replace(next);
        return { ok: true, state: next, error: null, cleared: removed };
    } catch (error) {
        try {
            if (typeof log === 'function') {
                log('Player tracker rejected; state unchanged', error);
            } else if (log && typeof log.warn === 'function') {
                log.warn('Player tracker rejected; state unchanged', error);
            }
        } catch {
            // Logging must never hide the failure.
        }
        return {
            ok: false,
            state: base,
            error: error?.message ?? String(error),
            cleared: 0,
        };
    }
}

function manualEventFor(path, value, role) {
    if (NUMERIC_PATHS.includes(path)) {
        const normalized = normalizeNumber(path, value, role);
        if (!normalized.ok) {
            throw new Error(`Manual edit rejected for "${path}": ${normalized.reason}`);
        }
        return path === 'corruption.stage' || path === 'corruption.progress'
            || path.startsWith('stamina.') || path.startsWith('willpower.')
            ? { type: 'SET_PLAYER_STAT', path, value: normalized.value }
            : null;
    }
    if (ARRAY_PATHS.includes(path)) {
        const normalized = normalizeArray(value);
        if (!normalized.ok) {
            throw new Error(`Manual edit rejected for "${path}": ${normalized.reason}`);
        }
        return { type: 'SET_PLAYER_FIELDS', [path]: normalized.value };
    }
    if (STRING_PATHS.includes(path)) {
        const normalized = normalizeString(path, value);
        if (!normalized.ok) {
            throw new Error(`Manual edit rejected for "${path}": ${normalized.reason}`);
        }
        return path === 'outfit' || path === 'mood' || path === 'notes'
            ? { type: 'SET_PLAYER_STAT', path, value: normalized.value }
            : { type: 'SET_PLAYER_FIELDS', [path]: normalized.value };
    }
    throw new Error(`Unknown player field "${path}"`);
}

/**
 * Apply a manual sheet edit, mark it manual, and persist once.
 * The marker suppresses the next tracker change for the same path.
 */
export function applyManualPlayerEdit(store, {
    path,
    value,
    reason = 'manual sheet edit',
    now = Date.now(),
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('applyManualPlayerEdit requires a WorldState store');
    }
    const base = store.get();
    if (!isObject(base)) {
        throw new Error('No seeded WorldState');
    }
    const view = playerView(base);
    if (!view) {
        throw new Error('No player state');
    }
    const event = manualEventFor(path, value, view.role);
    let next = event ? applyWorldEvents(base, [event]) : base;
    const currentManual = { ...manualEdits(next) };
    currentManual[path] = {
        value,
        reason,
        turn: next.meta?.turn ?? 0,
        editedAt: now,
    };
    next = {
        ...next,
        flags: {
            ...(next.flags ?? {}),
            playerTracker: {
                ...(isObject(next.flags?.playerTracker) ? next.flags.playerTracker : {}),
                manualEdits: currentManual,
            },
        },
    };
    const validation = validateWorldState(next);
    if (!validation.ok) {
        throw new Error(`Invalid WorldState after manual edit (${formatErrors(validation)})`);
    }
    store.replace(next);
    return next;
}

/** Remove all manual markers (used when clearing a chat world). */
export function clearManualPlayerEdits(store) {
    const base = store.get();
    if (!isObject(base)) {
        return null;
    }
    const tracker = isObject(base.flags?.playerTracker) ? base.flags.playerTracker : {};
    const next = {
        ...base,
        flags: {
            ...(base.flags ?? {}),
            playerTracker: { ...tracker, manualEdits: {} },
        },
    };
    store.replace(next);
    return next;
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break a tracker pass.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/**
 * Thin runner wrapper. `run` returns events only; the caller applies them.
 */
export function createStateTracker({
    runner = null,
    getSettings = null,
    log = null,
} = {}) {
    function prepare(request = {}) {
        const state = request.state ?? null;
        const message = request.message ?? request.text ?? '';
        const recentMessages = request.recentMessages ?? [];
        return {
            state,
            message,
            recentMessages,
            prompt: buildStateTrackerPrompt({ state, message, recentMessages }),
        };
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        if (typeof request.propose !== 'function') {
            return {
                ...normalizeStateTrackerResult({ result: null, state: prepared.state }),
                source: 'deterministic',
                prompt: prepared.prompt,
            };
        }
        return {
            ...normalizeStateTrackerResult({
                result: request.propose({
                    prompt: prepared.prompt,
                    schema: STATE_TRACKER_SCHEMA,
                }),
                state: prepared.state,
            }),
            source: 'agent',
            prompt: prepared.prompt,
        };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        const settings = (typeof getSettings === 'function' ? getSettings() : request.settings) ?? {};
        const enabled = settings?.agents?.stateTracker?.enabled !== false;
        if (!enabled || typeof runner?.runAgent !== 'function') {
            return {
                ...normalizeStateTrackerResult({ result: null, state: prepared.state }),
                source: 'deterministic',
                prompt: prepared.prompt,
            };
        }
        try {
            const response = await runner.runAgent({
                agentId: 'stateTracker',
                prompt: prepared.prompt,
                schema: STATE_TRACKER_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            return {
                ...normalizeStateTrackerResult({ result, state: prepared.state }),
                source: 'agent',
                prompt: prepared.prompt,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Player tracker failed; no state change', error);
            return {
                ...normalizeStateTrackerResult({ result: null, state: prepared.state }),
                source: 'deterministic',
                prompt: prepared.prompt,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildStateTrackerPrompt };
}

/**
 * One assistant turn: tick the clock, advance the off-screen world, run the
 * player tracker, advance the storyline on its cadence, then refresh the
 * present cast. Never throws; each stage is isolated so one failure cannot
 * skip the next.
 */
export async function runTurnPipeline({
    store,
    tracker = null,
    initiative = null,
    scene = null,
    getSettings = null,
    message = '',
    recentMessages = [],
    tickTurns = 1,
    worldTick = null,
    onStage = null,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function') {
        return { ok: false, reason: 'no-store' };
    }
    // Progress is best-effort: a throwing observer must never break the turn.
    const emitStage = (stage, status, detail = {}) => {
        if (typeof onStage !== 'function') {
            return;
        }
        try {
            onStage({ stage, status, ...detail });
        } catch (error) {
            logWarning(log, 'Turn stage callback failed', error);
        }
    };
    let settings = {};
    try {
        settings = (typeof getSettings === 'function' ? getSettings() : null) ?? {};
    } catch (error) {
        logWarning(log, 'Could not read settings for the turn pipeline', error);
    }
    const errors = [];

    // Stage 0: resolve encounter/beat auto-holds before the clock ticks. Combat
    // is handled by the reducer; a manual or chip hold always wins. Every
    // dispatch here is best-effort and never blocks the turn.
    try {
        const clockSettings = settings?.clock ?? {};
        const autoHold = isObject(clockSettings.autoHold) ? clockSettings.autoHold : {};
        const sceneNow = isObject(scene) ? scene : {};
        // The live `scene` argument is the flow object, not the document; read
        // the world's scene first and fall back to the injected object for
        // tests and future flow shapes.
        const worldScene = store.get()?.scene;
        const encounter = isObject(worldScene?.encounter)
            ? worldScene.encounter
            : (isObject(sceneNow.encounter) ? sceneNow.encounter : null);
        const hasEncounter = isObject(encounter);
        let hold = store.get()?.flags?.clock?.hold;
        let held = hold?.active === true;

        if (autoHold.encounter === true && hasEncounter && !held) {
            store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'encounter' });
            hold = store.get()?.flags?.clock?.hold;
            held = hold?.active === true;
        } else if (held && hold?.reason === 'encounter' && !hasEncounter) {
            store.dispatch({
                type: 'SET_CLOCK_HOLD',
                active: false,
                reason: 'encounter-cleared',
            });
            hold = store.get()?.flags?.clock?.hold;
            held = hold?.active === true;
        }

        const beatId = typeof worldScene?.beatId === 'string' && worldScene.beatId.length > 0
            ? worldScene.beatId
            : (typeof sceneNow.beatId === 'string' && sceneNow.beatId.length > 0
                ? sceneNow.beatId
                : null);
        const hasBeat = typeof beatId === 'string';
        if (autoHold.beat === true && hasBeat && !held) {
            store.dispatch({ type: 'SET_CLOCK_HOLD', active: true, reason: 'beat' });
        } else if (held && hold?.reason === 'beat' && !hasBeat) {
            store.dispatch({ type: 'SET_CLOCK_HOLD', active: false, reason: 'beat-cleared' });
        }
    } catch (error) {
        logWarning(log, 'Could not resolve the clock auto-hold', error);
    }

    // Stage 1: advance the world clock once per genuine assistant turn. An
    // automatic turn uses the clock-aware payload; an explicit multi-turn tick
    // keeps its exact length.
    let ticked = false;
    if (Number.isFinite(tickTurns) && tickTurns > 0) {
        emitStage('clock', 'start', { turns: tickTurns });
        try {
            const current = store.get();
            const tick = tickTurns === 1
                ? buildClockTurn({ state: current, settings })
                : buildClockTick({ state: current, settings, turns: tickTurns });
            store.dispatch(tick);
            ticked = true;
            emitStage('clock', 'done');
        } catch (error) {
            logWarning(log, 'Could not advance the world clock', error);
            errors.push({ stage: 'tick', error: error?.message ?? String(error) });
            emitStage('clock', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('clock', 'skipped', { reason: 'no-ticks' });
    }

    // Stage 1.5: the off-screen world tick. It only runs after a successful
    // clock stage; while time is held the flow itself reports `time-held`.
    let worldTickReport = { ran: false, reason: 'absent' };
    if (typeof worldTick?.run === 'function' && ticked) {
        emitStage('world-tick', 'start');
        try {
            const report = await worldTick.run({});
            worldTickReport = isObject(report) ? report : { ran: false, reason: 'invalid-report' };
            emitStage('world-tick', 'done', { ran: worldTickReport.ran === true });
        } catch (error) {
            worldTickReport = {
                ran: false,
                reason: 'failed',
                error: error?.message ?? String(error),
            };
            logWarning(log, 'Off-screen world tick failed; state unchanged', error);
            errors.push({
                stage: 'world-tick',
                error: error?.message ?? String(error),
            });
            emitStage('world-tick', 'failed', { error: error?.message ?? String(error) });
        }
    }

    // Stage 1.75: deterministic scene-drift analysis. It writes only
    // `flags.pacing` and never changes story state.
    let pacingReport = { ran: false, reason: 'absent' };
    if (settings?.pacing?.enabled !== false) {
        emitStage('pacing', 'start');
        try {
            const analysis = analyzePacing({ state: store.get(), settings });
            const recorded = recordPacing(store, analysis);
            pacingReport = {
                ran: recorded.ok === true,
                reason: recorded.ok === true ? analysis.level : 'record-failed',
                level: analysis.level,
                suggestion: analysis.suggestion,
                held: analysis.held,
                canCut: analysis.canCut,
            };
            if (recorded.ok !== true) {
                logWarning(log, 'Could not record the pacing analysis; state unchanged',
                    recorded.error);
                errors.push({ stage: 'pacing', error: recorded.error ?? 'record failed' });
                emitStage('pacing', 'failed', { error: recorded.error ?? 'record failed' });
            } else {
                emitStage('pacing', 'done', { level: analysis.level });
            }
        } catch (error) {
            pacingReport = { ran: false, reason: 'failed', error: error?.message ?? String(error) };
            logWarning(log, 'Pacing analysis failed; state unchanged', error);
            errors.push({ stage: 'pacing', error: error?.message ?? String(error) });
            emitStage('pacing', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('pacing', 'skipped', { reason: 'disabled' });
    }

    // Stage 2: the player tracker. Disabled means no run call at all; a failed
    // or aborted pass keeps the state and never blocks the later stages.
    const enabled = settings?.agents?.stateTracker?.enabled !== false;
    let trackerReport = { ran: false, reason: 'disabled' };
    if (enabled && typeof tracker?.run === 'function') {
        emitStage('tracker', 'start');
        try {
            const result = await tracker.run({
                state: store.get(),
                message,
                recentMessages,
            });
            const applied = applyStateTrackerResult(store, result, { log });
            trackerReport = {
                ran: true,
                applied: applied?.ok === true,
                cleared: applied?.cleared ?? 0,
                events: Array.isArray(result?.events) ? result.events.length : 0,
                source: result?.source ?? null,
                error: applied?.error ?? null,
            };
            if (applied?.ok !== true) {
                errors.push({ stage: 'tracker', error: applied?.error ?? 'tracker apply failed' });
                emitStage('tracker', 'failed', { error: applied?.error ?? 'tracker apply failed' });
            } else {
                emitStage('tracker', 'done', { source: result?.source ?? null });
            }
        } catch (error) {
            const aborted = isAbortError(error);
            trackerReport = {
                ran: false,
                reason: aborted ? 'aborted' : 'failed',
                error: error?.message ?? String(error),
            };
            logWarning(log, 'Player tracker pass failed; state unchanged', error);
            errors.push({
                stage: 'tracker',
                error: error?.message ?? String(error),
            });
            emitStage('tracker', 'failed', { error: error?.message ?? String(error) });
        }
    } else if (enabled) {
        trackerReport = { ran: false, reason: 'no-tracker' };
        emitStage('tracker', 'skipped', { reason: 'no-tracker' });
    } else {
        emitStage('tracker', 'skipped', { reason: 'disabled' });
    }

    // Stage 3: the storyline keeps its own cadence inside `initiative`.
    let storyline = { ran: false, reason: 'absent' };
    if (typeof initiative?.afterTurn === 'function') {
        emitStage('storyline', 'start');
        try {
            const result = await initiative.afterTurn({ recentProse: message });
            storyline = {
                ran: result?.ran === true,
                reason: result?.reason ?? null,
            };
            emitStage('storyline', 'done', { ran: storyline.ran, reason: storyline.reason });
        } catch (error) {
            const aborted = isAbortError(error);
            storyline = {
                ran: false,
                reason: aborted ? 'aborted' : 'failed',
                error: error?.message ?? String(error),
            };
            logWarning(log, 'Storyline pass failed after a message', error);
            errors.push({
                stage: 'storyline',
                error: error?.message ?? String(error),
            });
            emitStage('storyline', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('storyline', 'skipped', { reason: 'absent' });
    }

    // Stage 3.5: the Lore pass on its cadence (every N turns / act change).
    let loreReport = { ran: false, reason: 'absent' };
    if (typeof initiative?.runLore === 'function') {
        emitStage('lore', 'start');
        try {
            const report = await initiative.runLore({ recentProse: message, recentMessages });
            loreReport = isObject(report) ? report : { ran: false, reason: 'invalid-report' };
            if (loreReport.ran === true) {
                emitStage('lore', 'done', { reason: loreReport.reason ?? null });
            } else if (loreReport.reason === 'failed' || loreReport.reason === 'apply-failed') {
                errors.push({ stage: 'lore', error: loreReport.error ?? 'lore failed' });
                emitStage('lore', 'failed', { error: loreReport.error ?? 'lore failed' });
            } else {
                emitStage('lore', 'skipped', { reason: loreReport.reason ?? 'not-due' });
            }
        } catch (error) {
            loreReport = { ran: false, reason: 'failed', error: error?.message ?? String(error) };
            logWarning(log, 'Lore pass failed after a message', error);
            errors.push({ stage: 'lore', error: error?.message ?? String(error) });
            emitStage('lore', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('lore', 'skipped', { reason: 'absent' });
    }

    // Stage 3.75: the Auditor on act boundaries. Findings never block play.
    let auditorReport = { ran: false, reason: 'absent', findings: [] };
    if (typeof initiative?.runAudit === 'function') {
        emitStage('auditor', 'start');
        try {
            const report = await initiative.runAudit({ recentProse: message, recentMessages });
            auditorReport = isObject(report) ? report : { ran: false, reason: 'invalid-report', findings: [] };
            if (auditorReport.ran === true) {
                emitStage('auditor', 'done', {
                    findings: Array.isArray(auditorReport.findings) ? auditorReport.findings.length : 0,
                });
            } else if (auditorReport.reason === 'failed' || auditorReport.reason === 'apply-failed') {
                errors.push({ stage: 'auditor', error: auditorReport.error ?? 'audit failed' });
                emitStage('auditor', 'failed', { error: auditorReport.error ?? 'audit failed' });
            } else {
                emitStage('auditor', 'skipped', { reason: auditorReport.reason ?? 'not-due' });
            }
        } catch (error) {
            auditorReport = { ran: false, reason: 'failed', findings: [], error: error?.message ?? String(error) };
            logWarning(log, 'Auditor pass failed after a message', error);
            errors.push({ stage: 'auditor', error: error?.message ?? String(error) });
            emitStage('auditor', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('auditor', 'skipped', { reason: 'absent' });
    }

    // Stage 4: refresh the present cast; manual pins/removals win in scene.js.
    // The Cast Director runs on its cadence; travel always requests a pass.
    let cast = null;
    let castDirectorDecision = { run: false, reason: 'no-scene' };
    if (typeof scene?.refreshCast === 'function') {
        emitStage('cast', 'start');
        try {
            castDirectorDecision = shouldRunCastDirector({
                state: store.get(),
                settings,
                trigger: 'turn',
            });
            cast = await scene.refreshCast({ runDirector: castDirectorDecision.run === true });
            emitStage('cast', 'done', { director: castDirectorDecision.run === true });
        } catch (error) {
            cast = null;
            logWarning(log, 'Cast refresh failed after a message', error);
            errors.push({
                stage: 'cast',
                error: error?.message ?? String(error),
            });
            emitStage('cast', 'failed', { error: error?.message ?? String(error) });
        }
    } else {
        emitStage('cast', 'skipped', { reason: 'absent' });
    }

    let turn = null;
    let clock = null;
    try {
        const after = store.get();
        turn = after?.meta?.turn ?? null;
        clock = {
            held: isClockHeld(after),
            storyTurn: effectiveStoryTurn(after),
            timeOfDay: after?.meta?.timeOfDay ?? null,
            date: after?.meta?.inGameDate ?? null,
        };
    } catch (error) {
        logWarning(log, 'Could not read the world clock after the turn', error);
        errors.push({ stage: 'turn-read', error: error?.message ?? String(error) });
    }

    return {
        ok: true,
        ticked,
        turn,
        clock,
        worldTick: worldTickReport,
        pacing: pacingReport,
        tracker: trackerReport,
        storyline,
        lore: loreReport,
        auditor: auditorReport,
        cast,
        castDirector: castDirectorDecision,
        errors,
    };
}

/**
 * Stable identity for one assistant message across swipes. The first swipe's
 * `send_date` survives a swipe re-render; a genuinely new message that reuses a
 * deleted index gets a new date and is therefore a new turn.
 */
export function messageTurnIdentity(message) {
    const first = Array.isArray(message?.swipe_info) ? message.swipe_info[0] : null;
    const date = first?.send_date ?? message?.send_date;
    if (typeof date === 'string' && date.length > 0) {
        return date;
    }
    return typeof message?.mes === 'string' ? `len:${message.mes.length}` : '';
}

/**
 * Accept each (chatId, messageIndex, messageIdentity) once; a swipe re-render
 * keeps the same identity and is not a new turn.
 */
export function createTurnGate() {
    let last = null;
    return {
        accept({ chatId = null, messageIndex = -1, identity = '' } = {}) {
            const key = [
                chatId ?? '',
                Number.isInteger(messageIndex) ? messageIndex : -1,
                identity ?? '',
            ].join(':');
            if (last === key) return false;
            last = key;
            return true;
        },
        reset() { last = null; },
        get last() { return last; },
    };
}

export { playerView as describePlayerTrackerTarget };
