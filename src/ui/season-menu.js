/**
 * Season menu UI.
 *
 * The panel renders the six playable entries plus the disabled S5 notice, an
 * identity step (custom persona or canon character), and a replace-world
 * confirmation. All state text comes from `src/flows/season-start.js`; this
 * module owns only markup and DOM events.
 */

import { createLogger } from '../core/logger.js';
import { resolveActiveChatId } from '../core/live-context.js';
import { loadRegistry } from '../data/registry.js';
import { directorCardStatus, downloadDirectorCard } from './director-card.js';
import { avatarMarkup, initAvatars } from './avatar.js';
import { applyUiPreset, UI_PRESETS } from '../core/defaults.js';
import { getSettings, saveSettings } from '../core/settings.js';
import {
    SeasonStartError,
    applyCharacterFocus,
    buildGuestWarning,
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

/**
 * Pure reader for the selected identity radio. `value` carries the identity
 * kind and `data-character-id` carries the registry id for canon options; the
 * `neoterraCharacterId` dataset key never existed, so reading it always
 * produced `INVALID_IDENTITY`.
 */
export function readIdentityRadio(radio) {
    if (!radio || typeof radio !== 'object') {
        return { identity: undefined, characterId: null };
    }
    const raw = radio.dataset?.characterId ?? radio.getAttribute?.('data-character-id') ?? '';
    const characterId = String(raw).trim();
    return {
        identity: radio.value || undefined,
        characterId: characterId.length > 0 ? characterId : null,
    };
}

function identityOptionMarkup(option) {
    const checked = option.isDefault ? 'checked' : '';
    const detailParts = [];
    if (option.identity === 'canon') {
        detailParts.push(option.side ?? 'neutral');
        if (option.formKind && option.formKind !== 'base') {
            detailParts.push(option.formKind);
        }
        if (option.guest) {
            detailParts.push(`guest from ${option.homeSeasonId ?? 'another season'}`);
        } else if (option.nonCanon) {
            detailParts.push('non-canon character');
        }
    } else {
        detailParts.push('Write your own persona');
    }
    const portrait = option.identity === 'canon'
        ? avatarMarkup(option.characterId, { size: 'md', name: option.displayName })
        : `<span class="neoterra-avatar neoterra-avatar-md" data-neoterra-avatar data-avatar-source="initials">
            <span class="neoterra-avatar-fallback" aria-hidden="true">YOU</span>
        </span>`;
    return `
    <label class="neoterra-identity-option${option.guest ? ' is-guest' : ''}"
        data-neoterra-identity-option="${escapeHtml(option.characterId ?? 'custom')}"
        data-guest="${option.guest ? 'true' : 'false'}">
        <input type="radio" name="neoterra-identity" value="${escapeHtml(option.identity)}"
            data-neoterra-identity data-character-id="${escapeHtml(option.characterId ?? '')}"
            ${option.guest ? `data-guest-character-id="${escapeHtml(option.characterId ?? '')}" data-home-season="${escapeHtml(option.homeSeasonId ?? '')}"` : ''}
            ${checked}>
        <span class="neoterra-identity-portrait" aria-hidden="true">${portrait}</span>
        <span class="neoterra-identity-label">${escapeHtml(option.label)}</span>
        <span class="neoterra-identity-detail">${escapeHtml(detailParts.filter(Boolean).join(' — '))}</span>
        ${option.guest ? '<span class="neoterra-badge neoterra-badge-warning">Non-canon guest</span>' : ''}
    </label>`;
}

export function renderIdentityStep({
    entry,
    choices,
    error,
    guestWarning = null,
    acknowledged = false,
    selectedCharacterId = null,
}) {
    const options = choices.options ?? [];
    const custom = options.filter((option) => option.identity === 'custom');
    const canon = options.filter((option) => option.identity === 'canon' && !option.guest);
    const guests = options.filter((option) => option.guest === true);
    const selected = selectedCharacterId
        ? options.find((option) => (option.characterId ?? null) === (selectedCharacterId === 'custom' ? null : selectedCharacterId)) ?? null
        : options.find((option) => option.isDefault) ?? null;
    const markChecked = (option) => ({ ...option, isDefault: option === selected });
    const checkedOption = selected;
    const warning = guestWarning
        ? `
        <section class="neoterra-guest-warning" data-neoterra-guest-warning role="alert">
            <h5>Non-canon guest: ${escapeHtml(guestWarning.displayName)}</h5>
            <p>${escapeHtml(guestWarning.eraMismatch ?? 'This character belongs to another season.')}</p>
            <p>${escapeHtml(guestWarning.canonBeatPolicy)}</p>
            <label class="neoterra-field neoterra-guest-ack">
                <input type="checkbox" data-neoterra-guest-ack ${acknowledged ? 'checked' : ''}>
                <span>${escapeHtml(guestWarning.acknowledgment)}</span>
            </label>
        </section>`
        : '';

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
                ${custom.map((option) => identityOptionMarkup(markChecked(option))).join('')}
            </fieldset>
            ${canon.length > 0 ? `
            <section class="neoterra-identity-group" data-neoterra-identity-group="roster">
                <h5>Canon roster</h5>
                <fieldset class="neoterra-identity-options">
                    <legend class="neoterra-visually-hidden">Canon roster</legend>
                    ${canon.map((option) => identityOptionMarkup(markChecked(option))).join('')}
                </fieldset>
            </section>` : ''}
            ${guests.length > 0 ? `
            <section class="neoterra-identity-group" data-neoterra-identity-group="guests">
                <h5>Other seasons <span class="neoterra-hint">(guests — warning required)</span></h5>
                <fieldset class="neoterra-identity-options">
                    <legend class="neoterra-visually-hidden">Other seasons</legend>
                    ${guests.map((option) => identityOptionMarkup(markChecked(option))).join('')}
                </fieldset>
            </section>` : ''}
            ${warning}
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
                <button type="submit" class="menu_button neoterra-primary" data-neoterra-identity-confirm
                    ${checkedOption?.guest && !acknowledged ? 'disabled' : ''}>Begin season</button>
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

function hostLabelFor(ctx) {
    if (!ctx || typeof ctx !== 'object') {
        return null;
    }
    const name2 = typeof ctx.name2 === 'string' ? ctx.name2.trim() : '';
    if (name2.length > 0) {
        return name2;
    }
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const characterId = ctx.characterId;
    if (characterId !== undefined && characterId !== null) {
        const character = characters.find((candidate) => candidate && (
            candidate.id === characterId
            || candidate.avatar === characterId
            || String(candidate.id) === String(characterId)
        ));
        if (typeof character?.name === 'string' && character.name.length > 0) {
            return character.name;
        }
    }
    const groups = Array.isArray(ctx.groups) ? ctx.groups : [];
    const group = groups.find((candidate) => String(candidate?.id) === String(ctx.groupId));
    return typeof group?.name === 'string' && group.name.length > 0 ? group.name : null;
}

export function renderSetupStrip(setup) {
    if (!setup) {
        return '';
    }
    const directorInstalled = (setup.directorInstalled ?? setup.installed) === true;
    const modeLabels = {
        director: 'Director / narrator',
        group: 'Group chat',
        solo: 'Solo hot-swap',
    };
    const modeLabel = modeLabels[setup.mode] ?? setup.mode ?? 'Director / narrator';
    const hostLabel = setup.hostName
        || (setup.chatId ? 'Current chat' : null)
        || 'No chat open — open a character or group chat first';
    const narratorLabel = setup.mode === 'solo'
        ? `Canon card${setup.hostName ? ` — ${setup.hostName}` : ''}`
        : directorInstalled
            ? 'Director card — installed'
            : 'Director card — not installed';
    const needsDirectorCard = setup.mode !== 'solo' && !directorInstalled;
    const download = needsDirectorCard
        ? `<button type="button" class="menu_button" data-neoterra-download-director>Download Director card</button>`
        : '';
    const instructions = needsDirectorCard
        ? `<p class="neoterra-setup-hint">Import it in SillyTavern: <strong>Characters → Import character → select the downloaded file</strong>. Then select the card, start a new chat, and enter a season. Solo mode uses the canon card instead.</p>`
        : '';
    const notice = setup.notice
        ? `<p class="neoterra-setup-notice" role="status">${escapeHtml(setup.notice)}</p>`
        : '';

    return `
    <section class="neoterra-setup" data-neoterra-setup>
        <div class="neoterra-setup-row">
            <div class="neoterra-setup-fact">
                <span>Host chat</span>
                <strong>${escapeHtml(hostLabel)}</strong>
            </div>
            <div class="neoterra-setup-fact">
                <span>Narrator</span>
                <strong>${escapeHtml(narratorLabel)}</strong>
            </div>
            <div class="neoterra-setup-fact">
                <span>Mode</span>
                <strong>${escapeHtml(modeLabel)}</strong>
            </div>
            ${download}
        </div>
        ${instructions}
        ${notice}
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
        setup = null,
        guestWarning = null,
        guestAcknowledged = false,
        selectedCharacterId = null,
    } = options;

    if (view === VIEW.IDENTITY && selectedEntry && identityChoices) {
        return renderIdentityStep({
            entry: selectedEntry,
            choices: identityChoices,
            error,
            guestWarning,
            acknowledged: guestAcknowledged,
            selectedCharacterId,
        });
    }
    if (view === VIEW.CONFIRM && selectedEntry && identity) {
        return renderConfirmStep({ entry: selectedEntry, identity, error });
    }

    const cards = entries.map(renderSeasonCard).join('');
    return `
    <div class="neoterra-season-menu" data-neoterra-season-menu>
        ${renderSetupStrip(setup)}
        <div class="neoterra-season-toolbar">
            <label class="neoterra-field neoterra-character-first">
                <span>Character-first</span>
                <input type="search" data-neoterra-character-filter
                    value="${escapeHtml(characterFilter)}"
                    placeholder="Filter seasons by character id">
            </label>
            <button type="button" class="menu_button" data-neoterra-season-refresh>Refresh</button>
        </div>
        <div class="neoterra-season-presets" role="group" aria-label="Recommended presets">
            <span class="neoterra-season-presets-label">Recommended</span>
            ${UI_PRESETS.map((preset) => `
            <button type="button" class="neoterra-preset-button" data-neoterra-preset="${escapeHtml(preset.id)}"
                title="${escapeHtml(preset.description)}">${escapeHtml(preset.label)}</button>`).join('')}
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
    const resolveContext = typeof options.getContext === 'function'
        ? options.getContext
        : getContext;
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
        guestWarning: null,
        guestAcknowledged: false,
        selectedCharacterId: null,
        setupNotice: typeof options.notice === 'string' && options.notice.length > 0
            ? options.notice
            : null,
        directorDownloading: false,
        ctx,
        getContext: resolveContext,
        controller,
        root,
        onStart: typeof options.onStart === 'function' ? options.onStart : null,
        onEntered: typeof options.onEntered === 'function' ? options.onEntered : null,
        onKeepCurrentWorld: typeof options.onKeepCurrentWorld === 'function'
            ? options.onKeepCurrentWorld
            : null,
    };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const liveCtx = state.getContext?.() ?? state.ctx ?? getContext();
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
            guestWarning: state.guestWarning,
            guestAcknowledged: state.guestAcknowledged,
            selectedCharacterId: state.selectedCharacterId,
            setup: state.view === VIEW.LIST
                ? (() => {
                    const status = directorCardStatus(liveCtx);
                    return {
                        mode: liveCtx?.extensionSettings?.neoterra?.castMode ?? 'director',
                        hostName: hostLabelFor(liveCtx),
                        chatId: resolveActiveChatId(liveCtx),
                        directorInstalled: status.installed,
                        directorName: status.name,
                        directorAvatar: status.avatar,
                        notice: state.setupNotice,
                    };
                })()
                : null,
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
            await initAvatars({ registry, ctx: state.getContext?.() ?? state.ctx ?? null });
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

    const handleDirectorDownload = async () => {
        if (state.directorDownloading) {
            return;
        }
        state.directorDownloading = true;
        state.error = null;
        state.setupNotice = 'Preparing the Director card…';
        paint();
        try {
            await downloadDirectorCard();
            state.setupNotice = 'Director card downloaded. Import it via Characters → Import character.';
        } catch (error) {
            state.error = error?.message ?? String(error);
            state.setupNotice = null;
            logger.warn('Could not download the Director card', error);
        } finally {
            state.directorDownloading = false;
            paint();
        }
    };

    const beginSeason = async (confirmReplace) => {
        const entry = state.selectedEntry;
        const radio = selectedRadio();
        const { identity: radioIdentity, characterId } = readIdentityRadio(radio);
        const nameInput = root.querySelector('[data-neoterra-persona-name]');
        const notesInput = root.querySelector('[data-neoterra-persona-notes]');
        // The confirmation view has no identity inputs: carry the captured
        // selection forward instead of rebuilding it from missing fields.
        const identity = mergePendingIdentity(
            state.view === VIEW.CONFIRM ? state.identity : null,
            {
                identity: radioIdentity,
                characterId: characterId || undefined,
                displayName: nameInput?.value?.trim() || undefined,
                personaNotes: notesInput?.value?.trim() || undefined,
                warningAccepted: state.guestAcknowledged === true ? true : undefined,
            },
        );

        state.busy = true;
        state.error = null;
        state.identity = identity;
        paint();
        try {
            const liveCtx = state.getContext?.() ?? state.ctx ?? getContext();
            const start = state.onStart ?? enterSeason;
            const allowGuests = liveCtx?.extensionSettings?.neoterra?.identity?.allowGuests === true;
            const result = await start({
                id: entry.id,
                identity,
                mode: liveCtx?.extensionSettings?.neoterra?.castMode ?? 'director',
                ctx: liveCtx,
                chatId: resolveActiveChatId(liveCtx),
                confirmReplace,
                allowGuests,
                guestCanonBeats: liveCtx?.extensionSettings?.neoterra?.identity?.guestCanonBeats ?? 'adapt',
            });
            state.busy = false;
            state.view = VIEW.LIST;
            state.selectedEntry = null;
            state.identityChoices = null;
            state.identity = null;
            state.guestWarning = null;
            state.guestAcknowledged = false;
            state.selectedCharacterId = null;
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
        const presetId = target.closest?.('[data-neoterra-preset]')?.dataset.neoterraPreset;
        if (presetId) {
            const liveCtx = state.getContext?.() ?? state.ctx ?? getContext();
            try {
                const next = applyUiPreset(getSettings(liveCtx), presetId);
                saveSettings(liveCtx, next);
                const preset = UI_PRESETS.find((entry) => entry.id === presetId);
                state.setupNotice = preset
                    ? `Preset applied: ${preset.label}. ${preset.description}`
                    : 'Preset applied.';
            } catch (error) {
                state.error = error?.message ?? String(error);
                logger.warn('Could not apply the UI preset', error);
            }
            paint();
            return;
        }
        if (target.closest?.('[data-neoterra-download-director]')) {
            void handleDirectorDownload();
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
                    {
                        registry: state.registry,
                        allowGuests: (state.getContext?.() ?? state.ctx)?.extensionSettings?.neoterra?.identity?.allowGuests === true,
                    },
                ),
                state.characterFilter,
            );
            if (state.identityChoices.focusedCharacterId) {
                state.characterFilter = state.identityChoices.focusedCharacterId;
            }
            state.guestWarning = null;
            state.guestAcknowledged = false;
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
            // With a live world, leaving the replace prompt must return to
            // Session Home. The fallback keeps the old in-menu behaviour for
            // callers that mount the menu without a host callback.
            if (state.onKeepCurrentWorld) {
                state.onKeepCurrentWorld();
                return;
            }
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

    root.addEventListener('change', (event) => {
        if (event.target.matches?.('[data-neoterra-guest-ack]')) {
            state.guestAcknowledged = event.target.checked === true;
            paint();
            return;
        }
        const radio = event.target.closest?.('[data-neoterra-identity]');
        if (!radio) {
            return;
        }
        const option = (state.identityChoices?.options ?? [])
            .find((candidate) => candidate.characterId === (radio.dataset?.characterId || null));
        const guest = option?.guest === true;
        state.guestWarning = guest
            ? buildGuestWarning(
                (state.registry?.entries ?? []).find((entry) => entry.id === option.characterId) ?? null,
                state.seasons?.[state.selectedEntry?.id] ?? state.selectedEntry,
            )
            : null;
        state.selectedCharacterId = radio.dataset?.characterId || 'custom';
        if (!guest) {
            state.guestAcknowledged = false;
        }
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
