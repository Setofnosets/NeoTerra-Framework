/**
 * Encounter bar: a small row above the input that turns the persisted
 * `scene.encounter` into explicit Engage / Talk / Avoid actions, and offers
 * Surrender / End while a conflict is active.
 *
 * The pure helpers own every decision (which actions are valid, the avoided
 * marker, the combat start payload, the frame prose); the DOM layer only paints
 * and forwards clicks. No WorldState ever reaches the chat from here: the shell
 * posts the prose frames built by `buildCombatStartFrameText` /
 * `buildCombatResolutionFrameText`.
 */

import { createLogger } from '../core/logger.js';
import { encounterKey, isCombatActive } from '../flows/encounter.js';
import { SCENE_KINDS, buildSceneChatMessage, buildSceneKey } from './chat-output.js';

const logger = createLogger('encounter-bar');

const ENGAGE_DISABLED_REASON = 'No individual opponent — resolve this in prose.';
const DEFAULT_STAKES = 'No retreat — this confrontation is settled here.';

/** Module-level mount mirroring `disposeChoicesBar`. */
let mounted = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function asStringList(value) {
    return Array.isArray(value)
        ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))]
        : [];
}

/** Display name for a combatant id; `'player'` only means a custom persona. */
function characterName(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return state?.player?.displayName ?? 'The Player';
    }
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function locationNameOf(state, locationId) {
    const name = locationId ? state?.locations?.[locationId]?.name : null;
    return name ?? locationId ?? 'here';
}

/**
 * Deterministic stakes string: prose only, no numbers, no invented outcome.
 * The start frame already names the opponents and the location, so the stakes
 * stay general instead of repeating them.
 */
function defaultDeterministicStakes(state, encounter) {
    void state;
    void encounter;
    return DEFAULT_STAKES;
}

/**
 * The combat actor for this WorldState: the canon character id for a canon
 * player, otherwise the synthetic `'player'` persona.
 */
export function encounterActorId(state) {
    if (state?.player?.identity === 'canon' && typeof state.player.characterId === 'string') {
        return state.player.characterId;
    }
    return 'player';
}

/**
 * Recover the encounter identity from an active conflict. `detectEncounter`
 * clears `scene.encounter` while combat runs, so the resolution path must not
 * rely on it to remember which encounter it is dismissing.
 */
export function encounterFromCombat(state) {
    const combat = isObject(state?.scene?.combat) ? state.scene.combat : null;
    if (!combat) {
        return null;
    }
    const actorId = encounterActorId(state);
    const characterIds = asStringList(combat.participants)
        .filter((characterId) => characterId !== actorId);
    if (characterIds.length === 0) {
        return null;
    }
    return {
        locationId: combat.locationId ?? state?.scene?.locationId ?? null,
        characterIds,
        threatNames: [],
        source: 'scene',
    };
}

/**
 * Pure model for the bar.
 *
 * @returns {{visible: false}|{
 *   visible: true,
 *   mode: 'combat',
 *   encounter: null,
 *   combat: object|null,
 *   key: null,
 *   actions: Array<{id: string, label: string, enabled: boolean, reason?: string|null}>,
 * }|{
 *   visible: true,
 *   mode: 'encounter',
 *   encounter: object,
 *   key: string,
 *   locationId: string|null,
 *   actions: Array<{id: string, label: string, enabled: boolean, reason?: string|null}>,
 * }}
 */
export function buildEncounterBarModel(options = {}) {
    const { state, settings = {} } = isObject(options) ? options : {};
    void settings;
    try {
        if (!isObject(state)) {
            return { visible: false };
        }
        const combat = isObject(state.scene?.combat) ? state.scene.combat : null;
        if (isCombatActive(state) || combat) {
            return {
                visible: true,
                mode: 'combat',
                encounter: null,
                combat,
                key: null,
                actions: [
                    { id: 'surrender', label: 'Surrender', enabled: true },
                    { id: 'end', label: 'End combat', enabled: true },
                ],
            };
        }
        const encounter = isObject(state.scene?.encounter) ? state.scene.encounter : null;
        if (!encounter) {
            return { visible: false };
        }
        const key = encounterKey(encounter);
        if (!key) {
            return { visible: false };
        }
        // A stale record after a failed cast refresh names hostiles who are not
        // here; never offer a fight against an absent character.
        if (typeof encounter.locationId === 'string'
            && typeof state.scene?.locationId === 'string'
            && encounter.locationId !== state.scene.locationId) {
            return { visible: false, encounter, key, reason: 'stale-location' };
        }
        if (state.flags?.encounter?.avoidedKey === key) {
            return { visible: false, encounter, key, reason: 'avoided' };
        }
        const actorId = encounterActorId(state);
        const characterIds = asStringList(encounter.characterIds)
            .filter((characterId) => characterId !== actorId);
        const engageEnabled = characterIds.length > 0;
        return {
            visible: true,
            mode: 'encounter',
            encounter,
            key,
            locationId: encounter.locationId ?? state.scene?.locationId ?? null,
            actions: [
                {
                    id: 'engage',
                    label: 'Engage',
                    enabled: engageEnabled,
                    reason: engageEnabled ? null : ENGAGE_DISABLED_REASON,
                },
                { id: 'talk', label: 'Talk', enabled: true },
                { id: 'avoid', label: 'Avoid', enabled: true },
            ],
        };
    } catch (error) {
        logger.debug('Could not build the encounter bar model', error);
        return { visible: false };
    }
}

/**
 * Record the dismissed encounter in `flags.encounter.avoidedKey` so a refresh
 * (or a rebuilt runtime) does not prompt for it again. The persisted
 * `scene.encounter` is left untouched. Returns the next state, or null.
 */
export function avoidEncounter(store, encounter, { now = Date.now } = {}) {
    const key = encounterKey(encounter);
    if (!key) {
        return null;
    }
    try {
        const state = store?.get?.();
        if (!isObject(state)) {
            return null;
        }
        const flags = isObject(state.flags) ? state.flags : {};
        const next = {
            ...state,
            flags: {
                ...flags,
                encounter: {
                    ...(isObject(flags.encounter) ? flags.encounter : {}),
                    avoidedKey: key,
                    avoidedAt: now(),
                },
            },
        };
        store.replace(next);
        return next;
    } catch (error) {
        logger.warn('Could not record the avoided encounter', error);
        return null;
    }
}

/**
 * Start combat for the persisted encounter, deterministically and exactly once.
 * A threat-only encounter (no hostile character ids) never calls the flow.
 */
export function startEncounterCombat({
    flow,
    state,
    encounter,
    kind = 'skirmish',
    stakes = '',
} = {}) {
    try {
        if (!flow || typeof flow.start !== 'function') {
            return { ok: false, reason: 'no-flow', message: 'No combat flow is available.' };
        }
        const actorId = encounterActorId(state);
        const hostiles = asStringList(encounter?.characterIds)
            .filter((characterId) => characterId !== actorId);
        if (hostiles.length === 0) {
            return {
                ok: false,
                reason: 'threat-only',
                message: ENGAGE_DISABLED_REASON,
            };
        }
        const participants = [actorId, ...hostiles];
        const sides = {
            [actorId]: 'a',
            ...Object.fromEntries(hostiles.map((characterId) => [characterId, 'b'])),
        };
        const locationId = encounter?.locationId ?? state?.scene?.locationId ?? null;
        const resolvedStakes = typeof stakes === 'string' && stakes.trim().length > 0
            ? stakes.trim()
            : defaultDeterministicStakes(state, encounter);
        const result = flow.start({
            participants,
            sides,
            locationId,
            kind,
            stakes: resolvedStakes,
            intent: `Encounter at ${locationNameOf(state, locationId)}.`,
        });
        if (!result?.ok) {
            return {
                ok: false,
                reason: result?.reason ?? 'rejected',
                message: result?.message ?? result?.reason ?? 'The conflict could not start.',
            };
        }
        const combat = result.combat
            ?? flow.getState?.()?.scene?.combat
            ?? null;
        return {
            ok: true,
            participants,
            sides,
            locationId,
            stakes: resolvedStakes,
            combat,
            text: buildCombatStartFrameText({
                state,
                participants,
                locationId,
                stakes: resolvedStakes,
            }),
        };
    } catch (error) {
        return {
            ok: false,
            reason: 'error',
            message: error?.message ?? String(error),
        };
    }
}

/**
 * Engage an encounter end to end: start once, post one combat frame, then
 * request combat choices. The caller supplies the post/choices seams so this is
 * testable without a DOM. A failed start never posts anything.
 */
export async function engageEncounter({
    flow,
    state,
    encounter,
    chatId = null,
    post = null,
    requestChoices = null,
    onPosted = null,
    now = Date.now,
} = {}) {
    const started = startEncounterCombat({ flow, state, encounter });
    if (!started.ok) {
        return started;
    }
    const key = buildSceneKey(
        'combat',
        chatId,
        started.combat?.id ?? started.participants.join('-'),
    );
    const message = buildSceneChatMessage({
        kind: SCENE_KINDS.COMBAT,
        text: started.text,
        key,
        extra: {
            participants: started.participants,
            locationId: started.locationId,
        },
        now,
    });
    if (typeof post !== 'function') {
        return { ...started, key, message, posted: null };
    }
    const posted = await post(message, key);
    try {
        onPosted?.(posted, started);
    } catch (error) {
        logger.warn('Could not announce the combat start', error);
    }
    if ((posted?.posted || posted?.deduped) && typeof requestChoices === 'function') {
        try {
            await requestChoices(posted.index);
        } catch (error) {
            logger.warn('Could not request combat choices', error);
        }
    }
    return { ...started, key, message, posted };
}

/** Yield the active conflict through the flow. Never throws. */
export function surrenderEncounterCombat(flow) {
    if (!flow || typeof flow.surrender !== 'function') {
        return { ok: false, reason: 'no-flow' };
    }
    try {
        return flow.surrender() ?? { ok: false, reason: 'no-flow' };
    } catch (error) {
        return { ok: false, reason: 'error', message: error?.message ?? String(error) };
    }
}
/** End the active conflict through the flow. Never throws. */
export function endEncounterCombat(flow, { reason = 'scene-end' } = {}) {
    if (!flow || typeof flow.end !== 'function') {
        return { ok: false, reason: 'no-flow' };
    }
    try {
        return flow.end({ reason }) ?? { ok: false, reason: 'no-flow' };
    } catch (error) {
        return { ok: false, reason: 'error', message: error?.message ?? String(error) };
    }
}

/**
 * One short deterministic frame: location, player, and opponent names only.
 * No numbers, tiers, or invented outcome.
 */
export function buildCombatStartFrameText({ state, participants, locationId, stakes = '' } = {}) {
    const ids = Array.isArray(participants) ? participants : [];
    const actorId = ids[0] ?? 'player';
    const playerName = characterName(state, actorId);
    const names = ids.slice(1).map((characterId) => characterName(state, characterId));
    const opponents = names.length > 0 ? names.join(', ') : 'an unseen threat';
    const header = `Combat begins at ${locationNameOf(state, locationId)}: ${playerName} against ${opponents}.`;
    const stakesText = typeof stakes === 'string' ? stakes.trim() : '';
    if (stakesText.length === 0) {
        return header;
    }
    const stakesLine = /[.!?]$/.test(stakesText) ? stakesText : `${stakesText}.`;
    return `${header}\n\nStakes: ${stakesLine}`;
}

/** One short deterministic resolution frame; adds the recorded summary when it differs. */
export function buildCombatResolutionFrameText({ state, result } = {}) {
    const lastCombat = isObject(state?.flags?.lastCombat) ? state.flags.lastCombat : null;
    const endReason = [result?.endReason, lastCombat?.endReason, 'resolved']
        .find((value) => typeof value === 'string' && value.trim().length > 0)
        .trim();
    const header = `Combat ends — ${endReason}.`;
    const summary = typeof lastCombat?.summary === 'string' ? lastCombat.summary.trim() : '';
    if (summary.length === 0 || summary === endReason || summary === header) {
        return header;
    }
    return `${header}\n\n${summary}`;
}

function encounterBarMarkup() {
    return `
    <div class="neoterra-encounter-bar" data-neoterra-encounter-bar hidden>
        <span class="neoterra-encounter-title" data-neoterra-encounter-title>Encounter</span>
        <div class="neoterra-encounter-actions" role="group" aria-label="Encounter actions">
            <button type="button" class="menu_button" data-neoterra-encounter-action="engage" hidden>Engage</button>
            <button type="button" class="menu_button" data-neoterra-encounter-action="talk" hidden>Talk</button>
            <button type="button" class="menu_button" data-neoterra-encounter-action="avoid" hidden>Avoid</button>
            <button type="button" class="menu_button" data-neoterra-encounter-action="surrender" hidden>Surrender</button>
            <button type="button" class="menu_button" data-neoterra-encounter-action="end" hidden>End combat</button>
        </div>
        <p class="neoterra-encounter-reason" data-neoterra-encounter-reason hidden></p>
        <p class="neoterra-encounter-status" role="status" aria-live="polite"
            data-neoterra-encounter-status hidden></p>
    </div>`;
}

/**
 * Mount the encounter bar into a host element. The DOM layer writes no state;
 * every click is forwarded once through `onAction(actionId)`.
 */
export function mountEncounterBar({ root, onAction } = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountEncounterBar requires a root element');
    }
    disposeEncounterBar();
    const abort = new AbortController();
    const state = { root, abort, inFlight: false };
    mounted = state;
    root.innerHTML = encounterBarMarkup();

    const bar = root.querySelector('[data-neoterra-encounter-bar]');
    const title = root.querySelector('[data-neoterra-encounter-title]');
    const reasonLine = root.querySelector('[data-neoterra-encounter-reason]');
    const statusLine = root.querySelector('[data-neoterra-encounter-status]');

    const refresh = (model) => {
        if (mounted !== state) {
            return;
        }
        state.inFlight = false;
        if (!model?.visible) {
            root.hidden = true;
            if (bar) {
                bar.hidden = true;
            }
            return;
        }
        root.hidden = false;
        if (bar) {
            bar.hidden = false;
        }
        if (title) {
            title.textContent = model.mode === 'combat' ? 'Combat' : 'Encounter';
        }
        const actions = Array.isArray(model.actions) ? model.actions : [];
        let disabledReason = '';
        for (const button of root.querySelectorAll('[data-neoterra-encounter-action]')) {
            const actionId = button.dataset.neoterraEncounterAction;
            const action = actions.find((entry) => entry?.id === actionId) ?? null;
            button.hidden = !action;
            button.disabled = !action || action.enabled === false;
            if (action?.label) {
                button.textContent = action.label;
            }
            const reason = typeof action?.reason === 'string' ? action.reason : '';
            button.title = reason;
            if (reason && !disabledReason) {
                disabledReason = reason;
            }
        }
        if (reasonLine) {
            reasonLine.textContent = disabledReason;
            reasonLine.hidden = disabledReason.length === 0;
        }
    };

    const setStatus = (text, tone = 'info') => {
        if (mounted !== state) {
            return;
        }
        state.inFlight = false;
        if (!statusLine) {
            return;
        }
        statusLine.textContent = text ?? '';
        statusLine.dataset.tone = tone;
        statusLine.hidden = !text;
    };

    root.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-neoterra-encounter-action]');
        if (!button || button.hidden || button.disabled) {
            return;
        }
        const actionId = button.dataset.neoterraEncounterAction;
        if (!actionId || state.inFlight) {
            return;
        }
        state.inFlight = true;
        try {
            const result = onAction?.(actionId);
            if (result && typeof result.then === 'function') {
                result
                    .catch((error) => logger.warn('Encounter action failed', error))
                    .finally(() => {
                        state.inFlight = false;
                    });
            }
        } catch (error) {
            state.inFlight = false;
            logger.warn('Encounter action failed', error);
        }
    }, { signal: abort.signal });

    return {
        root,
        refresh,
        setStatus,
        dispose: () => {
            if (mounted === state) {
                disposeEncounterBar();
            }
        },
    };
}

/** Remove the mounted bar markup and abort its listener. Safe to call twice. */
export function disposeEncounterBar() {
    if (!mounted) {
        return;
    }
    mounted.abort?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
