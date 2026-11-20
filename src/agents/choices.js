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
import { isSurprisedCombat, SURPRISED_COMBAT_ACTIONS } from '../flows/encounter.js';
import { COMBAT_ACTIONS, COMBAT_RISK_TIERS } from '../combat/resolver.js';
import { isPlayerCharacter } from '../state/selectors.js';

export const CHOICES_SCHEMA_VERSION = 1;
export const DEFAULT_CHOICE_COUNT = 4;
export const MAX_CHOICE_COUNT = 6;
export const MIN_CHOICE_COUNT = 2;
export const DEFAULT_MAX_LABEL_LENGTH = 100;
export const MAX_CONNECTED_CHOICES = 8;

/**
 * Routable chip kinds. `prose` (the default) sends the label as ordinary player
 * text; `travel` moves the player to `target` through the travel flow; `combat`
 * engages the current encounter. A chip without a routable payload always stays
 * `prose`, so a malformed model can never trigger an engine action.
 */
export const CHOICE_KINDS = Object.freeze(['prose', 'travel', 'combat']);

/**
 * Only offensive combat actions can start a fight from a chip. Defend,
 * retreat, surrender, and talk-down stay prose: a stale row from a finished
 * fight must never re-open combat.
 */
const ENGAGE_COMBAT_ACTIONS = Object.freeze(['strike', 'grapple', 'feint', 'skill']);

/** The resolver owns the combat vocabulary; choices re-export it. */
export { COMBAT_ACTIONS, COMBAT_RISK_TIERS } from '../combat/resolver.js';

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
                    kind: { type: 'string', enum: [...CHOICE_KINDS] },
                    target: { type: 'string', maxLength: 120 },
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

/**
 * Connection lists may come from the live travel graph (which knows bridge
 * overrides and virtual nodes) or from a WorldState location record. Accept
 * both `string[]` and `{ id, name }[]` entries so the prompt always names the
 * destination instead of only an id.
 */
function normalizeConnectionEntry(entry, state) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || id.length === 0) {
        return null;
    }
    // A live graph entry may carry the overridden/virtual name; prefer it.
    const name = typeof entry?.name === 'string' && entry.name.trim().length > 0
        ? entry.name.trim()
        : state?.locations?.[id]?.name ?? id;
    return { id, name };
}

/**
 * The current location's directly connected destinations, capped for the
 * prompt. A travel chip may only target one of these ids (Decision 4).
 */
export function connectedLocations({ state = null, connections = null, max = MAX_CONNECTED_CHOICES } = {}) {
    const current = state?.scene?.locationId ?? null;
    if (typeof current !== 'string' || current.length === 0) {
        return [];
    }
    // A supplied graph map is authoritative: a missing key means "no known
    // connections", never a silent fallback to authored edges.
    const raw = isObject(connections)
        ? (Array.isArray(connections[current]) ? connections[current] : [])
        : Array.isArray(state?.locations?.[current]?.connections)
            ? state.locations[current].connections
            : [];
    const seen = new Set([current]);
    const locations = [];
    for (const entry of raw) {
        const resolved = normalizeConnectionEntry(entry, state);
        if (!resolved || seen.has(resolved.id)) {
            continue;
        }
        seen.add(resolved.id);
        locations.push(resolved);
        if (locations.length >= (Number.isInteger(max) && max > 0 ? max : MAX_CONNECTED_CHOICES)) {
            break;
        }
    }
    return locations;
}

/**
 * Hostiles the player could engage right now: the persisted encounter's
 * characters first, then the active combat's participants (minus the player).
 */
export function choiceHostiles({ state = null } = {}) {
    const encounter = isObject(state?.scene?.encounter) ? state.scene.encounter : null;
    const combat = isObject(state?.scene?.combat) ? state.scene.combat : null;
    const ids = [
        ...asArray(encounter?.characterIds),
        ...asArray(combat?.participants),
    ];
    const playerSide = combat && isObject(combat.sides)
        ? (isPlayerCharacter(state, state?.player?.characterId)
            ? combat.sides[state.player.characterId] ?? 'a'
            : combat.sides.player ?? 'a')
        : null;
    const seen = new Set();
    const hostiles = [];
    for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
            continue;
        }
        if (id === 'player' || isPlayerCharacter(state, id)) {
            continue;
        }
        const character = state?.characters?.[id] ?? null;
        if (!character || character.alive === false) {
            continue;
        }
        // Active combat lists both sides: only the opposing side is hostile.
        if (combat && playerSide && isObject(combat.sides) && combat.sides[id] === playerSide) {
            continue;
        }
        seen.add(id);
        hostiles.push({
            id,
            name: character.displayName ?? character.charId ?? id,
        });
    }
    // A threat-only encounter has no character ids, but the prompt still names
    // the threat so an engage chip is never silently invented or dropped.
    for (const name of asArray(encounter?.threatNames)) {
        const threatName = typeof name === 'string' ? name.trim() : '';
        if (threatName.length === 0 || seen.has(`threat:${threatName}`)) {
            continue;
        }
        seen.add(`threat:${threatName}`);
        hostiles.push({ id: `threat:${threatName}`, name: threatName, threat: true });
    }
    return hostiles;
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
    connections = null,
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

    const destinations = combat ? [] : connectedLocations({ state, connections });
    const hostiles = choiceHostiles({ state });
    if (destinations.length > 0) {
        lines.push('## Connected locations');
        lines.push('Travel chips may only target one of these directly connected ids:');
        for (const location of destinations) {
            lines.push(`- ${location.id} — ${location.name}`);
        }
        lines.push('');
    }
    if (hostiles.length > 0) {
        lines.push('## Hostiles here');
        for (const hostile of hostiles) {
            lines.push(`- ${hostile.id} — ${hostile.name}`);
        }
        lines.push('');
    }

    const surprised = combat && isSurprisedCombat(state);
    if (combat) {
        lines.push('## Combat');
        lines.push(`Active: yes`);
        lines.push(`Participants: ${asArray(state?.scene?.combat?.participants).join(', ') || '(unknown)'}`);
        lines.push('Combat choices must be concrete actions, not narration.');
        if (surprised) {
            lines.push('Surprised: this is the opening beat of an ambush. Only defensive/escape actions are allowed this round.');
        }
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
        const allowedActions = surprised ? SURPRISED_COMBAT_ACTIONS : COMBAT_ACTIONS;
        lines.push(`Allowed actions: ${allowedActions.join(', ')}.`);
        lines.push(`Risk tiers: ${COMBAT_RISK_TIERS.join(', ')}.`);
        if (surprised) {
            lines.push('The ambush restricts this round: do not offer strike, grapple, feint, or skill.');
        }
        lines.push('Every choice requires an action from the allowed list and a risk tier.');
        lines.push('Prefer actions the resolver can settle: strike, defend, grapple, feint, skill, retreat, surrender, talk down.');
        lines.push('Combat choices are already inside the fight; the narrator resolves them from the label. Never omit the action.');
    } else {
        lines.push(`Allowed intents: ${CHOICE_INTENTS.join(', ')}.`);
        lines.push('Exploration choices may include dialogue, investigation, travel, romance, or lewd content when the mix allows it.');
        lines.push('Choice kind: "prose" (default), "travel", or "combat".');
        if (destinations.length > 0) {
            lines.push('A travel chip must set kind "travel" and target to one of the connected location ids above.');
        } else {
            lines.push('Do not emit travel chips: no connected destinations are known.');
        }
        if (hostiles.length > 0) {
            lines.push('A chip that starts a fight must set kind "combat" and target "engage".');
        } else {
            lines.push('Do not emit combat chips: no hostiles are recorded here.');
        }
        lines.push('Any other choice must use kind "prose" (or omit kind) and no target.');
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
    connections = null,
} = {}) {
    const config = settingsForMode(settings, mode);
    const combat = mode === 'combat' || isCombatScene(state);
    const surprised = combat && isSurprisedCombat(state);
    const travelLocations = connectedLocations({ state, connections });
    const allowedTravelIds = new Set(travelLocations.map((location) => location.id));
    const hostiles = choiceHostiles({ state });
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
    let downgraded = 0;

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
            const allowedActions = surprised ? SURPRISED_COMBAT_ACTIONS : COMBAT_ACTIONS;
            if (!allowedActions.includes(action)) {
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

        // Routable payload. A chip is only allowed to carry a kind the engine
        // can execute for this exact scene; everything else is a plain prose
        // chip so a stale or inventive model can never start a fight or a trip.
        let kind = 'prose';
        let target = null;
        let targetName = null;
        if (combat) {
            // An offensive action can start/continue a fight; defensive ones
            // are prose so a surviving row cannot re-engage after combat ends.
            if (ENGAGE_COMBAT_ACTIONS.includes(action)) {
                kind = 'combat';
                target = 'engage';
                targetName = hostiles.length > 0
                    ? hostiles.map((hostile) => hostile.name).join(', ')
                    : null;
            }
        } else {
            const rawKind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : 'prose';
            const rawTarget = typeof raw.target === 'string' ? raw.target.trim() : '';
            if (rawKind === 'travel') {
                if (rawTarget.length > 0 && allowedTravelIds.has(rawTarget)) {
                    kind = 'travel';
                    target = rawTarget;
                    targetName = travelLocations.find((location) => location.id === rawTarget)?.name ?? null;
                } else {
                    downgraded += 1;
                }
            } else if (rawKind === 'combat') {
                const validTarget = rawTarget === 'engage'
                    || hostiles.some((hostile) => hostile.id === rawTarget);
                if (hostiles.length > 0 && validTarget) {
                    kind = 'combat';
                    target = 'engage';
                    targetName = hostiles.map((hostile) => hostile.name).join(', ');
                } else {
                    downgraded += 1;
                }
            } else if (rawKind !== 'prose' && rawKind.length > 0) {
                downgraded += 1;
            }
        }

        seen.add(key);
        choices.push({
            label,
            kind,
            ...(target ? { target } : {}),
            ...(targetName ? { targetName } : {}),
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
        downgraded,
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
    connectionsKey = '',
} = {}) {
    return [
        String(chatId ?? ''),
        String(Number.isInteger(messageIndex) ? messageIndex : -1),
        String(Number.isInteger(swipeId) ? swipeId : 0),
        mode,
        theme,
        String(count),
        String(Number.isInteger(regenerate) ? regenerate : 0),
        String(connectionsKey ?? ''),
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
            connections: request.connections ?? null,
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
                    connections: request.connections ?? null,
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
                connections: request.connections ?? null,
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
            connections: request.connections ?? null,
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
                    connections: request.connections ?? null,
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
                    connections: request.connections ?? null,
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
