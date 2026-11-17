/**
 * Season menu UI.
 *
 * The panel renders the six playable entries plus the disabled S5 notice, an
 * identity step (custom persona or canon character), and a replace-world
 * confirmation. All state text comes from `src/flows/season-start.js`; this
 * module owns only markup and DOM events.
 */

import { createLogger } from '../core/logger.js';
import { loadRegistry } from '../data/registry.js';
import {
    SeasonStartError,
    applyCharacterFocus,
    buildIdentityChoices,
    buildSeasonMenuEntries,
    enterSeason,
    filterSeasonEntriesByCharacter,
    getSeasonMenuEntries,
    mergePendingIdentity,
} from '../flows/season-start.js';

const logger = createLogger('season-menu');

const VIEW = Object.freeze({
    LIST: 'list',
    IDENTITY: 'identity',
    CONFIRM: 'confirm',
});

let mounted = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/** Minimal HTML escaping for every interpolated string. */
export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function roleBadgeClass(playerRole) {
    if (playerRole === 'villain') {
        return 'neoterra-badge neoterra-badge-danger';
    }
    if (playerRole === 'hero') {
        return 'neoterra-badge neoterra-badge-accent';
    }
    return 'neoterra-badge';
}

function renderSeasonCard(entry) {
    const threatText = entry.mainThreatNames.length > 0
        ? entry.mainThreatNames.join(', ')
        : entry.sandbox ? 'No fixed threat' : 'None declared';
    const notice = entry.disabledReason ?? entry.notice ?? '';

    return `
    <article class="neoterra-season-card${entry.disabled ? ' is-disabled' : ''}"
        data-neoterra-season-card data-season-id="${escapeHtml(entry.id)}"
        aria-disabled="${entry.disabled ? 'true' : 'false'}">
        <header class="neoterra-season-card-header">
            <h4 class="neoterra-season-title">${escapeHtml(entry.title)}</h4>
            <span class="${roleBadgeClass(entry.playerRole)}">${escapeHtml(entry.playerRoleLabel)}</span>
        </header>
        <p class="neoterra-season-era">${escapeHtml(entry.era)}</p>
        <p class="neoterra-season-premise">${escapeHtml(entry.premise)}</p>
        <dl class="neoterra-season-facts">
            <div><dt>Main threat</dt><dd>${escapeHtml(threatText)}</dd></div>
            <div><dt>Cast</dt><dd>${escapeHtml(entry.castLabel)}</dd></div>
            <div><dt>Start</dt><dd>${escapeHtml(entry.startLocationName ?? entry.startLocationId ?? 'Unknown')}</dd></div>
        </dl>
        ${notice ? `<p class="neoterra-season-notice">${escapeHtml(notice)}</p>` : ''}
        <p class="neoterra-season-content-note">${escapeHtml(entry.contentNotice)}</p>
        <button type="button" class="menu_button neoterra-season-enter"
            data-neoterra-season-select="${escapeHtml(entry.id)}"
            ${entry.disabled ? 'disabled' : ''}>
            ${escapeHtml(entry.disabled ? 'Coming later' : entry.playAsLabel ?? 'Enter season')}
        </button>
    </article>`;
}

function renderIdentityStep({ entry, choices, error }) {
    const options = choices.options.map((option) => {
        const checked = option.isDefault ? 'checked' : '';
        const detail = option.identity === 'canon'
            ? `${option.side}${option.nonCanon ? ' — non-canon character' : ''}`
            : 'Write your own persona';
        return `
        <label class="neoterra-identity-option">
            <input type="radio" name="neoterra-identity" value="${escapeHtml(option.identity)}"
                data-neoterra-identity data-character-id="${escapeHtml(option.characterId ?? '')}"
                ${checked}>
            <span class="neoterra-identity-label">${escapeHtml(option.label)}</span>
            <span class="neoterra-identity-detail">${escapeHtml(detail)}</span>
        </label>`;
    }).join('');

    return `
    <section class="neoterra-season-identity" data-neoterra-identity-step
        data-season-id="${escapeHtml(entry.id)}">
        <button type="button" class="menu_button neoterra-back" data-neoterra-identity-back>Back</button>
        <h4>Choose your identity — ${escapeHtml(entry.title)}</h4>
        <p class="neoterra-season-era">${escapeHtml(entry.era)} · ${escapeHtml(entry.playerRoleLabel)}</p>
        ${error ? `<p class="neoterra-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <form data-neoterra-identity-form>
            <fieldset class="neoterra-identity-options">
                <legend class="neoterra-visually-hidden">Player identity</legend>
                ${options}
            </fieldset>
            <label class="neoterra-field">
                <span>Display name (custom persona)</span>
                <input type="text" data-neoterra-persona-name placeholder="The Player">
            </label>
            <label class="neoterra-field">
                <span>Persona notes (optional)</span>
                <textarea rows="2" data-neoterra-persona-notes placeholder="Who are you in Neo Terra?"></textarea>
            </label>
            <div class="neoterra-season-actions">
                <button type="button" class="menu_button neoterra-cancel" data-neoterra-identity-cancel>Cancel</button>
                <button type="submit" class="menu_button neoterra-primary" data-neoterra-identity-confirm>Begin season</button>
            </div>
        </form>
    </section>`;
}

function renderConfirmStep({ entry, identity, error }) {
    const label = identity.identity === 'canon'
        ? `play as ${identity.displayName}`
        : 'use a custom persona';
    return `
    <section class="neoterra-season-confirm" data-neoterra-confirm-step
        data-season-id="${escapeHtml(entry.id)}">
        <h4>Replace this chat's world?</h4>
        <p>This chat already has a Neo Terra world. Continuing will ${escapeHtml(label)} in
            <strong>${escapeHtml(entry.title)}</strong> and replace the existing world state.</p>
        ${error ? `<p class="neoterra-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <div class="neoterra-season-actions">
            <button type="button" class="menu_button neoterra-cancel" data-neoterra-confirm-cancel>Keep current world</button>
            <button type="button" class="menu_button neoterra-danger" data-neoterra-confirm-replace>Replace and begin</button>
        </div>
    </section>`;
}

export function renderSeasonMenuMarkup(entries, options = {}) {
    const {
        view = VIEW.LIST,
        selectedEntry = null,
        identityChoices = null,
        identity = null,
        error = null,
        characterFilter = '',
        loading = false,
    } = options;

    if (view === VIEW.IDENTITY && selectedEntry && identityChoices) {
        return renderIdentityStep({ entry: selectedEntry, choices: identityChoices, error });
    }
    if (view === VIEW.CONFIRM && selectedEntry && identity) {
        return renderConfirmStep({ entry: selectedEntry, identity, error });
    }

    const cards = entries.map(renderSeasonCard).join('');
    return `
    <div class="neoterra-season-menu" data-neoterra-season-menu>
        <div class="neoterra-season-toolbar">
            <label class="neoterra-field neoterra-character-first">
                <span>Character-first</span>
                <input type="search" data-neoterra-character-filter
                    value="${escapeHtml(characterFilter)}"
                    placeholder="Filter seasons by character id">
            </label>
            <button type="button" class="menu_button" data-neoterra-season-refresh>Refresh</button>
        </div>
        ${error ? `<p class="neoterra-error" role="alert">${escapeHtml(error)}</p>` : ''}
        ${loading ? '<p class="neoterra-loading">Loading seasons…</p>' : ''}
        ${cards.length > 0 ? `<div class="neoterra-season-grid">${cards}</div>`
            : '<p class="neoterra-empty">No season matches that character.</p>'}
    </div>`;
}

function getContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        logger.warn('Could not read SillyTavern context', error);
        return null;
    }
}

/**
 * Mount the season menu into a container (the Season tab panel).
 *
 * @param {{
 *   root: HTMLElement,
 *   ctx?: object,
 *   onStart?: Function,
 *   onEntered?: Function,
 * }} options
 */
export async function mountSeasonMenu(options = {}) {
    if (!hasDom()) {
        return null;
    }
    const root = options.root;
    if (!root) {
        throw new TypeError('mountSeasonMenu requires a root element');
    }
    disposeSeasonMenu();

    const ctx = options.ctx ?? getContext();
    const controller = new AbortController();
    const state = {
        entries: [],
        registry: null,
        seasons: null,
        view: VIEW.LIST,
        selectedEntry: null,
        identityChoices: null,
        identity: null,
        characterFilter: '',
        error: null,
        busy: false,
        ctx,
        controller,
        root,
        onStart: typeof options.onStart === 'function' ? options.onStart : null,
        onEntered: typeof options.onEntered === 'function' ? options.onEntered : null,
    };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const entries = state.characterFilter
            ? filterSeasonEntriesByCharacter(state.entries, state.characterFilter, {
                registry: state.registry,
                seasons: state.seasons,
            })
            : state.entries;
        root.innerHTML = renderSeasonMenuMarkup(entries, {
            view: state.view,
            selectedEntry: state.selectedEntry,
            identityChoices: state.identityChoices,
            identity: state.identity,
            error: state.error,
            characterFilter: state.characterFilter,
            loading: state.busy,
        });
    };

    const load = async () => {
        state.busy = true;
        state.error = null;
        paint();
        try {
            const [entries, registry, seasons] = await Promise.all([
                getSeasonMenuEntries({ fetchImpl: options.fetchImpl }),
                loadRegistry({ fetchImpl: options.fetchImpl }),
                options.seasons
                    ? Promise.resolve(options.seasons)
                    : import('../data/seasons.js').then((module) => module.loadSeasonDefinitions({ fetchImpl: options.fetchImpl })),
            ]);
            state.entries = entries;
            state.registry = registry;
            state.seasons = seasons;
        } catch (error) {
            state.error = error?.message ?? String(error);
            state.entries = [];
            logger.warn('Could not load the season menu', error);
        } finally {
            state.busy = false;
            paint();
        }
    };

    const selectedRadio = () => root.querySelector(
        'input[name="neoterra-identity"]:checked',
    );

    const beginSeason = async (confirmReplace) => {
        const entry = state.selectedEntry;
        const radio = selectedRadio();
        const characterId = radio?.dataset?.neoterraCharacterId ?? null;
        const nameInput = root.querySelector('[data-neoterra-persona-name]');
        const notesInput = root.querySelector('[data-neoterra-persona-notes]');
        // The confirmation view has no identity inputs: carry the captured
        // selection forward instead of rebuilding it from missing fields.
        const identity = mergePendingIdentity(
            state.view === VIEW.CONFIRM ? state.identity : null,
            {
                identity: radio?.value,
                characterId: characterId || undefined,
                displayName: nameInput?.value?.trim() || undefined,
                personaNotes: notesInput?.value?.trim() || undefined,
            },
        );

        state.busy = true;
        state.error = null;
        state.identity = identity;
        paint();
        try {
            const start = state.onStart ?? enterSeason;
            const result = await start({
                id: entry.id,
                identity,
                mode: ctx?.extensionSettings?.neoterra?.castMode ?? 'director',
                ctx,
                confirmReplace,
            });
            state.busy = false;
            state.view = VIEW.LIST;
            state.selectedEntry = null;
            state.identityChoices = null;
            state.identity = null;
            paint();
            state.onEntered?.(result);
        } catch (error) {
            state.busy = false;
            if (error instanceof SeasonStartError && error.code === 'EXISTING_WORLD') {
                state.identity = identity;
                state.view = VIEW.CONFIRM;
            } else {
                state.error = error?.message ?? String(error);
            }
            paint();
        }
    };

    root.addEventListener('click', (event) => {
        const target = event.target;
        if (target.closest?.('[data-neoterra-season-refresh]')) {
            load();
            return;
        }
        const seasonId = target.closest?.('[data-neoterra-season-select]')?.dataset.neoterraSeasonSelect;
        if (seasonId) {
            const entry = state.entries.find((candidate) => candidate.id === seasonId);
            if (!entry || entry.disabled) {
                return;
            }
            state.selectedEntry = entry;
            state.identityChoices = applyCharacterFocus(
                buildIdentityChoices(
                    state.seasons?.[seasonId] ?? {
                        id: seasonId,
                        roster: [],
                        allowAnyCharacter: entry.sandbox,
                    },
                    { registry: state.registry },
                ),
                state.characterFilter,
            );
            if (state.identityChoices.focusedCharacterId) {
                state.characterFilter = state.identityChoices.focusedCharacterId;
            }
            state.view = VIEW.IDENTITY;
            state.error = null;
            paint();
            return;
        }
        if (target.closest?.('[data-neoterra-identity-back]')
            || target.closest?.('[data-neoterra-identity-cancel]')) {
            state.view = VIEW.LIST;
            state.selectedEntry = null;
            state.identityChoices = null;
            state.identity = null;
            state.error = null;
            paint();
            return;
        }
        if (target.closest?.('[data-neoterra-confirm-cancel]')) {
            state.view = VIEW.IDENTITY;
            state.error = null;
            paint();
            return;
        }
        if (target.closest?.('[data-neoterra-confirm-replace]')) {
            beginSeason(true);
        }
    }, { signal: controller.signal });

    root.addEventListener('submit', (event) => {
        if (event.target.matches?.('[data-neoterra-identity-form]')) {
            event.preventDefault();
            beginSeason(false);
        }
    }, { signal: controller.signal });

    root.addEventListener('input', (event) => {
        const filter = event.target.closest?.('[data-neoterra-character-filter]');
        if (!filter) {
            return;
        }
        state.characterFilter = filter.value.trim();
        paint();
    }, { signal: controller.signal });

    await load();
    state.handle = { refresh: load, state, root };
    return { refresh: load, state };
}

/** Reload the mounted menu. Returns null when no menu is mounted. */
export function refreshSeasonMenu() {
    return mounted?.handle?.refresh?.() ?? null;
}

export function getSeasonMenuState() {
    if (!mounted) {
        return null;
    }
    return {
        view: mounted.view,
        selectedSeasonId: mounted.selectedEntry?.id ?? null,
        characterFilter: mounted.characterFilter,
        error: mounted.error,
    };
}

export function disposeSeasonMenu() {
    if (!mounted) {
        return;
    }
    mounted.controller?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}

export { VIEW as SEASON_MENU_VIEWS };
