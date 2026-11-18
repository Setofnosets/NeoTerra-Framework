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
import { mountClockChip } from './clock-chip.js';
import {
    describeMissingSettingsHost,
    disposeSettingsPanel,
    mountSettingsPanel,
    refreshSettingsPanel,
    revealSettingsPanel,
} from './settings.js';
import { disposeMapPanel, disposeNewspaperReader, mountMapPanel } from './map-panel.js';
import { disposeCodex, mountCodex } from './codex.js';
import { loadCodexData } from './codex-data.js';
import { createWorldBookAdapter } from '../context/worldbook.js';
import { createWorldStateStore, getSharedWorldStateStore, releaseSharedWorldStateStore, loadWorldStateFromMetadata, WAL_PREFIX } from '../state/store.js';
import { createTravelFlow, attachTravelToMessage } from '../flows/travel.js';
import { createSceneFlow } from '../flows/scene.js';
import { createInitiative } from '../flows/initiative.js';
import { createWorldTick } from '../flows/world-tick.js';
import { createPacingFlow } from '../flows/pacing.js';
import { createNewsroomFlow } from '../flows/newsroom.js';
import { createNewspaperAgent } from '../agents/newspaper.js';
import { createStorylineTracker } from '../agents/storyline.js';
import { createEpilogueAgent } from '../agents/epilogue.js';
import { createChoicesAgent } from '../agents/choices.js';
import { createAgentClient } from '../agents/client.js';
import { createAgentRunner } from '../agents/runner.js';
import {
    createStateTracker,
    createTurnGate,
    messageTurnIdentity,
    runTurnPipeline,
} from '../agents/state-tracker.js';
import { createEndingFlow, isEndingScreenActive } from '../flows/ending.js';
import { mountEndingPanel, disposeEndingPanel } from './ending.js';
import { createChoicesController, mountChoicesBar, disposeChoicesBar } from './choices.js';
import {
    avoidEncounter,
    buildCombatResolutionFrameText,
    buildEncounterBarModel,
    disposeEncounterBar,
    encounterFromCombat,
    endEncounterCombat,
    engageEncounter,
    mountEncounterBar,
    surrenderEncounterCombat,
} from './encounter-bar.js';
import {
    SCENE_KINDS,
    buildOpeningFrameText,
    buildOpeningSceneKey,
    buildSceneChatMessage,
    buildSceneKey,
    buildTravelFrameText,
    buildTravelSceneKey,
    hasStoryHistory,
    postSceneMessage,
} from './chat-output.js';
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
        body: 'Global Neo Terra settings live in SillyTavern’s Extensions drawer.',
    },
});

/** Tabs whose panel is a live mountable component instead of a placeholder. */
const LIVE_PANELS = new Set(['season', 'map', 'characters', 'settings']);

let ctx = null;
let abort = null;
let mounted = false;
let mounting = null;
let mountGeneration = 0;
let registeredCommand = null;
let activeTab = 'season';
let previousFocus = null;
let mapMounted = false;

/** Per-message gate and serialized queue for the assistant-turn pipeline. */
const turnGate = createTurnGate();
let turnQueue = Promise.resolve();

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
            ${tab.id === 'settings' ? `
            <div class="neoterra-settings-tab">
                <p class="neoterra-hint">Neo Terra settings live in SillyTavern's <strong>Extensions</strong>
                    drawer (the plug icon), collapsed under <strong>Neo Terra Framework</strong>.
                    Use the button to close this window, open the drawer, and scroll to the panel.</p>
                <button type="button" class="menu_button" data-neoterra-open-settings>Open settings panel</button>
                <p class="neoterra-status" role="status" aria-live="polite" data-neoterra-settings-status hidden></p>
            </div>` : ''}
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

/* ------------------------------------------------------------------ */
/* World-clock chip                                                    */
/* ------------------------------------------------------------------ */

let clockChip = null;
let clockChipSubscription = null;

/** The store backing the open chat, preferring the live shared runtime. */
function liveWorldState() {
    const live = refreshContext();
    const chatId = currentChatId(live);
    if (!chatId) {
        return null;
    }
    if (mapRuntime?.chatId === chatId) {
        return mapRuntime.store.get();
    }
    if (interactionRuntime?.chatId === chatId) {
        return interactionRuntime.store.get();
    }
    let stored = null;
    try {
        stored = loadWorldStateFromMetadata(live?.chatMetadata);
    } catch (error) {
        logger.debug('Could not read the world state for the clock chip', error);
        return null;
    }
    if (!stored) {
        return null;
    }
    // A chip toggle may have an in-memory dispatch that has not been persisted
    // yet; read the per-chat shared store so the chip reflects it immediately.
    return sharedStoreFor(live)?.get() ?? stored;
}

function sharedStoreFor(context) {
    const chatId = currentChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata) {
        return null;
    }
    if (mapRuntime?.chatId === chatId) {
        return mapRuntime.store;
    }
    if (interactionRuntime?.chatId === chatId) {
        return interactionRuntime.store;
    }
    try {
        return getSharedWorldStateStore({
            metadata,
            saveMetadataDebounced: () => context?.saveMetadataDebounced?.(),
            storage: readLocalStorage(),
            chatId,
        });
    } catch (error) {
        logger.warn('Could not open the chat world state for the clock chip', error);
        return null;
    }
}

function mountClockChipForShell() {
    if (!hasDom()) {
        return null;
    }
    const wrapper = document.querySelector('[data-neoterra-top-wrapper]');
    if (!wrapper) {
        return null;
    }
    clockChip?.dispose?.();
    clockChip = mountClockChip({
        host: wrapper,
        getState: () => liveWorldState(),
        getSettings: () => {
            try {
                return getSettings(refreshContext() ?? ctx);
            } catch {
                return null;
            }
        },
        onToggle: ({ held }) => {
            const live = refreshContext() ?? ctx;
            const store = sharedStoreFor(live);
            if (!store || !store.get()) {
                return;
            }
            try {
                store.dispatch({
                    type: 'SET_CLOCK_HOLD',
                    active: !held,
                    reason: 'chip',
                });
                clockChip?.refresh?.();
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'clock', held: !held });
            } catch (error) {
                logger.warn('Could not toggle the world clock', error);
            }
        },
    });
    clockChipSubscription?.();
    const offMap = bus.on(EVENTS.MAP_UPDATED, () => {
        clockChip?.refresh?.();
    });
    const offSettings = bus.on(EVENTS.SETTINGS_CHANGED, () => {
        clockChip?.refresh?.();
    });
    clockChipSubscription = () => {
        offMap();
        offSettings();
    };
    return clockChip;
}

function disposeClockChip() {
    clockChipSubscription?.();
    clockChipSubscription = null;
    clockChip?.dispose?.();
    clockChip = null;
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

function seasonIdOf(result) {
    // `meta.sceneId` is a scene id ('opening'), not a season id; an absent
    // season id is simply dropped from the dedupe key.
    return result?.opening?.seasonId ?? result?.state?.seasonId ?? null;
}

/**
 * Post the season opening frame, hand control back to the chat, and (only when
 * explicitly enabled on a fresh chat) send one player kickoff prompt.
 *
 * This is the "the story has started" signal: before it, `enterSeason` only
 * seeded metadata and dropped the user back on the season list.
 */
async function handleSeasonEntered(result) {
    const live = refreshContext() ?? ctx;
    const seasonId = seasonIdOf(result);
    const turn = Number.isFinite(result?.state?.meta?.turn) ? result.state.meta.turn : 0;
    const chatId = currentChatId(live);
    if (!chatId || !Array.isArray(live?.chat)) {
        logger.warn('Season started without an open chat; skipping the opening frame');
        return null;
    }
    const freshChat = !hasStoryHistory(live.chat);
    // `enterSeason` seeded a fresh WorldState into chatMetadata through its own
    // store; drop the cached runtimes so the map, choices, and turn pipeline
    // read the new season instead of writing the previous document back.
    invalidateChatRuntimes(live);
    const key = buildOpeningSceneKey({ chatId, seasonId, turn });
    const message = buildSceneChatMessage({
        kind: SCENE_KINDS.OPENING,
        text: buildOpeningFrameText({
            state: result?.state ?? null,
            season: live?.chatMetadata?.neoterra?.seasonDefinition ?? null,
            opening: result?.opening ?? null,
        }),
        key,
        extra: { seasonId, turn },
    });

    // The post is synchronous up to `saveChat`, so re-check the chat right
    // before writing: a chat switch must never receive another world's frame.
    if (currentChatId(refreshContext() ?? live) !== chatId) {
        logger.warn('Chat changed during season start; skipping the opening frame');
        return null;
    }
    const posted = await postSceneMessage(live, message, { dedupeKey: key });
    if (posted.posted || posted.deduped) {
        closeShell();
    }
    document.getElementById('send_textarea')?.focus?.();
    bus.emit(EVENTS.MAP_UPDATED, { reason: 'season-start', seasonId });

    const settings = getSettings(live);
    const auto = settings?.kickoff?.auto === true;
    const prompt = typeof settings?.kickoff?.prompt === 'string' ? settings.kickoff.prompt.trim() : '';
    const index = Number.isInteger(posted.index) ? posted.index : null;

    // With an immediate auto-kickoff the narrator's reply owns the choices;
    // requesting them for the frame too would flash and then replace chips.
    // An empty kickoff prompt still only posts the frame, so it keeps chips.
    if (!(auto && freshChat && prompt.length > 0)) {
        await requestChoicesFor(live, index);
    }
    if (auto && freshChat && prompt.length > 0) {
        // A chat switch during the awaited save must not send into the new chat.
        if (currentChatId(refreshContext() ?? live) !== chatId) {
            logger.warn('Chat changed before the auto-kickoff; skipping the send');
            return posted;
        }
        // Normal ST send path: one player message, one narrator turn.
        sendChoiceText(prompt);
    }
    return posted;
}

async function requestChoicesFor(live, messageIndex, { mode = null } = {}) {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) {
        return null;
    }
    const runtime = await refreshInteractionUi(live);
    if (!runtime) {
        return null;
    }
    const messages = Array.isArray(live?.chat) ? live.chat : [];
    const view = await runtime.controller.request({
        messages,
        messageIndex,
        swipeId: 0,
        mode,
    });
    if (view?.visible) {
        choicesBar?.refresh?.();
    }
    return view;
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
        return await mountSeasonMenu({
            root: host,
            ctx: context,
            getContext: refreshContext,
            onEntered: (result) => {
                handleSeasonEntered(result).catch((error) => {
                    logger.warn('Could not hand the season start back to the chat', error);
                });
            },
        });
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
    const sharedInteraction = interactionRuntime && interactionRuntime.chatId === chatId
        ? interactionRuntime
        : null;
    // A stale runtime for another chat must not keep its registry entry alive.
    if (interactionRuntime && interactionRuntime.chatId !== chatId) {
        releaseSharedWorldStateStore(interactionRuntime.chatId);
        interactionRuntime = null;
    }
    let store;
    try {
        // One WorldState per chat: the map, interaction, and turn pipeline all
        // read and write the same document instead of caching their own copy.
        store = sharedInteraction?.store ?? getSharedWorldStateStore({
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
        // Nothing was seeded: do not leave an unowned store in the registry.
        if (!sharedInteraction) {
            releaseSharedWorldStateStore(chatId);
        }
        return { chatId, store, panelRef, travel: null };
    }
    const season = metadata.neoterra?.seasonDefinition ?? null;
    const scene = sharedInteraction?.scene ?? createSceneFlow({
        store,
        season,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const { initiative, ending, runner } = sharedInteraction?.initiative
        ? {
            initiative: sharedInteraction.initiative,
            ending: sharedInteraction.ending,
            runner: sharedInteraction.runner,
        }
        : buildStorylineInitiative(context, store, season);
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
    const pacing = sharedInteraction?.pacing ?? createPacingFlow({
        store,
        season,
        scene,
        initiative,
        getSettings: () => getSettings(context),
        now: Date.now,
        log: (message, error) => logger.warn(message, error),
    });
    mapRuntime = {
        chatId,
        store,
        panelRef,
        scene,
        initiative,
        ending,
        runner,
        tracker: sharedInteraction?.tracker ?? null,
        travel,
        pacing,
    };
    return mapRuntime;
}

/**
 * Post the travel arrival frame into the same chat and hand control back: the
 * frame carries the `extra.neoterra.travel` record and its dedupe key, then the
 * interaction UI is refreshed and CYOA is requested for the new message index.
 *
 * A chat switch during the awaited save must never write into the new chat. A
 * choices failure (abort, missing agent) is non-fatal: the move and the frame
 * stand, and the map update has already been announced through `onPosted`.
 *
 * Exported for tests; production callers use the default dependencies.
 */
export async function postTravelOutcome(context, runtime, result, {
    onPosted = null,
    requestChoices = requestChoicesFor,
    resolveContext = refreshContext,
    getChatId = currentChatId,
} = {}) {
    const live = resolveContext() ?? context;
    const chatId = runtime?.chatId ?? null;
    if (!chatId || getChatId(live) !== chatId) {
        logger.warn('Chat changed; skipping the travel arrival frame');
        return null;
    }
    const turn = result?.state?.meta?.turn ?? 0;
    const key = buildTravelSceneKey({
        chatId,
        from: result?.from,
        to: result?.to,
        turn,
    });
    const message = buildSceneChatMessage({
        kind: SCENE_KINDS.TRAVEL,
        text: buildTravelFrameText({
            fromName: result?.fromName,
            toName: result?.toName,
            intro: result?.intro,
        }),
        key,
        extra: {
            from: result?.from ?? null,
            to: result?.to ?? null,
            turn,
            encounter: result?.state?.scene?.encounter ?? null,
        },
    });
    // Attach before posting so the persisted frame carries the travel record.
    if (result?.messageExtra) {
        attachTravelToMessage(message, result.messageExtra);
    }
    const posted = await postSceneMessage(live, message, { dedupeKey: key });
    if (!posted.posted && !posted.deduped) {
        return posted;
    }
    // Announce the move before the choices round-trip so the map never waits on
    // an agent call to reflect the new location.
    try {
        onPosted?.(posted);
    } catch (error) {
        logger.warn('Could not announce the travel arrival', error);
    }
    const afterSave = resolveContext() ?? live;
    if (getChatId(afterSave) !== chatId) {
        logger.warn('Chat changed after the travel frame; skipping CYOA');
        return posted;
    }
    try {
        await requestChoices(afterSave, posted.index);
    } catch (error) {
        logger.warn('Could not request choices after travel; the frame stands', error);
    }
    return posted;
}

/**
 * Should a successful travel reveal the chat? Only a posted (or deduped) frame
 * counts; a rejected travel, an `alreadyThere` no-op, or a partial failed post
 * keeps the map open. Exported for tests.
 */
export function shouldCloseAfterTravel(posted, settings) {
    if (!posted || (posted.posted !== true && posted.deduped !== true)) {
        return false;
    }
    return settings?.map?.closeOnTravel !== false;
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
        // `onPosted` fires before the choices round-trip, so the handoff back to
        // the chat is immediate instead of waiting on an agent-backed request.
        const announce = (posted = null) => {
            panelRef?.refresh?.();
            bus.emit(EVENTS.MAP_UPDATED, { travel: result, intro: result.intro ?? null });
            let shouldClose = false;
            try {
                shouldClose = shouldCloseAfterTravel(posted, getSettings(refreshContext() ?? context));
            } catch (error) {
                logger.debug('Could not read map.closeOnTravel', error);
            }
            if (shouldClose) {
                closeShell();
            }
        };
        if (result.alreadyThere === true) {
            announce();
            return true;
        }
        const posted = await postTravelOutcome(context, runtime, result, { onPosted: announce });
        if (!posted) {
            // No chat/aborted post: still let the map reflect the committed move.
            announce();
            return true;
        }
        // A partial post (chat array only, no renderer) still needs its choices.
        if (!posted.posted && !posted.deduped) {
            announce(posted);
        }
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
        // The overlay gates off-screen text at render time; contentGate and
        // contentLimits are top-level settings, not map settings. The panel
        // re-reads this getter on every repaint.
        const mapSettingsNow = () => {
            const whole = getSettings(refreshContext() ?? context);
            return {
                ...(whole.map ?? {}),
                contentGate: whole.contentGate,
                contentLimits: whole.contentLimits,
                // The director card and the panel's fallback pacing flow must
                // see the user's pacing settings, not only the map slice.
                pacing: whole.pacing,
                // The newspaper teaser/reader and the [NEOTERRA_NEWS] block
                // need the feature settings; the panel gets the map slice.
                newspaper: whole.newspaper,
            };
        };
        const panel = await mountMapPanel({
            root: host,
            ctx: context,
            season: context?.chatMetadata?.neoterra?.seasonDefinition ?? null,
            settings: mapSettingsNow(),
            getSettings: mapSettingsNow,
            store: runtime?.store ?? null,
            pacing: runtime?.pacing ?? null,
            scene: runtime?.scene ?? null,
            initiative: runtime?.initiative ?? null,
            onTravel,
            // The toolbar X used to only send CLOSE to the panel's own state
            // machine, so nothing visible happened. The host closes the shell.
            onClose: () => closeShell(),
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
        host.removeAttribute('data-neoterra-codex-error');
        host.innerHTML = '<p class="neoterra-empty">Open a chat to see its character codex.</p>';
        return null;
    }
    if (mountedCodexChatId && mountedCodexChatId !== chatId) {
        disposeCodex();
    }
    mountedCodexChatId = chatId;
    host.removeAttribute('data-neoterra-codex-error');
    try {
        // Form rules are a global document; loading them without the chat slice
        // keeps every season's ids unresolved only where they belong.
        const { season, registry, formGroups, formRules, profiles } = await loadCodexData({ metadata });
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
            profiles,
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
        const message = error instanceof Error ? error.message : String(error);
        host.dataset.neoterraCodexError = message;
        logger.warn('Could not mount the character codex', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The character codex could not be mounted.</p>';
        return null;
    }
}

async function mountCodexPanelForActiveChat() {
    return mountCodexPanelComponent(refreshContext());
}

/**
 * Drop the chat-bound runtimes and the shared store they were using. The next
 * activation rebuilds them from metadata; the gate resets so the first turn in
 * the rebuilt runtime is accepted again.
 */
function disposeChatRuntimes() {
    const chatIds = [...new Set(
        [mapRuntime?.chatId, interactionRuntime?.chatId].filter(Boolean),
    )];
    mapRuntime = null;
    mountedMapChatId = null;
    interactionRuntime = null;
    choicesBar = null;
    disposeEncounterBar();
    encounterBar = null;
    // The registry is the single disposal point; the two runtimes share a store.
    for (const chatId of chatIds) {
        releaseSharedWorldStateStore(chatId);
    }
    turnGate.reset();
}

/**
 * Drop sibling runtimes that cache their own WorldState copy after the codex
 * mutates the shared document. The next activation rebuilds them from metadata.
 */
function invalidateChatRuntimes(context, { keepCodex = false } = {}) {
    disposeChatRuntimes();
    disposeMapPanel();
    disposeChoicesBar();
    disposeEncounterBar();
    encounterBar = null;
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
let encounterBar = null;

function ensureEncounterHost() {
    let host = document.getElementById('neoterra-encounter-host');
    if (host) {
        return host;
    }
    host = document.createElement('div');
    host.id = 'neoterra-encounter-host';
    host.className = 'neoterra-encounter-host';
    const form = document.getElementById('send_form');
    if (form) {
        // Directly above the CYOA host (and therefore above the input).
        const choicesHost = document.getElementById('neoterra-choices-host');
        if (choicesHost?.parentNode === form) {
            form.insertBefore(host, choicesHost);
        } else {
            form.prepend(host);
        }
    } else {
        document.body.append(host);
    }
    return host;
}

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
    // A stale runtime for another chat must not keep its registry entry alive.
    if (interactionRuntime && interactionRuntime.chatId !== chatId) {
        releaseSharedWorldStateStore(interactionRuntime.chatId);
        interactionRuntime = null;
    }
    // Share the map runtime's store/graph for this chat: travel mutates the map
    // store, and a second cached copy would give the choices agent (and the
    // turn pipeline) the pre-travel world.
    const shared = mapRuntime && mapRuntime.chatId === chatId ? mapRuntime : null;
    if (mapRuntime && mapRuntime.chatId !== chatId) {
        releaseSharedWorldStateStore(mapRuntime.chatId);
        mapRuntime = null;
    }
    let store;
    try {
        store = shared?.store ?? getSharedWorldStateStore({
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
        // Nothing was seeded: do not leave an unowned store in the registry.
        if (!shared) {
            releaseSharedWorldStateStore(chatId);
        }
        return null;
    }
    const season = metadata.neoterra?.seasonDefinition ?? null;
    const scene = shared?.scene ?? createSceneFlow({
        store,
        season,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const { initiative, ending, runner } = shared?.initiative
        ? { initiative: shared.initiative, ending: shared.ending, runner: shared.runner }
        : buildStorylineInitiative(context, store, season);
    const tracker = shared?.tracker ?? createStateTracker({
        runner,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const choicesAgent = createChoicesAgent({
        runner,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const worldTick = shared?.worldTick ?? createWorldTick({
        store,
        getSeason: () => season,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const newsroom = shared?.newsroom ?? createNewsroomFlow({
        store,
        getSeason: () => season,
        getSettings: () => getSettings(context),
        agent: createNewspaperAgent({
            runner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        }),
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
        scene,
        tracker,
        initiative,
        ending,
        runner,
        worldTick,
        newsroom,
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

/**
 * Mount (once per chat runtime) and paint the encounter bar. A malformed model
 * must never break the interaction UI: log at debug and hide the bar.
 */
function paintEncounterBar(runtime, live) {
    try {
        const model = buildEncounterBarModel({
            state: runtime.store.get(),
            settings: getSettings(live),
        });
        if (!model?.visible) {
            encounterBar?.refresh({ visible: false });
            return;
        }
        const host = ensureEncounterHost();
        // ST may re-render `#send_form`; remount instead of painting into a
        // detached node.
        if (encounterBar && encounterBar.root !== host) {
            disposeEncounterBar();
            encounterBar = null;
        }
        encounterBar ??= mountEncounterBar({
            root: host,
            onAction: (id) => handleEncounterAction(id),
        });
        encounterBar?.refresh(model);
    } catch (error) {
        logger.debug('Could not refresh the encounter bar', error);
        encounterBar?.refresh({ visible: false });
    }
}

/**
 * One delegated action from the encounter bar. Every branch re-reads the live
 * context and the shared runtime: the bar is UI-only, the frames carry prose.
 */
async function handleEncounterAction(actionId) {
    const live = refreshContext();
    const runtime = buildInteractionRuntime(live);
    if (!runtime) {
        return;
    }
    const state = runtime.store.get();
    const model = buildEncounterBarModel({
        state,
        settings: getSettings(live),
    });

    if (actionId === 'talk') {
        document.getElementById('send_textarea')?.focus?.();
        const index = (Array.isArray(live?.chat) ? live.chat.length : 0) - 1;
        const view = runtime.controller?.getView?.();
        if (index >= 0 && !view?.visible) {
            await requestChoicesFor(live, index);
        }
        return;
    }

    if (actionId === 'avoid') {
        avoidEncounter(runtime.store, state.scene?.encounter ?? model.encounter);
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'encounter-avoided' });
        await refreshInteractionUi(live);
        return;
    }

    if (actionId === 'engage') {
        const outcome = await engageEncounter({
            flow: runtime.combat,
            state,
            encounter: model.encounter,
            chatId: runtime.chatId,
            post: (message, key) => postSceneMessage(live, message, { dedupeKey: key }),
            requestChoices: (index) => requestChoicesFor(live, index, { mode: 'combat' }),
            onPosted: () => {
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'combat-start' });
            },
        });
        if (!outcome.ok) {
            encounterBar?.setStatus(outcome.message, 'error');
            return;
        }
        // Paint the combat controls (Surrender/End) before the choices round-trip.
        await refreshInteractionUi(live);
        return;
    }

    if (actionId === 'surrender' || actionId === 'end') {
        // Capture the encounter before resolving: the bar belongs to it, and
        // `detectEncounter` clears scene.encounter while combat runs.
        const encounter = state.scene?.encounter
            ?? encounterFromCombat(state)
            ?? model.encounter;
        const result = actionId === 'surrender'
            ? surrenderEncounterCombat(runtime.combat)
            : endEncounterCombat(runtime.combat, { reason: 'scene-end' });
        if (!result?.ok) {
            encounterBar?.setStatus(
                result?.message ?? 'The conflict could not be closed.',
                'error',
            );
            return;
        }
        avoidEncounter(runtime.store, encounter);
        const ended = runtime.store.get();
        const key = buildSceneKey(
            'resolution',
            runtime.chatId,
            ended?.flags?.lastCombat?.id ?? result.combatId ?? 'ended',
            result.endReason ?? 'ended',
        );
        const message = buildSceneChatMessage({
            kind: SCENE_KINDS.RESOLUTION,
            text: buildCombatResolutionFrameText({ state: ended, result }),
            key,
        });
        await postSceneMessage(live, message, { dedupeKey: key });
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'combat-end' });
        await refreshInteractionUi(live);
    }
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
        disposeEncounterBar();
        encounterBar = null;
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
    paintEncounterBar(runtime, live);
    return runtime;
}

function recentMessagesBefore(messages, messageIndex) {
    if (!Array.isArray(messages) || !Number.isInteger(messageIndex) || messageIndex <= 0) {
        return [];
    }
    return messages
        .slice(0, messageIndex)
        .map((entry) => (typeof entry?.mes === 'string' ? entry.mes : ''))
        .filter((text) => text.trim().length > 0)
        .slice(-4);
}

function chatStillCurrent(chatId) {
    if (!chatId) {
        return true;
    }
    const current = refreshContext();
    return !current || currentChatId(current) === chatId;
}

/** Drop a runtime the queued turn created for a chat that is no longer open. */
function abortStaleTurnRuntime(chatId) {
    if (!chatId) {
        return;
    }
    if (mapRuntime?.chatId === chatId) {
        mapRuntime = null;
    }
    if (interactionRuntime?.chatId === chatId) {
        interactionRuntime = null;
    }
    releaseSharedWorldStateStore(chatId);
    turnGate.reset();
}

async function handleAssistantMessage(message, messageIndex, context = null) {
    const live = context ?? refreshContext();
    // A queued turn may run after a chat switch; never apply it to the new chat.
    const liveChatId = currentChatId(live);
    if (!chatStillCurrent(liveChatId)) {
        logger.debug('Chat changed before the assistant turn ran; skipping');
        return;
    }
    const runtime = await refreshInteractionUi(live);
    if (!runtime) {
        return;
    }
    const chatId = currentChatId(live);
    if (!chatStillCurrent(chatId)) {
        logger.debug('Chat changed while building the turn runtime; skipping');
        abortStaleTurnRuntime(chatId);
        return;
    }
    // A swipe or a re-render of the same message is not a new turn: only a
    // genuinely new assistant message ticks the clock and runs the trackers.
    const isNewTurn = turnGate.accept({
        chatId,
        messageIndex,
        identity: messageTurnIdentity(message),
    });
    if (isNewTurn) {
        const messages = Array.isArray(live?.chat) ? live.chat : [];
        const result = await runTurnPipeline({
            store: runtime.store,
            tracker: runtime.tracker,
            initiative: runtime.initiative,
            scene: runtime.scene,
            getSettings: () => getSettings(live),
            message: typeof message?.mes === 'string' ? message.mes : '',
            recentMessages: recentMessagesBefore(messages, messageIndex),
            tickTurns: 1,
            worldTick: runtime.worldTick,
            log: (m, e) => logger.warn(m, e),
        });
        if (!chatStillCurrent(chatId)) {
            logger.debug('Chat changed during the turn pipeline; skipping the UI handoff');
            abortStaleTurnRuntime(chatId);
            return;
        }
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'turn', turn: result?.turn ?? null });
        mapRuntime?.panelRef?.refresh?.();
        // The newspaper is detached: a slow agent call must never delay CYOA.
        if (runtime.newsroom && typeof runtime.newsroom.publish === 'function') {
            void runtime.newsroom.publish({
                chatId,
                isCurrent: () => chatStillCurrent(chatId),
            }).then((report) => {
                if (report?.ok === true) {
                    bus.emit(EVENTS.MAP_UPDATED, { reason: 'newsroom', date: report.edition?.date ?? null });
                    mapRuntime?.panelRef?.refresh?.();
                }
            }).catch((error) => {
                logger.warn('Detached newspaper publication failed', error);
            });
        }
        // CYOA is requested only after the new state is written.
        await refreshInteractionUi(live);
    }
    if (!chatStillCurrent(chatId)) {
        logger.debug('Chat changed before the choices request; skipping');
        abortStaleTurnRuntime(chatId);
        return;
    }
    const messages = Array.isArray(live?.chat) ? live.chat : [];
    const view = await runtime.controller.request({
        messages,
        messageIndex,
        swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
    });
    if (view?.visible) {
        choicesBar?.refresh?.();
    }
}

/** Serialize turns so two events for one index cannot interleave a tick. */
function enqueueAssistantTurn(message, messageIndex, context = null) {
    turnQueue = turnQueue
        .then(() => handleAssistantMessage(message, messageIndex, context))
        .catch((error) => logger.warn('Assistant turn pipeline failed', error));
    return turnQueue;
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
        void enqueueAssistantTurn(message, index, live);
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

/**
 * Hand off to SillyTavern's Extensions drawer. The shell is a full-screen
 * modal, so it must close first or it keeps occluding the page behind it.
 * A missing host is reported inside the still-open tab; a late failure
 * re-opens the shell so the status stays visible.
 */
function openSettingsPanel() {
    const live = refreshContext();
    const drawerPresent = Boolean(document.getElementById('rm_extensions_block'));
    const panelPresent = Boolean(document.getElementById(UI_IDS.SETTINGS_PANEL));
    if (!drawerPresent || !panelPresent) {
        failSettingsReveal({ drawerPresent, panelPresent });
        return;
    }
    closeShell();
    const result = revealSettingsPanel({ ctx: live });
    if (!result.ok) {
        openShell('settings');
        failSettingsReveal({ drawerPresent, panelPresent });
        return;
    }
    globalThis.toastr?.info?.('Neo Terra settings are open in the Extensions drawer.');
}

function failSettingsReveal({ drawerPresent, panelPresent }) {
    const reason = describeMissingSettingsHost({ drawerPresent, panelPresent });
    logger.warn(reason);
    setSettingsStatus(reason, 'error');
}

function setSettingsStatus(text, tone = 'info') {
    const host = document.querySelector('[data-neoterra-settings-status]');
    if (!host) {
        return;
    }
    host.textContent = text ?? '';
    host.dataset.tone = tone;
    host.hidden = !text;
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
    disposeNewspaperReader();
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
    disposeChatRuntimes();
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
        openSettings: openSettingsPanel,
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
        mountClockChipForShell();
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
        disposeChatRuntimes();
        mountedCodexChatId = null;
        disposeMapPanel();
        disposeCodex();
        disposeChoicesBar();
        disposeEncounterBar();
        encounterBar = null;
        disposeEndingPanel();
        if (isShellOpen() && getActiveTab() === 'map') {
            void mountMapPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'characters') {
            void mountCodexPanelForActiveChat();
        }
        refreshSettingsPanel();
        clockChip?.refresh?.();
        void refreshInteractionUi(refreshContext());
    };
    try {
        // ST 1.19 ships camelCase event names (`chat_id_changed`); older builds
        // used `chat_changed`. Read the live map so a chat switch always lands.
        const chatChangedEvent = context?.eventTypes?.CHAT_CHANGED ?? 'chat_id_changed';
        on(chatChangedEvent, handler);
        chatChangeSubscription = { eventSource, handler, event: chatChangedEvent };
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
        off?.call?.(subscription.eventSource, subscription.event ?? 'chat_id_changed', subscription.handler);
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
    disposeClockChip();
    disposeChatRuntimes();
    mountedCodexChatId = null;
    disposeSeasonMenu();
    disposeMapPanel();
    disposeCodex();
    disposeSettingsPanel();
    disposeChoicesBar();
    disposeEncounterBar();
    encounterBar = null;
    disposeEndingPanel();
    document.getElementById('neoterra-choices-host')?.remove();
    document.getElementById('neoterra-encounter-host')?.remove();
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
