/**
 * Journal and recap.
 *
 * The Journal is assembled deterministically from `WorldState`: recent events,
 * travel, beat changes, relationship notes, and newspaper headlines. When the
 * Lore agent has written a recap (`flags.lore.recap`), it replaces the
 * deterministic "previously on" paragraph; the fallback always produces text.
 *
 * Entry extraction is pure so dedupe and filtering can be tested in Node.
 */

import { createLogger } from '../core/logger.js';
import { buildPreviouslyOn as buildDeterministicRecap } from './session-home.js';

const logger = createLogger('journal');

const TYPE_LABELS = Object.freeze({
    event: 'Event',
    rumor: 'Rumor',
    travel: 'Travel',
    beat: 'Beat',
    relationship: 'Relationship',
    newspaper: 'Newspaper',
});

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function escapeJournalHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function locationName(state, id) {
    return state?.locations?.[id]?.name ?? id ?? 'Unknown';
}

function eventType(event) {
    const tags = asArray(event?.tags);
    return tags.includes('travel')
        ? 'travel'
        : (tags.includes('offscreen') || tags.includes('tick') || tags.includes('rumor') ? 'rumor' : 'event');
}

function pushEntry(entries, seen, entry) {
    if (!entry?.id || seen.has(entry.id)) {
        return;
    }
    seen.add(entry.id);
    entries.push(entry);
}

/** Recap paragraph: a Lore recap when present, the deterministic fallback otherwise. */
export function buildJournalRecap(state, season) {
    const recap = state?.flags?.lore?.recap;
    if (typeof recap === 'string' && recap.trim().length > 0) {
        return recap.trim();
    }
    return buildDeterministicRecap(state, season);
}

/**
 * Chronological journal entries. Sorting is stable on `turn` then insertion, and
 * every entry has a stable id so a re-render or a repeated MAP_UPDATED cannot
 * duplicate a line.
 */
export function buildJournalEntries(state, season = null) {
    const entries = [];
    const seen = new Set();

    asArray(state?.recentEvents).forEach((event, index) => {
        const summary = typeof event?.summary === 'string' ? event.summary.trim() : '';
        if (!summary) {
            return;
        }
        pushEntry(entries, seen, {
            id: `event:${event?.turn ?? index}:${summary}`,
            type: eventType(event),
            title: eventType(event) === 'rumor' ? 'Rumor' : 'World event',
            text: summary,
            turn: Number.isFinite(event?.turn) ? event.turn : null,
            date: event?.date ?? null,
            locationId: event?.locationId ?? null,
            actors: asArray(event?.actors),
            tags: asArray(event?.tags),
        });
    });

    asArray(state?.flags?.travel?.history).forEach((travel, index) => {
        if (!travel?.to) {
            return;
        }
        pushEntry(entries, seen, {
            id: `travel:${travel?.at ?? index}:${travel?.from ?? ''}:${travel.to}`,
            type: 'travel',
            title: 'Travel',
            text: `${locationName(state, travel.from)} → ${locationName(state, travel.to)}${travel.ability ? ` (${travel.ability})` : ''}`,
            turn: Number.isFinite(travel?.at) ? travel.at : null,
            date: null,
            locationId: travel.to,
            actors: [],
            tags: ['travel'],
        });
    });

    const seasonBeats = asArray(season?.canonBeats);
    for (const [beatId, record] of Object.entries(state?.beats ?? {})) {
        if (!isObject(record) || !['done', 'adapted', 'failed'].includes(record.status)) {
            continue;
        }
        const beat = seasonBeats.find((entry) => entry?.id === beatId) ?? null;
        pushEntry(entries, seen, {
            id: `beat:${beatId}:${record.status}`,
            type: 'beat',
            title: `Beat ${record.status}`,
            text: beat?.title ?? record.title ?? beatId,
            turn: Number.isFinite(record?.turn) ? record.turn : null,
            date: record?.date ?? null,
            locationId: null,
            act: beat?.act ?? record?.act ?? null,
            actors: asArray(record?.actors),
            tags: ['beat', record.status, ...(beat?.act ? [`act:${beat.act}`] : [])],
        });
    }

    for (const relationship of asArray(state?.relationships)) {
        asArray(relationship?.notes).forEach((note, index) => {
            const text = typeof note === 'string'
                ? note.trim()
                : (typeof note?.text === 'string' ? note.text.trim() : '');
            if (!text) {
                return;
            }
            pushEntry(entries, seen, {
                id: `relationship:${relationship?.a}:${relationship?.b}:${index}:${text}`,
                type: 'relationship',
                title: 'Relationship',
                text,
                turn: Number.isFinite(note?.turn) ? note.turn : null,
                date: null,
                locationId: null,
                actors: [relationship?.a, relationship?.b].filter(Boolean),
                tags: ['relationship', relationship?.type ?? 'neutral'],
            });
        });
    }

    asArray(state?.flags?.newsroom?.editions).forEach((edition) => {
        asArray(edition?.headlines).forEach((headline, index) => {
            const text = typeof headline === 'string' ? headline.trim() : '';
            if (!text) {
                return;
            }
            pushEntry(entries, seen, {
                id: `newspaper:${edition?.date ?? index}:${index}:${text}`,
                type: 'newspaper',
                title: 'Newspaper',
                text,
                turn: Number.isFinite(edition?.turn) ? edition.turn : null,
                date: edition?.date ?? null,
                locationId: null,
                actors: [],
                tags: ['newspaper'],
            });
        });
    });

    return entries
        .map((entry, index) => ({ ...entry, order: index }))
        .sort((a, b) => {
            const turnA = Number.isFinite(a.turn) ? a.turn : Number.POSITIVE_INFINITY;
            const turnB = Number.isFinite(b.turn) ? b.turn : Number.POSITIVE_INFINITY;
            if (turnA !== turnB) {
                return turnA - turnB;
            }
            return a.order - b.order;
        });
}

/** Filter by type, act, location, or a case-insensitive text query. */
export function filterJournalEntries(entries, {
    type = 'all',
    query = '',
    act = null,
    locationId = null,
} = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    return asArray(entries).filter((entry) => {
        if (type && type !== 'all' && entry.type !== type) {
            return false;
        }
        if (act) {
            // Only beat entries carry an act; world events stay visible so the
            // filter narrows the timeline instead of hiding all context.
            if (entry.type === 'beat' && entry.act !== act) {
                return false;
            }
        }
        if (locationId && entry.locationId && entry.locationId !== locationId) {
            return false;
        }
        if (needle) {
            const haystack = `${entry.title} ${entry.text} ${asArray(entry.tags).join(' ')}`.toLowerCase();
            if (!haystack.includes(needle)) {
                return false;
            }
        }
        return true;
    });
}

/** Markdown export for the current chat's journal. */
export function buildJournalMarkdown({ season = null, recap = '', entries = [] } = {}) {
    const title = season?.title ?? 'Neo Terra journal';
    const lines = [`# ${title}`, ''];
    if (recap) {
        lines.push('## Previously on', '', recap, '');
    }
    lines.push('## Timeline', '');
    for (const entry of asArray(entries)) {
        const when = [entry.turn !== null && Number.isFinite(entry.turn) ? `turn ${entry.turn}` : null, entry.date]
            .filter(Boolean)
            .join(' · ');
        lines.push(`- ${when ? `[${when}] ` : ''}**${entry.title}** — ${entry.text}`);
    }
    return `${lines.join('\n').trim()}\n`;
}

function renderEntry(entry) {
    const when = [
        Number.isFinite(entry.turn) ? `turn ${entry.turn}` : null,
        entry.date,
    ].filter(Boolean).join(' · ');
    return `
    <li class="neoterra-journal-entry" data-journal-entry="${escapeJournalHtml(entry.id)}" data-type="${escapeJournalHtml(entry.type)}">
        <div class="neoterra-journal-entry-head">
            <span class="neoterra-journal-type">${escapeJournalHtml(TYPE_LABELS[entry.type] ?? entry.type)}</span>
            <span class="neoterra-journal-turn">${escapeJournalHtml(when)}</span>
        </div>
        <p class="neoterra-journal-text">${escapeJournalHtml(entry.text)}</p>
    </li>`;
}

export function renderJournalMarkup({
    recap = '',
    entries = [],
    type = 'all',
    query = '',
    acts = [],
    locations = [],
    act = '',
    locationId = '',
} = {}) {
    const types = ['all', ...Object.keys(TYPE_LABELS)];
    return `
    <section class="neoterra-journal" data-neoterra-journal>
        <header class="neoterra-journal-head">
            <div>
                <h3>Journal</h3>
                <p class="neoterra-journal-recap" data-neoterra-journal-recap>${escapeJournalHtml(recap)}</p>
            </div>
            <button type="button" class="menu_button" data-neoterra-journal-export>Export recap</button>
        </header>
        <div class="neoterra-journal-toolbar">
            <label class="neoterra-field">
                <span>Search</span>
                <input type="search" data-neoterra-journal-search value="${escapeJournalHtml(query)}" placeholder="Search the timeline">
            </label>
            <label class="neoterra-field">
                <span>Act</span>
                <select data-neoterra-journal-act>
                    <option value="">All acts</option>
                    ${acts.map((value) => `<option value="${escapeJournalHtml(value)}" ${value === act ? 'selected' : ''}>${escapeJournalHtml(value)}</option>`).join('')}
                </select>
            </label>
            <label class="neoterra-field">
                <span>Location</span>
                <select data-neoterra-journal-location>
                    <option value="">All locations</option>
                    ${locations.map((entry) => `<option value="${escapeJournalHtml(entry.id)}" ${entry.id === locationId ? 'selected' : ''}>${escapeJournalHtml(entry.name)}</option>`).join('')}
                </select>
            </label>
            <div class="neoterra-journal-filters" role="group" aria-label="Journal filters">
                ${types.map((id) => `<button type="button" class="neoterra-journal-filter${id === type ? ' is-active' : ''}"
                    data-neoterra-journal-filter="${escapeJournalHtml(id)}">${escapeJournalHtml(TYPE_LABELS[id] ?? 'All')}</button>`).join('')}
            </div>
        </div>
        ${entries.length === 0
        ? '<p class="neoterra-empty">No journal entries yet. Travel, turns, and beat changes appear here.</p>'
        : `<ol class="neoterra-journal-list">${entries.map(renderEntry).join('')}</ol>`}
    </section>`;
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Mount the Journal into a window body. State is re-read on every refresh so a
 * turn or a chat switch cannot paint a stale timeline.
 */
export function mountJournal({
    root,
    getState,
    getSeason = () => null,
    getRecap = null,
    onClose = null,
} = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountJournal requires a root element');
    }
    const controller = new AbortController();
    let type = 'all';
    let query = '';
    let act = '';
    let locationId = '';

    const buildView = () => {
        const state = typeof getState === 'function' ? getState() : null;
        const season = typeof getSeason === 'function' ? getSeason() : null;
        const all = buildJournalEntries(state, season);
        const acts = [...new Set(all.map((entry) => entry.act).filter(Boolean))];
        const seenLocations = new Set();
        const locations = all
            .filter((entry) => entry.locationId && !seenLocations.has(entry.locationId))
            .map((entry) => {
                seenLocations.add(entry.locationId);
                return {
                    id: entry.locationId,
                    name: state?.locations?.[entry.locationId]?.name ?? entry.locationId,
                };
            });
        return {
            recap: typeof getRecap === 'function'
                ? getRecap(state, season)
                : buildJournalRecap(state, season),
            entries: filterJournalEntries(all, { type, query, act: act || null, locationId: locationId || null }),
            all,
            type,
            query,
            acts,
            locations,
            act,
            locationId,
        };
    };

    const paint = () => {
        if (typeof root.isConnected === 'boolean' && !root.isConnected) {
            return;
        }
        const searchFocused = typeof document !== 'undefined'
            && root.querySelector?.('[data-neoterra-journal-search]') === document.activeElement;
        try {
            root.innerHTML = renderJournalMarkup(buildView());
        } catch (error) {
            logger.warn('Could not render the journal', error);
            root.innerHTML = '<p class="neoterra-error" role="alert">The journal could not be rendered.</p>';
            return;
        }
        if (searchFocused) {
            const input = root.querySelector('[data-neoterra-journal-search]');
            input?.focus?.();
            const end = input?.value?.length ?? 0;
            input?.setSelectionRange?.(end, end);
        }
    };

    root.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-neoterra-journal-close]')) {
            onClose?.();
            return;
        }
        const filter = event.target.closest?.('[data-neoterra-journal-filter]')?.dataset.neoterraJournalFilter;
        if (filter) {
            type = filter;
            paint();
            return;
        }
        if (event.target.closest?.('[data-neoterra-journal-export]')) {
            const view = buildView();
            try {
                const blob = new Blob([buildJournalMarkdown({
                    season: getSeason?.(),
                    recap: view.recap,
                    entries: view.all,
                })], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = 'neoterra-journal.md';
                anchor.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                logger.warn('Could not export the journal', error);
            }
        }
    }, { signal: controller.signal });

    root.addEventListener('change', (event) => {
        const actSelect = event.target.closest?.('[data-neoterra-journal-act]');
        if (actSelect) {
            act = actSelect.value ?? '';
            paint();
            return;
        }
        const locationSelect = event.target.closest?.('[data-neoterra-journal-location]');
        if (locationSelect) {
            locationId = locationSelect.value ?? '';
            paint();
        }
    }, { signal: controller.signal });

    root.addEventListener('input', (event) => {
        const input = event.target.closest?.('[data-neoterra-journal-search]');
        if (!input) {
            return;
        }
        query = input.value ?? '';
        paint();
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
