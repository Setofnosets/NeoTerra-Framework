/**
 * Neo Terra Choices Agent (optional CYOA mode).
 *
 * The agent proposes 2-6 short labels after an assistant turn. It never writes
 * state and never sends a message: clicking a chip routes the chosen label
 * through SillyTavern's ordinary player input path.
 *
 * Exploration and tactical combat choices are independent settings. Combat
 * chips are restricted to actions the dice resolver understands, and both modes
 * use the resolver's risk vocabulary.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGate, applyContentGateToPrompt, resolveContentLevel } from '../core/content-gate.js';
import { renderPromptTemplate } from './prompts.js';
import { isEndingScreenActive } from '../flows/ending.js';

export const CHOICES_SCHEMA_VERSION = 1;
export const DEFAULT_CHOICE_COUNT = 4;
export const MAX_CHOICE_COUNT = 6;
export const MIN_CHOICE_COUNT = 2;
export const DEFAULT_MAX_LABEL_LENGTH = 100;

/** Actions the dice conflict resolver can parse (Step 19 contract). */
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

/** Risk tiers shared with the resolver and rendered on tactical chips. */
export const COMBAT_RISK_TIERS = Object.freeze([
    'low',
    'moderate',
    'high',
    'extreme',
]);

export const CHOICE_THEMES = Object.freeze([
    'auto',
    'heroic',
    'villainous',
    'romantic',
    'noir',
    'comedic',
    'tactical',
    'lewd',
]);

export const CHOICE_INTENTS = Object.freeze([
    'action',
    'dialogue',
    'romance',
    'investigation',
    'travel',
    'lewd',
    'skill',
    'other',
]);

export const CHOICES_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['choices', 'rationale'],
    properties: {
        theme: { type: 'string', maxLength: 40 },
        choices: {
            type: 'array',
            minItems: MIN_CHOICE_COUNT,
            maxItems: MAX_CHOICE_COUNT,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['label'],
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: DEFAULT_MAX_LABEL_LENGTH },
                    action: { type: 'string', maxLength: 40 },
                    intent: { type: 'string', maxLength: 40 },
                    tone: { type: 'string', maxLength: 40 },
                    risk: { type: 'string', maxLength: 40 },
                },
            },
        },
        rationale: { type: 'string', maxLength: 500 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a choices pass.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

/** Combat is a scene fact, so both the flag and the combat object count. */
export function isCombatScene(state) {
    return state?.meta?.inCombat === true || isObject(state?.scene?.combat);
}

/**
 * Resolve `auto` from season tone, player role, and the current scene.
 * S1Dark and other villain-POV seasons therefore get villainous choices with
 * no configuration.
 */
export function resolveChoiceTheme({ settings = {}, state = null, season = null, mode = 'exploration' } = {}) {
    if (mode === 'combat' || isCombatScene(state)) {
        const configured = settings?.cyoa?.combatChoices?.theme;
        return configured && configured !== 'auto' ? configured : 'tactical';
    }
    const configured = settings?.cyoa?.theme ?? 'auto';
    if (configured !== 'auto') {
        return configured;
    }
    const tone = String(season?.toneNotes ?? '').toLowerCase();
    const role = state?.playerRole ?? season?.playerRole ?? 'neutral';
    if (role === 'villain' || state?.flags?.brainwashed === true) {
        return 'villainous';
    }
    if (/romance|romantic|erotic/.test(tone)) {
        return 'romantic';
    }
    if (/noir|grim|gritty/.test(tone)) {
        return 'noir';
    }
    if (/comedy|comedic|light/.test(tone)) {
        return 'comedic';
    }
    return role === 'hero' ? 'heroic' : 'noir';
}

function settingsForMode(settings, mode) {
    const cyoa = isObject(settings?.cyoa) ? settings.cyoa : {};
    const combat = isObject(cyoa.combatChoices) ? cyoa.combatChoices : {};
    const source = mode === 'combat' ? combat : cyoa;
    return {
        // Tactical choices are a genuinely independent setting: the combat
        // switch activates them in a conflict even while exploration CYOA is
        // off. Outside combat they never appear.
        enabled: mode === 'combat'
            ? combat.enabled === true
            : cyoa.enabled === true,
        count: clamp(
            Number.isInteger(source.count) ? source.count : DEFAULT_CHOICE_COUNT,
            MIN_CHOICE_COUNT,
            MAX_CHOICE_COUNT,
        ),
        maxLabelLength: clamp(
            Number.isInteger(source.maxLabelLength) && source.maxLabelLength > 0
                ? source.maxLabelLength
                : DEFAULT_MAX_LABEL_LENGTH,
            1,
            DEFAULT_MAX_LABEL_LENGTH,
        ),
        theme: source.theme ?? (mode === 'combat' ? 'tactical' : 'auto'),
        contentMix: isObject(source.contentMix) ? source.contentMix : {},
        promptOverride: typeof source.promptOverride === 'string' ? source.promptOverride : '',
    };
}

/**
 * Guard for every choices request. Disabled mode makes no agent call, no chip,
 * and no write. Ending suppression comes from the Step 16 ending flow.
 */
export function shouldGenerateChoices({
    state = null,
    settings = {},
    lastMessage = null,
    mode = 'exploration',
    generationActive = false,
    afterChoice = false,
    now = 0,
    lastGeneratedAt = 0,
    minIntervalMs = 0,
} = {}) {
    const config = settingsForMode(settings, mode);
    if (!config.enabled) {
        return { allowed: false, reason: 'disabled' };
    }
    if (isEndingScreenActive(state)) {
        return { allowed: false, reason: 'ending' };
    }
    if (generationActive) {
        return { allowed: false, reason: 'generation-active' };
    }
    if (afterChoice) {
        return { allowed: false, reason: 'after-choice' };
    }
    if (!lastMessage || lastMessage.is_user === true) {
        return { allowed: false, reason: 'no-assistant-message' };
    }
    if (minIntervalMs > 0 && Number(now) - Number(lastGeneratedAt) < minIntervalMs) {
        return { allowed: false, reason: 'throttled' };
    }
    return { allowed: true, reason: 'ok', config };
}

function characterName(state, characterId) {
    return state?.characters?.[characterId]?.displayName
        ?? state?.characters?.[characterId]?.charId
        ?? characterId;
}

function presentCast(state) {
    return asArray(state?.scene?.present)
        .map((characterId) => state?.characters?.[characterId] ?? null)
        .filter(Boolean)
        .map((character) => ({
            characterId: character.charId,
            name: character.displayName ?? character.charId,
            status: character.status,
            mood: character.mood,
            agenda: character.agenda,
        }));
}

function contentMixLine(mix) {
    const entries = Object.entries(isObject(mix) ? mix : {})
        .filter(([, weight]) => Number(weight) > 0)
        .map(([key, weight]) => `${key} ${weight}`);
    return entries.length > 0 ? entries.join(', ') : '(balanced)';
}

/**
 * Deterministic prompt. It names the allowed ids, the chosen theme, the content
 * mix, and the exact label limit so the model cannot invent formats.
 */
export function buildChoicesPrompt({
    state = null,
    season = null,
    recentMessages = [],
    settings = {},
    mode = 'exploration',
    count,
    theme,
    maxLabelLength,
} = {}) {
    const config = settingsForMode(settings, mode);
    const resolvedTheme = theme ?? resolveChoiceTheme({
        settings,
        state,
        season,
        mode,
    });
    const resolvedCount = clamp(
        Number.isInteger(count) ? count : config.count,
        MIN_CHOICE_COUNT,
        MAX_CHOICE_COUNT,
    );
    const labelLimit = clamp(
        Number.isInteger(maxLabelLength) ? maxLabelLength : config.maxLabelLength,
        1,
        DEFAULT_MAX_LABEL_LENGTH,
    );
    const combat = mode === 'combat' || isCombatScene(state);

    const lines = [];
    lines.push(`# Neo Terra Choice Writer — ${season?.title ?? state?.seasonId ?? 'Neo Terra'}`);
    lines.push('');
    lines.push('## Scene');
    lines.push(`Turn: ${state?.meta?.turn ?? 0}`);
    lines.push(`Date: ${state?.meta?.inGameDate ?? 'unknown'} (${state?.meta?.timeOfDay ?? 'unknown'})`);
    lines.push(`Arc: ${state?.arc ?? 'season'}`);
    lines.push(`Player role: ${state?.playerRole ?? 'neutral'}`);
    lines.push(`Theme: ${resolvedTheme}`);
    lines.push(`Mode: ${combat ? 'combat' : 'exploration'}`);
    lines.push(`Location: ${state?.scene?.locationId ?? 'unknown'}`);
    if (state?.scene?.framing) {
        lines.push(`Framing: ${state.scene.framing}`);
    }
    lines.push('');

    lines.push('## Present cast');
    const cast = presentCast(state);
    if (cast.length === 0) {
        lines.push('(nobody)');
    } else {
        for (const character of cast) {
            lines.push(`- ${character.characterId} — ${character.name} [${character.status}]${character.agenda ? `: ${character.agenda}` : ''}`);
        }
    }
    lines.push('');

    if (combat) {
        lines.push('## Combat');
        lines.push(`Active: yes`);
        lines.push(`Participants: ${asArray(state?.scene?.combat?.participants).join(', ') || '(unknown)'}`);
        lines.push('Combat choices must be concrete actions, not narration.');
        lines.push('');
    }

    lines.push('## Recent messages');
    const messages = asArray(recentMessages).slice(-5);
    if (messages.length === 0) {
        lines.push('(none supplied)');
    } else {
        for (const message of messages) {
            const role = message?.is_user === true ? 'player' : 'assistant';
            const text = typeof message === 'string'
                ? message
                : message?.mes ?? message?.content ?? JSON.stringify(message);
            lines.push(`[${role}] ${String(text ?? '').slice(0, 1200)}`);
        }
    }
    lines.push('');

    lines.push('## Rules');
    lines.push(`Return exactly ${resolvedCount} choices.`);
    lines.push(`Each label must be at most ${labelLimit} characters and read as a player action.`);
    lines.push('Do not write state, roll dice, or decide outcomes. Do not repeat the narrator\'s prose.');
    lines.push('Every choice must be plausible in this scene and distinct from the others.');
    lines.push(`Content mix weights: ${contentMixLine(config.contentMix)}.`);
    if (combat) {
        lines.push(`Allowed actions: ${COMBAT_ACTIONS.join(', ')}.`);
        lines.push(`Risk tiers: ${COMBAT_RISK_TIERS.join(', ')}.`);
        lines.push('Every choice requires an action from the allowed list and a risk tier.');
        lines.push('Prefer actions the resolver can settle: strike, defend, grapple, feint, skill, retreat, surrender, talk down.');
    } else {
        lines.push(`Allowed intents: ${CHOICE_INTENTS.join(', ')}.`);
        lines.push('Exploration choices may include dialogue, investigation, travel, romance, or lewd content when the mix allows it.');
    }
    lines.push('Return JSON only. No prose.');

    const sections = lines.join('\n');
    const override = config.promptOverride.trim();
    const renderedOverride = override.length > 0
        ? renderPromptTemplate(override, {
            scene: sections,
            count: String(resolvedCount),
            theme: resolvedTheme,
            maxLabelLength: String(labelLimit),
            actions: COMBAT_ACTIONS.join(', '),
            riskTiers: COMBAT_RISK_TIERS.join(', '),
        })
        : sections;
    const prompt = override.length > 0
        ? `${renderedOverride}\n\n${sections}\n\n## Response shape\n${JSON.stringify(CHOICES_SCHEMA)}`
        : `${sections}\n\n## Response shape\n${JSON.stringify(CHOICES_SCHEMA)}`;

    return applyContentGateToPrompt(
        prompt,
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        { isPlayer: true },
    );
}

function labelIsGatedOut(label, settings) {
    const level = resolveContentLevel(
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        { isPlayer: true },
    );
    if (level === 'full') {
        return false;
    }
    const gated = applyContentGate(
        label,
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        { isPlayer: true },
    ).trim();
    if (gated.length === 0) {
        return true;
    }
    // `strict` removes explicit sentences rather than masking them. In that
    // mode a changed label is an explicit option and is dropped entirely.
    return level === 'strict' && gated !== label;
}

/**
 * Normalize a raw result. Malformed output hides the row (`choices: []`) rather
 * than throwing; validation and label truncation are deterministic.
 */
export function normalizeChoicesResult({
    result,
    settings = {},
    mode = 'exploration',
    state = null,
    count = null,
    maxLabelLength = null,
} = {}) {
    const config = settingsForMode(settings, mode);
    const combat = mode === 'combat' || isCombatScene(state);
    const limit = clamp(
        Number.isInteger(maxLabelLength) ? maxLabelLength : config.maxLabelLength,
        1,
        DEFAULT_MAX_LABEL_LENGTH,
    );
    const desired = clamp(
        Number.isInteger(count) ? count : config.count,
        MIN_CHOICE_COUNT,
        MAX_CHOICE_COUNT,
    );
    const output = isObject(result) ? result : {};
    const choices = [];
    const rejected = [];
    const seen = new Set();
    let truncated = false;

    for (const raw of asArray(output.choices)) {
        if (choices.length >= desired) {
            break;
        }
        if (!isObject(raw)) {
            rejected.push({ reason: 'not-an-object' });
            continue;
        }
        let label = typeof raw.label === 'string' ? raw.label.trim() : '';
        if (label.length === 0) {
            rejected.push({ reason: 'empty-label' });
            continue;
        }
        if (label.length > limit) {
            label = label.slice(0, limit).trimEnd();
            truncated = true;
        }
        const key = label.toLowerCase();
        if (seen.has(key)) {
            rejected.push({ reason: 'duplicate-label', label });
            continue;
        }
        if (labelIsGatedOut(label, settings)) {
            rejected.push({ reason: 'content-gate', label });
            continue;
        }

        const action = typeof raw.action === 'string'
            ? raw.action.trim().toLowerCase()
            : '';
        if (combat) {
            if (!COMBAT_ACTIONS.includes(action)) {
                rejected.push({ reason: `unknown-combat-action:${action || 'none'}`, label });
                continue;
            }
        }
        const risk = typeof raw.risk === 'string' ? raw.risk.trim().toLowerCase() : '';
        if (combat && risk.length > 0 && !COMBAT_RISK_TIERS.includes(risk)) {
            rejected.push({ reason: `unknown-risk-tier:${risk}`, label });
            continue;
        }
        const intent = typeof raw.intent === 'string' && CHOICE_INTENTS.includes(raw.intent)
            ? raw.intent
            : (combat ? 'action' : 'other');
        const tone = typeof raw.tone === 'string' && raw.tone.trim().length > 0
            ? raw.tone.trim().slice(0, 40)
            : null;

        seen.add(key);
        choices.push({
            label,
            ...(combat ? { action } : {}),
            intent,
            ...(tone ? { tone } : {}),
            ...(combat ? { risk: COMBAT_RISK_TIERS.includes(risk) ? risk : 'moderate' } : {}),
        });
    }

    return {
        choices,
        count: choices.length,
        desired,
        theme: typeof output.theme === 'string' && output.theme.length > 0
            ? output.theme
            : resolveChoiceTheme({ settings, state, mode }),
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 500) : '',
        rejected,
        truncated,
        mode: combat ? 'combat' : 'exploration',
        // A row with fewer than two usable choices is not worth rendering.
        visible: choices.length >= MIN_CHOICE_COUNT,
    };
}

export function choicesCacheKey({
    chatId = '',
    messageIndex = -1,
    swipeId = 0,
    mode = 'exploration',
    theme = 'auto',
    count = DEFAULT_CHOICE_COUNT,
    regenerate = 0,
} = {}) {
    return [
        String(chatId ?? ''),
        String(Number.isInteger(messageIndex) ? messageIndex : -1),
        String(Number.isInteger(swipeId) ? swipeId : 0),
        mode,
        theme,
        String(count),
        String(Number.isInteger(regenerate) ? regenerate : 0),
    ].join(':');
}

/** Create the choices agent. `plan` is the test seam; `run` makes one call. */
export function createChoicesAgent({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    function plan(request = {}) {
        const settings = settingsFor(request);
        const mode = request.mode === 'combat' ? 'combat' : 'exploration';
        const state = request.state ?? null;
        const theme = request.theme ?? resolveChoiceTheme({
            settings,
            state,
            season: request.season ?? null,
            mode,
        });
        const prompt = buildChoicesPrompt({
            state,
            season: request.season ?? null,
            recentMessages: request.recentMessages ?? [],
            settings,
            mode,
            count: request.count,
            theme,
            maxLabelLength: request.maxLabelLength,
        });
        if (typeof request.propose !== 'function') {
            return {
                ...normalizeChoicesResult({
                    result: null,
                    settings,
                    mode,
                    state,
                    count: request.count,
                    maxLabelLength: request.maxLabelLength,
                }),
                prompt,
                calls: 0,
                source: 'deterministic',
            };
        }
        return {
            ...normalizeChoicesResult({
                result: request.propose({ prompt, schema: CHOICES_SCHEMA }),
                settings,
                mode,
                state,
                count: request.count,
                maxLabelLength: request.maxLabelLength,
            }),
            prompt,
            calls: 1,
            source: 'agent',
        };
    }

    async function run(request = {}) {
        const settings = settingsFor(request);
        const mode = request.mode === 'combat' ? 'combat' : 'exploration';
        const state = request.state ?? null;
        const config = settingsForMode(settings, mode);
        const recentMessages = asArray(request.recentMessages);
        const lastMessage = request.lastMessage
            ?? (recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null);
        const guard = shouldGenerateChoices({
            state,
            settings,
            lastMessage,
            mode,
            generationActive: request.generationActive === true,
            afterChoice: request.afterChoice === true,
        });
        if (!config.enabled) {
            return {
                enabled: false,
                calls: 0,
                choices: [],
                visible: false,
                reason: 'disabled',
                mode,
            };
        }
        if (!guard.allowed && request.force !== true) {
            return {
                enabled: true,
                calls: 0,
                choices: [],
                visible: false,
                reason: guard.reason,
                mode,
            };
        }

        const theme = request.theme ?? resolveChoiceTheme({
            settings,
            state,
            season: request.season ?? null,
            mode,
        });
        const prompt = buildChoicesPrompt({
            state,
            season: request.season ?? null,
            recentMessages: request.recentMessages ?? [],
            settings,
            mode,
            count: request.count,
            theme,
            maxLabelLength: request.maxLabelLength,
        });

        if (typeof runner?.runAgent !== 'function') {
            return {
                ...normalizeChoicesResult({
                    result: null,
                    settings,
                    mode,
                    state,
                    count: request.count,
                    maxLabelLength: request.maxLabelLength,
                }),
                enabled: true,
                calls: 0,
                source: 'deterministic',
                prompt,
            };
        }

        try {
            const response = await runner.runAgent({
                agentId: 'choices',
                prompt,
                schema: CHOICES_SCHEMA,
                signal: request.signal,
            });
            const result = responseValue(response);
            return {
                ...normalizeChoicesResult({
                    result,
                    settings,
                    mode,
                    state,
                    count: request.count,
                    maxLabelLength: request.maxLabelLength,
                }),
                enabled: true,
                calls: 1,
                source: 'agent',
                prompt,
                theme,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Choices pass failed; hiding the row', error);
            return {
                enabled: true,
                calls: 1,
                choices: [],
                visible: false,
                reason: 'agent-failed',
                mode,
                prompt,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildChoicesPrompt };
}
