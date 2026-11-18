/**
 * Neo Terra Storyline Tracker.
 *
 * The tracker is a pure planner plus a thin runner wrapper. It receives the
 * WorldState and the season's Canon Beat Ledger, and returns reducer-shaped
 * events. Deterministic lifecycle rules (satisfied predicates, impossible
 * beats, soft deadlines, the final deadline) run first; one schema-validated
 * agent pass may then enrich factions, threats, characters, locations, and
 * headlines. The tracker never imports `src/state/**` and never mutates state.
 */

import { AgentAbortedError } from './client.js';
import {
    getBeatDefinition,
    getBeatStatus,
    getCurrentAct,
    getUpcomingBeats,
    isBeatCompleted,
    isBeatTerminal,
    listImpossibleBeats,
    listSatisfiedBeats,
    planBeatLifecycleEvents,
    summarizeBeatLedger,
} from '../data/beats.js';
import { FACTION_STATUSES } from '../data/factions.js';
import { isClockHeld } from '../core/world-clock.js';
import { isLegalTransform } from '../data/forms.js';
import { LOCATION_STATUSES } from '../data/locations.js';

export const STORYLINE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
        'factions',
        'threats',
        'characters',
        'locations',
        'transformations',
        'events',
        'beats',
        'rationale',
    ],
    properties: {
        factions: {
            type: 'array',
            maxItems: 12,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string' },
                    influence: { type: 'number', minimum: 0, maximum: 100 },
                    status: { type: 'string' },
                    goals: {
                        type: 'array',
                        maxItems: 5,
                        items: { type: 'string', maxLength: 180 },
                    },
                },
            },
        },
        threats: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string' },
                    progressDelta: { type: 'number' },
                    stage: { type: 'integer', minimum: 0 },
                    status: { type: 'string' },
                    locationId: { type: 'string' },
                    agenda: { type: 'string', maxLength: 300 },
                },
            },
        },
        characters: {
            type: 'array',
            maxItems: 24,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string' },
                    locationId: { type: 'string' },
                    status: { type: 'string' },
                    agenda: { type: 'string', maxLength: 300 },
                    goals: {
                        type: 'array',
                        maxItems: 5,
                        items: { type: 'string', maxLength: 160 },
                    },
                    allegiance: { type: 'string', maxLength: 80 },
                    mood: { type: 'string', maxLength: 80 },
                },
            },
        },
        locations: {
            type: 'array',
            maxItems: 16,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string' },
                    factionId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    status: { type: 'string' },
                    notes: { type: 'string', maxLength: 300 },
                },
            },
        },
        transformations: {
            type: 'array',
            maxItems: 6,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['characterId', 'formId'],
                properties: {
                    characterId: { type: 'string' },
                    formId: { type: 'string' },
                    reason: { type: 'string', maxLength: 240 },
                },
            },
        },
        events: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['summary'],
                properties: {
                    summary: { type: 'string', maxLength: 500 },
                    headline: { type: 'string', maxLength: 180 },
                    actors: {
                        type: 'array',
                        maxItems: 10,
                        items: { type: 'string' },
                    },
                    locationId: { type: 'string' },
                    tags: {
                        type: 'array',
                        maxItems: 8,
                        items: { type: 'string', maxLength: 60 },
                    },
                    beatId: { type: 'string' },
                },
            },
        },
        beats: {
            type: 'array',
            maxItems: 6,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'action', 'reason'],
                properties: {
                    id: { type: 'string' },
                    action: {
                        type: 'string',
                        enum: ['resolve', 'adapt', 'defer', 'short-circuit'],
                    },
                    adaptedFrom: { type: 'string', maxLength: 200 },
                    adaptedTo: { type: 'string', maxLength: 200 },
                    reason: { type: 'string', maxLength: 400 },
                },
            },
        },
        framing: { type: 'string', maxLength: 800 },
        rationale: { type: 'string', maxLength: 700 },
    },
});

const CHARACTER_STATUSES = Object.freeze([
    'active',
    'offscreen',
    'captured',
    'corrupted',
    'dead',
    'retired',
    'missing',
    'lost',
    'imprisoned',
]);
const THREAT_STATUSES = Object.freeze(['active', 'dormant', 'defeated', 'contained']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
    return asArray(value).filter((item) => typeof item === 'string' && item.length > 0);
}

function characterName(state, characterId) {
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function factionName(state, factionId) {
    return state?.factions?.[factionId]?.name ?? factionId;
}

function isPlayerCharacter(state, characterId) {
    return characterId === state?.player?.characterId
        || state?.characters?.[characterId]?.controlledBy === 'player';
}

/**
 * Completion check that also accepts event-tag predicates satisfied by events
 * returned in the same agent response (the agent journals an event and resolves
 * its beat in one pass).
 */
function isBeatCompletedWithEvents(beat, state, agentEvents = []) {
    if (isBeatCompleted(beat, state)) {
        return true;
    }
    const predicates = beat?.completion?.predicates;
    if (!Array.isArray(predicates) || predicates.length === 0) {
        return false;
    }
    const returnedTags = new Set(
        asArray(agentEvents).flatMap((event) => asStringArray(event?.tags)),
    );
    return predicates.every((predicate) => {
        if (predicate?.kind === 'event-tag') {
            return returnedTags.has(predicate.tag)
                || asArray(state?.recentEvents).some(
                    (event) => Array.isArray(event?.tags) && event.tags.includes(predicate.tag),
                );
        }
        return isBeatCompleted({ ...beat, completion: { predicates: [predicate] } }, state);
    });
}

function rejection(rejected, entityId, reason) {
    rejected.push({ entityId, reason });
}

/**
 * Deterministic prompt for one Storyline pass.
 */
export function buildStorylinePrompt({
    state,
    season,
    pressure = 'standard',
    recentProse = '',
    travel = null,
} = {}) {
    const locationId = state?.scene?.locationId ?? null;
    const location = locationId ? state?.locations?.[locationId] ?? null : null;
    const act = getCurrentAct(state, season);
    const openBeats = (season?.canonBeats ?? [])
        .filter((beat) => !isBeatTerminal(state, beat.id))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const upcoming = getUpcomingBeats(state, season, 2);
    const summary = summarizeBeatLedger(state, season);

    const lines = [];
    lines.push(`# Neo Terra Storyline Tracker — ${season?.title ?? season?.id ?? 'Season'}`);
    lines.push('');
    lines.push('## Now');
    lines.push(`Turn: ${state?.meta?.turn ?? 0}`);
    lines.push(`Date: ${state?.meta?.inGameDate ?? 'unknown'} (${state?.meta?.timeOfDay ?? 'unknown'})`);
    lines.push(`Act: ${act}`);
    lines.push(`Scene: ${location ? `${location.name}${location.district ? `, ${location.district}` : ''}` : 'unknown'} (${String(locationId)})`);
    lines.push(`Combat: ${state?.meta?.inCombat === true ? 'yes' : 'no'}`);
    lines.push(`Deadline pressure: ${pressure}`);
    lines.push(`Player role: ${state?.playerRole ?? 'neutral'}`);
    lines.push('');
    if (travel && typeof travel === 'object') {
        const route = Array.isArray(travel.path) ? travel.path.filter((id) => typeof id === 'string') : [];
        const bridges = Array.isArray(travel.bridges) ? travel.bridges.filter((id) => typeof id === 'string') : [];
        lines.push('## Travel');
        lines.push(`From: ${travel.from ?? 'unknown'} -> To: ${travel.to ?? 'unknown'}`);
        lines.push(`Route: ${route.length > 0 ? route.join(' -> ') : '(unknown)'}`);
        lines.push(`Bridges: ${bridges.length > 0 ? bridges.join(', ') : '(none)'}`);
        if (travel.ability) {
            lines.push(`Bypass ability: ${travel.ability}`);
        }
        if (Number.isFinite(travel.turns)) {
            lines.push(`Turns spent: ${travel.turns}`);
        }
        lines.push('A travel event just happened. React to the arrival: ambushes, blockades, faction response, or a quiet arrival are all valid.');
        lines.push('');
    }

    lines.push('## Factions');
    for (const faction of Object.values(state?.factions ?? {}).filter(isObject)) {
        lines.push(`${faction.id} — ${faction.name} — ${faction.side} — influence ${faction.influence} — ${faction.status}`);
    }
    lines.push('');

    lines.push('## Threats');
    for (const threat of asArray(state?.threats).filter(isObject)) {
        lines.push(`${threat.id} — ${threat.name} — ${threat.rank} — stage ${threat.stage} (${threat.progress}%) — ${threat.status}`);
    }
    lines.push('');

    lines.push('## Open canon beats');
    if (openBeats.length === 0) {
        lines.push('(none)');
    } else {
        for (const beat of openBeats.slice(0, 10)) {
            lines.push([
                beat.id,
                beat.act,
                beat.flexibility,
                getBeatStatus(state, beat.id),
                beat.title,
                `deadline=${beat.deadlineTurns ?? beat.deadlineDate ?? 'none'}`,
                `consequence=${beat.deadlineConsequence}`,
            ].join(' | '));
            lines.push(`  description: ${beat.description}`);
            lines.push(`  rewriteHints: ${beat.rewriteHints}`);
        }
    }
    if (upcoming.length > 0) {
        lines.push(`Next: ${upcoming.map((beat) => beat.title).join(', ')}`);
    }
    lines.push('');

    lines.push('## Ledger');
    lines.push(JSON.stringify(summary));
    lines.push('');

    lines.push('## Recent prose');
    lines.push(recentProse.length > 0 ? recentProse.slice(0, 4000) : '(none supplied)');
    lines.push('');

    lines.push('## Rules');
    lines.push('Only use ids supplied above.');
    lines.push('Never edit the player-controlled character. The player state tracker owns the player.');
    lines.push('Threat progress only moves forward; never return a negative progressDelta.');
    lines.push('Transformations are legal only through a declared form rule.');
    lines.push('Beats may resolve only when their completion predicates are satisfied.');
    lines.push('Prefer adaptation over short-circuiting unless the beat premise is impossible.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(JSON.stringify(STORYLINE_SCHEMA));

    return lines.join('\n');
}

function validStatus(value, allowed) {
    return typeof value === 'string' && allowed.includes(value);
}

/**
 * Validate raw tracker output into reducer events. Never throws for bad model
 * output: invalid references and illegal moves are recorded as rejections.
 *
 * @param {{
 *   result: object,
 *   state: object,
 *   season: object,
 *   formRules?: object,
 * }} options
 */
export function normalizeStorylineResult({
    result,
    state,
    season,
    formRules = null,
} = {}) {
    const output = isObject(result) ? result : {};
    const events = [];
    const rejected = [];
    const notes = [];
    const beatActions = new Set();

    for (const faction of asArray(output.factions).slice(0, 12)) {
        if (!isObject(faction) || typeof faction.id !== 'string') {
            continue;
        }
        if (!state?.factions?.[faction.id]) {
            rejection(rejected, faction.id, 'unknown-faction');
            continue;
        }
        const influence = Number.isFinite(faction.influence) ? faction.influence : undefined;
        const status = validStatus(faction.status, FACTION_STATUSES) ? faction.status : undefined;
        const goals = asStringArray(faction.goals).slice(0, 5);
        if (influence === undefined && status === undefined && goals.length === 0) {
            rejection(rejected, faction.id, 'no-usable-change');
            continue;
        }
        events.push({
            type: 'SET_FACTION_INFLUENCE',
            factionId: faction.id,
            ...(influence !== undefined ? { influence } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(goals.length > 0 ? { goals } : {}),
        });
        notes.push(`faction:${faction.id}`);
    }

    for (const threat of asArray(output.threats).slice(0, 8)) {
        if (!isObject(threat) || typeof threat.id !== 'string') {
            continue;
        }
        const current = asArray(state?.threats).find((entry) => entry.id === threat.id);
        if (!current) {
            rejection(rejected, threat.id, 'unknown-threat');
            continue;
        }
        if (threat.progressDelta !== undefined) {
            if (!Number.isFinite(threat.progressDelta) || threat.progressDelta < 0) {
                rejection(rejected, threat.id, 'non-monotonic-progress');
            } else if (threat.progressDelta > 0) {
                events.push({
                    type: 'ADVANCE_THREAT',
                    threatId: threat.id,
                    amount: threat.progressDelta,
                });
                notes.push(`threat-progress:${threat.id}`);
            }
        }
        if (threat.stage !== undefined) {
            if (!Number.isInteger(threat.stage) || threat.stage < Number(current.stage ?? 0)) {
                rejection(rejected, threat.id, 'non-monotonic-stage');
            } else if (threat.stage > Number(current.stage ?? 0)) {
                events.push({
                    type: 'ADVANCE_THREAT',
                    threatId: threat.id,
                    stage: threat.stage,
                });
                notes.push(`threat-stage:${threat.id}`);
            }
        }
        if (threat.status !== undefined) {
            if (!THREAT_STATUSES.includes(threat.status)) {
                rejection(rejected, threat.id, 'unknown-threat-status');
            } else {
                events.push({
                    type: 'SET_THREAT_STATUS',
                    threatId: threat.id,
                    status: threat.status,
                    ...(typeof threat.locationId === 'string' ? { locationId: threat.locationId } : {}),
                });
            }
        }
    }

    for (const character of asArray(output.characters).slice(0, 24)) {
        if (!isObject(character) || typeof character.id !== 'string') {
            continue;
        }
        if (isPlayerCharacter(state, character.id)) {
            rejection(rejected, character.id, 'player-controlled');
            continue;
        }
        if (!state?.characters?.[character.id]) {
            rejection(rejected, character.id, 'unknown-character');
            continue;
        }
        if (typeof character.locationId === 'string') {
            if (!state.locations?.[character.locationId]) {
                rejection(rejected, character.id, 'unknown-location');
            } else {
                events.push({
                    type: 'MOVE_CHARACTER',
                    characterId: character.id,
                    locationId: character.locationId,
                });
            }
        }
        if (character.status !== undefined) {
            if (!CHARACTER_STATUSES.includes(character.status)) {
                rejection(rejected, character.id, 'unknown-character-status');
            } else {
                events.push({
                    type: 'SET_STATUS',
                    characterId: character.id,
                    status: character.status,
                });
            }
        }
        const goals = asStringArray(character.goals).slice(0, 5);
        if (typeof character.agenda === 'string'
            || typeof character.allegiance === 'string'
            || typeof character.mood === 'string'
            || goals.length > 0) {
            events.push({
                type: 'SET_CHARACTER_FIELDS',
                characterId: character.id,
                ...(typeof character.agenda === 'string' ? { agenda: character.agenda } : {}),
                ...(goals.length > 0 ? { goals } : {}),
                ...(typeof character.allegiance === 'string' ? { allegiance: character.allegiance } : {}),
                ...(typeof character.mood === 'string' ? { mood: character.mood } : {}),
            });
        }
    }

    for (const location of asArray(output.locations).slice(0, 16)) {
        if (!isObject(location) || typeof location.id !== 'string') {
            continue;
        }
        if (!state?.locations?.[location.id]) {
            rejection(rejected, location.id, 'unknown-location');
            continue;
        }
        if (location.factionId !== undefined && location.factionId !== null
            && !state.factions?.[location.factionId]) {
            rejection(rejected, location.id, 'unknown-faction');
            continue;
        }
        if (location.status !== undefined && !LOCATION_STATUSES.includes(location.status)) {
            rejection(rejected, location.id, 'unknown-location-status');
            continue;
        }
        events.push({
            type: 'SET_LOCATION_STATUS',
            locationId: location.id,
            ...(location.status !== undefined ? { status: location.status } : {}),
            ...(location.factionId !== undefined ? { factionId: location.factionId } : {}),
            ...(typeof location.notes === 'string' ? { notes: location.notes } : {}),
        });
    }

    for (const transformation of asArray(output.transformations).slice(0, 6)) {
        if (!isObject(transformation)
            || typeof transformation.characterId !== 'string'
            || typeof transformation.formId !== 'string') {
            continue;
        }
        const character = state?.characters?.[transformation.characterId];
        if (!character) {
            rejection(rejected, transformation.characterId, 'unknown-character');
            continue;
        }
        if (isPlayerCharacter(state, transformation.characterId)) {
            rejection(rejected, transformation.characterId, 'player-controlled');
            continue;
        }
        if (character.formId === transformation.formId) {
            rejection(rejected, transformation.characterId, 'already-active');
            continue;
        }
        if (!formRules || !isLegalTransform(formRules, character.formId, transformation.formId)) {
            rejection(rejected, transformation.characterId, 'undeclared-form-rule');
            continue;
        }
        events.push({
            type: 'TRANSFORM',
            characterId: transformation.characterId,
            formId: transformation.formId,
        });
        notes.push(`transform:${transformation.characterId}`);
    }

    for (const event of asArray(output.events).slice(0, 8)) {
        if (!isObject(event) || typeof event.summary !== 'string'
            || event.summary.trim().length === 0) {
            continue;
        }
        const actors = asStringArray(event.actors);
        const unknownActor = actors.find((actorId) => !state?.characters?.[actorId]);
        if (unknownActor) {
            rejection(rejected, unknownActor, 'unknown-event-actor');
            continue;
        }
        if (typeof event.locationId === 'string' && !state?.locations?.[event.locationId]) {
            rejection(rejected, event.locationId, 'unknown-event-location');
            continue;
        }
        if (typeof event.beatId === 'string' && !getBeatDefinition(season, event.beatId)) {
            rejection(rejected, event.beatId, 'unknown-event-beat');
            continue;
        }
        events.push({
            type: 'ADD_EVENT',
            summary: event.summary.trim().slice(0, 500),
            ...(typeof event.headline === 'string' && event.headline.trim().length > 0
                ? { headline: event.headline.trim().slice(0, 180) }
                : {}),
            actors,
            locationId: typeof event.locationId === 'string'
                ? event.locationId
                : state?.scene?.locationId ?? null,
            tags: asStringArray(event.tags).slice(0, 8),
            ...(typeof event.beatId === 'string' ? { beatId: event.beatId } : {}),
        });
    }

    for (const action of asArray(output.beats).slice(0, 6)) {
        if (!isObject(action) || typeof action.id !== 'string') {
            continue;
        }
        const beat = getBeatDefinition(season, action.id);
        if (!beat) {
            rejection(rejected, action.id, 'unknown-beat');
            continue;
        }
        if (beatActions.has(action.id) || isBeatTerminal(state, action.id)) {
            rejection(rejected, action.id, 'beat-already-terminal');
            continue;
        }
        if (!['resolve', 'adapt', 'defer', 'short-circuit'].includes(action.action)) {
            rejection(rejected, action.id, 'unknown-beat-action');
            continue;
        }
        if (action.action === 'resolve') {
            if (!isBeatCompletedWithEvents(beat, state, output.events)) {
                rejection(rejected, action.id, 'predicates-not-satisfied');
                continue;
            }
            events.push({
                type: 'RESOLVE_BEAT',
                beatId: action.id,
                reason: typeof action.reason === 'string' ? action.reason : 'resolved by tracker',
            });
        } else if (action.action === 'adapt') {
            if (typeof action.adaptedFrom !== 'string' || action.adaptedFrom.trim().length === 0
                || typeof action.adaptedTo !== 'string' || action.adaptedTo.trim().length === 0) {
                rejection(rejected, action.id, 'adapt-requires-from-and-to');
                continue;
            }
            events.push({
                type: 'ADAPT_BEAT',
                beatId: action.id,
                adaptedFrom: action.adaptedFrom,
                adaptedTo: action.adaptedTo,
                reason: typeof action.reason === 'string' ? action.reason : '',
            });
        } else if (action.action === 'defer') {
            if (typeof action.reason !== 'string' || action.reason.trim().length === 0) {
                rejection(rejected, action.id, 'defer-requires-reason');
                continue;
            }
            events.push({
                type: 'DEFER_BEAT',
                beatId: action.id,
                reason: action.reason,
            });
        } else {
            if (typeof action.reason !== 'string' || action.reason.trim().length === 0) {
                rejection(rejected, action.id, 'short-circuit-requires-reason');
                continue;
            }
            events.push({
                type: 'SHORT_CIRCUIT_BEAT',
                beatId: action.id,
                reason: action.reason,
            });
        }
        beatActions.add(action.id);
        notes.push(`beat:${action.action}:${action.id}`);
    }

    if (typeof output.framing === 'string'
        && output.framing.trim().length > 0
        && output.framing.trim() !== state?.scene?.framing) {
        events.push({ type: 'SET_SCENE_FRAMING', framing: output.framing.trim() });
    }

    return {
        events,
        rejected,
        notes,
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 700) : '',
        beatActions: [...beatActions],
    };
}

function dedupeEvents(events) {
    const seen = new Set();
    const result = [];
    for (const event of events) {
        if (!isObject(event) || typeof event.type !== 'string') {
            continue;
        }
        const key = JSON.stringify(event);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(event);
    }
    return result;
}

/**
 * Deterministic lifecycle events for one pass. Exposed for tests and the
 * initiative flow; it is always safe to apply on its own.
 */
export function planDeterministicStoryline({
    state,
    season,
    pressure = 'standard',
    resolveSatisfied = true,
} = {}) {
    const plan = planBeatLifecycleEvents({
        state,
        season,
        pressure,
        resolveSatisfied,
        held: isClockHeld(state),
    });
    return {
        events: dedupeEvents(plan.events),
        notes: plan.notes,
        ending: plan.ending,
        act: getCurrentAct(state, season),
        upcoming: getUpcomingBeats(state, season, 2),
        impossible: listImpossibleBeats(state, season).map((beat) => beat.id),
        satisfied: listSatisfiedBeats(state, season).map((beat) => beat.id),
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
        // Logging must never break a pass.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/**
 * Thin runner wrapper.
 */
export function createStorylineTracker({
    runner = null,
    getSettings = null,
    log = null,
} = {}) {
    function prepare(request = {}) {
        const state = request.state ?? null;
        const season = request.season ?? null;
        const pressure = request.pressure
            ?? (request.settings?.beatDeadlinePressure)
            ?? 'standard';
        return {
            state,
            season,
            formRules: request.formRules ?? null,
            pressure,
            recentProse: request.recentProse ?? '',
            travel: request.travel ?? null,
            prompt: buildStorylinePrompt({
                state,
                season,
                pressure,
                recentProse: request.recentProse ?? '',
                travel: request.travel ?? null,
            }),
        };
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        const deterministic = planDeterministicStoryline(prepared);
        if (typeof request.propose !== 'function') {
            return {
                ...deterministic,
                source: 'deterministic',
                prompt: prepared.prompt,
                rejected: [],
                rationale: '',
            };
        }
        const normalized = normalizeStorylineResult({
            result: request.propose({
                prompt: prepared.prompt,
                schema: STORYLINE_SCHEMA,
            }),
            state: prepared.state,
            season: prepared.season,
            formRules: prepared.formRules,
        });
        return {
            ...deterministic,
            events: dedupeEvents([...deterministic.events, ...normalized.events]),
            rejected: normalized.rejected,
            notes: [...deterministic.notes, ...normalized.notes],
            rationale: normalized.rationale,
            source: 'agent',
            prompt: prepared.prompt,
        };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        const settings = (typeof getSettings === 'function' ? getSettings() : request.settings) ?? {};
        const enabled = settings?.agents?.storyline?.enabled !== false;
        const deterministic = planDeterministicStoryline(prepared);

        if (!enabled || typeof runner?.runAgent !== 'function') {
            return {
                ...deterministic,
                source: 'deterministic',
                prompt: prepared.prompt,
                rejected: [],
                rationale: '',
            };
        }

        try {
            const response = await runner.runAgent({
                agentId: 'storyline',
                prompt: prepared.prompt,
                schema: STORYLINE_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            const normalized = normalizeStorylineResult({
                result,
                state: prepared.state,
                season: prepared.season,
                formRules: prepared.formRules,
            });
            return {
                ...deterministic,
                events: dedupeEvents([...deterministic.events, ...normalized.events]),
                rejected: normalized.rejected,
                notes: [...deterministic.notes, ...normalized.notes],
                rationale: normalized.rationale,
                source: 'agent',
                prompt: prepared.prompt,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Storyline tracker failed; keeping the deterministic lifecycle', error);
            return {
                ...deterministic,
                source: 'deterministic',
                prompt: prepared.prompt,
                rejected: [],
                rationale: '',
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildStorylinePrompt };
}

export {
    characterName as describeStorylineCharacter,
    factionName as describeStorylineFaction,
};
