/**
 * Persistent session HUD.
 *
 * A collapsible right rail that is visible only while the open chat owns a
 * world. It is gameplay-only: season/act/time, location, the player's meters,
 * the current threat and beat, the present cast, and the gameplay actions.
 * Settings, export/import, agent configuration, prompts, and diagnostics stay
 * in SillyTavern's Extensions drawer and are never rendered here.
 *
 * The view model is pure so the placement, meter, and action rules can be
 * tested in Node; the mount only owns DOM wiring and a hidden-by-default rail.
 */

import { createLogger } from '../core/logger.js';
import { effectiveStoryTurn } from '../core/world-clock.js';
import { selectOpenBeats } from '../state/selectors.js';
import { buildPlayerSheet, escapeHtml as escapePlayerHtml } from './player-panel.js';
import { buildSessionHomeView, escapeHtml } from './session-home.js';
import { avatarStripMarkup, avatarMarkup } from './avatar.js';

const logger = createLogger('hud');

/** Gameplay actions only. Non-gameplay surfaces belong in the Extensions drawer. */
export const HUD_ACTIONS = Object.freeze([
    { id: 'map', label: 'Map', icon: 'fa-map' },
    { id: 'characters', label: 'Cast', icon: 'fa-users' },
    { id: 'player', label: 'Player', icon: 'fa-user-shield' },
    { id: 'journal', label: 'Journal', icon: 'fa-book' },
    { id: 'newspaper', label: 'News', icon: 'fa-newspaper' },
]);

export const HUD_MIN_HEIGHT = 220;
export const HUD_MARGIN = 12;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a persisted rail offset to the current viewport. A short viewport
 * keeps the rail on screen instead of restoring stale geometry off-canvas.
 */
export function clampHudGeometry(geometry = {}, viewport = {}, options = {}) {
    const width = Number(viewport?.width) > 0 ? Number(viewport.width) : 1280;
    const height = Number(viewport?.height) > 0 ? Number(viewport.height) : 800;
    const margin = Number.isFinite(options.margin) ? options.margin : HUD_MARGIN;
    const requestedMin = Number.isFinite(options.minHeight) ? options.minHeight : HUD_MIN_HEIGHT;
    // A short viewport cannot fit the nominal minimum; shrink it instead of
    // overflowing the rail below the send form.
    const minHeight = Math.max(0, Math.min(requestedMin, height - margin * 2));
    const maxHeight = Math.max(minHeight, height - margin * 2);
    const top = clamp(Number(geometry?.top) || margin, margin, Math.max(margin, height - minHeight - margin));
    const resolvedHeight = clamp(Number(geometry?.height) || maxHeight, minHeight, Math.max(minHeight, height - top - margin));
    return { top, height: resolvedHeight, width };
}

/** Mobile turns the rail into a bottom sheet; desktop keeps the right rail. */
export function resolveHudMode(viewport = {}) {
    const width = Number(viewport?.width) > 0 ? Number(viewport.width) : 1280;
    return width <= 720 ? 'sheet' : 'rail';
}

function deadlineOf(beat, state) {
    if (!beat) {
        return null;
    }
    const turn = effectiveStoryTurn(state);
    const deadlineTurn = Number.isFinite(beat.deadlineTurns) ? beat.deadlineTurns : null;
    if (deadlineTurn !== null) {
        const remaining = deadlineTurn - turn;
        if (remaining >= 0) {
            return { label: `${remaining} turn${remaining === 1 ? '' : 's'} left`, remaining };
        }
        return { label: 'Deadline passed', remaining };
    }
    if (typeof beat.deadlineDate === 'string' && beat.deadlineDate.length > 0) {
        return { label: `By ${beat.deadlineDate}`, remaining: null };
    }
    return null;
}

/**
 * Pure HUD view model. Null when the chat has no world, which is also the
 * rule that hides the rail.
 */
export function buildHudView({
    state = null,
    season = null,
    registry = null,
    locations = null,
    settings = null,
} = {}) {
    const home = buildSessionHomeView({ state, season, registry, locations });
    if (!home) {
        return null;
    }
    const sheet = buildPlayerSheet({ state, season, registry });
    const openBeat = selectOpenBeats(state, season)[0] ?? null;
    const playerCharacterId = state?.player?.characterId ?? null;
    const present = home.present.filter((entry) => entry.id !== playerCharacterId);

    return {
        visible: true,
        collapsed: settings?.ui?.hudCollapsed === true,
        title: home.title,
        era: home.era,
        act: home.act,
        when: [home.date, home.timeLabel].filter(Boolean).join(' · '),
        location: home.location,
        player: {
            name: home.player.name,
            initials: home.player.initials,
            formLabel: home.player.formLabel,
            formId: sheet?.form?.id ?? null,
            characterId: playerCharacterId,
            portrait: home.player.portrait,
        },
        resources: asArray(sheet?.resources).map((resource) => ({
            id: resource.id,
            label: resource.label,
            current: resource.current,
            max: resource.max,
            percent: resource.percent,
        })),
        corruption: sheet?.corruption
            ? {
                label: sheet.corruption.label,
                stage: sheet.corruption.stage,
                progress: sheet.corruption.progress,
                active: sheet.corruption.active,
            }
            : null,
        threat: home.threat,
        beat: home.beat
            ? { ...home.beat, deadline: deadlineOf(openBeat ?? home.beat, state) }
            : null,
        present,
        presentIds: present.map((entry) => entry.id).filter(Boolean),
        inCombat: home.inCombat,
        actions: HUD_ACTIONS.map((action) => ({ ...action })),
    };
}

function renderMeter(resource) {
    return `
    <div class="neoterra-hud-meter" data-neoterra-hud-meter="${escapeHtml(resource.id)}">
        <div class="neoterra-hud-meter-head">
            <span>${escapeHtml(resource.label)}</span>
            <span>${escapeHtml(resource.current)}/${escapeHtml(resource.max)}</span>
        </div>
        <div class="neoterra-hud-meter-track" role="meter" aria-valuemin="0"
            aria-valuemax="${escapeHtml(resource.max)}" aria-valuenow="${escapeHtml(resource.current)}"
            aria-label="${escapeHtml(resource.label)}">
            <span class="neoterra-hud-meter-fill" style="width:${clamp(resource.percent, 0, 100)}%"></span>
        </div>
    </div>`;
}

function renderCorruption(corruption) {
    if (!corruption) {
        return '';
    }
    const percent = clamp(corruption.progress, 0, 100);
    return `
    <div class="neoterra-hud-corruption" data-neoterra-hud-corruption="${corruption.active ? 'true' : 'false'}">
        <div class="neoterra-hud-meter-head">
            <span>${escapeHtml(corruption.label)}</span>
            <span>${escapeHtml(corruption.stage)}</span>
        </div>
        <div class="neoterra-hud-meter-track" role="meter" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="${percent}" aria-label="${escapeHtml(corruption.label)}">
            <span class="neoterra-hud-meter-fill neoterra-hud-corruption-fill" style="width:${percent}%"></span>
        </div>
    </div>`;
}

function renderThreat(threat) {
    if (!threat) {
        return '<p class="neoterra-hud-empty">No active threat.</p>';
    }
    const percent = clamp(threat.progress, 0, 100);
    return `
    <div class="neoterra-hud-threat" data-neoterra-hud-threat>
        <div class="neoterra-hud-threat-head">
            <span class="neoterra-hud-threat-name">${escapeHtml(threat.name)}</span>
            <span class="neoterra-hud-threat-progress">${percent}%</span>
        </div>
        ${threat.stage ? `<p class="neoterra-hud-threat-stage">${escapeHtml(threat.stage)}</p>` : ''}
        <div class="neoterra-hud-meter-track" role="meter" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="${percent}" aria-label="${escapeHtml(threat.name)}">
            <span class="neoterra-hud-meter-fill neoterra-hud-threat-fill" style="width:${percent}%"></span>
        </div>
    </div>`;
}

function renderPresent(present) {
    if (!present || present.length === 0) {
        return '<p class="neoterra-hud-empty">Nobody else is on stage.</p>';
    }
    const ids = present.map((entry) => entry.id).filter(Boolean);
    return `
    <div class="neoterra-hud-present" data-neoterra-hud-present>
        ${avatarStripMarkup(ids, { size: 'sm', className: 'neoterra-hud-strip' })}
        <ul class="neoterra-hud-present-list">
            ${present.map((entry) => `<li>${escapeHtml(entry.name)}</li>`).join('')}
        </ul>
    </div>`;
}

function renderBeat(beat) {
    if (!beat) {
        return '<p class="neoterra-hud-empty">No open beat.</p>';
    }
    const deadline = beat.deadline?.label
        ? `<span class="neoterra-hud-deadline" data-neoterra-hud-deadline>${escapeHtml(beat.deadline.label)}</span>`
        : '';
    return `
    <div class="neoterra-hud-beat" data-neoterra-hud-beat>
        <span class="neoterra-hud-beat-title">${escapeHtml(beat.title ?? beat.id ?? 'Beat')}</span>
        ${beat.act ? `<span class="neoterra-hud-beat-act">${escapeHtml(beat.act)}</span>` : ''}
        ${deadline}
    </div>`;
}

function renderActions(actions) {
    return actions.map((action) => `
        <button type="button" class="neoterra-hud-action" data-neoterra-hud-action="${escapeHtml(action.id)}"
            title="${escapeHtml(action.label)}">
            <i class="fa-solid ${escapeHtml(action.icon ?? 'fa-circle')}" aria-hidden="true"></i>
            <span>${escapeHtml(action.label)}</span>
        </button>`).join('');
}

/** Pure markup for the rail; the mount owns events. */
export function renderHudMarkup(view, { mode = 'rail' } = {}) {
    if (!view?.visible) {
        return '';
    }
    const collapsed = view.collapsed === true;
    const when = view.when ? `<p class="neoterra-hud-when">${escapeHtml(view.when)}</p>` : '';
    const playerId = view.player.formId ?? view.player.characterId;
    const portrait = playerId
        ? avatarMarkup(playerId, { size: 'md', name: view.player.name, label: view.player.name })
        : `<span class="neoterra-avatar neoterra-avatar-md"><span class="neoterra-avatar-fallback" aria-hidden="true">${escapePlayerHtml(view.player.initials || '?')}</span></span>`;
    return `
    <div class="neoterra-hud-inner" data-neoterra-hud data-mode="${escapeHtml(mode)}"
        data-collapsed="${collapsed ? 'true' : 'false'}">
        <button type="button" class="neoterra-hud-toggle" data-neoterra-hud-toggle
            aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="neoterra-hud-body"
            title="${collapsed ? 'Expand the HUD' : 'Collapse the HUD'}">
            <i class="fa-solid ${collapsed ? 'fa-chevron-left' : 'fa-chevron-right'}" aria-hidden="true"></i>
            <span class="neoterra-hud-toggle-label">${collapseLabel(collapsed)}</span>
        </button>
        <div class="neoterra-hud-body" id="neoterra-hud-body">
            <header class="neoterra-hud-header">
                <div class="neoterra-hud-portrait">${portrait}</div>
                <div class="neoterra-hud-heading">
                    <p class="neoterra-hud-era">${escapeHtml([view.era, view.act].filter(Boolean).join(' · '))}</p>
                    <h3 class="neoterra-hud-title">${escapeHtml(view.title)}</h3>
                    <p class="neoterra-hud-player">${escapeHtml(view.player.name)} · ${escapeHtml(view.player.formLabel)}</p>
                    ${when}
                    ${view.inCombat ? '<span class="neoterra-badge neoterra-badge-danger">In combat</span>' : ''}
                </div>
            </header>

            <section class="neoterra-hud-section" aria-label="Location">
                <h4>Location</h4>
                <p class="neoterra-hud-location" data-neoterra-hud-location>
                    ${escapeHtml(view.location?.name ?? 'Unknown location')}
                </p>
            </section>

            <section class="neoterra-hud-section" aria-label="Player meters">
                <h4>Player</h4>
                <div class="neoterra-hud-meters">${view.resources.map(renderMeter).join('')}${renderCorruption(view.corruption)}</div>
            </section>

            <section class="neoterra-hud-section" aria-label="Threat">
                <h4>Threat</h4>
                ${renderThreat(view.threat)}
            </section>

            <section class="neoterra-hud-section" aria-label="Current beat">
                <h4>Beat</h4>
                ${renderBeat(view.beat)}
            </section>

            <section class="neoterra-hud-section" aria-label="Present cast">
                <h4>Present</h4>
                ${renderPresent(view.present)}
            </section>

            <nav class="neoterra-hud-actions" aria-label="Gameplay actions">
                ${renderActions(view.actions)}
            </nav>
        </div>
    </div>`;
}

function collapseLabel(collapsed) {
    return collapsed ? 'HUD' : 'Hide';
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export function mountHud({
    getContext = null,
    getSettings = null,
    onAction = null,
    onToggleCollapsed = null,
} = {}) {
    if (!hasDom()) {
        return null;
    }
    let root = document.getElementById('neoterra-hud');
    if (!root) {
        root = document.createElement('aside');
        root.id = 'neoterra-hud';
        document.body.append(root);
    }
    const controller = new AbortController();

    const buildView = () => {
        let live = null;
        try {
            live = typeof getContext === 'function' ? getContext() : null;
        } catch (error) {
            logger.debug('Could not read the context for the HUD', error);
            return null;
        }
        let settings = null;
        try {
            settings = typeof getSettings === 'function' ? getSettings(live) : null;
        } catch (error) {
            logger.debug('Could not read the settings for the HUD', error);
        }
        const neoterra = live?.chatMetadata?.neoterra ?? null;
        return buildHudView({
            state: neoterra?.worldState ?? null,
            season: neoterra?.seasonDefinition ?? null,
            locations: neoterra?.locations ?? null,
            registry: neoterra?.registry ?? null,
            settings: settings ?? live?.chatMetadata?.neoterra?.ui ?? null,
        });
    };

    const paint = () => {
        if (!root || (typeof root.isConnected === 'boolean' && !root.isConnected)) {
            return null;
        }
        const view = buildView();
        if (!view?.visible) {
            root.hidden = true;
            root.dataset.visible = 'false';
            root.innerHTML = '';
            return null;
        }
        root.hidden = false;
        root.dataset.visible = 'true';
        root.className = 'neoterra-hud';
        root.dataset.mode = resolveHudMode({ width: window.innerWidth });
        root.dataset.collapsed = view.collapsed === true ? 'true' : 'false';
        root.setAttribute('aria-label', 'Neo Terra session HUD');
        root.innerHTML = renderHudMarkup(view, { mode: root.dataset.mode });
        placeHud(root, root.dataset.mode);
        return view;
    };

    // The rail clamp is applied on mount and on viewport resize, not only in
    // CSS: a short window must never push the actions below the send form.
    function placeHud(element, mode) {
        if (!element?.style) {
            return;
        }
        if (mode === 'rail') {
            const geometry = clampHudGeometry(
                { top: 76, height: (window.innerHeight || 800) - 160 },
                { width: window.innerWidth || 1280, height: window.innerHeight || 800 },
            );
            element.style.top = `${geometry.top}px`;
            element.style.maxHeight = `${geometry.height}px`;
        } else {
            element.style.top = '';
            element.style.maxHeight = '';
        }
    }

    root.addEventListener('click', (event) => {
            if (event.target.closest?.('[data-neoterra-hud-toggle]')) {
                const collapsed = root.dataset.collapsed === 'true';
                root.dataset.collapsed = collapsed ? 'false' : 'true';
                const inner = root.querySelector('.neoterra-hud-inner');
                if (inner) {
                    inner.dataset.collapsed = root.dataset.collapsed;
                }
                const button = root.querySelector('[data-neoterra-hud-toggle]');
                button?.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
                try {
                    onToggleCollapsed?.(!collapsed);
                } catch (error) {
                    logger.debug('Could not persist the HUD collapse state', error);
                }
                return;
            }
            const action = event.target.closest?.('[data-neoterra-hud-action]')?.dataset.neoterraHudAction;
            if (action) {
                try {
                    onAction?.(action);
                } catch (error) {
                    logger.warn('HUD action failed', error);
                }
            }
        }, { signal: controller.signal });
    window.addEventListener('resize', () => paint(), { signal: controller.signal });

    const view = paint();
    return {
        root: () => root,
        refresh: paint,
        getView: buildView,
        visible: Boolean(view?.visible),
        dispose: () => {
            controller.abort();
            root?.remove?.();
            root = null;
        },
    };
}

export function disposeHud() {
    document.getElementById('neoterra-hud')?.remove();
}
