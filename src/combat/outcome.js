/**
 * Deterministic outcome deltas and reducer events for the combat resolver.
 *
 * Resource means stamina / willpower / corruption progress. Deltas are bounded:
 * no single change exceeds 20 points, and every applied value is clamped to the
 * character's own range. No HP and no damage numbers are ever written to prose
 * or to event summaries.
 */

export const OUTCOME_TIERS = Object.freeze([
    'critical-success',
    'success',
    'partial',
    'fail',
    'critical-fail',
]);

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

/** Base deltas before risk scaling. Negative = resource loss. */
export const DEFAULT_TIER_DELTAS = deepFreeze({
    'critical-success': {
        actor: {},
        target: { stamina: -15, willpower: -6 },
    },
    success: {
        actor: {},
        target: { stamina: -9, willpower: -3 },
    },
    partial: {
        actor: { stamina: -4, willpower: -2 },
        target: { stamina: -4, willpower: -1 },
    },
    fail: {
        actor: { stamina: -8, willpower: -3, corruption: 1 },
        target: {},
    },
    'critical-fail': {
        actor: { stamina: -12, willpower: -8, corruption: 2 },
        target: {},
    },
});

export const RISK_SCALE = deepFreeze({
    low: 1,
    moderate: 1.25,
    high: 1.5,
    extreme: 1.75,
});

/** Corruption progress gained by the actor for a bad roll. */
export const TIER_CORRUPTION = deepFreeze({
    'critical-success': 0,
    success: 0,
    partial: 0,
    fail: 1,
    'critical-fail': 2,
});

const MAX_DELTA = 20;

const CONTRACT_SENTENCES = deepFreeze({
    'critical-success': 'A decisive success: the action lands fully and on the actor\'s terms.',
    success: 'A clean success: the action achieves its intent without a new cost.',
    partial: 'A costly partial: the intent lands, but the exchange takes a price.',
    fail: 'A failure: the intent does not land and the exchange turns against the actor.',
    'critical-fail': 'A backfire: the attempt collapses and the actor pays for it.',
});

export const OUTCOME_CONTRACT_INSTRUCTION = 'Describe only this result. Do not decide the next outcome, invent damage numbers, or narrate a different tier.';

function clampMagnitude(value) {
    const rounded = Math.round(value);
    return Math.min(MAX_DELTA, Math.max(-MAX_DELTA, rounded));
}

function scaleDeltas(base, scale) {
    const out = {};
    for (const [resource, delta] of Object.entries(base ?? {})) {
        // Corruption progress has an explicit fixed gain per tier; risk scales
        // the physical resource loss only.
        const scaled = resource === 'corruption'
            ? clampMagnitude(Number(delta))
            : clampMagnitude(Number(delta) * scale);
        if (scaled !== 0) {
            out[resource] = scaled;
        }
    }
    return out;
}

/**
 * Turn a resolver result into bounded deltas plus the narrator contract.
 *
 * @param {{ tier?: string, risk?: string }} result
 * @returns {{ tier: string, risk: string, deltas: {actor: object, target: object}, contract: string }}
 */
export function buildOutcome(result, options = {}) {
    const tier = result?.tier;
    if (!OUTCOME_TIERS.includes(tier)) {
        throw new Error(`Unknown outcome tier "${String(tier)}"`);
    }
    const risk = options.risk ?? result?.risk ?? 'moderate';
    const scale = RISK_SCALE[risk] ?? 1;
    const base = DEFAULT_TIER_DELTAS[tier] ?? { actor: {}, target: {} };
    const actor = scaleDeltas(base.actor, scale);
    const target = scaleDeltas(base.target, scale);
    return {
        tier,
        risk,
        deltas: { actor, target },
        contract: `${CONTRACT_SENTENCES[tier]} ${OUTCOME_CONTRACT_INSTRUCTION}`,
    };
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function resourceOf(entry) {
    if (!isObject(entry)) {
        return null;
    }
    const current = Number(entry.current);
    const max = Number(entry.max);
    if (!Number.isFinite(current) || !Number.isFinite(max)) {
        return null;
    }
    return { current, max };
}

function actorEntry(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return isObject(state?.player) ? state.player : null;
    }
    if (state?.player?.identity === 'canon' && characterId === state.player.characterId) {
        return isObject(state.player) ? state.player : null;
    }
    return state?.characters?.[characterId] ?? null;
}

function isPlayerTarget(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return true;
    }
    return state?.player?.identity === 'canon'
        && characterId === state.player.characterId;
}

function statEvents(state, characterId, deltas) {
    if (!characterId || !isObject(deltas)) {
        return [];
    }
    const entry = actorEntry(state, characterId);
    if (!entry) {
        return [];
    }
    const usePlayerEvent = isPlayerTarget(state, characterId);
    const events = [];
    const push = (path, value) => {
        if (usePlayerEvent) {
            events.push({ type: 'SET_PLAYER_STAT', path, value });
        } else {
            events.push({
                type: 'SET_CHARACTER_STAT',
                characterId,
                path,
                value,
            });
        }
    };

    const stamina = resourceOf(entry.stamina);
    if (Number.isFinite(deltas.stamina) && deltas.stamina !== 0 && stamina) {
        push('stamina.current', clamp(stamina.current + deltas.stamina, 0, stamina.max));
    }
    const willpower = resourceOf(entry.willpower);
    if (Number.isFinite(deltas.willpower) && deltas.willpower !== 0 && willpower) {
        push('willpower.current', clamp(willpower.current + deltas.willpower, 0, willpower.max));
    }
    const corruption = entry.corruption;
    if (Number.isFinite(deltas.corruption) && deltas.corruption !== 0
        && isObject(corruption) && Number.isFinite(Number(corruption.progress))) {
        push('corruption.progress', clamp(Number(corruption.progress) + deltas.corruption, 0, 100));
    }
    return events;
}

/**
 * Reducer-ready events for one built outcome.
 *
 * A custom persona (`actorId === 'player'`) and the canon player use
 * SET_PLAYER_STAT so the mirror and the character stay in sync. Ordinary NPCs
 * use SET_CHARACTER_STAT. Zero deltas are omitted; current values are clamped.
 */
export function outcomeEvents({ outcome, actorId = null, targetId = null, state = null } = {}) {
    if (!isObject(outcome) || !isObject(outcome.deltas)) {
        return [];
    }
    const events = [];
    events.push(...statEvents(state, actorId, outcome.deltas.actor));
    if (targetId && targetId !== actorId) {
        events.push(...statEvents(state, targetId, outcome.deltas.target));
    }
    return events;
}
