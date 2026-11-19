/**
 * Gameplay command palette.
 *
 * `/neoterra` (or the palette entry point) opens a keyboard-first launcher for
 * gameplay actions only. Settings, export/import, and agent configuration stay
 * in the Extensions drawer; the palette never exposes them.
 */

export const PALETTE_ACTIONS = Object.freeze([
    { id: 'travel', label: 'Travel', words: 'map move district bridge location', command: '/neoterra map' },
    { id: 'cast', label: 'Cast', words: 'characters codex people', command: '/neoterra characters' },
    { id: 'player', label: 'Player', words: 'sheet stamina willpower corruption', command: '/neoterra player' },
    { id: 'journal', label: 'Journal', words: 'recap timeline log journal', command: '/neoterra journal' },
    { id: 'rest', label: 'Rest', words: 'downtime recover sleep', command: '/neoterra downtime rest' },
    { id: 'train', label: 'Train', words: 'downtime practice body will', command: '/neoterra downtime train' },
    { id: 'patrol', label: 'Patrol', words: 'downtime watch wander', command: '/neoterra downtime patrol' },
    { id: 'investigate', label: 'Investigate', words: 'downtime lead clues search', command: '/neoterra downtime investigate' },
    { id: 'socialize', label: 'Socialize', words: 'downtime people civilian talk', command: '/neoterra downtime socialize' },
    { id: 'work', label: 'Work', words: 'downtime shift job civilian', command: '/neoterra downtime work' },
    { id: 'newspaper', label: 'Newspaper', words: 'news paper headlines', command: '/neoterra newspaper' },
    { id: 'new-timeline', label: 'New timeline', words: 'new chat restart season', command: '/neoterra new-timeline' },
]);

export function escapePaletteHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Ranked filtering: a label prefix beats a label match, which beats a keyword
 * match. An empty query returns the authored order.
 */
export function filterPaletteActions(query, actions = PALETTE_ACTIONS) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) {
        return [...actions];
    }
    return actions
        .map((action) => {
            const label = action.label.toLowerCase();
            const words = `${label} ${action.words ?? ''} ${action.command ?? ''}`.toLowerCase();
            let score = -1;
            if (label.startsWith(needle)) {
                score = 3;
            } else if (label.includes(needle)) {
                score = 2;
            } else if (words.includes(needle)) {
                score = 1;
            }
            return { action, score };
        })
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.action);
}

export function renderPaletteMarkup(results, { selectedIndex = 0, query = '' } = {}) {
    const items = results.length === 0
        ? '<p class="neoterra-empty">No matching action.</p>'
        : results.map((action, index) => `
            <button type="button" class="neoterra-palette-item${index === selectedIndex ? ' is-selected' : ''}"
                data-neoterra-palette-action="${escapePaletteHtml(action.id)}"
                aria-selected="${index === selectedIndex ? 'true' : 'false'}">
                <span class="neoterra-palette-label">${escapePaletteHtml(action.label)}</span>
                <span class="neoterra-palette-command">${escapePaletteHtml(action.command ?? '')}</span>
            </button>`).join('');
    return `
    <div class="neoterra-command-palette" data-neoterra-command-palette role="dialog"
        aria-modal="true" aria-label="Neo Terra command palette">
        <div class="neoterra-palette-backdrop" data-neoterra-palette-close></div>
        <section class="neoterra-palette-panel">
            <label class="neoterra-palette-search">
                <span class="neoterra-visually-hidden">Search gameplay actions</span>
                <input type="search" data-neoterra-palette-input autocomplete="off"
                    placeholder="Travel, Cast, Journal, Rest…" value="${escapePaletteHtml(query)}">
            </label>
            <div class="neoterra-palette-results" data-neoterra-palette-results>${items}</div>
        </section>
    </div>`;
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Mount a single palette overlay. Arrow keys move, Enter runs, Escape closes.
 * The returned controller can be disposed by a chat switch or the shell teardown.
 */
export function mountCommandPalette({ onAction = null, onClose = null } = {}) {
    if (!hasDom()) {
        return null;
    }
    document.getElementById('neoterra-command-palette')?.remove();
    let query = '';
    let results = filterPaletteActions(query);
    let selectedIndex = 0;

    const wrapper = document.createElement('div');
    wrapper.id = 'neoterra-command-palette';
    document.body.append(wrapper);

    const paint = () => {
        wrapper.innerHTML = renderPaletteMarkup(results, { selectedIndex, query });
        const input = wrapper.querySelector('[data-neoterra-palette-input]');
        if (input && input.value !== query) {
            input.value = query;
        }
        input?.focus?.();
    };

    const select = (id) => {
        const action = PALETTE_ACTIONS.find((entry) => entry.id === id);
        if (!action) {
            return;
        }
        close();
        try {
            onAction?.(action);
        } catch (error) {
            console.warn('[Neo Terra] Palette action failed', error);
        }
    };

    const close = () => {
        wrapper.remove();
        document.removeEventListener('keydown', onKeydown, true);
        onClose?.();
    };

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, Math.max(0, results.length - 1));
            paint();
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            paint();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const action = results[selectedIndex];
            if (action) {
                select(action.id);
            }
        }
    }

    wrapper.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-neoterra-palette-close]')) {
            close();
            return;
        }
        const id = event.target.closest?.('[data-neoterra-palette-action]')?.dataset.neoterraPaletteAction;
        if (id) {
            select(id);
        }
    });
    wrapper.addEventListener('input', (event) => {
        if (!event.target.closest?.('[data-neoterra-palette-input]')) {
            return;
        }
        query = event.target.value ?? '';
        results = filterPaletteActions(query);
        selectedIndex = 0;
        paint();
    });
    document.addEventListener('keydown', onKeydown, true);

    paint();
    return {
        element: wrapper,
        getQuery: () => query,
        getResults: () => [...results],
        close,
        dispose: close,
    };
}
