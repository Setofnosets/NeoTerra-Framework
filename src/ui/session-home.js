/**
 * Session Home: the Story tab when the current chat already owns a world.
 *
 * The home answers "where am I in this timeline" and offers a way back into
 * play. It is read-only: every action is delegated to the shell, and every
 * data point comes from `WorldState` plus the authored season definition.
 */

import { createLogger } from '../core/logger.js';
import { isPlayerCharacter, selectOpenBeats, selectPresentCast } from '../state/selectors.js';

const logger = createLogger('session-home');

const TIME_LABELS = Object.freeze({
    dawn: 'Dawn',
    morning: 'Morning',
    afternoon: 'Afternoon',
    evening: 'Evening',
    night: 'Night',
});

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function characterName(entry) {
    return entry?.displayName ?? entry?.name ?? entry?.charId ?? 'Unknown';
}

function initialsOf(name) {
    return String(name ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || '?';
}

function mainThreatOf(state) {
    const threats = asArray(state?.threats);
    const active = threats.filter((threat) => threat?.status === 'active');
    return active.find((threat) => threat.rank === 'main')
        ?? active[0]
        ?? threats.find((threat) => threat?.status === 'active')
        ?? threats[0]
        ?? null;
}

function stageLabel(threat) {
    if (!threat) {
        return null;
    }
    const stages = asArray(threat.stages);
    const index = Number.isFinite(threat.stage) ? threat.stage : 0;
    return stages[index] ?? stages[stages.length - 1] ?? `stage ${index + 1}`;
}

/**
 * Deterministic "previously on" paragraph. The Lore agent may replace this
 * later; the fallback must always produce something readable.
 */
export function buildPreviouslyOn(state, season) {
    const events = asArray(state?.recentEvents)
        .map((event) => (typeof event?.summary === 'string' ? event.summary.trim() : ''))
        .filter(Boolean);
    if (events.length > 0) {
        return events.slice(-3).join(' ');
    }
    if (typeof season?.premise === 'string' && season.premise.trim().length > 0) {
        return season.premise.trim();
    }
    return 'A new Neo Terra timeline begins.';
}

/**
 * Pure view model for Session Home. Returns null when the chat has no world.
 */
export function buildSessionHomeView({
    state = null,
    season = null,
    registry = null,
    locations = null,
} = {}) {
    if (!state || typeof state !== 'object' || !state.player) {
        return null;
    }
    const player = state.player;
    const character = player.identity === 'canon' && player.characterId
        ? state.characters?.[player.characterId] ?? null
        : null;
    const role = character ?? player;
    const displayName = role.displayName ?? player.displayName ?? 'The Player';
    const locationId = state.scene?.locationId ?? null;
    const locationName = locationId
        ? (state.locations?.[locationId]?.name ?? locations?.byId?.[locationId]?.name ?? locationId)
        : null;
    const openBeats = selectOpenBeats(state, season);
    const beat = openBeats[0] ?? null;
    const threat = mainThreatOf(state);
    const presentNpcs = selectPresentCast(state)
        .filter((entry) => !isPlayerCharacter(state, entry?.charId ?? entry?.id ?? null))
        .map((entry) => {
            const name = characterName(entry);
            return { id: entry.charId ?? entry.id ?? name, name, initials: initialsOf(name) };
        });
    // The scene is the authority for where the player physically is: a custom
    // persona's mirror `locationId` is seeded once and not maintained by
    // SET_LOCATION, so prefer the scene and fall back to the mirror.
    const playerLocationId = state.scene?.locationId ?? player.locationId ?? null;
    const playerHere = typeof state.scene?.locationId === 'string'
        && state.scene.locationId === playerLocationId;
    const registryEntry = character?.charId && registry
        ? asArray(registry.entries).find((entry) => entry.id === character.charId) ?? null
        : null;
    const actorId = character?.charId ?? null;
    const anyBadEnd = actorId && state.badEnds?.[actorId] ? state.badEnds[actorId] : null;

    return {
        title: season?.title ?? state.seasonId ?? 'Neo Terra',
        era: season?.era ?? null,
        seasonId: state.seasonId ?? season?.id ?? null,
        act: beat?.act ?? state.scene?.act ?? 'opening',
        beat: beat ? { id: beat.id, title: beat.title, act: beat.act, order: beat.order } : null,
        turn: Number.isFinite(state.meta?.turn) ? state.meta.turn : 0,
        storyTurn: Number.isFinite(state.meta?.storyTurn) ? state.meta.storyTurn : null,
        date: state.meta?.inGameDate ?? null,
        time: state.meta?.timeOfDay ?? null,
        timeLabel: TIME_LABELS[state.meta?.timeOfDay] ?? state.meta?.timeOfDay ?? null,
        player: {
            name: displayName,
            initials: initialsOf(displayName),
            identity: player.identity ?? 'custom',
            form: role.formId ?? null,
            formLabel: role.formId
                ? (registryEntry?.displayName ?? role.formId)
                : 'Custom persona',
            portrait: registryEntry?.avatar ?? null,
        },
        location: locationId ? { id: locationId, name: locationName ?? locationId } : null,
        threat: threat
            ? {
                id: threat.id ?? null,
                name: threat.name ?? threat.id ?? 'Unknown threat',
                rank: threat.rank ?? null,
                status: threat.status ?? null,
                stage: stageLabel(threat),
                progress: Number.isFinite(threat.progress) ? threat.progress : 0,
            }
            : null,
        present: presentNpcs,
        presentNpcs,
        playerHere,
        previouslyOn: buildPreviouslyOn(state, season),
        badEnd: anyBadEnd
            ? { type: anyBadEnd.type ?? anyBadEnd.badEndType ?? null }
            : null,
        inCombat: state.meta?.inCombat === true,
        actions: [
            { id: 'continue', label: 'Continue', primary: true },
            { id: 'map', label: 'Map' },
            { id: 'characters', label: 'Cast' },
            { id: 'player', label: 'Player' },
            { id: 'journal', label: 'Journal' },
        ],
        secondaryActions: [
            { id: 'new-timeline', label: 'New timeline' },
        ],
    };
}

function renderBadge(label, tone = '') {
    return `<span class="neoterra-badge${tone ? ` neoterra-badge-${tone}` : ''}">${escapeHtml(label)}</span>`;
}

function renderChips(view) {
    const chips = [];
    if (view.act) {
        chips.push(renderBadge(`${view.act} act`));
    }
    if (view.beat?.title) {
        chips.push(renderBadge(view.beat.title));
    }
    if (view.inCombat) {
        chips.push(renderBadge('In combat', 'danger'));
    }
    if (view.badEnd?.type) {
        chips.push(renderBadge(`Bad end: ${view.badEnd.type}`, 'danger'));
    }
    return chips.join('');
}

function renderPresent(view) {
    const npcs = Array.isArray(view.presentNpcs) ? view.presentNpcs : (view.present ?? []);
    const marker = view.playerHere
        ? '<p class="neoterra-home-player-here" data-neoterra-home-player-here>You are here</p>'
        : '';
    if (npcs.length === 0) {
        return marker || '<p class="neoterra-empty">Nobody else is on stage.</p>';
    }
    return `
    ${marker}
    <ul class="neoterra-home-cast">
        ${npcs.map((entry) => `
        <li class="neoterra-home-cast-member" data-neoterra-home-character="${escapeHtml(entry.id)}">
            <span class="neoterra-home-avatar" aria-hidden="true">${escapeHtml(entry.initials)}</span>
            <span>${escapeHtml(entry.name)}</span>
        </li>`).join('')}
    </ul>`;
}

/**
 * Pure markup. The shell mounts it and wires `[data-neoterra-home-action]`.
 */
export function renderSessionHomeMarkup(view) {
    if (!view) {
        return '<p class="neoterra-empty">No world is active in this chat.</p>';
    }
    const threat = view.threat
        ? `
        <div class="neoterra-home-threat" data-neoterra-home-threat>
            <span class="neoterra-home-threat-name">${escapeHtml(view.threat.name)}</span>
            ${view.threat.stage ? renderBadge(view.threat.stage, 'warning') : ''}
            <span class="neoterra-home-threat-progress">${view.threat.progress}%</span>
        </div>`
        : '<p class="neoterra-empty">No active threat.</p>';
    const when = [view.date, view.timeLabel].filter(Boolean).join(' · ');
    return `
    <div class="neoterra-session-home" data-neoterra-session-home>
        <header class="neoterra-home-header">
            <div class="neoterra-home-portrait" aria-hidden="true">${escapeHtml(view.player.initials)}</div>
            <div class="neoterra-home-heading">
                <p class="neoterra-home-era">${escapeHtml([view.era, when].filter(Boolean).join(' · '))}</p>
                <h3 class="neoterra-home-title">${escapeHtml(view.title)}</h3>
                <p class="neoterra-home-player">
                    ${escapeHtml(view.player.name)} · ${escapeHtml(view.player.formLabel)}
                    ${view.location ? ` · ${escapeHtml(view.location.name)}` : ''}
                </p>
                <div class="neoterra-chip-row">${renderChips(view)}</div>
            </div>
        </header>

        <section class="neoterra-home-section">
            <h4>Previously on</h4>
            <p class="neoterra-home-recap" data-neoterra-home-recap>${escapeHtml(view.previouslyOn)}</p>
        </section>

        <div class="neoterra-home-columns">
            <section class="neoterra-home-section">
                <h4>Current threat</h4>
                ${threat}
            </section>
            <section class="neoterra-home-section">
                <h4>Present</h4>
                ${renderPresent(view)}
            </section>
        </div>

        <div class="neoterra-home-actions">
            ${view.actions.map((action) => `
            <button type="button" class="menu_button neoterra-home-action"
                data-neoterra-home-action="${escapeHtml(action.id)}"
                ${action.primary ? 'data-primary="true"' : ''}
                ${action.disabled ? 'disabled title="' + escapeHtml(action.note ?? '') + '"' : ''}>
                ${escapeHtml(action.label)}
            </button>`).join('')}
        </div>
        <div class="neoterra-home-secondary">
            ${view.secondaryActions.map((action) => `
            <button type="button" class="menu_button neoterra-home-secondary-action"
                data-neoterra-home-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`).join('')}
            <button type="button" class="menu_button" data-neoterra-home-refresh>Refresh</button>
        </div>
    </div>`;
}

/**
 * Mount Session Home into the Story tab. `getContext` is re-read on every
 * refresh so a chat switch or a turn cannot paint a stale timeline.
 */
export function mountSessionHome({ root, getContext, onAction = null } = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return null;
    }
    if (!root) {
        throw new TypeError('mountSessionHome requires a root element');
    }
    const controller = new AbortController();
    const state = { root, getContext, onAction, controller };

    const buildView = () => {
        const live = typeof getContext === 'function' ? getContext() : null;
        return buildSessionHomeView({
            state: live?.chatMetadata?.neoterra?.worldState ?? null,
            season: live?.chatMetadata?.neoterra?.seasonDefinition ?? null,
            locations: live?.chatMetadata?.neoterra?.locations ?? null,
            registry: live?.chatMetadata?.neoterra?.registry ?? null,
        });
    };

    const paint = () => {
        if (typeof root.isConnected === 'boolean' && !root.isConnected) {
            return;
        }
        try {
            root.innerHTML = renderSessionHomeMarkup(buildView());
        } catch (error) {
            logger.warn('Could not render Session Home', error);
            root.innerHTML = '<p class="neoterra-error" role="alert">Session Home could not be rendered.</p>';
        }
    };

    root.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-neoterra-home-refresh]')) {
            paint();
            return;
        }
        const action = event.target.closest?.('[data-neoterra-home-action]')?.dataset.neoterraHomeAction;
        if (!action) {
            return;
        }
        onAction?.(action);
    }, { signal: controller.signal });

    paint();
    return {
        root,
        refresh: paint,
        buildView,
        dispose: () => {
            controller.abort();
            if (root?.isConnected) {
                root.innerHTML = '';
            }
        },
    };
}
