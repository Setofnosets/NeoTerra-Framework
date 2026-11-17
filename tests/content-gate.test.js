import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CONTENT_GATE_TERMS,
    applyContentGate,
    applyContentGateToPrompt,
    contentGatePromptInstructions,
    normalizeContentLevel,
    resolveContentLevel,
    strictestLevel,
} from '../src/core/content-gate.js';

const SEXUAL_FIXTURE = 'They had explicit sex in the dark. The city kept moving.';
const VIOLENCE_FIXTURE = 'It was brutal violence. Rain fell on the plaza.';
const MIXED_FIXTURE = 'They had explicit sex. Graphic violence followed. The city kept moving.';

test('full is a byte-identical no-op', () => {
    const input = `  ${SEXUAL_FIXTURE}\n${VIOLENCE_FIXTURE}  `;
    assert.equal(applyContentGate(input, 'full'), input);
    assert.equal(applyContentGate(input), input);
    assert.equal(applyContentGate(input, 'not-a-level'), input);
});

test('mature-only minimizes explicit sexual content but leaves violence', () => {
    const sexual = applyContentGate(SEXUAL_FIXTURE, 'mature-only');
    assert.equal(sexual, 'They had [sexual content omitted] in the dark. The city kept moving.');
    assert.equal(applyContentGate(VIOLENCE_FIXTURE, 'mature-only'), VIOLENCE_FIXTURE);
});

test('reduced fades sex and softens violence deterministically', () => {
    const first = applyContentGate(MIXED_FIXTURE, 'reduced');
    const second = applyContentGate(MIXED_FIXTURE, 'reduced');
    assert.equal(first, second);
    assert.match(first, /\[sexual content omitted\]/);
    assert.match(first, /\[violence elided\]/);
    assert.doesNotMatch(first, /explicit sex|graphic violence/i);
});

test('strict removes explicit and violent sentences deterministically', () => {
    const first = applyContentGate(MIXED_FIXTURE, 'strict');
    const second = applyContentGate(MIXED_FIXTURE, 'strict');
    assert.equal(first, 'The city kept moving.');
    assert.equal(first, second);
    assert.doesNotMatch(first, /explicit|violence/i);
});

test('hard per-character limits always win over the global level', () => {
    const limits = { player: '', characters: { 's1.carol': 'strict' } };
    const text = 'They had explicit sex. The city kept moving.';
    assert.equal(applyContentGate(text, 'full', limits, { characterId: 's1.carol' }), 'The city kept moving.');
    assert.equal(applyContentGate(text, 'full', limits, { characterId: 's1.other' }), text);
});

test('the per-player limit applies only to player context', () => {
    const limits = { player: 'strict', characters: {} };
    const text = 'They had explicit sex. The city kept moving.';
    assert.equal(applyContentGate(text, 'full', limits, { isPlayer: true }), 'The city kept moving.');
    assert.equal(applyContentGate(text, 'full', limits, { isPlayer: false }), text);
    assert.equal(applyContentGate(text, 'full', limits, {}), text);
});

test('a stricter global level cannot be relaxed by a permissive hard limit', () => {
    const limits = { player: 'full', characters: { a: 'full' } };
    assert.equal(
        applyContentGate('They had explicit sex.', 'strict', limits, { characterId: 'a', isPlayer: true }),
        '',
    );
});

test('level helpers normalize, compare, and resolve', () => {
    assert.equal(normalizeContentLevel('strict'), 'strict');
    assert.equal(normalizeContentLevel('nonsense'), 'full');
    assert.equal(strictestLevel('full', 'reduced', 'mature-only'), 'reduced');
    assert.equal(strictestLevel('full', 'bogus'), 'full');
    assert.equal(
        resolveContentLevel('reduced', { characters: { a: 'strict' } }, { characterId: 'a' }),
        'strict',
    );
});

test('prompt instructions are added only in reduced and strict modes', () => {
    assert.equal(contentGatePromptInstructions('full'), '');
    assert.equal(contentGatePromptInstructions('mature-only'), '');
    assert.match(contentGatePromptInstructions('reduced'), /Do not record new explicit acts/);
    assert.match(contentGatePromptInstructions('strict'), /plot-focused/);

    const full = applyContentGateToPrompt('System prompt.', 'full');
    assert.equal(full, 'System prompt.');

    const reduced = applyContentGateToPrompt('System prompt.', 'reduced');
    assert.match(reduced, /^System prompt\./);
    assert.match(reduced, /\[NEOTERRA_CONTENT_GATE reduced\]/);

    const strictViaLimit = applyContentGateToPrompt(
        'System prompt.',
        'full',
        { characters: { a: 'strict' } },
        { characterId: 'a' },
    );
    assert.match(strictViaLimit, /\[NEOTERRA_CONTENT_GATE strict\]/);
});

test('invalid input throws and limits are never mutated', () => {
    assert.throws(() => applyContentGate(null, 'full'), TypeError);
    assert.throws(() => applyContentGate(42, 'strict'), TypeError);

    const limits = Object.freeze({
        player: 'strict',
        characters: Object.freeze({ a: 'reduced' }),
    });
    assert.equal(
        applyContentGate('They had explicit sex. Safe line.', 'full', limits, { characterId: 'a' }),
        'They had [sexual content omitted]. Safe line.',
    );
    assert.equal(limits.characters.a, 'reduced');
});

test('term lists are frozen and cover sexual and violent fixtures', () => {
    assert.ok(Object.isFrozen(CONTENT_GATE_TERMS));
    assert.ok(Object.isFrozen(CONTENT_GATE_TERMS.sexual));
    assert.ok(CONTENT_GATE_TERMS.sexual.includes('explicit sex'));
    assert.ok(CONTENT_GATE_TERMS.violence.includes('graphic violence'));
});
