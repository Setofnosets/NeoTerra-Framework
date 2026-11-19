/**
 * Neo Terra player sheet.
 *
 * The panel is a thin DOM client over `buildPlayerSheet` and
 * `applyManualPlayerEdit`. It shows the modular sheet, a "Playing as" badge,
 * live stamina/willpower bars, status chips, skills, traits, allegiance,
 * corruption, relationships, and the active form. Villain-POV seasons reuse the
 * same sheet with villain-side labels.
 *
 * Manual edits are allowed: they are applied immediately, marked `manual`, and
 * protected from the next tracker pass.
 */

import { createLogger } from '../core/logger.js';
import { avatarMarkup, initAvatars } from './avatar.js';
import {
    applyManualPlayerEdit,
    getManualEditPaths,
} from '../agents/state-tracker.js';

const logger = createLogger('player-panel');

let mounted = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

const HERO_LABELS = Object.freeze({
    stamina: 'Stamina',
    willpower: 'Willpower',
    status: 'Status',
    allegiance: 'Allegiance',
    corruption: 'Corruption',
    relationships: 'Relationships',
    skills: 'Skills',
});

const VILLAIN_LABELS = Object.freeze({
    stamina: 'Dominion',
    willpower: 'Conviction',
    status: 'Standing',
    allegiance: 'Loyalty',
    corruption: 'Ascension',
    relationships: 'Leverage',
    skills: 'Talents',
});

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function resourceBar(current, max) {
    const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
    const safeCurrent = Number.isFinite(current) ? clamp(current, 0, safeMax) : 0;
    return {
        current: safeCurrent,
        max: safeMax,
        percent: Math.round((safeCurrent / safeMax) * 100),
    };
}

function relationshipName(state, relationship) {
    if (typeof relationship?.withCharacterId === 'string') {
        return state?.characters?.[relationship.withCharacterId]?.displayName
            ?? relationship.withCharacterId;
    }
    if (typeof relationship?.b === 'string') {
        return state?.characters?.[relationship.b]?.displayName ?? relationship.b;
    }
    return 'Unknown';
}

function relationshipsFor(state, characterId) {
    const direct = asArray(state?.player?.relationships).map((relationship) => ({ ...relationship }));
    const world = asArray(state?.relationships).filter(
        (relationship) => !characterId
            || relationship.a === characterId
            || relationship.b === characterId,
    );
    return [...direct, ...world].map((relationship) => ({
        name: relationshipName(state, relationship),
        type: relationship.type ?? 'neutral',
        affinity: Number.isFinite(relationship.affinity) ? relationship.affinity : 0,
        tension: Number.isFinite(relationship.tension) ? relationship.tension : 0,
    }));
}

/**
 * Pure view model for the player panel.
 */
export function buildPlayerSheet({ state, season = null, registry = null } = {}) {
    const player = state?.player;
    if (!player || typeof player !== 'object') {
        return null;
    }
    const character = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    const role = character ?? player;
    const villainPov = state?.playerRole === 'villain';
    const labels = villainPov ? VILLAIN_LABELS : HERO_LABELS;
    const registryEntry = character?.charId && registry
        ? (registry.entries ?? []).find((entry) => entry.id === character.charId) ?? null
        : null;

    const displayName = role.displayName ?? player.displayName ?? 'The Player';
    const initials = displayName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');

    const statusChips = [];
    if (role.status) {
        statusChips.push({ label: String(role.status), tone: role.status === 'dead' ? 'danger' : 'default' });
    }
    if (role.badEndType) {
        statusChips.push({ label: String(role.badEndType), tone: 'danger' });
    }
    if (state?.meta?.inCombat === true) {
        statusChips.push({ label: 'In combat', tone: 'warning' });
    }
    if (state?.flags?.nonCanon === true) {
        statusChips.push({ label: 'Non-canon', tone: 'warning' });
    }
    if (villainPov) {
        statusChips.push({ label: 'Villain POV', tone: 'danger' });
    }

    const corruptionStage = Number(role.corruption?.stage ?? 0);
    const corruptionProgress = Number(role.corruption?.progress ?? 0);

    return {
        identity: player.identity ?? 'custom',
        characterId: player.characterId ?? null,
        displayName,
        initials,
        portrait: registryEntry?.avatar ?? registryEntry?.file ?? null,
        playingAs: player.identity === 'canon'
            ? `Playing as ${displayName}`
            : 'Playing as your custom persona',
        nonCanon: state?.flags?.nonCanon === true,
        villainPov,
        roleLabel: villainPov ? 'Villain' : (state?.playerRole === 'hero' ? 'Hero' : 'Neutral'),
        seasonTitle: season?.title ?? state?.seasonId ?? null,
        form: {
            id: role.formId ?? null,
            group: role.formGroup ?? null,
            label: role.formId
                ? (registryEntry?.displayName ?? role.formId)
                : 'Custom persona',
        },
        location: state?.scene?.locationId
            ? state?.locations?.[state.scene.locationId]?.name ?? state.scene.locationId
            : null,
        labels,
        resources: [
            {
                id: 'stamina',
                label: labels.stamina,
                ...resourceBar(role.stamina?.current, role.stamina?.max),
            },
            {
                id: 'willpower',
                label: labels.willpower,
                ...resourceBar(role.willpower?.current, role.willpower?.max),
            },
        ],
        statusChips,
        agenda: role.agenda ?? '',
        goals: asArray(role.goals),
        skills: asArray(role.skills),
        traits: asArray(role.traits),
        injuries: asArray(role.injuries),
        outfit: role.outfit ?? '',
        mood: role.mood ?? '',
        notes: role.notes ?? '',
        allegiance: role.allegiance ?? 'neutral',
        corruption: {
            label: labels.corruption,
            stage: corruptionStage,
            progress: clamp(corruptionProgress, 0, 100),
            active: corruptionStage > 0 || corruptionProgress > 0,
        },
        relationships: relationshipsFor(state, character?.charId ?? null),
        manualEditPaths: getManualEditPaths(state),
        editable: true,
    };
}

function resourceMarkup(resource) {
    return `
    <div class="neoterra-player-resource" data-neoterra-resource="${escapeHtml(resource.id)}">
        <div class="neoterra-player-resource-head">
            <span>${escapeHtml(resource.label)}</span>
            <span>${resource.current}/${resource.max}</span>
        </div>
        <div class="neoterra-player-meter" role="meter" aria-valuemin="0"
            aria-valuemax="${resource.max}" aria-valuenow="${resource.current}"
            aria-label="${escapeHtml(resource.label)}">
            <span class="neoterra-player-meter-fill" style="width:${resource.percent}%"></span>
        </div>
    </div>`;
}

function chipsMarkup(chips) {
    if (chips.length === 0) {
        return '<p class="neoterra-empty">No active status.</p>';
    }
    return `<div class="neoterra-chip-row">${chips.map((chip) => (
        `<span class="neoterra-chip neoterra-chip-${escapeHtml(chip.tone)}">${escapeHtml(chip.label)}</span>`
    )).join('')}</div>`;
}

function listMarkup(values, empty = 'None') {
    if (values.length === 0) {
        return `<p class="neoterra-empty">${escapeHtml(empty)}</p>`;
    }
    return `<ul class="neoterra-player-list">${values.map((value) => (
        `<li>${escapeHtml(value)}</li>`
    )).join('')}</ul>`;
}

function relationshipsMarkup(relationships) {
    if (relationships.length === 0) {
        return '<p class="neoterra-empty">No tracked relationships.</p>';
    }
    return `<ul class="neoterra-player-relationships">${relationships.map((relationship) => `
        <li>
            <span class="neoterra-relationship-name">${escapeHtml(relationship.name)}</span>
            <span class="neoterra-relationship-type">${escapeHtml(relationship.type)}</span>
            <span class="neoterra-relationship-meter">
                affinity ${relationship.affinity}; tension ${relationship.tension}
            </span>
        </li>`).join('')}</ul>`;
}

/**
 * Pure markup for tests and the mounted panel.
 */
export function renderPlayerPanelMarkup(sheet, { editable = true } = {}) {
    if (!sheet) {
        return '<p class="neoterra-empty">No player world is active in this chat.</p>';
    }
    const statusOptions = [
        'active',
        'offscreen',
        'captured',
        'corrupted',
        'dead',
        'retired',
        'missing',
        'lost',
        'imprisoned',
    ].map((status) => (
        `<option value="${status}" ${status === sheet.statusChips[0]?.label ? 'selected' : ''}>${status}</option>`
    )).join('');

    return `
    <section class="neoterra-player-sheet" data-neoterra-player-sheet
        data-player-identity="${escapeHtml(sheet.identity)}"
        data-player-role="${escapeHtml(sheet.roleLabel.toLowerCase())}">
        <header class="neoterra-player-head">
            <div class="neoterra-player-portrait" aria-hidden="true">
                ${sheet.characterId ? avatarMarkup(sheet.form?.id ?? sheet.characterId, { size: 'lg', name: sheet.displayName, label: sheet.displayName }) : escapeHtml(sheet.initials || '?')}
            </div>
            <div class="neoterra-player-title">
                <h4>${escapeHtml(sheet.displayName)}</h4>
                <p class="neoterra-player-badge">${escapeHtml(sheet.playingAs)}</p>
                <p class="neoterra-player-meta">
                    ${escapeHtml(sheet.roleLabel)}${sheet.seasonTitle ? ` · ${escapeHtml(sheet.seasonTitle)}` : ''}
                    ${sheet.location ? ` · ${escapeHtml(sheet.location)}` : ''}
                </p>
            </div>
        </header>

        ${chipsMarkup(sheet.statusChips)}

        <div class="neoterra-player-resources">
            ${sheet.resources.map(resourceMarkup).join('')}
        </div>

        <div class="neoterra-player-grid">
            <section class="neoterra-player-card">
                <h5>Form</h5>
                <p>${escapeHtml(sheet.form.label)}</p>
                ${sheet.form.group ? `<p class="neoterra-hint">Group: ${escapeHtml(sheet.form.group)}</p>` : ''}
            </section>
            <section class="neoterra-player-card">
                <h5>${escapeHtml(sheet.labels.allegiance)}</h5>
                <p>${escapeHtml(sheet.allegiance)}</p>
            </section>
            <section class="neoterra-player-card">
                <h5>${escapeHtml(sheet.labels.corruption)}</h5>
                <p>Stage ${sheet.corruption.stage} — ${sheet.corruption.progress}%</p>
            </section>
            <section class="neoterra-player-card">
                <h5>Agenda</h5>
                <p>${escapeHtml(sheet.agenda || 'No agenda recorded.')}</p>
            </section>
        </div>

        <div class="neoterra-player-grid">
            <section class="neoterra-player-card">
                <h5>${escapeHtml(sheet.labels.skills)}</h5>
                ${listMarkup(sheet.skills)}
            </section>
            <section class="neoterra-player-card">
                <h5>Traits</h5>
                ${listMarkup(sheet.traits)}
            </section>
            <section class="neoterra-player-card">
                <h5>Injuries</h5>
                ${listMarkup(sheet.injuries)}
            </section>
            <section class="neoterra-player-card">
                <h5>Goals</h5>
                ${listMarkup(sheet.goals)}
            </section>
        </div>

        <section class="neoterra-player-card">
            <h5>${escapeHtml(sheet.labels.relationships)}</h5>
            ${relationshipsMarkup(sheet.relationships)}
        </section>

        ${editable ? `
        <form class="neoterra-player-edit" data-neoterra-player-edit>
            <h5>Manual sheet edit</h5>
            <p class="neoterra-hint">Manual edits are marked and protected from the next tracker pass.</p>
            <div class="neoterra-settings-grid">
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.stamina)} current</span>
                    <input type="number" min="0" step="1" data-neoterra-player-input="stamina.current"
                        value="${sheet.resources[0].current}">
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.stamina)} max</span>
                    <input type="number" min="1" step="1" data-neoterra-player-input="stamina.max"
                        value="${sheet.resources[0].max}">
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.willpower)} current</span>
                    <input type="number" min="0" step="1" data-neoterra-player-input="willpower.current"
                        value="${sheet.resources[1].current}">
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.willpower)} max</span>
                    <input type="number" min="1" step="1" data-neoterra-player-input="willpower.max"
                        value="${sheet.resources[1].max}">
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.status)}</span>
                    <select data-neoterra-player-input="status">${statusOptions}</select>
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.corruption)} stage</span>
                    <input type="number" min="0" step="1" data-neoterra-player-input="corruption.stage"
                        value="${sheet.corruption.stage}">
                </label>
                <label class="neoterra-field">
                    <span>${escapeHtml(sheet.labels.corruption)} progress</span>
                    <input type="number" min="0" max="100" step="1" data-neoterra-player-input="corruption.progress"
                        value="${sheet.corruption.progress}">
                </label>
                <label class="neoterra-field">
                    <span>Outfit</span>
                    <input type="text" data-neoterra-player-input="outfit"
                        value="${escapeHtml(sheet.outfit)}">
                </label>
                <label class="neoterra-field neoterra-field-wide">
                    <span>Skills (comma separated)</span>
                    <input type="text" data-neoterra-player-input="skills"
                        value="${escapeHtml(sheet.skills.join(', '))}">
                </label>
                <label class="neoterra-field neoterra-field-wide">
                    <span>Injuries (comma separated)</span>
                    <input type="text" data-neoterra-player-input="injuries"
                        value="${escapeHtml(sheet.injuries.join(', '))}">
                </label>
                <label class="neoterra-field neoterra-field-wide">
                    <span>Notes</span>
                    <textarea rows="2" data-neoterra-player-input="notes">${escapeHtml(sheet.notes)}</textarea>
                </label>
            </div>
            ${sheet.manualEditPaths.length > 0
                ? `<p class="neoterra-hint">Manual-protected: ${escapeHtml(sheet.manualEditPaths.join(', '))}</p>`
                : ''}
            <div class="neoterra-settings-actions">
                <button type="submit" class="menu_button neoterra-primary">Save manual edit</button>
            </div>
        </form>` : ''}
    </section>`;
}

function parseManualValue(path, raw) {
    if (path === 'skills' || path === 'injuries' || path === 'traits' || path === 'goals') {
        return String(raw ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }
    if (path === 'stamina.current' || path === 'stamina.max'
        || path === 'willpower.current' || path === 'willpower.max'
        || path === 'corruption.stage' || path === 'corruption.progress') {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
            throw new Error(`${path} requires a number`);
        }
        return number;
    }
    return String(raw ?? '');
}

function currentFieldValue(sheet, path) {
    if (path === 'stamina.current' || path === 'stamina.max') {
        return sheet.resources[0]?.[path === 'stamina.current' ? 'current' : 'max'];
    }
    if (path === 'willpower.current' || path === 'willpower.max') {
        return sheet.resources[1]?.[path === 'willpower.current' ? 'current' : 'max'];
    }
    if (path === 'status') {
        return sheet.statusChips[0]?.label ?? 'active';
    }
    if (path === 'corruption.stage') {
        return sheet.corruption.stage;
    }
    if (path === 'corruption.progress') {
        return sheet.corruption.progress;
    }
    if (path === 'skills') {
        return sheet.skills;
    }
    if (path === 'injuries') {
        return sheet.injuries;
    }
    if (path === 'traits') {
        return sheet.traits;
    }
    if (path === 'goals') {
        return sheet.goals;
    }
    if (path === 'outfit') {
        return sheet.outfit;
    }
    if (path === 'notes') {
        return sheet.notes;
    }
    return undefined;
}

function sameFieldValue(current, next) {
    if (Array.isArray(current) || Array.isArray(next)) {
        return JSON.stringify(asArray(current)) === JSON.stringify(asArray(next));
    }
    if (typeof current === 'number' || typeof next === 'number') {
        return Number(current) === Number(next);
    }
    return String(current ?? '') === String(next ?? '');
}

/**
 * Mount the sheet into a container (the Player tab panel). The caller owns the
 * store and may call `refresh()` after any state change.
 */
export function mountPlayerPanel({
    root,
    store,
    season = null,
    registry = null,
    ctx = null,
    onChange = null,
} = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountPlayerPanel requires a root element');
    }
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('mountPlayerPanel requires a WorldState store');
    }
    disposePlayerPanel();
    const controller = new AbortController();
    const state = {
        root,
        store,
        season,
        registry,
        onChange,
        controller,
        error: null,
    };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const snapshot = store.get();
        const sheet = buildPlayerSheet({ state: snapshot, season, registry });
        root.innerHTML = `
            ${state.error ? `<p class="neoterra-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
            ${renderPlayerPanelMarkup(sheet, { editable: Boolean(sheet) })}`;
    };

    root.addEventListener('submit', (event) => {
        if (!event.target.matches?.('[data-neoterra-player-edit]')) {
            return;
        }
        event.preventDefault();
        state.error = null;
        try {
            const sheet = buildPlayerSheet({ state: store.get(), season, registry });
            const inputs = [...root.querySelectorAll('[data-neoterra-player-input]')];
            let edits = 0;
            for (const input of inputs) {
                const path = input.dataset.neoterraPlayerInput;
                const value = parseManualValue(path, input.value);
                if (sameFieldValue(currentFieldValue(sheet, path), value)) {
                    continue;
                }
                applyManualPlayerEdit(store, {
                    path,
                    value,
                    reason: 'manual sheet edit',
                });
                edits += 1;
            }
            paint();
            if (edits > 0) {
                onChange?.(store.get());
            }
        } catch (error) {
            state.error = error?.message ?? String(error);
            logger.warn('Manual player edit failed', error);
            paint();
        }
    }, { signal: controller.signal });

    root.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-neoterra-player-refresh]')) {
            paint();
        }
    }, { signal: controller.signal });

    paint();
    void initAvatars({ registry, ctx }).then(() => paint()).catch(() => {});
    return {
        refresh: paint,
        getSheet: () => buildPlayerSheet({ state: store.get(), season, registry }),
    };
}

export function refreshPlayerPanel() {
    if (!mounted) {
        return null;
    }
    const snapshot = mounted.store.get();
    const sheet = buildPlayerSheet({
        state: snapshot,
        season: mounted.season,
        registry: mounted.registry,
    });
    mounted.root.innerHTML = renderPlayerPanelMarkup(sheet, { editable: Boolean(sheet) });
    return sheet;
}

export function disposePlayerPanel() {
    if (!mounted) {
        return;
    }
    mounted.controller?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
