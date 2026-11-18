/**
 * In-chat scene message writer.
 *
 * Neo Terra's world state lives in `chatMetadata` and reaches the model through
 * `neoTerraGenerateInterceptor`, which renders it into the prompt copy only.
 * The chat is reserved for scene narration: an opening frame, a travel arrival,
 * an encounter, a combat resolution. Those frames are ordinary assistant
 * messages (`is_user` and `is_system` both false) so they stay in SillyTavern's
 * generation history and the model can refer to them.
 *
 * This module owns the message shape, the dedupe rule, and the one write path.
 * It never touches the DOM and never copies `WorldState` into a message.
 */

import { createLogger } from '../core/logger.js';

const logger = createLogger('chat-output');

/** Author shown for every Neo Terra scene frame. */
export const SCENE_MESSAGE_NAME = 'Neo Terra';

/** Scene frame kinds. */
export const SCENE_KINDS = Object.freeze({
    OPENING: 'opening',
    TRAVEL: 'travel',
    ENCOUNTER: 'encounter',
    COMBAT: 'combat',
    RESOLUTION: 'resolution',
});

/** Avatar shown next to a scene frame (bundled with the extension). */
export const SCENE_AVATAR_URL = new URL('../../assets/neoterra-avatar.svg', import.meta.url).href;

const CONTEXT_BLOCK_PATTERN = /\[NEOTERRA_[A-Z_]+\][\s\S]*?(?=\n\[NEOTERRA_[A-Z_]+\]|$)/g;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Scene text must never carry prompt blocks. The interceptor owns context
 * injection, so any block that slips into a frame is stripped defensively.
 */
export function stripContextBlocks(text) {
    return String(text ?? '')
        .replace(CONTEXT_BLOCK_PATTERN, '')
        .replace(/\[NEOTERRA_[A-Z_]+\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Join the non-empty parts of a dedupe key (`null`/blank parts are dropped). */
export function buildSceneKey(...parts) {
    const values = parts
        .flat()
        .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
        .filter((part) => part.length > 0);
    return values.join(':');
}

/**
 * Build a SillyTavern message object for a scene frame.
 *
 * @param {{
 *   kind: string,
 *   text: string,
 *   key?: string|null,
 *   extra?: object,
 *   now?: number|Date,
 * }} options
 */
export function buildSceneChatMessage({
    kind,
    text,
    key = null,
    extra = {},
    now = Date.now,
} = {}) {
    const sceneKind = typeof kind === 'string' && kind.length > 0 ? kind : 'scene';
    const date = typeof now === 'function' ? now() : now;
    const timestamp = date instanceof Date ? date : new Date(date);
    const scene = {
        kind: sceneKind,
        key: typeof key === 'string' && key.length > 0 ? key : null,
        ...(isObject(extra) ? extra : {}),
    };
    return {
        name: SCENE_MESSAGE_NAME,
        is_user: false,
        // ST filters system messages out of the generation history; a scene
        // frame must be visible to the model, so this stays false.
        is_system: false,
        send_date: (Number.isNaN(timestamp.getTime()) ? new Date() : timestamp).toISOString(),
        mes: stripContextBlocks(text),
        force_avatar: SCENE_AVATAR_URL,
        extra: { neoterra: { scene } },
    };
}

/** The `extra.neoterra.scene` record of a chat message, or null. */
export function readSceneExtra(message) {
    const scene = message?.extra?.neoterra?.scene;
    return isObject(scene) ? scene : null;
}

/** The dedupe key of a chat message, or null. */
export function sceneKeyOf(message) {
    const scene = readSceneExtra(message);
    return typeof scene?.key === 'string' && scene.key.length > 0 ? scene.key : null;
}

/** True for a message this extension posted as a scene frame. */
export function isSceneMessage(message) {
    return readSceneExtra(message) !== null;
}

/**
 * Does this chat already contain story turns? The character-card greeting (the
 * single first message) does not count; a user message or a second assistant
 * message does. Auto-kickoff only fires on a fresh chat.
 *
 * Assumption: index 0 is the card greeting. A chat whose greeting was deleted
 * can therefore look fresh; the kickoff is a single editable prompt, so the
 * cost of that false positive is one send, not a state change.
 */
export function hasStoryHistory(messages) {
    if (!Array.isArray(messages)) {
        return false;
    }
    return messages.some((message, index) => {
        if (!message || isSceneMessage(message)) {
            return false;
        }
        if (message.is_user === true) {
            return true;
        }
        // The first assistant message is the card greeting.
        return index > 0;
    });
}

/** Dedupe key for a season opening frame. */
export function buildOpeningSceneKey({ chatId, seasonId, turn } = {}) {
    return buildSceneKey('opening', chatId, seasonId, turn ?? 0);
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text.length > 0) {
            return text;
        }
    }
    return '';
}

const NEUTRAL_GOALS = 'No goals are recorded yet — set your own course.';
const NEUTRAL_SITUATION = 'The city is quiet. Nothing has happened yet.';

/**
 * The "your move" kickoff block appended to the season opening frame.
 *
 * Deterministic and short: what season started, who the player is, their goals,
 * the current situation, and the explicit invitation to act. This is the start
 * signal the chat was missing.
 */
export function buildKickoffLines({ state, season, opening = null } = {}) {
    const player = state?.player ?? {};
    const canon = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    const playerName = firstNonEmpty(
        opening?.playerName,
        player.displayName,
        canon?.displayName,
        'The Player',
    );
    const role = firstNonEmpty(
        opening?.playerRole,
        state?.playerRole,
        season?.playerRole,
        'neutral',
    );
    const locationId = state?.scene?.locationId ?? season?.startLocationId ?? null;
    const locationName = firstNonEmpty(
        locationId ? state?.locations?.[locationId]?.name : '',
        opening?.locationName,
        locationId,
        'an unrecorded part of the city',
    );
    const goals = firstNonEmpty(
        Array.isArray(canon?.goals) ? canon.goals.filter(Boolean).join('; ') : '',
        Array.isArray(player.goals) ? player.goals.filter(Boolean).join('; ') : '',
        player.agenda,
        NEUTRAL_GOALS,
    );
    const threat = (Array.isArray(state?.threats) ? state.threats : [])
        .find((entry) => entry && typeof entry.name === 'string' && entry.status === 'active') ?? null;
    const situation = firstNonEmpty(
        state?.scene?.framing,
        threat?.agenda ? `${threat.name}: ${threat.agenda}` : '',
        threat?.name ? `${threat.name} is active.` : '',
        season?.premise,
        NEUTRAL_SITUATION,
    );
    const title = firstNonEmpty(opening?.title, season?.title, state?.seasonId, 'Neo Terra');

    return [
        `Season started — ${title}`,
        `You are ${playerName}, ${role}, at ${locationName}.`,
        `Goals: ${goals}`,
        `Current situation: ${situation}`,
        'Current action: none yet — the opening is yours.',
        'Your move: describe your first action, or pick a suggestion below.',
    ];
}

/** Opening frame text: the deterministic opening scene, then the kickoff block. */
export function buildOpeningFrameText({ state, season, opening } = {}) {
    const openingText = typeof opening?.text === 'string' ? opening.text.trim() : '';
    const kickoff = buildKickoffLines({ state, season, opening }).join('\n');
    return openingText.length > 0 ? `${openingText}\n\n${kickoff}` : kickoff;
}

/** Index of the last message in the chat array, or -1. */
function lastIndex(messages) {
    return Array.isArray(messages) ? messages.length - 1 : -1;
}

/**
 * Mark the rendered message element so the stylesheet can distinguish a scene
 * frame from the narrator's prose. Best-effort: a missing DOM is fine, and a
 * renderer that paints on a later frame gets one retry.
 */
function markSceneMessage(index, { retry = true } = {}) {
    if (typeof document === 'undefined' || !Number.isInteger(index)) {
        return false;
    }
    try {
        const element = document.querySelector(`.mes[mesid="${index}"]`);
        if (!element) {
            if (retry && typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => markSceneMessage(index, { retry: false }));
            }
            return false;
        }
        element.classList.add('neoterra-scene-message');
        return true;
    } catch (error) {
        logger.debug('Could not mark the scene message element', error);
        return false;
    }
}

/**
 * Post one scene frame, once per dedupe key.
 *
 * The frame is appended to `ctx.chat` and rendered with `ctx.addOneMessage`
 * (which only paints; ST's own send path owns generation). A repeated key posts
 * nothing, so a double `MAP_UPDATED`, a remount, or a swipe cannot duplicate
 * the frame.
 *
 * Never throws: a missing chat/addOneMessage/saveChat yields
 * `{ posted: false, reason }`.
 *
 * @returns {{ posted: boolean, index: number|null, reason?: string, deduped?: boolean }}
 */
export async function postSceneMessage(ctx, message, { dedupeKey = null } = {}) {
    if (!isObject(message) || typeof message.mes !== 'string') {
        return { posted: false, index: null, reason: 'invalid-message' };
    }
    const messages = Array.isArray(ctx?.chat) ? ctx.chat : null;
    if (!messages) {
        return { posted: false, index: null, reason: 'no-chat' };
    }
    const key = typeof dedupeKey === 'string' && dedupeKey.length > 0
        ? dedupeKey
        : sceneKeyOf(message);
    const previous = messages[lastIndex(messages)] ?? null;
    const previousKey = sceneKeyOf(previous);
    if (key && previousKey && key === previousKey) {
        return { posted: false, index: lastIndex(messages), reason: 'duplicate', deduped: true };
    }

    try {
        messages.push(message);
    } catch (error) {
        logger.warn('Could not append the Neo Terra scene frame', error);
        return { posted: false, index: null, reason: 'append-failed' };
    }
    const index = lastIndex(messages);

    if (typeof ctx?.addOneMessage !== 'function') {
        // The message is in the chat array but unrendered: a reload will show
        // it, so this is a partial success.
        return { posted: true, index, reason: 'not-rendered' };
    }
    try {
        ctx.addOneMessage(message);
    } catch (error) {
        logger.warn('Could not render the Neo Terra scene frame', error);
        return { posted: true, index, reason: 'render-failed' };
    }
    markSceneMessage(index);

    try {
        const saving = typeof ctx?.saveChat === 'function' ? ctx.saveChat() : null;
        if (saving && typeof saving.then === 'function') {
            await saving;
        }
    } catch (error) {
        logger.warn('Could not save the chat after posting a scene frame', error);
        return { posted: true, index, reason: 'save-failed' };
    }
    return { posted: true, index };
}
