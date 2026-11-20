/**
 * Player/character goal derivation (pure).
 *
 * Two deterministic passes, in priority order:
 *   1. the labelled `Goals/Motives` list parsed from the card;
 *   2. explicit motive sentences mined from the card's background/identity prose.
 *
 * Nothing is ever invented: only labelled entries or sentences that already carry
 * a goal verb phrase survive, each is validated by `isUsableGoal`, and a
 * truncated card fragment (e.g. "... are far better than") is rejected.
 *
 * Browser-safe and dependency-free: no IO, no DOM, no globals.
 */

export const GOAL_VERBS = Object.freeze([
    'wants', 'want', 'seeks', 'seek', 'intends', 'intend',
    'plans', 'plan', 'must', 'obsessed with', 'sworn to', 'aims to', 'strives to',
    'determined to', 'vows to', 'needs to',
]);

export const GOAL_LABELS = Object.freeze([
    'Goals/Motives', 'Goals/Motive', 'Goal/Motives', 'Motive',
    'Ultimate Goal', 'Goals', 'Motivation', 'Motivations', 'Drive', 'Main drive',
    'Ambition', 'Objective',
]);

const DEFAULT_MAX = 5;
const DEFAULT_MAX_LENGTH = 160;

/** Trailing words that mean the sentence was cut mid-thought. */
const DANGLING_CONNECTOR = /(?:^|\s)(?:and|or|but|than|with|of|to|for|the|a|an|her|his|their)$/i;

const LABEL_ALTERNATION = [...GOAL_LABELS]
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

const LABEL_PREFIX = new RegExp(
    `^(?:${LABEL_ALTERNATION})(?=\\s*[:\\-\u2013\u2014]\\s+|\\s*$)\\s*[:\\-\u2013\u2014]?\\s*`,
    'i',
);

const GOAL_VERB_PATTERN = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${GOAL_VERBS
        .map((verb) => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})(?![\\p{L}\\p{N}])`,
    'iu',
);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasLetter(value) {
    return /\p{L}/u.test(value);
}

/** Strip terminal punctuation/quotes so the dangling-connector test sees the last word. */
function tailWord(value) {
    return String(value ?? '').replace(/[\s"'`\u2018\u2019\u201c\u201d()[\]{}.,;:!?\u2026]+$/u, '');
}

/**
 * True when a candidate is a self-contained, usable goal string.
 *
 * @param {unknown} text
 * @param {{ maxLength?: number }} [options]
 */
export function isUsableGoal(text, { maxLength = DEFAULT_MAX_LENGTH } = {}) {
    if (typeof text !== 'string') {
        return false;
    }
    const trimmed = text.trim();
    if (trimmed.length < 3 || trimmed.length > maxLength) {
        return false;
    }
    if (!hasLetter(trimmed)) {
        return false;
    }
    if (/\.\.\.$/.test(trimmed) || /\u2026$/.test(trimmed)) {
        return false;
    }
    if (DANGLING_CONNECTOR.test(tailWord(trimmed))) {
        return false;
    }
    return true;
}

function cleanCandidate(value) {
    let text = normalizeWhitespace(value);
    if (!text) {
        return '';
    }
    text = text.replace(LABEL_PREFIX, '').trim();
    text = text.replace(/^[\s*•\-\u2013\u2014]+/, '').replace(/^\d+[.)]\s*/, '').trim();
    text = text.replace(/^["'`\u2018\u2019\u201c\u201d]+/, '').replace(/["'`\u2018\u2019\u201c\u201d]+$/, '').trim();
    return text;
}

function dedupe(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const key = value.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(value);
    }
    return out;
}

function splitSentences(text) {
    return String(text)
        .split(/\n+|(?<=[.!?\u2026])\s+/u)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
}

function isQuotedDialogue(raw) {
    if (/^["\u201c]/.test(raw)) {
        return true;
    }
    const quotes = raw.match(/["\u201c\u201d]/g) ?? [];
    return quotes.length % 2 !== 0;
}

/** Mine explicit motive sentences from one prose field. */
function mineProse(text, { maxLength }) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return [];
    }
    const mined = [];
    for (const raw of splitSentences(text)) {
        if (isQuotedDialogue(raw)) {
            continue;
        }
        const candidate = cleanCandidate(raw);
        if (!candidate) {
            continue;
        }
        // A sentence must already carry a goal verb phrase; this is also what
        // separates an explicit motive from ordinary history prose.
        if (!GOAL_VERB_PATTERN.test(candidate)) {
            continue;
        }
        if (candidate.length > maxLength) {
            continue;
        }
        if (!isUsableGoal(candidate, { maxLength })) {
            continue;
        }
        mined.push(candidate);
    }
    return mined;
}

/**
 * Derive up to `max` grounded goals from one parsed card profile.
 *
 * @param {object|null} profile
 * @param {{ max?: number, maxLength?: number }} [options]
 * @returns {string[]}
 */
export function deriveGoalsFromProfile(profile, {
    max = DEFAULT_MAX,
    maxLength = DEFAULT_MAX_LENGTH,
} = {}) {
    if (!isObject(profile)) {
        return [];
    }
    const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX;
    const cap = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH;

    // Goal labels win: card order preserved, each entry must survive the guard.
    // A labelled block does not fall through to prose mining: if every labelled
    // entry is unusable, the card yields nothing and the caller may infer.
    if (Array.isArray(profile.goals) && profile.goals.length > 0) {
        const labelled = [];
        for (const goal of profile.goals) {
            const candidate = cleanCandidate(goal);
            if (candidate && isUsableGoal(candidate, { maxLength: cap })) {
                labelled.push(candidate);
            }
        }
        return dedupe(labelled).slice(0, limit);
    }

    const mined = [
        ...mineProse(profile.background, { maxLength: cap }),
        ...mineProse(profile.identity, { maxLength: cap }),
    ];
    return dedupe(mined).slice(0, limit);
}

/**
 * Normalize an agent's goal response: `{ goals: string[] }` or a raw array.
 * Invalid shapes and unusable entries are dropped (never throws).
 */
export function normalizeInferredGoals(value, {
    max = DEFAULT_MAX,
    maxLength = DEFAULT_MAX_LENGTH,
} = {}) {
    const list = Array.isArray(value)
        ? value
        : (isObject(value) && Array.isArray(value.goals) ? value.goals : null);
    if (!list) {
        return [];
    }
    const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX;
    const cap = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH;
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string') {
            continue;
        }
        const candidate = normalizeWhitespace(item);
        if (!isUsableGoal(candidate, { maxLength: cap })) {
            continue;
        }
        out.push(candidate);
    }
    // Dedupe before the cap so duplicates cannot crowd out a distinct goal.
    return dedupe(out).slice(0, limit);
}
