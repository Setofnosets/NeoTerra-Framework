/**
 * Canon Beat Ledger helpers.
 *
 * A beat describes the *function* of a canon milestone, not a fixed script.
 * The story tracker may resolve it, adapt it to substituted actors or places,
 * short-circuit it when its premise became impossible, or defer it. All
 * functions here are pure so they can be reused by the reducer, the storyline
 * agent, and tests.
 */

export const BEAT_ACTS = Object.freeze(['opening', 'escalation', 'climax', 'resolution']);
export const BEAT_FLEXIBILITIES = Object.freeze(['strict', 'adaptable', 'optional']);
export const BEAT_STATUSES = Object.freeze([
    'open',
    'deferred',
    'resolved',
    'adapted',
    'short-circuited',
    'closed',
]);
export const TERMINAL_BEAT_STATUSES = Object.freeze([
    'resolved',
    'adapted',
    'short-circuited',
    'closed',
]);
export const COMPLETION_TYPES = Object.freeze([
    'event',
    'state',
    'relationship',
    'threat',
    'transformation',
]);
export const PREDICATE_KINDS = Object.freeze([
    'event-tag',
    'character-status',
    'location-control',
    'threat-stage',
    'relationship-affinity',
    'form-active',
    'beat-resolved',
    'flag',
]);

const TRANSITIONS = Object.freeze({
    open: Object.freeze(['deferred', 'resolved', 'adapted', 'short-circuited', 'closed']),
    deferred: Object.freeze(['open', 'resolved', 'adapted', 'short-circuited', 'closed']),
    resolved: Object.freeze([]),
    adapted: Object.freeze([]),
    'short-circuited': Object.freeze([]),
    closed: Object.freeze([]),
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

export function isTerminalBeatStatus(status) {
    return TERMINAL_BEAT_STATUSES.includes(status);
}

/**
 * Beat statuses are monotonic: once a beat is resolved, adapted, or
 * short-circuited it never reopens. Only `deferred` can return to `open`.
 */
export function canTransitionBeat(from, to) {
    if (from === to) {
        return true;
    }
    return Boolean(TRANSITIONS[from]?.includes(to));
}

/** Return `to` when the transition is legal, otherwise throw. */
export function nextBeatStatus(from, to) {
    const current = from ?? 'open';
    if (!BEAT_STATUSES.includes(current)) {
        throw new Error(`Unknown beat status "${current}"`);
    }
    if (!BEAT_STATUSES.includes(to)) {
        throw new Error(`Unknown beat status "${to}"`);
    }
    if (!canTransitionBeat(current, to)) {
        throw new Error(`Illegal beat status transition "${current}" -> "${to}"`);
    }
    return to;
}

export function listBeatsByAct(beats) {
    const byAct = Object.fromEntries(BEAT_ACTS.map((act) => [act, []]));
    for (const beat of beats ?? []) {
        if (isObject(beat) && Object.hasOwn(byAct, beat.act)) {
            byAct[beat.act].push(beat);
        }
    }
    for (const act of BEAT_ACTS) {
        byAct[act].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return byAct;
}

/**
 * Return open or deferred beats, sorted by order, restricted to an act when
 * `act` is provided.
 */
export function getOpenBeats(beats, statuses = {}, act = null) {
    return (beats ?? [])
        .filter((beat) => {
            if (act && beat.act !== act) {
                return false;
            }
            const status = statuses[beat.id]?.status ?? statuses[beat.id] ?? 'open';
            return status === 'open' || status === 'deferred';
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function withinRange(value, range) {
    if (!Array.isArray(range) || range.length !== 2) {
        return true;
    }
    if (typeof value !== 'number') {
        return true;
    }
    return value >= range[0] && value <= range[1];
}

function resolveStatus(statuses, beatId) {
    const entry = statuses?.[beatId];
    return entry && typeof entry === 'object' ? entry.status ?? 'open' : entry ?? 'open';
}

/**
 * Check whether a beat's preconditions are satisfied by the supplied context.
 *
 * @param {object} beat
 * @param {{
 *   turn?: number,
 *   date?: string,
 *   state?: { characters?: object, locations?: object, threats?: Array<object>, flags?: object },
 *   statuses?: Record<string, { status: string } | string>,
 * }} context
 * @returns {boolean}
 */
export function isBeatEligible(beat, context = {}) {
    if (!isObject(beat) || !isObject(beat.conditions)) {
        return false;
    }
    const { conditions } = beat;
    const { turn, date, state, statuses } = context;

    if (conditions.turnRange && !withinRange(turn ?? 0, conditions.turnRange)) {
        return false;
    }
    if (conditions.dateRange) {
        if (!date) {
            return false;
        }
        if (conditions.dateRange.from && date < conditions.dateRange.from) {
            return false;
        }
        if (conditions.dateRange.to && date > conditions.dateRange.to) {
            return false;
        }
    }
    if (conditions.locationIds?.length && state?.scene?.locationId) {
        if (!conditions.locationIds.includes(state.scene.locationId)) {
            return false;
        }
    }
    if (conditions.actorIds?.length && state?.characters) {
        const present = new Set(
            Object.values(state.characters)
                .filter((character) => character?.status === 'active')
                .map((character) => character.charId),
        );
        if (!conditions.actorIds.some((actorId) => present.has(actorId))) {
            return false;
        }
    }
    if (typeof conditions.threatStage === 'number' && Array.isArray(state?.threats)) {
        const maxStage = Math.max(
            0,
            ...state.threats.map((threat) => Number(threat?.stage ?? 0)).filter(Number.isFinite),
        );
        if (maxStage < conditions.threatStage) {
            return false;
        }
    }
    if (conditions.requiresBeats?.length) {
        const satisfied = conditions.requiresBeats.every(
            (beatId) => resolveStatus(statuses, beatId) === 'resolved'
                || resolveStatus(statuses, beatId) === 'adapted',
        );
        if (!satisfied) {
            return false;
        }
    }
    if (conditions.forbidsBeats?.length) {
        const forbidden = conditions.forbidsBeats.some(
            (beatId) => resolveStatus(statuses, beatId) === 'resolved',
        );
        if (forbidden) {
            return false;
        }
    }
    return true;
}

/**
 * Evaluate the declared completion predicates against a world state.
 * Predicates are intentionally conservative: an unknown predicate kind never
 * resolves a beat.
 */
export function isBeatCompleted(beat, state) {
    const predicates = beat?.completion?.predicates;
    if (!Array.isArray(predicates) || predicates.length === 0) {
        return false;
    }
    return predicates.every((predicate) => evaluatePredicate(predicate, state));
}

function evaluatePredicate(predicate, state) {
    if (!isObject(predicate) || !isObject(state)) {
        return false;
    }
    switch (predicate.kind) {
        case 'event-tag':
            return (state.recentEvents ?? []).some((event) =>
                Array.isArray(event?.tags) ? event.tags.includes(predicate.tag) : false,
            );
        case 'character-status': {
            const character = state.characters?.[predicate.characterId];
            return Boolean(character && (predicate.statuses ?? []).includes(character.status));
        }
        case 'location-control': {
            const location = state.locations?.[predicate.locationId];
            return Boolean(location && location.factionId === predicate.factionId);
        }
        case 'threat-stage': {
            const threat = (state.threats ?? []).find((entry) => entry.id === predicate.threatId);
            return Boolean(threat && Number(threat.stage ?? 0) >= Number(predicate.stage ?? 0));
        }
        case 'relationship-affinity':
            return (state.relationships ?? []).some(
                (relationship) =>
                    relationship.a === predicate.a
                    && relationship.b === predicate.b
                    && Number(relationship.affinity ?? 0) >= Number(predicate.minAffinity ?? 0),
            );
        case 'form-active': {
            const character = state.characters?.[predicate.characterId];
            return Boolean(character && character.formId === predicate.formId);
        }
        case 'beat-resolved':
            return state.beats?.[predicate.beatId]?.status === 'resolved'
                || state.beats?.[predicate.beatId]?.status === 'adapted';
        case 'flag':
            return Boolean(state.flags) && state.flags[predicate.flag] === predicate.value;
        default:
            return false;
    }
}

/**
 * Validate one authored beat. Cross-file references are only checked when the
 * corresponding `context` is supplied.
 */
export function validateBeat(beat, seasonId, context = {}) {
    const errors = [];
    if (!isObject(beat)) {
        add(errors, '$', 'beat must be an object');
        return result(errors);
    }

    const path = `beat.${beat.id ?? '?'}`;
    if (typeof beat.id !== 'string' || beat.id.length === 0) {
        add(errors, `${path}.id`, 'must be a non-empty string');
    } else if (seasonId && !beat.id.startsWith(`${seasonId}.`)) {
        add(errors, `${path}.id`, `must start with "${seasonId}."`);
    }
    if (!Number.isInteger(beat.order) || beat.order < 0) {
        add(errors, `${path}.order`, 'must be a non-negative integer');
    }
    for (const field of ['title', 'description', 'deadlineConsequence', 'rewriteHints']) {
        if (typeof beat[field] !== 'string' || beat[field].trim().length === 0) {
            add(errors, `${path}.${field}`, 'must be a non-empty string');
        }
    }
    if (!BEAT_ACTS.includes(beat.act)) {
        add(errors, `${path}.act`, `must be one of ${BEAT_ACTS.join(', ')}`);
    }
    if (!BEAT_FLEXIBILITIES.includes(beat.flexibility)) {
        add(errors, `${path}.flexibility`, `must be one of ${BEAT_FLEXIBILITIES.join(', ')}`);
    }

    if (beat.deadlineTurns !== null && beat.deadlineTurns !== undefined) {
        if (!Number.isInteger(beat.deadlineTurns) || beat.deadlineTurns < 0) {
            add(errors, `${path}.deadlineTurns`, 'must be a non-negative integer or null');
        }
    }
    if (beat.deadlineDate !== null && beat.deadlineDate !== undefined) {
        if (typeof beat.deadlineDate !== 'string' || beat.deadlineDate.length === 0) {
            add(errors, `${path}.deadlineDate`, 'must be a non-empty string or null');
        }
    }
    if (beat.deadlineTurns == null && beat.deadlineDate == null) {
        add(errors, `${path}.deadlineTurns`, 'a soft deadline requires deadlineTurns or deadlineDate');
    }

    if (!isObject(beat.conditions)) {
        add(errors, `${path}.conditions`, 'must be an object');
    } else {
        const conditions = beat.conditions;
        if (conditions.turnRange !== undefined) {
            if (
                !Array.isArray(conditions.turnRange)
                || conditions.turnRange.length !== 2
                || !conditions.turnRange.every((value) => Number.isInteger(value) && value >= 0)
            ) {
                add(errors, `${path}.conditions.turnRange`, 'must be a pair of non-negative integers');
            }
        }
        if (conditions.dateRange !== undefined) {
            if (
                !isObject(conditions.dateRange)
                || typeof conditions.dateRange.from !== 'string'
                || typeof conditions.dateRange.to !== 'string'
            ) {
                add(errors, `${path}.conditions.dateRange`, 'must be { from, to } strings');
            }
        }
        for (const field of ['locationIds', 'actorIds', 'requiresBeats', 'forbidsBeats']) {
            if (conditions[field] !== undefined && !isStringArray(conditions[field])) {
                add(errors, `${path}.conditions.${field}`, 'must be an array of strings');
            }
        }
        if (conditions.threatStage !== undefined && !Number.isInteger(conditions.threatStage)) {
            add(errors, `${path}.conditions.threatStage`, 'must be an integer');
        }
        for (const locationId of conditions.locationIds ?? []) {
            if (context.locationIds && !context.locationIds.has(locationId)) {
                add(errors, `${path}.conditions.locationIds`, `unresolved location "${locationId}"`);
            }
        }
        for (const actorId of conditions.actorIds ?? []) {
            if (context.characterIds && !context.characterIds.has(actorId)) {
                add(errors, `${path}.conditions.actorIds`, `unresolved character "${actorId}"`);
            }
        }
        for (const field of ['requiresBeats', 'forbidsBeats']) {
            for (const beatId of conditions[field] ?? []) {
                if (context.beatIds && !context.beatIds.has(beatId)) {
                    add(errors, `${path}.conditions.${field}`, `unresolved beat "${beatId}"`);
                }
                if (beatId === beat.id) {
                    add(errors, `${path}.conditions.${field}`, 'a beat cannot require or forbid itself');
                }
            }
        }
    }

    if (!isObject(beat.completion)) {
        add(errors, `${path}.completion`, 'must be an object');
    } else {
        if (!COMPLETION_TYPES.includes(beat.completion.type)) {
            add(errors, `${path}.completion.type`, `must be one of ${COMPLETION_TYPES.join(', ')}`);
        }
        if (!Array.isArray(beat.completion.predicates) || beat.completion.predicates.length === 0) {
            add(errors, `${path}.completion.predicates`, 'must declare at least one predicate');
        } else {
            beat.completion.predicates.forEach((predicate, index) => {
                const predicatePath = `${path}.completion.predicates[${index}]`;
                if (!isObject(predicate)) {
                    add(errors, predicatePath, 'must be an object');
                    return;
                }
                if (!PREDICATE_KINDS.includes(predicate.kind)) {
                    add(errors, `${predicatePath}.kind`, 'unknown predicate kind');
                    return;
                }
                if (predicate.characterId && context.characterIds && !context.characterIds.has(predicate.characterId)) {
                    add(errors, `${predicatePath}.characterId`, `unresolved character "${predicate.characterId}"`);
                }
                if (predicate.locationId && context.locationIds && !context.locationIds.has(predicate.locationId)) {
                    add(errors, `${predicatePath}.locationId`, `unresolved location "${predicate.locationId}"`);
                }
                if (predicate.factionId && context.factionIds && !context.factionIds.has(predicate.factionId)) {
                    add(errors, `${predicatePath}.factionId`, `unresolved faction "${predicate.factionId}"`);
                }
                if (predicate.threatId && context.threatIds && !context.threatIds.has(predicate.threatId)) {
                    add(errors, `${predicatePath}.threatId`, `unresolved threat "${predicate.threatId}"`);
                }
                if (predicate.formId && context.characterIds && !context.characterIds.has(predicate.formId)) {
                    add(errors, `${predicatePath}.formId`, `unresolved form "${predicate.formId}"`);
                }
                if (predicate.beatId && context.beatIds && !context.beatIds.has(predicate.beatId)) {
                    add(errors, `${predicatePath}.beatId`, `unresolved beat "${predicate.beatId}"`);
                }
            });
        }
    }

    return result(errors);
}

/**
 * Validate a full beat list: unique ids, one beat per act minimum (unless
 * `allowEmpty`), per-act ordering, and cross-references.
 */
export function validateBeats(beats, { seasonId, ...context } = {}) {
    const errors = [];
    if (!Array.isArray(beats)) {
        add(errors, 'canonBeats', 'must be an array');
        return result(errors);
    }
    if (beats.length === 0) {
        return result(errors);
    }

    const ids = new Set();
    const localContext = { ...context, beatIds: new Set(beats.map((beat) => beat?.id).filter(Boolean)) };

    beats.forEach((beat, index) => {
        const validation = validateBeat(beat, seasonId, localContext);
        for (const error of validation.errors) {
            add(errors, `canonBeats[${index}].${error.path}`, error.message);
        }
        if (typeof beat?.id === 'string') {
            if (ids.has(beat.id)) {
                add(errors, `canonBeats[${index}].id`, `duplicate beat id "${beat.id}"`);
            }
            ids.add(beat.id);
        }
    });

    const byAct = listBeatsByAct(beats);
    for (const act of BEAT_ACTS) {
        if (byAct[act].length === 0) {
            add(errors, 'canonBeats', `season must declare at least one "${act}" beat`);
        }
    }

    const seenOrders = new Set();
    for (const beat of beats) {
        if (!Number.isInteger(beat?.order)) {
            continue;
        }
        if (seenOrders.has(beat.order)) {
            add(errors, 'canonBeats', `duplicate beat order ${beat.order}`);
        }
        seenOrders.add(beat.order);
    }

    return result(errors);
}

/* ------------------------------------------------------------------ */
/* Ledger helpers used by the Storyline Tracker and the Auditor        */
/* ------------------------------------------------------------------ */

export const BEAT_ACTIONS = Object.freeze([
    'resolve',
    'adapt',
    'defer',
    'short-circuit',
]);

export const DEADLINE_PRESSURE_SETTINGS = Object.freeze(['off', 'generous', 'standard', 'harsh']);

const PRESSURE_THREAT_GAIN = Object.freeze({
    off: 0,
    generous: 5,
    standard: 10,
    harsh: 20,
});

const TERMINAL_CHARACTER_STATUSES = Object.freeze([
    'dead',
    'captured',
    'lost',
    'imprisoned',
    'retired',
    'missing',
]);

function beatList(season) {
    return Array.isArray(season?.canonBeats) ? season.canonBeats.filter(isObject) : [];
}

export function getBeatDefinition(season, beatId) {
    return beatList(season).find((beat) => beat.id === beatId) ?? null;
}

export function getBeatStatus(state, beatId) {
    const record = state?.beats?.[beatId];
    if (record && typeof record === 'object') {
        return record.status ?? 'open';
    }
    return typeof record === 'string' ? record : 'open';
}

export function isBeatTerminal(state, beatId) {
    return isTerminalBeatStatus(getBeatStatus(state, beatId));
}

function deadlineTurnPassed(beat, state) {
    return Number.isInteger(beat?.deadlineTurns)
        && Number.isInteger(state?.meta?.turn)
        && state.meta.turn > beat.deadlineTurns;
}

function deadlineDatePassed(beat, state) {
    return typeof beat?.deadlineDate === 'string'
        && typeof state?.meta?.inGameDate === 'string'
        && state.meta.inGameDate > beat.deadlineDate;
}

/** True once a beat's soft deadline has passed. */
export function isBeatOverdue(beat, state) {
    return deadlineTurnPassed(beat, state) || deadlineDatePassed(beat, state);
}

/** True once the season's final deadline has passed. */
export function isFinalDeadlinePassed(season, state) {
    const deadline = season?.finalDeadline;
    if (!isObject(deadline)) {
        return false;
    }
    const turnPassed = Number.isInteger(deadline.turns)
        && Number.isInteger(state?.meta?.turn)
        && state.meta.turn > deadline.turns;
    const datePassed = typeof deadline.date === 'string'
        && typeof state?.meta?.inGameDate === 'string'
        && state.meta.inGameDate > deadline.date;
    return turnPassed || datePassed;
}

/**
 * Current act from completed beats: the last act that still has an open beat,
 * defaulting to `opening`. Deterministic and monotonic once a later act opens.
 */
export function getCurrentAct(state, season) {
    const beats = beatList(season);
    for (const act of BEAT_ACTS) {
        const hasOpen = beats.some(
            (beat) => beat.act === act && !isBeatTerminal(state, beat.id),
        );
        if (hasOpen) {
            return act;
        }
    }
    return 'resolution';
}

/** The next 1-2 beat titles, used by the map overlay as rumors/headlines. */
export function getUpcomingBeats(state, season, limit = 2) {
    const beats = beatList(season)
        .filter((beat) => !isBeatTerminal(state, beat.id))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return beats.slice(0, Math.max(0, limit));
}

/** Completion predicates already satisfied by the current state. */
export function listSatisfiedBeats(state, season) {
    return beatList(season)
        .filter((beat) => !isBeatTerminal(state, beat.id))
        .filter((beat) => isBeatCompleted(beat, state))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Beats whose canonical actors are all terminal in the state. These are
 * candidates for adaptation or short-circuiting, never silent resolution.
 */
export function listImpossibleBeats(state, season) {
    return beatList(season)
        .filter((beat) => !isBeatTerminal(state, beat.id))
        .filter((beat) => {
            const actorIds = beat.conditions?.actorIds;
            if (!Array.isArray(actorIds) || actorIds.length === 0) {
                return false;
            }
            return actorIds.every((actorId) => {
                const character = state?.characters?.[actorId];
                return character && TERMINAL_CHARACTER_STATUSES.includes(character.status);
            });
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function deadlineThreatGain(pressure = 'standard') {
    return PRESSURE_THREAT_GAIN[pressure] ?? PRESSURE_THREAT_GAIN.standard;
}

/** First active threat, preferring the main threat. */
export function selectPrimaryThreat(state) {
    const threats = Array.isArray(state?.threats) ? state.threats.filter(isObject) : [];
    return threats.find((threat) => threat.rank === 'main' && threat.status === 'active')
        ?? threats.find((threat) => threat.status === 'active')
        ?? threats.find((threat) => threat.rank === 'main')
        ?? null;
}

/** Secondary threat used as a successor when the main threat falls. */
export function selectSuccessorThreat(state) {
    const threats = Array.isArray(state?.threats) ? state.threats.filter(isObject) : [];
    return threats.find((threat) => threat.rank === 'secondary' && threat.status !== 'defeated')
        ?? threats.find((threat) => threat.rank !== 'main' && threat.status !== 'defeated')
        ?? null;
}

/**
 * Deterministic beat/deadline events for one Storyline pass.
 *
 * The function is pure and returns only reducer-shaped events. It never
 * reopens a terminal beat and never escalates the same beat twice: escalation
 * marks the beat `deferred`, which removes it from the open set.
 *
 * @returns {{ events: object[], notes: string[], ending: boolean }}
 */
export function planBeatLifecycleEvents({
    state,
    season,
    pressure = 'standard',
    resolveSatisfied = true,
} = {}) {
    const events = [];
    const notes = [];
    if (!isObject(state) || !isObject(season)) {
        return { events, notes, ending: false };
    }

    // 1. Resolve beats whose declared predicates are already satisfied.
    if (resolveSatisfied) {
        for (const beat of listSatisfiedBeats(state, season)) {
            events.push({
                type: 'RESOLVE_BEAT',
                beatId: beat.id,
                turn: state.meta?.turn ?? 0,
                reason: 'completion predicates satisfied',
            });
            events.push({
                type: 'ADD_EVENT',
                summary: `Canon beat resolved: ${beat.title}`,
                headline: beat.title,
                actors: [],
                locationId: state.scene?.locationId ?? null,
                tags: ['beat', 'beat-resolved', beat.id],
                beatId: beat.id,
            });
            notes.push(`resolved:${beat.id}`);
        }
    }

    // 2. Short-circuit impossible strict beats. Loose beats may still be
    //    adapted by the agent; only strict climax/resolution beats are terminal.
    const handled = new Set(events.filter((event) => event.beatId).map((event) => event.beatId));
    for (const beat of listImpossibleBeats(state, season)) {
        if (handled.has(beat.id) || beat.act === 'opening' || beat.flexibility !== 'strict') {
            continue;
        }
        events.push({
            type: 'SHORT_CIRCUIT_BEAT',
            beatId: beat.id,
            reason: `Canonical actors are unavailable (${beat.conditions.actorIds.join(', ')})`,
        });
        events.push({
            type: 'ADD_EVENT',
            summary: `Canon beat short-circuited: ${beat.title}. ${beat.rewriteHints ?? ''}`.trim(),
            headline: `Divergence: ${beat.title}`,
            actors: [],
            locationId: state.scene?.locationId ?? null,
            tags: ['beat', 'beat-short-circuited', beat.id],
            beatId: beat.id,
        });
        notes.push(`short-circuited:${beat.id}`);
    }

    // 3. A fallen main threat promotes a successor, once per timeline.
    const mainThreats = (state.threats ?? []).filter(
        (threat) => isObject(threat) && threat.rank === 'main',
    );
    const allMainDefeated = mainThreats.length > 0
        && mainThreats.every((threat) => threat.status === 'defeated');
    const successor = selectSuccessorThreat(state);
    if (allMainDefeated && successor && successor.status !== 'defeated') {
        const alreadyPromoted = (state.recentEvents ?? []).some(
            (event) => Array.isArray(event?.tags)
                && event.tags.includes(`successor:${successor.id}`),
        );
        if (!alreadyPromoted) {
            if (successor.status !== 'active') {
                events.push({
                    type: 'SET_THREAT_STATUS',
                    threatId: successor.id,
                    status: 'active',
                });
            }
            events.push({
                type: 'ADD_EVENT',
                summary: `With the main threat defeated, ${successor.name} rises to take its place.`,
                headline: `${successor.name} moves into the vacuum`,
                actors: [],
                locationId: successor.locationId ?? state.scene?.locationId ?? null,
                tags: ['threat', 'successor', `successor:${successor.id}`],
            });
            notes.push(`successor:${successor.id}`);
        }
    }

    // 4. Overdue beats escalate once, then defer. `off` still records the miss
    //    but never advances a threat.
    {
        const primary = selectPrimaryThreat(state);
        const gain = pressure === 'off' ? 0 : deadlineThreatGain(pressure);
        for (const beat of beatList(season)) {
            if (isBeatTerminal(state, beat.id) || getBeatStatus(state, beat.id) === 'deferred') {
                continue;
            }
            if (!isBeatOverdue(beat, state)) {
                continue;
            }
            events.push({
                type: 'DEFER_BEAT',
                beatId: beat.id,
                reason: beat.deadlineConsequence,
                untilTurn: Number.isInteger(beat.deadlineTurns) ? beat.deadlineTurns + 1 : null,
            });
            if (primary && gain > 0) {
                events.push({
                    type: 'ADVANCE_THREAT',
                    threatId: primary.id,
                    amount: gain,
                });
            }
            events.push({
                type: 'ADD_EVENT',
                summary: `Deadline missed for "${beat.title}": ${beat.deadlineConsequence}`,
                headline: `Pressure rises: ${beat.title}`,
                actors: [],
                locationId: state.scene?.locationId ?? null,
                tags: ['beat', 'beat-deadline', beat.id],
                beatId: beat.id,
            });
            notes.push(`overdue:${beat.id}`);
        }
    }

    // 5. Final deadline: the declared failure state wins once.
    let ending = false;
    if (state.ending?.status === 'none' && isFinalDeadlinePassed(season, state)) {
        const mainThreatsNow = (state.threats ?? []).filter(
            (threat) => isObject(threat) && threat.rank === 'main',
        );
        const survived = mainThreatsNow.length > 0
            && mainThreatsNow.every((threat) => threat.status === 'defeated' || threat.status === 'contained');
        if (survived) {
            // Early defeat legally skips the threat's victory path.
            notes.push('final-deadline-averted');
        } else {
            const primary = selectPrimaryThreat(state);
            const victor = primary?.name ?? season?.title ?? 'The main threat';
            const failureState = season?.failureState ?? 'villain-victory';
            const tag = failureState === 'villain-victory' ? 'villain-victory' : 'season-failure';
            if (state.meta?.inCombat === true) {
                events.push({ type: 'COMBAT_END' });
            }
            events.push({
                type: 'ADD_EVENT',
                summary: `${victor} wins. The season's final deadline has passed.`,
                headline: failureState === 'villain-victory'
                    ? `VILLAIN VICTORY: ${victor} takes Neo Terra`
                    : `The season ends in failure: ${victor}`,
                actors: [],
                locationId: state.scene?.locationId ?? null,
                tags: ['ending', 'final-deadline', tag],
            });
            events.push({ type: 'TRIGGER_ENDING', firedTurn: state.meta?.turn ?? 0 });
            ending = true;
            notes.push('final-deadline');
        }
    }

    return { events, notes, ending };
}

/** Compact ledger summary used by tests, the map overlay, and the journal. */
export function summarizeBeatLedger(state, season) {
    const beats = beatList(season);
    const statuses = { open: 0, deferred: 0, resolved: 0, adapted: 0, 'short-circuited': 0, closed: 0 };
    for (const beat of beats) {
        const status = getBeatStatus(state, beat.id);
        statuses[status] = (statuses[status] ?? 0) + 1;
    }
    return {
        act: getCurrentAct(state, season),
        total: beats.length,
        statuses,
        upcoming: getUpcomingBeats(state, season, 2).map((beat) => ({
            id: beat.id,
            title: beat.title,
            act: beat.act,
            status: getBeatStatus(state, beat.id),
        })),
        finalDeadlinePassed: isFinalDeadlinePassed(season, state),
        endingStatus: state?.ending?.status ?? 'none',
    };
}

