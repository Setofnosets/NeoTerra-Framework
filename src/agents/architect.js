/**
 * Neo Terra Architect.
 *
 * One-shot season bootstrap enrichment. The Architect is a pure planner: it
 * reads a seeded WorldState and returns reducer-shaped events for placements,
 * agendas, initial headlines, and act framing. It never mutates the document
 * it is given and never posts to chat.
 */

import { AgentAbortedError } from './client.js';
import { getCurrentAct, getUpcomingBeats } from '../data/beats.js';

export const ARCHITECT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['placements', 'agendas', 'headlines', 'framing', 'rationale'],
    properties: {
        placements: {
            type: 'array',
            maxItems: 20,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['characterId', 'locationId', 'reason'],
                properties: {
                    characterId: { type: 'string' },
                    locationId: { type: 'string' },
                    reason: { type: 'string', maxLength: 240 },
                },
            },
        },
        agendas: {
            type: 'array',
            maxItems: 20,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['characterId', 'agenda'],
                properties: {
                    characterId: { type: 'string' },
                    agenda: { type: 'string', maxLength: 300 },
                    goals: {
                        type: 'array',
                        maxItems: 5,
                        items: { type: 'string', maxLength: 160 },
                    },
                },
            },
        },
        headlines: {
            type: 'array',
            maxItems: 5,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['summary'],
                properties: {
                    summary: { type: 'string', maxLength: 400 },
                    headline: { type: 'string', maxLength: 160 },
                    tags: {
                        type: 'array',
                        maxItems: 6,
                        items: { type: 'string', maxLength: 60 },
                    },
                },
            },
        },
        framing: { type: 'string', maxLength: 800 },
        rationale: { type: 'string', maxLength: 600 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function characterName(state, characterId) {
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function locationLabel(state, locationId) {
    const location = state?.locations?.[locationId];
    if (!location) {
        return String(locationId ?? 'unknown');
    }
    return location.district ? `${location.name}, ${location.district}` : location.name;
}

function isPlayerCharacter(state, characterId) {
    return characterId === state?.player?.characterId
        || state?.characters?.[characterId]?.controlledBy === 'player';
}

/**
 * Deterministic prompt. No agent call and no clock use.
 */
export function buildArchitectPrompt({ state, season } = {}) {
    const locationId = state?.scene?.locationId ?? season?.startLocationId ?? null;
    const act = getCurrentAct(state, season);
    const upcoming = getUpcomingBeats(state, season, 4);
    const threats = asArray(season?.threats);
    const factions = Object.values(state?.factions ?? {}).filter(isObject);
    const characters = Object.values(state?.characters ?? {}).filter(isObject);

    const lines = [];
    lines.push(`# Neo Terra Architect — ${season?.title ?? season?.id ?? 'Season'}`);
    lines.push('');
    lines.push('## Season');
    lines.push(`Era: ${season?.era ?? 'unknown'}`);
    lines.push(`Player role: ${state?.playerRole ?? season?.playerRole ?? 'neutral'}`);
    lines.push(`Act: ${act}`);
    lines.push(`Start: ${locationLabel(state, locationId)} (${String(locationId)})`);
    if (typeof season?.premise === 'string' && season.premise.length > 0) {
        lines.push(`Premise: ${season.premise}`);
    }
    lines.push('');

    lines.push('## Factions');
    if (factions.length === 0) {
        lines.push('(none)');
    } else {
        for (const faction of factions.slice(0, 16)) {
            lines.push(`${faction.id} — ${faction.name} — ${faction.side} — influence ${faction.influence} — ${faction.status}`);
        }
    }
    lines.push('');

    lines.push('## Threats');
    if (threats.length === 0) {
        lines.push('(none)');
    } else {
        for (const threat of threats.slice(0, 12)) {
            lines.push(`${threat.id} — ${threat.name} — ${threat.rank} — ${threat.agenda}`);
        }
    }
    lines.push('');

    lines.push('## Cast');
    for (const character of characters.slice(0, 40)) {
        lines.push([
            character.charId,
            character.displayName,
            character.locationId ?? 'unknown',
            character.status,
            character.side,
        ].join(' — '));
    }
    lines.push('');

    lines.push('## Opening beats');
    for (const beat of upcoming) {
        lines.push(`${beat.id} — ${beat.act} — ${beat.title}`);
    }
    lines.push('');

    lines.push('## Rules');
    lines.push('Only use character ids and location ids supplied above.');
    lines.push('Never move or re-agenda the player-controlled character.');
    lines.push('At most one active form per form group may be placed.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(JSON.stringify(ARCHITECT_SCHEMA));

    return lines.join('\n');
}

function rejection(rejected, characterId, reason) {
    rejected.push({ characterId, reason });
}

/**
 * Validate raw Architect output and translate it into reducer events.
 * Bad output never throws: unknown ids and forbidden changes become reasons.
 */
export function normalizeArchitectResult({ result, state, season } = {}) {
    const output = isObject(result) ? result : {};
    const events = [];
    const rejected = [];
    const notes = [];
    const seenPlacements = new Set();
    const seenAgendas = new Set();

    for (const placement of asArray(output.placements)) {
        if (!isObject(placement) || typeof placement.characterId !== 'string'
            || typeof placement.locationId !== 'string') {
            continue;
        }
        const { characterId, locationId } = placement;
        if (isPlayerCharacter(state, characterId)) {
            rejection(rejected, characterId, 'player-controlled');
            continue;
        }
        if (!state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'unknown-character');
            continue;
        }
        if (!state?.locations?.[locationId]) {
            rejection(rejected, characterId, 'unknown-location');
            continue;
        }
        if (seenPlacements.has(characterId)) {
            rejection(rejected, characterId, 'duplicate-placement');
            continue;
        }
        seenPlacements.add(characterId);
        if (state.characters[characterId].locationId !== locationId) {
            events.push({ type: 'MOVE_CHARACTER', characterId, locationId });
        }
    }

    for (const agenda of asArray(output.agendas)) {
        if (!isObject(agenda) || typeof agenda.characterId !== 'string'
            || typeof agenda.agenda !== 'string' || agenda.agenda.trim().length === 0) {
            continue;
        }
        const { characterId } = agenda;
        if (isPlayerCharacter(state, characterId)) {
            rejection(rejected, characterId, 'player-controlled');
            continue;
        }
        if (!state?.characters?.[characterId]) {
            rejection(rejected, characterId, 'unknown-character');
            continue;
        }
        if (seenAgendas.has(characterId)) {
            rejection(rejected, characterId, 'duplicate-agenda');
            continue;
        }
        seenAgendas.add(characterId);
        const goals = asArray(agenda.goals)
            .filter((goal) => typeof goal === 'string' && goal.trim().length > 0)
            .slice(0, 5);
        events.push({
            type: 'SET_CHARACTER_FIELDS',
            characterId,
            agenda: agenda.agenda.trim(),
            ...(goals.length > 0 ? { goals } : {}),
        });
    }

    for (const headline of asArray(output.headlines).slice(0, 5)) {
        if (!isObject(headline) || typeof headline.summary !== 'string'
            || headline.summary.trim().length === 0) {
            continue;
        }
        const tags = asArray(headline.tags)
            .filter((tag) => typeof tag === 'string' && tag.length > 0)
            .slice(0, 6);
        events.push({
            type: 'ADD_EVENT',
            summary: headline.summary.trim(),
            headline: typeof headline.headline === 'string' && headline.headline.trim().length > 0
                ? headline.headline.trim()
                : headline.summary.trim(),
            actors: [],
            locationId: state?.scene?.locationId ?? null,
            tags: [...new Set(['architect', ...tags])],
        });
    }

    if (typeof output.framing === 'string'
        && output.framing.trim().length > 0
        && output.framing.trim() !== state?.scene?.framing) {
        events.push({ type: 'SET_SCENE_FRAMING', framing: output.framing.trim() });
        notes.push('framing-updated');
    }

    return {
        events,
        rejected,
        notes,
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 600) : '',
        act: getCurrentAct(state, season),
        prompt: null,
    };
}

/** Deterministic fallback: no state changes, only a stable act framing summary. */
export function planArchitect({ state, season } = {}) {
    const act = getCurrentAct(state, season);
    const upcoming = getUpcomingBeats(state, season, 2);
    return {
        events: [],
        rejected: [],
        notes: [`act:${act}`],
        rationale: upcoming.length > 0
            ? `Opening the ${act} act with ${upcoming.map((beat) => beat.title).join(', ')}.`
            : `Opening the ${act} act.`,
        act,
    };
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break a bootstrap.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/**
 * Thin runner wrapper. `run` performs one schema-validated pass and degrades to
 * the deterministic plan on any non-abort failure.
 */
export function createArchitect({
    runner = null,
    getSettings = null,
    log = null,
} = {}) {
    function prepare(request = {}) {
        const state = request.state ?? null;
        const season = request.season ?? null;
        return {
            state,
            season,
            prompt: buildArchitectPrompt({ state, season }),
        };
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        if (typeof request.propose === 'function') {
            return {
                ...normalizeArchitectResult({
                    result: request.propose({
                        prompt: prepared.prompt,
                        schema: ARCHITECT_SCHEMA,
                    }),
                    state: prepared.state,
                    season: prepared.season,
                }),
                source: 'agent',
                prompt: prepared.prompt,
            };
        }
        return { ...planArchitect(prepared), source: 'deterministic', prompt: prepared.prompt };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        const settings = (typeof getSettings === 'function' ? getSettings() : request.settings) ?? {};
        const enabled = settings?.agents?.architect?.enabled !== false;

        if (!enabled || typeof runner?.runAgent !== 'function') {
            return { ...planArchitect(prepared), source: 'deterministic', prompt: prepared.prompt };
        }

        try {
            const response = await runner.runAgent({
                agentId: 'architect',
                prompt: prepared.prompt,
                schema: ARCHITECT_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            return {
                ...normalizeArchitectResult({
                    result,
                    state: prepared.state,
                    season: prepared.season,
                }),
                source: 'agent',
                prompt: prepared.prompt,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Architect agent failed; using the deterministic bootstrap', error);
            return {
                ...planArchitect(prepared),
                source: 'deterministic',
                prompt: prepared.prompt,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run };
}

export { characterName as describeArchitectCharacter };
