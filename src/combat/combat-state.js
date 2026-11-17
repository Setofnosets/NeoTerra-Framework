/**
 * Combat state flow: start, resolve, end.
 *
 * The flow is the authority for conflict resources. It resolves actions through
 * the pure resolver, converts outcomes into bounded reducer events, writes the
 * compact action log, and ends the conflict deterministically. The narrator
 * only describes what this flow already decided.
 *
 * SillyTavern integration (function tool + slash command) lives here too so the
 * standalone extension can opt in without a panel or a new agent.
 */

import { applyWorldEvents } from '../state/reducer.js';
import { cloneWorldState } from '../state/world-state.js';
import {
    COMBAT_ACTIONS,
    normalizeCombatAction,
    resolveAction,
    rollD20,
} from './resolver.js';
import { buildOutcome, outcomeEvents, OUTCOME_TIERS } from './outcome.js';

const DEFAULT_MAX_ROUNDS = 8;
const MIN_MAX_ROUNDS = 3;
const MAX_MAX_ROUNDS = 20;
const MAX_ACTION_LOG = 50;

// Registration handles mirror the `/neoterra` shell pattern: unregister before
// re-register on every enable. A hot reload creates a new module instance, so
// callers should still run `dispose` before reloading the extension.
let registeredTool = null;
let registeredCommand = null;
let registeredContext = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function failure(reason, message) {
    return { ok: false, reason, message: message ?? reason };
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break a combat action.
    }
}

function characterName(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return state?.player?.displayName ?? 'The Player';
    }
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function staminaOf(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return Number(state?.player?.stamina?.current ?? 0);
    }
    return Number(state?.characters?.[characterId]?.stamina?.current ?? 0);
}

function defaultActorId(state) {
    if (state?.player?.identity === 'canon' && state.player.characterId) {
        return state.player.characterId;
    }
    return 'player';
}

function formatSigned(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return '—';
    }
    return number >= 0 ? `+${number}` : String(number);
}

function maxRoundsFrom(getSettings) {
    let settings = null;
    try {
        settings = typeof getSettings === 'function' ? getSettings() : null;
    } catch {
        settings = null;
    }
    const raw = Number(settings?.combat?.maxRounds);
    if (!Number.isFinite(raw)) {
        return DEFAULT_MAX_ROUNDS;
    }
    return clamp(Math.round(raw), MIN_MAX_ROUNDS, MAX_MAX_ROUNDS);
}

function appendAction(state, record) {
    const combat = state.scene?.combat;
    if (!isObject(combat)) {
        return;
    }
    const actions = Array.isArray(combat.actions) ? combat.actions.slice() : [];
    actions.push(record);
    combat.actions = actions.slice(-MAX_ACTION_LOG);
    combat.round = record.round;
}

function sidesFor(participants, sides) {
    if (isObject(sides)) {
        return { ...sides };
    }
    const out = {};
    participants.forEach((participantId, index) => {
        out[participantId] = index % 2 === 0 ? 'a' : 'b';
    });
    return out;
}

function inferWinnerSide(participants, sides, loserIds) {
    if (!Array.isArray(loserIds) || loserIds.length === 0 || !isObject(sides)) {
        return null;
    }
    const loserSides = new Set(loserIds.map((id) => sides[id]).filter(Boolean));
    const allSides = new Set(participants.map((id) => sides[id]).filter(Boolean));
    if (loserSides.size !== 1 || allSides.size !== 2) {
        return null;
    }
    const losing = [...loserSides][0];
    return [...allSides].find((side) => side !== losing) ?? null;
}

function finishCombat(state, { endReason, loserIds = [], extra = {} } = {}) {
    const combat = isObject(state.scene?.combat) ? state.scene.combat : {};
    const participants = Array.isArray(combat.participants) ? combat.participants.slice() : [];
    const lastCombat = {
        id: combat.id ?? null,
        kind: combat.kind ?? 'skirmish',
        stakes: combat.stakes ?? '',
        intent: combat.intent ?? '',
        participants,
        sides: isObject(combat.sides) ? { ...combat.sides } : null,
        round: Number.isInteger(combat.round) ? combat.round : 0,
        maxRounds: Number.isInteger(combat.maxRounds) ? combat.maxRounds : DEFAULT_MAX_ROUNDS,
        endReason,
        reason: endReason,
        endedTurn: state.meta?.turn ?? 0,
        winnerSide: inferWinnerSide(participants, combat.sides, loserIds),
        loserIds: loserIds.slice(),
        summary: `${combat.kind ?? 'skirmish'} ended: ${endReason}`,
        ...extra,
    };
    state.flags = {
        ...(isObject(state.flags) ? state.flags : {}),
        lastCombat,
    };
    return applyWorldEvents(state, [{ type: 'COMBAT_END' }]);
}

/**
 * Create a combat flow bound to one WorldState store.
 *
 * @param {{
 *   store: { get(): object, replace(state: object): object },
 *   getSettings?: (() => object) | null,
 *   now?: () => number,
 *   log?: ((message: string, error?: unknown) => void) | null,
 * }} options
 */
export function createCombatFlow({ store, getSettings = null, now = Date.now, log = null } = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('createCombatFlow requires a WorldState store');
    }

    function activeCombat() {
        const state = store.get();
        return isObject(state?.scene?.combat) ? state.scene.combat : null;
    }

    function start({
        participants,
        sides = null,
        stakes = '',
        intent = '',
        kind = 'skirmish',
        locationId = null,
        seed = null,
    } = {}) {
        const state = store.get();
        if (!isObject(state)) {
            return failure('no-state', 'No seeded WorldState');
        }
        if (isObject(state.scene?.combat)) {
            return failure('combat-active', 'A conflict is already active');
        }
        if (!Array.isArray(participants) || participants.length < 2) {
            return failure('invalid-participants', 'A conflict requires at least two participants');
        }
        const unique = [];
        for (const participantId of participants) {
            if (typeof participantId !== 'string' || participantId.length === 0) {
                return failure('invalid-participants', 'Participant ids must be non-empty strings');
            }
            if (unique.includes(participantId)) {
                return failure('duplicate-participant', `Duplicate participant "${participantId}"`);
            }
            if (participantId === 'player') {
                if (state.player?.identity !== 'custom') {
                    return failure(
                        'invalid-participant',
                        'The "player" participant is only valid for a custom persona; use the canon character id',
                    );
                }
            } else if (!state.characters?.[participantId]) {
                return failure('unknown-participant', `Unknown participant "${participantId}"`);
            }
            unique.push(participantId);
        }

        let resolvedSides;
        if (sides !== null && sides !== undefined) {
            if (!isObject(sides)) {
                return failure('invalid-sides', 'sides must map participant ids to "a" or "b"');
            }
            resolvedSides = {};
            for (const participantId of unique) {
                const side = sides[participantId];
                if (side !== 'a' && side !== 'b') {
                    return failure(
                        'unknown-side',
                        `Participant "${participantId}" has no valid side`,
                    );
                }
                resolvedSides[participantId] = side;
            }
            const values = new Set(Object.values(resolvedSides));
            if (!values.has('a') || !values.has('b')) {
                return failure('invalid-sides', 'Both sides must have at least one participant');
            }
        } else {
            resolvedSides = sidesFor(unique, null);
        }

        const resolvedSeed = Number.isFinite(Number(seed)) && seed !== null
            ? Number(seed)
            : now();
        const resolvedLocation = locationId ?? state.scene?.locationId ?? null;
        try {
            const next = applyWorldEvents(state, [{
                type: 'COMBAT_START',
                participants: unique,
                kind: typeof kind === 'string' && kind.length > 0 ? kind : 'skirmish',
                locationId: resolvedLocation,
                id: `combat-${resolvedSeed}`,
                stakes: typeof stakes === 'string' ? stakes : '',
                intent: typeof intent === 'string' ? intent : '',
                seed: resolvedSeed,
                sides: resolvedSides,
                round: 0,
                maxRounds: maxRoundsFrom(getSettings),
                status: 'active',
                actions: [],
            }]);
            store.replace(next);
            return { ok: true, combat: store.get().scene.combat, state: store.get() };
        } catch (error) {
            logWarning(log, 'Combat start rejected; state unchanged', error);
            return failure('rejected', error?.message ?? String(error));
        }
    }

    function surrenderConflict(state, combat, { actorId, targetId, action }) {
        const record = {
            round: (Number.isInteger(combat.round) ? combat.round : 0) + 1,
            actorId,
            targetId: targetId ?? null,
            action,
            risk: 'low',
            tier: 'surrender',
            roll: null,
            total: null,
            margin: null,
            contract: 'The actor yields; the conflict ends without another roll.',
        };
        let next = applyWorldEvents(state, [{
            type: 'ADD_EVENT',
            summary: `${characterName(state, actorId)} yields, ending the conflict.`,
            actors: [actorId].filter((id) => Boolean(state.characters?.[id])),
            tags: ['combat', 'surrender'],
        }]);
        appendAction(next, record);
        if (state.player?.identity === 'canon'
            && actorId === state.player.characterId
            && state.characters?.[actorId]) {
            next = applyWorldEvents(next, [{
                type: 'SET_STATUS',
                characterId: actorId,
                status: 'captured',
            }]);
        }
        next = finishCombat(next, {
            endReason: 'surrender',
            loserIds: [actorId],
            extra: {
                lastAction: 'surrender',
                lastTier: 'surrender',
                lastMargin: null,
            },
        });
        store.replace(next);
        return {
            ok: true,
            outcome: null,
            action: record,
            ended: true,
            endReason: 'surrender',
            state: store.get(),
        };
    }

    function resolve({
        actorId = null,
        targetId = null,
        action = null,
        attribute,
        skill,
        situational,
        targetDefense,
        roll = null,
        seed = null,
    } = {}) {
        const state = store.get();
        if (!isObject(state)) {
            return failure('no-state', 'No seeded WorldState');
        }
        const combat = state.scene?.combat;
        if (!isObject(combat)) {
            return failure('no-combat', 'No conflict is active');
        }
        const normalized = normalizeCombatAction(action);
        if (!normalized) {
            return failure('invalid-action', `Unknown combat action "${String(action)}"`);
        }
        const participants = Array.isArray(combat.participants) ? combat.participants : [];
        if (!participants.includes(actorId)) {
            return failure('unknown-actor', `"${String(actorId)}" is not a participant`);
        }

        let resolvedTarget = targetId ?? null;
        if (normalized === 'defend') {
            // Defend is always a self-guard; ignore an explicit opponent target.
            resolvedTarget = actorId;
        } else if (normalized !== 'surrender' && !resolvedTarget) {
            return failure('target-required', `Action "${normalized}" requires a target`);
        }
        if (resolvedTarget !== null) {
            if (!participants.includes(resolvedTarget)) {
                return failure('unknown-target', `"${String(resolvedTarget)}" is not a participant`);
            }
            if (resolvedTarget === actorId && normalized !== 'defend') {
                return failure('self-target', `Action "${normalized}" requires a different target`);
            }
        }

        if (normalized === 'surrender') {
            try {
                return surrenderConflict(state, combat, {
                    actorId,
                    targetId: resolvedTarget,
                    action: normalized,
                });
            } catch (error) {
                logWarning(log, 'Combat surrender rejected; state unchanged', error);
                return failure('rejected', error?.message ?? String(error));
            }
        }

        const roundNumber = (Number.isInteger(combat.round) ? combat.round : 0) + 1;
        let result;
        try {
            result = resolveAction({
                seed: seed ?? combat.seed ?? 0,
                round: roundNumber,
                actorId,
                targetId: resolvedTarget,
                action: normalized,
                roll,
                attribute,
                skill,
                situational,
                targetDefense,
            });
        } catch (error) {
            return failure('invalid-input', error?.message ?? String(error));
        }

        let outcome;
        try {
            outcome = buildOutcome(result);
        } catch (error) {
            return failure('invalid-outcome', error?.message ?? String(error));
        }

        // A self-targeted defend is a guard, not damage to the defender.
        const deltaTarget = normalized === 'defend' && resolvedTarget === actorId
            ? null
            : resolvedTarget;
        const record = {
            round: roundNumber,
            actorId,
            targetId: resolvedTarget,
            action: normalized,
            risk: result.risk,
            tier: result.tier,
            roll: result.roll,
            total: result.total,
            margin: result.margin,
            contract: outcome.contract,
        };

        try {
            const deltaEvents = outcomeEvents({
                outcome,
                actorId,
                targetId: deltaTarget,
                state,
            });
            const summaryTarget = resolvedTarget
                ? ` against ${characterName(state, resolvedTarget)}`
                : '';
            const event = {
                type: 'ADD_EVENT',
                summary: `${characterName(state, actorId)} attempts to ${normalized}${summaryTarget} — ${result.tier}.`,
                actors: [actorId, resolvedTarget]
                    .filter((id) => Boolean(id) && Boolean(state.characters?.[id])),
                tags: ['combat'],
            };
            let next = applyWorldEvents(state, [...deltaEvents, event]);
            appendAction(next, record);

            const maxRounds = Number.isInteger(combat.maxRounds)
                ? combat.maxRounds
                : DEFAULT_MAX_ROUNDS;
            const downed = participants.filter((id) => staminaOf(next, id) <= 0);
            let endReason = null;
            if (downed.length > 0) {
                endReason = 'stamina-zero';
            } else if (record.round >= maxRounds) {
                endReason = 'round-cap';
            }

            if (endReason) {
                next = finishCombat(next, {
                    endReason,
                    loserIds: downed,
                    extra: {
                        lastTier: result.tier,
                        lastAction: record.action,
                        lastMargin: record.margin,
                    },
                });
                store.replace(next);
                return {
                    ok: true,
                    outcome,
                    action: record,
                    ended: true,
                    endReason,
                    state: store.get(),
                };
            }

            store.replace(next);
            return {
                ok: true,
                outcome,
                action: record,
                ended: false,
                endReason: null,
                state: store.get(),
            };
        } catch (error) {
            logWarning(log, 'Combat resolution rejected; state unchanged', error);
            return failure('rejected', error?.message ?? String(error));
        }
    }

    function surrender({ characterId = null } = {}) {
        const state = store.get();
        const actorId = characterId ?? defaultActorId(state);
        return resolve({ actorId, action: 'surrender' });
    }

    function end({ reason = 'ended' } = {}) {
        const state = store.get();
        if (!isObject(state?.scene?.combat)) {
            return failure('no-combat', 'No conflict is active');
        }
        try {
            const next = finishCombat(cloneWorldState(state), {
                endReason: typeof reason === 'string' && reason.length > 0 ? reason : 'ended',
            });
            store.replace(next);
            return {
                ok: true,
                ended: true,
                endReason: next.flags?.lastCombat?.endReason ?? reason,
                state: store.get(),
            };
        } catch (error) {
            logWarning(log, 'Combat end rejected; state unchanged', error);
            return failure('rejected', error?.message ?? String(error));
        }
    }

    return {
        start,
        resolve,
        surrender,
        end,
        activeCombat,
        getState: () => store.get(),
    };
}

const FUNCTION_TOOL_NAME = 'neoterra_roll';

function functionToolParameters() {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
            action: { type: 'string', enum: [...COMBAT_ACTIONS] },
            actorId: { type: 'string' },
            targetId: { type: 'string' },
            attribute: { type: 'number' },
            skill: { type: 'number' },
            situational: { type: 'number' },
            targetDefense: { type: 'number' },
            seed: { type: 'number' },
        },
    };
}

function toolStatus(result) {
    if (!result) {
        return JSON.stringify({ ok: false, reason: 'no-combat' });
    }
    return JSON.stringify({
        ok: result.ok === true,
        tier: result.outcome?.tier ?? null,
        contract: result.outcome?.contract ?? null,
        ended: result.ended === true,
        endReason: result.endReason ?? null,
        reason: result.reason ?? null,
    });
}

function parseRollArguments(value) {
    const tokens = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return null;
    }
    const action = normalizeCombatAction(tokens[0]);
    let targetId = null;
    let modifier = 0;
    for (const token of tokens.slice(1)) {
        const numeric = Number(token);
        if (Number.isFinite(numeric)) {
            modifier = numeric;
        } else if (targetId === null) {
            targetId = token;
        }
    }
    return { action, targetId, modifier };
}

/**
 * Register the function tool and `/neoterra-roll` command.
 * Re-registering is safe: any previous registration is removed first.
 */
export function registerCombatIntegrations({
    ctx,
    getCombat = null,
    getSettings = null,
    log = null,
} = {}) {
    if (!ctx || typeof ctx !== 'object') {
        return { ok: false, reason: 'no-context' };
    }
    unregisterCombatIntegrations({ ctx });
    registeredContext = ctx;

    const resolveCombat = typeof getCombat === 'function' ? getCombat : () => null;

    if (typeof ctx.registerFunctionTool === 'function') {
        const tool = {
            name: FUNCTION_TOOL_NAME,
            displayName: 'Neo Terra Roll',
            description: 'Resolve one Neo Terra combat action through the deterministic dice resolver.',
            parameters: functionToolParameters(),
            action: async (args = {}) => {
                try {
                    const flow = resolveCombat();
                    const state = flow?.getState?.() ?? null;
                    const actorId = typeof args.actorId === 'string'
                        ? args.actorId
                        : defaultActorId(state);
                    const result = flow?.resolve?.({
                        actorId,
                        targetId: args.targetId ?? null,
                        action: args.action,
                        attribute: args.attribute,
                        skill: args.skill,
                        situational: args.situational,
                        targetDefense: args.targetDefense,
                        seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : null,
                    });
                    return toolStatus(result);
                } catch (error) {
                    logWarning(log, 'Function tool roll failed', error);
                    return JSON.stringify({
                        ok: false,
                        reason: 'error',
                        error: error?.message ?? String(error),
                    });
                }
            },
        };
        try {
            ctx.registerFunctionTool(tool);
            registeredTool = tool;
        } catch (error) {
            logWarning(log, 'Could not register the neoterra_roll function tool', error);
        }
    }

    const { SlashCommand, SlashCommandParser, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (SlashCommand?.fromProps && SlashCommandParser?.addCommandObject) {
        const command = SlashCommand.fromProps({
            name: 'neoterra-roll',
            callback: async (_args, value) => {
                try {
                    const parsed = parseRollArguments(value);
                    if (!parsed || !parsed.action) {
                        return `Usage: /neoterra-roll <${COMBAT_ACTIONS.join('|')}> [targetId] [modifier]`;
                    }
                    const flow = resolveCombat();
                    const state = flow?.getState?.() ?? null;
                    if (flow?.activeCombat?.()) {
                        const result = flow.resolve({
                            actorId: defaultActorId(state),
                            targetId: parsed.targetId,
                            action: parsed.action,
                            attribute: parsed.modifier,
                        });
                        if (!result?.ok) {
                            return `Combat rejected: ${result?.reason ?? 'unknown'}`;
                        }
                        const tier = result.outcome?.tier ?? result.action?.tier ?? 'resolved';
                        const margin = formatSigned(result.action?.margin);
                        const ended = result.ended ? ` (ended: ${result.endReason})` : '';
                        return `${tier} — margin ${margin}${ended}`;
                    }
                    const die = rollD20({
                        seed: nowSeed(),
                        round: 0,
                        actorId: defaultActorId(state),
                        targetId: parsed.targetId,
                        action: parsed.action,
                    });
                    const total = die + parsed.modifier;
                    return `Seeded d20: ${die} (no active conflict; check ${formatSigned(parsed.modifier)} → ${total})`;
                } catch (error) {
                    logWarning(log, 'Slash command roll failed', error);
                    return `Combat error: ${error?.message ?? String(error)}`;
                }
            },
            helpString: 'Roll a Neo Terra combat action, or a seeded d20 check outside combat.',
            returns: 'result string',
            unnamedArgumentList: SlashCommandArgument?.fromProps
                ? [
                    SlashCommandArgument.fromProps({
                        description: 'action [targetId] [modifier]',
                        isRequired: true,
                        typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : undefined,
                    }),
                ]
                : [],
        });
        try {
            SlashCommandParser.addCommandObject(command);
            registeredCommand = command;
        } catch (error) {
            logWarning(log, 'Could not register /neoterra-roll', error);
        }
    }

    return { ok: true };
}

function nowSeed() {
    try {
        return Date.now();
    } catch {
        return 0;
    }
}

/**
 * Remove the function tool and slash command. Safe to call repeatedly and with
 * a different context than the one used to register.
 */
export function unregisterCombatIntegrations({ ctx } = {}) {
    const context = ctx ?? registeredContext;
    if (registeredTool && context) {
        try {
            if (typeof context.unregisterFunctionTool === 'function') {
                context.unregisterFunctionTool(registeredTool.name);
            }
        } catch (error) {
            logWarning(null, 'Could not unregister the neoterra_roll function tool', error);
        }
    }
    registeredTool = null;

    if (registeredCommand && context) {
        const parser = context.SlashCommandParser;
        const commands = parser?.commands;
        if (commands && typeof commands === 'object') {
            for (const name of [registeredCommand.name, ...(registeredCommand.aliases ?? [])]) {
                if (commands[name] === registeredCommand) {
                    delete commands[name];
                }
            }
        }
    }
    registeredCommand = null;
    registeredContext = null;
    return { ok: true };
}

/** Re-export the tier list for callers that only import the flow. */
export { OUTCOME_TIERS };
