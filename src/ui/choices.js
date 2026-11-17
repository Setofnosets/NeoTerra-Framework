/**
 * Neo Terra CYOA choice chips.
 *
 * The controller is pure: it owns the per-message/per-swipe cache, the
 * exactly-once click guard, and the after-choice loop guard. The DOM layer only
 * renders chips and forwards clicks. Sending a chip uses the caller's `onSend`
 * so the extension never posts to chat itself.
 */

import { createLogger } from '../core/logger.js';
import {
    choicesCacheKey,
    isCombatScene,
    shouldGenerateChoices,
} from '../agents/choices.js';
import { isEndingScreenActive } from '../flows/ending.js';
import { escapeHtml } from './player-panel.js';

const logger = createLogger('choices-ui');

let mounted = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function modeFor(settings, state, requested = null) {
    if (requested === 'combat' || requested === 'exploration') {
        return requested;
    }
    if (isCombatScene(state) && settings?.cyoa?.combatChoices?.enabled === true) {
        return 'combat';
    }
    return 'exploration';
}

/**
 * Create the choices controller used by both the UI and tests.
 *
 * `onSend(label)` is the only side effect: it is called once per click.
 */
export function createChoicesController({
    agent = null,
    getState = () => null,
    getSettings = () => ({}),
    getSeason = () => null,
    onSend = null,
    now = Date.now,
} = {}) {
    const cache = new Map();
    const sent = new Set();
    let lastRequest = null;
    let lastGeneratedAt = 0;
    let regenerateCounter = 0;
    let lastSentMessageIndex = null;
    let current = null;

    function chatIdOf(state) {
        return state?.chatId ?? '';
    }

    function stateSnapshot() {
        try {
            return getState();
        } catch (error) {
            logger.warn('Could not read WorldState for choices', error);
            return null;
        }
    }

    function settingsSnapshot() {
        try {
            return getSettings() ?? {};
        } catch {
            return {};
        }
    }

    function buildView(result, request) {
        const state = stateSnapshot();
        const ending = isEndingScreenActive(state);
        const messageKey = request
            ? choicesCacheKey({
                chatId: chatIdOf(state),
                messageIndex: request.messageIndex,
                swipeId: request.swipeId,
                mode: result?.mode ?? request.mode,
                theme: result?.theme ?? 'auto',
                count: result?.desired ?? 0,
            })
            : null;
        const alreadySent = messageKey ? sent.has(messageKey) : false;
        return {
            visible: Boolean(result?.visible) && !ending && !alreadySent,
            mode: result?.mode ?? request?.mode ?? 'exploration',
            theme: result?.theme ?? 'auto',
            choices: asArray(result?.choices),
            count: asArray(result?.choices).length,
            messageKey,
            regenerate: request?.regenerate ?? 0,
            sent: alreadySent,
            reason: ending ? 'ending' : alreadySent ? 'already-sent' : result?.reason ?? null,
            cacheSize: cache.size,
        };
    }

    async function request({
        messages = [],
        messageIndex = -1,
        swipeId = 0,
        mode = null,
        generationActive = false,
        regenerate = false,
        force = false,
    } = {}) {
        const state = stateSnapshot();
        const settings = settingsSnapshot();
        const season = getSeason();
        const resolvedMode = modeFor(settings, state, mode);
        const lastMessage = asArray(messages).length > 0
            ? asArray(messages)[asArray(messages).length - 1]
            : null;
        const afterChoice = Number.isInteger(lastSentMessageIndex)
            && Number.isInteger(messageIndex)
            && messageIndex <= lastSentMessageIndex;
        const guard = shouldGenerateChoices({
            state,
            settings,
            lastMessage,
            mode: resolvedMode,
            generationActive,
            afterChoice,
            now: now(),
            lastGeneratedAt,
        });

        if (!guard.allowed && force !== true) {
            current = {
                result: {
                    visible: false,
                    choices: [],
                    mode: resolvedMode,
                    reason: guard.reason,
                },
                request: { messages, messageIndex, swipeId, mode: resolvedMode, regenerate: 0 },
            };
            return buildView(current.result, current.request);
        }

        if (regenerate) {
            regenerateCounter += 1;
        }
        const theme = resolvedMode === 'combat'
            ? settings?.cyoa?.combatChoices?.theme ?? 'tactical'
            : settings?.cyoa?.theme ?? 'auto';
        const count = resolvedMode === 'combat'
            ? settings?.cyoa?.combatChoices?.count ?? 4
            : settings?.cyoa?.count ?? 4;
        const key = choicesCacheKey({
            chatId: chatIdOf(state),
            messageIndex,
            swipeId,
            mode: resolvedMode,
            theme,
            count,
            regenerate: regenerateCounter,
        });

        const requestContext = {
            messages,
            messageIndex,
            swipeId,
            mode: resolvedMode,
            regenerate: regenerateCounter,
            theme,
            count,
        };

        if (!regenerate && cache.has(key)) {
            current = { result: cache.get(key), request: requestContext };
            return buildView(cache.get(key), requestContext);
        }

        let result;
        if (!agent || typeof agent.run !== 'function') {
            result = { visible: false, choices: [], mode: resolvedMode, reason: 'no-agent' };
        } else {
            result = await agent.run({
                state,
                season,
                recentMessages: messages,
                lastMessage,
                settings,
                mode: resolvedMode,
                theme,
                count,
                force: force === true,
            });
        }
        lastGeneratedAt = now();
        lastRequest = requestContext;
        cache.set(key, result);
        // Cache the same result for the swipe/theme/count without a regenerate
        // counter so a re-render does not call the model again.
        cache.set(choicesCacheKey({
            chatId: chatIdOf(state),
            messageIndex,
            swipeId,
            mode: resolvedMode,
            theme,
            count,
        }), result);
        current = { result, request: requestContext };
        return buildView(result, requestContext);
    }

    function choose(index) {
        const view = current ? buildView(current.result, current.request) : null;
        if (!view?.visible) {
            return false;
        }
        const choice = view.choices[index];
        if (!choice || typeof choice.label !== 'string') {
            return false;
        }
        const messageKey = view.messageKey;
        if (messageKey && sent.has(messageKey)) {
            return false;
        }
        if (messageKey) {
            sent.add(messageKey);
        }
        lastSentMessageIndex = Number.isInteger(current?.request?.messageIndex)
            ? current.request.messageIndex
            : null;
        if (typeof onSend === 'function') {
            onSend(choice.label, choice);
        }
        // The row is hidden immediately; the caller repaints from this view.
        current = {
            ...current,
            result: { ...current.result, visible: false },
        };
        return true;
    }

    function regenerate() {
        if (!lastRequest) {
            return null;
        }
        return request({ ...lastRequest, regenerate: true, force: true });
    }

    function getView() {
        if (!current) {
            return {
                visible: false,
                choices: [],
                count: 0,
                mode: 'exploration',
                theme: 'auto',
                messageKey: null,
                regenerate: 0,
                sent: false,
                reason: 'idle',
                cacheSize: cache.size,
            };
        }
        return buildView(current.result, current.request);
    }

    function clearCache() {
        cache.clear();
        sent.clear();
        lastSentMessageIndex = null;
        current = null;
    }

    return {
        request,
        choose,
        regenerate,
        getView,
        clearCache,
        getCacheSize: () => cache.size,
    };
}

export function renderChoicesMarkup(view) {
    if (!view?.visible || asArray(view.choices).length === 0) {
        return '';
    }
    const chips = view.choices.map((choice, index) => {
        const risk = choice.risk
            ? `<span class="neoterra-choice-risk" data-risk="${escapeHtml(choice.risk)}">${escapeHtml(choice.risk)}</span>`
            : '';
        const action = choice.action
            ? `<span class="neoterra-choice-action">${escapeHtml(choice.action)}</span>`
            : '';
        return `<button type="button" class="neoterra-choice-chip menu_button"
            data-neoterra-choice-index="${index}"
            data-neoterra-choice-action="${escapeHtml(choice.action ?? '')}"
            data-neoterra-choice-risk="${escapeHtml(choice.risk ?? '')}"
            title="${escapeHtml(choice.tone ?? choice.intent ?? '')}">
            ${escapeHtml(choice.label)}
            ${risk}${action}
        </button>`;
    }).join('');
    return `
    <div class="neoterra-choices" data-neoterra-choices data-mode="${escapeHtml(view.mode)}">
        <div class="neoterra-choice-row" role="group" aria-label="Suggested actions">${chips}</div>
        <div class="neoterra-choice-actions">
            <button type="button" class="menu_button" data-neoterra-choice-regenerate>Regenerate</button>
            <button type="button" class="menu_button" data-neoterra-choice-write>Write my own</button>
        </div>
    </div>`;
}

/**
 * Mount a chips row into a host element. The controller owns all generation;
 * this layer only paints and forwards clicks.
 */
export function mountChoicesBar({ root, controller } = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountChoicesBar requires a root element');
    }
    if (!controller || typeof controller.getView !== 'function') {
        throw new TypeError('mountChoicesBar requires a choices controller');
    }
    disposeChoicesBar();
    const abort = new AbortController();
    const state = { root, controller, abort };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const view = controller.getView();
        root.innerHTML = renderChoicesMarkup(view);
    };

    root.addEventListener('click', async (event) => {
        const chip = event.target.closest?.('[data-neoterra-choice-index]');
        if (chip) {
            const index = Number(chip.dataset.neoterraChoiceIndex);
            if (Number.isInteger(index)) {
                controller.choose(index);
                paint();
            }
            return;
        }
        if (event.target.closest?.('[data-neoterra-choice-regenerate]')) {
            paint();
            const result = controller.regenerate();
            if (result && typeof result.then === 'function') {
                await result;
            }
            paint();
            return;
        }
        if (event.target.closest?.('[data-neoterra-choice-write]')) {
            const input = document.getElementById('send_textarea');
            input?.focus?.();
        }
    }, { signal: abort.signal });

    root.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
        }
        const chips = [...root.querySelectorAll('[data-neoterra-choice-index]')];
        const index = chips.indexOf(document.activeElement);
        if (index === -1 || chips.length === 0) {
            return;
        }
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        chips[(index + delta + chips.length) % chips.length]?.focus?.();
    }, { signal: abort.signal });

    paint();
    return { refresh: paint };
}

export function disposeChoicesBar() {
    if (!mounted) {
        return;
    }
    mounted.abort?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
