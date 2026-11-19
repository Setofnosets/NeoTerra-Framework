/**
 * Portrait-first character picker.
 *
 * A pure view model plus DOM mount used by the season identity step. The picker
 * shows a portrait, name, side, home season, form kind, and a form lineage
 * strip; it separates the canon roster from cross-season guests and requires an
 * explicit acknowledgement before a guest can be confirmed.
 */

import { avatarMarkup, avatarStripMarkup, initAvatars } from './avatar.js';

export function escapePickerHtml(value) {
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

function normalize(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function formMembers(registry, groupId) {
    if (!groupId) {
        return [];
    }
    return asArray(registry?.entries).filter((entry) => entry.formGroup === groupId && entry.bundle !== true);
}

function matchesQuery(entry, query) {
    if (!query) {
        return true;
    }
    const needle = normalize(query);
    return [entry.displayName, entry.dataName, ...(entry.aliases ?? [])]
        .some((value) => normalize(value).includes(needle));
}

/**
 * Build the picker view.
 *
 * @param {{
 *   registry: object,
 *   season: object,
 *   selectedId?: string|null,
 *   query?: string,
 *   side?: string,
 *   formKind?: string,
 *   allowGuests?: boolean,
 * }} [options]
 */
export function buildCharacterPickerView({
    registry = null,
    season = null,
    selectedId = null,
    query = '',
    side = 'all',
    formKind = 'all',
    allowGuests = false,
} = {}) {
    const rosterIds = new Set(asArray(season?.roster).map((member) => member.characterId));
    const sandbox = season?.allowAnyCharacter === true || season?.sandbox === true;
    const entries = asArray(registry?.entries).filter((entry) => entry && entry.bundle !== true);
    const filtered = entries.filter((entry) => {
        if (side !== 'all' && entry.side !== side) {
            return false;
        }
        if (formKind !== 'all' && entry.formKind !== formKind) {
            return false;
        }
        return matchesQuery(entry, query);
    });
    const toItem = (entry, section) => ({
        characterId: entry.id,
        displayName: entry.displayName ?? entry.dataName ?? entry.id,
        dataName: entry.dataName ?? '',
        aliases: asArray(entry.aliases),
        side: entry.side ?? 'neutral',
        homeSeasonId: entry.seasonId ?? null,
        formKind: entry.formKind ?? 'base',
        formGroup: entry.formGroup ?? null,
        formRole: entry.formRole ?? 'base',
        guest: section === 'guests',
        inRoster: rosterIds.has(entry.id),
        forms: formMembers(registry, entry.formGroup).map((member) => ({
            id: member.id,
            displayName: member.displayName,
            active: member.id === selectedId,
        })),
    });
    const canon = filtered
        .filter((entry) => rosterIds.has(entry.id))
        .map((entry) => toItem(entry, 'roster'));
    const guests = allowGuests
        ? filtered
            .filter((entry) => !rosterIds.has(entry.id) && entry.seasonId !== season?.id)
            .map((entry) => toItem(entry, 'guests'))
        : [];
    const other = filtered
        .filter((entry) => !rosterIds.has(entry.id) && (!allowGuests || entry.seasonId === season?.id))
        .map((entry) => toItem(entry, sandbox ? 'roster' : 'other'));

    const facets = {
        sides: [...new Set(entries.map((entry) => entry.side).filter(Boolean))].sort(),
        forms: [...new Set(entries.map((entry) => entry.formKind).filter(Boolean))].sort(),
    };

    return {
        seasonId: season?.id ?? null,
        selectedId,
        query,
        side,
        formKind,
        allowGuests,
        facets,
        sections: [
            { id: 'custom', label: 'Custom persona', items: [] },
            { id: 'roster', label: `Canon roster (${season?.id ?? 'season'})`, items: [...canon, ...other] },
            { id: 'guests', label: 'Other seasons (guests — warning required)', items: guests },
        ],
    };
}

function renderItem(item, selectedId) {
    const selected = item.characterId === selectedId;
    const forms = item.forms.length > 1
        ? `<span class="neoterra-picker-forms">${item.forms.map((form) => (
            `<span class="neoterra-picker-form${form.id === selectedId ? ' is-active' : ''}">${escapePickerHtml(form.displayName)}</span>`
        )).join('')}</span>`
        : '';
    return `<button type="button" class="neoterra-picker-card${selected ? ' is-selected' : ''}${item.guest ? ' is-guest' : ''}"
        data-neoterra-picker-select="${escapePickerHtml(item.characterId)}"
        data-guest="${item.guest ? 'true' : 'false'}"
        aria-pressed="${selected ? 'true' : 'false'}">
        <span class="neoterra-picker-portrait">${avatarMarkup(item.characterId, { size: 'md', name: item.displayName })}</span>
        <span class="neoterra-picker-body">
            <span class="neoterra-picker-name">${escapePickerHtml(item.displayName)}</span>
            <span class="neoterra-picker-meta">${escapePickerHtml(item.side)} · ${escapePickerHtml(item.homeSeasonId ?? 'unknown')} · ${escapePickerHtml(item.formKind)}</span>
            ${forms}
        </span>
        ${item.guest ? '<span class="neoterra-badge neoterra-badge-warning">Guest</span>' : ''}
    </button>`;
}

/** Pure markup for the picker. */
export function renderCharacterPickerMarkup(view) {
    if (!view) {
        return '<p class="neoterra-empty">No season selected.</p>';
    }
    const sections = view.sections.map((section) => {
        if (section.id === 'custom') {
            const customSelected = view.selectedId === 'custom';
            return `<section class="neoterra-picker-section" data-picker-section="custom">
                <button type="button" class="neoterra-picker-card neoterra-picker-custom${customSelected ? ' is-selected' : ''}"
                    data-neoterra-picker-select="custom" data-guest="false" aria-pressed="${customSelected ? 'true' : 'false'}">
                    <span class="neoterra-picker-portrait"><span class="neoterra-avatar neoterra-avatar-md"><span class="neoterra-avatar-fallback">YOU</span></span></span>
                    <span class="neoterra-picker-body">
                        <span class="neoterra-picker-name">Custom persona</span>
                        <span class="neoterra-picker-meta">Write your own persona</span>
                    </span>
                </button>
            </section>`;
        }
        if (section.items.length === 0) {
            return '';
        }
        return `<section class="neoterra-picker-section" data-picker-section="${escapePickerHtml(section.id)}">
            <h5>${escapePickerHtml(section.label)}</h5>
            <div class="neoterra-picker-grid">${section.items.map((item) => renderItem(item, view.selectedId)).join('')}</div>
        </section>`;
    }).join('');

    return `<div class="neoterra-character-picker" data-neoterra-character-picker>
        <div class="neoterra-picker-toolbar">
            <label class="neoterra-field">
                <span>Search</span>
                <input type="search" data-neoterra-picker-search value="${escapePickerHtml(view.query)}" placeholder="Name or alias">
            </label>
            <label class="neoterra-field">
                <span>Side</span>
                <select data-neoterra-picker-side>
                    <option value="all">All</option>
                    ${view.facets.sides.map((value) => `<option value="${escapePickerHtml(value)}" ${value === view.side ? 'selected' : ''}>${escapePickerHtml(value)}</option>`).join('')}
                </select>
            </label>
            <label class="neoterra-field">
                <span>Form</span>
                <select data-neoterra-picker-form>
                    <option value="all">All</option>
                    ${view.facets.forms.map((value) => `<option value="${escapePickerHtml(value)}" ${value === view.formKind ? 'selected' : ''}>${escapePickerHtml(value)}</option>`).join('')}
                </select>
            </label>
        </div>
        <div class="neoterra-picker-sections">${sections}</div>
    </div>`;
}

/**
 * Mount the picker into a container. Keyboard: arrows move, Enter selects,
 * Escape clears the query.
 */
export function mountCharacterPicker({
    root,
    registry = null,
    season = null,
    allowGuests = false,
    selectedId = null,
    onSelect = null,
    ctx = null,
} = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return null;
    }
    if (!root) {
        throw new TypeError('mountCharacterPicker requires a root element');
    }
    const controller = new AbortController();
    const state = {
        registry,
        season,
        allowGuests,
        selectedId: selectedId ?? 'custom',
        query: '',
        side: 'all',
        formKind: 'all',
        onSelect,
    };

    const buildView = () => buildCharacterPickerView({
        registry: state.registry,
        season: state.season,
        selectedId: state.selectedId,
        query: state.query,
        side: state.side,
        formKind: state.formKind,
        allowGuests: state.allowGuests,
    });

    const paint = () => {
        root.innerHTML = renderCharacterPickerMarkup(buildView());
        const input = root.querySelector('[data-neoterra-picker-search]');
        if (input && state.query) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
    };

    root.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-neoterra-picker-select]');
        if (!button) {
            return;
        }
        state.selectedId = button.dataset.neoterraPickerSelect;
        paint();
        onSelect?.(state.selectedId, { guest: button.dataset.guest === 'true' });
    }, { signal: controller.signal });

    root.addEventListener('input', (event) => {
        if (!event.target.matches?.('[data-neoterra-picker-search]')) {
            return;
        }
        state.query = event.target.value;
        paint();
    }, { signal: controller.signal });

    root.addEventListener('change', (event) => {
        if (event.target.matches?.('[data-neoterra-picker-side]')) {
            state.side = event.target.value;
            paint();
        } else if (event.target.matches?.('[data-neoterra-picker-form]')) {
            state.formKind = event.target.value;
            paint();
        }
    }, { signal: controller.signal });

    root.addEventListener('keydown', (event) => {
        const buttons = [...root.querySelectorAll('[data-neoterra-picker-select]')];
        if (buttons.length === 0) {
            return;
        }
        const index = buttons.findIndex((button) => button.dataset.neoterraPickerSelect === state.selectedId);
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            const next = buttons[Math.min(buttons.length - 1, index + 1)];
            next?.click?.();
            next?.focus?.();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            const previous = buttons[Math.max(0, index - 1)];
            previous?.click?.();
            previous?.focus?.();
        } else if (event.key === 'Escape') {
            state.query = '';
            paint();
        }
    }, { signal: controller.signal });

    void initAvatars({ registry, ctx }).then(() => paint()).catch(() => {});
    paint();
    return {
        root,
        getSelectedId: () => state.selectedId,
        refresh: paint,
        dispose: () => controller.abort(),
    };
}
