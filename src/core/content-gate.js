/**
 * Optional content gate.
 *
 * The gate is a deterministic, render-time reducer. It never mutates the world
 * state or rewrites stored text; it only transforms prompt blocks and agent
 * prompts. `full` is a strict no-op (the exact input string is returned).
 *
 * Levels, from least to most restrictive:
 *   full        — no change
 *   mature-only — explicit sexual content is minimized
 *   reduced     — explicit sexual content fades to black, violence is softened
 *   strict      — explicit and graphic-violence sentences are removed
 *
 * Per-character and per-player hard limits are layered on top of the global
 * level and always win. A hard limit can only make content stricter.
 */

import { CONTENT_GATE_LEVELS } from './constants.js';

const STRICTNESS = Object.freeze({
    full: 0,
    'mature-only': 1,
    reduced: 2,
    strict: 3,
});

const SEXUAL_TERMS = Object.freeze([
    'explicit sex',
    'graphic sex',
    'hardcore sex',
    'sex scene',
    'sexual intercourse',
    'erotic',
    'erotica',
    'orgasm',
    'orgasmic',
    'penetration',
    'genitalia',
    'genitals',
    'cock',
    'pussy',
    'cumming',
    'cum',
    'blowjob',
    'handjob',
    'nudity',
    'nude',
    'aroused',
    'arousal',
    'moaning',
    'moan',
    'fucking',
    'fuck',
]);

const VIOLENCE_TERMS = Object.freeze([
    'graphic violence',
    'brutal violence',
    'gore',
    'gory',
    'bloodbath',
    'dismemberment',
    'dismembered',
    'dismember',
    'disemboweled',
    'disembowel',
    'decapitation',
    'decapitated',
    'decapitate',
    'torture',
    'tortured',
    'flayed',
    'impaled',
    'entrails',
]);

export const SEXUAL_MARKER = '[sexual content omitted]';
export const VIOLENCE_SOFT_MARKER = '[violence elided]';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term) {
    return new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
}

function termTestRegex(term) {
    return new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
}

function hasAny(text, testers) {
    return testers.some((tester) => tester.test(text));
}

function replaceTerms(text, terms, marker) {
    let output = text;
    for (const term of terms) {
        output = output.replace(termRegex(term), marker);
    }
    return output;
}

function splitSentences(line) {
    const sentences = [];
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if ((character === '.' || character === '!' || character === '?')
            && /\s/.test(line[index + 1] ?? '')) {
            sentences.push(line.slice(start, index + 1));
            start = index + 1;
            while (start < line.length && /\s/.test(line[start])) {
                start += 1;
            }
            index = start - 1;
        }
    }
    const rest = line.slice(start).trim();
    if (rest.length > 0) {
        sentences.push(rest);
    }
    return sentences;
}

function stripSentences(text, testers) {
    const lines = String(text).split('\n');
    const kept = [];
    for (const line of lines) {
        const sentences = splitSentences(line);
        const filtered = sentences.filter((sentence) => !hasAny(sentence, testers));
        const rebuilt = filtered.join(' ').replace(/[ \t]+/g, ' ').trim();
        if (rebuilt.length > 0) {
            kept.push(rebuilt);
        }
    }
    return kept.join('\n').trim();
}

/** Normalize an unknown level to a supported one; invalid input becomes `full`. */
export function normalizeContentLevel(level) {
    return CONTENT_GATE_LEVELS.includes(level) ? level : 'full';
}

/** True when `level` is no stricter than `baseline`. */
export function isNoStricterThan(level, baseline = 'full') {
    return STRICTNESS[normalizeContentLevel(level)] <= STRICTNESS[normalizeContentLevel(baseline)];
}

/** Return the strictest of the supplied levels. Unknown levels are ignored. */
export function strictestLevel(...levels) {
    let chosen = 'full';
    for (const candidate of levels) {
        if (!CONTENT_GATE_LEVELS.includes(candidate)) {
            continue;
        }
        if (STRICTNESS[candidate] > STRICTNESS[chosen]) {
            chosen = candidate;
        }
    }
    return chosen;
}

/**
 * Resolve the effective level after applying hard limits.
 *
 * `limits` is the `settings.contentLimits` shape:
 *   { player: 'strict'|'reduced'|..., characters: { [charId]: level } }
 * `context.characterId` applies that character's limit; `context.isPlayer`
 * applies the player limit. Hard limits can only increase strictness.
 */
export function resolveContentLevel(level, limits = {}, context = {}) {
    const characterLimit = context.characterId
        ? limits?.characters?.[context.characterId]
        : null;
    const playerLimit = context.isPlayer ? limits?.player : null;
    return strictestLevel(level, characterLimit, playerLimit);
}

/**
 * Apply the gate to arbitrary text.
 *
 * @param {string} text
 * @param {'full'|'mature-only'|'reduced'|'strict'} [level]
 * @param {{ player?: string, characters?: Record<string, string> }} [limits]
 * @param {{ characterId?: string|null, isPlayer?: boolean }} [context]
 * @returns {string}
 */
export function applyContentGate(text, level = 'full', limits = {}, context = {}) {
    if (typeof text !== 'string') {
        throw new TypeError('applyContentGate requires a string');
    }
    const effective = resolveContentLevel(level, limits, context);
    if (effective === 'full') {
        return text;
    }

    const sexual = SEXUAL_TERMS.map(termTestRegex);
    const violence = VIOLENCE_TERMS.map(termTestRegex);

    if (effective === 'mature-only') {
        return replaceTerms(text, SEXUAL_TERMS, SEXUAL_MARKER);
    }
    if (effective === 'reduced') {
        return replaceTerms(
            replaceTerms(text, SEXUAL_TERMS, SEXUAL_MARKER),
            VIOLENCE_TERMS,
            VIOLENCE_SOFT_MARKER,
        );
    }
    return stripSentences(text, [...sexual, ...violence]);
}

/**
 * Instructions appended to agent prompts in reduced/strict modes. The tracker
 * may still record what already happened; it must not invent new explicit acts.
 */
export function contentGatePromptInstructions(level = 'full') {
    const effective = normalizeContentLevel(level);
    if (effective === 'strict') {
        return [
            '[NEOTERRA_CONTENT_GATE strict]',
            'Do not describe, request, or record explicit sexual content or graphic violence.',
            'Remove such acts from any proposed summary. Keep all output plot-focused.',
            'Record only that a scene was interrupted, faded to black, or handled off-screen.',
        ].join(' ');
    }
    if (effective === 'reduced') {
        return [
            '[NEOTERRA_CONTENT_GATE reduced]',
            'Fade explicit sexual content to black and soften graphic violence.',
            'Do not record new explicit acts or graphic injuries; summarize them as off-screen or implied.',
        ].join(' ');
    }
    return '';
}

/**
 * Apply the gate to an agent prompt and append the matching instruction block.
 */
export function applyContentGateToPrompt(text, level = 'full', limits = {}, context = {}) {
    const gated = applyContentGate(text, level, limits, context);
    const effective = resolveContentLevel(level, limits, context);
    const instructions = contentGatePromptInstructions(effective);
    if (!instructions) {
        return gated;
    }
    return gated.length > 0 ? `${gated}\n\n${instructions}` : instructions;
}

/** Exposed for tests and for UI copy; callers must not mutate these arrays. */
export const CONTENT_GATE_TERMS = Object.freeze({
    sexual: SEXUAL_TERMS,
    violence: VIOLENCE_TERMS,
});
