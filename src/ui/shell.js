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
const LIVE_PANELS = new Set(['season', 'map']);

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
    try {
        ctx = globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        logger.warn('Could not read SillyTavern context', error);
        ctx = null;
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
            ${tab.id === 'settings' ? '<button type="button" class="menu_button" data-neoterra-open-settings>Open settings panel</button>' : ''}
        </section>`;
    }).join('');

    return `
    <div id="${UI_IDS.ROOT}" class="neoterra-root" hidden>
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
        return await mountSeasonMenu({ root: host, ctx: context });
    } catch (error) {
        logger.warn('Could not mount the season menu', error);
        return null;
    }
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
        return await mountMapPanel({
            root: host,
            ctx: context,
            settings: getSettings(context).map ?? {},
            store: null,
        });
    } catch (error) {
        logger.warn('Could not mount the city map', error);
        host.innerHTML = '<p class="neoterra-error" role="alert">The city map could not be mounted.</p>';
        return null;
    }
}

function openSettingsPanel() {
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
    for (const tab of root.querySelectorAll('[role="tab"]')) {
        const selected = tab.dataset.neoterraTab === tabId;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-neoterra-panel]')) {
        panel.hidden = panel.dataset.neoterraPanel !== tabId;
    }
    if (tabId === 'map' && !mapMounted) {
        mapMounted = true;
        void mountMapPanelComponent(getContext());
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
        exposeDebugApi(ctx);
        await mountSettingsPanel(ctx, { signal: abort.signal });

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

/** Unmount the extension. Called by the manifest `disable`/`delete` hooks. */
export function dispose() {
    mounted = false;
    mounting = null;
    mountGeneration += 1;
    mapMounted = false;

    unregisterSlashCommand(ctx);
    disposeSeasonMenu();
    disposeMapPanel();
    disposeSettingsPanel();

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
