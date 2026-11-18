/**
 * Newspaper publisher.
 *
 * Cadence is deterministic: an edition is due when enough in-game days have
 * passed or enough new events accumulated. The prose may come from the
 * optional newspaper agent, but the deterministic edition is always built and
 * is published on any agent failure. Time held in a scene publishes nothing.
 *
 * The publisher is called detached from the turn pipeline; it never throws and
 * re-checks that the chat is still current before writing.
 */

import { diffDays, isClockHeld } from '../core/world-clock.js';
import {
    buildDeterministicEdition,
    newspaperSettings,
    selectNewsworthyEvents,
    validateEdition,
} from '../data/newsroom.js';
import { applyEventBatch } from './initiative.js';

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
        // Logging must never break a publication.
    }
}

/** Count events newer than the last edition. */
export function countNewEvents(state) {
    const newsroom = isObject(state?.flags?.newsroom) ? state.flags.newsroom : {};
    const lastTurn = Number.isInteger(newsroom.lastEditionTurn) ? newsroom.lastEditionTurn : -1;
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    return events.filter((event) => (
        isObject(event)
        && Number.isInteger(event.turn)
        && event.turn > lastTurn
        && !(Array.isArray(event.tags) && event.tags.includes('season-start'))
    )).length;
}

/**
 * Deterministic cadence decision. Pure and exported for tests.
 *
 * @returns {{ due: boolean, reason: string, newEvents: number, elapsedDays: number }}
 */
export function editionDue(state, settings = {}) {
    const config = newspaperSettings(settings);
    if (!config.enabled) {
        return { due: false, reason: 'disabled', newEvents: 0, elapsedDays: 0 };
    }
    if (isClockHeld(state)) {
        return { due: false, reason: 'time-held', newEvents: 0, elapsedDays: 0 };
    }
    const endingStatus = state?.ending?.status;
    if (endingStatus === 'epilogue' || endingStatus === 'ended') {
        return { due: false, reason: 'ending', newEvents: 0, elapsedDays: 0 };
    }
    const newEvents = countNewEvents(state);
    const newsroom = isObject(state?.flags?.newsroom) ? state.flags.newsroom : {};
    const lastDate = typeof newsroom.lastEditionDate === 'string' ? newsroom.lastEditionDate : null;
    const date = typeof state?.meta?.inGameDate === 'string' ? state.meta.inGameDate : null;
    const elapsedDays = lastDate && date ? Math.max(0, diffDays(lastDate, date)) : 0;
    // Before the first edition there is no date anchor, so the first paper is
    // driven by the event threshold (or by an explicit publish call).
    if (newEvents === 0) {
        return { due: false, reason: 'no-events', newEvents, elapsedDays };
    }
    const dueByDays = elapsedDays >= config.everyDays;
    const dueByEvents = newEvents >= config.minEvents;
    return {
        due: dueByDays || dueByEvents,
        reason: dueByDays ? 'days' : dueByEvents ? 'events' : 'not-due',
        newEvents,
        elapsedDays,
    };
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

/** True when this in-game date already has an edition (or was the last one). */
function isDuplicateDate(state, edition) {
    const date = typeof edition?.date === 'string' ? edition.date : null;
    if (!date) {
        return false;
    }
    const newsroom = isObject(state?.flags?.newsroom) ? state.flags.newsroom : {};
    if (newsroom.lastEditionDate === date) {
        return true;
    }
    const editions = Array.isArray(newsroom.editions) ? newsroom.editions : [];
    return editions.some((entry) => isObject(entry) && entry.date === date);
}

/**
 * Create the publisher flow.
 *
 * @param {{
 *   store: object,
 *   getSeason?: (() => object|null)|null,
 *   getSettings?: (() => object|null)|null,
 *   agent?: object|null,
 *   now?: () => number,
 *   log?: ((message: string, error?: unknown) => void)|null,
 * }} options
 */
export function createNewsroomFlow({
    store,
    getSeason = null,
    getSettings = null,
    agent = null,
    now = Date.now,
    log = null,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('createNewsroomFlow requires a WorldState store');
    }
    const clock = typeof now === 'function' ? now : Date.now;

    function settings() {
        try {
            return (typeof getSettings === 'function' ? getSettings() : null) ?? {};
        } catch (error) {
            logWarning(log, 'Could not read newspaper settings', error);
            return {};
        }
    }

    function season() {
        try {
            return typeof getSeason === 'function' ? getSeason() : null;
        } catch {
            return null;
        }
    }

    /**
     * Publish one edition if due. Safe to call detached: it never throws.
     *
     * @param {{ chatId?: string|null, isCurrent?: (() => boolean)|null, signal?: AbortSignal|null }} [options]
     */
    async function publish({ chatId = null, isCurrent = null, signal = null } = {}) {
        const settingsNow = settings();
        const config = newspaperSettings(settingsNow);
        if (!config.enabled) {
            return { ok: false, reason: 'disabled' };
        }
        const current = typeof isCurrent === 'function' ? isCurrent : null;
        if (current && !current()) {
            return { ok: false, reason: 'chat-changed' };
        }
        if (signal?.aborted) {
            return { ok: false, reason: 'aborted' };
        }

        const state = store.get();
        if (!isObject(state)) {
            return { ok: false, reason: 'no-state' };
        }
        const decision = editionDue(state, settingsNow);
        if (!decision.due) {
            return { ok: false, reason: decision.reason, decision };
        }

        const seasonNow = season();
        const deterministic = buildDeterministicEdition({
            state,
            season: seasonNow,
            settings: settingsNow,
            source: 'deterministic',
        });
        if (!deterministic) {
            return { ok: false, reason: 'no-edition', decision };
        }
        if (isDuplicateDate(state, deterministic)) {
            return { ok: false, reason: 'duplicate-date', decision };
        }

        let agentError = null;
        let agentPayload = null;
        if (agent && typeof agent.run === 'function'
            && settingsNow?.agents?.newspaper?.enabled !== false) {
            try {
                const response = await agent.run({
                    state,
                    season: seasonNow,
                    settings: settingsNow,
                    events: selectNewsworthyEvents(state, {
                        sinceTurn: Number.isInteger(state?.flags?.newsroom?.lastEditionTurn)
                            ? state.flags.newsroom.lastEditionTurn
                            : -1,
                        limit: 20,
                    }),
                    fallback: deterministic,
                    signal,
                });
                const value = responseValue(response);
                const candidate = isObject(value?.edition) ? value.edition : value;
                if (isObject(candidate)) {
                    agentPayload = candidate;
                } else {
                    agentError = 'agent response was not an object';
                }
            } catch (error) {
                agentError = error?.message ?? String(error);
                logWarning(log, 'Newspaper agent failed; publishing the deterministic edition', error);
            }
        }

        if (current && !current()) {
            return { ok: false, reason: 'chat-changed' };
        }

        // The agent can take seconds. Re-read and rebuild from the fresh world:
        // a turn may have advanced the date while the call was in flight, and a
        // stale edition would move `lastEditionTurn` backwards.
        const fresh = store.get();
        if (!isObject(fresh)) {
            return { ok: false, reason: 'no-state' };
        }
        const freshDecision = editionDue(fresh, settingsNow);
        if (!freshDecision.due) {
            return { ok: false, reason: freshDecision.reason, decision: freshDecision };
        }
        const freshBase = buildDeterministicEdition({
            state: fresh,
            season: seasonNow,
            settings: settingsNow,
            source: 'deterministic',
        });
        if (!freshBase) {
            return { ok: false, reason: 'no-edition', decision: freshDecision };
        }
        if (isDuplicateDate(fresh, freshBase)) {
            return { ok: false, reason: 'duplicate-date', decision: freshDecision };
        }

        let edition = freshBase;
        let source = 'deterministic';
        if (agentPayload) {
            const merged = {
                ...freshBase,
                ...agentPayload,
                // Time and identity always come from the fresh world document.
                id: freshBase.id,
                date: freshBase.date,
                turn: freshBase.turn,
                source: 'agent',
            };
            const validation = validateEdition(merged);
            if (validation.ok) {
                edition = validation.edition;
                source = 'agent';
            } else {
                agentError = validation.errors.join('; ');
                logWarning(log, `Newspaper agent edition rejected: ${agentError}`);
            }
        }

        let applied;
        try {
            applied = applyEventBatch(store, [{ type: 'PUBLISH_EDITION', edition }], { log });
        } catch (error) {
            logWarning(log, 'Could not publish the newspaper edition', error);
            return { ok: false, reason: 'apply-failed', error: error?.message ?? String(error) };
        }
        if (applied.ok !== true) {
            return { ok: false, reason: 'apply-failed', error: applied.error ?? null };
        }
        return {
            ok: true,
            reason: null,
            chatId,
            edition,
            source,
            decision: freshDecision,
            agentError,
            at: clock(),
            state: applied.state,
        };
    }

    return { publish, editionDue: () => editionDue(store.get(), settings()) };
}
