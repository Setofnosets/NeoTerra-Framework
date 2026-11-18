/**
 * Off-screen world tick.
 *
 * Deterministic, dependency-free planner plus the flow that commits its events.
 * When in-game time passes, factions move their influence, threats advance, a
 * capped number of off-screen NPCs travel along authored connections, and a few
 * rumors are written as world events. No LLM is involved: every selection is
 * seeded by the world state, so replays produce identical batches.
 */

import { effectiveStoryTurn, isClockHeld, diffDays, slotsPerDay } from '../core/world-clock.js';
import {
    DEFAULT_AGENDAS,
    formatTemplate,
    loadAgendas,
    pickDeterministic,
    resolveAgenda,
} from '../data/agendas.js';
import { loadLocations } from '../data/locations.js';
import { applyEventBatch } from './initiative.js';

const TERMINAL_CHARACTER_STATUSES = Object.freeze([
    'dead',
    'retired',
    'missing',
    'lost',
    'captured',
    'imprisoned',
    'corrupted',
]);

const MAX_PENDING_RUMORS = 10;

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
        // Logging must never break a tick.
    }
}

function compareIds(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** Round to one decimal without float noise; never returns NaN. */
function round1(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const rounded = Math.round(value * 10) / 10;
    return rounded === 0 ? 0 : rounded;
}

function integerOr(value, fallback, { min = 0 } = {}) {
    return Number.isInteger(value) && value >= min ? value : fallback;
}

function numberOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function emptySummary(overrides = {}) {
    return {
        elapsedDays: 0,
        appliedDays: 0,
        suppressedDays: 0,
        factions: 0,
        threats: 0,
        moves: 0,
        rumors: 0,
        ...overrides,
    };
}

function guarded(reason, worldTick = null) {
    return {
        ok: false,
        reason,
        initialized: false,
        events: [],
        worldTick,
        summary: null,
    };
}

/** Authored locations as an id -> record map, tolerant of an index shape. */
function buildAuthoredLocationMap(locations) {
    const map = new Map();
    if (Array.isArray(locations?.locations)) {
        for (const location of locations.locations) {
            if (isObject(location) && typeof location.id === 'string') {
                map.set(location.id, location);
            }
        }
    } else if (isObject(locations?.byId)) {
        for (const [id, location] of Object.entries(locations.byId)) {
            if (isObject(location)) {
                map.set(id, location);
            }
        }
    }
    return map;
}

function resolvedLocationId(state, candidate) {
    return typeof candidate === 'string' && isObject(state.locations?.[candidate])
        ? candidate
        : null;
}

/**
 * Pure planner. Returns the reducer events and the next `flags.worldTick`
 * object; the caller writes both in one atomic batch.
 *
 * @param {{
 *   state: object|null,
 *   season?: object|null,
 *   agenda?: object|null,
 *   locations?: object|null,
 *   settings?: object|null,
 *   turn?: number|null,
 * }} options
 */
export function planWorldTick({
    state,
    season = null,
    agenda = null,
    locations = null,
    settings = null,
    turn = null,
} = {}) {
    if (!isObject(state)) {
        return guarded('no-state');
    }
    const settingsSource = isObject(settings) ? settings : {};
    const worldTickSettings = isObject(settingsSource.worldTick) ? settingsSource.worldTick : {};
    if (worldTickSettings.enabled === false) {
        return guarded('disabled', isObject(state.flags?.worldTick) ? state.flags.worldTick : null);
    }
    if (isClockHeld(state)) {
        return guarded('time-held', isObject(state.flags?.worldTick) ? state.flags.worldTick : null);
    }
    if (season?.sandbox === true || state.seasonId === 'sandbox') {
        return guarded('sandbox', isObject(state.flags?.worldTick) ? state.flags.worldTick : null);
    }
    if (state.ending?.status === 'epilogue' || state.ending?.status === 'ended') {
        return guarded('ending', isObject(state.flags?.worldTick) ? state.flags.worldTick : null);
    }

    const effectiveAgenda = isObject(agenda)
        ? agenda
        : resolveAgenda(null, state.seasonId);
    const defaults = {
        ...DEFAULT_AGENDAS,
        ...(isObject(effectiveAgenda.defaults) ? effectiveAgenda.defaults : {}),
    };
    const factionAgendas = isObject(effectiveAgenda.factionAgendas) ? effectiveAgenda.factionAgendas : {};
    const threatPace = isObject(effectiveAgenda.threatPace) ? effectiveAgenda.threatPace : {};
    const rumorTemplates = Array.isArray(effectiveAgenda.rumorTemplates)
        && effectiveAgenda.rumorTemplates.length > 0
        ? effectiveAgenda.rumorTemplates
        : DEFAULT_AGENDAS.rumorTemplates;

    const previous = isObject(state.flags?.worldTick) ? state.flags.worldTick : null;
    const missingBaseline = !previous
        || previous.lastStoryTurn === undefined
        || previous.lastDate === undefined;

    if (missingBaseline) {
        return {
            ok: true,
            reason: 'no-elapsed-day',
            initialized: true,
            events: [],
            worldTick: {
                lastDate: state.meta?.inGameDate ?? null,
                lastTurn: Number.isInteger(state.meta?.turn) ? state.meta.turn : 0,
                lastStoryTurn: effectiveStoryTurn(state),
                totalDays: numberOr(previous?.totalDays, 0),
                suppressedDays: numberOr(previous?.suppressedDays, 0),
                pendingRumorIds: Array.isArray(previous?.pendingRumorIds)
                    ? previous.pendingRumorIds.slice(-MAX_PENDING_RUMORS)
                    : [],
                carryFactions: isObject(previous?.carryFactions) ? { ...previous.carryFactions } : {},
                carryThreats: isObject(previous?.carryThreats) ? { ...previous.carryThreats } : {},
            },
            summary: emptySummary(),
        };
    }

    const lastStoryTurn = Number.isInteger(previous.lastStoryTurn)
        ? previous.lastStoryTurn
        : effectiveStoryTurn(state);
    const dateDelta = previous.lastDate && state.meta?.inGameDate
        ? diffDays(previous.lastDate, state.meta.inGameDate)
        : null;
    const dateDays = Number.isFinite(dateDelta) ? Math.max(0, dateDelta) : 0;
    // The story-turn delta is authoritative when the date is static (V1 mode,
    // a disabled clock, or a sandbox without an anchor date). Take the larger
    // of the two so a clock that only advances slots still moves the city.
    const storyDays = Math.floor(
        Math.max(0, effectiveStoryTurn(state) - lastStoryTurn) / slotsPerDay(settingsSource),
    );
    const elapsedDays = Math.max(dateDays, storyDays);

    if (elapsedDays < 1) {
        return {
            ok: true,
            reason: 'no-elapsed-day',
            initialized: false,
            events: [],
            worldTick: previous,
            summary: emptySummary({ elapsedDays }),
        };
    }

    const maxDaysPerTick = integerOr(defaults.maxDaysPerTick, 14, { min: 1 });
    const appliedDays = Math.min(elapsedDays, maxDaysPerTick);
    const suppressed = elapsedDays - appliedDays;
    const totalDays = numberOr(previous.totalDays, 0) + appliedDays;
    const suppressedDays = numberOr(previous.suppressedDays, 0) + suppressed;

    const events = [];
    const maxFactionDelta = integerOr(defaults.maxFactionDeltaPerTick, 5);
    const factionInfluencePerDay = numberOr(defaults.factionInfluencePerDay, 0.5);
    const mainThreatProgressPerDay = numberOr(defaults.mainThreatProgressPerDay, 1);
    const secondaryThreatProgressPerDay = numberOr(defaults.secondaryThreatProgressPerDay, 0.5);
    const carryFactions = isObject(previous.carryFactions) ? { ...previous.carryFactions } : {};
    const carryThreats = isObject(previous.carryThreats) ? { ...previous.carryThreats } : {};

    /** Fold a sub-unit per-day rate into a one-decimal delta with carry. */
    function carriedTotal(carry, id, rate, days) {
        const banked = Number.isFinite(carry[id]) ? carry[id] : 0;
        return round1((rate * days) + banked);
    }

    // 1. Faction influence, deterministic by id.
    let factionCount = 0;
    const factionIds = isObject(state.factions) ? Object.keys(state.factions).sort(compareIds) : [];
    for (const factionId of factionIds) {
        const faction = state.factions[factionId];
        if (!isObject(faction) || faction.status === 'disbanded') {
            continue;
        }
        const current = Number(faction.influence);
        if (!Number.isFinite(current)) {
            continue;
        }
        const rate = Number(factionAgendas[factionId]?.influencePerDay);
        const effectiveRate = Number.isFinite(rate) ? rate : factionInfluencePerDay;
        const total = carriedTotal(carryFactions, factionId, effectiveRate, appliedDays);
        const rawDelta = Math.round(total);
        const delta = clamp(rawDelta, -maxFactionDelta, maxFactionDelta);
        // Keep a sub-unit remainder so a 0.3/day faction still moves every few
        // days; a clamped overshoot is discarded rather than banked forever.
        carryFactions[factionId] = delta === rawDelta
            ? clamp(round1(total - delta), -1, 1)
            : 0;
        if (delta === 0) {
            continue;
        }
        const influence = clamp(current + delta, 0, 100);
        if (Math.round(influence) !== Math.round(current)) {
            events.push({ type: 'SET_FACTION_INFLUENCE', factionId, influence });
            factionCount += 1;
        }
    }

    // 2. Threat progress, deterministic by id; the reducer derives the stage.
    let threatCount = 0;
    const threats = (Array.isArray(state.threats) ? state.threats : [])
        .filter(isObject)
        .slice()
        .sort((a, b) => compareIds(String(a.id), String(b.id)));
    for (const threat of threats) {
        if (threat.status !== 'active') {
            continue;
        }
        const rate = Number(threatPace[threat.id]?.progressPerDay);
        const effectiveRate = Number.isFinite(rate)
            ? rate
            : (threat.rank === 'main' ? mainThreatProgressPerDay : secondaryThreatProgressPerDay);
        const total = carriedTotal(carryThreats, threat.id, effectiveRate, appliedDays);
        const rawAmount = Math.round(total);
        const amount = clamp(rawAmount, -100, 100);
        carryThreats[threat.id] = amount === rawAmount
            ? clamp(round1(total - amount), -1, 1)
            : 0;
        if (amount === 0) {
            continue;
        }
        events.push({ type: 'ADVANCE_THREAT', threatId: threat.id, amount });
        threatCount += 1;
    }

    // 3. Off-screen NPC movement along authored connections.
    let moveCount = 0;
    const maxNpcMoves = integerOr(defaults.maxNpcMovesPerTick, 2);
    const combatActive = state.meta?.inCombat === true || isObject(state.scene?.combat);
    const allowNpcMoves = !(combatActive && worldTickSettings.allowNpcMovesDuringCombat !== true);
    if (allowNpcMoves && maxNpcMoves > 0) {
        const authored = buildAuthoredLocationMap(locations);
        const present = new Set(Array.isArray(state.scene?.present) ? state.scene.present : []);
        const pins = new Set(
            Array.isArray(state.flags?.castDirector?.manualPins)
                ? state.flags.castDirector.manualPins
                : [],
        );
        const terminal = new Set(TERMINAL_CHARACTER_STATUSES);
        const playerCharacterId = state.player?.characterId ?? null;
        const candidates = Object.values(isObject(state.characters) ? state.characters : {})
            .filter(isObject)
            .filter((character) => (
                character.controlledBy === 'npc'
                && character.alive === true
                && !terminal.has(character.status)
                && !present.has(character.charId)
                && !pins.has(character.charId)
                && character.charId !== playerCharacterId
                && typeof character.locationId === 'string'
                && isObject(state.locations?.[character.locationId])
            ))
            .sort((a, b) => compareIds(String(a.charId), String(b.charId)))
            .slice(0, maxNpcMoves);

        candidates.forEach((character, index) => {
            const origin = character.locationId;
            const originRecord = state.locations[origin];
            const authoredConnections = authored.get(origin)?.connections;
            const connections = Array.isArray(authoredConnections)
                ? authoredConnections
                : (Array.isArray(originRecord?.connections) ? originRecord.connections : []);
            const destinations = connections.filter((candidate) => (
                typeof candidate === 'string'
                && candidate !== origin
                && isObject(state.locations?.[candidate])
            ));
            if (destinations.length === 0) {
                return;
            }
            const destination = pickDeterministic(
                destinations,
                `${character.charId}:${totalDays + index}`,
            );
            if (typeof destination !== 'string') {
                return;
            }
            events.push({ type: 'MOVE_CHARACTER', characterId: character.charId, locationId: destination });
            moveCount += 1;
        });
    }

    // 4. Rumors: at most `rumorsPerTick` per tick, stable ids for dedupe.
    const rumorsPerTick = integerOr(defaults.rumorsPerTick, 2);
    const rumorCount = Math.min(rumorsPerTick, appliedDays);
    const storyTurn = effectiveStoryTurn(state);
    const pendingRumorIds = Array.isArray(previous.pendingRumorIds) ? previous.pendingRumorIds : [];
    const newRumorIds = [];
    let emittedRumors = 0;

    if (rumorCount > 0 && Array.isArray(rumorTemplates) && rumorTemplates.length > 0) {
        const factionCandidates = factionIds
            .filter((factionId) => isObject(state.factions[factionId]))
            .filter((factionId) => state.factions[factionId].status !== 'disbanded');
        const threatCandidates = threats.filter((threat) => threat.status === 'active');
        const sceneLocationId = resolvedLocationId(state, state.scene?.locationId);

        for (let index = 0; index < rumorCount; index += 1) {
            const id = `rumor:${state.meta?.inGameDate ?? 'undated'}:${storyTurn}:${index}`;
            if (pendingRumorIds.includes(id)) {
                continue;
            }
            const seed = `${storyTurn}:${index}`;
            const factionId = factionCandidates.length > 0
                ? pickDeterministic(factionCandidates, `${seed}:faction`)
                : null;
            const faction = typeof factionId === 'string' && isObject(state.factions[factionId])
                ? state.factions[factionId]
                : null;
            const threat = threatCandidates.length > 0
                ? pickDeterministic(threatCandidates, `${seed}:threat`)
                : null;

            const threatLocationId = resolvedLocationId(state, threat?.locationId);
            const headquartersLocationId = resolvedLocationId(state, faction?.headquartersLocationId);
            const locationId = threatLocationId ?? headquartersLocationId ?? sceneLocationId;
            const locationName = locationId
                ? String(state.locations[locationId]?.name ?? locationId)
                : String(factionId ?? sceneLocationId ?? 'the city');
            const factionName = faction
                ? String(faction.name ?? factionId)
                : String(factionId ?? 'The city');
            const threatName = isObject(threat)
                ? String(threat.name ?? "the city's troubles")
                : "the city's troubles";

            const template = pickDeterministic(rumorTemplates, seed);
            const summary = formatTemplate(template, {
                faction: factionName,
                location: locationName,
                threat: threatName,
            });
            const headline = `${factionName} activity near ${locationName}`.slice(0, 90).trim();
            const extraTags = Array.isArray(factionAgendas[factionId]?.rumorTags)
                ? factionAgendas[factionId].rumorTags.filter((tag) => typeof tag === 'string')
                : [];
            const event = {
                type: 'ADD_EVENT',
                summary,
                headline,
                actors: [],
                tags: ['offscreen', 'tick', `tick:${storyTurn}`, ...extraTags],
            };
            if (locationId) {
                event.locationId = locationId;
            }
            events.push(event);
            newRumorIds.push(id);
            emittedRumors += 1;
        }
    }

    const worldTick = {
        lastDate: state.meta?.inGameDate ?? null,
        lastTurn: Number.isInteger(state.meta?.turn) ? state.meta.turn : 0,
        lastStoryTurn: storyTurn,
        totalDays,
        suppressedDays,
        pendingRumorIds: [...pendingRumorIds, ...newRumorIds].slice(-MAX_PENDING_RUMORS),
        carryFactions,
        carryThreats,
    };

    return {
        ok: true,
        reason: 'ok',
        initialized: false,
        events,
        worldTick,
        summary: {
            elapsedDays,
            appliedDays,
            suppressedDays: suppressed,
            factions: factionCount,
            threats: threatCount,
            moves: moveCount,
            rumors: emittedRumors,
        },
    };
}

/**
 * Create the world-tick flow.
 *
 * @param {{
 *   store: object,
 *   getSeason?: (() => object|null)|null,
 *   getSettings?: (() => object|null)|null,
 *   loadData?: (() => Promise<{ agendas?: object|null, locations?: object|null }>)|null,
 *   fetchImpl?: typeof fetch,
 *   log?: ((message: string, error?: unknown) => void)|null,
 * }} options
 */
export function createWorldTick({
    store,
    getSeason = null,
    getSettings = null,
    loadData = null,
    fetchImpl = globalThis.fetch,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('createWorldTick requires a WorldState store');
    }

    let cachedLocations = null;
    let cachedAgendas = null;

    async function loadDefaultData() {
        const [agendaOutcome, locations] = await Promise.all([
            loadAgendas({ fetchImpl })
                .then((document) => ({ document, error: null }))
                .catch((error) => ({ document: null, error })),
            loadLocations({ fetchImpl }),
        ]);
        if (agendaOutcome.error) {
            // The loader rejects malformed data. The tick still runs with the
            // global fallback and the global locations document; the failed
            // document is not cached so the next tick retries the fetch.
            logWarning(log, 'World tick agenda data unavailable; using defaults', agendaOutcome.error);
        }
        return { agendas: agendaOutcome.document, locations };
    }

    async function data() {
        if (cachedLocations && cachedAgendas) {
            return { agendas: cachedAgendas, locations: cachedLocations };
        }
        const loaded = typeof loadData === 'function' ? await loadData() : await loadDefaultData();
        const locations = isObject(loaded?.locations) ? loaded.locations : null;
        if (!locations) {
            return { agendas: cachedAgendas, locations: null };
        }
        cachedLocations = locations;
        if (isObject(loaded?.agendas)) {
            cachedAgendas = loaded.agendas;
        }
        return { agendas: cachedAgendas, locations: cachedLocations };
    }

    async function run({ signal = null } = {}) {
        if (signal?.aborted) {
            return { ran: false, reason: 'aborted', events: [], summary: null };
        }
        let settings = {};
        try {
            settings = (typeof getSettings === 'function' ? getSettings() : null) ?? {};
        } catch (error) {
            logWarning(log, 'Could not read settings for the world tick', error);
        }
        if (settings?.worldTick?.enabled === false) {
            return { ran: false, reason: 'disabled', events: [], summary: null };
        }

        let loaded;
        try {
            loaded = await data();
        } catch (error) {
            logWarning(log, 'World tick data unavailable; skipping this tick', error);
            return { ran: false, reason: 'data-unavailable', events: [], summary: null };
        }
        if (!isObject(loaded.locations)) {
            return { ran: false, reason: 'data-unavailable', events: [], summary: null };
        }

        const current = store.get();
        if (!isObject(current)) {
            return { ran: false, reason: 'no-state', events: [], summary: null };
        }

        let season = null;
        try {
            season = typeof getSeason === 'function' ? getSeason() : null;
        } catch (error) {
            logWarning(log, 'Could not resolve the season for the world tick', error);
            season = null;
        }

        const plan = planWorldTick({
            state: current,
            season,
            agenda: resolveAgenda(loaded.agendas, season?.id ?? current.seasonId),
            locations: loaded.locations,
            settings,
        });

        if (!plan.ok) {
            return { ran: false, reason: plan.reason, events: [], summary: plan.summary };
        }
        if (plan.events.length === 0 && plan.initialized !== true && plan.reason !== 'ok') {
            return {
                ran: false,
                reason: plan.reason,
                applied: null,
                summary: plan.summary,
                events: [],
            };
        }
        if (signal?.aborted) {
            return { ran: false, reason: 'aborted', events: [], summary: plan.summary };
        }

        const applied = applyEventBatch(store, plan.events, {
            log,
            patch: (next) => ({
                ...next,
                flags: {
                    ...(next.flags ?? {}),
                    worldTick: plan.worldTick,
                },
            }),
        });
        if (applied.ok !== true) {
            return {
                ran: false,
                reason: 'apply-failed',
                applied,
                summary: plan.summary,
                events: plan.events,
                error: applied.error ?? 'apply failed',
            };
        }

        return {
            ran: true,
            reason: plan.reason,
            applied,
            summary: plan.summary,
            events: plan.events,
            initialized: plan.initialized === true,
        };
    }

    return { run };
}
