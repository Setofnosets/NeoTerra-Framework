/**
 * Scene-card decorator.
 *
 * Neo Terra scene frames are ordinary assistant messages. This module decorates
 * the rendered DOM with a header (kind, location, time, POV) and a present-cast
 * portrait strip without ever touching `message.mes`. Decorations are
 * idempotent, so a reload, a swipe, or a re-render cannot duplicate the header.
 *
 * Cinematic chat mode groups consecutive scene frames under a divider and hides
 * SillyTavern's own timestamp/avatar chrome for those frames only. User messages
 * and non-Neo-Terra messages are never touched.
 */

import { avatarStripMarkup } from './avatar.js';

const KIND_LABELS = Object.freeze({
    opening: 'Opening',
    travel: 'Arrival',
    encounter: 'Encounter',
    combat: 'Combat',
    resolution: 'Resolution',
    cut: 'Meanwhile',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function escapeSceneHtml(value) {
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

/**
 * Structured metadata for a scene frame. The builders attach it under
 * `extra.neoterra.scene.meta`; older frames fall back to the flat fields the
 * encounter writer already had (`locationId`, `participants`).
 */
export function buildSceneMeta({
    locationId = null,
    locationName = null,
    timeSlot = null,
    pov = null,
    present = null,
} = {}) {
    const ids = asArray(present).filter((id) => typeof id === 'string' && id.length > 0);
    return {
        location: locationId || locationName
            ? { id: locationId ?? null, name: locationName ?? null }
            : null,
        time: typeof timeSlot === 'string' && timeSlot.length > 0 ? timeSlot : null,
        pov: typeof pov === 'string' && pov.length > 0 ? pov : null,
        present: ids,
    };
}

/** Read the header model from a chat message, or null for a non-scene. */
export function extractSceneMeta(message) {
    const scene = message?.extra?.neoterra?.scene;
    if (!isObject(scene)) {
        return null;
    }
    const meta = isObject(scene.meta) ? scene.meta : {};
    const location = isObject(meta.location) ? meta.location : null;
    const locationId = location?.id ?? meta.locationId ?? scene.locationId ?? null;
    const locationName = location?.name ?? meta.locationName ?? null;
    const present = asArray(meta.present).length > 0
        ? asArray(meta.present)
        : asArray(scene.participants);
    const kind = typeof scene.kind === 'string' ? scene.kind : 'scene';
    return {
        kind,
        label: KIND_LABELS[kind] ?? 'Scene',
        key: typeof scene.key === 'string' ? scene.key : null,
        locationId,
        locationName,
        time: typeof meta.time === 'string' && meta.time.length > 0 ? meta.time : null,
        pov: typeof meta.pov === 'string' && meta.pov.length > 0 ? meta.pov : null,
        present: present.filter((id) => typeof id === 'string' && id.length > 0),
    };
}

/**
 * Consecutive scene frames become one visual run. A user or narrator message
 * between two frames splits the run; that is what keeps ordinary chat intact.
 */
export function buildSceneRuns(messages = []) {
    const runs = [];
    let current = null;
    asArray(messages).forEach((message, index) => {
        const meta = extractSceneMeta(message);
        if (!meta) {
            current = null;
            return;
        }
        if (!current || current.end !== index - 1) {
            current = { start: index, end: index, kind: meta.kind, key: meta.key };
            runs.push(current);
            return;
        }
        current.end = index;
    });
    return runs;
}

function badge(text, className = '') {
    if (!text) {
        return '';
    }
    return `<span class="neoterra-scene-badge${className ? ` ${className}` : ''}">${escapeSceneHtml(text)}</span>`;
}

/** Pure header markup for a scene frame. */
export function renderSceneHeader(model) {
    if (!model) {
        return '';
    }
    const location = model.locationName
        ?? model.locationId
        ?? 'Unknown location';
    const portraits = model.present.length > 0
        ? avatarStripMarkup(model.present, { size: 'sm', className: 'neoterra-scene-strip' })
        : '';
    return `
    <div class="neoterra-scene-card-header" data-neoterra-scene-card="${escapeSceneHtml(model.kind)}">
        <div class="neoterra-scene-heading">
            ${badge(model.label, 'neoterra-scene-kind')}
            ${badge(location, 'neoterra-scene-location')}
            ${badge(model.time, 'neoterra-scene-when')}
            ${badge(model.pov ? `POV ${model.pov}` : null, 'neoterra-scene-pov')}
        </div>
        ${portraits}
    </div>`;
}

/**
 * Decorate one rendered message element. Idempotent: a second call is a no-op
 * because the header carries the marker attribute.
 */
export function decorateSceneElement(element, model, { cinematic = true } = {}) {
    if (!element || !model) {
        return false;
    }
    if (element.dataset?.neoterraSceneCard === 'true') {
        return false;
    }
    try {
        element.insertAdjacentHTML?.('afterbegin', renderSceneHeader(model));
    } catch {
        return false;
    }
    if (element.dataset) {
        element.dataset.neoterraSceneCard = 'true';
    }
    element.classList?.add?.('neoterra-scene-card');
    element.classList?.add?.('neoterra-scene-message');
    if (cinematic) {
        element.classList?.add?.('neoterra-cinematic-frame');
    } else {
        element.classList?.remove?.('neoterra-cinematic-frame');
    }
    return true;
}

function dividerFor(run) {
    const label = KIND_LABELS[run.kind] ?? 'Scene';
    return `<span class="neoterra-scene-divider-label">${escapeSceneHtml(label)}</span>`;
}

/**
 * Decorate every rendered scene frame for the current chat and add one divider
 * before each run. `root` is ST's `#chat` (or any container with `.mes[mesid]`).
 * Never throws on partial DOMs.
 */
export function applySceneDecorations({
    root = null,
    messages = [],
    cinematic = true,
    doc = typeof document !== 'undefined' ? document : null,
} = {}) {
    if (!root || typeof root.querySelector !== 'function') {
        return { decorated: 0, runs: [] };
    }
    try {
        root.classList?.toggle?.('neoterra-cinematic', cinematic === true);
        for (const divider of [...(root.querySelectorAll?.('.neoterra-scene-divider') ?? [])]) {
            divider.remove?.();
        }
        const runs = buildSceneRuns(messages);
        let decorated = 0;
        for (const run of runs) {
            const start = root.querySelector?.(`.mes[mesid="${run.start}"]`);
            if (start && doc?.createElement) {
                const divider = doc.createElement('div');
                divider.className = 'neoterra-scene-divider';
                divider.dataset.neoterraSceneDivider = String(run.start);
                divider.innerHTML = dividerFor(run);
                start.parentNode?.insertBefore?.(divider, start);
            }
            for (let index = run.start; index <= run.end; index += 1) {
                const element = root.querySelector?.(`.mes[mesid="${index}"]`);
                const model = extractSceneMeta(messages[index]);
                if (decorateSceneElement(element, model, { cinematic })) {
                    decorated += 1;
                }
            }
        }
        return { decorated, runs };
    } catch {
        return { decorated: 0, runs: [] };
    }
}
