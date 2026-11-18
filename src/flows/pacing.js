/**
 * Pacing / scene director.
 *
 * Two halves, both deterministic:
 *
 * 1. `analyzePacing` reads only the world state and returns a level
 *    (`ok | nudge | cut | stalled`), the reasons, and whether an explicit cut is
 *    allowed. It never mutates story state.
 * 2. `createPacingFlow(...).cutScene(...)` is the explicit cut. It advances
 *    time, changes framing and refreshes the cast *at the same location*. It
 *    never moves the player and never auto-posts prose.
 *
 * No LLM is involved. The narration nudge block (a later step) consumes
 * `flags.pacing`; this module only writes that analysis.
 */

import { buildClockTick, isClockHeld } from '../core/world-clock.js';
import { applyEventBatch } from './initiative.js';
import { validateWorldState } from '../state/world-state.js';

export const PACING_LEVELS = Object.freeze(['ok', 'nudge', 'cut', 'stalled']);

const PACING_TAG = 'pacing';
const CUT_REASON_MAX = 160;

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
        // Logging must never break a turn.
    }
}

function integerSetting(value, fallback, { min = 0, max = 1000 } = {}) {
    return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Normalized pacing settings; tolerant of a partial settings object. */
export function pacingSettings(settings) {
    const raw = isObject(settings?.pacing) ? settings.pacing : {};
    return {
        enabled: raw.enabled !== false,
        stallTurns: integerSetting(raw.stallTurns, 3, { min: 1, max: 100 }),
        sceneMaxTurns: integerSetting(raw.sceneMaxTurns, 12, { min: 2, max: 500 }),
        threatNudgeTurns: integerSetting(raw.threatNudgeTurns, 10, { min: 1, max: 500 }),
        cutScore: integerSetting(raw.cutScore, 4, { min: 1, max: 20 }),
        nudgeScore: integerSetting(raw.nudgeScore, 2, { min: 1, max: 20 }),
        cutSlots: integerSetting(raw.cutSlots, 2, { min: 1, max: 12 }),
        snoozeTurns: integerSetting(raw.snoozeTurns, 3, { min: 1, max: 100 }),
    };
}

function endingActive(state) {
    return state?.ending?.status === 'epilogue' || state?.ending?.status === 'ended';
}

function inCombat(state) {
    return state?.meta?.inCombat === true || isObject(state?.scene?.combat);
}

/** Last event that was not caused by pacing itself. */
function lastNonPacingEventTurn(state) {
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        if (!tags.includes(PACING_TAG)) {
            return Number.isInteger(event?.turn) ? event.turn : null;
        }
    }
    return null;
}

function currentSnooze(state) {
    const value = state?.flags?.pacing?.snoozedUntilTurn;
    return Number.isInteger(value) ? value : null;
}

/** Last event turn carrying any of `tags`. */
function lastEventTurnWithTag(state, tag) {
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        if (tags.includes(tag)) {
            return Number.isInteger(event?.turn) ? event.turn : null;
        }
    }
    return null;
}

/**
 * Analyze scene drift. Pure: reads `state`, returns a plain report.
 *
 * @param {{
 *   state: object|null,
 *   settings?: object|null,
 *   turn?: number|null,
 *   date?: string|null,
 * }} options
 */
export function analyzePacing({ state, settings = null, turn = null, date = null } = {}) {
    const config = pacingSettings(settings);
    const now = Number.isInteger(turn) ? turn : (state?.meta?.turn ?? 0);
    const held = isClockHeld(state);
    const existing = isObject(state?.flags?.pacing) ? state.flags.pacing : {};
    const snoozedUntilTurn = Number.isInteger(existing.snoozedUntilTurn)
        ? existing.snoozedUntilTurn
        : null;
    const lastCutTurn = Number.isInteger(existing.lastCutTurn) ? existing.lastCutTurn : null;
    const base = {
        enabled: config.enabled,
        held,
        analyzedDate: typeof date === 'string' ? date : (state?.meta?.inGameDate ?? null),
        lastAnalyzedTurn: now,
        lastCutTurn,
        snoozedUntilTurn,
        suggestedSlots: config.cutSlots,
        level: 'ok',
        reasons: [],
        codes: [],
        score: 0,
        canCut: true,
        suggestion: 'none',
    };

    if (!isObject(state)) {
        return { ...base, enabled: false, canCut: false, reason: 'no-state' };
    }
    if (!config.enabled) {
        return { ...base, canCut: false, reason: 'disabled' };
    }
    if (endingActive(state)) {
        return {
            ...base,
            canCut: false,
            reason: 'ending',
            reasons: ['The ending screen is active.'],
            codes: ['ending'],
        };
    }
    if (snoozedUntilTurn !== null && now <= snoozedUntilTurn) {
        return {
            ...base,
            canCut: false,
            reason: 'snoozed',
            reasons: [`Pacing is snoozed until turn ${snoozedUntilTurn}.`],
            codes: ['snoozed'],
        };
    }
    if (inCombat(state)) {
        return {
            ...base,
            canCut: false,
            reason: 'combat',
            reasons: ['Combat is active.'],
            codes: ['combat'],
        };
    }

    const flags = isObject(state.flags) ? state.flags : {};
    // A scene starts when the location changes (tracked by `recordPacing`) or
    // after a cut. `castDirector.turn` is a cast-refresh timestamp, not a scene
    // start, so it must never be used here.
    const sceneStart = Number.isInteger(existing.sceneStartedTurn)
        ? existing.sceneStartedTurn
        : now;
    const sceneTurns = Math.max(0, now - sceneStart);
    const lastEventTurn = lastNonPacingEventTurn(state);
    const lastActivityTurn = lastEventTurn === null
        ? lastCutTurn
        : (lastCutTurn === null ? lastEventTurn : Math.max(lastEventTurn, lastCutTurn));
    const turnsSinceEvent = lastActivityTurn === null
        ? sceneTurns
        : Math.max(0, now - lastActivityTurn);
    const lastTravelTurn = Number.isInteger(flags.travel?.lastAt) ? flags.travel.lastAt : null;
    const turnsSinceTravel = lastTravelTurn === null ? sceneTurns : Math.max(0, now - lastTravelTurn);
    // "Beat action": a beat-tagged event or a storyline pass, whichever is later.
    const lastBeatEventTurn = lastEventTurnWithTag(state, 'beat');
    const lastStorylineTurn = Number.isInteger(flags.storyline?.lastRunTurn)
        ? flags.storyline.lastRunTurn
        : null;
    const lastBeatTurn = lastBeatEventTurn === null
        ? (lastStorylineTurn ?? sceneStart)
        : (lastStorylineTurn === null
            ? lastBeatEventTurn
            : Math.max(lastBeatEventTurn, lastStorylineTurn));
    const turnsSinceBeat = Math.max(0, now - lastBeatTurn);

    const reasons = [];
    const codes = [];
    let score = 0;

    if (sceneTurns >= config.sceneMaxTurns) {
        score += 4;
        reasons.push(`${sceneTurns} turns in this scene.`);
        codes.push('long-scene');
    }
    if (turnsSinceEvent >= config.stallTurns) {
        score += 2;
        reasons.push(`No development in ${turnsSinceEvent} turns.`);
        codes.push('no-development');
    }
    if (turnsSinceBeat >= config.threatNudgeTurns) {
        score += 2;
        reasons.push(`No beat movement in ${turnsSinceBeat} turns.`);
        codes.push('threat-stale');
    }
    if (turnsSinceTravel >= config.threatNudgeTurns) {
        score += 1;
        reasons.push(`No travel in ${turnsSinceTravel} turns.`);
        codes.push('static-location');
    }

    let level = 'ok';
    if (score >= config.nudgeScore) {
        level = 'nudge';
    }
    if (score >= config.cutScore) {
        level = 'cut';
    }
    // "Stalled" is reserved for a scene that has doubled the long-scene bound;
    // ordinary drift is a cut, not an emergency.
    if (sceneTurns >= config.sceneMaxTurns * 2) {
        level = 'stalled';
    }

    // A held scene is intentionally not cut; offer to release time instead.
    if (held && level !== 'ok') {
        level = 'nudge';
        reasons.unshift('Time is frozen in this scene.');
        codes.unshift('time-held');
    }

    const suggestion = held ? 'release-time' : (level === 'cut' || level === 'stalled' ? 'cut' : 'none');
    return {
        ...base,
        level,
        reasons,
        codes,
        score,
        canCut: !held && suggestion === 'cut',
        suggestion,
        sceneTurns,
        turnsSinceEvent,
        turnsSinceTravel,
        turnsSinceBeat,
    };
}

/** The `flags.pacing` payload to persist after an analysis. */
export function pacingPatch(analysis) {
    return {
        level: analysis.level,
        reasons: Array.isArray(analysis.reasons) ? analysis.reasons.slice() : [],
        codes: Array.isArray(analysis.codes) ? analysis.codes.slice() : [],
        score: Number.isFinite(analysis.score) ? analysis.score : 0,
        suggestedSlots: analysis.suggestedSlots,
        held: analysis.held === true,
        canCut: analysis.canCut === true,
        suggestion: analysis.suggestion ?? 'none',
        lastAnalyzedTurn: analysis.lastAnalyzedTurn,
        lastCutTurn: analysis.lastCutTurn ?? null,
        snoozedUntilTurn: analysis.snoozedUntilTurn ?? null,
        sceneTurns: analysis.sceneTurns ?? 0,
    };
}

/**
 * Persist an analysis without touching story state.
 *
 * @param {object} store WorldState store
 * @param {object} analysis result of `analyzePacing`
 */
export function recordPacing(store, analysis) {
    if (!store || typeof store.replace !== 'function') {
        return { ok: false, error: 'no-store' };
    }
    const state = store.get();
    if (!isObject(state)) {
        return { ok: false, error: 'no-state' };
    }
    const previous = isObject(state.flags?.pacing) ? state.flags.pacing : {};
    const locationId = state.scene?.locationId ?? null;
    // Track the actual scene boundary: a location change resets it, everything
    // else (including a per-turn cast refresh) keeps the original start.
    const sameScene = Number.isInteger(previous.sceneStartedTurn)
        && (previous.sceneLocationId ?? null) === locationId;
    const sceneStartedTurn = sameScene
        ? previous.sceneStartedTurn
        : analysis.lastAnalyzedTurn;
    const next = {
        ...state,
        flags: {
            ...(state.flags ?? {}),
            pacing: {
                ...pacingPatch(analysis),
                sceneStartedTurn,
                sceneLocationId: locationId,
            },
        },
    };
    const validation = validateWorldState(next);
    if (!validation.ok) {
        return {
            ok: false,
            error: validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('; '),
        };
    }
    try {
        store.replace(next);
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
    return { ok: true };
}

/** Deterministic cut framing; never invents plot, only time and framing. */
export function buildCutFraming({ locationName = null, slots = 2, reason = null } = {}) {
    const place = typeof locationName === 'string' && locationName.length > 0
        ? locationName
        : 'the same place';
    const trimmedReason = typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim().slice(0, CUT_REASON_MAX)
        : null;
    const time = `${slots} slot${slots === 1 ? '' : 's'} later`;
    return trimmedReason
        ? `Time moves on — ${time}. The scene resumes at ${place}. ${trimmedReason}`
        : `Time moves on — ${time}. The scene resumes at ${place}.`;
}

/** Deterministic event summary for a cut. */
export function buildCutSummary({ locationName = null, slots = 2, reason = null } = {}) {
    const place = typeof locationName === 'string' && locationName.length > 0
        ? locationName
        : 'the same place';
    const trimmedReason = typeof reason === 'string' ? reason.trim().slice(0, CUT_REASON_MAX) : '';
    return `Meanwhile, ${slots} slot${slots === 1 ? '' : 's'} pass at ${place}.`
        + (trimmedReason.length > 0 ? ` ${trimmedReason}` : '');
}

/**
 * Create the pacing flow (explicit cut + snooze).
 *
 * @param {{
 *   store: object,
 *   season?: object|null,
 *   scene?: object|null,
 *   initiative?: object|null,
 *   getSettings?: (() => object|null)|null,
 *   now?: () => number,
 *   log?: ((message: string, error?: unknown) => void)|null,
 * }} options
 */
export function createPacingFlow({
    store,
    season = null,
    scene = null,
    initiative = null,
    getSettings = null,
    now = Date.now,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('createPacingFlow requires a WorldState store');
    }
    const clock = typeof now === 'function' ? now : Date.now;
    let cutting = false;

    function settings() {
        try {
            return (typeof getSettings === 'function' ? getSettings() : null) ?? {};
        } catch (error) {
            logWarning(log, 'Could not read pacing settings', error);
            return {};
        }
    }

    function analyze(turn = null) {
        return analyzePacing({ state: store.get(), settings: settings(), turn });
    }

    function refuse(reason, message, extra = {}) {
        return { ok: false, reason, message, ...extra };
    }

    /**
     * Explicit scene cut. Refuses during combat, on the ending screen, and
     * while time is held. Never moves the player.
     */
    async function cutScene({ reason = 'manual', forceBeat = false } = {}) {
        const state = store.get();
        if (!isObject(state)) {
            return refuse('no-state', 'There is no world to cut.');
        }
        if (pacingSettings(settings()).enabled === false) {
            return refuse('disabled', 'The pacing director is disabled.');
        }
        if (cutting) {
            return refuse('busy', 'A cut is already in progress.');
        }
        if (endingActive(state)) {
            return refuse('ending', 'The ending screen owns the scene; it cannot be cut.');
        }
        if (inCombat(state)) {
            return refuse('combat', 'Combat is active; finish the fight first.');
        }
        if (isClockHeld(state)) {
            return refuse(
                'time-held',
                'Time is frozen in this scene. Release time instead of cutting.',
                { offerRelease: true },
            );
        }

        cutting = true;
        try {
            return await runCut({ state, reason, forceBeat });
        } finally {
            cutting = false;
        }
    }

    async function runCut({ state, reason, forceBeat }) {
        const config = pacingSettings(settings());
        const locationId = state.scene?.locationId ?? null;
        const locationName = locationId
            ? state.locations?.[locationId]?.name ?? locationId
            : null;
        const events = [
            { type: 'SET_CLOCK_HOLD', active: false, reason: 'pacing-cut' },
            buildClockTick({ state, settings: settings(), turns: config.cutSlots }),
            {
                type: 'SET_SCENE_FRAMING',
                framing: buildCutFraming({
                    locationName,
                    slots: config.cutSlots,
                    reason: typeof reason === 'string' ? reason : null,
                }),
            },
            {
                type: 'ADD_EVENT',
                summary: buildCutSummary({
                    locationName,
                    slots: config.cutSlots,
                    reason: typeof reason === 'string' ? reason : null,
                }),
                headline: 'Meanwhile',
                actors: [],
                ...(locationId ? { locationId } : {}),
                tags: [PACING_TAG, 'cut'],
            },
        ];

        const applied = applyEventBatch(store, events, {
            log,
            patch: (next) => {
                const previous = isObject(next.flags?.pacing) ? next.flags.pacing : {};
                return {
                    ...next,
                    flags: {
                        ...(next.flags ?? {}),
                        pacing: {
                            ...previous,
                            level: 'ok',
                            reasons: [],
                            codes: [],
                            score: 0,
                            held: false,
                            canCut: false,
                            suggestion: 'none',
                            suggestedSlots: config.cutSlots,
                            lastAnalyzedTurn: next.meta?.turn ?? 0,
                            lastCutTurn: next.meta?.turn ?? 0,
                            sceneStartedTurn: next.meta?.turn ?? 0,
                            sceneLocationId: next.scene?.locationId ?? null,
                            snoozedUntilTurn: previous.snoozedUntilTurn ?? null,
                        },
                    },
                };
            },
        });
        if (applied.ok !== true) {
            return refuse('apply-failed', 'The cut was rejected; the world is unchanged.', {
                error: applied.error ?? null,
            });
        }

        // Same location only: the cut changes time and framing, never the map.
        let cast = null;
        if (typeof scene?.refreshCast === 'function') {
            try {
                cast = await scene.refreshCast({ runDirector: false });
            } catch (error) {
                logWarning(log, 'Cast refresh failed after a pacing cut', error);
            }
        }

        let storyline = null;
        if (forceBeat && typeof initiative?.runStoryline === 'function') {
            try {
                storyline = await initiative.runStoryline({ trigger: 'beat' });
            } catch (error) {
                logWarning(log, 'Storyline beat pass failed after a pacing cut', error);
            }
        }

        return {
            ok: true,
            reason: null,
            slots: config.cutSlots,
            turn: store.get()?.meta?.turn ?? null,
            at: clock(),
            state: store.get(),
            cast,
            storyline,
        };
    }

    /** "Not now": suppress pacing levels until `turn + snoozeTurns`. */
    function snooze({ turns = null } = {}) {
        const state = store.get();
        if (!isObject(state)) {
            return { ok: false, reason: 'no-state' };
        }
        const config = pacingSettings(settings());
        const count = Number.isInteger(turns) && turns > 0 ? turns : config.snoozeTurns;
        const until = (state.meta?.turn ?? 0) + count;
        const previous = isObject(state.flags?.pacing) ? state.flags.pacing : {};
        const applied = applyEventBatch(store, [], {
            log,
            patch: (next) => ({
                ...next,
                flags: {
                    ...(next.flags ?? {}),
                    pacing: {
                        ...previous,
                        level: 'ok',
                        reasons: [],
                        codes: [],
                        canCut: false,
                        suggestion: 'none',
                        snoozedUntilTurn: until,
                    },
                },
            }),
        });
        if (applied.ok !== true) {
            return { ok: false, reason: 'apply-failed', error: applied.error ?? null };
        }
        return { ok: true, snoozedUntilTurn: until, state: store.get() };
    }

    /** Release a hold from the pacing surface. */
    async function releaseTime({ reason = 'pacing-release' } = {}) {
        const state = store.get();
        if (!isObject(state)) {
            return { ok: false, reason: 'no-state' };
        }
        if (!isClockHeld(state)) {
            return { ok: true, alreadyReleased: true, state };
        }
        const applied = applyEventBatch(store, [
            { type: 'SET_CLOCK_HOLD', active: false, reason },
        ], { log });
        if (applied.ok !== true) {
            return { ok: false, reason: 'apply-failed', error: applied.error ?? null };
        }
        // Refresh the analysis so the director card stops offering "Release
        // time" immediately instead of on the next turn.
        try {
            recordPacing(store, analyzePacing({ state: store.get(), settings: settings() }));
        } catch (error) {
            logWarning(log, 'Could not refresh the pacing analysis after release', error);
        }
        return { ok: true, state: store.get() };
    }

    return {
        analyze,
        cutScene,
        snooze,
        releaseTime,
        getSeason: () => season,
    };
}
