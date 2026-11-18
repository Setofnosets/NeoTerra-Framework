/**
 * Pure world-clock helpers.
 *
 * The mechanical turn counter (`meta.turn`) always advances. Fiction time
 * (`meta.storyTurn`, `meta.inGameDate`, `meta.timeOfDay`) is owned here and can
 * be frozen by a hold. Nothing in this module touches the DOM or SillyTavern.
 */

import { TIME_SLOTS } from './constants.js';

export { TIME_SLOTS };

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_SLOT = 'evening';
const DEFAULT_SLOTS_PER_DAY = TIME_SLOTS.length;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSlot(slot) {
    return TIME_SLOTS.includes(slot) ? slot : DEFAULT_SLOT;
}

export function isValidSlot(slot) {
    return TIME_SLOTS.includes(slot);
}

/** The next slot; invalid input is treated as `evening`. */
export function nextSlot(slot) {
    const index = TIME_SLOTS.indexOf(normalizeSlot(slot));
    return TIME_SLOTS[(index + 1) % TIME_SLOTS.length];
}

/**
 * Parse a `YYYY-MM-DD` calendar date into a UTC-midnight Date.
 * Returns null for anything that is not a real calendar date.
 */
export function parseIsoDate(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const match = ISO_DATE.exec(value);
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (
        date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day
    ) {
        return null;
    }
    return date;
}

/** Format a Date as `YYYY-MM-DD` in UTC; null when the date is invalid. */
export function formatIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return null;
    }
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Add whole days to an ISO date. `null` stays `null`. */
export function addDays(isoDate, days) {
    if (isoDate === null || isoDate === undefined) {
        return null;
    }
    const parsed = parseIsoDate(isoDate);
    if (!parsed || !Number.isInteger(days)) {
        return null;
    }
    const next = new Date(parsed.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return formatIsoDate(next);
}

/** Integer day difference (`to - from`), or null when either date is invalid. */
export function diffDays(fromIso, toIso) {
    const from = parseIsoDate(fromIso);
    const to = parseIsoDate(toIso);
    if (!from || !to) {
        return null;
    }
    return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Advance the clock by `turns` slots. One slot per turn; a day is added every
 * time the slot index wraps from `night` to `dawn`.
 *
 * @param {{ date?: string|null, timeOfDay?: string, turns?: number }} [options]
 * @returns {{ date: string|null, timeOfDay: string, days: number }}
 */
export function advanceClock({ date = null, timeOfDay = DEFAULT_SLOT, turns = 1 } = {}) {
    const slot = normalizeSlot(timeOfDay);
    const parsed = typeof date === 'string' ? parseIsoDate(date) : null;
    // A malformed authored date is preserved (and surfaced by validation)
    // instead of being silently erased. Arithmetic only runs on a real date.
    const baseDate = parsed
        ? formatIsoDate(parsed)
        : (typeof date === 'string' && date.length > 0 ? date : null);

    if (!Number.isInteger(turns) || turns < 0) {
        return { date: baseDate, timeOfDay: slot, days: 0 };
    }
    if (turns === 0) {
        return { date: baseDate, timeOfDay: slot, days: 0 };
    }

    let index = TIME_SLOTS.indexOf(slot);
    let days = 0;
    for (let turn = 0; turn < turns; turn += 1) {
        index += 1;
        if (index >= TIME_SLOTS.length) {
            index = 0;
            days += 1;
        }
    }

    return {
        date: parsed && baseDate !== null ? addDays(baseDate, days) : baseDate,
        timeOfDay: TIME_SLOTS[index],
        days,
    };
}

/** The `flags.clock` object, or an empty object. */
export function getClockFlags(state) {
    return isObject(state?.flags?.clock) ? state.flags.clock : {};
}

export function isClockHeld(state) {
    return state?.flags?.clock?.hold?.active === true;
}

/** Normalized hold record. */
export function getHold(state) {
    const hold = isObject(getClockFlags(state).hold) ? getClockFlags(state).hold : {};
    return {
        active: hold.active === true,
        reason: typeof hold.reason === 'string' ? hold.reason : null,
        sinceTurn: Number.isInteger(hold.sinceTurn) && hold.sinceTurn >= 0 ? hold.sinceTurn : 0,
        sinceDate: typeof hold.sinceDate === 'string' ? hold.sinceDate : null,
    };
}

export function getHoldReason(state) {
    const hold = getClockFlags(state).hold;
    return isObject(hold) && typeof hold.reason === 'string' ? hold.reason : null;
}

/**
 * Fiction turn. V1 documents without `meta.storyTurn` fall back to `meta.turn`;
 * a valid state never yields undefined.
 */
export function effectiveStoryTurn(state) {
    const storyTurn = state?.meta?.storyTurn;
    if (Number.isInteger(storyTurn) && storyTurn >= 0) {
        return storyTurn;
    }
    const turn = state?.meta?.turn;
    return Number.isInteger(turn) && turn >= 0 ? turn : 0;
}

export function clockEnabled(settings) {
    return settings?.clock?.enabled !== false;
}

/** Future-calendar slot count; the advance algorithm always uses TIME_SLOTS. */
export function slotsPerDay(settings) {
    const value = Number(settings?.clock?.slotsPerDay);
    if (!Number.isFinite(value)) {
        return DEFAULT_SLOTS_PER_DAY;
    }
    return Math.min(12, Math.max(1, Math.round(value)));
}

/**
 * The reducer-shaped TICK_TIME payload for one automatic assistant turn.
 * `turns: 1` always advances the mechanical clock; `storyTurns` decides
 * whether fiction time moves.
 */
export function buildClockTurn({ state, settings } = {}) {
    if (!clockEnabled(settings)) {
        return { type: 'TICK_TIME', turns: 1 };
    }
    if (isClockHeld(state)) {
        return { type: 'TICK_TIME', turns: 1, storyTurns: 0 };
    }
    const advanced = advanceClock({
        date: state?.meta?.inGameDate ?? null,
        timeOfDay: state?.meta?.timeOfDay ?? DEFAULT_SLOT,
        turns: 1,
    });
    return {
        type: 'TICK_TIME',
        turns: 1,
        storyTurns: 1,
        date: advanced.date,
        timeOfDay: advanced.timeOfDay,
    };
}

/**
 * The reducer-shaped TICK_TIME payload for an explicit multi-turn tick
 * (travel, pacing cut). With the clock enabled, fiction time advances by the
 * same number of turns. With the clock disabled it degrades to V1: mechanical
 * turns and fiction turns both advance, while date and slot stay untouched.
 */
export function buildClockTick({ state, settings, turns } = {}) {
    const count = Number.isInteger(turns) ? turns : 0;
    if (!clockEnabled(settings)) {
        // V1 behavior: the mechanical turn counter alone tracks elapsed time,
        // so fiction turns (and every turn-based deadline) must match it.
        return { type: 'TICK_TIME', turns: count, storyTurns: count };
    }
    if (count <= 0) {
        return { type: 'TICK_TIME', turns: count, storyTurns: 0 };
    }
    const advanced = advanceClock({
        date: state?.meta?.inGameDate ?? null,
        timeOfDay: state?.meta?.timeOfDay ?? DEFAULT_SLOT,
        turns: count,
    });
    return {
        type: 'TICK_TIME',
        turns: count,
        storyTurns: count,
        date: advanced.date,
        timeOfDay: advanced.timeOfDay,
    };
}
