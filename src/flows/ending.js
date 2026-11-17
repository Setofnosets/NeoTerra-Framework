/**
 * Villain-victory ending flow.
 *
 * The season fails once when the final deadline passes (or the main threat
 * reaches its terminal stage). The epilogue agent writes prose; the player
 * then chooses Resistance, Join the villain, or End here. Both continuations
 * rewrite the world into a schema-valid post-victory arc through the same beat
 * ledger, threats, factions, locations, and cast.
 */

import {
    DEFAULT_EPILOGUE_PARAGRAPHS,
    buildDeterministicEpilogue,
    selectVictoriousThreat,
} from '../agents/epilogue.js';
import { isFinalDeadlinePassed, isTerminalBeatStatus } from '../data/beats.js';
import { applyEventBatch } from './initiative.js';
import {
    cloneWorldState,
    ENDING_PATHS,
    isJoinVillainPathAvailable,
    isResistancePathAvailable,
} from '../state/world-state.js';

const TERMINAL_THREAT_STAGES = Object.freeze(['active']);

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
        // Logging must never block the ending.
    }
}

function isAbortError(error) {
    return error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED';
}

function playerCharacter(state) {
    if (state?.player?.identity !== 'canon' || typeof state.player.characterId !== 'string') {
        return null;
    }
    return state?.characters?.[state.player.characterId] ?? null;
}

function playerBadEnd(state) {
    const character = playerCharacter(state);
    return character ? state?.badEnds?.[character.charId] ?? null : null;
}

/** Join-villain availability, shared with the reducer. */
export function isJoinVillainAvailable(state) {
    return isJoinVillainPathAvailable(state);
}

/** True while the ending screen owns the next pass (CYOA is suppressed). */
export function isEndingScreenActive(state) {
    return state?.ending?.status === 'epilogue' || state?.ending?.status === 'ended';
}

/**
 * Whether the season should end now: a passed final deadline, or a main threat
 * that has reached its terminal stage while still active.
 */
export function shouldTriggerEnding({ state, season = null } = {}) {
    if (!isObject(state) || state.ending?.status !== 'none') {
        return false;
    }
    if (isFinalDeadlinePassed(season, state)) {
        return true;
    }
    const threats = asArray(state.threats).filter(isObject);
    const mainThreats = threats.filter((threat) => threat.rank === 'main');
    const candidates = mainThreats.length > 0 ? mainThreats : threats;
    return candidates.some((threat) => {
        if (!TERMINAL_THREAT_STAGES.includes(threat.status)) {
            return false;
        }
        const stageMax = Math.max(0, asArray(threat.stages).length - 1);
        return Number(threat.stage ?? 0) >= stageMax && stageMax > 0;
    });
}

/** Pure, state-aware ending choices for the UI and the flow. */
export function listEndingChoices({ state, season = null } = {}) {
    const record = playerBadEnd(state);
    const activeRecord = record && record.reversed !== true ? record : null;
    const resistanceAvailable = isResistancePathAvailable(state);

    return {
        resistance: {
            available: resistanceAvailable,
            path: 'resistance',
            label: 'Resistance',
            description: 'Continue as an underground movement against the victor.',
            reason: resistanceAvailable
                ? null
                : activeRecord
                    ? 'The player cannot resist without a declared reversal.'
                    : 'The player is mind-overwritten and cannot lead a resistance.',
            goals: [
                'Build the resistance',
                'Sabotage the victor\'s regime',
                'Liberate Neo Terra',
            ],
        },
        'join-villain': {
            available: isJoinVillainAvailable(state),
            path: 'join-villain',
            label: 'Join the villain',
            description: 'Serve the victor: defeat the resistance, govern captured districts, or conquer further.',
            reason: isJoinVillainAvailable(state)
                ? null
                : 'Joining requires a villain role, corruption, brainwashing, or coercion.',
            goals: [
                'Serve the victor',
                'Defeat the resistance',
                'Govern captured districts',
                'Conquer neighbouring districts',
            ],
        },
        end: {
            available: true,
            path: 'end',
            label: 'End here',
            description: 'Stop at the epilogue. The world stays viewable and inert.',
            reason: null,
        },
        ending: {
            status: state?.ending?.status ?? 'none',
            path: state?.ending?.path ?? null,
            victor: state?.ending?.victor ?? selectVictoriousThreat(state, season).name,
            playerBadEnd: activeRecord
                ? { type: activeRecord.type, reversibility: activeRecord.reversibility }
                : null,
        },
    };
}

function victorThreat(state, season) {
    return selectVictoriousThreat(state, season);
}

function victorFactionId(state, season, config = {}) {
    if (typeof config.victorFactionId === 'string' && state?.factions?.[config.victorFactionId]) {
        return config.victorFactionId;
    }
    const threat = victorThreat(state, season);
    if (threat.sourceFactionId && state?.factions?.[threat.sourceFactionId]) {
        return threat.sourceFactionId;
    }
    return Object.keys(state?.factions ?? {}).sort()[0] ?? null;
}

function resistanceFactionId(state, season, config = {}) {
    if (typeof config.resistanceFactionId === 'string' && state?.factions?.[config.resistanceFactionId]) {
        return config.resistanceFactionId;
    }
    const existing = Object.values(state?.factions ?? {})
        .filter((faction) => ['hero', 'vigilante', 'neutral'].includes(faction.side))
        .sort((a, b) => Number(b.influence ?? 0) - Number(a.influence ?? 0))[0];
    if (existing) {
        return existing.id;
    }
    return `${season?.id ?? state?.seasonId ?? 'neoterra'}.post.resistance`;
}

function beatOrderOffset(base) {
    return Number.isInteger(base) ? base : 100;
}

/**
 * Post-victory definitions come from `season.postVictory[path]`, with a
 * deterministic fallback so every season and Sandbox can finish safely.
 */
export function getPostVictoryDefinition({ state, season, path } = {}) {
    const id = season?.id ?? state?.seasonId ?? 'neoterra';
    const configured = isObject(season?.postVictory?.[path])
        ? season.postVictory[path]
        : {};
    const victor = victorThreat(state, season);
    const turn = Number.isInteger(state?.meta?.turn) ? state.meta.turn : 0;
    const defaultDeadline = turn + 20;
    const fallbackThreat = path === 'join-villain'
        ? {
            id: `${id}.post.resistance`,
            name: 'The Resistance',
            rank: 'main',
            sourceFactionId: null,
            agenda: 'Overthrow the victor and restore the old order.',
            stages: ['Cells form', 'Sabotage spreads', 'Open uprising'],
            progress: 15,
            locationId: state?.locations?.['old-subway'] ? 'old-subway' : state?.scene?.locationId ?? null,
        }
        : {
            id: `${id}.post.victor`,
            name: `${victor.name} Regime`,
            rank: 'main',
            sourceFactionId: victor.sourceFactionId ?? null,
            agenda: 'Hunt the resistance and make the victory permanent.',
            stages: ['Martial control', 'Purges and informants', 'Total dominion'],
            progress: 60,
            locationId: victor.locationId ?? state?.scene?.locationId ?? null,
        };

    const fallbackBeats = path === 'join-villain'
        ? [
            {
                id: `${id}.post.join.break-resistance`,
                order: beatOrderOffset(turn) + 10,
                title: 'Break a Resistance Cell',
                description: 'Locate and destroy a resistance cell before it can grow.',
                act: 'escalation',
                conditions: {},
                completion: {
                    type: 'event',
                    predicates: [{ kind: 'event-tag', tag: 'post-resistance-cell' }],
                },
                flexibility: 'adaptable',
                deadlineTurns: defaultDeadline,
                deadlineDate: null,
                deadlineConsequence: 'The resistance recruits a named hero and gains influence.',
                rewriteHints: 'Any cell, safehouse, or symbol of resistance counts.',
            },
            {
                id: `${id}.post.join.conquer`,
                order: beatOrderOffset(turn) + 20,
                title: 'Conquer the Next District',
                description: 'Take a neighbouring district and install an occupation government.',
                act: 'resolution',
                conditions: { requiresBeats: [`${id}.post.join.break-resistance`] },
                completion: {
                    type: 'state',
                    predicates: [{
                        kind: 'location-control',
                        locationId: state?.scene?.locationId ?? state?.locations?.['central-plaza']?.id ?? '',
                        factionId: victor.sourceFactionId ?? '',
                    }],
                },
                flexibility: 'adaptable',
                deadlineTurns: defaultDeadline + 20,
                deadlineDate: null,
                deadlineConsequence: 'The resistance holds the district and humiliates the victor.',
                rewriteHints: 'Use an occupied district; the exact target may change.',
            },
        ]
        : [
            {
                id: `${id}.post.resistance.recruit`,
                order: beatOrderOffset(turn) + 10,
                title: 'Recruit the First Cell',
                description: 'Gather survivors, defectors, and heroes into a functioning resistance cell.',
                act: 'escalation',
                conditions: {},
                completion: {
                    type: 'event',
                    predicates: [{ kind: 'event-tag', tag: 'post-resistance-recruit' }],
                },
                flexibility: 'adaptable',
                deadlineTurns: defaultDeadline,
                deadlineDate: null,
                deadlineConsequence: 'The victor captures a prospective ally and the cell shrinks.',
                rewriteHints: 'Any ally, defector, or contact may anchor the cell.',
            },
            {
                id: `${id}.post.resistance.strike`,
                order: beatOrderOffset(turn) + 20,
                title: 'Strike the Victor\'s Seat',
                description: 'Hit the victor\'s headquarters and prove the regime is not invincible.',
                act: 'resolution',
                conditions: { requiresBeats: [`${id}.post.resistance.recruit`] },
                completion: {
                    type: 'event',
                    predicates: [{ kind: 'event-tag', tag: 'post-resistance-strike' }],
                },
                flexibility: 'adaptable',
                deadlineTurns: defaultDeadline + 20,
                deadlineDate: null,
                deadlineConsequence: 'The regime tightens control and the resistance loses its base.',
                rewriteHints: 'The target may be a symbol, a prison, or a supply hub.',
            },
        ];

    return {
        title: typeof configured.title === 'string' && configured.title.trim().length > 0
            ? configured.title.trim()
            : path === 'join-villain'
                ? 'Serve the Victor'
                : 'The Resistance',
        threat: isObject(configured.threat)
            ? { ...fallbackThreat, ...configured.threat }
            : fallbackThreat,
        beats: Array.isArray(configured.beats) && configured.beats.length > 0
            ? configured.beats.map((beat) => ({ ...beat }))
            : fallbackBeats,
        conquest: isObject(configured.conquest)
            ? { ...configured.conquest }
            : path === 'join-villain'
                ? {
                    targets: Object.keys(state?.locations ?? {}).sort().slice(0, 3),
                    goal: 'Conquer the neighbouring districts and city.',
                }
                : null,
        victorFactionId: configured.victorFactionId ?? null,
        resistanceFactionId: configured.resistanceFactionId ?? null,
    };
}

function seedPostVictoryBeat() {
    return {
        status: 'open',
        resolvedTurn: null,
        adaptedFrom: null,
        adaptedTo: null,
        reason: null,
        deferredUntilTurn: null,
    };
}

function ensureFaction(state, faction) {
    if (!state.factions[faction.id]) {
        state.factions[faction.id] = faction;
    }
    return state.factions[faction.id];
}

function rewriteFactionControl(state, { victorId, resistanceId, path, threat }) {
    const victor = state.factions[victorId];
    if (victor) {
        victor.influence = Math.max(Number(victor.influence ?? 0), 90);
        victor.status = 'dominant';
        victor.goals = path === 'join-villain'
            ? ['Hold the city', 'Destroy the resistance', 'Expand the conquest']
            : ['Hunt the resistance', 'Make the victory permanent'];
    }
    const resistance = state.factions[resistanceId];
    if (resistance) {
        resistance.influence = Math.min(Number(resistance.influence ?? 0), 30);
        resistance.status = 'underground';
        resistance.goals = path === 'join-villain'
            ? ['Overthrow the victor', 'Restore the old order']
            : ['Build the resistance', 'Liberate Neo Terra'];
    }

    const targetLocations = new Set([
        threat.locationId,
        state.scene?.locationId,
        state.player?.locationId,
        ...Object.values(state.locations)
            .filter((location) => location.factionId === victorId)
            .map((location) => location.id),
    ].filter((id) => typeof id === 'string' && state.locations[id]));

    for (const locationId of targetLocations) {
        const location = state.locations[locationId];
        if (path === 'join-villain') {
            location.factionId = victorId;
            location.status = 'contested';
            location.notes = `Occupied after ${victor.name ?? 'the victor'}'s victory.`;
        } else if (locationId === state.scene?.locationId) {
            location.factionId = victorId;
            location.status = 'contested';
            location.notes = 'Patrolled by the victor; the resistance meets in secret.';
        }
    }
}

function rewriteCast(state, { path, victorId, resistanceId, threat }) {
    const playerId = state.player?.identity === 'canon' ? state.player.characterId : null;
    const playerGoals = path === 'join-villain'
        ? ['Serve the victor', 'Defeat the resistance', 'Govern captured districts', 'Conquer neighbouring districts']
        : ['Build the resistance', 'Sabotage the victor\'s regime', 'Liberate Neo Terra'];
    const playerAgenda = path === 'join-villain'
        ? 'Secure the victor\'s new order'
        : 'Bring the victor down from the shadows';

    for (const character of Object.values(state.characters)) {
        if (character.charId === playerId) {
            continue;
        }
        if (character.side === 'villain') {
            character.allegiance = path === 'join-villain' ? 'villain' : character.allegiance;
            character.agenda = path === 'join-villain'
                ? `Serve the victor and hunt the resistance`
                : `Enforce the victor's peace`;
        } else if (character.side === 'hero' || character.side === 'vigilante') {
            character.allegiance = path === 'join-villain' ? 'resistance' : character.allegiance;
            character.agenda = path === 'join-villain'
                ? 'Survive the occupation and resist quietly'
                : 'Join or aid the resistance';
            if (path === 'join-villain' && character.status === 'active') {
                character.status = 'offscreen';
            }
        }
    }

    const applyPlayer = (target) => {
        if (!target) {
            return;
        }
        target.goals = playerGoals.slice();
        target.agenda = playerAgenda;
        target.allegiance = path === 'join-villain' ? 'villain' : resistanceId;
        if (path === 'join-villain') {
            target.side = 'villain';
        } else if (target.side === 'villain') {
            target.side = 'hero';
        }
    };
    applyPlayer(state.player);
    if (playerId && state.characters[playerId]) {
        applyPlayer(state.characters[playerId]);
    }
    void victorId;
    void threat;
}

/**
 * Pure rewrite of the world after a continued ending. The caller supplies a
 * state that already has `ending.path` set by CHOOSE_ENDING_PATH.
 */
export function buildPostVictoryState({ state, season = null, path } = {}) {
    if (!isObject(state)) {
        throw new TypeError('buildPostVictoryState requires a WorldState');
    }
    if (path !== 'resistance' && path !== 'join-villain') {
        throw new Error(`Unknown post-victory path "${String(path)}"`);
    }
    const next = cloneWorldState(state);
    const definition = getPostVictoryDefinition({ state: next, season, path });
    const id = season?.id ?? next.seasonId ?? 'neoterra';

    const victorId = victorFactionId(next, season, {
        victorFactionId: definition.victorFactionId,
    });
    let resolvedVictorId = victorId;
    if (!resolvedVictorId) {
        resolvedVictorId = `${id}.post.victor`;
        ensureFaction(next, {
            id: resolvedVictorId,
            name: 'The Victor',
            side: 'villain',
            influence: 90,
            status: 'dominant',
            goals: ['Hold the city'],
            description: 'The establishment created by the season victory.',
            headquartersLocationId: definition.threat.locationId ?? null,
        });
    } else if (!next.factions[resolvedVictorId]) {
        ensureFaction(next, {
            id: resolvedVictorId,
            name: resolvedVictorId,
            side: 'villain',
            influence: 90,
            status: 'dominant',
            goals: ['Hold the city'],
            description: '',
            headquartersLocationId: null,
        });
    }

    let resistanceId = resistanceFactionId(next, season, {
        resistanceFactionId: definition.resistanceFactionId,
    });
    if (!next.factions[resistanceId]) {
        ensureFaction(next, {
            id: resistanceId,
            name: path === 'join-villain' ? 'The Resistance' : 'The Underground',
            side: 'hero',
            influence: 20,
            status: 'underground',
            goals: path === 'join-villain'
                ? ['Overthrow the victor']
                : ['Liberate Neo Terra'],
            description: 'A hidden movement formed after the season victory.',
            headquartersLocationId: null,
        });
    }

    const threat = {
        ...definition.threat,
        id: typeof definition.threat.id === 'string' && definition.threat.id.length > 0
            ? definition.threat.id
            : `${id}.post.threat`,
        sourceFactionId: path === 'join-villain' ? resistanceId : resolvedVictorId,
        progress: Number.isFinite(definition.threat.progress) ? definition.threat.progress : 40,
        stage: 0,
        status: 'active',
        rank: 'main',
        name: typeof definition.threat.name === 'string' && definition.threat.name.length > 0
            ? definition.threat.name
            : path === 'join-villain' ? 'The Resistance' : 'The Victor',
        agenda: typeof definition.threat.agenda === 'string' && definition.threat.agenda.length > 0
            ? definition.threat.agenda
            : 'Consolidate the new order.',
        stages: asArray(definition.threat.stages).length > 1
            ? definition.threat.stages.slice()
            : ['First moves', 'Consolidation', 'Final victory'],
        locationId: definition.threat.locationId
            && next.locations[definition.threat.locationId]
            ? definition.threat.locationId
            : next.scene?.locationId ?? null,
    };

    // Freeze the season ledger, then add the post-victory beats.
    for (const beatState of Object.values(next.beats)) {
        if (!isTerminalBeatStatus(beatState.status)) {
            beatState.status = 'closed';
        }
    }
    next.beats = next.beats ?? {};
    const startedTurn = Number.isInteger(next.meta?.turn) ? next.meta.turn : 0;
    const newBeats = asArray(definition.beats)
        .filter((beat) => isObject(beat) && typeof beat.id === 'string')
        .map((beat) => ({
            ...beat,
            // Authored deadlines are relative offsets; make them relative to the
            // ending turn instead of replaying an already-passed season clock.
            order: startedTurn + (Number.isInteger(beat.order) ? beat.order : 100),
            deadlineTurns: Number.isInteger(beat.deadlineTurns)
                ? startedTurn + beat.deadlineTurns
                : null,
        }));
    for (const beat of newBeats) {
        next.beats[beat.id] = seedPostVictoryBeat();
    }
    next.postVictoryBeats = newBeats.map((beat) => ({ ...beat }));

    // Old threats are resolved; exactly one new post-victory threat remains.
    for (const oldThreat of asArray(next.threats)) {
        if (oldThreat.status === 'active' || oldThreat.status === 'dormant') {
            oldThreat.status = 'contained';
        }
    }
    next.threats = [...asArray(next.threats), threat];

    rewriteFactionControl(next, {
        victorId: resolvedVictorId,
        resistanceId,
        path,
        threat,
    });
    rewriteCast(next, {
        path,
        victorId: resolvedVictorId,
        resistanceId,
        threat,
    });

    const conquest = definition.conquest
        ? {
            ...definition.conquest,
            targets: asArray(definition.conquest.targets)
                .filter((target) => typeof target === 'string' && next.locations[target])
                .slice(0, 8),
            occupation: Object.fromEntries(
                asArray(definition.conquest.targets)
                    .filter((target) => typeof target === 'string' && next.locations[target])
                    .map((target) => [
                        target,
                        next.locations[target].factionId === resolvedVictorId ? 'occupied' : 'target',
                    ]),
            ),
        }
        : null;

    next.arc = 'post-victory';
    next.flags = {
        ...(isObject(next.flags) ? next.flags : {}),
        postVictory: {
            path,
            title: definition.title,
            victorFactionId: resolvedVictorId,
            resistanceFactionId: resistanceId,
            threatId: threat.id,
            beats: newBeats.map((beat) => beat.id),
            conquest,
            startedTurn: next.meta?.turn ?? 0,
        },
    };
    next.postVictory = next.flags.postVictory;

    return next;
}

/** Create the ending flow. Writes are atomic and the trigger is idempotent. */
export function createEndingFlow({
    store,
    agent = null,
    season = null,
    getSettings = null,
    context = {},
    log = null,
    now = Date.now,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('createEndingFlow requires a WorldState store');
    }
    const worldContext = isObject(context) ? context : {};
    const clock = typeof now === 'function' ? now : Date.now;
    let triggerInFlight = null;

    function settings() {
        return typeof getSettings === 'function' ? getSettings() ?? {} : {};
    }

    function currentState() {
        const state = store.get();
        if (!isObject(state)) {
            throw new Error('No seeded WorldState');
        }
        return state;
    }

    function apply(events, patch = null) {
        const applied = applyEventBatch(store, events, {
            context: worldContext,
            log,
            patch,
        });
        if (!applied.ok) {
            throw new Error(applied.error ?? 'Ending write rejected');
        }
        return applied.state;
    }

    function trigger(request = {}) {
        if (triggerInFlight) {
            return triggerInFlight;
        }
        triggerInFlight = runTrigger(request).finally(() => {
            triggerInFlight = null;
        });
        return triggerInFlight;
    }

    async function runTrigger({ recentProse = '', signal = null, force = false } = {}) {
        const state = currentState();
        const alreadyTriggered = state.ending?.status !== 'none';
        const needsEpilogue = state.ending?.status === 'epilogue'
            && typeof state.ending.epilogueText !== 'string';
        if (alreadyTriggered && !needsEpilogue) {
            return {
                triggered: false,
                alreadyFired: true,
                ending: state.ending,
                state,
            };
        }
        if (!force && !alreadyTriggered && !shouldTriggerEnding({ state, season })) {
            return { triggered: false, alreadyFired: false, reason: 'not-due', state };
        }

        const paragraphs = clamp(
            Number(settings()?.ending?.paragraphs ?? DEFAULT_EPILOGUE_PARAGRAPHS),
            3,
            8,
        );
        let epilogue;
        try {
            epilogue = await agent?.run?.({
                state,
                season,
                recentProse,
                paragraphs,
                settings: settings(),
                signal,
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Epilogue agent failed; using deterministic epilogue', error);
            epilogue = null;
        }
        if (!isObject(epilogue) || typeof epilogue.epilogueText !== 'string'
            || epilogue.epilogueText.trim().length === 0) {
            epilogue = {
                epilogueText: buildDeterministicEpilogue({ state, season, paragraphs }),
                victor: selectVictoriousThreat(state, season).name,
                playerStatus: '',
                castFates: [],
                source: 'deterministic',
            };
        }

        const events = [];
        if (state.meta?.inCombat === true) {
            events.push({ type: 'COMBAT_END' });
        }
        const victor = epilogue.victor || selectVictoriousThreat(state, season).name;
        events.push({
            type: 'ADD_EVENT',
            summary: `Epilogue: ${victor} wins the season. ${String(epilogue.epilogueText).slice(0, 900)}`,
            headline: `The end of the season: ${victor}`,
            actors: state.player?.identity === 'canon' ? [state.player.characterId] : [],
            locationId: state.scene?.locationId ?? null,
            tags: ['ending', 'epilogue', season?.failureState ?? 'villain-victory'],
        });
        events.push({ type: 'TRIGGER_ENDING', firedTurn: state.meta?.turn ?? 0 });

        const applied = applyEventBatch(store, events, {
            context: worldContext,
            log,
            patch: (next) => ({
                ...next,
                ending: {
                    ...next.ending,
                    epilogueText: String(epilogue.epilogueText).slice(0, 9000),
                    victor,
                    playerStatus: epilogue.playerStatus ?? '',
                    castFates: asArray(epilogue.castFates).slice(0, 8),
                    paragraphs: Number.isInteger(epilogue.paragraphs)
                        ? epilogue.paragraphs
                        : paragraphs,
                    source: epilogue.source ?? 'agent',
                    firedAt: clock(),
                },
            }),
        });
        if (!applied.ok) {
            throw new Error(applied.error ?? 'Epilogue write rejected');
        }
        return {
            triggered: true,
            alreadyFired: false,
            ending: applied.state.ending,
            epilogue,
            state: applied.state,
        };
    }

    function choices(state = null) {
        return listEndingChoices({ state: state ?? currentState(), season });
    }

    function choosePath(path) {
        const state = currentState();
        if (state.ending?.status !== 'epilogue') {
            throw new Error('CHOOSE_ENDING_PATH requires an epilogue ending');
        }
        if (!ENDING_PATHS.includes(path)) {
            throw new Error(`Invalid ending path "${String(path)}"`);
        }
        const options = listEndingChoices({ state, season });
        const option = options[path];
        if (option && option.available !== true) {
            throw new Error(`Ending path "${path}" is not available: ${option.reason ?? 'unavailable'}`);
        }

        if (path === 'end') {
            const next = apply([{ type: 'CHOOSE_ENDING_PATH', path }]);
            return { ok: true, path, state: next, arc: next.arc };
        }

        const next = apply(
            [{ type: 'CHOOSE_ENDING_PATH', path }],
            (stateAfterChoice) => buildPostVictoryState({
                state: stateAfterChoice,
                season,
                path,
            }),
        );
        return {
            ok: true,
            path,
            state: next,
            arc: next.arc,
            postVictory: next.flags?.postVictory ?? null,
            beats: asArray(next.postVictoryBeats).map((beat) => beat.id),
        };
    }

    /**
     * Advance the conquest track. Occupation is stored per chat in
     * `flags.postVictory.conquest.occupation`, not in the global map data.
     */
    function setOccupation({ locationId, status = 'occupied' } = {}) {
        const state = currentState();
        const postVictory = state.flags?.postVictory;
        if (!postVictory?.conquest) {
            throw new Error('No post-victory conquest track is active');
        }
        if (!state.locations?.[locationId]) {
            throw new Error(`Unknown location "${String(locationId)}"`);
        }
        if (!['target', 'occupied', 'liberated'].includes(status)) {
            throw new Error(`Unknown occupation status "${String(status)}"`);
        }
        const next = applyEventBatch(store, [], {
            context: worldContext,
            log,
            patch: (current) => {
                const flags = current.flags?.postVictory ?? postVictory;
                const conquest = {
                    ...(isObject(flags.conquest) ? flags.conquest : {}),
                    occupation: {
                        ...(isObject(flags.conquest?.occupation) ? flags.conquest.occupation : {}),
                        [locationId]: status,
                    },
                };
                const locations = {
                    ...current.locations,
                    [locationId]: {
                        ...current.locations[locationId],
                        ...(status === 'occupied'
                            ? { factionId: flags.victorFactionId ?? current.locations[locationId].factionId }
                            : {}),
                    },
                };
                return {
                    ...current,
                    locations,
                    flags: {
                        ...current.flags,
                        postVictory: { ...flags, conquest },
                    },
                };
            },
        });
        if (!next.ok) {
            throw new Error(next.error ?? 'Occupation write rejected');
        }
        return { ok: true, locationId, status, state: next.state };
    }

    function getView() {
        const state = currentState();
        return {
            state,
            choices: choices(state),
            epilogueText: state.ending?.epilogueText ?? '',
            status: state.ending?.status ?? 'none',
        };
    }

    return {
        trigger,
        choosePath,
        choices,
        setOccupation,
        getView,
        getState: () => currentState(),
        getSettings: () => settings(),
        shouldTrigger: () => shouldTriggerEnding({ state: currentState(), season }),
        now: clock,
        season,
    };
}
