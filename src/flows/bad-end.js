/**
 * Bad-end flow.
 *
 * The flow owns writes: detection is pure, epilogues are best-effort, and the
 * whole record+journal batch is applied atomically through `applyEventBatch`.
 * Every mutation is opt-in through `settings.badEnds.enabled`.
 */

import {
    BAD_END_EPILOGUE_SCHEMA,
    buildBadEndEpiloguePrompt,
} from '../agents/bad-end.js';
import { validateJsonSchema } from '../agents/client.js';
import { applyEventBatch } from './initiative.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a bad-end pass.
    }
}

function isAbortError(error) {
    return error?.name === 'AgentAbortedError' || error?.code === 'AGENT_ABORTED';
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

function isBundleCharacter(character, registry) {
    if (character?.bundle === true || character?.isBundle === true) {
        return true;
    }
    const entry = asArray(registry?.entries).find((candidate) => candidate?.id === character?.charId);
    return entry?.bundle === true;
}

function fallbackEpilogue(state, record) {
    const character = state?.characters?.[record?.characterId] ?? null;
    const name = character?.displayName ?? record?.characterId ?? 'This character';
    const locationId = record?.locationId ?? character?.locationId ?? null;
    const place = locationId
        ? state?.locations?.[locationId]?.name ?? locationId
        : 'the place where it happened';
    const cause = typeof record?.cause === 'string' && record.cause.length > 0
        ? record.cause
        : 'The record is closed.';
    return `${name}'s story reaches its end at ${place}. ${cause} The world keeps the shape this ending left behind, and the record of what happened remains.`;
}

/**
 * Pure continuation options for one character. Shared by the flow and the UI.
 */
export function listContinuationOptionsFor({
    state,
    characterId,
    settings = {},
    registry = null,
} = {}) {
    const record = state?.badEnds?.[characterId] ?? null;
    const allowDeadContinuation = settings?.badEnds?.allowDeadContinuation === true;
    const selfAvailable = Boolean(record) && (record.type === 'death'
        ? record.playableAs === true && allowDeadContinuation
        : true);

    const characters = Object.values(isObject(state?.characters) ? state.characters : {})
        .filter((character) => isObject(character))
        .filter((character) => character.charId !== characterId)
        .filter((character) => character.alive === true)
        .filter((character) => !['dead', 'missing', 'lost', 'retired'].includes(character.status))
        .filter((character) => !isBundleCharacter(character, registry))
        .filter((character) => {
            const otherRecord = state?.badEnds?.[character.charId];
            return !otherRecord || otherRecord.reversed === true;
        })
        .map((character) => ({
            characterId: character.charId,
            displayName: character.displayName ?? character.charId,
            status: character.status,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
        self: {
            available: selfAvailable,
            characterId,
            record,
        },
        other: {
            available: true,
            characters,
            custom: { available: true },
        },
        end: { available: true },
    };
}

/**
 * Create the bad-end flow. Writes are opt-in and atomic.
 */
export function createBadEndFlow({
    store,
    detector,
    runner = null,
    getSettings = null,
    season = null,
    context = {},
    log = null,
    now = Date.now,
} = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('createBadEndFlow requires a WorldState store');
    }
    const clock = typeof now === 'function' ? now : Date.now;
    const worldContext = isObject(context) ? context : {};

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

    function requireCharacter(state, characterId) {
        const character = state?.characters?.[characterId];
        if (!isObject(character)) {
            throw new Error(`Unknown character "${String(characterId)}"`);
        }
        return character;
    }

    function apply(events) {
        const applied = applyEventBatch(store, events, {
            context: worldContext,
            log,
        });
        if (!applied.ok) {
            throw new Error(applied.error ?? 'Bad-end write rejected');
        }
        return applied.state;
    }

    function optionsFor(state, characterId) {
        return listContinuationOptionsFor({
            state,
            characterId,
            settings: settings(),
            registry: worldContext.registry ?? null,
        });
    }

    async function epilogueFor({ state, record, signal }) {
        if (typeof runner?.runAgent !== 'function') {
            return { text: '', called: false };
        }
        const prompt = buildBadEndEpiloguePrompt({ state, record, settings: settings() });
        try {
            const response = await runner.runAgent({
                agentId: 'epilogue',
                prompt,
                schema: BAD_END_EPILOGUE_SCHEMA,
                signal,
            });
            const value = responseValue(response);
            const text = typeof value?.epilogueText === 'string'
                ? value.epilogueText.trim()
                : '';
            const validation = validateJsonSchema(
                { epilogueText: text },
                BAD_END_EPILOGUE_SCHEMA,
            );
            if (!validation.ok) {
                logWarning(
                    log,
                    'Bad-end epilogue failed schema validation; using deterministic fallback',
                    validation.errors,
                );
                return { text: '', called: true };
            }
            return { text, called: true };
        } catch (error) {
            // An epilogue failure never blocks the record itself.
            logWarning(log, 'Bad-end epilogue failed; using deterministic fallback', error);
            return { text: '', called: true };
        }
    }

    /**
     * Detect and record bad ends. Disabled mode is a strict no-op.
     */
    async function detectAndRecord({
        message = '',
        recentProse = '',
        signal = null,
        continuityKey = null,
    } = {}) {
        const settingsNow = settings();
        if (settingsNow?.badEnds?.enabled !== true) {
            return { enabled: false, calls: 0, recorded: [], skipped: [], epilogues: [] };
        }
        if (settingsNow?.agents?.badEnd?.enabled === false) {
            return {
                enabled: false,
                reason: 'agent-disabled',
                calls: 0,
                recorded: [],
                skipped: [],
                epilogues: [],
            };
        }
        if (!detector || typeof detector.run !== 'function') {
            throw new TypeError('detectAndRecord requires a bad-end detector');
        }

        const base = currentState();
        let detection;
        try {
            detection = await detector.run({
                state: base,
                message,
                recentProse,
                signal,
                formRules: worldContext.formRules ?? null,
                settings: settingsNow,
                options: typeof continuityKey === 'string' && continuityKey.length > 0
                    ? { continuityKey }
                    : {},
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Bad-end detection failed; state unchanged', error);
            return {
                enabled: true,
                calls: 0,
                recorded: [],
                skipped: [],
                epilogues: [],
                error: error?.message ?? String(error),
            };
        }

        const calls = Number.isFinite(detection?.calls) ? detection.calls : 0;
        const events = [];
        const recorded = [];
        const epilogues = [];
        const skipped = asArray(detection?.skipped);
        let totalCalls = calls;
        const seenKeys = new Set();

        for (const candidate of asArray(detection?.records)) {
            if (!isObject(candidate) || typeof candidate.characterId !== 'string') {
                continue;
            }
            const characterId = candidate.characterId;
            const character = base.characters?.[characterId];
            if (!isObject(character)) {
                continue;
            }
            const resolvedKey = typeof candidate.continuityKey === 'string'
                && candidate.continuityKey.length > 0
                ? candidate.continuityKey
                : (typeof continuityKey === 'string' && continuityKey.length > 0
                    ? continuityKey
                    : `${base.seasonId}:${characterId}`);
            const seenKey = `${characterId}:${resolvedKey}`;
            if (seenKeys.has(seenKey)) {
                continue;
            }
            seenKeys.add(seenKey);
            const existing = base.badEnds?.[characterId];
            if (existing && existing.continuityKey === resolvedKey) {
                // Already recorded under this continuity key: never duplicate.
                recorded.push({
                    characterId,
                    record: existing,
                    epilogueText: existing.epilogueText ?? '',
                });
                epilogues.push({ characterId, epilogueText: existing.epilogueText ?? '' });
                continue;
            }

            const badEndType = candidate.badEndType ?? candidate.type;
            if (typeof badEndType !== 'string') {
                continue;
            }
            const recordForPrompt = {
                ...candidate,
                characterId,
                type: badEndType,
                continuityKey: resolvedKey,
            };
            let epilogueText = typeof candidate.epilogueText === 'string'
                ? candidate.epilogueText.trim()
                : '';
            if (epilogueText.length === 0) {
                const epilogue = await epilogueFor({
                    state: base,
                    record: recordForPrompt,
                    signal,
                });
                if (epilogue.called) {
                    totalCalls += 1;
                }
                epilogueText = epilogue.text;
            }
            if (epilogueText.length === 0) {
                epilogueText = fallbackEpilogue(base, recordForPrompt);
            }
            epilogueText = epilogueText.slice(0, 2400);
            epilogues.push({ characterId, epilogueText });

            const sourceCharacterId = typeof candidate.sourceCharacterId === 'string'
                && base.characters?.[candidate.sourceCharacterId]
                ? candidate.sourceCharacterId
                : null;
            const sourceFactionId = typeof candidate.sourceFactionId === 'string'
                ? candidate.sourceFactionId
                : null;
            const locationId = typeof candidate.locationId === 'string'
                && base.locations?.[candidate.locationId]
                ? candidate.locationId
                : (character.locationId ?? null);

            events.push({
                type: 'RECORD_BAD_END',
                characterId,
                badEndType,
                severity: candidate.severity ?? 'major',
                cause: candidate.cause ?? '',
                sourceCharacterId,
                sourceFactionId,
                turn: Number.isInteger(candidate.turn) ? candidate.turn : (base.meta?.turn ?? 0),
                date: candidate.date !== undefined ? candidate.date : base.meta?.inGameDate ?? null,
                locationId,
                epilogueText,
                playableAs: candidate.playableAs === true,
                continuityKey: resolvedKey,
                reversibility: candidate.reversibility ?? 'none',
                notes: candidate.notes ?? '',
            });
            events.push({
                type: 'ADD_EVENT',
                turn: base.meta?.turn ?? 0,
                date: base.meta?.inGameDate ?? null,
                summary: `Bad end recorded: ${badEndType} - ${candidate.cause ?? characterId}`,
                actors: [characterId],
                locationId,
                tags: ['bad-end', badEndType],
            });
        }

        if (events.length === 0) {
            return {
                enabled: true,
                calls: totalCalls,
                recorded,
                skipped,
                epilogues,
                ambiguous: asArray(detection?.ambiguous),
                error: detection?.error ?? null,
            };
        }

        let next;
        try {
            next = apply(events);
        } catch (error) {
            logWarning(log, 'Bad-end batch rejected atomically; state unchanged', error);
            return {
                enabled: true,
                calls: totalCalls,
                recorded: [],
                skipped,
                epilogues,
                ambiguous: asArray(detection?.ambiguous),
                error: error?.message ?? String(error),
            };
        }

        for (const epilogue of epilogues) {
            const stored = next.badEnds?.[epilogue.characterId];
            if (stored) {
                recorded.push({
                    characterId: epilogue.characterId,
                    record: stored,
                    epilogueText: stored.epilogueText ?? epilogue.epilogueText,
                });
            }
        }

        return {
            enabled: true,
            calls: totalCalls,
            recorded,
            skipped,
            epilogues,
            ambiguous: asArray(detection?.ambiguous),
            state: next,
        };
    }

    function listContinuationOptions({ state = null, characterId } = {}) {
        const snapshot = state ?? currentState();
        requireCharacter(snapshot, characterId);
        return optionsFor(snapshot, characterId);
    }

    function continueAsBadEnded({ characterId } = {}) {
        const state = currentState();
        requireCharacter(state, characterId);
        const record = state.badEnds?.[characterId];
        if (!record) {
            throw new Error(`No bad end record for character "${characterId}"`);
        }
        const options = optionsFor(state, characterId);
        if (!options.self.available) {
            throw new Error(`Cannot continue as "${characterId}": dead continuation is not available`);
        }
        const next = apply([{
            type: 'CONTINUE_BAD_END',
            action: 'self',
            characterId,
            allowDeadContinuation: settings()?.badEnds?.allowDeadContinuation === true,
        }]);
        return {
            ok: true,
            characterId,
            record: next.badEnds?.[characterId] ?? record,
            state: next,
        };
    }

    function continueAsSomeoneElse({ identity = 'custom', characterId = null, displayName = null } = {}) {
        const state = currentState();
        if (identity !== 'custom' && identity !== 'canon') {
            throw new Error(`Unknown player identity "${String(identity)}"`);
        }
        if (identity === 'canon') {
            const target = requireCharacter(state, characterId);
            const otherRecord = state.badEnds?.[target.charId];
            if (target.alive !== true || ['dead', 'missing'].includes(target.status)) {
                throw new Error(`Cannot play as "${target.charId}": the character is not alive`);
            }
            if (otherRecord && otherRecord.reversed !== true) {
                throw new Error(`Cannot play as "${target.charId}": the character has a bad-end record`);
            }
            if (isBundleCharacter(target, worldContext.registry ?? null)) {
                throw new Error(`Cannot play as "${target.charId}": bundles are not playable characters`);
            }
        }
        const event = {
            type: 'CONTINUE_BAD_END',
            action: 'other',
            identity,
        };
        if (identity === 'canon') {
            event.characterId = characterId;
        } else if (typeof displayName === 'string' && displayName.trim().length > 0) {
            event.displayName = displayName.trim();
        }
        const next = apply([event]);
        return {
            ok: true,
            identity,
            characterId: next.player?.characterId ?? null,
            state: next,
        };
    }

    function endHere({ characterId } = {}) {
        const state = currentState();
        requireCharacter(state, characterId);
        return {
            ended: true,
            characterId,
            record: state.badEnds?.[characterId] ?? null,
            state,
        };
    }

    function reverseBadEnd({ characterId, reason = '', restoredStatus = 'active' } = {}) {
        const state = currentState();
        requireCharacter(state, characterId);
        if (!state.badEnds?.[characterId]) {
            throw new Error(`No bad end record for character "${characterId}"`);
        }
        const next = apply([{
            type: 'REVERSE_BAD_END',
            characterId,
            reason,
            restoredStatus,
        }]);
        return {
            ok: true,
            characterId,
            record: next.badEnds?.[characterId] ?? null,
            state: next,
        };
    }

    return {
        detectAndRecord,
        listContinuationOptions,
        continueAsBadEnded,
        continueAsSomeoneElse,
        endHere,
        reverseBadEnd,
        getState: () => currentState(),
        getSettings: () => settings(),
        now: clock,
        season,
    };
}
