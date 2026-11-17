/**
 * Pure, deterministic conflict resolver.
 *
 * The resolver owns every dice decision. It reads no state, touches no DOM, and
 * imports nothing: the same seed and inputs always produce the same result, so
 * a replay or a test is reproducible. Narrators describe the returned outcome;
 * they never decide it.
 */

export const COMBAT_ACTIONS = Object.freeze([
    'strike',
    'defend',
    'grapple',
    'feint',
    'skill',
    'retreat',
    'surrender',
    'talk-down',
]);

export const COMBAT_RISK_TIERS = Object.freeze([
    'low',
    'moderate',
    'high',
    'extreme',
]);

/** Deterministic action → risk map (extreme remains reserve vocabulary). */
export const COMBAT_ACTION_RISK = Object.freeze({
    strike: 'high',
    defend: 'low',
    grapple: 'high',
    feint: 'moderate',
    skill: 'moderate',
    retreat: 'moderate',
    surrender: 'low',
    'talk-down': 'low',
});

/** Alias kept for callers that only know the brief's generic name. */
export const ACTION_RISK = COMBAT_ACTION_RISK;

const TARGET_OPTIONAL_ACTIONS = Object.freeze(['defend', 'surrender']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize a user- or model-supplied action.
 * `"Talk Down"`, `"talk down"`, and `" TALK-DOWN "` all become `talk-down`.
 * Unknown actions return `null`.
 */
export function normalizeCombatAction(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
    return COMBAT_ACTIONS.includes(normalized) ? normalized : null;
}

/** mulberry32: small, fast, deterministic, browser-safe. */
export function createSeededRng(seed) {
    let state = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : 0;
    state = state >>> 0;
    return function rng() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** FNV-1a-style stable hash. Never returns a negative or fractional value. */
function stableHash(input) {
    let hash = 0x811c9dc5;
    const text = String(input);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function requireFiniteNumber(value, label, fallback = 0) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (!Number.isFinite(value)) {
        throw new Error(`resolveAction ${label} must be a finite number`);
    }
    return value;
}

/**
 * Roll one d20 from a stable hash of every input.
 *
 * `sequence` separates multiple rolls that share the same seed and round.
 * A caller-supplied integer `roll` between 1 and 20 overrides the RNG.
 */
export function rollD20({ seed = 0, round = 0, actorId = null, targetId = null, action = null, sequence = 0, roll = null } = {}) {
    if (roll !== null && roll !== undefined) {
        if (!Number.isInteger(roll) || roll < 1 || roll > 20) {
            throw new Error('rollD20 roll override must be an integer from 1 to 20');
        }
        return roll;
    }
    const hash = stableHash([
        seed,
        round,
        actorId ?? '',
        targetId ?? '',
        action ?? '',
        sequence ?? 0,
    ].join('|'));
    const rng = createSeededRng(hash);
    return Math.min(20, Math.max(1, Math.floor(rng() * 20) + 1));
}

function tierFor(die, margin) {
    // A natural 20 always succeeds; a natural 1 always fails, even against an
    // extreme margin in the other direction.
    if (die === 20) {
        return 'critical-success';
    }
    if (die === 1) {
        return 'critical-fail';
    }
    if (margin <= -10) {
        return 'critical-fail';
    }
    if (margin >= 10) {
        return 'critical-success';
    }
    if (margin >= -9 && margin <= -5) {
        return 'fail';
    }
    if (margin >= -4 && margin <= -1) {
        return 'partial';
    }
    return 'success';
}

/**
 * Resolve one action.
 *
 * @returns {{ action: string, risk: string, roll: number, total: number, margin: number, tier: string, modifiers: object }}
 */
export function resolveAction({
    seed = 0,
    round = 0,
    actorId = null,
    targetId = null,
    action = null,
    roll = null,
    attribute = 0,
    skill = 0,
    situational = 0,
    targetDefense = 10,
} = {}) {
    const normalized = normalizeCombatAction(action);
    if (!normalized) {
        throw new Error(`Unknown combat action "${String(action)}"`);
    }
    if (targetId && actorId && targetId === actorId
        && !TARGET_OPTIONAL_ACTIONS.includes(normalized)) {
        throw new Error(`Combat action "${normalized}" cannot target the actor itself`);
    }

    const modifiers = {
        attribute: requireFiniteNumber(attribute, 'attribute', 0),
        skill: requireFiniteNumber(skill, 'skill', 0),
        situational: requireFiniteNumber(situational, 'situational', 0),
        targetDefense: requireFiniteNumber(targetDefense, 'targetDefense', 10),
    };

    const die = rollD20({
        seed,
        round,
        actorId,
        targetId,
        action: normalized,
        sequence: 0,
        roll,
    });
    const total = die + modifiers.attribute + modifiers.skill + modifiers.situational;
    const margin = total - modifiers.targetDefense;
    return {
        action: normalized,
        risk: COMBAT_ACTION_RISK[normalized] ?? 'moderate',
        roll: die,
        total,
        margin,
        tier: tierFor(die, margin),
        modifiers,
    };
}

/** True when the shape looks like a resolver result (used by callers). */
export function isResolvedAction(value) {
    return isObject(value)
        && typeof value.action === 'string'
        && Number.isInteger(value.roll)
        && typeof value.tier === 'string';
}
