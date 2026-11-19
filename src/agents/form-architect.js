/**
 * Neo Terra Form Architect.
 *
 * When a transform targets a form that has no card profile, the flow asks this
 * agent for a complete, validated profile overlay. The agent is read-only: the
 * reducer accepts only the validated payload and stores it under
 * `flags.generatedForms`. A transport or validation failure leaves the base
 * profile in place and adds a transformation note; play is never blocked.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import { buildFormProfileOverlay, FORM_PROFILE_FIELDS } from '../state/form-profiles.js';

export const MAX_FORM_FIELD = 1200;
export const MAX_FORM_LIST_ITEMS = 12;
export const MAX_FORM_SKILL_ITEMS = 6;
export const MAX_FORM_TRAIT_ITEMS = 8;

export const FORM_ARCHITECT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
        'displayName',
        'side',
        'formKind',
        'appearance',
        'attire',
        'personality',
        'speech',
        'abilities',
        'skills',
        'traits',
        'likes',
        'dislikes',
        'goals',
        'notes',
        'transformationSummary',
    ],
    properties: {
        displayName: { type: 'string', minLength: 1, maxLength: 80 },
        side: { type: 'string', enum: ['hero', 'villain', 'vigilante', 'civilian', 'neutral'] },
        formKind: { type: 'string', maxLength: 40 },
        appearance: { type: 'string', minLength: 1, maxLength: MAX_FORM_FIELD },
        attire: { type: 'string', maxLength: MAX_FORM_FIELD },
        personality: { type: 'string', maxLength: MAX_FORM_FIELD },
        speech: { type: 'string', maxLength: MAX_FORM_FIELD },
        abilities: {
            type: 'array',
            maxItems: MAX_FORM_LIST_ITEMS,
            items: { type: 'string', maxLength: 300 },
        },
        skills: {
            type: 'array',
            maxItems: MAX_FORM_SKILL_ITEMS,
            items: { type: 'string', maxLength: 60 },
        },
        traits: {
            type: 'array',
            maxItems: MAX_FORM_TRAIT_ITEMS,
            items: { type: 'string', maxLength: 60 },
        },
        likes: {
            type: 'array',
            maxItems: MAX_FORM_LIST_ITEMS,
            items: { type: 'string', maxLength: 200 },
        },
        dislikes: {
            type: 'array',
            maxItems: MAX_FORM_LIST_ITEMS,
            items: { type: 'string', maxLength: 200 },
        },
        goals: {
            type: 'array',
            maxItems: MAX_FORM_LIST_ITEMS,
            items: { type: 'string', maxLength: 240 },
        },
        notes: { type: 'string', maxLength: MAX_FORM_FIELD },
        transformationSummary: { type: 'string', minLength: 1, maxLength: 600 },
        contentFlags: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', maxLength: 80 },
        },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a transform.
    }
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

function clipped(value, max = MAX_FORM_FIELD) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clippedList(value, maxItems = MAX_FORM_LIST_ITEMS) {
    return asArray(value)
        .map((item) => clipped(item, 300))
        .filter(Boolean)
        .slice(0, maxItems);
}

/** Validate and normalize one generated form profile. */
export function validateGeneratedForm(value) {
    if (!isObject(value)) {
        return { ok: false, errors: ['generated form must be an object'] };
    }
    const errors = [];
    const displayName = clipped(value.displayName, 80);
    if (!displayName) {
        errors.push('displayName is required');
    }
    const appearance = clipped(value.appearance);
    if (!appearance) {
        errors.push('appearance is required');
    }
    const transformationSummary = clipped(value.transformationSummary, 600);
    if (!transformationSummary) {
        errors.push('transformationSummary is required');
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return {
        ok: true,
        errors: [],
        value: {
            displayName,
            side: ['hero', 'villain', 'vigilante', 'civilian', 'neutral'].includes(value.side)
                ? value.side
                : 'neutral',
            formKind: clipped(value.formKind, 40),
            appearance,
            attire: clipped(value.attire),
            personality: clipped(value.personality),
            speech: clipped(value.speech),
            abilities: clippedList(value.abilities),
            skills: clippedList(value.skills, MAX_FORM_SKILL_ITEMS).map((item) => item.slice(0, 60)),
            traits: clippedList(value.traits, MAX_FORM_TRAIT_ITEMS).map((item) => item.slice(0, 60)),
            likes: clippedList(value.likes),
            dislikes: clippedList(value.dislikes),
            goals: clippedList(value.goals),
            notes: clipped(value.notes),
            transformationSummary,
            contentFlags: clippedList(value.contentFlags, 12),
        },
    };
}

/** Convert a validated generated form into the stored overlay shape. */
export function generatedFormOverlay(form, { formId = null, model = null, now = Date.now() } = {}) {
    const overlay = buildFormProfileOverlay({
        appearance: form.appearance,
        attire: form.attire,
        abilities: form.abilities.join('\n'),
        personality: form.personality,
        speech: form.speech,
        likes: form.likes,
        dislikes: form.dislikes,
        goals: form.goals,
        background: form.notes,
    }, { formId, source: 'generated' });
    if (!overlay) {
        return null;
    }
    if (Array.isArray(form.skills)) {
        overlay.skills = form.skills.slice(0, MAX_FORM_SKILL_ITEMS);
    }
    if (Array.isArray(form.traits)) {
        overlay.traits = form.traits.slice(0, MAX_FORM_TRAIT_ITEMS);
    }
    return {
        ...overlay,
        formId,
        source: 'generated',
        generated: true,
        displayName: form.displayName,
        side: form.side,
        formKind: form.formKind,
        personality: form.personality,
        speech: form.speech,
        transformationSummary: form.transformationSummary,
        contentFlags: form.contentFlags,
        model,
        generatedAt: now,
        approved: false,
    };
}

/** Build the agent prompt from the base profile, form metadata, and season. */
export function buildFormArchitectPrompt({
    state = null,
    season = null,
    settings = {},
    character = null,
    targetFormId = null,
    formLabel = null,
    trigger = null,
    recentScene = null,
    otherCast = [],
} = {}) {
    const threats = asArray(season?.threats).slice(0, 6).map((threat) => ({
        name: threat.name,
        agenda: threat.agenda,
        rank: threat.rank,
    }));
    const factions = asArray(season?.factions).slice(0, 8).map((faction) => ({
        id: faction.id,
        role: faction.role ?? faction.side ?? null,
    }));
    const baseProfile = character
        ? {
            displayName: character.displayName,
            side: character.side,
            appearance: character.appearance,
            attire: character.outfit,
            abilities: asArray(character.abilities).slice(0, 8),
            skills: asArray(character.skills).slice(0, MAX_FORM_SKILL_ITEMS),
            traits: asArray(character.traits).slice(0, MAX_FORM_TRAIT_ITEMS),
            likes: asArray(character.likes).slice(0, 8),
            dislikes: asArray(character.dislikes).slice(0, 8),
            goals: asArray(character.goals).slice(0, 8),
            notes: character.notes,
        }
        : null;
    const sections = [
        'You are the Neo Terra Form Architect. Write one complete alternate-form profile for an established character.',
        'Ground every detail in the supplied base profile, the declared form, the season threats and factions, the other cast, and the recent scene.',
        'Do not invent a new canon character, a new faction, or future knowledge. Keep the same person recognizable.',
        'Respect the content gate and keep all fields concise. Return JSON only.',
        `Every string field is capped at ${MAX_FORM_FIELD} characters; list fields hold at most ${MAX_FORM_LIST_ITEMS} items.`,
        `skills holds at most ${MAX_FORM_SKILL_ITEMS} short capabilities and traits at most ${MAX_FORM_TRAIT_ITEMS} short passives.`,
        '',
        '## Transform',
        JSON.stringify({
            characterId: character?.charId ?? null,
            baseFormId: character?.formId ?? null,
            targetFormId,
            formLabel,
            trigger,
            seasonId: season?.id ?? state?.seasonId ?? null,
        }),
        '',
        '## Base profile',
        JSON.stringify(baseProfile),
        '',
        '## Season threats and factions',
        JSON.stringify({ threats, factions }),
        '',
        '## Other cast',
        JSON.stringify(asArray(otherCast).slice(0, 8)),
        '',
        '## Recent scene',
        JSON.stringify(recentScene ?? null),
        '',
        '## Response shape',
        JSON.stringify(FORM_ARCHITECT_SCHEMA),
    ];
    return applyContentGateToPrompt(
        sections.join('\n'),
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        {},
    );
}

/**
 * Create the Form Architect agent.
 *
 * `run` accepts `{ state, season, character, targetFormId, ... }` and resolves
 * to `{ ok, value?, overlay?, error? }`. It never mutates state and never
 * throws for model failures; abort errors propagate.
 */
export function createFormArchitect({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    async function run(request = {}) {
        const settings = settingsFor(request);
        const prompt = buildFormArchitectPrompt({
            state: request.state,
            season: request.season,
            settings,
            character: request.character,
            targetFormId: request.targetFormId,
            formLabel: request.formLabel,
            trigger: request.trigger,
            recentScene: request.recentScene,
            otherCast: request.otherCast,
        });
        if (settings?.agents?.formArchitect?.enabled === false
            || typeof runner?.runAgent !== 'function') {
            return { ok: false, reason: 'disabled', prompt, calls: 0 };
        }
        try {
            const response = await runner.runAgent({
                agentId: 'formArchitect',
                prompt,
                schema: FORM_ARCHITECT_SCHEMA,
                signal: request.signal,
            });
            const validation = validateGeneratedForm(responseValue(response));
            if (!validation.ok) {
                return {
                    ok: false,
                    reason: 'invalid',
                    errors: validation.errors,
                    prompt,
                    calls: 1,
                };
            }
            return {
                ok: true,
                value: validation.value,
                overlay: generatedFormOverlay(validation.value, {
                    formId: request.targetFormId,
                    model: settings?.agents?.formArchitect?.model ?? null,
                }),
                prompt,
                calls: 1,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Form Architect failed; keeping the base profile', error);
            return {
                ok: false,
                reason: 'failed',
                error: error?.message ?? String(error),
                prompt,
                calls: 1,
            };
        }
    }

    return { run, prompt: buildFormArchitectPrompt };
}
