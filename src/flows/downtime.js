/**
 * Deterministic downtime and civilian-life actions.
 *
 * Rest, Train, Patrol, Investigate, Socialize, and Work advance the clock by
 * one slot, apply a small bounded change to the player sheet, and append one
 * Journal event. No model call is ever made, so downtime works with every
 * agent disabled. The event table can be authored in data/agendas.json; the
 * built-in fallback keeps the flow usable without a fetch.
 */

import { buildClockTick } from '../core/world-clock.js';
import { applyContentGate } from '../core/content-gate.js';
import { applyEventBatch } from './initiative.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block downtime.
    }
}

/**
 * The six deterministic downtime actions. `cost` and `recovery` are bounded
 * fractions of the player's maxima, never absolute points.
 */
export const DOWNTIME_ACTIONS = Object.freeze([
    {
        id: 'rest',
        label: 'Rest',
        icon: 'fa-bed',
        description: 'Recover stamina and willpower at a safe place.',
        stamina: 0.2,
        willpower: 0.15,
        tags: ['rest', 'recovery'],
    },
    {
        id: 'train',
        label: 'Train',
        icon: 'fa-dumbbell',
        description: 'Push the body and sharpen the will.',
        stamina: -0.08,
        willpower: 0.05,
        tags: ['train', 'practice'],
    },
    {
        id: 'patrol',
        label: 'Patrol',
        icon: 'fa-shield-halved',
        description: 'Walk the district and show the flag.',
        stamina: -0.06,
        willpower: -0.03,
        tags: ['patrol', 'watch'],
    },
    {
        id: 'investigate',
        label: 'Investigate',
        icon: 'fa-magnifying-glass',
        description: 'Follow a lead and read the city for clues.',
        stamina: -0.02,
        willpower: -0.05,
        tags: ['investigate', 'lead'],
    },
    {
        id: 'socialize',
        label: 'Socialize',
        icon: 'fa-mug-hot',
        description: 'Spend time with the people around you.',
        stamina: 0.02,
        willpower: 0.06,
        tags: ['socialize', 'civilian'],
    },
    {
        id: 'work',
        label: 'Work',
        icon: 'fa-briefcase',
        description: 'Take a shift and keep a roof overhead.',
        stamina: -0.08,
        willpower: 0.04,
        tags: ['work', 'civilian'],
    },
]);

export const DOWNTIME_ACTION_IDS = Object.freeze(DOWNTIME_ACTIONS.map((action) => action.id));

const ACTION_BY_ID = new Map(DOWNTIME_ACTIONS.map((action) => [action.id, action]));

const DEFAULT_EVENTS = Object.freeze([
    'A quiet shift passes in {location}; the city keeps its small routines.',
    'Someone in {location} shares a rumor and asks for nothing in return.',
    'The district settles into its evening rhythm around {location}.',
]);

/** Pick the authored downtime event table, falling back to the built-ins. */
export function resolveDowntimeEvents(document, seasonId = null) {
    const downtime = isObject(document?.downtime) ? document.downtime : null;
    if (!downtime) {
        return [...DEFAULT_EVENTS];
    }
    const season = typeof seasonId === 'string' && isObject(downtime.seasons?.[seasonId])
        ? downtime.seasons[seasonId]
        : {};
    const list = Array.isArray(season.events) && season.events.length > 0
        ? season.events
        : (Array.isArray(downtime.events) && downtime.events.length > 0
            ? downtime.events
            : DEFAULT_EVENTS);
    return list.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/** Deterministic index for the civilian-life table. */
function pickEvent(events, seed) {
    const list = asArray(events).filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (list.length === 0) {
        return DEFAULT_EVENTS[0];
    }
    let hash = 0x811c9dc5;
    const text = String(seed ?? '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return list[hash % list.length];
}

function statDelta(current, max, fraction) {
    const maximum = Number.isFinite(max) && max > 0 ? max : 10;
    const amount = Math.round(maximum * Math.abs(fraction));
    if (amount <= 0) {
        return null;
    }
    return Math.round(clamp(current + (fraction >= 0 ? amount : -amount), 0, maximum));
}

/**
 * Build one downtime turn without mutating anything. Returns the reducer
 * events, the Journal summary, and an optional short scene prompt.
 */
export function buildDowntimePlan({
    actionId,
    state,
    season = null,
    settings = {},
    events = DEFAULT_EVENTS,
} = {}) {
    const action = ACTION_BY_ID.get(actionId);
    if (!action) {
        return { ok: false, reason: 'unknown-action', actionId };
    }
    if (!isObject(state) || !isObject(state.player)) {
        return { ok: false, reason: 'no-state', action };
    }
    const player = state.player;
    const turn = state.meta?.turn ?? 0;
    const locationId = state.scene?.locationId ?? null;
    const locationName = state.locations?.[locationId]?.name ?? locationId ?? 'the district';
    const level = settings?.contentGate ?? 'full';
    const limits = isObject(settings?.contentLimits) ? settings.contentLimits : {};

    const reducerEvents = [];
    const clock = buildClockTick({ state, settings, turns: 1 });
    if (clock) {
        reducerEvents.push(clock);
    }

    for (const [field, fraction] of [['stamina', action.stamina], ['willpower', action.willpower]]) {
        const bucket = player[field];
        if (!isObject(bucket)) {
            continue;
        }
        const next = statDelta(Number(bucket.current ?? 0), Number(bucket.max ?? 0), fraction);
        if (Number.isFinite(next) && next !== Number(bucket.current ?? 0)) {
            reducerEvents.push({
                type: 'SET_PLAYER_STAT',
                path: `${field}.current`,
                value: next,
            });
        }
    }

    const eventText = pickEvent(events, `${state.seasonId ?? ''}:${turn}:${action.id}`)
        .replaceAll('{location}', String(locationName));
    const gatedEvent = applyContentGate(eventText, level, limits, {});
    const safeEvent = gatedEvent.trim().length > 0
        ? gatedEvent
        : `A quiet ${action.label.toLowerCase()} passes without incident.`;
    const summary = applyContentGate(
        `${action.label} in ${locationName}: ${safeEvent}`,
        level,
        limits,
        {},
    );
    const resolvedSummary = summary.trim().length > 0
        ? summary
        : `${action.label} in ${locationName}.`;
    reducerEvents.push({
        type: 'ADD_EVENT',
        summary: resolvedSummary,
        headline: action.label,
        actors: player.identity === 'canon' && typeof player.characterId === 'string'
            ? [player.characterId]
            : [],
        locationId,
        tags: ['downtime', action.id, ...action.tags],
        turn,
    });

    return {
        ok: true,
        action,
        turn,
        events: reducerEvents,
        summary: resolvedSummary,
        prompt: applyContentGate(
            `${action.label}: ${safeEvent}`,
            level,
            limits,
            {},
        ) || `${action.label} in ${locationName}.`,
    };
}

/**
 * Apply a downtime action atomically. `loadEvents` may return an authored
 * table from data/agendas.json; a failure falls back to the built-in table.
 */
export function createDowntimeFlow({
    store,
    season = null,
    getSeason = null,
    getSettings = null,
    loadEvents = null,
    now = Date.now,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('createDowntimeFlow requires a WorldState store');
    }
    let cachedEvents = null;

    function currentSeason() {
        if (season) {
            return season;
        }
        return typeof getSeason === 'function' ? getSeason() : null;
    }

    function currentSettings() {
        return (typeof getSettings === 'function' ? getSettings() : null) ?? {};
    }

    async function resolveEvents() {
        if (cachedEvents) {
            return cachedEvents;
        }
        if (typeof loadEvents === 'function') {
            try {
                const loaded = await loadEvents();
                if (Array.isArray(loaded) && loaded.length > 0) {
                    cachedEvents = loaded;
                    return cachedEvents;
                }
            } catch (error) {
                logWarning(log, 'Could not load the downtime event table; using built-ins', error);
            }
        }
        cachedEvents = [...DEFAULT_EVENTS];
        return cachedEvents;
    }

    async function perform(actionId) {
        const state = store.get();
        if (!isObject(state)) {
            return { ok: false, reason: 'no-world' };
        }
        const events = await resolveEvents();
        const plan = buildDowntimePlan({
            actionId,
            state,
            season: currentSeason(),
            settings: currentSettings(),
            events,
        });
        if (!plan.ok) {
            return plan;
        }
        const applied = applyEventBatch(store, plan.events, {
            context: {},
            log,
        });
        return {
            ...plan,
            ok: applied.ok,
            ran: applied.ok,
            state: applied.state,
            error: applied.error,
        };
    }

    return {
        actions: DOWNTIME_ACTIONS,
        perform,
        buildView: (actionId) => buildDowntimePlan({
            actionId,
            state: store.get(),
            season: currentSeason(),
            settings: currentSettings(),
            events: cachedEvents ?? DEFAULT_EVENTS,
        }),
        now,
    };
}
