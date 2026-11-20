/**
 * Player goal inference.
 *
 * Deterministic first: the card's labelled goals or an explicit motive sentence
 * become the character's goals immediately, with no model call. Only when the
 * card yields nothing usable (and no tracker-owned list exists) does the agent
 * get one chance to draft 3-5 grounded goals.
 *
 * Everything here is best-effort: an identity change must never be blocked by a
 * goal lookup, so `ensurePlayerGoals` never throws and `run` never throws.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import { createLogger } from '../core/logger.js';
import { deriveGoalsFromProfile, normalizeInferredGoals } from '../data/goals.js';

const logger = createLogger('goal-inference');

export const GOAL_INFERENCE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['goals', 'rationale'],
    properties: {
        goals: {
            type: 'array',
            minItems: 3,
            maxItems: 5,
            items: { type: 'string', minLength: 3, maxLength: 160 },
        },
        rationale: { type: 'string', maxLength: 400 },
    },
});

const MAX_EXCERPT = 600;
const MAX_SEASON_TEXT = 300;
const MIN_GOALS = 3;
const MAX_GOALS = 5;
const MAX_GOAL_LENGTH = 160;
const MAX_RATIONALE = 400;
const DEFAULT_TIMEOUT_MS = 20000;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clip(value, max) {
    if (typeof value !== 'string') {
        return '';
    }
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

function logDebug(message, error) {
    try {
        logger.debug(message, error === undefined ? undefined : (error?.message ?? String(error)));
    } catch {
        // Logging must never block an identity change.
    }
}

function logWarn(log, message, error) {
    const data = error === undefined ? undefined : (error?.message ?? String(error));
    try {
        if (typeof log === 'function') {
            log(message, error);
            return;
        }
        if (log && typeof log.warn === 'function') {
            log.warn(message, error);
            return;
        }
        logger.warn(message, data);
    } catch {
        // Logging must never block an identity change.
    }
}

/**
 * Validate and normalize one goal-inference response.
 *
 * @returns {{ ok: boolean, goals: string[], rationale: string, errors: string[] }}
 */
export function validateGoalInference(value) {
    const errors = [];
    if (!isObject(value)) {
        return {
            ok: false,
            goals: [],
            rationale: '',
            errors: ['goal inference must be an object'],
        };
    }
    if (!Array.isArray(value.goals)) {
        errors.push('goals must be an array');
    }
    const goals = normalizeInferredGoals(value.goals, {
        max: MAX_GOALS,
        maxLength: MAX_GOAL_LENGTH,
    });
    if (Array.isArray(value.goals) && goals.length < MIN_GOALS) {
        errors.push(`goals must contain at least ${MIN_GOALS} usable entries`);
    }
    let rationale = '';
    if (typeof value.rationale === 'string') {
        rationale = value.rationale.trim().slice(0, MAX_RATIONALE);
    } else {
        // The schema requires a rationale string; a missing one is a repairable
        // contract failure, not silently accepted data.
        errors.push('rationale must be a string');
    }
    return {
        ok: errors.length === 0 && goals.length >= MIN_GOALS,
        goals,
        rationale,
        errors,
    };
}

/**
 * Build the grounded goal-inference prompt.
 *
 * @param {{
 *   state?: object|null, season?: object|null, character?: object|null,
 *   profile?: object|null, recentScene?: unknown, settings?: object,
 * }} options
 */
export function buildGoalInferencePrompt({
    state = null,
    season = null,
    character = null,
    profile = null,
    recentScene = null,
    settings = {},
} = {}) {
    const cardGoals = asArray(profile?.goals)
        .map((goal) => clip(goal, MAX_GOAL_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_GOALS);
    const locationId = character?.locationId ?? state?.scene?.locationId ?? null;
    const locationName = (locationId && state?.locations?.[locationId]?.name)
        || locationId
        || 'unknown';
    const playerId = character?.charId ?? null;
    const presentNames = asArray(state?.scene?.present)
        .filter((id) => typeof id === 'string' && id !== playerId)
        .map((id) => state?.characters?.[id]?.displayName ?? id)
        .filter(Boolean)
        .slice(0, 8);

    const sections = [
        'You are the Neo Terra Goal Scribe. Draft the goals the played character is actively steering toward.',
        'Ground every goal only in the supplied card material and season context. Never invent canon, never name anyone who is not supplied, and never quote dialogue.',
        'Produce 3 to 5 concrete, present-tense goals (each at most 160 characters). Return JSON only.',
        '',
        '## Character',
        JSON.stringify({
            displayName: character?.displayName ?? null,
            side: character?.side ?? null,
            agenda: character?.agenda ?? null,
        }),
        '',
        '## Card goals (context only; ignore when truncated or unusable)',
        JSON.stringify(cardGoals),
        '',
        '## Background excerpt',
        clip(profile?.background, MAX_EXCERPT) || '(none supplied)',
        '',
        '## Identity excerpt',
        clip(profile?.identity, MAX_EXCERPT) || '(none supplied)',
        '',
        '## Season',
        JSON.stringify({
            title: clip(season?.title ?? season?.id ?? null, MAX_SEASON_TEXT) || null,
            premise: clip(season?.premise, MAX_SEASON_TEXT) || null,
        }),
        '',
        '## Scene',
        JSON.stringify({
            location: locationName,
            present: presentNames,
            recentEvents: asArray(recentScene)
                .map((event) => clip(
                    typeof event === 'string' ? event : (event?.summary ?? event?.text ?? event?.headline),
                    MAX_SEASON_TEXT,
                ))
                .filter(Boolean)
                .slice(-3),
        }),
        '',
        '## Response shape',
        JSON.stringify(GOAL_INFERENCE_SCHEMA),
    ];

    return applyContentGateToPrompt(
        sections.join('\n'),
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        { characterId: character?.charId ?? null, isPlayer: true },
    );
}

/**
 * Create the goal-inference agent.
 *
 * `run` accepts `{ state, season, character, profile, recentScene, signal }` and
 * resolves to `{ ok, goals, rationale }` or `{ ok:false, error, aborted }`.
 * It never throws, including for transport and abort failures.
 */
export function createGoalInference({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    async function run(request = {}) {
        try {
            const settings = settingsFor(request);
            const agentSettings = settings?.agents?.goalInference ?? {};
            const prompt = buildGoalInferencePrompt({
                state: request.state ?? null,
                season: request.season ?? null,
                character: request.character ?? null,
                profile: request.profile ?? null,
                recentScene: request.recentScene ?? null,
                settings,
            });
            if (agentSettings.enabled === false) {
                return { skipped: true, ok: false, error: 'Goal inference is disabled', goals: [], rationale: '', prompt };
            }
            if (typeof runner?.runAgent !== 'function') {
                return { skipped: true, ok: false, error: 'Goal inference has no runner', goals: [], rationale: '', prompt };
            }
            const response = await runner.runAgent({
                agentId: 'goalInference',
                prompt,
                schema: GOAL_INFERENCE_SCHEMA,
                // Goal inference is best-effort: keep the agent's own timeout,
                // falling back to the documented 20 s budget.
                overrides: {
                    timeoutMs: Number.isFinite(agentSettings.timeoutMs) && agentSettings.timeoutMs > 0
                        ? agentSettings.timeoutMs
                        : DEFAULT_TIMEOUT_MS,
                },
                signal: request.signal,
            });
            const validation = validateGoalInference(responseValue(response));
            if (!validation.ok) {
                logWarn(log, 'Goal inference returned an unusable draft; goals stay untouched', validation.errors.join('; '));
                return {
                    ok: false,
                    error: validation.errors.join('; ') || 'Goal inference was rejected',
                    aborted: false,
                    goals: [],
                    rationale: validation.rationale,
                    prompt,
                };
            }
            return {
                ok: true,
                goals: validation.goals,
                rationale: validation.rationale,
                aborted: false,
                prompt,
            };
        } catch (error) {
            const aborted = isAbortError(error);
            logWarn(
                log,
                aborted
                    ? 'Goal inference was aborted; goals stay untouched'
                    : 'Goal inference failed; goals stay untouched',
                error,
            );
            return {
                ok: false,
                error: error?.message ?? String(error),
                aborted,
                goals: [],
                rationale: '',
                prompt: '',
            };
        }
    }

    return { run, prompt: buildGoalInferencePrompt };
}

function sameGoals(left, right) {
    return JSON.stringify(asArray(left)) === JSON.stringify(asArray(right));
}

/** One in-flight goal resolution per store+character (no duplicate AI calls). */
const inFlightByStore = new WeakMap();

function cloneState(state) {
    try {
        return typeof structuredClone === 'function'
            ? structuredClone(state)
            : JSON.parse(JSON.stringify(state));
    } catch {
        return null;
    }
}

function dispatchFields(store, event) {
    if (typeof store?.dispatch !== 'function') {
        throw new TypeError('ensurePlayerGoals requires a reducible WorldState store');
    }
    return store.dispatch(event);
}

/**
 * Ensure the played character has goals: deterministic card parse first, one
 * agent pass only when the card yields nothing and no tracker list exists.
 *
 * Never throws. Accepts `force` to bypass the once-per-character idempotency
 * guard (the Codex "Infer goals" button).
 */
export async function ensurePlayerGoals({
    store = null,
    registry = null,
    profiles = null,
    goalInference = null,
    settings = null,
    characterId = null,
    state = null,
    season = null,
    recentScene = null,
    signal = null,
    now = Date.now,
    force = false,
} = {}) {
    try {
        if (!store || typeof store.get !== 'function') {
            return { ok: false, error: 'ensurePlayerGoals requires a WorldState store', goals: [], inferred: false };
        }
        const before = state ?? store.get();
        const resolvedId = characterId ?? before?.player?.characterId ?? null;
        const character = resolvedId ? before?.characters?.[resolvedId] ?? null : null;
        if (!character) {
            return { ok: false, error: 'Unknown character', goals: [], inferred: false };
        }
        const formId = character.formId ?? resolvedId;
        const profile = profiles?.[formId] ?? profiles?.[resolvedId] ?? null;
        const inferenceFlag = before?.flags?.goalInference?.characterId === resolvedId
            ? before.flags.goalInference
            : null;
        const liveGoals = asArray(character.goals);
        const trackerOwned = character.goalsSource === 'live';

        // Concurrency: one goal resolution per character at a time. A second
        // Play-as while the first inference is in flight must not spend a
        // second model call.
        const inFlight = inFlightByStore.get(store) ?? new Set();
        inFlightByStore.set(store, inFlight);
        if (inFlight.has(resolvedId)) {
            return {
                ok: true,
                source: character.goalsSource ?? 'card',
                goals: liveGoals.slice(),
                inferred: false,
                pending: true,
            };
        }
        inFlight.add(resolvedId);

        try {
            // 1. The card wins only when the list is not tracker-owned. Once the
            // tracker has written goals they are plot-owned and survive every
            // identity change (the reducer enforces the same rule on TRANSFORM).
            const derived = deriveGoalsFromProfile(profile);
            if (derived.length > 0 && !trackerOwned) {
                if (character.goalsSource !== 'card' || !sameGoals(character.goals, derived)) {
                    dispatchFields(store, {
                        type: 'SET_CHARACTER_FIELDS',
                        characterId: resolvedId,
                        goals: derived,
                        goalsSource: 'card',
                    });
                }
                return { ok: true, source: 'card', goals: derived, inferred: false };
            }

            // 2. A tracker/live list is never overwritten by a card parse. The
            // explicit "Infer goals" retry (`force`) may replace a list that
            // this agent itself inferred earlier, but never a tracker list.
            if (liveGoals.length > 0) {
                const fromInference = inferenceFlag?.source === 'ai'
                    && sameGoals(inferenceFlag.goals, liveGoals);
                if (!(force === true && fromInference)) {
                    return {
                        ok: true,
                        source: character.goalsSource ?? 'live',
                        goals: liveGoals.slice(),
                        inferred: false,
                    };
                }
            }

            const agentSettings = settings?.agents?.goalInference ?? {};
            if (!goalInference || typeof goalInference.run !== 'function') {
                return { ok: false, error: 'Goal inference is unavailable', goals: [], inferred: false };
            }
            if (agentSettings.enabled === false) {
                return { ok: false, error: 'Goal inference is disabled', goals: [], inferred: false };
            }

            // 3. Once per character unless the caller explicitly forces a re-run.
            if (force !== true && inferenceFlag) {
                return {
                    ok: true,
                    source: character.goalsSource ?? 'live',
                    goals: liveGoals.slice(),
                    inferred: false,
                    cached: true,
                };
            }

            const result = await goalInference.run({
                state: before,
                season,
                character,
                profile,
                recentScene,
                settings,
                signal,
            });
            if (!result?.ok || !asArray(result.goals).length) {
                logDebug('Goal inference produced nothing; goals stay untouched', result?.error);
                return {
                    ok: false,
                    error: result?.error ?? 'Goal inference produced nothing',
                    goals: liveGoals.slice(),
                    inferred: false,
                };
            }

            const goals = normalizeInferredGoals(result.goals, {
                max: MAX_GOALS,
                maxLength: MAX_GOAL_LENGTH,
            });
            if (goals.length === 0) {
                return { ok: false, error: 'Goal inference produced nothing usable', goals: [], inferred: false };
            }

            dispatchFields(store, {
                type: 'SET_CHARACTER_FIELDS',
                characterId: resolvedId,
                goals,
                goalsSource: 'live',
            });

            // Record the inference on the flags so a remount does not repeat it.
            // There is no SET_FLAGS event: clone the post-dispatch state and
            // replace. The goal snapshot lets the UI tell an inferred list from
            // a tracker rewrite.
            try {
                const live = store.get();
                const cloned = cloneState(live);
                if (cloned) {
                    cloned.flags = {
                        ...(cloned.flags ?? {}),
                        goalInference: {
                            characterId: resolvedId,
                            at: typeof now === 'function' ? now() : Date.now(),
                            source: 'ai',
                            model: agentSettings.model || '',
                            goals: goals.slice(),
                        },
                    };
                    store.replace(cloned);
                }
            } catch (error) {
                logDebug('Could not record the goal-inference flag', error);
            }

            return { ok: true, source: 'live', goals, inferred: true, rationale: result.rationale ?? '' };
        } finally {
            inFlight.delete(resolvedId);
        }
    } catch (error) {
        logDebug('ensurePlayerGoals failed; continuing without goals', error);
        return { ok: false, error: error?.message ?? String(error), goals: [], inferred: false };
    }
}
