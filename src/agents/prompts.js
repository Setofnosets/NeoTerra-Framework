/**
 * Prompt templates and per-agent configuration resolution.
 *
 * This module is intentionally pure: every export returns plain data and
 * never touches settings objects, the DOM, or SillyTavern globals.
 */

import { AGENT_IDS } from '../core/constants.js';

/** Hard contract appended to every agent system prompt. */
export const AGENT_JSON_CONTRACT = `Return exactly one JSON value.
Do not wrap the value in markdown code fences.
Do not write prose before or after the JSON value.
Use the supplied JSON schema as the shape of your answer.
Omit keys you do not know; use null for unknown values.
Never invent ids, names, or facts that were not supplied.`;

/** Default role prompts for every supported agent. */
export const DEFAULT_AGENT_PROMPTS = Object.freeze({
    architect: `You are the Neo Terra Architect. Build the season bootstrap from the supplied canon: initial placements, faction agendas, and opening situations. You are read-only: emit data describing the world, never edit it yourself.`,

    storyline: `You are the Neo Terra Storyline Director. Produce a high-level update for factions, threats, events, and story beats. Only use forms and ids declared in the supplied context. You are read-only: emit a data update, never write world state.`,

    stateTracker: `You are the Neo Terra State Tracker. Report only the player character's per-turn state from the supplied scene. Never decide or narrate NPC agency. You are read-only: emit data only.`,

    castDirector: `You are the Neo Terra Cast Director. Report who is present, who arrives, who departs, and which offscreen characters move. Exclude every player-controlled character. You are read-only: emit cast data only.`,

    lore: `You are the Neo Terra Lore Keeper. Produce concise summaries, relationship notes, and lore selections grounded in the supplied canon. You are read-only: emit data only and never invent ids or facts.`,

    auditor: `You are the Neo Terra Auditor. Check the supplied context for contradictions and continuity errors. You are strictly read-only: report findings; never change state or prose.`,

    epilogue: `You are the Neo Terra Epilogue Writer. Write the ending prose and the available path options for a recorded ending. Stay consistent with the recorded evidence. You are read-only: emit text and option data only.`,

    choices: `You are the Neo Terra Choice Designer. Produce 2 to 6 choice labels, each tagged with intent, tone, and risk. Never post or act on a choice yourself. You are read-only: emit choice data only.`,

    badEnd: `You are the Neo Terra Bad End Detector. Confirm a terminal state only from the supplied deterministic evidence. Never invent evidence, and never alter characters. You are read-only: emit a confirmation result only.`,

    newspaper: `You are the Neo Terra Newspaper Editor. Write the front page of an in-world newspaper from the supplied events and world facts. Use the requested style and tone. Return only masthead, dateline, and 1-6 headlines. Never invent events, ids, names, numbers, or outcomes; every headline must be traceable to the supplied facts. You are read-only: emit prose data only.`,

    formArchitect: `You are the Neo Terra Form Architect. Write one complete alternate-form profile for an established character, grounded in the base card, the declared form, the season threats and factions, the other cast, and the recent scene. Keep the same person recognizable and never invent future knowledge. You are read-only: emit data only.`,

    characterCreator: `You are the Neo Terra Card Architect. Write one new non-canon supporting character for a Neo Terra season, in the exact house style of the supplied exemplar cards. Ground every detail in the season bible, the closed district list, and the concept brief. Return structured fields only; the card description is assembled from them. Never invent a faction, district, hero, or major villain, never grant future knowledge, and never narrate the player. You are read-only: emit data only.`,

    goalInference: `You are the Neo Terra Goal Scribe. Derive the goals a played character is actively steering toward from the supplied card and season context. Stay grounded in the supplied material, never invent canon or names, and never quote dialogue. You are read-only: emit data only.`,

    sceneDescriber: `You are the Neo Terra Scene Describer. Write a short atmospheric description of the place the player just arrived at. Address the player in second person, present tense, for 2-3 sentences. Use only the supplied location, time, cast, and encounter facts. Never introduce new characters, never decide outcomes, never use numbers, and never write state. You are read-only: emit prose data only.`,
});

/** Instructions for the single allowed repair attempt. */
export const DEFAULT_REPAIR_PROMPT = `Your previous answer was not valid. Repair it now.
Restate and obey the JSON-only contract: return exactly one JSON value, with no markdown fences and no prose before or after it.
Use the validation errors below to correct the response.
Return only the corrected JSON value.`;

const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_SCHEMA_CHARS = 6000;

/**
 * Resolve one agent's effective configuration.
 *
 * Precedence: `overrides` > `settings.agents[agentId]` > built-in defaults.
 * The settings object is only read, never mutated.
 */
export function resolveAgentConfig(settings, agentId, overrides = {}, defaults = {}) {
    if (!AGENT_IDS.includes(agentId)) {
        throw new Error(`Unknown agent id: "${agentId}"`);
    }

    const agentSettings = settings?.agents?.[agentId];
    const override = isPlainObject(overrides) ? overrides : {};
    const fallback = isPlainObject(defaults) ? defaults : {};

    const promptFromOverride = nonEmptyString(override.prompt);
    const promptFromSettings = nonEmptyString(agentSettings?.prompt);
    const systemPrompt =
        promptFromOverride ??
        promptFromSettings ??
        DEFAULT_AGENT_PROMPTS[agentId];

    return {
        agentId,
        systemPrompt,
        temperature:
            finiteNumber(override.temperature) ??
            finiteNumber(agentSettings?.temperature) ??
            DEFAULT_TEMPERATURE,
        maxTokens:
            positiveInteger(override.maxTokens) ??
            positiveInteger(agentSettings?.maxTokens) ??
            DEFAULT_MAX_TOKENS,
        model:
            stringOrEmpty(override.model) ??
            stringOrEmpty(agentSettings?.model) ??
            '',
        connectionProfileId:
            stringOrEmpty(override.connectionProfileId) ??
            stringOrEmpty(agentSettings?.connectionProfileId) ??
            '',
        timeoutMs:
            positiveInteger(override.timeoutMs) ??
            positiveInteger(agentSettings?.timeoutMs) ??
            positiveInteger(fallback.timeoutMs) ??
            DEFAULT_TIMEOUT_MS,
        enabled:
            typeof override.enabled === 'boolean'
                ? override.enabled
                : typeof agentSettings?.enabled === 'boolean'
                    ? agentSettings.enabled
                    : true,
    };
}

/** Compose the final system prompt: role + JSON contract + compact schema. */
export function buildSystemPrompt({ agentId, settings, overrides = {}, schema } = {}) {
    const config = resolveAgentConfig(settings, agentId, overrides);
    const parts = [config.systemPrompt, AGENT_JSON_CONTRACT];
    const schemaText = describeSchema(schema);
    if (schemaText) {
        parts.push(`JSON schema:\n${schemaText}`);
    }
    return parts.join('\n\n');
}

/** Compose the system prompt for the single repair request. */
export function buildRepairSystemPrompt({ agentId, settings, overrides = {}, schema } = {}) {
    const config = resolveAgentConfig(settings, agentId, overrides);
    const parts = [config.systemPrompt, DEFAULT_REPAIR_PROMPT, AGENT_JSON_CONTRACT];
    const schemaText = describeSchema(schema);
    if (schemaText) {
        parts.push(`JSON schema:\n${schemaText}`);
    }
    return parts.join('\n\n');
}

/** Compose the user prompt for the single repair request. */
export function buildRepairUserPrompt({ originalPrompt, rawResponse, errors, schema } = {}) {
    const errorText = formatErrors(errors);
    const previous = truncate(stringifyForPrompt(rawResponse), 8000);
    const schemaText = describeSchema(schema) ?? '(no schema supplied)';

    return [
        'The previous response was not valid for the required JSON contract.',
        `Original task:\n${stringifyForPrompt(originalPrompt)}`,
        `Previous response:\n${previous}`,
        `Validation errors:\n${errorText}`,
        `Required JSON schema:\n${schemaText}`,
        'Return only the corrected JSON value.',
    ].join('\n\n');
}

/**
 * Replace `{{key}}` placeholders with values. Unknown placeholders stay
 * untouched. Non-string templates are a programming error.
 */
export function renderPromptTemplate(template, vars = {}) {
    if (typeof template !== 'string') {
        throw new TypeError('renderPromptTemplate expects a string template');
    }
    const values = isPlainObject(vars) ? vars : {};
    return template.replace(/\{\{([^{}]+)\}\}/g, (match, rawKey) => {
        const key = rawKey.trim();
        if (!Object.hasOwn(values, key) || values[key] === undefined) {
            return match;
        }
        return String(values[key]);
    });
}

/** Build the chat-completion message array. */
export function buildMessages({ systemPrompt, userPrompt }) {
    return [
        { role: 'system', content: String(systemPrompt ?? '') },
        { role: 'user', content: String(userPrompt ?? '') },
    ];
}

function describeSchema(schema) {
    if (schema === undefined || schema === null) {
        return '';
    }
    let text;
    try {
        text = JSON.stringify(schema);
    } catch {
        text = '"[unserializable schema]"';
    }
    if (text === undefined) {
        return '';
    }
    return truncate(text, MAX_SCHEMA_CHARS);
}

function formatErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
        return '(no validation errors reported)';
    }
    return errors
        .map((error) => {
            if (error && typeof error === 'object') {
                return `${error.path ?? '$'}: ${error.message ?? 'invalid value'}`;
            }
            return String(error);
        })
        .join('\n');
}

function stringifyForPrompt(value) {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function truncate(text, limit) {
    return text.length > limit ? text.slice(0, limit) : text;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringOrEmpty(value) {
    return typeof value === 'string' ? value : undefined;
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}
