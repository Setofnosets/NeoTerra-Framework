/**
 * State-delta toasts.
 *
 * `diffWorldState(before, after)` is pure and produces at most one batched toast
 * per meaningful delta, so a turn cannot spam the chat. The mount creates a
 * small stack near the bottom-left, auto-dismisses entries, and never blocks
 * the input.
 */

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function playerView(state) {
    const player = state?.player ?? null;
    const character = player?.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    return { player, character, role: character ?? player ?? null };
}

function characterName(state, id) {
    return state?.characters?.[id]?.displayName ?? state?.characters?.[id]?.name ?? id;
}

function meterToast({ id, label, before, after, max, tone = 'info' }) {
    const from = Number(before?.current ?? before ?? 0);
    const to = Number(after?.current ?? after ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
        return null;
    }
    const limit = Number(max ?? after?.max ?? before?.max ?? 0);
    return {
        id: `resource:${id}`,
        type: 'resource',
        title: label,
        message: `${from}${limit ? `/${limit}` : ''} → ${to}${limit ? `/${limit}` : ''}`,
        tone: to < from ? 'warning' : 'info',
    };
}

function newEvents(before, after) {
    const previous = new Set(asArray(before?.recentEvents).map((event) => `${event?.turn ?? ''}:${event?.summary ?? ''}`));
    return asArray(after?.recentEvents)
        .filter((event) => !previous.has(`${event?.turn ?? ''}:${event?.summary ?? ''}`))
        .filter((event) => typeof event?.summary === 'string' && event.summary.trim().length > 0);
}

function isRumor(event) {
    const tags = asArray(event?.tags);
    return tags.includes('offscreen') || tags.includes('tick') || tags.includes('rumor');
}

/**
 * Batched deltas for one turn: meters, corruption, rumors, cast changes, form
 * changes, relationship changes, and a new newspaper edition.
 */
export function diffWorldState(before, after) {
    const toasts = [];
    if (!isObject(before) || !isObject(after)) {
        return toasts;
    }
    const prev = playerView(before);
    const next = playerView(after);
    const prevRole = prev.role ?? {};
    const nextRole = next.role ?? {};

    for (const [id, label] of [['stamina', 'Stamina'], ['willpower', 'Willpower']]) {
        const toast = meterToast({
            id,
            label,
            before: prevRole[id],
            after: nextRole[id],
            max: nextRole[id]?.max ?? prevRole[id]?.max,
        });
        if (toast) {
            toasts.push(toast);
        }
    }

    const prevCorruption = prevRole.corruption ?? {};
    const nextCorruption = nextRole.corruption ?? {};
    if (prevCorruption.stage !== nextCorruption.stage
        || prevCorruption.progress !== nextCorruption.progress) {
        toasts.push({
            id: 'corruption',
            type: 'corruption',
            title: 'Corruption',
            message: `stage ${nextCorruption.stage ?? 0} · ${nextCorruption.progress ?? 0}%`,
            tone: Number(nextCorruption.stage ?? 0) > Number(prevCorruption.stage ?? 0) ? 'danger' : 'info',
        });
    }

    for (const event of newEvents(before, after)) {
        toasts.push({
            id: `event:${event.turn ?? ''}:${event.summary}`,
            type: isRumor(event) ? 'rumor' : 'event',
            title: isRumor(event) ? 'New rumor' : 'World event',
            message: String(event.summary).trim(),
            tone: 'info',
        });
    }

    const beforePresent = new Set(asArray(before?.scene?.present));
    const afterPresent = new Set(asArray(after?.scene?.present));
    for (const id of afterPresent) {
        if (!beforePresent.has(id)) {
            toasts.push({
                id: `arrival:${id}`,
                type: 'cast-arrival',
                title: 'Arrival',
                message: `${characterName(after, id)} joins the scene`,
                tone: 'info',
            });
        }
    }
    for (const id of beforePresent) {
        if (!afterPresent.has(id)) {
            toasts.push({
                id: `departure:${id}`,
                type: 'cast-departure',
                title: 'Departure',
                message: `${characterName(before, id)} leaves the scene`,
                tone: 'info',
            });
        }
    }

    for (const [id, character] of Object.entries(after?.characters ?? {})) {
        const previous = before?.characters?.[id];
        if (!previous) {
            continue;
        }
        if (previous.formId && character?.formId && previous.formId !== character.formId) {
            toasts.push({
                id: `form:${id}`,
                type: 'form',
                title: 'Form change',
                message: `${previous.displayName ?? character.displayName ?? id} → ${character.formId}`,
                tone: 'warning',
            });
        }
    }

    for (const relationship of asArray(after?.relationships)) {
        const previous = asArray(before?.relationships).find((entry) => entry?.a === relationship?.a && entry?.b === relationship?.b);
        if (!previous) {
            continue;
        }
        const changed = previous.type !== relationship.type
            || Number(previous.affinity) !== Number(relationship.affinity)
            || Number(previous.tension) !== Number(relationship.tension);
        if (!changed) {
            continue;
        }
        toasts.push({
            id: `relationship:${relationship.a}:${relationship.b}`,
            type: 'relationship',
            title: 'Relationship',
            message: `${characterName(after, relationship.a)} & ${characterName(after, relationship.b)} · ${relationship.type ?? 'neutral'}`,
            tone: 'info',
        });
    }

    const previousEditions = new Set(asArray(before?.flags?.newsroom?.editions).map((edition) => edition?.date));
    for (const edition of asArray(after?.flags?.newsroom?.editions)) {
        if (edition?.date && !previousEditions.has(edition.date)) {
            toasts.push({
                id: `newspaper:${edition.date}`,
                type: 'newspaper',
                title: 'New edition',
                message: `The city desk published ${edition.date}`,
                tone: 'info',
            });
        }
    }

    return toasts;
}

/** Error toasts are separate: the turn still completed, but a stage failed. */
export function buildErrorToasts(errors = [], { detailsHref = null } = {}) {
    return asArray(errors).map((error, index) => ({
        id: `error:${error?.stage ?? index}:${error?.error ?? ''}`,
        type: 'error',
        title: 'Agent error',
        message: `${error?.stage ?? 'agent'}: ${error?.error ?? 'failed'}`,
        tone: 'danger',
        href: detailsHref,
    }));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function renderToastMarkup(toast) {
    if (!toast) {
        return '';
    }
    const link = toast.href
        ? ` <a class="neoterra-toast-details" href="${escapeHtml(toast.href)}">details</a>`
        : '';
    return `
    <div class="neoterra-toast" data-neoterra-toast="${escapeHtml(toast.id)}"
        data-tone="${escapeHtml(toast.tone ?? 'info')}" role="status">
        <span class="neoterra-toast-title">${escapeHtml(toast.title)}</span>
        <span class="neoterra-toast-message">${escapeHtml(toast.message)}${link}</span>
    </div>`;
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/** Mount a toast stack; `push` batches by id and caps the visible entries. */
export function mountToasts({ host = null, max = 5, ttlMs = 6500 } = {}) {
    if (!hasDom()) {
        return null;
    }
    const container = document.createElement('div');
    container.className = 'neoterra-toasts';
    container.id = 'neoterra-toasts';
    (host ?? document.body).append(container);
    let dispose = false;

    const push = (toasts = []) => {
        if (dispose) {
            return 0;
        }
        let shown = 0;
        const existing = new Set(
            [...(container.querySelectorAll?.('[data-neoterra-toast]') ?? [])]
                .map((element) => element.dataset.neoterraToast),
        );
        for (const toast of asArray(toasts)) {
            if (!toast || existing.has(toast.id)) {
                continue;
            }
            existing.add(toast.id);
            container.insertAdjacentHTML('beforeend', renderToastMarkup(toast));
            const element = container.lastElementChild;
            setTimeout(() => element?.remove?.(), ttlMs);
            shown += 1;
            if (container.children.length > max) {
                container.firstElementChild?.remove?.();
            }
        }
        return shown;
    };

    return {
        container,
        push,
        dispose: () => {
            dispose = true;
            container.remove?.();
        },
    };
}
