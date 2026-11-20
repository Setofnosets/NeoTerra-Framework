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
import { applyContentGate } from '../core/content-gate.js';
import { buildNoticeFrameText, detectNotice } from '../flows/encounter.js';
import { getSettings, resetSettings, setSetting } from '../core/settings.js';
import { mountSeasonMenu, disposeSeasonMenu, refreshSeasonMenu, getSeasonMenuState } from './season-menu.js';
import { mountSessionHome } from './session-home.js';
import { createNewTimeline } from '../flows/new-chat.js';
import { mountClockChip } from './clock-chip.js';
import {
    describeMissingSettingsHost,
    disposeSettingsPanel,
    mountSettingsPanel,
    refreshSettingsPanel,
    revealSettingsPanel,
} from './settings.js';
import { disposeMapPanel, disposeNewspaperReader, loadMapSources, mountMapPanel, openNewspaperFromPanel } from './map-panel.js';
import { disposeCodex, mountCodex } from './codex.js';
import { loadCodexData, loadCardExemplars, resolveCodexRegistry } from './codex-data.js';
import { mountRelationships } from './relationships.js';
import { resolveSceneAvatar } from './avatar.js';
import { mountSensorium } from './sensorium.js';
import {
    mountPlayerPanel,
    disposePlayerPanel as disposeMountedPlayerPanel,
} from './player-panel.js';
import { mountHud, disposeHud } from './hud.js';
import { createWindowManager } from './window-manager.js';
import { mountJournal } from './journal.js';
import { mountCommandPalette } from './command-palette.js';
import { mountTurnStatus } from './turn-status.js';
import { buildArrivalToast, buildErrorToasts, diffWorldState, mountToasts } from './toasts.js';
import { downloadJson } from './download.js';
import { buildArrivalSummary, writeArrivalIntro } from './arrival-summary.js';
import { isDomainTabVisible, resolveActiveTab, resolveVisibleTabs } from './tab-visibility.js';
import { loadRegistry } from '../data/registry.js';
import { loadLocations } from '../data/locations.js';
import { loadProfiles } from '../data/profiles.js';
import { loadDistricts } from '../data/map.js';
import { createWorldBookAdapter } from '../context/worldbook.js';
import { getSharedWorldStateStore, releaseSharedWorldStateStore, loadWorldStateFromMetadata, WAL_PREFIX } from '../state/store.js';
import { selectPresenceIds } from '../state/selectors.js';
import { createTravelFlow, attachTravelToMessage } from '../flows/travel.js';
import { createSceneFlow } from '../flows/scene.js';
import { createInitiative } from '../flows/initiative.js';
import { createWorldTick } from '../flows/world-tick.js';
import { createPacingFlow } from '../flows/pacing.js';
import { createNewsroomFlow } from '../flows/newsroom.js';
import { createDowntimeFlow, DOWNTIME_ACTION_IDS, resolveDowntimeEvents } from '../flows/downtime.js';
import { loadAgendas } from '../data/agendas.js';
import { createNewspaperAgent } from '../agents/newspaper.js';
import { createStorylineTracker } from '../agents/storyline.js';
import { createCastDirector } from '../agents/cast-director.js';
import { createLoreAgent } from '../agents/lore.js';
import { createAuditor } from '../agents/auditor.js';
import { createArchitect } from '../agents/architect.js';
import { createBadEndDetector } from '../agents/bad-end.js';
import { createFormArchitect } from '../agents/form-architect.js';
import { createCharacterCreator } from '../agents/character-creator.js';
import { createGoalInference, ensurePlayerGoals } from '../agents/goal-inference.js';
import { createSceneDescriber } from '../agents/scene-describer.js';
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
import { createBadEndFlow } from '../flows/bad-end.js';
import { mountEndingPanel, disposeEndingPanel } from './ending.js';
import { mountBadEndPanel, disposeBadEndPanel } from './bad-end.js';
import { mountAgentLog } from './agent-log.js';
import { createChoicesController, dispatchChoiceRoute, mountChoicesBar, disposeChoicesBar } from './choices.js';
import {
    avoidEncounter,
    buildCombatResolutionFrameText,
    buildEncounterBarModel,
    disposeEncounterBar,
    encounterFromCombat,
    endEncounterCombat,
    engageEncounter,
    markAmbushOpening,
    mountEncounterBar,
    startEncounterCombat,
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
    applySceneDecorations,
    buildSceneMeta,
    decorateSceneElement,
    extractSceneMeta,
} from './scene-decorator.js';
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
    relations: {
        title: 'Relations',
        body: 'The relationship graph will appear here.',
    },
    domain: {
        title: 'Domain',
        body: 'The villain domain sensorium appears for villain-POV seasons.',
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
const LIVE_PANELS = new Set(['season', 'map', 'characters', 'relations', 'domain', 'player', 'settings']);

/**
 * Gameplay surfaces that live in floating windows instead of the modal shell.
 * They stay in `SHELL_TABS` for slash-command and last-tab compatibility, but
 * the shell nav renders only the remaining tabs.
 */
const WINDOW_TABS = new Set(['map', 'characters', 'relations', 'journal', 'log']);

const WINDOW_SPECS = Object.freeze({
    map: { title: 'City Map', initial: { x: 96, y: 64, width: 1100, height: 680 } },
    characters: { title: 'Character Codex', initial: { x: 140, y: 56, width: 980, height: 720 } },
    relations: { title: 'Relations', initial: { x: 180, y: 72, width: 860, height: 620 } },
    journal: { title: 'Journal', initial: { x: 200, y: 60, width: 820, height: 700 } },
    log: { title: 'Agent log', initial: { x: 260, y: 120, width: 720, height: 480 } },
});

let ctx = null;
let abort = null;
let mounted = false;
let mounting = null;
let mountGeneration = 0;
let registeredCommand = null;
let activeTab = 'season';
let previousFocus = null;
let mapMounted = false;
/** Story tab mode: Session Home when a world exists, the season grid otherwise. */
let storyMode = null;
let storyGridRequested = false;
let storyNotice = null;
let sessionHomePanel = null;
let sessionHomeChatId = null;
let mountingShell = false;
let timelinePending = false;

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

/** Last shell surface used in this chat, when it is still a known tab. */
export function readLastTab(context) {
    const stored = context?.chatMetadata?.neoterra?.ui?.lastTab;
    return SHELL_TABS.some((tab) => tab.id === stored) ? stored : null;
}

/** Persist the last surface per chat. Never writes outside `neoterra.ui`. */
export function rememberLastTab(tabId) {
    try {
        const live = refreshContext();
        const metadata = live?.chatMetadata;
        if (!metadata || typeof metadata !== 'object') {
            return false;
        }
        const neoterra = metadata.neoterra && typeof metadata.neoterra === 'object'
            ? metadata.neoterra
            : (metadata.neoterra = { schemaVersion: 1 });
        const ui = neoterra.ui && typeof neoterra.ui === 'object'
            ? neoterra.ui
            : (neoterra.ui = {});
        if (ui.lastTab === tabId) {
            return false;
        }
        ui.lastTab = tabId;
        live.saveMetadataDebounced?.();
        return true;
    } catch (error) {
        logger.debug('Could not remember the last shell tab', error);
        return false;
    }
}

function shellMarkup() {
    const navTabs = SHELL_TABS.filter((tab) => !WINDOW_TABS.has(tab.id));
    const tabs = navTabs.map(tab => `
        <button type="button" role="tab" class="neoterra-tab" id="neoterra-tab-${tab.id}"
            data-neoterra-tab="${tab.id}" aria-controls="neoterra-panel-${tab.id}"
            aria-selected="${tab.id === activeTab ? 'true' : 'false'}"
            tabindex="${tab.id === activeTab ? '0' : '-1'}">${tab.label}</button>`).join('');

    const panels = navTabs.map(tab => {
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
            ${tab.id === 'relations' ? '<div class="neoterra-relations-host" data-neoterra-relations-host></div>' : ''}
            ${tab.id === 'domain' ? '<div class="neoterra-domain-host" data-neoterra-domain-host></div>' : ''}
            ${tab.id === 'player' ? '<div class="neoterra-player-host" data-neoterra-player-host></div>' : ''}
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
    mountingShell = true;
    document.getElementById(UI_IDS.ROOT)?.remove();
    document.body.insertAdjacentHTML('beforeend', shellMarkup());
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        mountingShell = false;
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
            return;
        }
        if (event.target.closest?.('[data-neoterra-start-season]')) {
            storyGridRequested = true;
            setActiveTab('season');
        }
    }, { signal: abort.signal });

    // The sheet reflects the same per-chat document the map and the turn
    // pipeline write: refresh it whenever the world announces a change.
    playerRefreshOff?.();
    const offMapRefresh = bus.on(EVENTS.MAP_UPDATED, () => {
        playerPanel?.refresh?.();
        sessionHomePanel?.refresh?.();
        journalPanel?.refresh?.();
        refreshHud();
    });
    const offSettingsRefresh = bus.on(EVENTS.SETTINGS_CHANGED, (event) => {
        refreshHud();
        if (!event?.path || event.path === '*' || event.path === 'ui.cinematicChat') {
            decorateSceneFrames(refreshContext());
        }
    });
    playerRefreshOff = () => {
        offMapRefresh();
        offSettingsRefresh();
    };

    // Apply authored-data tab visibility once at mount: before a chat exists
    // the Domain tab must already be hidden, not only after the first click.
    setActiveTab(activeTab);

    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeShell();
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const tabs = [...root.querySelectorAll('[role="tab"]:not([hidden])')];
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

    mountingShell = false;
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
        meta: sceneMetaFor(live, { state: result?.state ?? null }),
    });

    // The post is synchronous up to `saveChat`, so re-check the chat right
    // before writing: a chat switch must never receive another world's frame.
    if (currentChatId(refreshContext() ?? live) !== chatId) {
        logger.warn('Chat changed during season start; skipping the opening frame');
        return null;
    }
    const posted = await postSceneMessage(live, message, {
        dedupeKey: key,
        avatarUrl: resolveSceneAvatar(live),
    });
    if (posted.posted || posted.deduped) {
        decorateSceneAt(live, posted.index);
        closeShell();
    }
    document.getElementById('send_textarea')?.focus?.();
    bus.emit(EVENTS.MAP_UPDATED, { reason: 'season-start', seasonId });

    const settings = getSettings(live);
    // Optional season-start Architect pass (`seasonStart`, default off). It
    // never blocks the opening frame or the CYOA request.
    if (settings?.agents?.architect?.enabled !== false
        && settings?.agents?.architect?.seasonStart === true) {
        const seedChatId = chatId;
        void Promise.resolve().then(async () => {
            const runtime = buildInteractionRuntime(refreshContext() ?? live);
            if (!runtime?.initiative?.runArchitect) {
                return;
            }
            const report = await runtime.initiative.runArchitect();
            if (report?.ran === true && chatStillCurrent(seedChatId)) {
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'architect' });
                ensureToasts().push([{
                    id: 'architect:season-start',
                    type: 'event',
                    title: 'Architect',
                    message: 'The opening layout has been refreshed.',
                    tone: 'info',
                }]);
            }
        }).catch((error) => logger.warn('Season-start Architect pass failed', error));
    }
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
    // Travel chips may only name directly connected ids; the map graph is the
    // one source of truth (it knows bridge overrides and virtual nodes).
    const connections = await buildChoiceConnections(runtime, runtime.store.get());
    const view = await runtime.controller.request({
        messages,
        messageIndex,
        swipeId: 0,
        mode,
        connections,
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
    const wantsHome = hasWorldInChat(context) && !storyGridRequested;
    if (wantsHome) {
        if (storyMode === 'home' && sessionHomePanel
            && sessionHomeChatId === currentChatId(context)) {
            sessionHomePanel.refresh();
            return sessionHomePanel;
        }
        disposeSeasonMenu();
        disposeSessionHome();
        storyMode = 'home';
        sessionHomeChatId = currentChatId(context);
        sessionHomePanel = mountSessionHome({
            root: host,
            getContext: refreshContext,
            onAction: (action) => handleSessionHomeAction(action),
        });
        return sessionHomePanel;
    }
    if (storyMode === 'grid' && getSeasonMenuState() && !storyNotice) {
        // Keep the wizard/filter state when the grid is already mounted.
        refreshSeasonMenu();
        return getSeasonMenuState();
    }
    disposeSessionHome();
    storyMode = 'grid';
    const notice = storyNotice;
    storyNotice = null;
    try {
        return await mountSeasonMenu({
            root: host,
            ctx: context,
            getContext: refreshContext,
            notice,
            onEntered: (result) => {
                storyGridRequested = false;
                handleSeasonEntered(result).catch((error) => {
                    logger.warn('Could not hand the season start back to the chat', error);
                });
            },
            onKeepCurrentWorld: () => {
                // "Keep current world" returns to Session Home, not to the
                // identity step in front of a destructive replace prompt.
                storyGridRequested = false;
                void mountSeasonPanel(refreshContext());
            },
        });
    } catch (error) {
        logger.warn('Could not mount the season menu', error);
        return null;
    }
}

export function hasWorldInChat(context) {
    return Boolean(context?.chatMetadata?.neoterra?.worldState);
}

/* ------------------------------------------------------------------ */
/* Scene-card decoration                                               */
/* ------------------------------------------------------------------ */

function cinematicChatEnabled(context) {
    try {
        return getSettings(context)?.ui?.cinematicChat !== false;
    } catch (error) {
        logger.debug('Could not read cinematic chat setting', error);
        return true;
    }
}

/** Structured scene meta from the live world: location, time, POV, present. */
function sceneMetaFor(live, { locationId = null, locationName = null, state: providedState = null } = {}) {
    const neoterra = live?.chatMetadata?.neoterra ?? {};
    const state = providedState ?? neoterra.worldState ?? null;
    const resolvedLocation = locationId ?? state?.scene?.locationId ?? null;
    const name = locationName
        ?? (resolvedLocation ? state?.locations?.[resolvedLocation]?.name ?? null : null);
    const player = state?.player ?? null;
    const character = player?.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    const pov = character?.displayName ?? player?.displayName ?? null;
    // Presence is NPC-only: the fallback must not re-add the player when the
    // stored `scene.present` is empty at a player-only location.
    const present = Array.isArray(state?.scene?.present) && state.scene.present.length > 0
        ? selectPresenceIds(state, state.scene.present)
        : selectPresenceIds(state, Object.values(state?.characters ?? {})
            .filter((entry) => resolvedLocation && entry?.locationId === resolvedLocation)
            .map((entry) => entry.charId)
            .filter(Boolean));
    return buildSceneMeta({
        locationId: resolvedLocation,
        locationName: name,
        timeSlot: state?.meta?.timeOfDay ?? null,
        pov,
        present,
    });
}

/** Decorate one freshly posted (or re-rendered) frame without touching `mes`. */
export function decorateSceneAt(live, index) {
    if (!hasDom() || !Number.isInteger(index) || index < 0) {
        return false;
    }
    const messages = Array.isArray(live?.chat) ? live.chat : [];
    const model = extractSceneMeta(messages[index]);
    if (!model) {
        return false;
    }
    const element = document.querySelector(`.mes[mesid="${index}"]`);
    if (!element) {
        return false;
    }
    return decorateSceneElement(element, model, { cinematic: cinematicChatEnabled(live) });
}

/** Re-decorate the whole open chat (reload, chat switch, render event sweep). */
export function decorateSceneFrames(context = null) {
    if (!hasDom()) {
        return { decorated: 0, runs: [] };
    }
    const live = context ?? refreshContext();
    const root = document.getElementById('chat');
    return applySceneDecorations({
        root,
        messages: Array.isArray(live?.chat) ? live.chat : [],
        cinematic: cinematicChatEnabled(live),
        doc: document,
    });
}

/* ------------------------------------------------------------------ */
/* Persistent session HUD                                              */
/* ------------------------------------------------------------------ */

let hudPanel = null;
let hudChatId = null;

function hudEnabled(context) {
    try {
        return getSettings(context)?.ui?.hudEnabled !== false;
    } catch (error) {
        logger.debug('Could not read the HUD setting', error);
        return true;
    }
}

/**
 * Mount or refresh the gameplay HUD. It is hidden on a chat without a world and
 * rebuilt per chat so a switch cannot paint the previous timeline's meters.
 */
function refreshHud(context = null) {
    if (!hasDom()) {
        return null;
    }
    const live = context ?? refreshContext();
    if (!hasWorldInChat(live) || !hudEnabled(live ?? ctx)) {
        hudPanel?.dispose?.();
        hudPanel = null;
        hudChatId = null;
        disposeHud();
        return null;
    }
    const chatId = currentChatId(live);
    if (hudPanel && hudChatId === chatId) {
        hudPanel.refresh();
        return hudPanel;
    }
    hudPanel?.dispose?.();
    hudPanel = null;
    hudChatId = chatId;
    hudPanel = mountHud({
        getContext: refreshContext,
        getSettings: (requested) => {
            try {
                return getSettings(requested ?? refreshContext() ?? ctx);
            } catch (error) {
                logger.debug('Could not read settings for the HUD', error);
                return null;
            }
        },
        onAction: (action) => handleHudAction(action),
        onToggleCollapsed: (collapsed) => {
            const current = refreshContext() ?? ctx;
            try {
                setSetting(current, 'ui.hudCollapsed', collapsed === true);
            } catch (error) {
                logger.warn('Could not save the HUD collapse state', error);
            }
            hudPanel?.refresh();
        },
    });
    return hudPanel;
}

function handleHudAction(action) {
    if (!action) {
        return;
    }
    if (typeof action === 'string' && action.startsWith('downtime:')) {
        void performDowntime(action.slice('downtime:'.length));
        return;
    }
    if (action === 'map' || action === 'characters') {
        openWindowTab(action);
        return;
    }
    if (action === 'player') {
        openShell(action);
        return;
    }
    if (action === 'newspaper') {
        openWindowTab('map');
        // The map mount is async and the reader control only exists when an
        // edition is present; retry briefly instead of clicking a stale node.
        let attempts = 0;
        const openReader = () => {
            if (openNewspaperFromPanel()) {
                return;
            }
            attempts += 1;
            if (attempts < 8) {
                setTimeout(openReader, 250);
            }
        };
        setTimeout(openReader, 250);
        return;
    }
    if (action === 'journal') {
        openWindowTab('journal');
    }
}

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

let commandPalette = null;

function openCommandPalette() {
    if (!hasDom()) {
        return null;
    }
    commandPalette?.dispose?.();
    commandPalette = mountCommandPalette({
        onAction: (action) => handlePaletteAction(action),
        onClose: () => {
            commandPalette = null;
        },
    });
    return commandPalette;
}

function handlePaletteAction(action) {
    if (!action?.id) {
        return;
    }
    if (DOWNTIME_ACTION_IDS.includes(action.id)) {
        void performDowntime(action.id);
        return;
    }
    if (action.id === 'travel') {
        openWindowTab('map');
        return;
    }
    if (action.id === 'cast') {
        openWindowTab('characters');
        return;
    }
    if (action.id === 'player') {
        openShell('player');
        return;
    }
    if (action.id === 'journal') {
        openWindowTab('journal');
        return;
    }
    if (action.id === 'newspaper') {
        handleHudAction('newspaper');
        return;
    }
    if (action.id === 'new-timeline') {
        void startNewTimeline();
        return;
    }
    if (action.command) {
        closeShell();
        sendChoiceText(action.command);
    }
}

/** Apply one deterministic downtime action and refresh the visible surfaces. */
async function performDowntime(actionId) {
    const live = refreshContext();
    const runtime = buildInteractionRuntime(live);
    if (!runtime?.downtime) {
        return null;
    }
    const before = snapshotWorldState(runtime.store.get());
    const result = await runtime.downtime.perform(actionId);
    if (!result?.ok) {
        ensureToasts().push([{
            id: `downtime-error:${actionId}`,
            type: 'error',
            title: 'Downtime',
            message: result?.reason === 'unknown-action'
                ? 'That downtime action is not available.'
                : (result?.error ?? 'The downtime action could not be applied.'),
            tone: 'warning',
        }]);
        return result;
    }
    try {
        ensureToasts().push([
            {
                id: `downtime:${actionId}:${result.turn ?? ''}`,
                type: 'downtime',
                title: result.action?.label ?? 'Downtime',
                message: result.summary ?? 'The city moves on.',
                tone: 'info',
            },
            ...diffWorldState(before, runtime.store.get()),
        ]);
    } catch (error) {
        logger.debug('Could not build downtime toasts', error);
    }
    bus.emit(EVENTS.MAP_UPDATED, { reason: 'downtime', action: actionId });
    mapRuntime?.panelRef?.refresh?.();
    await refreshInteractionUi(live);
    return result;
}

function disposeCommandPalette() {
    commandPalette?.dispose?.();
    commandPalette = null;
}

function disposeHudPanel() {
    hudPanel?.dispose?.();
    hudPanel = null;
    hudChatId = null;
    disposeHud();
}

/* ------------------------------------------------------------------ */
/* Floating gameplay windows                                           */
/* ------------------------------------------------------------------ */

let windowManager = null;

function ensureWindowManager() {
    if (!hasDom()) {
        return null;
    }
    if (windowManager) {
        return windowManager;
    }
    windowManager = createWindowManager({
        getScope: () => currentChatId(refreshContext()) ?? 'global',
    });
    // The no-world map CTA lives inside a window; delegate it here so it can
    // close the window and open the Story wizard without a tab-host handler.
    windowManager?.layer?.addEventListener('click', (event) => {
        if (!event.target.closest?.('[data-neoterra-start-season]')) {
            return;
        }
        windowManager?.close('map');
        storyGridRequested = true;
        openShell('season');
    });
    return windowManager;
}

function windowMountFor(tabId) {
    if (tabId === 'map') {
        return (host) => mountMapPanelComponent(refreshContext() ?? ctx, host, { hosted: true });
    }
    if (tabId === 'characters') {
        return (host) => mountCodexPanelComponent(refreshContext() ?? ctx, host);
    }
    if (tabId === 'relations') {
        return (host) => mountRelationsPanelComponent(refreshContext() ?? ctx, host);
    }
    if (tabId === 'journal') {
        return (host) => mountJournalPanelComponent(refreshContext() ?? ctx, host);
    }
    if (tabId === 'log') {
        return (host) => {
            const controller = mountAgentLog(host);
            return {
                refresh: () => controller?.render?.(),
                dispose: () => controller?.destroy?.(),
            };
        };
    }
    return null;
}

function windowDisposeFor(tabId) {
    if (tabId === 'map') {
        disposeMapPanel();
        mountedMapChatId = null;
        return;
    }
    if (tabId === 'characters') {
        const chatId = mountedCodexChatId;
        disposeCodex();
        mountedCodexChatId = null;
        // The codex now shares the chat's store. If it was the only runtime
        // using it, release it here: closing the window would otherwise leave
        // a stale document in the shared registry for the next chat run.
        const stillOwned = chatId
            && (mapRuntime?.chatId === chatId
                || interactionRuntime?.chatId === chatId
                || mountedPlayerChatId === chatId);
        if (chatId && !stillOwned) {
            releaseSharedWorldStateStore(chatId);
        }
        return;
    }
    if (tabId === 'relations') {
        disposeRelationsPanel();
        mountedRelationsChatId = null;
        return;
    }
    if (tabId === 'journal') {
        disposeJournalPanel();
    }
}

/** Open Map, Codex, or Relations over the chat; the shell stays closed. */
export function openWindowTab(tabId) {
    if (!WINDOW_TABS.has(tabId) || !hasDom()) {
        return null;
    }
    // A window over a full-screen modal is unreachable, so the shell closes
    // first: the chat remains scrollable and the send form stays usable.
    closeShell();
    const wm = ensureWindowManager();
    if (!wm) {
        return openShellLegacyTab(tabId);
    }
    const spec = WINDOW_SPECS[tabId];
    const handle = wm.open({
        id: tabId,
        title: spec.title,
        initial: spec.initial,
        mount: windowMountFor(tabId),
        onClose: () => windowDisposeFor(tabId),
    });
    wm.focus(tabId);
    bus.emit(EVENTS.WINDOW_OPENED, { id: tabId });
    return handle;
}

/** Fallback for environments without a mountable window layer. */
function openShellLegacyTab(tabId) {
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return null;
    }
    root.hidden = false;
    root.classList.add('is-open');
    activeTab = tabId;
    root.dataset.activeTab = tabId;
    for (const tab of root.querySelectorAll('[role="tab"]')) {
        tab.setAttribute('aria-selected', tab.dataset.neoterraTab === tabId ? 'true' : 'false');
    }
    for (const panel of root.querySelectorAll('[data-neoterra-panel]')) {
        panel.hidden = panel.dataset.neoterraPanel !== tabId;
    }
    return null;
}

/**
 * Closing the map surface means closing its window when hosted, or the shell
 * when an older layout mounted it as a tab.
 */
function closeMapSurface() {
    if (windowManager?.isOpen('map')) {
        windowManager.close('map');
        return true;
    }
    return closeShell();
}

/** Rebuild an open window's content after its cached runtime was dropped. */
function remountWindow(tabId) {
    if (!windowManager?.isOpen(tabId)) {
        return;
    }
    windowManager.close(tabId, { silent: true });
    // The silent close skipped onClose, so the module-level panel singleton
    // must be dropped here or the remount early-returns a detached controller.
    windowDisposeFor(tabId);
    openWindowTab(tabId);
}

function closeWindowLayer() {
    windowManager?.dispose();
    windowManager = null;
}

function disposeSessionHome() {
    sessionHomePanel?.dispose?.();
    sessionHomePanel = null;
    sessionHomeChatId = null;
}

function handleSessionHomeAction(action) {
    if (action === 'continue') {
        closeShell();
        document.getElementById('send_textarea')?.focus?.();
        return;
    }
    if (action === 'new-timeline') {
        void startNewTimeline();
        return;
    }
    if (action === 'map' || action === 'characters' || action === 'player') {
        setActiveTab(action);
        return;
    }
    if (action === 'journal') {
        openWindowTab('journal');
        return;
    }
    if (action === 'season') {
        storyGridRequested = true;
        void mountSeasonPanel(refreshContext());
    }
}

/**
 * "New timeline" creates a new chat, leaving the current timeline intact.
 * Only a failed creation falls back to the explicit replace confirmation.
 */
async function startNewTimeline() {
    if (timelinePending) {
        return { ok: false, reason: 'pending' };
    }
    timelinePending = true;
    try {
        const live = refreshContext() ?? ctx;
        const result = await createNewTimeline({ ctx: live });
        if (!result.ok) {
            storyGridRequested = true;
            storyNotice = result.message ?? 'A new chat could not be created.';
            await mountSeasonPanel(refreshContext());
            return result;
        }
        // The new chat has no world yet: show the season grid so the user can
        // start a fresh timeline there.
        storyGridRequested = true;
        storyNotice = null;
        invalidateChatRuntimes(refreshContext() ?? live);
        await mountSeasonPanel(refreshContext());
        return result;
    } finally {
        timelinePending = false;
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
    const settings = () => getSettings(context);
    const log = (message, error) => logger.warn(message, error);
    const storyline = createStorylineTracker({ runner, getSettings: settings, log });
    const ending = createEndingFlow({
        store,
        agent: createEpilogueAgent({ runner, getSettings: settings, log }),
        season,
        getSettings: settings,
        log,
    });
    const castDirector = createCastDirector({ runner, getSettings: settings, log });
    const lore = createLoreAgent({ runner, getSettings: settings, log });
    const auditor = createAuditor({ runner, getSettings: settings, log });
    const architect = createArchitect({ runner, getSettings: settings, log });
    const initiative = createInitiative({
        store,
        season,
        storyline,
        ending,
        lore,
        auditor,
        architect,
        getSettings: settings,
        log,
    });
    return { initiative, ending, runner, castDirector };
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
    const { initiative, ending, runner, castDirector } = sharedInteraction?.initiative
        ? {
            initiative: sharedInteraction.initiative,
            ending: sharedInteraction.ending,
            runner: sharedInteraction.runner,
            castDirector: sharedInteraction.castDirector,
        }
        : buildStorylineInitiative(context, store, season);
    const scene = sharedInteraction?.scene ?? createSceneFlow({
        store,
        season,
        director: castDirector ?? null,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const travel = createTravelFlow({
        store,
        season,
        scene,
        initiative,
        getSettings: () => getSettings(context),
        // Read through the live runtime so a panel remount (same chat) still
        // supplies the current overrides. A chip-driven travel may run before
        // the map has ever been opened, so fall back to the same loaders the
        // panel uses instead of failing with "no sources".
        loadSources: async () => {
            const fromPanel = mapRuntime?.panelRef?.getSources?.()
                ?? panelRef?.getSources?.()
                ?? null;
            return fromPanel ?? loadMapSources();
        },
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
        castDirector: castDirector ?? null,
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
    getSettings: readSettings = (live) => getSettings(live),
    noticeDetector = detectNotice,
    combatFlow = null,
    describer = null,
    now = Date.now,
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
        meta: sceneMetaFor(live, {
            locationId: result?.to ?? null,
            locationName: result?.toName ?? null,
            state: result?.state ?? null,
        }),
    });
    // Attach before posting so the persisted frame carries the travel record.
    if (result?.messageExtra) {
        attachTravelToMessage(message, result.messageExtra);
    }
    const posted = await postSceneMessage(live, message, {
        dedupeKey: key,
        avatarUrl: resolveSceneAvatar(live),
    });
    if (!posted.posted && !posted.deduped) {
        return posted;
    }
    // The arrival frame is decorated while the message element is fresh; a
    // reload re-runs the same decorator from the render subscription.
    decorateSceneAt(live, posted.index);
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

    // Perception is a second, deterministic frame. A hostile may notice the
    // player (no state change) or, in a hostile/contested place on a strong
    // roll, spring an ambush: one combat start with a restricted first round.
    let choicesIndex = posted.index;
    let choicesMode = null;
    let settingsNow = {};
    try {
        settingsNow = (typeof readSettings === 'function' ? readSettings(afterSave) : null) ?? {};
    } catch (error) {
        logger.debug('Could not read the travel settings', error);
    }
    const encounter = result?.state?.scene?.encounter ?? null;
    let notice = null;
    try {
        notice = typeof noticeDetector === 'function'
            ? noticeDetector({
                state: result?.state ?? null,
                encounter,
                noticeFirst: settingsNow?.travel?.noticeFirst !== false,
                ambush: settingsNow?.travel?.ambush !== false,
            })
            : null;
    } catch (error) {
        logger.debug('Could not run the arrival perception check', error);
    }
    if (notice?.noticedFirst) {
        const noticeKey = buildSceneKey(
            'encounter',
            chatId,
            result?.from,
            result?.to,
            turn,
            notice.ambush ? 'ambush' : 'notice',
        );
        const rawText = buildNoticeFrameText({ state: result.state, notice });
        const text = applyContentGate(
            rawText,
            settingsNow?.contentGate ?? 'full',
            settingsNow?.contentLimits ?? {},
            { isPlayer: true },
        ).trim();
        if (text.length > 0) {
            const message = buildSceneChatMessage({
                kind: SCENE_KINDS.ENCOUNTER,
                text,
                key: noticeKey,
                extra: {
                    actorId: notice.actorId ?? null,
                    ambush: notice.ambush === true,
                    locationId: result?.to ?? null,
                },
            });
            const postedNotice = await postSceneMessage(afterSave, message, {
                dedupeKey: noticeKey,
                avatarUrl: resolveSceneAvatar(afterSave),
            }).catch((error) => {
                logger.warn('Could not post the arrival notice; the travel frame stands', error);
                return null;
            });
            if (postedNotice) {
                decorateSceneAt(afterSave, postedNotice.index);
                if (postedNotice.posted || postedNotice.deduped) {
                    choicesIndex = postedNotice.index;
                }
            }
        }
        if (notice.ambush) {
            const flow = combatFlow
                ?? (() => {
                    try {
                        return buildInteractionRuntime(afterSave)?.combat ?? null;
                    } catch (error) {
                        logger.debug('Could not build the combat flow for an ambush', error);
                        return null;
                    }
                })();
            const started = startEncounterCombat({
                flow,
                state: result?.state ?? null,
                encounter,
            });
            if (started.ok) {
                markAmbushOpening(runtime?.store ?? null, {
                    actorId: notice.actorId ?? null,
                    actorName: notice.actorName ?? null,
                    now: typeof now === 'function' ? now : Date.now,
                });
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'combat-start', ambush: true });
                choicesMode = 'combat';
            } else {
                logger.warn('The ambush could not start combat; the notice frame stands', started.message);
            }
        }
    }

    try {
        await requestChoices(afterSave, choicesIndex, choicesMode ? { mode: choicesMode } : undefined);
    } catch (error) {
        logger.warn('Could not request choices after travel; the frame stands', error);
    }

    // Optional atmospheric description. It never blocks the arrival (the map
    // already closed through onPosted) and never posts on failure, timeout, or
    // a chat switch. The deterministic frame above is the canonical one.
    const activeDescriber = describer;
    if (activeDescriber && typeof activeDescriber.run === 'function') {
        try {
            const description = await activeDescriber.run({
                state: result?.state ?? null,
                season: afterSave?.chatMetadata?.neoterra?.seasonDefinition ?? null,
                encounter,
                notice,
                settings: settingsNow,
            });
            if (description?.ok && typeof description.description === 'string') {
                const stillLive = resolveContext() ?? afterSave;
                if (getChatId(stillLive) === chatId) {
                    const text = applyContentGate(
                        description.description,
                        settingsNow?.contentGate ?? 'full',
                        settingsNow?.contentLimits ?? {},
                        { isPlayer: true },
                    ).trim();
                    if (text.length > 0) {
                        const descKey = buildSceneKey('scene-desc', chatId, key);
                        const message = buildSceneChatMessage({
                            kind: SCENE_KINDS.SCENE,
                            text,
                            key: descKey,
                            extra: { travelKey: key, locationId: result?.to ?? null },
                        });
                        const postedDescription = await postSceneMessage(stillLive, message, {
                            dedupeKey: descKey,
                            avatarUrl: resolveSceneAvatar(stillLive),
                        }).catch((error) => {
                            logger.debug('Could not post the travel description', error);
                            return null;
                        });
                        if (postedDescription) {
                            decorateSceneAt(stillLive, postedDescription.index);
                            try {
                                const store = runtime?.store ?? null;
                                const current = store?.get?.();
                                if (current && (postedDescription.posted || postedDescription.deduped)) {
                                    const cloned = snapshotWorldState(current);
                                    if (cloned) {
                                        const existing = Array.isArray(cloned.flags?.travelDescriptions)
                                            ? cloned.flags.travelDescriptions
                                            : [];
                                        cloned.flags = {
                                            ...(cloned.flags ?? {}),
                                            travelDescriptions: [
                                                ...existing,
                                                {
                                                    key,
                                                    text,
                                                    at: typeof now === 'function' ? now() : Date.now(),
                                                },
                                            ].slice(-10),
                                        };
                                        store.replace(cloned);
                                    }
                                }
                            } catch (error) {
                                logger.debug('Could not record the travel description', error);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.debug('The travel description failed; the arrival frame stands', error);
        }
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

/**
 * Should an accepted travel announce itself to the player? Exported for tests.
 *
 * `alreadyThere` is a no-op, not an arrival. The setting is the single switch
 * for every arrival cue. A chat switch during the awaited post must not land
 * the cue in the new chat: when the runtime has a chat id, the live id must
 * match it (a missing live id is treated as unknown, not as a match).
 */
export function shouldAnnounceArrival({ result, settings, liveChatId = null, chatId = null } = {}) {
    if (!result || result.ok !== true || result.alreadyThere === true) {
        return false;
    }
    if (settings?.map?.arrivalFeedback === false) {
        return false;
    }
    if (chatId) {
        return liveChatId === chatId;
    }
    return !liveChatId;
}

/**
 * Should the map toolbar's Return-to-chat button pulse? Only when the arrival
 * cues are on and the map is staying open (a closing map has nothing to
 * point at). Pure; exported for tests.
 */
export function shouldPulseReturn({ settings, posted } = {}) {
    if (settings?.map?.arrivalFeedback === false) {
        return false;
    }
    return !shouldCloseAfterTravel(posted, settings);
}

/** Is the map currently visible (hosted window or the legacy tab)? */
function isMapSurfaceOpen() {
    try {
        if (windowManager?.isOpen?.('map')) {
            return true;
        }
    } catch {
        // A missing window manager means the legacy tab layout.
    }
    return isShellOpen() && getActiveTab() === 'map';
}

/**
 * One travel execution shared by the map and by routed travel chips. Returns
 * `{ ok, result, posted }` instead of throwing; the caller decides whether to
 * show a status line (a chip) or keep the map open (the map handler).
 */
/** The describer may live on the map runtime or on the interaction runtime. */
function resolveSceneDescriber(runtime, live) {
    if (runtime?.sceneDescriber) {
        return runtime.sceneDescriber;
    }
    try {
        return buildInteractionRuntime(live)?.sceneDescriber ?? null;
    } catch (error) {
        logger.debug('Could not build the scene describer', error);
        return null;
    }
}

async function runTravelTo(context, runtime, panelRef, to, { remountOnChatSwitch = false } = {}) {
    const travel = runtime?.travel ?? null;
    if (!travel || typeof to !== 'string' || to.length === 0) {
        return { ok: false, reason: travel ? 'no-destination' : 'no-travel' };
    }
    // The user may have switched chats with the map open. Never write into
    // the previous chat's timeline (or onto the new chat's message).
    const live = refreshContext();
    const liveChatId = currentChatId(live ?? context);
    if (liveChatId && liveChatId !== runtime.chatId) {
        if (remountOnChatSwitch) {
            logger.info('Chat changed; remounting the map before travel');
            disposeMapPanel();
            mountedMapChatId = null;
            await mountMapPanelForActiveChat();
        }
        return { ok: false, reason: 'chat-changed' };
    }
    const beforeTravel = snapshotWorldState(runtime.store.get());
    const result = await travel.travel({ to });
    if (!result.ok) {
        logger.info('Travel rejected', { reason: result.reason, message: result.message });
        bus.emit(EVENTS.MAP_UPDATED, { travel: result });
        return { ok: false, reason: result.reason ?? 'rejected', result };
    }
        // Arrivals/departures from the Cast Director are surfaced once per
        // travel; the toast stack dedupes ids across later repaints.
        try {
            ensureToasts().push(diffWorldState(beforeTravel, runtime.store.get()));
        } catch (error) {
            logger.debug('Could not build travel toasts', error);
        }
        // `onPosted` fires before the choices round-trip, so the handoff back to
        // the chat is immediate instead of waiting on an agent-backed request.
        const announce = (posted = null) => {
            panelRef?.refresh?.();
            bus.emit(EVENTS.MAP_UPDATED, { travel: result, intro: result.intro ?? null });
            let settingsNow = null;
            try {
                settingsNow = getSettings(refreshContext() ?? context);
            } catch (error) {
                logger.debug('Could not read map settings', error);
            }
            let shouldClose = false;
            try {
                shouldClose = shouldCloseAfterTravel(posted, settingsNow);
            } catch (error) {
                logger.debug('Could not read map.closeOnTravel', error);
            }
            // Arrival cues fire from the travel flow, never the turn diff. A
            // chat switch during the awaited post must not toast into the new
            // chat, and `alreadyThere`/rejected travel is not an arrival.
            const liveChatId = currentChatId(refreshContext() ?? context);
            const announceArrival = shouldAnnounceArrival({
                result,
                settings: settingsNow,
                liveChatId,
                chatId: runtime.chatId,
            });
            const summary = announceArrival
                ? buildArrivalSummary({ result, state: runtime.store.get() })
                : null;
            if (summary && settingsNow?.map?.arrivalFeedback !== false) {
                try {
                    ensureToasts().push([buildArrivalToast(summary, { mapStayedOpen: !shouldClose })]);
                } catch (error) {
                    logger.debug('Could not show the arrival toast', error);
                }
            }
            // Persist the arrival prose and its arrival-time facts so the
            // sidebar card survives the panel being disposed (close → reopen).
            if (announceArrival && summary?.key && result.intro?.text) {
                writeArrivalIntro(refreshContext() ?? context, summary.key, result.intro.text, {
                    timeSlot: summary.timeSlot,
                    district: summary.district,
                    turns: summary.turns,
                    hasEncounter: summary.hasEncounter,
                    hostiles: summary.hostiles,
                });
            }
            // Only a real arrival that leaves the map open pulses the Return
            // button; a closing map has nothing to point at.
            if (announceArrival && shouldPulseReturn({ settings: settingsNow, posted })) {
                try {
                    panelRef?.pulseArrival?.({ key: summary?.key ?? null });
                } catch (error) {
                    logger.debug('Could not pulse the Return button', error);
                }
            }
            // A chip-driven trip runs while the chat is visible: only close a
            // surface that is actually open, never the shell on another tab.
            if (shouldClose && isMapSurfaceOpen()) {
                closeMapSurface();
            }
        };
        if (result.alreadyThere === true) {
            announce();
            return { ok: true, result, posted: null, alreadyThere: true };
        }
        const posted = await postTravelOutcome(context, runtime, result, {
            onPosted: announce,
            describer: resolveSceneDescriber(runtime, live),
        })
            .catch((error) => {
                // The move is already committed. A save/post failure must not
                // swallow the arrival cue: announce what happened.
                logger.warn('Travel arrival frame failed; keeping the move', error);
                return null;
            });
        if (!posted) {
            // No chat/aborted post: still let the map reflect the committed move.
            announce();
            return { ok: true, result, posted: null };
        }
        // A partial post (chat array only, no renderer) still needs its choices.
        if (!posted.posted && !posted.deduped) {
            announce(posted);
        }
        return { ok: true, result, posted };
}

function buildMapTravelHandler(context, runtime, panelRef) {
    if (!runtime?.travel) {
        return null;
    }
    return async (request) => {
        if (!request?.to) {
            return false;
        }
        const outcome = await runTravelTo(context, runtime, panelRef, request.to, {
            remountOnChatSwitch: true,
        });
        return outcome.ok === true;
    };
}

/** Re-read the live context so a chat switch is visible, then mount the map. */
async function mountMapPanelForActiveChat() {
    return mountMapPanelComponent(refreshContext());
}

async function mountMapPanelComponent(context, host = document.querySelector('[data-neoterra-map-host]'), { hosted = false } = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!host) {
        return null;
    }
    if (!hasWorldInChat(context)) {
        // No world: one CTA instead of an empty map with disabled travel.
        disposeMapPanel();
        mountedMapChatId = null;
        host.innerHTML = `
        <div class="neoterra-map-empty" data-neoterra-map-empty>
            <h3>No world in this chat</h3>
            <p>Start a season to unlock the districts, travel, and the living city.</p>
            <button type="button" class="menu_button" data-neoterra-start-season>Start a season</button>
        </div>`;
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
            pulseArrival: (payload) => ref.panel?.pulseArrival?.(payload),
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
            registry: context?.chatMetadata?.neoterra?.registry ?? null,
            settings: mapSettingsNow(),
            getSettings: mapSettingsNow,
            getContext: () => refreshContext() ?? context,
            store: runtime?.store ?? null,
            pacing: runtime?.pacing ?? null,
            scene: runtime?.scene ?? null,
            initiative: runtime?.initiative ?? null,
            hosted,
            onFogChange: (enabled) => {
                try {
                    setSetting(refreshContext() ?? context, 'map.showFogOfWar', enabled === true);
                } catch (error) {
                    logger.warn('Could not save the fog setting', error);
                }
            },
            onTravel,
            // The toolbar X used to only send CLOSE to the panel's own state
            // machine, so nothing visible happened. The host closes the map
            // window (or the shell in the legacy tab layout).
            onClose: () => closeMapSurface(),
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

async function mountCodexPanelComponent(context, host = document.querySelector('[data-neoterra-codex-host]')) {
    if (!hasDom()) {
        return null;
    }
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
        const { season, registry, formGroups, formRules, profiles, factions, locations, districts } = await loadCodexData({ metadata });
        let codexRunner = null;
        try {
            codexRunner = createAgentRunner({ client: createAgentClient({ ctx: context }) });
        } catch (error) {
            logger.debug('Form Architect runner unavailable; missing forms fall back', error);
        }
        const formArchitect = createFormArchitect({
            runner: codexRunner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        });
        const characterCreator = createCharacterCreator({
            runner: codexRunner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        });
        const goalInference = createGoalInference({
            runner: codexRunner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        });
        const store = getSharedWorldStateStore({
            metadata,
            // Read the live context at save time: the codex may be the first
            // runtime to open the store, and a captured `context` from that
            // mount would pin an old chat's metadata closure.
            saveMetadataDebounced: () => (refreshContext() ?? context)?.saveMetadataDebounced?.(),
            storage: readLocalStorage(),
            chatId,
            context: { registry, formGroups, formRules },
        });
        return mountCodex({
            root: host,
            store,
            // The shell's runtime lifecycle owns the shared store; the codex
            // must not cancel its pending saves when the panel is disposed.
            ownsStore: false,
            season,
            registry,
            formGroups,
            formRules,
            profiles,
            ctx: context,
            formArchitect,
            characterCreator,
            goalInference,
            pushToast: (toasts, meta) => {
                if (meta?.playerCard) {
                    for (const toast of toasts ?? []) {
                        if (toast?.id) {
                            pendingPlayerCards.set(toast.id, meta.playerCard);
                        }
                    }
                }
                ensureToasts().push(toasts);
            },
            creatorData: { factions, locations, districts },
            loadExemplars: () => loadCardExemplars({
                registry,
                seasonId: season?.id ?? null,
            }),
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

/* ------------------------------------------------------------------ */
/* Relations graph                                                     */
/* ------------------------------------------------------------------ */

let relationsPanel = null;
let mountedRelationsChatId = null;

function disposeRelationsPanel() {
    relationsPanel?.dispose?.();
    relationsPanel = null;
}

async function mountRelationsPanelForActiveChat() {
    return mountRelationsPanelComponent(refreshContext());
}

async function mountRelationsPanelComponent(context, host = document.querySelector('[data-neoterra-relations-host]')) {
    if (!hasDom()) {
        return null;
    }
    if (!host) {
        return null;
    }
    const chatId = currentChatId(context);
    if (mountedRelationsChatId && mountedRelationsChatId !== chatId) {
        disposeRelationsPanel();
    }
    mountedRelationsChatId = chatId;
    if (relationsPanel && chatId) {
        // Re-activating the tab must keep the user's selection and filters.
        relationsPanel.refresh();
        return relationsPanel;
    }
    try {
        const metadata = context?.chatMetadata;
        const resolved = resolveCodexRegistry(metadata);
        const registry = chatId ? await resolved.registry : null;
        // A chat switch during the fetch must not paint into the new chat.
        if (mountedRelationsChatId !== chatId) {
            return null;
        }
        disposeRelationsPanel();
        relationsPanel = mountRelationships({
            root: host,
            getState: () => liveWorldState(),
            getRegistry: () => registry,
            getSettings: () => getSettings(refreshContext() ?? context),
        });
        return relationsPanel;
    } catch (error) {
        logger.warn('Could not mount the relationship graph', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The relationship graph could not be mounted.</p>';
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

let journalPanel = null;
let mountedJournalChatId = null;

function disposeJournalPanel() {
    journalPanel?.dispose?.();
    journalPanel = null;
    mountedJournalChatId = null;
}

async function mountJournalPanelComponent(context, host = null) {
    if (!hasDom()) {
        return null;
    }
    if (!host) {
        return null;
    }
    const chatId = currentChatId(context);
    if (mountedJournalChatId && mountedJournalChatId !== chatId) {
        disposeJournalPanel();
    }
    mountedJournalChatId = chatId;
    if (journalPanel) {
        journalPanel.refresh();
        return journalPanel;
    }
    try {
        journalPanel = mountJournal({
            root: host,
            getState: () => liveWorldState(),
            getSeason: () => currentSeasonDefinition(),
            onClose: () => {
                if (windowManager?.isOpen('journal')) {
                    windowManager.close('journal');
                }
            },
        });
        return journalPanel;
    } catch (error) {
        logger.warn('Could not mount the journal', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The journal could not be mounted.</p>';
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Domain sensorium (villain POV)                                      */
/* ------------------------------------------------------------------ */

let domainPanel = null;
let mountedDomainChatId = null;

function currentSeasonDefinition(context = refreshContext()) {
    return context?.chatMetadata?.neoterra?.seasonDefinition ?? null;
}

function disposeDomainPanel() {
    domainPanel?.dispose?.();
    domainPanel = null;
}

async function mountDomainPanelForActiveChat() {
    return mountDomainPanelComponent(refreshContext());
}

async function mountDomainPanelComponent(context) {
    if (!hasDom()) {
        return null;
    }
    const host = document.querySelector('[data-neoterra-domain-host]');
    if (!host) {
        return null;
    }
    const chatId = currentChatId(context);
    const season = currentSeasonDefinition(context);
    if (!isDomainTabVisible(liveWorldState(), season)) {
        disposeDomainPanel();
        host.innerHTML = '<p class="neoterra-empty">This season has no domain view.</p>';
        return null;
    }
    if (mountedDomainChatId && mountedDomainChatId !== chatId) {
        disposeDomainPanel();
    }
    mountedDomainChatId = chatId;
    if (domainPanel && chatId) {
        domainPanel.refresh();
        return domainPanel;
    }
    try {
        const metadata = context?.chatMetadata;
        const registrySource = resolveCodexRegistry(metadata).registry;
        const [registry, locations, districts] = await Promise.all([
            Promise.resolve(registrySource).catch(() => null),
            loadLocations().catch(() => null),
            loadDistricts().catch(() => null),
        ]);
        if (mountedDomainChatId !== chatId) {
            return null;
        }
        const fullRegistry = await loadRegistry().catch(() => registry);
        if (mountedDomainChatId !== chatId) {
            return null;
        }
        disposeDomainPanel();
        domainPanel = mountSensorium({
            root: host,
            getState: () => liveWorldState(),
            getSeason: () => currentSeasonDefinition(),
            getRegistry: () => fullRegistry ?? registry,
            getLocations: () => locations,
            getDistricts: () => districts,
            getSettings: () => getSettings(refreshContext() ?? context),
        });
        return domainPanel;
    } catch (error) {
        logger.warn('Could not mount the domain sensorium', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The domain view could not be mounted.</p>';
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Player sheet                                                       */
/* ------------------------------------------------------------------ */

let playerPanel = null;
let mountedPlayerChatId = null;
let playerRefreshOff = null;

function disposePlayerPanelComponent() {
    disposeMountedPlayerPanel();
    playerPanel = null;
}

async function mountPlayerPanelForActiveChat() {
    return mountPlayerPanelComponent(refreshContext());
}

async function mountPlayerPanelComponent(context) {
    if (!hasDom()) {
        return null;
    }
    const host = document.querySelector('[data-neoterra-player-host]');
    if (!host) {
        return null;
    }
    const chatId = currentChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata) {
        disposePlayerPanelComponent();
        mountedPlayerChatId = null;
        host.innerHTML = '<p class="neoterra-empty">Open a chat with a world to see the player sheet.</p>';
        return null;
    }
    const store = sharedStoreFor(context);
    if (!store || !store.get()) {
        disposePlayerPanelComponent();
        mountedPlayerChatId = null;
        // `sharedStoreFor` may have registered an empty store; release it when
        // no other runtime owns it so it cannot linger across the chat.
        const ownedByMap = mapRuntime?.chatId === chatId;
        const ownedByInteraction = interactionRuntime?.chatId === chatId;
        if (!ownedByMap && !ownedByInteraction) {
            releaseSharedWorldStateStore(chatId);
        }
        host.innerHTML = '<p class="neoterra-empty">This chat has no active world. Start a season to see the player sheet.</p>';
        return null;
    }
    if (mountedPlayerChatId && mountedPlayerChatId !== chatId) {
        disposePlayerPanelComponent();
    }
    mountedPlayerChatId = chatId;
    if (playerPanel) {
        playerPanel.refresh();
        return playerPanel;
    }
    try {
        const season = metadata.neoterra?.seasonDefinition ?? null;
        const resolved = resolveCodexRegistry(metadata);
        const registry = await resolved.registry;
        // A chat switch during the registry fetch must not paint into the new
        // chat with the previous chat's sheet.
        if (mountedPlayerChatId !== chatId) {
            return null;
        }
        disposePlayerPanelComponent();
        playerPanel = mountPlayerPanel({
            root: host,
            store,
            season,
            registry,
            ctx: context,
            onChange: () => {
                // The sheet writes through the shared store; refresh the other
                // surfaces that read the same document.
                bus.emit(EVENTS.MAP_UPDATED, { reason: 'player-edit' });
            },
        });
        return playerPanel;
    } catch (error) {
        logger.warn('Could not mount the player sheet', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The player sheet could not be mounted.</p>';
        return null;
    }
}

/**
 * Drop the chat-bound runtimes and the shared store they were using. The next
 * activation rebuilds them from metadata; the gate resets so the first turn in
 * the rebuilt runtime is accepted again.
 */
function disposeChatRuntimes({ keepChatId = null } = {}) {
    const chatIds = [...new Set(
        [mapRuntime?.chatId, interactionRuntime?.chatId, mountedPlayerChatId, mountedCodexChatId].filter(Boolean),
    )];
    mapRuntime = null;
    mountedMapChatId = null;
    interactionRuntime = null;
    choicesBar = null;
    disposeEncounterBar();
    encounterBar = null;
    // The sheet holds the same store; a released store must never be written
    // back through a stale manual edit.
    disposePlayerPanelComponent();
    mountedPlayerChatId = null;
    // The registry is the single disposal point; the two runtimes share a store.
    for (const chatId of chatIds) {
        // A mounted codex still reads and writes its chat's shared store, so
        // releasing it here would leave the panel and the remounted map on two
        // different documents. `keepChatId` pins it for that one caller.
        if (chatId === keepChatId) {
            continue;
        }
        releaseSharedWorldStateStore(chatId);
    }
    turnGate.reset();
}

/**
 * Drop sibling runtimes that cache their own WorldState copy after the codex
 * mutates the shared document. The next activation rebuilds them from metadata.
 */
function invalidateChatRuntimes(context, { keepCodex = false } = {}) {
    // The codex and the map now share one store per chat. Keeping the codex
    // mounted means keeping that store alive so the remounted map (and the
    // choices pipeline) read the document the codex just wrote, not the
    // still-unsaved metadata copy.
    const keepStoreChatId = keepCodex ? mountedCodexChatId : null;
    disposeChatRuntimes({ keepChatId: keepStoreChatId });
    disposeMapPanel();
    disposeChoicesBar();
    disposeEncounterBar();
    encounterBar = null;
    if (!keepCodex) {
        disposeCodex();
    }
    // A hosted window keeps its frame but its cached panel was just dropped:
    // rebuild it so the open window cannot paint a stale world.
    remountWindow('map');
    if (!keepCodex) {
        remountWindow('characters');
    }
    remountWindow('relations');
    remountWindow('journal');
    if (isShellOpen() && getActiveTab() === 'player') {
        void mountPlayerPanelForActiveChat();
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

function ensureBadEndHost() {
    let host = document.getElementById('neoterra-bad-end-host');
    if (host) {
        return host;
    }
    host = document.createElement('div');
    host.id = 'neoterra-bad-end-host';
    host.className = 'neoterra-bad-end-host';
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

/** One short status line for a routed chip that could not execute. */
function showChoiceRouteStatus(message, tone = 'warning') {
    const text = typeof message === 'string' ? message.trim() : '';
    if (text.length === 0) {
        return;
    }
    try {
        ensureToasts().push([{
            id: `choice-route:${text}`,
            type: 'event',
            title: 'Choice',
            message: text,
            tone,
        }]);
    } catch (error) {
        logger.debug('Could not show the choice status', error);
    }
}

/** The map runtime, created on demand for a chip that needs travel sources. */
function ensureMapRuntimeForChoices(context, runtime) {
    if (mapRuntime && mapRuntime.chatId === runtime?.chatId) {
        return mapRuntime;
    }
    try {
        return buildMapRuntime(context);
    } catch (error) {
        logger.debug('Could not build a travel runtime for a chip', error);
        return null;
    }
}

/** The connected destinations for the choices prompt, from the live graph. */
async function buildChoiceConnections(runtime, state) {
    const map = ensureMapRuntimeForChoices(refreshContext(), runtime);
    if (!map?.travel || typeof map.travel.getGraph !== 'function') {
        return null;
    }
    const current = state?.scene?.locationId ?? null;
    if (typeof current !== 'string' || current.length === 0) {
        return null;
    }
    try {
        const graph = await map.travel.getGraph();
        const node = graph?.getNode?.(current) ?? null;
        const ids = Array.isArray(node?.connections) ? node.connections : [];
        return {
            [current]: ids.map((id) => ({
                id,
                name: graph?.getNode?.(id)?.name ?? state?.locations?.[id]?.name ?? id,
            })),
        };
    } catch (error) {
        logger.debug('Could not read the travel graph for choices', error);
        return null;
    }
}

/** One travel chip: the same execution path as the map, without a map UI. */
async function routeTravelChoice(live, runtime, target) {
    const map = ensureMapRuntimeForChoices(live, runtime);
    if (!map?.travel) {
        return { ok: false, reason: 'no-travel', message: 'Travel is unavailable in this chat.' };
    }
    const panel = map.panelRef?.panel ?? null;
    const panelRef = panel
        ? {
            refresh: () => panel.refresh?.(),
            getSources: () => panel.getSources?.(),
            pulseArrival: (payload) => panel.pulseArrival?.(payload),
        }
        : null;
    const outcome = await runTravelTo(live, map, panelRef, target);
    if (outcome.ok === false) {
        return {
            ok: false,
            reason: outcome.reason ?? 'rejected',
            message: outcome.result?.message ?? 'That trip is not possible right now.',
        };
    }
    return outcome;
}

/** Start a fight through the encounter path; a missing encounter is a notice. */
async function routeCombatChoice(live, runtime) {
    const state = runtime.store.get();
    const model = buildEncounterBarModel({
        state,
        settings: getSettings(live),
    });
    if (model.visible && model.mode === 'encounter' && model.encounter) {
        const outcome = await engageEncounterWithRuntime(runtime, live, model.encounter);
        if (outcome.ok) {
            await refreshInteractionUi(live);
        }
        return outcome;
    }
    return {
        ok: false,
        reason: 'no-encounter',
        message: model.reason === 'avoided'
            ? 'No one here to fight — you already avoided them.'
            : 'No one here to fight.',
    };
}

/** A prose notice frame for a combat chip that had nothing to engage. */
async function postChoiceNotice(live, runtime, text) {
    const state = runtime.store.get();
    const key = buildSceneKey('notice', runtime.chatId, 'no-combat', state?.meta?.turn ?? 0);
    const message = buildSceneChatMessage({
        kind: SCENE_KINDS.NOTICE,
        text,
        key,
    });
    const posted = await postSceneMessage(live, message, {
        dedupeKey: key,
        avatarUrl: resolveSceneAvatar(live),
    });
    decorateSceneAt(live, posted?.index);
    return posted;
}

let choiceRouteInFlight = false;

/**
 * Route one chip: prose goes through SillyTavern's normal send; travel and
 * combat call the same engine paths as the map and the encounter bar. The
 * choices controller has already consumed its exactly-once guard, and the
 * in-flight flag keeps a second click from starting a second action.
 */
async function handleChoiceSend(text, choice) {
    const kind = typeof choice?.kind === 'string' ? choice.kind : 'prose';
    if (kind !== 'travel' && kind !== 'combat') {
        sendChoiceText(text);
        return;
    }
    if (choiceRouteInFlight) {
        return;
    }
    const live = refreshContext();
    const runtime = buildInteractionRuntime(live);
    if (!runtime) {
        sendChoiceText(text);
        return;
    }
    choiceRouteInFlight = true;
    try {
        const routed = await dispatchChoiceRoute({
            choice,
            state: runtime.store.get(),
            handlers: {
                prose: () => sendChoiceText(text),
                travel: (target) => routeTravelChoice(live, runtime, target),
                combat: () => routeCombatChoice(live, runtime),
                notice: (message) => postChoiceNotice(live, runtime, message),
            },
        });
        if (routed.route === 'travel' && routed.result?.ok === false) {
            showChoiceRouteStatus(routed.result.message ?? 'That trip is not possible right now.');
        } else if (routed.route === 'combat' && routed.result?.ok === false) {
            showChoiceRouteStatus(routed.result.message ?? 'The conflict could not start.');
        } else if (routed.route === 'notice') {
            // The notice frame is the visible response; the input stays ready
            // for the player's own words.
            document.getElementById('send_textarea')?.focus?.();
        }
    } catch (error) {
        logger.warn('Could not route the choice', error);
        showChoiceRouteStatus('The chosen action could not be executed.');
    } finally {
        choiceRouteInFlight = false;
        choicesBar?.refresh?.();
    }
}

/**
 * Wrap a bad-end flow so a canon self-continuation also resolves the new POV's
 * goals. Fire-and-forget: the continuation returns immediately and never waits
 * for a model pass.
 */
function withContinuationGoalInference(flow, { store = null, season = null, context = null, runner = null } = {}) {
    if (!flow || flow.__neoterraGoalInference === true || typeof flow.continueAsBadEnded !== 'function') {
        return flow;
    }
    const goalInference = createGoalInference({
        runner,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
    const runGoals = (characterId) => {
        if (typeof characterId !== 'string' || characterId.length === 0) {
            return;
        }
        void (async () => {
            try {
                let profiles = null;
                try {
                    profiles = await loadProfiles();
                } catch (error) {
                    logger.debug('Card profiles are unavailable; inferring goals without them', error);
                }
                await ensurePlayerGoals({
                    store,
                    profiles,
                    goalInference,
                    settings: getSettings(context),
                    characterId,
                    season,
                    recentScene: store?.get?.()?.recentEvents?.slice?.(-3) ?? null,
                });
            } catch (error) {
                logger.debug('Goal inference after a bad-end continuation failed', error);
            }
        })();
    };
    // Prototype delegation keeps every other flow method (and its live bindings)
    // intact; a spread would freeze getter-backed state and leak a marker key.
    const wrapper = Object.create(flow);
    Object.defineProperty(wrapper, '__neoterraGoalInference', {
        value: true,
        enumerable: false,
    });
    wrapper.continueAsBadEnded = (options = {}) => {
        const result = flow.continueAsBadEnded(options);
        runGoals(result?.characterId ?? options?.characterId ?? null);
        return result;
    };
    wrapper.continueAsSomeoneElse = (options = {}) => {
        const result = flow.continueAsSomeoneElse(options);
        if (result?.identity === 'canon') {
            runGoals(result?.characterId ?? null);
        }
        return result;
    };
    return wrapper;
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
    const { initiative, ending, runner, castDirector } = shared?.initiative
        ? {
            initiative: shared.initiative,
            ending: shared.ending,
            runner: shared.runner,
            castDirector: shared.castDirector,
        }
        : buildStorylineInitiative(context, store, season);
    const scene = shared?.scene ?? createSceneFlow({
        store,
        season,
        director: castDirector ?? null,
        getSettings: () => getSettings(context),
        log: (message, error) => logger.warn(message, error),
    });
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
        onSend: (text, choice) => {
            void handleChoiceSend(text, choice);
        },
    });
    const badEndBase = shared?.badEnd ?? createBadEndFlow({
        store,
        detector: createBadEndDetector({
            runner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        }),
        runner,
        getSettings: () => getSettings(context),
        season,
        context: { registry: metadata.neoterra?.registry ?? null },
        log: (message, error) => logger.warn(message, error),
    });
    // A canon self-continuation is an identity change: resolve the goals in the
    // background so the continuation never waits on the model.
    const badEnd = withContinuationGoalInference(badEndBase, {
        store,
        season,
        context,
        runner,
    });
    const downtime = shared?.downtime ?? createDowntimeFlow({
        store,
        season,
        getSettings: () => getSettings(context),
        loadEvents: async () => {
            const document = await loadAgendas();
            return resolveDowntimeEvents(document, season?.id ?? metadata.neoterra?.seasonId ?? null);
        },
        now: Date.now,
        log: (message, error) => logger.warn(message, error),
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
        castDirector: castDirector ?? null,
        badEnd,
        downtime,
        worldTick,
        newsroom,
        controller,
        sceneDescriber: createSceneDescriber({
            runner,
            getSettings: () => getSettings(context),
            log: (message, error) => logger.warn(message, error),
        }),
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
 * Start the encounter through the combat flow, post the one combat frame, and
 * request combat choices. Shared by the encounter bar and routed combat chips.
 */
async function engageEncounterWithRuntime(runtime, live, encounter) {
    const outcome = await engageEncounter({
        flow: runtime.combat,
        state: runtime.store.get(),
        encounter,
        chatId: runtime.chatId,
        post: async (message, key) => {
            const posted = await postSceneMessage(live, message, {
                dedupeKey: key,
                avatarUrl: resolveSceneAvatar(live),
            });
            decorateSceneAt(live, posted?.index);
            return posted;
        },
        requestChoices: (index) => requestChoicesFor(live, index, { mode: 'combat' }),
        onPosted: () => {
            bus.emit(EVENTS.MAP_UPDATED, { reason: 'combat-start' });
        },
    });
    return outcome;
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
        const outcome = await engageEncounterWithRuntime(runtime, live, model.encounter);
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
        const postedResolution = await postSceneMessage(live, message, {
            dedupeKey: key,
            avatarUrl: resolveSceneAvatar(live),
        });
        decorateSceneAt(live, postedResolution?.index);
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
        disposeBadEndPanel();
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
    try {
        const settingsNow = getSettings(live);
        const playerId = state?.player?.identity === 'canon' ? state.player.characterId : null;
        const continuationId = state?.flags?.badEndContinuation?.characterId ?? null;
        const hasPlayerBadEnd = [playerId, continuationId]
            .filter(Boolean)
            .some((id) => Boolean(state?.badEnds?.[id]));
        if (settingsNow?.badEnds?.enabled === true && hasPlayerBadEnd && runtime.badEnd) {
            mountBadEndPanel({
                root: ensureBadEndHost(),
                store: runtime.store,
                flow: runtime.badEnd,
            });
        } else {
            disposeBadEndPanel();
        }
    } catch (error) {
        logger.debug('Could not refresh the bad-end panel', error);
        disposeBadEndPanel();
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

/* ------------------------------------------------------------------ */
/* Turn progress and delta toasts                                      */
/* ------------------------------------------------------------------ */

let turnStatusController = null;
let toastStack = null;
// Keyed by toast id so each Play-as toast downloads its own card, even when
// several are on screen.
let pendingPlayerCards = new Map();

/** JSON-safe snapshot; WorldState is plain data, so this is cheap and exact. */
function snapshotWorldState(state) {
    if (!state || typeof state !== 'object') {
        return null;
    }
    try {
        return typeof structuredClone === 'function'
            ? structuredClone(state)
            : JSON.parse(JSON.stringify(state));
    } catch (error) {
        logger.debug('Could not snapshot the world state for the turn diff', error);
        return null;
    }
}

function ensureTurnStatusHost() {
    let host = document.getElementById('neoterra-turn-status-host');
    if (host) {
        return host;
    }
    host = document.createElement('div');
    host.id = 'neoterra-turn-status-host';
    host.className = 'neoterra-turn-status-host';
    const form = document.getElementById('send_form');
    if (form) {
        form.prepend(host);
    } else {
        document.body.append(host);
    }
    return host;
}

function beginTurnStatus() {
    turnStatusController?.dispose?.();
    turnStatusController = mountTurnStatus({ host: ensureTurnStatusHost() });
    turnStatusController?.start?.();
    return turnStatusController;
}

function ensureToasts() {
    toastStack ??= mountToasts();
    if (toastStack?.container && !toastStack.container.dataset.neoterraLogLink) {
        toastStack.container.dataset.neoterraLogLink = '1';
        toastStack.container.addEventListener('click', (event) => {
            const action = event.target.closest?.('[data-neoterra-toast-action]');
            if (action) {
                event.preventDefault();
                if (action.dataset.neoterraToastAction === 'return-to-chat') {
                    closeMapSurface();
                    document.getElementById('send_textarea')?.focus?.();
                    action.closest?.('.neoterra-toast')?.remove?.();
                }
                if (action.dataset.neoterraToastAction === 'download-player-card') {
                    const toastEl = action.closest?.('.neoterra-toast');
                    const toastId = toastEl?.dataset?.neoterraToast ?? null;
                    const card = toastId ? pendingPlayerCards.get(toastId) : null;
                    if (card) {
                        downloadJson(card.filename, card.document);
                        pendingPlayerCards.delete(toastId);
                        toastEl?.remove?.();
                    }
                }
                return;
            }
            const link = event.target.closest?.('.neoterra-toast-details');
            if (!link) {
                return;
            }
            if (String(link.getAttribute('href') ?? '').includes('agent-log')) {
                event.preventDefault();
                openWindowTab('log');
            }
        });
    }
    return toastStack;
}

function disposeTurnSurfaces() {
    turnStatusController?.dispose?.();
    turnStatusController = null;
    toastStack?.dispose?.();
    toastStack = null;
    pendingPlayerCards = new Map();
}

/** Drop a runtime the queued turn created for a chat that is no longer open. */
function abortStaleTurnRuntime(chatId) {    if (!chatId) {
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
    let turnResult = null;
    let status = null;
    if (isNewTurn) {
        const messages = Array.isArray(live?.chat) ? live.chat : [];
        const beforeState = snapshotWorldState(runtime.store.get());
        status = beginTurnStatus();
        try {
            turnResult = await runTurnPipeline({
                store: runtime.store,
                tracker: runtime.tracker,
                initiative: runtime.initiative,
                scene: runtime.scene,
                getSettings: () => getSettings(live),
                message: typeof message?.mes === 'string' ? message.mes : '',
                recentMessages: recentMessagesBefore(messages, messageIndex),
                tickTurns: 1,
                worldTick: runtime.worldTick,
                onStage: (event) => status?.event(event),
                log: (m, e) => logger.warn(m, e),
            });
        } catch (error) {
            status?.finish({ errors: [{ stage: 'pipeline', error: error?.message ?? String(error) }] });
            throw error;
        }
        if (!chatStillCurrent(chatId)) {
            logger.debug('Chat changed during the turn pipeline; skipping the UI handoff');
            status?.finish({ errors: turnResult?.errors ?? [] });
            abortStaleTurnRuntime(chatId);
            return;
        }
        // Bad-end detection is opt-in. When disabled the flow makes zero
        // calls; a failure is reported as a non-blocking turn error.
        try {
            const settingsNow = getSettings(live);
            if (settingsNow?.badEnds?.enabled === true
                && settingsNow?.agents?.badEnd?.enabled !== false
                && runtime.badEnd?.detectAndRecord) {
                status?.event({ stage: 'bad-end', status: 'start' });
                const report = await runtime.badEnd.detectAndRecord({
                    message: typeof message?.mes === 'string' ? message.mes : '',
                    recentProse: typeof message?.mes === 'string' ? message.mes : '',
                    continuityKey: messageTurnIdentity(message),
                });
                if (Array.isArray(report?.recorded) && report.recorded.length > 0) {
                    bus.emit(EVENTS.MAP_UPDATED, { reason: 'bad-end' });
                }
                status?.event({ stage: 'bad-end', status: 'done' });
            }
        } catch (error) {
            logger.warn('Bad-end detection failed; the turn stands', error);
            turnResult?.errors?.push({ stage: 'bad-end', error: error?.message ?? String(error) });
            status?.event({ stage: 'bad-end', status: 'failed', error: error?.message ?? String(error) });
        }
        // Batch the visible deltas once per turn; the toast stack dedupes ids so
        // a repeated MAP_UPDATED cannot repeat a line.
        try {
            const continuity = turnResult?.auditor;
            const findingCount = Array.isArray(continuity?.findings) ? continuity.findings.length : 0;
            const summary = continuity?.summary ?? null;
            const extra = continuity?.ran === true && findingCount > 0
                ? [{
                    id: `continuity:${turnResult?.turn ?? ''}:${findingCount}:${summary?.warnings ?? 0}:${summary?.errors ?? 0}`,
                    type: 'continuity',
                    title: 'Continuity',
                    message: `${findingCount} finding${findingCount === 1 ? '' : 's'}` +
                        (summary?.warnings ? ` · ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : '') +
                        (summary?.errors ? ` · ${summary.errors} error${summary.errors === 1 ? '' : 's'}` : ''),
                    tone: summary?.errors ? 'warning' : 'info',
                    href: '#neoterra-agent-log',
                }]
                : [];
            ensureToasts().push([
                ...diffWorldState(beforeState, runtime.store.get()),
                ...extra,
                ...buildErrorToasts(turnResult?.errors ?? [], { detailsHref: '#neoterra-agent-log' }),
            ]);
        } catch (error) {
            logger.debug('Could not build state-delta toasts', error);
        }
        bus.emit(EVENTS.MAP_UPDATED, { reason: 'turn', turn: turnResult?.turn ?? null });
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
        status?.finish({ errors: turnResult?.errors ?? [] });
        abortStaleTurnRuntime(chatId);
        return;
    }
    const messages = Array.isArray(live?.chat) ? live.chat : [];
    status?.event({ stage: 'choices', status: 'start' });
    let view = null;
    try {
        view = await runtime.controller.request({
            messages,
            messageIndex,
            swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
        });
        status?.event({ stage: 'choices', status: 'done' });
    } catch (error) {
        status?.event({ stage: 'choices', status: 'failed', error: error?.message ?? String(error) });
        throw error;
    } finally {
        status?.finish({ errors: turnResult?.errors ?? [] });
    }
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

/* ------------------------------------------------------------------ */
/* Scene render subscription                                          */
/* ------------------------------------------------------------------ */

let sceneRenderSubscription = null;

/** Decorate frames as ST re-renders them (reload, swipe, chat open). */
function subscribeSceneRendering(context) {
    unsubscribeSceneRendering();
    const eventSource = context?.eventSource ?? context?.eventTypes;
    const on = typeof eventSource?.on === 'function' ? eventSource.on.bind(eventSource) : null;
    if (!on) {
        return;
    }
    const event = context?.eventTypes?.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered';
    const handler = (messageIndex) => {
        const live = refreshContext();
        const messages = Array.isArray(live?.chat) ? live.chat : [];
        const index = Number.isInteger(messageIndex) ? messageIndex : messages.length - 1;
        decorateSceneAt(live, index);
    };
    try {
        on(event, handler);
        sceneRenderSubscription = { eventSource, event, handler };
    } catch (error) {
        logger.debug('CHARACTER_MESSAGE_RENDERED subscription unavailable', error);
    }
}

function unsubscribeSceneRendering() {
    const subscription = sceneRenderSubscription;
    sceneRenderSubscription = null;
    if (!subscription) {
        return;
    }
    try {
        const off = subscription.eventSource?.removeListener ?? subscription.eventSource?.off;
        off?.call?.(subscription.eventSource, subscription.event, subscription.handler);
    } catch (error) {
        logger.debug('Could not remove the scene-render listener', error);
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
    // Map, Codex, Relations, and Journal live in floating windows; the shell
    // nav no longer renders their tabs (Journal was never a tab). Opening one
    // closes the modal so the chat and the window are both usable.
    if (WINDOW_TABS.has(tabId)) {
        openWindowTab(tabId);
        return true;
    }
    if (!SHELL_TABS.some(tab => tab.id === tabId)) {
        return false;
    }
    // Domain is authored-data conditional. Resolve against the live chat so a
    // hidden domain falls back to Characters instead of trapping focus on a
    // nav button the user cannot see.
    const season = currentSeasonDefinition();
    const state = liveWorldState();
    const visible = resolveVisibleTabs(state, season);
    const visibleIds = new Set(visible.map(tab => tab.id));
    tabId = resolveActiveTab(tabId, state, season);
    activeTab = tabId;
    // Never treat the mount-time default as a user choice: it would overwrite
    // the per-chat last tab before `openShell` can restore it.
    if (!mountingShell) {
        rememberLastTab(tabId);
    }
    if (!hasDom()) {
        return true;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return true;
    }
    root.dataset.activeTab = tabId;
    for (const tab of root.querySelectorAll('[role="tab"]')) {
        const id = tab.dataset.neoterraTab;
        const isVisible = visibleIds.has(id);
        tab.hidden = !isVisible;
        const selected = id === tabId;
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
    if (tabId === 'relations') {
        void mountRelationsPanelForActiveChat();
    }
    if (tabId === 'domain') {
        void mountDomainPanelForActiveChat();
    }
    if (tabId === 'player') {
        void mountPlayerPanelForActiveChat();
    }
    if (tabId === 'season' && !mountingShell) {
        void mountSeasonPanel(refreshContext());
    }
    bus.emit(EVENTS.TAB_CHANGED, { tab: tabId });
    return true;
}

export function openShell(tabId = null) {
    if (!hasDom()) {
        return false;
    }
    const root = document.getElementById(UI_IDS.ROOT);
    if (!root) {
        return false;
    }
    previousFocus = document.activeElement;
    // A gameplay surface goes straight to its floating window: the modal never
    // opens, so the chat stays interactive.
    const requested = tabId ?? readLastTab(refreshContext()) ?? 'season';
    if (WINDOW_TABS.has(requested)) {
        openWindowTab(requested);
        return true;
    }
    // Unhide before switching tabs so lazily mounted panels (the map) measure a
    // real viewport instead of a zero-size hidden container.
    root.hidden = false;
    root.classList.add('is-open');
    // Restore the last surface used in this chat; the Story tab defaults to
    // Session Home when a world exists, so a reload never forces a season
    // re-selection.
    const target = requested;
    setActiveTab(target);
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
    // Reopening a chat that has a world should land on Session Home unless the
    // user explicitly opens the grid again.
    if (hasWorldInChat(refreshContext())) {
        storyGridRequested = false;
    }
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
            if (!requested) {
                openCommandPalette();
                return '';
            }
            if (WINDOW_TABS.has(requested)) {
                openWindowTab(requested);
                return '';
            }
            openShell(SHELL_TABS.some(tab => tab.id === requested) ? requested : 'season');
            return '';
        },
        helpString: 'Open the Neo Terra framework shell, a gameplay window, or the agent log.',
        returns: 'empty string',
        unnamedArgumentList: SlashCommandArgument?.fromProps
            ? [
                SlashCommandArgument.fromProps({
                    description: 'Optional surface: season, map, characters, relations, journal, log, player, settings',
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
    closeWindowLayer();
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
    mountedRelationsChatId = null;
    mountedDomainChatId = null;
    mountedPlayerChatId = null;
    storyMode = null;
    storyGridRequested = false;
    storyNotice = null;
    disposeSessionHome();
    disposeSeasonMenu();
    interactionRuntime = null;
    choicesBar = null;
    disposeMapPanel();
    disposeCodex();
    disposeRelationsPanel();
    disposeJournalPanel();
    disposeDomainPanel();
    disposePlayerPanelComponent();
    disposeChoicesBar();
    disposeEndingPanel();
    disposeBadEndPanel();
    if (isShellOpen() && getActiveTab() === 'map') {
        void mountMapPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'characters') {
        void mountCodexPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'relations') {
        void mountRelationsPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'domain') {
        void mountDomainPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'player') {
        void mountPlayerPanelForActiveChat();
    }
    if (isShellOpen() && getActiveTab() === 'season') {
        void mountSeasonPanel(refreshContext());
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
        openPalette: openCommandPalette,
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
        refreshHud(ctx);
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
        subscribeSceneRendering(ctx);
        window.setTimeout(() => decorateSceneFrames(refreshContext()), 250);
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

        // First-run wizard: open the Story surface once on a fresh install with
        // no world. The flag is per-user, so upgrading an existing install does
        // not reopen it on every chat.
        try {
            const settings = getSettings(refreshContext() ?? ctx);
            if (settings?.ui?.firstRunWizardSeen !== true && !hasWorldInChat(refreshContext() ?? ctx)) {
                setSetting(refreshContext() ?? ctx, 'ui.firstRunWizardSeen', true);
                openShell('season');
            }
        } catch (error) {
            logger.debug('Could not open the first-run wizard', error);
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
        disposeTurnSurfaces();
        disposeCommandPalette();
        closeWindowLayer();
        mountedCodexChatId = null;
        disposeMapPanel();
        disposeCodex();
        mountedRelationsChatId = null;
        disposeRelationsPanel();
        disposeJournalPanel();
        mountedDomainChatId = null;
        disposeDomainPanel();
        mountedPlayerChatId = null;
        disposePlayerPanelComponent();
        storyMode = null;
        storyGridRequested = false;
        storyNotice = null;
        disposeSessionHome();
        disposeSeasonMenu();
        disposeChoicesBar();
        disposeEncounterBar();
        encounterBar = null;
        disposeEndingPanel();
        disposeBadEndPanel();
        if (isShellOpen() && getActiveTab() === 'map') {
            void mountMapPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'characters') {
            void mountCodexPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'relations') {
            void mountRelationsPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'domain') {
            void mountDomainPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'player') {
            void mountPlayerPanelForActiveChat();
        }
        if (isShellOpen() && getActiveTab() === 'season') {
            void mountSeasonPanel(refreshContext());
        }
        // A chat switch can hide the Domain tab; move focus to Characters
        // rather than leaving an invisible tab selected. Visible tabs keep
        // the mount above, so this never triggers a second concurrent mount.
        if (isShellOpen() && getActiveTab() === 'domain'
            && !isDomainTabVisible(liveWorldState(), currentSeasonDefinition())) {
            setActiveTab('characters');
        }
        refreshSettingsPanel();
        clockChip?.refresh?.();
        disposeHudPanel();
        refreshHud(refreshContext());
        void refreshInteractionUi(refreshContext());
        window.setTimeout(() => decorateSceneFrames(refreshContext()), 200);
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
    unsubscribeSceneRendering();
    disposeClockChip();
    disposeChatRuntimes();
    closeWindowLayer();
    mountedCodexChatId = null;
    mountedRelationsChatId = null;
    mountedDomainChatId = null;
    mountedPlayerChatId = null;
    disposeSeasonMenu();
    disposeSessionHome();
    storyMode = null;
    storyGridRequested = false;
    storyNotice = null;
    disposeMapPanel();
    disposeCodex();
    disposeRelationsPanel();
    disposeJournalPanel();
    disposeDomainPanel();
    disposePlayerPanelComponent();
    playerRefreshOff?.();
    playerRefreshOff = null;
    disposeSettingsPanel();
    disposeHudPanel();
    disposeTurnSurfaces();
    disposeCommandPalette();
    disposeChoicesBar();
    disposeEncounterBar();
    encounterBar = null;
    disposeEndingPanel();
    disposeBadEndPanel();
    document.getElementById('neoterra-choices-host')?.remove();
    document.getElementById('neoterra-encounter-host')?.remove();
    document.getElementById('neoterra-turn-status-host')?.remove();
    document.getElementById('neoterra-ending-host')?.remove();
    document.getElementById('neoterra-bad-end-host')?.remove();

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
