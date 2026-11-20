import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GOAL_LABELS,
    GOAL_VERBS,
    deriveGoalsFromProfile,
    isUsableGoal,
    normalizeInferredGoals,
} from '../src/data/goals.js';

// Exact stored fragment from the step contract (a truncated card goal).
const LEILA_FRAGMENT = '…single-minded obsession with proving herself superior to Vaiva AKA Colorgarde. Leila believed her magic and curses are far better than';

test('goal vocabulary is exported and frozen', () => {
    assert.ok(GOAL_VERBS.includes('wants'));
    assert.ok(GOAL_VERBS.includes('obsessed with'));
    assert.ok(GOAL_LABELS.includes('Goals/Motives'));
    assert.ok(Object.isFrozen(GOAL_VERBS));
    assert.ok(Object.isFrozen(GOAL_LABELS));
});

test('a labelled card wins and is capped at max, in card order', () => {
    const profile = {
        goals: ['Rule the docks', 'Find her sister', 'Break the curse', 'Guard the gate'],
        background: 'She wants to do something else entirely.',
    };
    assert.deepEqual(deriveGoalsFromProfile(profile), [
        'Rule the docks',
        'Find her sister',
        'Break the curse',
        'Guard the gate',
    ]);
    assert.deepEqual(deriveGoalsFromProfile(profile, { max: 2 }), [
        'Rule the docks',
        'Find her sister',
    ]);
});

test('motive prose becomes goals, each within the length cap', () => {
    const goals = deriveGoalsFromProfile({
        background: 'She wants to rule the docks. He intends to find his sister.',
    });
    assert.ok(goals.length >= 1 && goals.length <= 5);
    assert.ok(goals.includes('She wants to rule the docks.'));
    assert.ok(goals.includes('He intends to find his sister.'));
    for (const goal of goals) {
        assert.ok(goal.length <= 160);
        assert.equal(isUsableGoal(goal), true);
    }
});

test('quoted dialogue, dangling fragments and truncations are dropped', () => {
    const goals = deriveGoalsFromProfile({
        background: [
            '"I want to rule the city," she said. She wants to protect her sister.',
            'He plans to leave the city and',
            'She strives to rebuild the docks.',
        ].join('\n'),
    });
    assert.ok(!goals.some((goal) => goal.startsWith('"')));
    assert.ok(!goals.some((goal) => goal.endsWith('and')));
    assert.ok(goals.includes('She strives to rebuild the docks.'));
});

test("Leila's stored truncated fragment is rejected everywhere", () => {
    assert.equal(isUsableGoal(LEILA_FRAGMENT), false);
    assert.deepEqual(deriveGoalsFromProfile({ goals: [LEILA_FRAGMENT] }), []);
    assert.ok(!deriveGoalsFromProfile({ goals: [LEILA_FRAGMENT] }).includes(LEILA_FRAGMENT));
    assert.equal(isUsableGoal('Leila wants to rule the docks.'), true);
});

test('isUsableGoal enforces the documented shape', () => {
    assert.equal(isUsableGoal(''), false);
    assert.equal(isUsableGoal('ab'), false);
    assert.equal(isUsableGoal('1234'), false);
    assert.equal(isUsableGoal('Rule the docks...'), false);
    assert.equal(isUsableGoal('Rule the docks with'), false);
    assert.equal(isUsableGoal('x'.repeat(200)), false);
    assert.equal(isUsableGoal('Rule the docks.'), true);
    assert.equal(isUsableGoal('Rule the docks.', { maxLength: 5 }), false);
});

test('invalid profiles return an empty list without throwing', () => {
    assert.deepEqual(deriveGoalsFromProfile(null), []);
    assert.deepEqual(deriveGoalsFromProfile(undefined), []);
    assert.deepEqual(deriveGoalsFromProfile('nope'), []);
    assert.deepEqual(deriveGoalsFromProfile({}), []);
});

test('normalizeInferredGoals clamps, trims, dedupes and rejects bad shapes', () => {
    assert.deepEqual(
        normalizeInferredGoals([' Rule the docks ', 'RULE THE DOCKS', 'Find her sister'], { max: 5 }),
        ['Rule the docks', 'Find her sister'],
    );
    assert.deepEqual(normalizeInferredGoals({ goals: ['Rule the docks', 'Find her sister'] }), [
        'Rule the docks',
        'Find her sister',
    ]);
    assert.deepEqual(normalizeInferredGoals(['Rule the docks', 'Find her sister'], { max: 1 }), ['Rule the docks']);
    assert.deepEqual(normalizeInferredGoals(['Rule the docks', 5, '', 'ab']), ['Rule the docks']);
    for (const bad of [null, undefined, 'not an array', 42, { goals: 'nope' }, { other: [] }]) {
        assert.deepEqual(normalizeInferredGoals(bad), []);
    }
});

test('normalizeInferredGoals caps an overlong entry instead of keeping it', () => {
    const long = `Rule the docks ${'and more '.repeat(30)}`;
    assert.deepEqual(normalizeInferredGoals([long]), []);
});
