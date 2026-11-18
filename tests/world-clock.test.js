import test from 'node:test';
import assert from 'node:assert/strict';

import { TIME_SLOTS } from '../src/core/constants.js';
import {
    addDays,
    advanceClock,
    buildClockTick,
    buildClockTurn,
    clockEnabled,
    diffDays,
    effectiveStoryTurn,
    formatIsoDate,
    getClockFlags,
    getHold,
    getHoldReason,
    isClockHeld,
    isValidSlot,
    nextSlot,
    parseIsoDate,
    slotsPerDay,
} from '../src/core/world-clock.js';
import { buildClockChipModel } from '../src/ui/clock-chip.js';

function clocked(overrides = {}) {
    return {
        meta: {
            turn: 0,
            storyTurn: 0,
            inGameDate: '2037-03-05',
            timeOfDay: 'evening',
            ...(overrides.meta ?? {}),
        },
        flags: overrides.flags ?? {},
    };
}

test('the slot table is frozen and cycles evening to dawn', () => {
    assert.deepEqual(TIME_SLOTS, ['dawn', 'morning', 'afternoon', 'evening', 'night']);
    assert.ok(Object.isFrozen(TIME_SLOTS));
    assert.equal(isValidSlot('night'), true);
    assert.equal(isValidSlot('midnight'), false);
    assert.equal(nextSlot('evening'), 'night');
    assert.equal(nextSlot('night'), 'dawn');
    assert.equal(nextSlot('bogus'), 'night');
});

test('ISO dates parse at UTC midnight and reject impossible calendar days', () => {
    const parsed = parseIsoDate('2036-02-29');
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.getUTCHours(), 0);
    assert.equal(formatIsoDate(parsed), '2036-02-29');

    assert.equal(parseIsoDate('2037-02-29'), null);
    assert.equal(parseIsoDate('2037-13-01'), null);
    assert.equal(parseIsoDate('2037-2-01'), null);
    assert.equal(parseIsoDate(null), null);
    assert.equal(formatIsoDate(new Date('nope')), null);
});

test('day arithmetic crosses months, years, and leap days', () => {
    assert.equal(addDays('2037-03-31', 1), '2037-04-01');
    assert.equal(addDays('2037-12-31', 1), '2038-01-01');
    assert.equal(addDays('2036-02-28', 1), '2036-02-29');
    assert.equal(addDays('2037-02-28', 1), '2037-03-01');
    assert.equal(addDays(null, 5), null);

    assert.equal(diffDays('2037-03-05', '2037-03-05'), 0);
    assert.equal(diffDays('2037-03-05', '2037-02-28'), -5);
    assert.equal(diffDays('2037-03-05', 'nope'), null);
});

test('advanceClock returns to the same slot after one full day', () => {
    const result = advanceClock({ date: '2037-03-05', timeOfDay: 'evening', turns: 5 });
    assert.equal(result.timeOfDay, 'evening');
    assert.equal(result.days, 1);
    assert.equal(result.date, '2037-03-06');
});

test('advanceClock rolls 1, 30, 31, leap-day, and year boundaries correctly', () => {
    assert.equal(
        advanceClock({ date: '2037-03-05', timeOfDay: 'night', turns: 1 }).date,
        '2037-03-06',
    );
    assert.equal(
        advanceClock({ date: '2037-04-01', timeOfDay: 'evening', turns: 30 }).date,
        '2037-04-07',
    );
    assert.equal(
        advanceClock({ date: '2037-01-31', timeOfDay: 'evening', turns: 5 }).date,
        '2037-02-01',
    );
    assert.equal(
        advanceClock({ date: '2036-02-28', timeOfDay: 'evening', turns: 5 }).date,
        '2036-02-29',
    );
    assert.equal(
        advanceClock({ date: '2037-12-31', timeOfDay: 'evening', turns: 5 }).date,
        '2038-01-01',
    );
});

test('a null date never invents a date, and turns:0 is identity', () => {
    const nullDates = advanceClock({ date: null, timeOfDay: 'night', turns: 3 });
    assert.equal(nullDates.date, null);
    assert.equal(nullDates.timeOfDay, 'afternoon');
    assert.equal(nullDates.days, 1);

    const identity = advanceClock({ date: '2037-03-05', timeOfDay: 'evening', turns: 0 });
    assert.deepEqual(identity, { date: '2037-03-05', timeOfDay: 'evening', days: 0 });

    const invalidSlot = advanceClock({ date: '2037-03-05', timeOfDay: 'midnight', turns: 1 });
    assert.equal(invalidSlot.timeOfDay, 'night');
});

test('negative and non-integer turns return the input unchanged', () => {
    const start = { date: '2037-03-05', timeOfDay: 'evening' };
    for (const turns of [-1, 1.5, Number.NaN]) {
        assert.deepEqual(advanceClock({ ...start, turns }), {
            date: '2037-03-05',
            timeOfDay: 'evening',
            days: 0,
        });
    }
});

test('200 consecutive ticks stay stable and advance exactly 40 days', () => {
    let clock = { date: '2037-01-01', timeOfDay: 'evening' };
    for (let index = 0; index < 200; index += 1) {
        clock = advanceClock({ ...clock, turns: 1 });
    }
    assert.equal(clock.timeOfDay, 'evening');
    assert.equal(clock.date, addDays('2037-01-01', 40));
});

test('hold helpers normalize missing and active holds', () => {
    assert.deepEqual(getClockFlags({}), {});
    assert.equal(isClockHeld({}), false);
    assert.deepEqual(getHold({}), { active: false, reason: null, sinceTurn: 0, sinceDate: null });

    const held = clocked({
        flags: {
            clock: {
                hold: { active: true, reason: 'combat', sinceTurn: 4, sinceDate: '2037-03-05' },
            },
        },
    });
    assert.equal(isClockHeld(held), true);
    assert.equal(getHoldReason(held), 'combat');
    assert.deepEqual(getHold(held), {
        active: true,
        reason: 'combat',
        sinceTurn: 4,
        sinceDate: '2037-03-05',
    });
});

test('effectiveStoryTurn prefers storyTurn and falls back to turn', () => {
    assert.equal(effectiveStoryTurn(clocked({ meta: { turn: 9, storyTurn: 3 } })), 3);
    assert.equal(effectiveStoryTurn({ meta: { turn: 9 } }), 9);
    assert.equal(effectiveStoryTurn({ meta: { turn: 9, storyTurn: -1 } }), 9);
    assert.equal(effectiveStoryTurn({}), 0);
});

test('clockEnabled defaults on and slotsPerDay clamps to 1..12', () => {
    assert.equal(clockEnabled({}), true);
    assert.equal(clockEnabled({ clock: { enabled: false } }), false);
    assert.equal(slotsPerDay({}), 5);
    assert.equal(slotsPerDay({ clock: { slotsPerDay: 0 } }), 1);
    assert.equal(slotsPerDay({ clock: { slotsPerDay: 99 } }), 12);
    assert.equal(slotsPerDay({ clock: { slotsPerDay: 7.6 } }), 8);
});

test('buildClockTurn advances an unheld clock, freezes a hold, and is inert when disabled', () => {
    const state = clocked();
    const turn = buildClockTurn({ state, settings: {} });
    assert.deepEqual(turn, {
        type: 'TICK_TIME',
        turns: 1,
        storyTurns: 1,
        date: '2037-03-05',
        timeOfDay: 'night',
    });

    const held = clocked({
        flags: { clock: { hold: { active: true, reason: 'manual' } } },
    });
    assert.deepEqual(buildClockTurn({ state: held, settings: {} }), {
        type: 'TICK_TIME',
        turns: 1,
        storyTurns: 0,
    });

    const disabled = buildClockTurn({ state, settings: { clock: { enabled: false } } });
    assert.deepEqual(disabled, { type: 'TICK_TIME', turns: 1 });
});

test('buildClockTick advances an explicit path length and keeps a 0-turn tick still', () => {
    const state = clocked();
    const tick = buildClockTick({ state, settings: {}, turns: 2 });
    assert.deepEqual(tick, {
        type: 'TICK_TIME',
        turns: 2,
        storyTurns: 2,
        date: '2037-03-06',
        timeOfDay: 'dawn',
    });

    assert.deepEqual(
        buildClockTick({ state, settings: {}, turns: 0 }),
        { type: 'TICK_TIME', turns: 0, storyTurns: 0 },
    );
    assert.deepEqual(
        buildClockTick({ state, settings: { clock: { enabled: false } }, turns: 3 }),
        // Disabled clock = V1: fiction turns track the mechanical counter while
        // the date and slot stay untouched.
        { type: 'TICK_TIME', turns: 3, storyTurns: 3 },
    );
});

test('the clock chip model reflects date, slot, and the brake', () => {
    const state = clocked();
    const normal = buildClockChipModel(state, {});
    assert.equal(normal.visible, true);
    assert.equal(normal.held, false);
    assert.equal(normal.label, '2037-03-05 · evening');
    assert.equal(normal.tone, 'normal');
    assert.equal(normal.title, 'Click to freeze in-game time.');

    const held = clocked({
        flags: { clock: { hold: { active: true, reason: 'chip' } } },
    });
    const frozen = buildClockChipModel(held, {});
    assert.equal(frozen.held, true);
    assert.equal(frozen.reason, 'chip');
    assert.match(frozen.label, /time frozen/);
    assert.equal(frozen.tone, 'frozen');
    assert.match(frozen.title, /frozen/i);

    const noDate = clocked({ meta: { inGameDate: null } });
    assert.equal(buildClockChipModel(noDate, {}).label, 'Day · evening');

    assert.equal(buildClockChipModel(null, {}).visible, false);
});
