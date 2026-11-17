/**
 * Neo Terra shell: top-right entry button, floating tabbed panel, slash command,
 * and the debug API exposed on `window.NeoTerra`.
 *
 * The shell is intentionally thin in Step 1. Each tab is a placeholder that
 * later steps fill in; the shell owns mount/unmount, focus, and tab state.
 */

import {
    EXTENSION_NAME,
    EXTENSION_VERSION,
    SHELL_TABS,
    UI_IDS,
} from '../core/constants.js';
import { bus, EVENTS } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { getSettings, resetSettings } from '../core/settings.js';
import { mountSeasonMenu, disposeSeasonMenu } from './season-menu.js';
import { disposeSettingsPanel, mountSettingsPanel, refreshSettingsPanel } from './settings.js';
import { disposeMapPanel, mountMapPanel } from './map-panel.js';
import { disposeCodex, mountCodex } from './codex.js';
import { loadRegistry } from '../data/registry.js';
import { loadFormGroups, loadFormRules } from '../data/forms.js';
import { createWorldBookAdapter } from '../context/worldbook.js';
import { createWorldStateStore, WAL_PREFIX } from '../state/store.js';
import { createTravelFlow, attachTravelToMessage } from '../flows/travel.js';
import { createSceneFlow } from '../flows/scene.js';
import { createInitiative } from '../flows/initiative.js';
import { createStorylineTracker } from '../agents/storyline.js';
import { createEpilogueAgent } from '../agents/epilogue.js';
import { createChoicesAgent } from '../agents/choices.js';
import { createAgentClient } from '../agents/client.js';
import { createAgentRunner } from '../agents/runner.js';
import { createEndingFlow, isEndingScreenActive } from '../flows/ending.js';
import { mountEndingPanel, disposeEndingPanel } from './ending.js';
import { createChoicesController, mountChoicesBar, disposeChoicesBar } from './choices.js';
import {
    createCombatFlow,
    registerCombatIntegrations,
    unregisterCombatIntegrations,
} from '../combat/combat-state.js';

const logger = createLogger('shell');

const TAB_PLACEHOLDERS = Object.freeze({
    season: {
        title: 'Season',
        body: 'Choose a season to construct a world.',
    },
    map: {
        title: 'Map',
        body: 'The city map, districts, and travel controls will appear here.',
    },
    characters: {
        title: 'Characters',
        body: 'The character codex and live cast will appear here.',
    },
    player: {
        title: 'Player',
        body: 'The player sheet, identity, and current form will appear here.',
    },
    settings: {
        title: 'Settings',
        body: 'Global Neo Terra settings live in the Extensions settings panel. Chat worlds keep their own state.',
    },
});

/** Tabs whose panel is a live mountable component instead of a placeholder. */
const LIVE_PANELS = new Set(['season', 'map', 'characters']);

let ctx = null;
let abort = null;
let mounted = false;
let mounting = null;
let mountGeneration = 0;
let registeredCommand = null;
let activeTab = 'season';
let previousFocus = null;
let mapMounted = false;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function getContext() {
    if (ctx) {
        return ctx;
    }
    return refreshContext();
}

/** Re-read the live context; chat switches change `chatId`/`chatMetadata`. */
function refreshContext() {
    try {
        ctx = globalThis.SillyTavern?.getContext?.() ?? ctx;
    } catch (error) {
        logger.warn('Could not read SillyTavern context', error);
    }
    return ctx;
}

function shellMarkup() {
    const tabs = SHELL_TABS.map(tab => `
        <button type="button" role="tab" class="neoterra-tab" id="neoterra-tab-${tab.id}"
            data-neoterra-tab="${tab.id}" aria-controls="neoterra-panel-${tab.id}"
            aria-selected="${tab.id === activeTab ? 'true' : 'false'}"
            tabindex="${tab.id === activeTab ? '0' : '-1'}">${tab.label}</button>`).join('');

    const panels = SHELL_TABS.map(tab => {
        const placeholder = TAB_PLACEHOLDERS[tab.id];
        const live = LIVE_PANELS.has(tab.id);
        return `
        <section class="neoterra-panel${live ? ' is-live' : ''}" id="neoterra-panel-${tab.id}" role="tabpanel"
            data-neoterra-panel="${tab.id}" aria-labelledby="neoterra-tab-${tab.id}"
            ${tab.id === activeTab ? '' : 'hidden'}>
            ${live ? '' : `<h3 class="neoterra-panel-title">${placeholder.title}</h3>`}
            <p class="neoterra-placeholder" ${live ? 'hidden' : ''}>${placeholder.body}</p>
            ${tab.id === 'map' ? '<div class="neoterra-map-host" data-neoterra-map-host></div>' : ''}
            ${tab.id === 'season' ? '<div class="neoterra-season-host" data-neoterra-season-host></div>' : ''}
            ${tab.id === 'characters' ? '<div class="neoterra-codex-host" data-neoterra-codex-host></div>' : ''}
            ${tab.id === 'settings' ? '<button type="button" class="menu_button" data-neoterra-open-settings>Open settings panel</button>' : ''}
        </section>`;
    }).join('');

    return `
    <div id="${UI_IDS.ROOT}" class="neoterra-root" data-active-tab="${activeTab}" hidden>
        <div class="neoterra-backdrop" data-neoterra-close></div>
        <section id="${UI_IDS.SHELL}" class="neoterra-shell" role="dialog" aria-modal="true"
            aria-labelledby="neoterra-shell-title">
            <header class="neoterra-shell-header">
                <div>
                    <h2 id="neoterra-shell-title" class="neoterra-shell-title">${EXTENSION_NAME}</h2>
                    <span class="neoterra-version">v${EXTENSION_VERSION}</span>
                </div>
                <button type="button" class="neoterra-close menu_button" data-neoterra-close
                    title="Close Neo Terra" aria-label="Close Neo Terra">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>
            <nav class="neoterra-tabs" role="tablist" aria-label="Neo Terra sections">${tabs}</nav>
            <div class="neoterra-tabpanels">${panels}</div>
        </section>
    </div>`;
}

function topButtonMarkup() {
    return `
    <div class="neoterra-top-slot" data-neoterra-top-wrapper>
        <button id="${UI_IDS.TOP_BUTTON}" type="button" class="neoterra-top-button"
            title="Neo Terra" aria-label="Open Neo Terra" aria-haspopup="dialog">
            <i class="fa-solid fa-earth-americas" aria-hidden="true"></i>
        </button>
    </div>`;
}

function mountTopButton() {
    if (document.getElementById(UI_IDS.TOP_BUTTON)) {
        return document.getElementById(UI_IDS.TOP_BUTTON);
    }
    const holder = document.getElementById('top-settings-holder');
    if (!holder) {
        logger.warn('SillyTavern top bar not ready; Neo Terra entry button not mounted');
        return null;
    }
    holder.insertAdjacentHTML('beforeend', topButtonMarkup());
    const button = document.getElementById(UI_IDS.TOP_BUTTON);
    button?.addEventListener('click', () => openShell(), { signal: abort.signal });
    return button;
}

function mountShell() {
    document.getElementById(UI_IDS.ROOT)?.remove();
    document.body.insertAdjacentHTML('beforeend', shellMarkup());
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return null;
    }

    root.addEventListener('click', event => {
        if (event.target.closest?.('[data-neoterra-close]')) {
            closeShell();
            return;
        }
        const tab = event.target.closest?.('[data-neoterra-tab]')?.dataset.neoterraTab;
        if (tab) {
            setActiveTab(tab);
            return;
        }
        if (event.target.closest?.('[data-neoterra-open-settings]')) {
            openSettingsPanel();
        }
    }, { signal: abort.signal });

    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeShell();
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const tabs = [...root.querySelectorAll('[role="tab"]')];
            const index = tabs.findIndex(element => element.dataset.neoterraTab === activeTab);
            if (index === -1) {
                return;
            }
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            setActiveTab(next.dataset.neoterraTab);
            next.focus();
        }
    }, { signal: abort.signal });

    return root;
}

async function mountSeasonPanel(context) {
    if (!hasDom()) {
        return null;
    }
    const panel = document.querySelector('[data-neoterra-panel="season"]');
    if (!panel) {
        return null;
    }
    const host = panel.querySelector('[data-neoterra-season-host]') ?? panel;
    try {
        return await mountSeasonMenu({ root: host, ctx: context, getContext: refreshContext });
    } catch (error) {
        logger.warn('Could not mount the season menu', error);
        return null;
    }
}

/**
 * Cached per-chat store. SillyTavern does not reload extension scripts when the
 * chat changes, so the cache is keyed by chat id: a switch invalidates the
 * store instead of leaking one chat's world into another.
 */
let mapRuntime = null;
let mountedMapChatId = null;

function currentChatId(context) {
    // `ctx.chatId` lags during `CHAT_CHANGED`; the world state carries the chat
    // it belongs to, so prefer it and fall back to the context id.
    return context?.chatMetadata?.neoterra?.worldState?.chatId ?? context?.chatId ?? null;
}

function readLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function buildStorylineInitiative(context, store, season) {
    let runner = null;
    try {
        const client = createAgentClient({ ctx: context });
        runner = createAgentRunner({ client });
    } catch (error) {
        logger.debug('Agent runner unavailable; travel uses the deterministic tracker', error);
    }
    const storyline = createStorylineTracker({
        runner,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const ending = createEndingFlow({
        store,
        agent: createEpilogueAgent({
            runner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        }),
        season,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const initiative = createInitiative({
        store,
        season,
        storyline,
        ending,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    return { initiative, ending, runner };
}

function buildMapRuntime(context, panelRef) {
    const chatId = currentChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata) {
        return null;
    }
    if (mapRuntime && mapRuntime.chatId === chatId) {
        mapRuntime.panelRef = panelRef;
        return mapRuntime;
    }
    let store;
    try {
        store = createWorldStateStore({
            metadata,
            saveMetadataDebounced: () => context?.saveMetadataDebounced?.(),
            storage: readLocalStorage(),
            chatId,
        });
    } catch (error) {
        logger.warn('Could not open the chat world state', error);
        return null;
    }
    if (!store.get()) {
        return { chatId, store, panelRef, travel: null };
    }
    const season = metadata.neoterra?.seasonDefinition ?? null;
    const scene = createSceneFlow({
        store,
        season,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const { initiative, ending } = buildStorylineInitiative(context, store, season);
    const travel = createTravelFlow({
        store,
        season,
        scene,
        initiative,
        // Read through the live runtime so a panel remount (same chat) still
        // supplies the current overrides.
        loadSources: () => mapRuntime?.panelRef?.getSources?.() ?? panelRef?.getSources?.() ?? null,
        now: Date.now,
        log: (message, error) => logger.warn(message, error),
    });
    mapRuntime = { chatId, store, panelRef, scene, initiative, ending, travel };
    return mapRuntime;
}

function recordTravelOnMessage(context, result) {
    const messages = Array.isArray(context?.chat) ? context.chat : null;
    if (!messages || !result?.messageExtra) {
        return false;
    }
    // Prefer the latest assistant message: the travel record describes the
    // scene the narrator last presented, not the player's own prompt.
    const message = [...messages].reverse().find((entry) => entry && entry.is_user !== true) ?? null;
    if (!message) {
        return false;
    }
    try {
        attachTravelToMessage(message, result.messageExtra);
        context?.saveChat?.();
        return true;
    } catch (error) {
        logger.warn('Could not record the travel on the message', error);
        return false;
    }
}

function buildMapTravelHandler(context, runtime, panelRef) {
    const travel = runtime?.travel ?? null;
    if (!travel) {
        return null;
    }
    return async (request) => {
        if (!request?.to) {
            return false;
        }
        // The user may have switched chats with the map open. Never write into
        // the previous chat's timeline (or onto the new chat's message).
        const live = refreshContext();
        const liveChatId = currentChatId(live ?? context);
        if (liveChatId && liveChatId !== runtime.chatId) {
            logger.info('Chat changed; remounting the map before travel');
            disposeMapPanel();
            mountedMapChatId = null;
            await mountMapPanelForActiveChat();
            return false;
        }
        const result = await travel.travel({ to: request.to });
        if (!result.ok) {
            logger.info('Travel rejected', { reason: result.reason, message: result.message });
            bus.emit(EVENTS.MAP_UPDATED, { travel: result });
            return false;
        }
        recordTravelOnMessage(context, result);
        panelRef?.refresh?.();
        bus.emit(EVENTS.MAP_UPDATED, { travel: result, intro: result.intro ?? null });
        return true;
    };
}

/** Re-read the live context so a chat switch is visible, then mount the map. */
async function mountMapPanelForActiveChat() {
    return mountMapPanelComponent(refreshContext());
}

async function mountMapPanelComponent(context) {
    if (!hasDom()) {
        return null;
    }
    const host = document.querySelector('[data-neoterra-map-host]');
    if (!host) {
        return null;
    }
    try {
        // A chat switch keeps this module loaded: drop the old panel/store so
        // nothing is written into the previous chat's metadata.
        const chatId = currentChatId(context);
        if (chatId && mountedMapChatId && mountedMapChatId !== chatId) {
            disposeMapPanel();
        }
        mountedMapChatId = chatId;
        const ref = { panel: null };
        const runtime = buildMapRuntime(context, {
            getSources: () => ref.panel?.getSources?.() ?? null,
            refresh: () => ref.panel?.refresh?.(),
        });
        const onTravel = buildMapTravelHandler(context, runtime, {
            getSources: () => ref.panel?.getSources?.() ?? null,
            refresh: () => ref.panel?.refresh?.(),
        });
        const panel = await mountMapPanel({
            root: host,
            ctx: context,
            season: context?.chatMetadata?.neoterra?.seasonDefinition ?? null,
            settings: getSettings(context).map ?? {},
            store: runtime?.store ?? null,
            onTravel,
        });
        ref.panel = panel;
        return panel;
    } catch (error) {
        logger.warn('Could not mount the city map', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The city map could not be mounted.</p>';
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Character Codex                                                     */
/* ------------------------------------------------------------------ */

let mountedCodexChatId = null;

async function mountCodexPanelComponent(context) {
    if (!hasDom()) {
        return null;
    }
    const host = document.querySelector('[data-neoterra-codex-host]');
    if (!host) {
        return null;
    }
    const chatId = currentChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata) {
        disposeCodex();
        host.innerHTML = '<p class="neoterra-empty">Open a chat to see its character codex.</p>';
        return null;
    }
    if (mountedCodexChatId && mountedCodexChatId !== chatId) {
        disposeCodex();
    }
    mountedCodexChatId = chatId;
    try {
        const season = metadata?.neoterra?.seasonDefinition ?? null;
        const metadataRegistry = metadata?.neoterra?.registry ?? null;
        const hasEntries = Array.isArray(metadataRegistry?.entries)
            && metadataRegistry.entries.length > 0;
        // Season-start stores a roster slice. Sandbox has an empty roster, so its
        // slice is truthy but empty; load the full registry in that case.
        const registry = hasEntries && season?.allowAnyCharacter !== true
            ? metadataRegistry
            : await loadRegistry();
        const [formGroups, formRules] = await Promise.all([
            loadFormGroups(),
            loadFormRules({ registry }),
        ]);
        const store = createWorldStateStore({
            metadata,
            saveMetadataDebounced: () => context?.saveMetadataDebounced?.(),
            storage: readLocalStorage(),
            chatId,
            context: { registry, formGroups, formRules },
        });
        return mountCodex({
            root: host,
            store,
            season,
            registry,
            formGroups,
            formRules,
            getSettings: () => getSettings(context),
            onIdentityChange: ({ identity }) => {
                const root = metadata.neoterra ?? (metadata.neoterra = {});
                root.playerIdentity = identity;
                try {
                    context?.saveMetadataDebounced?.();
                } catch (error) {
                    logger.debug('Could not persist the player identity', error);
                }
                invalidateChatRuntimes(context, { keepCodex: true });
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'identity', identity });
            },
            onWorldChange: () => {
                invalidateChatRuntimes(context, { keepCodex: true });
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'codex' });
            },
        });
    } catch (error) {
        logger.warn('Could not mount the character codex', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The character codex could not be mounted.</p>';
        return null;
    }
}

async function mountCodexPanelForActiveChat() {
    return mountCodexPanelComponent(refreshContext());
}

/**
 * Drop sibling runtimes that cache their own WorldState copy after the codex
 * mutates the shared document. The next activation rebuilds them from metadata.
 */
function invalidateChatRuntimes(context, { keepCodex = false } = {}) {
    mapRuntime?.store?.dispose?.();
    interactionRuntime?.store?.dispose?.();
    mapRuntime = null;
    mountedMapChatId = null;
    interactionRuntime = null;
    choicesBar = null;
    disposeMapPanel();
    disposeChoicesBar();
    if (!keepCodex) {
        disposeCodex();
    }
    if (isShellOpen() && getActiveTab() === 'map') {
        void mountMapPanelForActiveChat();
    }
    void refreshInteractionUi(context ?? refreshContext());
}

/* ------------------------------------------------------------------ */
/* Ending and CYOA wiring                                               */
/* ------------------------------------------------------------------ */

let interactionRuntime = null;
let interactionSubscription = null;
let choicesBar = null;

function ensureChoicesHost() {
    let host = document.getElementById('neoterra-choices-host');
    if (host) {
        return host;
    }
    host = document.createElement('div');
    host.id = 'neoterra-choices-host';
    host.className = 'neoterra-choices-host';
    const form = document.getElementById('send_form');
    if (form) {
        form.prepend(host);
    } else {
        document.body.append(host);
    }
    return host;
}

function ensureEndingHost() {
    let host = document.getElementById('neoterra-ending-host');
    if (host) {
        return host;
    }
    host = document.createElement('div');
    host.id = 'neoterra-ending-host';
    host.className = 'neoterra-ending-host';
    document.body.append(host);
    return host;
}

function sendChoiceText(text) {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        return false;
    }
    textarea.value = String(text ?? '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send_but')?.click?.();
    return true;
}

function buildInteractionRuntime(context) {
    const chatId = currentChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata) {
        return null;
    }
    if (interactionRuntime && interactionRuntime.chatId === chatId) {
        return interactionRuntime;
    }
    let store;
    try {
        store = createWorldStateStore({
            metadata,
            saveMetadataDebounced: () => context?.saveMetadataDebounced?.(),
            storage: readLocalStorage(),
            chatId,
        });
    } catch (error) {
        logger.warn('Could not open the chat world state for ending/choices', error);
        return null;
    }
    if (!store.get()) {
        return null;
    }
    const season = metadata.neoterra?.seasonDefinition ?? null;
    const { initiative, ending, runner } = buildStorylineInitiative(context, store, season);
    const choicesAgent = createChoicesAgent({
        runner,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const controller = createChoicesController({
        agent: choicesAgent,
        getState: () => store.get(),
        getSettings: () => getSettings(context),
        getSeason: () => season,
        onSend: (text) => sendChoiceText(text),
    });
    interactionRuntime = {
        chatId,
        store,
        season,
        initiative,
        ending,
        controller,
        combat: createCombatFlow({
            store,
            getSettings: () => getSettings(context),
            now: Date.now,
            log: (message, error) => logger.warn(message, error),
        }),
    };
    return interactionRuntime;
}

async function refreshInteractionUi(context = null) {
    if (!hasDom()) {
        return null;
    }
    const live = context ?? refreshContext();
    const runtime = buildInteractionRuntime(live);
    if (!runtime) {
        choicesBar = null;
        disposeChoicesBar();
        disposeEndingPanel();
        return null;
    }
    if (!choicesBar) {
        choicesBar = mountChoicesBar({
            root: ensureChoicesHost(),
            controller: runtime.controller,
        });
    }
    const state = runtime.store.get();
    if (isEndingScreenActive(state) || state?.ending?.status === 'continued') {
        mountEndingPanel({
            root: ensureEndingHost(),
            store: runtime.store,
            flow: runtime.ending,
        });
    } else {
        disposeEndingPanel();
    }
    return runtime;
}

async function handleAssistantMessage(message, messageIndex, context = null) {
    const live = context ?? refreshContext();
    const runtime = await refreshInteractionUi(live);
    if (!runtime) {
        return;
    }
    const messages = Array.isArray(live?.chat) ? live.chat : [];
    try {
        await runtime.initiative?.afterTurn?.({
            recentProse: typeof message?.mes === 'string' ? message.mes : '',
        });
    } catch (error) {
        logger.warn('Storyline pass failed after a message', error);
    }
    await refreshInteractionUi(live);
    const view = await runtime.controller.request({
        messages,
        messageIndex,
        swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
    });
    if (view?.visible) {
        choicesBar?.refresh?.();
    }
}

function subscribeInteractionEvents(context) {
    unsubscribeInteractionEvents();
    const eventSource = context?.eventSource ?? context?.eventTypes;
    const on = typeof eventSource?.on === 'function' ? eventSource.on.bind(eventSource) : null;
    if (!on) {
        void refreshInteractionUi(context);
        return;
    }
    const messageEvent = context?.eventTypes?.MESSAGE_RECEIVED ?? 'message_received';
    const handler = (messageIndex) => {
        const live = refreshContext();
        const messages = Array.isArray(live?.chat) ? live.chat : [];
        const index = Number.isInteger(messageIndex) ? messageIndex : messages.length - 1;
        const message = messages[index] ?? null;
        if (!message || message.is_user === true) {
            return;
        }
        void handleAssistantMessage(message, index, live);
    };
    try {
        on(messageEvent, handler);
        interactionSubscription = { eventSource, event: messageEvent, handler };
    } catch (error) {
        logger.debug('MESSAGE_RECEIVED subscription unavailable', error);
    }
    void refreshInteractionUi(context);
}

function unsubscribeInteractionEvents() {
    const subscription = interactionSubscription;
    interactionSubscription = null;
    if (!subscription) {
        return;
    }
    try {
        const off = subscription.eventSource?.removeListener ?? subscription.eventSource?.off;
        off?.call?.(subscription.eventSource, subscription.event, subscription.handler);
        // (event name and handler are passed separately above)

    } catch (error) {
        logger.debug('Could not remove the MESSAGE_RECEIVED listener', error);
    }
}

function openSettingsPanel() {
    refreshSettingsPanel();
    const panel = document.getElementById(UI_IDS.SETTINGS_PANEL);
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    host?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const content = panel?.querySelector('.inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') {
        panel.querySelector('.inline-drawer-toggle')?.click();
    }
    panel?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

export function isShellOpen() {
    if (!hasDom()) {
        return false;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    return Boolean(root && !root.hidden);
}

export function getActiveTab() {
    return activeTab;
}

export function setActiveTab(tabId) {
    if (!SHELL_TABS.some(tab => tab.id === tabId)) {
        return false;
    }
    activeTab = tabId;
    if (!hasDom()) {
        return true;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return true;
    }
    root.dataset.activeTab = tabId;
    for (const tab of root.querySelectorAll('[role="tab"]')) {
        const selected = tab.dataset.neoterraTab === tabId;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-neoterra-panel]')) {
        panel.hidden = panel.dataset.neoterraPanel !== tabId;
    }
    if (tabId === 'map') {
        mapMounted = true;
        void mountMapPanelForActiveChat();
    }
    if (tabId === 'characters') {
        void mountCodexPanelForActiveChat();
    }
    bus.emit(EVENTS.TAB_CHANGED, { tab: tabId });
    return true;
}

export function openShell(tabId = activeTab) {
    if (!hasDom()) {
        return false;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return false;
    }
    previousFocus = document.activeElement;
    // Unhide before switching tabs so lazily mounted panels (the map) measure a
    // real viewport instead of a zero-size hidden container.
    root.hidden = false;
    root.classList.add('is-open');
    setActiveTab(tabId);
    root.querySelector('.neoterra-close')?.focus?.();
    bus.emit(EVENTS.SHELL_OPENED, { tab: activeTab });
    return true;
}

export function closeShell() {
    if (!hasDom()) {
        return false;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root || root.hidden) {
        return false;
    }
    root.hidden = true;
    root.classList.remove('is-open');
    previousFocus?.focus?.();
    previousFocus = null;
    bus.emit(EVENTS.SHELL_CLOSED, { tab: activeTab });
    return true;
}

function registerSlashCommand(context) {
    if (registeredCommand) {
        return;
    }
    const { SlashCommand, SlashCommandParser, ARGUMENT_TYPE, SlashCommandArgument } = context ?? {};
    if (!SlashCommand?.fromProps || !SlashCommandParser?.addCommandObject) {
        logger.debug('Slash command API unavailable; /neoterra not registered');
        return;
    }

    const command = SlashCommand.fromProps({
        name: 'neoterra',
        aliases: ['nt'],
        callback: async (_args, value) => {
            const requested = String(value ?? '').trim().toLowerCase();
            openShell(SHELL_TABS.some(tab => tab.id === requested) ? requested : 'season');
            return '';
        },
        helpString: 'Open the Neo Terra framework shell.',
        returns: 'empty string',
        unnamedArgumentList: SlashCommandArgument?.fromProps
            ? [
                SlashCommandArgument.fromProps({
                    description: 'Optional tab: season, map, characters, player, settings',
                    isRequired: false,
                    typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : undefined,
                }),
            ]
            : [],
    });

    try {
        SlashCommandParser.addCommandObject(command);
        registeredCommand = command;
        logger.info('Registered /neoterra slash command');
    } catch (error) {
        logger.warn('Could not register /neoterra slash command', error);
    }
}

function unregisterSlashCommand(context) {
    if (!registeredCommand) {
        return;
    }
    const parser = context?.SlashCommandParser;
    const commands = parser?.commands;
    if (commands && typeof commands === 'object') {
        let removed = 0;
        for (const name of [registeredCommand.name, ...(registeredCommand.aliases ?? [])]) {
            if (commands[name] === registeredCommand) {
                delete commands[name];
                removed += 1;
            }
        }
        if (removed === 0) {
            logger.debug('Slash command entry was already gone; parser API may have changed');
        }
    }
    registeredCommand = null;
}

async function resetChatWorld(context = null) {
    // Always re-read the live context: the settings panel may hold a context
    // object captured before a chat switch.
    const live = refreshContext() ?? context;
    const metadata = live?.chatMetadata;
    if (!metadata?.neoterra) {
        return false;
    }
    const chatId = metadata.neoterra.worldState?.chatId
        ?? live?.chatId
        ?? null;
    const bookName = metadata.neoterra.worldBook?.name ?? null;
    if (bookName) {
        try {
            const adapter = createWorldBookAdapter({
                ctx: live,
                getSettings: () => getSettings(live),
                logger,
            });
            adapter.remove(bookName);
        } catch (error) {
            logger.warn('Could not remove the generated world book', error);
        }
    }
    // Cancel pending debounced saves from every live store before clearing the
    // document; otherwise a stale timer can write the old world back.
    mapRuntime?.store?.dispose?.();
    interactionRuntime?.store?.dispose?.();
    disposeCodex();
    if (chatId) {
        try {
            readLocalStorage()?.removeItem?.(`${WAL_PREFIX}${chatId}`);
        } catch (error) {
            logger.debug('Could not clear the world-state WAL', error);
        }
    }
    // Drop per-swipe snapshots so restoring a swipe cannot splice the old world
    // back into the reset timeline.
    if (Array.isArray(live?.chat)) {
        for (const message of live.chat) {
            if (message?.extra && typeof message.extra === 'object' && message.extra.neoterra) {
                delete message.extra.neoterra;
            }
        }
    }
    metadata.neoterra = { schemaVersion: 1 };
    try {
        live?.saveMetadataDebounced?.();
        live?.saveChat?.();
    } catch (error) {
        logger.debug('Could not persist the world reset', error);
    }
    mapRuntime = null;
    mountedMapChatId = null;
    mountedCodexChatId = null;
    interactionRuntime = null;
    choicesBar = null;
    disposeMapPanel();
    disposeCodex();
    disposeChoicesBar();
    disposeEndingPanel();
    if (isShellOpen() && getActiveTab() === 'map') {
        void mountMapPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'characters') {
        void mountCodexPanelForActiveChat();
    }
    void refreshInteractionUi(live);
    bus.emit(EVENTS.MAP_UPDATED, { reason: 'world-reset' });
    return true;
}

function exposeDebugApi(context) {
    const api = {
        version: EXTENSION_VERSION,
        open: openShell,
        close: closeShell,
        isOpen: isShellOpen,
        getActiveTab,
        setActiveTab,
        getSettings: () => getSettings(context),
        resetSettings: () => {
            const settings = resetSettings(context);
            refreshSettingsPanel();
            return settings;
        },
        resetWorld: () => resetChatWorld(context),
        refreshWorld: () => {
            invalidateChatRuntimes(context);
            bus.emit(EVENTS.MAP_UPDATED, { reason: 'world-refresh' });
            return true;
        },
        mount: initialize,
        dispose,
    };
    globalThis.NeoTerra = Object.assign(globalThis.NeoTerra ?? {}, api);
    return api;
}

/**
 * Mount the extension. Called by the manifest `activate`/`enable` hooks.
 * Repeated calls are safe.
 */
export async function initialize(options = {}) {
    if (!hasDom()) {
        return false;
    }
    if (mounted) {
        return true;
    }
    if (mounting) {
        return mounting;
    }

    const generation = ++mountGeneration;
    mounting = (async () => {
        ctx = options.ctx ?? getContext();
        if (!ctx) {
            logger.warn('SillyTavern context is unavailable; Neo Terra not mounted');
            return false;
        }

        abort?.abort();
        abort = new AbortController();

        mountTopButton();
        mountShell();
        void mountSeasonPanel(ctx);
        registerSlashCommand(ctx);
        registerCombatIntegrations({
            ctx,
            getCombat: () => buildInteractionRuntime(refreshContext() ?? ctx)?.combat ?? null,
            getSettings: () => getSettings(ctx),
            log: (message, error) => logger.warn(message, error),
        });
        subscribeChatChanges(ctx);
        subscribeInteractionEvents(ctx);
        exposeDebugApi(ctx);
        await mountSettingsPanel(ctx, {
            signal: abort.signal,
            onResetWorld: () => resetChatWorld(ctx),
        });

        // A disable/delete hook may have run while the settings template was
        // loading. In that case dispose() owns the teardown; never mark the
        // stale mount as live (and never tear down a newer mount's panel).
        if (generation !== mountGeneration) {
            return false;
        }

        mounted = true;
        logger.info('Mounted', { version: EXTENSION_VERSION });
        return true;
    })();

    try {
        return await mounting;
    } catch (error) {
        logger.error('Mount failed', error);
        if (generation === mountGeneration) {
            mounted = false;
        }
        throw error;
    } finally {
        if (generation === mountGeneration) {
            mounting = null;
        }
    }
}

/**
 * SillyTavern keeps the module loaded across chats. Drop the chat-bound map
 * runtime as soon as the chat changes so the next map activation rebuilds it.
 */
let chatChangeSubscription = null;

function subscribeChatChanges(context) {
    unsubscribeChatChanges();
    const eventSource = context?.eventSource ?? context?.eventTypes;
    const on = typeof eventSource?.on === 'function' ? eventSource.on.bind(eventSource) : null;
    if (!on) {
        return;
    }
    const handler = () => {
        mapRuntime = null;
        mountedMapChatId = null;
        mountedCodexChatId = null;
        interactionRuntime = null;
        choicesBar = null;
        disposeMapPanel();
        disposeCodex();
        disposeChoicesBar();
        disposeEndingPanel();
        if (isShellOpen() && getActiveTab() === 'map') {
            void mountMapPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'characters') {
            void mountCodexPanelForActiveChat();
        }
        refreshSettingsPanel();
        void refreshInteractionUi(refreshContext());
    };
    try {
        on('chat_changed', handler);
        chatChangeSubscription = { eventSource, handler };
    } catch (error) {
        logger.debug('chat_changed subscription unavailable', error);
    }
}

function unsubscribeChatChanges() {
    const subscription = chatChangeSubscription;
    chatChangeSubscription = null;
    if (!subscription) {
        return;
    }
    try {
        const off = subscription.eventSource?.removeListener ?? subscription.eventSource?.off;
        off?.call?.(subscription.eventSource, 'chat_changed', subscription.handler);
    } catch (error) {
        logger.debug('Could not remove the chat_changed listener', error);
    }
}

/** Unmount the extension. Called by the manifest `disable`/`delete` hooks. */
export function dispose() {
    mounted = false;
    mounting = null;
    mountGeneration += 1;
    mapMounted = false;

    unregisterSlashCommand(ctx);
    unregisterCombatIntegrations({ ctx });
    unsubscribeChatChanges();
    unsubscribeInteractionEvents();
    mapRuntime = null;
    mountedMapChatId = null;
    mountedCodexChatId = null;
    interactionRuntime = null;
    choicesBar = null;
    disposeSeasonMenu();
    disposeMapPanel();
    disposeCodex();
    disposeSettingsPanel();
    disposeChoicesBar();
    disposeEndingPanel();
    document.getElementById('neoterra-choices-host')?.remove();
    document.getElementById('neoterra-ending-host')?.remove();

    if (hasDom()) {
        document.getElementById(UI_IDS.ROOT)?.remove();
        document.querySelector('[data-neoterra-top-wrapper]')?.remove();
        document.getElementById(UI_IDS.TOP_BUTTON)?.remove();
    }

    abort?.abort();
    abort = null;

    if (typeof globalThis !== 'undefined') {
        delete globalThis.NeoTerra;
    }

    previousFocus = null;
    logger.info('Unmounted');
}
