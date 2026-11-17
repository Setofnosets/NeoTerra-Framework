/**
 * Neo Terra Epilogue Agent.
 *
 * The epilogue is a one-shot, prose-only summary of the season's failure state.
 * It is grounded in WorldState: the victor, how they won, the fates of the
 * cast, faction/location control, and the player's status. The agent never
 * writes state; the ending flow stores the returned text exactly once.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import { renderPromptTemplate } from './prompts.js';

export const DEFAULT_EPILOGUE_PARAGRAPHS = 5;
export const MIN_EPILOGUE_PARAGRAPHS = 3;
export const MAX_EPILOGUE_PARAGRAPHS = 8;

export const EPILOGUE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['epilogueText', 'victor', 'playerStatus', 'castFates'],
    properties: {
        epilogueText: { type: 'string', minLength: 80, maxLength: 9000 },
        victor: { type: 'string', maxLength: 200 },
        playerStatus: { type: 'string', maxLength: 400 },
        castFates: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['characterId', 'fate'],
                properties: {
                    characterId: { type: 'string', maxLength: 160 },
                    fate: { type: 'string', maxLength: 400 },
                },
            },
        },
        factionControl: { type: 'string', maxLength: 600 },
        cityState: { type: 'string', maxLength: 600 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clampParagraphs(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return DEFAULT_EPILOGUE_PARAGRAPHS;
    }
    return Math.min(
        MAX_EPILOGUE_PARAGRAPHS,
        Math.max(MIN_EPILOGUE_PARAGRAPHS, Math.round(number)),
    );
}

function characterName(state, characterId) {
    return state?.characters?.[characterId]?.displayName
        ?? state?.characters?.[characterId]?.charId
        ?? characterId;
}

function playerName(state) {
    if (state?.player?.identity === 'canon' && state.player.characterId) {
        return characterName(state, state.player.characterId);
    }
    return state?.player?.displayName ?? 'The Player';
}

function mainThreats(state) {
    const threats = asArray(state?.threats).filter(isObject);
    const main = threats.filter((threat) => threat.rank === 'main');
    return main.length > 0 ? main : threats;
}

export function selectVictoriousThreat(state, season = null) {
    const threats = mainThreats(state);
    return threats.find((threat) => threat.status === 'active')
        ?? threats[0]
        ?? {
            id: null,
            name: season?.failureState === 'villain-victory'
                ? 'The main threat'
                : season?.title ?? 'The season',
            agenda: '',
        };
}

function locationName(state, locationId) {
    if (!locationId) {
        return 'the city';
    }
    return state?.locations?.[locationId]?.name ?? locationId;
}

function factionName(state, factionId) {
    if (!factionId) {
        return null;
    }
    return state?.factions?.[factionId]?.name ?? factionId;
}

function playerStatusLine(state) {
    const player = state?.player ?? {};
    const character = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    const status = character?.status ?? player.status ?? 'active';
    const corruption = Number(player?.corruption?.stage ?? 0);
    const pieces = [`Status: ${status}`];
    if (corruption > 0) {
        pieces.push(`corruption stage ${corruption}`);
    }
    if (state?.flags?.brainwashed === true || state?.flags?.identityLoss === true) {
        pieces.push('mind overwritten');
    }
    if (state?.playerRole === 'villain') {
        pieces.push('villain-POV');
    }
    return pieces.join('; ');
}

/** Two or more cast fates, chosen deterministically from the roster. */
export function selectCastFates(state, { limit = 4 } = {}) {
    const characters = Object.values(isObject(state?.characters) ? state.characters : {})
        .filter((character) => isObject(character))
        .filter((character) => character.controlledBy !== 'player')
        .sort((a, b) => String(a.displayName ?? a.charId).localeCompare(String(b.displayName ?? b.charId)));

    const preferred = characters
        .filter((character) => ['captured', 'corrupted', 'dead', 'lost', 'imprisoned', 'retired', 'missing'].includes(character.status))
        .concat(characters)
        .filter((character, index, list) => list.indexOf(character) === index)
        .slice(0, Math.max(2, limit));

    return preferred.map((character) => ({
        characterId: character.charId,
        fate: `${character.displayName ?? character.charId} is ${character.status ?? 'active'}${character.locationId ? ` at ${locationName(state, character.locationId)}` : ''}.`,
    }));
}

/**
 * Deterministic 3-8 paragraph epilogue. Used when the agent is disabled or
 * fails, so the ending screen always has something grounded to show.
 */
export function buildDeterministicEpilogue({
    state,
    season = null,
    paragraphs = DEFAULT_EPILOGUE_PARAGRAPHS,
} = {}) {
    const count = clampParagraphs(paragraphs);
    const victor = selectVictoriousThreat(state, season);
    const victorFaction = factionName(state, victor.sourceFactionId);
    const location = locationName(state, victor.locationId ?? state?.scene?.locationId);
    const fates = selectCastFates(state, { limit: Math.max(2, count - 3) });
    const player = playerStatusLine(state);
    const name = playerName(state);
    const leadFaction = Object.values(isObject(state?.factions) ? state.factions : {})
        .filter((faction) => Number(faction?.influence ?? 0) >= 50)
        .sort((a, b) => Number(b.influence) - Number(a.influence))[0] ?? null;

    const paragraphsOut = [
        `${victor.name} has won. The season ends with ${victor.name} ascendant${victorFaction ? ` and ${victorFaction} standing openly behind it` : ''}, and ${location} belongs to the victor.`,
        `The victory was not a single blow but an accumulation: deadlines missed, allies worn down, and every opening spent before it could become a counterattack. ${victor.agenda ? victor.agenda : 'The city bent toward the victor before anyone agreed to kneel.'}`,
        fates.length >= 2
            ? fates.map((fate) => fate.fate).join(' ')
            : 'The cast is scattered, and the survivors are still counting what they lost.',
        `${leadFaction ? `${leadFaction.name} sets the tone of the new order. ` : ''}Faction control has hardened around the victor, and the places that once offered shelter are now checkpoints, offices, or memorials.`,
        `${name} survives the ending with ${player}. The story does not decide what happens next; the next choice does.`,
    ];

    while (paragraphsOut.length < count) {
        paragraphsOut.push(`Beyond the immediate surrender, the city waits to see whether the new order can be endured, resisted, or joined.`);
    }
    while (paragraphsOut.length > count) {
        const merged = paragraphsOut.splice(paragraphsOut.length - 2, 2).join(' ');
        paragraphsOut.push(merged);
    }
    return paragraphsOut.join('\n\n');
}

export function buildEpiloguePrompt({
    state,
    season = null,
    settings = {},
    paragraphs = DEFAULT_EPILOGUE_PARAGRAPHS,
} = {}) {
    const count = clampParagraphs(paragraphs);
    const victor = selectVictoriousThreat(state, season);
    const fates = selectCastFates(state, { limit: 6 });
    const player = {
        name: playerName(state),
        identity: state?.player?.identity ?? 'custom',
        status: playerStatusLine(state),
        role: state?.playerRole ?? 'neutral',
        corruption: state?.player?.corruption ?? null,
        badEnd: state?.player?.characterId
            ? state?.badEnds?.[state.player.characterId] ?? null
            : null,
    };
    const factions = Object.values(isObject(state?.factions) ? state.factions : {})
        .filter(isObject)
        .map((faction) => ({
            id: faction.id,
            name: faction.name,
            influence: faction.influence,
            status: faction.status,
        }));
    const template = typeof settings?.ending?.prompt === 'string'
        && settings.ending.prompt.trim().length > 0
        ? settings.ending.prompt
        : `Write the final epilogue for {{season}} after a complete villain victory. Write exactly {{paragraphs}} paragraphs. Ground every detail in the supplied state. Name the victor, how they won, at least two cast fates, faction/location control, and the player's status. Do not decide the player's next choice. Return JSON only.`;

    const rendered = renderPromptTemplate(template, {
        season: season?.title ?? state?.seasonId ?? 'Neo Terra',
        paragraphs: String(count),
    });

    const sections = [
        '',
        '## Victor',
        JSON.stringify(victor),
        '',
        '## Player',
        JSON.stringify(player),
        '',
        '## Cast fates',
        JSON.stringify(fates),
        '',
        '## Factions',
        JSON.stringify(factions),
        '',
        '## Scene',
        JSON.stringify({
            locationId: state?.scene?.locationId ?? null,
            location: locationName(state, state?.scene?.locationId),
            turn: state?.meta?.turn ?? 0,
            date: state?.meta?.inGameDate ?? null,
            inCombat: state?.meta?.inCombat === true,
        }),
        '',
        '## Recent events',
        JSON.stringify(asArray(state?.recentEvents).slice(-10)),
        '',
        '## Rules',
        `Return exactly ${count} paragraphs in epilogueText.`,
        'Name the victor, the player status, and at least two cast fates.',
        'Do not contradict stored statuses, bad ends, or faction control.',
        'Do not choose a continuation path for the player.',
        'Return JSON only. No prose outside the JSON object.',
        '',
        '## Response shape',
        JSON.stringify(EPILOGUE_SCHEMA),
    ];
    return applyContentGateToPrompt(
        `${rendered}\n${sections.join('\n')}`,
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        {},
    );
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block the ending.
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

/** Normalize an agent response, falling back to deterministic prose. */
export function normalizeEpilogueResult({
    result,
    state,
    season = null,
    paragraphs = DEFAULT_EPILOGUE_PARAGRAPHS,
    source = 'agent',
} = {}) {
    const value = isObject(result) ? result : {};
    const text = typeof value.epilogueText === 'string' ? value.epilogueText.trim() : '';
    if (text.length === 0) {
        return {
            epilogueText: buildDeterministicEpilogue({ state, season, paragraphs }),
            victor: selectVictoriousThreat(state, season),
            playerStatus: playerStatusLine(state),
            castFates: selectCastFates(state),
            source: 'deterministic',
            paragraphs: clampParagraphs(paragraphs),
        };
    }
    return {
        epilogueText: text.slice(0, 9000),
        victor: typeof value.victor === 'string' && value.victor.trim().length > 0
            ? value.victor.trim().slice(0, 200)
            : selectVictoriousThreat(state, season).name,
        playerStatus: typeof value.playerStatus === 'string' && value.playerStatus.trim().length > 0
            ? value.playerStatus.trim().slice(0, 400)
            : playerStatusLine(state),
        castFates: asArray(value.castFates)
            .filter((fate) => isObject(fate) && typeof fate.characterId === 'string')
            .slice(0, 8)
            .map((fate) => ({
                characterId: fate.characterId,
                fate: typeof fate.fate === 'string' ? fate.fate.slice(0, 400) : '',
            })),
        factionControl: typeof value.factionControl === 'string'
            ? value.factionControl.slice(0, 600)
            : '',
        cityState: typeof value.cityState === 'string' ? value.cityState.slice(0, 600) : '',
        source,
        paragraphs: clampParagraphs(paragraphs),
    };
}

/**
 * Create the epilogue agent. `plan` uses the `propose` test seam; `run` calls
 * the shared runner once and never writes state.
 */
export function createEpilogueAgent({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    function paragraphSetting(settings, request) {
        return clampParagraphs(
            request?.paragraphs
                ?? settings?.ending?.paragraphs
                ?? settings?.agents?.epilogue?.paragraphs
                ?? DEFAULT_EPILOGUE_PARAGRAPHS,
        );
    }

    function plan(request = {}) {
        const settings = settingsFor(request);
        const paragraphs = paragraphSetting(settings, request);
        const prompt = buildEpiloguePrompt({
            state: request.state,
            season: request.season ?? null,
            settings,
            paragraphs,
        });
        if (typeof request.propose !== 'function') {
            return {
                ...normalizeEpilogueResult({
                    result: null,
                    state: request.state,
                    season: request.season ?? null,
                    paragraphs,
                    source: 'deterministic',
                }),
                prompt,
                calls: 0,
            };
        }
        return {
            ...normalizeEpilogueResult({
                result: request.propose({ prompt, schema: EPILOGUE_SCHEMA }),
                state: request.state,
                season: request.season ?? null,
                paragraphs,
                source: 'agent',
            }),
            prompt,
            calls: 1,
        };
    }

    async function run(request = {}) {
        const settings = settingsFor(request);
        const paragraphs = paragraphSetting(settings, request);
        const prompt = buildEpiloguePrompt({
            state: request.state,
            season: request.season ?? null,
            settings,
            paragraphs,
        });
        if (settings?.agents?.epilogue?.enabled === false
            || typeof runner?.runAgent !== 'function') {
            return {
                ...normalizeEpilogueResult({
                    result: null,
                    state: request.state,
                    season: request.season ?? null,
                    paragraphs,
                    source: 'deterministic',
                }),
                prompt,
                calls: 0,
                enabled: settings?.agents?.epilogue?.enabled !== false,
            };
        }
        try {
            const response = await runner.runAgent({
                agentId: 'epilogue',
                prompt,
                schema: EPILOGUE_SCHEMA,
                signal: request.signal,
            });
            const value = responseValue(response);
            return {
                ...normalizeEpilogueResult({
                    result: value,
                    state: request.state,
                    season: request.season ?? null,
                    paragraphs,
                    source: 'agent',
                }),
                prompt,
                calls: 1,
                enabled: true,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Epilogue agent failed; using deterministic epilogue', error);
            return {
                ...normalizeEpilogueResult({
                    result: null,
                    state: request.state,
                    season: request.season ?? null,
                    paragraphs,
                    source: 'deterministic',
                }),
                prompt,
                calls: 1,
                enabled: true,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildEpiloguePrompt };
}
