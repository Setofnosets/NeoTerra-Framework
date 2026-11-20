/**
 * Travel scene description.
 *
 * A successful travel already posts a deterministic arrival frame. This agent
 * adds one short atmospheric frame afterwards: present tense, second person,
 * grounded only in the supplied location/cast/encounter facts. It is optional
 * and time-boxed; a failure or timeout posts nothing.
 *
 * Pure module: the prompt/validation helpers never touch the DOM.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('scene-describer');

export const SCENE_DESCRIBER_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['description', 'sensory'],
    properties: {
        description: { type: 'string', minLength: 20, maxLength: 480 },
        sensory: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 40 },
        },
    },
});

export const MAX_DESCRIPTION_LENGTH = 480;
export const MAX_SENSORY = 4;
export const MAX_SENSORY_LENGTH = 40;
export const DEFAULT_TIMEOUT_MS = 12000;
const MAX_EXCERPT = 240;
const MAX_CAST = 6;
const MAX_SEASON_TEXT = 240;

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

function stripContextBlocks(text) {
    return String(text ?? '')
        .replace(/\[NEOTERRA_[A-Z_]+\][\s\S]*?(?=\n\[NEOTERRA_[A-Z_]+\]|$)/g, '')
        .replace(/\[NEOTERRA_[A-Z_]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        } else {
            logger.warn(message, error === undefined ? undefined : (error?.message ?? String(error)));
        }
    } catch {
        // Logging must never block the arrival.
    }
}

/**
 * Normalize one describer response. Returns `null` when no usable prose is
 * present; a valid but over-long description is clamped, never rejected.
 */
export function normalizeSceneDescription(value) {
    if (!isObject(value)) {
        return null;
    }
    const description = stripContextBlocks(value.description);
    if (description.length === 0) {
        return null;
    }
    const sensory = asArray(value.sensory)
        .map((entry) => clip(entry, MAX_SENSORY_LENGTH))
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_SENSORY);
    return {
        description: description.length > MAX_DESCRIPTION_LENGTH
            ? description.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()
            : description,
        sensory,
    };
}

/**
 * Build the grounded describer prompt. Everything is a scene fact: no card
 * dumps beyond a short excerpt and no state document.
 */
export function buildSceneDescriptionPrompt({
    state = null,
    season = null,
    encounter = null,
    notice = null,
    settings = {},
} = {}) {
    const locationId = state?.scene?.locationId ?? null;
    const location = locationId ? state?.locations?.[locationId] ?? null : null;
    const factionId = location?.factionId ?? null;
    const factionName = factionId ? state?.factions?.[factionId]?.name ?? factionId : null;
    const playerId = state?.player?.characterId ?? null;
    const cast = asArray(state?.scene?.present)
        .filter((id) => typeof id === 'string' && id !== playerId)
        .map((id) => state?.characters?.[id] ?? null)
        .filter((character) => character && character.controlledBy !== 'player')
        .slice(0, MAX_CAST)
        .map((character) => ({
            name: character.displayName ?? character.charId,
            side: character.side ?? null,
            mood: character.mood ?? null,
            appearance: clip(character.appearance, MAX_EXCERPT) || null,
        }));
    const resolvedEncounter = encounter ?? state?.scene?.encounter ?? null;
    const encounterNames = asArray(resolvedEncounter?.characterIds)
        .map((id) => state?.characters?.[id]?.displayName ?? id)
        .concat(asArray(resolvedEncounter?.threatNames));

    const sections = [
        'Write the arrival scene for the player. 2-3 sentences, present tense, second person ("you").',
        'Use only the supplied facts. Do not name anyone who is not in the cast or encounter lists.',
        'Do not decide outcomes, do not grant knowledge, do not include numbers or game statistics, and do not write prompt blocks.',
        'Return JSON only.',
        '',
        '## Location',
        JSON.stringify({
            name: clip(location?.name ?? locationId ?? 'unknown', MAX_SEASON_TEXT),
            district: clip(location?.district, MAX_SEASON_TEXT) || null,
            status: clip(location?.status, MAX_SEASON_TEXT) || null,
            faction: clip(factionName, MAX_SEASON_TEXT) || null,
            description: clip(location?.notes, MAX_EXCERPT) || null,
        }),
        '',
        '## Time',
        JSON.stringify({
            date: state?.meta?.inGameDate ?? null,
            slot: state?.meta?.timeOfDay ?? null,
            turn: state?.meta?.turn ?? null,
        }),
        '',
        '## Present cast',
        JSON.stringify(cast),
        '',
        '## Encounter',
        JSON.stringify({
            present: Boolean(resolvedEncounter),
            names: encounterNames.slice(0, 8),
            noticedFirst: notice?.noticedFirst === true,
            ambush: notice?.ambush === true,
            actor: notice?.actorName ?? null,
        }),
        '',
        '## Season',
        JSON.stringify({
            title: clip(season?.title ?? season?.id ?? null, MAX_SEASON_TEXT) || null,
            tone: clip(season?.toneNotes, MAX_SEASON_TEXT) || null,
            premise: clip(season?.premise, MAX_SEASON_TEXT) || null,
        }),
        '',
        '## Content level',
        String(settings?.contentGate ?? 'full'),
        '',
        '## Response shape',
        JSON.stringify(SCENE_DESCRIBER_SCHEMA),
    ];

    return applyContentGateToPrompt(
        sections.join('\n'),
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        { isPlayer: true },
    );
}

/**
 * Create the describer. `run` never throws; transport, timeout, and abort all
 * resolve to `{ ok: false }` so the arrival frame stands alone.
 */
export function createSceneDescriber({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    async function run(request = {}) {
        let prompt = '';
        try {
            const settings = settingsFor(request);
            const agentSettings = settings?.agents?.sceneDescriber ?? {};
            if (agentSettings.enabled === false) {
                return { ok: false, skipped: true, error: 'Scene description is disabled', description: null, sensory: [] };
            }
            if (typeof runner?.runAgent !== 'function') {
                return { ok: false, skipped: true, error: 'Scene description has no runner', description: null, sensory: [] };
            }
            prompt = buildSceneDescriptionPrompt({
                state: request.state ?? null,
                season: request.season ?? null,
                encounter: request.encounter ?? null,
                notice: request.notice ?? null,
                settings,
            });
            const response = await runner.runAgent({
                agentId: 'sceneDescriber',
                prompt,
                schema: SCENE_DESCRIBER_SCHEMA,
                overrides: {
                    timeoutMs: Number.isFinite(agentSettings.timeoutMs) && agentSettings.timeoutMs > 0
                        ? agentSettings.timeoutMs
                        : DEFAULT_TIMEOUT_MS,
                },
                signal: request.signal,
            });
            const normalized = normalizeSceneDescription(responseValue(response));
            if (!normalized) {
                logWarning(log, 'Scene description returned no usable prose; posting nothing');
                return { ok: false, error: 'unusable-description', description: null, sensory: [], prompt };
            }
            return {
                ok: true,
                description: normalized.description,
                sensory: normalized.sensory,
                prompt,
            };
        } catch (error) {
            const aborted = isAbortError(error);
            logWarning(
                log,
                aborted
                    ? 'Scene description was aborted; the arrival frame stands'
                    : 'Scene description failed; the arrival frame stands',
                error,
            );
            return {
                ok: false,
                aborted,
                error: error?.message ?? String(error),
                description: null,
                sensory: [],
                prompt,
            };
        }
    }

    return { run, prompt: buildSceneDescriptionPrompt };
}
