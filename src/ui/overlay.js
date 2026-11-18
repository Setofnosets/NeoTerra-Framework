/**
 * Neo Terra world overlay and map node editor.
 *
 * Two halves, both renderer-agnostic:
 *
 * 1. The **overlay** answers "where am I in the story": active factions and
 *    goals, every main/secondary threat with a stage-labelled progress bar,
 *    the current act, the next canon beats as rumours, a divergence indicator,
 *    and newspaper-style headlines. The model is built by
 *    `buildWorldOverlay` in `src/data/map.js`.
 *
 * 2. The **editor** edits overrides, never the SVGs. Global edits target the
 *    authored overrides document (`data/map/overrides.json`) and are exported
 *    or imported as JSON; per-chat edits (a bridge destroyed in this timeline,
 *    a district captured, a new virtual node) live in `WorldState.flags.map`
 *    and `WorldState.locations`.
 */

import {
    BRIDGE_STATUSES,
    MAP_OVERRIDE_LAYERS,
    buildWorldOverlay,
    exportMapOverrides,
    getChatMapOverrides,
    parseMapOverrides,
    resetMapOverride,
    applyMapOverride,
    deleteMapOverride,
} from '../data/map.js';
import { LOCATION_STATUSES } from '../data/locations.js';

export const OVERLAY_HEADINGS = Object.freeze({
    act: 'Act',
    activity: 'Latest activity',
    threats: 'Threats',
    factions: 'Factions',
    rumors: 'Rumours',
    headlines: 'Headlines',
    offscreen: 'City Desk / Off-screen',
    divergence: 'Divergence',
    editor: 'Map editor',
});

export const EDITABLE_FEATURE_KINDS = Object.freeze([
    'region',
    'bridge',
    'keyLocation',
    'namedLocation',
]);

export function escapeOverlayHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function bar(percent, label = null) {
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    return `
        <div class="neoterra-overlay-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="${value}" aria-label="${escapeOverlayHtml(label ?? 'progress')}">
            <span class="neoterra-overlay-bar-fill" style="width:${value}%"></span>
        </div>`;
}

/** Faction list markup: name, side, influence bar, and goals. */
export function renderFactionOverlay(factions = []) {
    if (!Array.isArray(factions) || factions.length === 0) {
        return '<p class="neoterra-placeholder">No active factions.</p>';
    }
    return `
    <ul class="neoterra-overlay-factions">
        ${factions.map((faction) => `
        <li class="neoterra-overlay-faction" data-neoterra-overlay-faction="${escapeOverlayHtml(faction.id)}"
            data-neoterra-side="${escapeOverlayHtml(faction.side)}">
            <div class="neoterra-overlay-faction-head">
                <span class="neoterra-overlay-swatch" style="background:${escapeOverlayHtml(faction.color)}"></span>
                <strong>${escapeOverlayHtml(faction.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeOverlayHtml(faction.side)}</span>
                ${faction.dominant ? '<span class="neoterra-overlay-chip is-dominant">dominant</span>' : ''}
            </div>
            ${bar(faction.influence, `${faction.name} influence`)}
            ${faction.goals?.length
                ? `<ul class="neoterra-overlay-goals">${faction.goals.map((goal) => `<li>${escapeOverlayHtml(goal)}</li>`).join('')}</ul>`
                : ''}
        </li>`).join('')}
    </ul>`;
}

/** Threat list markup; renders every threat independently (S4 has two mains). */
export function renderThreatOverlay(threats = []) {
    if (!Array.isArray(threats) || threats.length === 0) {
        return '<p class="neoterra-placeholder">No active threats.</p>';
    }
    return `
    <ul class="neoterra-overlay-threats">
        ${threats.map((threat) => `
        <li class="neoterra-overlay-threat${threat.defeated ? ' is-defeated' : ''}"
            data-neoterra-overlay-threat="${escapeOverlayHtml(threat.id)}">
            <div class="neoterra-overlay-threat-head">
                <strong>${escapeOverlayHtml(threat.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeOverlayHtml(threat.rank)}</span>
                <span class="neoterra-overlay-chip is-stage">${escapeOverlayHtml(threat.stageLabel)}</span>
                <span class="neoterra-overlay-chip">${escapeOverlayHtml(threat.status)}</span>
            </div>
            ${bar(threat.progress, `${threat.name} progress`)}
            <p class="neoterra-overlay-threat-meta">
                Stage ${threat.stage + 1}/${threat.stageCount} · ${threat.progress}%
                ${threat.sourceFactionName ? ` · ${escapeOverlayHtml(threat.sourceFactionName)}` : ''}
            </p>
            ${threat.agenda ? `<p class="neoterra-overlay-agenda">${escapeOverlayHtml(threat.agenda)}</p>` : ''}
        </li>`).join('')}
    </ul>`;
}

/** Next beats as rumours plus the divergence indicator. */
export function renderBeatOverlay(beats = null) {
    if (!beats) {
        return '';
    }
    const rumors = Array.isArray(beats.rumors) ? beats.rumors : [];
    const divergence = beats.divergence ?? { hasDivergence: false, label: '', adapted: [], shortCircuited: [], deferred: [] };
    return `
    <div class="neoterra-overlay-beats" data-neoterra-overlay-act="${escapeOverlayHtml(beats.act ?? '')}">
        ${rumors.length === 0
            ? '<p class="neoterra-placeholder">No upcoming beats.</p>'
            : `<ul class="neoterra-overlay-rumors">${rumors.map((beat) => `
                <li data-neoterra-overlay-beat="${escapeOverlayHtml(beat.id)}" data-status="${escapeOverlayHtml(beat.status)}">
                    <em>${escapeOverlayHtml(beat.act ?? '')}</em>
                    <span>${escapeOverlayHtml(beat.title)}</span>
                </li>`).join('')}</ul>`}
        <p class="neoterra-overlay-divergence${divergence.hasDivergence ? ' is-divergent' : ''}"
            data-neoterra-overlay-divergence="${divergence.hasDivergence ? 'true' : 'false'}">
            ${escapeOverlayHtml(divergence.label)}
        </p>
        ${divergence.hasDivergence
            ? `<ul class="neoterra-overlay-divergence-list">
                ${(divergence.adapted ?? []).map((id) => `<li class="is-adapted">${escapeOverlayHtml(id)} · adapted</li>`).join('')}
                ${(divergence.shortCircuited ?? []).map((id) => `<li class="is-short-circuited">${escapeOverlayHtml(id)} · short-circuited</li>`).join('')}
                ${(divergence.deferred ?? []).map((id) => `<li class="is-deferred">${escapeOverlayHtml(id)} · deferred</li>`).join('')}
            </ul>`
            : ''}
    </div>`;
}

/** Latest activity per named location / key location (one line each). */
export function renderActivityOverlay(entries = []) {
    const notable = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.headline);
    if (notable.length === 0) {
        return '<p class="neoterra-placeholder">No activity recorded.</p>';
    }
    return `
    <ul class="neoterra-overlay-headlines">
        ${notable.slice(0, 6).map((entry) => `
        <li data-neoterra-overlay-activity="${escapeOverlayHtml(entry.id)}">
            <span class="neoterra-overlay-dateline">${entry.turn === null ? '—' : `T${escapeOverlayHtml(entry.turn)}`}</span>
            <span><strong>${escapeOverlayHtml(entry.name)}</strong> · ${escapeOverlayHtml(entry.headline)}</span>
        </li>`).join('')}
    </ul>`;
}

/** Newspaper-style headline strip. */
export function renderHeadlines(headlines = []) {
    if (!Array.isArray(headlines) || headlines.length === 0) {
        return '<p class="neoterra-placeholder">No headlines yet.</p>';
    }
    return `
    <ul class="neoterra-overlay-headlines">
        ${headlines.map((headline) => `
        <li data-neoterra-overlay-headline="${escapeOverlayHtml(headline.turn)}">
            <span class="neoterra-overlay-dateline">T${escapeOverlayHtml(headline.turn)}</span>
            <span>${escapeOverlayHtml(headline.headline)}</span>
        </li>`).join('')}
    </ul>`;
}

/**
 * Off-screen city activity: newest first. `text` is already content-gated; the
 * location controller is a labelled aside, never presented as the actor.
 */
export function renderOffscreenFeed(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return '';
    }
    return `
    <ul class="neoterra-overlay-offscreen">
        ${entries.map((entry) => `
        <li data-neoterra-overlay-offscreen="${escapeOverlayHtml(entry.id)}">
            <span class="neoterra-overlay-dateline">T${escapeOverlayHtml(entry.turn)}</span>
            <span>
                ${entry.factionName ? `<strong>${escapeOverlayHtml(entry.factionName)}</strong> — ` : ''}
                ${escapeOverlayHtml(entry.text ?? entry.headline)}
                ${entry.locationName ? `<span class="neoterra-overlay-offscreen-place">${escapeOverlayHtml(entry.locationName)}${entry.controlledByFactionName ? ` — controlled by ${escapeOverlayHtml(entry.controlledByFactionName)}` : ''}</span>` : ''}
            </span>
        </li>`).join('')}
    </ul>`;
}

/** The complete overlay markup. `model` comes from `buildWorldOverlay`. */
export function renderWorldOverlayMarkup(model, { collapsed = false } = {}) {
    if (!model?.hasWorld) {
        return `
        <section class="neoterra-overlay neoterra-overlay-empty" data-neoterra-overlay>
            <p class="neoterra-placeholder">Start a season to see factions, threats, and headlines.</p>
        </section>`;
    }
    return `
    <section class="neoterra-overlay${collapsed ? ' is-collapsed' : ''}" data-neoterra-overlay
        data-neoterra-overlay-collapsed="${collapsed ? 'true' : 'false'}">
        <header class="neoterra-overlay-header">
            <h4>${OVERLAY_HEADINGS.act}: ${escapeOverlayHtml(model.act ?? 'unknown')}</h4>
            <button type="button" class="neoterra-icon-button" data-neoterra-overlay-toggle
                aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="Toggle world overlay">▾</button>
        </header>
        <div class="neoterra-overlay-body" ${collapsed ? 'hidden' : ''}>
            <div class="neoterra-overlay-section" data-neoterra-overlay-section="threats">
                <h5>${OVERLAY_HEADINGS.threats}</h5>
                ${renderThreatOverlay(model.threats)}
            </div>
            <div class="neoterra-overlay-section" data-neoterra-overlay-section="factions">
                <h5>${OVERLAY_HEADINGS.factions}</h5>
                ${renderFactionOverlay(model.factions)}
            </div>
            <div class="neoterra-overlay-section" data-neoterra-overlay-section="beats">
                <h5>${OVERLAY_HEADINGS.rumors}</h5>
                ${renderBeatOverlay(model.beats)}
            </div>
            <div class="neoterra-overlay-section" data-neoterra-overlay-section="headlines">
                <h5>${OVERLAY_HEADINGS.headlines}</h5>
                ${renderHeadlines(model.headlines)}
            </div>
            ${Array.isArray(model.offscreen) && model.offscreen.length > 0
                ? `<div class="neoterra-overlay-section" data-neoterra-overlay-section="offscreen">
                <h5>${OVERLAY_HEADINGS.offscreen}</h5>
                ${renderOffscreenFeed(model.offscreen)}
            </div>`
                : ''}
            <div class="neoterra-overlay-section" data-neoterra-overlay-section="activity">
                <h5>${OVERLAY_HEADINGS.activity}</h5>
                ${renderActivityOverlay([...(model.keyActivity ?? []), ...(model.namedActivity ?? [])])}
            </div>
        </div>
    </section>`;
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

/**
 * Which override layer a selected map feature writes to.
 *
 * Presentation/assignment edits (name, description, parent district, faction)
 * are global; live timeline facts (a status change: destroyed bridge, captured
 * district) are per chat. Named locations are per chat by definition.
 */
export function overrideTargetFor(feature) {
    if (!feature) {
        return null;
    }
    if (feature.kind === 'region') {
        return { layer: 'regions', key: feature.label, scope: 'global', chatLayer: 'regions', chatKey: feature.label };
    }
    if (feature.kind === 'bridge') {
        return { layer: 'bridges', key: feature.label, scope: 'global', chatLayer: 'bridges', chatKey: feature.label };
    }
    if (feature.kind === 'keyLocation') {
        return { layer: 'keyLocations', key: feature.label, scope: 'global', chatLayer: 'keyLocations', chatKey: feature.label };
    }
    if (feature.kind === 'namedLocation') {
        return { layer: 'namedLocations', key: feature.id, scope: 'chat' };
    }
    return null;
}

/** True when the schema also accepts a per-chat `status` write. */
export function supportsChatStatus(schema) {
    return Boolean(schema && (schema.layer === 'bridges' || schema.layer === 'regions' || schema.layer === 'namedLocations'));
}

/**
 * Fields the editor shows for a feature. Global feature overrides carry a
 * presentation/assignment subset; named locations also accept a chat-only
 * marker move and status/control changes.
 */
export function buildEditorSchema(feature, { factions = [], districts = [], virtual = false } = {}) {
    const target = overrideTargetFor(feature);
    if (!target) {
        return null;
    }
    const fields = [
        { name: 'name', type: 'text', label: 'Name', value: feature.name ?? '' },
        { name: 'description', type: 'textarea', label: 'Description', value: feature.description ?? '' },
    ];
    if (target.layer === 'regions' || target.layer === 'keyLocations') {
        fields.push({
            name: 'factionId',
            type: 'select',
            label: 'Controlling faction',
            value: feature.factionId ?? '',
            options: [{ value: '', label: 'Unclaimed' }, ...factions.map((faction) => ({
                value: faction.id,
                label: faction.name,
            }))],
        });
    }
    if ((target.layer === 'regions' || target.layer === 'keyLocations') && Array.isArray(districts) && districts.length > 0) {
        fields.push({
            name: 'districtId',
            type: 'select',
            label: 'Parent district',
            value: feature.districtId ?? '',
            options: districts.map((district) => ({ value: district.id, label: district.name ?? district.id })),
        });
    }
    if (target.layer === 'bridges') {
        fields.push({
            name: 'status',
            type: 'select',
            label: 'Status',
            value: feature.status ?? 'open',
            options: BRIDGE_STATUSES.map((status) => ({ value: status, label: status })),
        });
    }
    if (target.layer === 'regions') {
        fields.push({
            name: 'status',
            type: 'select',
            label: 'Status',
            value: feature.status ?? '',
            options: [
                { value: '', label: 'Generated default' },
                { value: 'peaceful', label: 'peaceful' },
                { value: 'patrolled', label: 'patrolled' },
                { value: 'contested', label: 'contested' },
                { value: 'hostile', label: 'hostile' },
            ],
        });
    }
    if (target.layer === 'namedLocations') {
        fields.push({
            name: 'status',
            type: 'select',
            label: 'Status',
            value: feature.status ?? 'unknown',
            options: LOCATION_STATUSES.map((status) => ({ value: status, label: status })),
        }, {
            name: 'factionId',
            type: 'select',
            label: 'Controlling faction',
            value: feature.factionId ?? '',
            options: [{ value: '', label: 'Unclaimed' }, ...factions.map((faction) => ({
                value: faction.id,
                label: faction.name,
            }))],
        }, {
            name: 'x',
            type: 'number',
            label: 'Marker X',
            value: Number.isFinite(feature.x) ? feature.x : '',
            min: 0,
            max: 2048,
        }, {
            name: 'y',
            type: 'number',
            label: 'Marker Y',
            value: Number.isFinite(feature.y) ? feature.y : '',
            min: 0,
            max: 1536,
        });
    }
    if (virtual) {
        fields.push({
            name: 'connections',
            type: 'text',
            label: 'Connections (comma separated ids)',
            value: Array.isArray(feature.connections) ? feature.connections.join(', ') : '',
        });
    }
    return {
        ...target,
        title: feature.name ?? feature.label ?? feature.id,
        fields,
    };
}

export function renderEditorField(field) {
    const name = escapeOverlayHtml(field.name);
    if (field.type === 'select') {
        return `
        <label class="neoterra-editor-field">
            <span>${escapeOverlayHtml(field.label)}</span>
            <select data-neoterra-editor-field="${name}">
                ${(field.options ?? []).map((option) => `
                <option value="${escapeOverlayHtml(option.value)}"
                    ${String(option.value) === String(field.value ?? '') ? 'selected' : ''}>
                    ${escapeOverlayHtml(option.label)}
                </option>`).join('')}
            </select>
        </label>`;
    }
    if (field.type === 'textarea') {
        return `
        <label class="neoterra-editor-field">
            <span>${escapeOverlayHtml(field.label)}</span>
            <textarea rows="2" data-neoterra-editor-field="${name}">${escapeOverlayHtml(field.value ?? '')}</textarea>
        </label>`;
    }
    if (field.type === 'number') {
        return `
        <label class="neoterra-editor-field">
            <span>${escapeOverlayHtml(field.label)}</span>
            <input type="number" inputmode="numeric" data-neoterra-editor-field="${name}"
                value="${escapeOverlayHtml(field.value ?? '')}"
                ${Number.isFinite(field.min) ? `min="${field.min}"` : ''}
                ${Number.isFinite(field.max) ? `max="${field.max}"` : ''}>
        </label>`;
    }
    return `
    <label class="neoterra-editor-field">
        <span>${escapeOverlayHtml(field.label)}</span>
        <input type="text" data-neoterra-editor-field="${name}" value="${escapeOverlayHtml(field.value ?? '')}">
    </label>`;
}

/**
 * Editor markup for one selected feature, plus the global export/import and
 * the chat reset controls.
 */
export function renderMapEditor(schema, { globalOverrides = null, chat = null, virtual = false } = {}) {
    if (!schema) {
        return '';
    }
    const chatCount = chat
        ? Object.entries(chat).reduce((sum, [, layer]) => (
            layer && typeof layer === 'object' && !Array.isArray(layer) ? sum + Object.keys(layer).length : sum
        ), 0)
        : 0;
    return `
    <section class="neoterra-map-editor" data-neoterra-map-editor data-layer="${escapeOverlayHtml(schema.layer)}"
        data-key="${escapeOverlayHtml(schema.key)}" data-scope="${escapeOverlayHtml(schema.scope)}">
        <header>
            <h5>${OVERLAY_HEADINGS.editor} — ${escapeOverlayHtml(schema.title)}</h5>
            <span class="neoterra-overlay-chip">${escapeOverlayHtml(schema.layer)}</span>
        </header>
        <div class="neoterra-editor-fields">
            ${schema.fields.map(renderEditorField).join('')}
        </div>
        ${supportsChatStatus(schema)
            ? `<fieldset class="neoterra-editor-scope">
                <legend>Apply to</legend>
                <label class="neoterra-check">
                    <input type="radio" name="neoterra-editor-scope-${escapeOverlayHtml(schema.key)}"
                        value="chat" data-neoterra-editor-scope checked>
                    <span>This chat's timeline (status, marker)</span>
                </label>
                <label class="neoterra-check">
                    <input type="radio" name="neoterra-editor-scope-${escapeOverlayHtml(schema.key)}"
                        value="global" data-neoterra-editor-scope>
                    <span>Every chat (authored override)</span>
                </label>
            </fieldset>`
            : ''}
        <div class="neoterra-editor-actions">
            <button type="button" class="menu_button" data-neoterra-editor-save>Save override</button>
            <button type="button" class="menu_button" data-neoterra-editor-reset>Reset to default</button>
            <button type="button" class="menu_button" data-neoterra-editor-delete>Delete override</button>
        </div>
        <details class="neoterra-editor-advanced">
            <summary>Global overrides</summary>
            <p class="neoterra-hint">Global edits change every chat; export them to commit to
                <code>data/map/overrides.json</code>.</p>
            <div class="neoterra-editor-actions">
                <button type="button" class="menu_button" data-neoterra-editor-export>Export overrides</button>
                <button type="button" class="menu_button" data-neoterra-editor-import>Import overrides</button>
                <input type="file" accept="application/json,.json" data-neoterra-editor-import-input hidden>
            </div>
            <p class="neoterra-hint">${chatCount} per-chat override${chatCount === 1 ? '' : 's'} in this chat.</p>
            <div class="neoterra-editor-actions">
                <button type="button" class="menu_button" data-neoterra-editor-reset-chat>Reset this chat's map</button>
            </div>
        </details>
        ${virtual
            ? '<p class="neoterra-hint">Chat-only virtual node. It exists in this timeline only.</p>'
            : ''}
    </section>`;
}

/** Add-a-virtual-node form markup (chat-scoped). */
export function renderVirtualNodeForm({ defaultPoint = null } = {}) {
    const x = Number.isFinite(defaultPoint?.x) ? Math.round(defaultPoint.x) : 1024;
    const y = Number.isFinite(defaultPoint?.y) ? Math.round(defaultPoint.y) : 768;
    return `
    <details class="neoterra-map-add-node" data-neoterra-map-add-node>
        <summary>Add a virtual node</summary>
        <div class="neoterra-editor-fields">
            <label class="neoterra-editor-field">
                <span>Name</span>
                <input type="text" data-neoterra-node-field="name" value="">
            </label>
            <label class="neoterra-editor-field">
                <span>X</span>
                <input type="number" min="0" max="2048" data-neoterra-node-field="x" value="${x}">
            </label>
            <label class="neoterra-editor-field">
                <span>Y</span>
                <input type="number" min="0" max="1536" data-neoterra-node-field="y" value="${y}">
            </label>
            <label class="neoterra-editor-field">
                <span>Connections (comma separated ids)</span>
                <input type="text" data-neoterra-node-field="connections" value="">
            </label>
        </div>
        <div class="neoterra-editor-actions">
            <button type="button" class="menu_button" data-neoterra-node-add>Add node</button>
        </div>
    </details>`;
}

/* ------------------------------------------------------------------ *
 * Override parsing (UI-independent, unit-tested)
 * ------------------------------------------------------------------ */

function coerceFieldValue(field, raw) {
    if (field?.type === 'number') {
        const number = Number(raw);
        return Number.isFinite(number) ? number : null;
    }
    return String(raw ?? '').trim();
}

/**
 * Turn the editor form values into a patch for the selected target.
 * Unknown/disabled fields are dropped; empty strings clear authored values.
 */
export function editorValuesToPatch(schema, values = {}) {
    if (!schema) {
        return {};
    }
    const patch = {};
    for (const field of schema.fields) {
        if (!Object.hasOwn(values, field.name)) {
            continue;
        }
        const value = coerceFieldValue(field, values[field.name]);
        if (value === null && field.type === 'number') {
            continue;
        }
        if (field.name === 'connections') {
            patch.connections = String(value)
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            continue;
        }
        if (field.name === 'factionId' && value === '') {
            patch.factionId = null;
            continue;
        }
        if (field.name === 'districtId' && value === '') {
            // A region always belongs to a canonical district; clearing it is
            // not a valid edit.
            continue;
        }
        if (value === '' && (field.name === 'name' || field.name === 'description')) {
            // Clearing an authored field means "back to the generated label".
            patch[field.name] = null;
            continue;
        }
        if (value !== '') {
            patch[field.name] = value;
        }
    }
    return patch;
}

/**
 * Validate an editor patch against the feature's fields.
 * Returns `{ ok, patch, errors }`; the caller surfaces errors to the user.
 */
export function validateEditorPatch(schema, values = {}) {
    const patch = editorValuesToPatch(schema, values);
    const errors = [];
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'x' || key === 'y') {
            const max = key === 'x' ? 2048 : 1536;
            if (!Number.isFinite(value) || value < 0 || value > max) {
                errors.push({ field: key, message: `must be between 0 and ${max}` });
            }
        }
        if (key === 'status') {
            const allowed = schema.layer === 'bridges' ? BRIDGE_STATUSES : LOCATION_STATUSES;
            if (!allowed.includes(value)) {
                errors.push({ field: key, message: `must be one of ${allowed.join(', ')}` });
            }
        }
        if (key === 'name' && value === null) {
            errors.push({ field: key, message: 'a name is required' });
        }
    }
    return { ok: errors.length === 0, patch, errors };
}

/**
 * Apply a global editor patch to the overrides document (pure).
 * Throws for an unknown layer; validates with `parseMapOverrides` separately.
 */
export function applyEditorPatch(document, schema, values = {}) {
    const validation = validateEditorPatch(schema, values);
    if (!validation.ok) {
        return { ok: false, document, errors: validation.errors };
    }
    return {
        ok: true,
        document: applyMapOverride(document, {
            layer: schema.layer,
            label: schema.key,
            patch: validation.patch,
        }),
        errors: [],
    };
}

/** Reset one global override to its generated default (pure). */
export function resetEditorOverride(document, schema) {
    if (!schema || !MAP_OVERRIDE_LAYERS.includes(schema.layer)) {
        return { ok: false, document, error: 'unknown override target' };
    }
    return {
        ok: true,
        document: resetMapOverride(document, { layer: schema.layer, label: schema.key }),
        error: null,
    };
}

/** Delete one global override entirely (pure). */
export function deleteEditorOverride(document, schema) {
    if (!schema || !MAP_OVERRIDE_LAYERS.includes(schema.layer)) {
        return { ok: false, document, error: 'unknown override target' };
    }
    return {
        ok: true,
        document: deleteMapOverride(document, { layer: schema.layer, label: schema.key }),
        error: null,
    };
}

export { exportMapOverrides, parseMapOverrides, getChatMapOverrides, buildWorldOverlay };
