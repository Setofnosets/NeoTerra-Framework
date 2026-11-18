/**
 * In-world newspaper reader.
 *
 * The model and markup are pure and Node-safe. `mountNewspaperReader` is the
 * only DOM code: a modal dialog with an archive list, a keyboard focus trap,
 * and Escape-to-close. It never fetches and never writes state.
 */

import { buildNewspaperView } from '../data/newsroom.js';

export function escapeNewsHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/** Pure reader model: the visible edition plus the archive (newest first). */
export function buildNewsreaderModel(state, settings = {}, { activeId = null } = {}) {
    const view = buildNewspaperView(state, settings);
    const active = view.editions.find((edition) => edition.id === activeId) ?? view.latest ?? null;
    return {
        visible: view.enabled && view.hasNews,
        enabled: view.enabled,
        hasNews: view.hasNews,
        latest: view.latest,
        active,
        editions: view.editions,
        headlines: active?.headlines ?? [],
    };
}

function renderHeadline(headline) {
    return `
        <li class="neoterra-news-headline" data-neoterra-news-headline>
            <div class="neoterra-news-headline-head">
                <strong>${escapeNewsHtml(headline.title)}</strong>
                <span class="neoterra-overlay-chip">${escapeNewsHtml(headline.section)}</span>
                <span class="neoterra-overlay-chip">${escapeNewsHtml(headline.tone)}</span>
            </div>
            ${headline.lede ? `<p>${escapeNewsHtml(headline.lede)}</p>` : ''}
        </li>`;
}

/** Modal markup. Empty when the feature is off or nothing was published. */
export function renderNewsreaderMarkup(model) {
    if (!model?.visible || !model.active) {
        return '';
    }
    const edition = model.active;
    const archive = model.editions.map((entry) => `
        <li>
            <button type="button" class="neoterra-news-archive-entry${entry.id === edition.id ? ' is-active' : ''}"
                data-neoterra-news-edition="${escapeNewsHtml(entry.id)}"
                aria-current="${entry.id === edition.id ? 'true' : 'false'}">
                <span>${escapeNewsHtml(entry.masthead)}</span>
                <span class="neoterra-news-archive-date">${escapeNewsHtml(entry.date ?? `T${entry.turn}`)}</span>
            </button>
        </li>`).join('');
    return `
    <div class="neoterra-modal" data-neoterra-newspaper-modal>
        <div class="neoterra-modal-backdrop" data-neoterra-news-close></div>
        <section class="neoterra-newsreader" role="dialog" aria-modal="true" aria-labelledby="neoterra-news-title">
            <header class="neoterra-newsreader-head">
                <div>
                    <h3 id="neoterra-news-title">${escapeNewsHtml(edition.masthead)}</h3>
                    <p class="neoterra-newsreader-dateline">${escapeNewsHtml(edition.dateline)}</p>
                </div>
                <button type="button" class="neoterra-icon-button" data-neoterra-news-close
                    aria-label="Close the newspaper">&times;</button>
            </header>
            <div class="neoterra-newsreader-body">
                <nav class="neoterra-news-archive" aria-label="Editions">
                    <h4>Archive</h4>
                    <ul>${archive}</ul>
                </nav>
                <article class="neoterra-newsreader-article">
                    <ul class="neoterra-news-headlines">
                        ${(model.headlines ?? []).map(renderHeadline).join('')}
                    </ul>
                    <p class="neoterra-hint">${escapeNewsHtml(edition.source === 'agent' ? 'Reported by the city desk.' : 'Compiled from the city wire.')}</p>
                </article>
            </div>
        </section>
    </div>`;
}

/**
 * Mount the reader into a DOM host. Returns `{ refresh, dispose }`; `dispose`
 * is idempotent and restores focus to the previously active element.
 */
export function mountNewspaperReader({ root = null, getState, getSettings, onClose = null } = {}) {
    if (typeof document === 'undefined') {
        return { refresh: () => null, dispose: () => {} };
    }
    const host = root ?? document.body;
    if (!host) {
        return { refresh: () => null, dispose: () => {} };
    }
    const previousFocus = document.activeElement ?? null;
    const element = document.createElement('div');
    element.className = 'neoterra-newsreader-host';
    let activeId = null;
    let disposed = false;

    function model() {
        const state = typeof getState === 'function' ? getState() : null;
        const settings = typeof getSettings === 'function' ? getSettings() : {};
        const next = buildNewsreaderModel(state, settings, { activeId });
        activeId = next.active?.id ?? null;
        return next;
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = [...element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )].filter((node) => !node.disabled && node.offsetParent !== null);
        if (focusable.length === 0) {
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!element.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function close() {
        const callback = onClose;
        dispose();
        if (typeof callback === 'function') {
            try {
                callback();
            } catch {
                // A host close error must not leave the modal mounted.
            }
        }
    }

    function refresh() {
        if (disposed) {
            return null;
        }
        const next = model();
        const focusSelector = activeId
            ? `[data-neoterra-news-edition="${activeId}"]`
            : null;
        const hadFocus = element.contains?.(document.activeElement);
        element.innerHTML = renderNewsreaderMarkup(next);
        if (!next.visible) {
            close();
            return next;
        }
        const target = (focusSelector ? element.querySelector(focusSelector) : null)
            ?? (hadFocus ? element.querySelector('button, [href]') : null);
        target?.focus?.();
        return next;
    }

    function onClick(event) {
        if (event.target.closest?.('[data-neoterra-news-close]')) {
            close();
            return;
        }
        const entry = event.target.closest?.('[data-neoterra-news-edition]');
        if (entry) {
            activeId = entry.dataset.neoterraNewsEdition ?? null;
            refresh();
        }
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        element.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKeydown);
        element.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') {
            try {
                previousFocus.focus();
            } catch {
                // Focus restore is best effort.
            }
        }
    }

    element.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    host.appendChild(element);
    refresh();
    if (disposed) {
        // The model closed the reader during the initial paint; report absence
        // so the caller never stores a disposed handle.
        return null;
    }

    return { refresh, dispose };
}
