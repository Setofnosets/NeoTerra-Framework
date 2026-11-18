/**
 * Neo Terra Newspaper Agent.
 *
 * The agent writes only the prose shell of an edition: masthead, dateline, and
 * 1-6 headlines. Time, date, style, and storage identity always come from the
 * deterministic edition, so an agent cannot move the clock or invent events.
 * On any non-abort failure (disabled, no runner, invalid JSON, timeout) the
 * deterministic edition is returned instead. Abort errors propagate so the
 * caller can abandon a chat that switched.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import {
    NEWSROOM_LEDE_MAX,
    NEWSROOM_MAX_HEADLINES,
    NEWSROOM_TITLE_MAX,
    NEWSPAPER_SECTIONS,
    NEWSPAPER_TONES,
    buildDeterministicEdition,
    deriveNewspaperStyle,
} from '../data/newsroom.js';

export const NEWSPAPER_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['masthead', 'dateline', 'headlines'],
    properties: {
        masthead: { type: 'string', minLength: 1, maxLength: 80 },
        dateline: { type: 'string', minLength: 1, maxLength: 120 },
        headlines: {
            type: 'array',
            minItems: 1,
            maxItems: NEWSROOM_MAX_HEADLINES,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'section'],
                properties: {
                    title: { type: 'string', minLength: 1, maxLength: NEWSROOM_TITLE_MAX },
                    lede: { type: 'string', maxLength: NEWSROOM_LEDE_MAX },
                    section: { type: 'string', enum: NEWSPAPER_SECTIONS.slice() },
                    tone: { type: 'string', enum: NEWSPAPER_TONES.slice() },
                    eventTurn: { type: ['integer', 'null'] },
                    actors: { type: 'array', maxItems: 8, items: { type: 'string' } },
                    locationId: { type: ['string', 'null'] },
                },
            },
        },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block an edition.
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

function factionFacts(state) {
    return Object.values(isObject(state?.factions) ? state.factions : {})
        .filter(isObject)
        .slice(0, 8)
        .map((faction) => ({
            name: faction.name ?? faction.id,
            side: faction.side ?? null,
            influence: faction.influence ?? null,
            status: faction.status ?? null,
        }));
}

function threatFacts(state) {
    return (Array.isArray(state?.threats) ? state.threats : [])
        .filter(isObject)
        .slice(0, 6)
        .map((threat) => ({
            name: threat.name ?? threat.id,
            rank: threat.rank ?? null,
            status: threat.status ?? null,
            progress: threat.progress ?? null,
            stage: threat.stage ?? null,
        }));
}

/** Build the agent prompt from events plus the current world facts. */
export function buildNewspaperPrompt({
    state = null,
    season = null,
    settings = {},
    events = [],
} = {}) {
    const style = deriveNewspaperStyle({ state, season, settings });
    const tone = season?.toneNotes ?? '';
    const sections = [
        `Write the front page of an in-world Neo Terra newspaper in the "${style}" style.`,
        'Return JSON only: masthead, dateline, and 1-6 headlines.',
        `Title <= ${NEWSROOM_TITLE_MAX} characters; lede <= ${NEWSROOM_LEDE_MAX} characters.`,
        'Every headline must be grounded in the supplied events and world facts. Do not invent ids, names, numbers, or outcomes.',
        'Group the headlines by section and keep the most consequential story first.',
        '',
        '## World',
        JSON.stringify({
            season: season?.title ?? state?.seasonId ?? 'Neo Terra',
            style,
            tone,
            date: state?.meta?.inGameDate ?? null,
            timeOfDay: state?.meta?.timeOfDay ?? null,
            act: state?.arc ?? null,
        }),
        '',
        '## Factions',
        JSON.stringify(factionFacts(state)),
        '',
        '## Threats',
        JSON.stringify(threatFacts(state)),
        '',
        '## Events',
        JSON.stringify((Array.isArray(events) ? events : []).slice(0, 20)),
        '',
        '## Response shape',
        JSON.stringify(NEWSPAPER_SCHEMA),
    ];
    return applyContentGateToPrompt(
        sections.join('\n'),
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        {},
    );
}

/** Deterministic fallback for a request without agent output. */
export function buildNewspaperFallback({ state, season = null, settings = {}, request = {} } = {}) {
    if (isObject(request.fallback)) {
        return request.fallback;
    }
    return buildDeterministicEdition({
        state,
        season,
        settings,
        source: 'deterministic',
    });
}

/**
 * Create the newspaper agent. `plan` accepts the `propose` test seam; `run`
 * uses the shared runner and never writes state.
 */
export function createNewspaperAgent({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    function plan(request = {}) {
        const settings = settingsFor(request);
        const prompt = buildNewspaperPrompt({
            state: request.state,
            season: request.season ?? null,
            settings,
            events: request.events,
        });
        if (typeof request.propose !== 'function') {
            return {
                edition: buildNewspaperFallback({ ...request, settings }),
                prompt,
                calls: 0,
                source: 'deterministic',
            };
        }
        const value = responseValue(request.propose({ prompt, schema: NEWSPAPER_SCHEMA }));
        return { edition: value, prompt, calls: 1, source: 'agent' };
    }

    async function run(request = {}) {
        const settings = settingsFor(request);
        const prompt = buildNewspaperPrompt({
            state: request.state,
            season: request.season ?? null,
            settings,
            events: request.events,
        });
        const fallback = buildNewspaperFallback({ ...request, settings });
        if (settings?.agents?.newspaper?.enabled === false
            || typeof runner?.runAgent !== 'function') {
            return {
                ok: false,
                reason: 'disabled',
                edition: fallback,
                source: 'deterministic',
                prompt,
                calls: 0,
            };
        }
        try {
            const response = await runner.runAgent({
                agentId: 'newspaper',
                prompt,
                schema: NEWSPAPER_SCHEMA,
                signal: request.signal,
            });
            const value = responseValue(response);
            return {
                ok: true,
                edition: value,
                source: 'agent',
                prompt,
                calls: 1,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Newspaper agent failed; using the deterministic edition', error);
            return {
                ok: false,
                reason: 'failed',
                edition: fallback,
                source: 'deterministic',
                prompt,
                calls: 1,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildNewspaperPrompt };
}
