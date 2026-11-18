/**
 * Relations tab: an SVG relationship graph plus detail list.
 *
 * The model (`relationship-graph.js`) is pure. This module owns markup,
 * filters, hover/selection, and the DOM lifecycle. It never dispatches world
 * events and never posts to chat.
 */

import { EVENTS, bus } from '../core/events.js';
import {
    RELATIONSHIP_SIDES,
    RELATIONSHIP_TYPES,
    buildRelationshipGraph,
    relationshipsForNode,
} from './relationship-graph.js';

export function escapeRelationshipHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

const DEFAULT_FILTERS = Object.freeze({
    presentOnly: false,
    side: 'all',
    type: 'all',
    minAffinity: null,
});

export function renderRelationshipFilters(filters = DEFAULT_FILTERS, { types = RELATIONSHIP_TYPES } = {}) {
    const typeOptions = ['all', ...types].map((type) => `
        <option value="${escapeRelationshipHtml(type)}"${filters.type === type ? ' selected' : ''}>
            ${escapeRelationshipHtml(type === 'all' ? 'All types' : type)}
        </option>`).join('');
    const sideOptions = ['all', ...RELATIONSHIP_SIDES].map((side) => `
        <option value="${escapeRelationshipHtml(side)}"${filters.side === side ? ' selected' : ''}>
            ${escapeRelationshipHtml(side === 'all' ? 'All sides' : side)}
        </option>`).join('');
    return `
        <div class="neoterra-relations-filters" role="group" aria-label="Graph filters">
            <label class="neoterra-check">
                <input type="checkbox" data-neoterra-graph-filter="presentOnly"
                    ${filters.presentOnly ? 'checked' : ''}>
                <span>Present only</span>
            </label>
            <label class="neoterra-field">
                <span>Side</span>
                <select data-neoterra-graph-filter="side">${sideOptions}</select>
            </label>
            <label class="neoterra-field">
                <span>Relationship</span>
                <select data-neoterra-graph-filter="type">${typeOptions}</select>
            </label>
            <label class="neoterra-field">
                <span>Min affinity</span>
                <input type="number" min="-100" max="100" step="5"
                    data-neoterra-graph-filter="minAffinity"
                    value="${filters.minAffinity === null || filters.minAffinity === undefined ? '' : Number(filters.minAffinity)}">
            </label>
        </div>`;
}

function renderLegend(legend) {
    return (legend ?? []).map((entry) => `
        <li class="neoterra-graph-legend-item${entry.dashed ? ' is-dashed' : ''}">
            <span class="neoterra-graph-legend-line" style="--nt-graph-edge:${entry.color}"></span>
            <span>${escapeRelationshipHtml(entry.label)}${entry.directed ? ' (directed)' : ''}</span>
        </li>`).join('');
}

/** SVG markup for a built graph model. Pure and testable. */
export function renderRelationshipGraphSvg(graph) {
    if (!graph || graph.empty || graph.nodes.length === 0) {
        return '';
    }
    const { width, height } = graph.bounds;
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const edges = graph.edges.map((edge) => {
        const from = nodesById.get(edge.a);
        const to = nodesById.get(edge.b);
        if (!from || !to) {
            return '';
        }
        // Trim to the node edge so the arrowhead is visible instead of being
        // painted underneath the target circle.
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.hypot(dx, dy) || 1;
        const ux = dx / distance;
        const uy = dy / distance;
        const startPad = from.r + 1;
        const endPad = to.r + (edge.directed ? 5 : 1);
        const x1 = from.x + ux * startPad;
        const y1 = from.y + uy * startPad;
        const x2 = to.x - ux * endPad;
        const y2 = to.y - uy * endPad;
        const dash = edge.dashed ? ' stroke-dasharray="6 5"' : '';
        const marker = edge.directed ? ' marker-end="url(#neoterra-rel-arrowhead)"' : '';
        return `<line class="neoterra-graph-edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"
            x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
            stroke="${edge.color}" stroke-width="${edge.width}"${dash}${marker}
            data-neoterra-graph-edge="${escapeRelationshipHtml(`${edge.a}::${edge.b}`)}"></line>`;
    }).join('');

    const nodes = graph.nodes.map((node) => {
        const classes = [
            'neoterra-graph-node',
            `is-side-${escapeRelationshipHtml(node.side)}`,
            node.isPlayer ? 'is-player' : '',
            node.isPresent ? 'is-present' : '',
        ].filter(Boolean).join(' ');
        const label = node.labelVisible
            ? `<text class="neoterra-graph-label" x="${node.x.toFixed(1)}"
                y="${(node.y + node.r + 13).toFixed(1)}" text-anchor="middle">${escapeRelationshipHtml(node.name)}</text>`
            : '';
        const badges = [
            node.corruptionStage > 0 ? `<tspan class="neoterra-graph-badge"> ⚠</tspan>` : '',
            node.badEnd ? `<tspan class="neoterra-graph-badge is-bad-end"> ✖</tspan>` : '',
        ].join('');
        return `<g class="${classes}" role="button" tabindex="0"
            data-neoterra-graph-node="${escapeRelationshipHtml(node.id)}"
            aria-label="${escapeRelationshipHtml(`${node.name}${node.isPlayer ? ', the player' : ''}`)}">
            <circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r}"></circle>
            ${label}${badges ? `<text x="${node.x.toFixed(1)}" y="${(node.y + 4).toFixed(1)}" text-anchor="middle">${badges}</text>` : ''}
        </g>`;
    }).join('');

    return `
    <svg class="neoterra-graph-svg" viewBox="0 0 ${width} ${height}" role="group"
        aria-label="Relationship graph" data-neoterra-graph-svg>
        <defs>
            <marker id="neoterra-rel-arrowhead" viewBox="0 0 10 10" refX="10" refY="5"
                markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8"
                orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
            </marker>
        </defs>
        <g class="neoterra-graph-edges">${edges}</g>
        <g class="neoterra-graph-nodes">${nodes}</g>
    </svg>`;
}

function renderDetail(graph, selectedId) {
    if (!selectedId) {
        return '<p class="neoterra-hint">Select a character to see its relationships.</p>';
    }
    const node = graph.nodes.find((entry) => entry.id === selectedId) ?? null;
    if (!node) {
        return '<p class="neoterra-hint">Select a character to see its relationships.</p>';
    }
    const relationships = relationshipsForNode(graph, selectedId);
    const rows = relationships.map((edge) => `
        <li class="neoterra-relation-row">
            <span class="neoterra-relation-type" style="--nt-graph-edge:${edge.color}">${escapeRelationshipHtml(edge.label)}</span>
            <strong>${escapeRelationshipHtml(edge.otherName)}</strong>
            <span class="neoterra-hint">affinity ${edge.affinity}; tension ${edge.tension}</span>
        </li>`).join('');
    const facts = [
        node.isPlayer ? 'Player' : null,
        node.side,
        node.isPresent ? 'present' : 'elsewhere',
        node.corruptionStage > 0 ? `corruption stage ${node.corruptionStage}` : null,
        node.badEnd ? `bad end${node.badEndType ? `: ${node.badEndType}` : ''}` : null,
    ].filter(Boolean).join(' · ');
    return `
        <h4 class="neoterra-relations-detail-title">${escapeRelationshipHtml(node.name)}</h4>
        <p class="neoterra-hint">${escapeRelationshipHtml(facts)}</p>
        ${rows
        ? `<ul class="neoterra-relation-list">${rows}</ul>`
        : '<p class="neoterra-hint">No declared relationships.</p>'}`;
}

function filtersActive(filters = {}) {
    return filters.presentOnly === true
        || (typeof filters.side === 'string' && filters.side !== 'all')
        || (typeof filters.type === 'string' && filters.type !== 'all')
        || (filters.minAffinity !== null && filters.minAffinity !== undefined);
}

/** Full tab markup for the current model, figure state, and selection. */
export function renderRelationshipsMarkup(graph, { selectedId = null, hoveredId = null } = {}) {
    const unfiltered = graph && !filtersActive(graph.filters);
    if (!graph || graph.nodes.length === 0 || (!graph.hasRelationships && unfiltered)) {
        return `
        <div class="neoterra-relations" data-neoterra-relations>
            ${renderRelationshipFilters(graph?.filters ?? DEFAULT_FILTERS)}
            <p class="neoterra-empty" data-neoterra-relations-empty>No relationships yet.
                Relationships appear here as the cast interacts with the player and each other.</p>
        </div>`;
    }
    return `
    <div class="neoterra-relations" data-neoterra-relations data-selected-id="${escapeRelationshipHtml(selectedId ?? '')}"
        data-hovered-id="${escapeRelationshipHtml(hoveredId ?? '')}">
        ${renderRelationshipFilters(graph.filters ?? DEFAULT_FILTERS)}
        <div class="neoterra-relations-body">
            <div class="neoterra-relations-graph" data-neoterra-relations-graph>
                ${renderRelationshipGraphSvg(graph)}
                ${graph.hasRelationships ? '' : '<p class="neoterra-hint">No relationships match the filters yet.</p>'}
            </div>
            <aside class="neoterra-relations-side" aria-live="polite">
                ${renderDetail(graph, selectedId)}
                <ul class="neoterra-graph-legend" aria-label="Legend">${renderLegend(graph.legend)}</ul>
            </aside>
        </div>
    </div>`;
}

/**
 * Mount the Relations tab.
 *
 * @param {{
 *   root: HTMLElement,
 *   getState: () => object|null,
 *   getRegistry?: () => object|null,
 *   getSettings?: () => object,
 *   subscribe?: boolean,
 * }} options
 * @returns {{refresh: Function, dispose: Function, select: Function}|null}
 */
export function mountRelationships({
    root,
    getState,
    getRegistry = () => null,
    getSettings = () => ({}),
    subscribe = true,
} = {}) {
    if (typeof document === 'undefined' || !root) {
        return null;
    }
    let disposed = false;
    let selectedId = null;
    let hoveredId = null;
    const filters = { ...DEFAULT_FILTERS };

    function model() {
        const state = typeof getState === 'function' ? getState() : null;
        const registry = typeof getRegistry === 'function' ? getRegistry() : null;
        const settings = typeof getSettings === 'function' ? getSettings() : {};
        const graph = buildRelationshipGraph({ state, registry, settings, filters });
        if (selectedId && !graph.nodes.some((node) => node.id === selectedId)) {
            selectedId = null;
        }
        return graph;
    }

    function escapeSelector(id) {
        return globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id;
    }

    function focusKey() {
        const active = document.activeElement;
        if (!active || !root.contains(active)) {
            return null;
        }
        const node = active.closest?.('[data-neoterra-graph-node]');
        if (node) {
            return { kind: 'node', value: node.dataset.neoterraGraphNode };
        }
        const filter = active.closest?.('[data-neoterra-graph-filter]');
        if (filter) {
            return { kind: 'filter', value: filter.dataset.neoterraGraphFilter };
        }
        return null;
    }

    function restoreFocus(key) {
        if (!key) {
            return;
        }
        const selector = key.kind === 'node'
            ? `[data-neoterra-graph-node="${escapeSelector(key.value)}"]`
            : `[data-neoterra-graph-filter="${escapeSelector(key.value)}"]`;
        root.querySelector(selector)?.focus?.();
    }

    function applyHoverClasses(nodeId) {
        root.querySelectorAll('[data-neoterra-graph-edge]').forEach((edge) => {
            const [a, b] = String(edge.dataset.neoterraGraphEdge ?? '').split('::');
            edge.classList.toggle('is-highlighted', Boolean(nodeId) && (a === nodeId || b === nodeId));
        });
        root.querySelectorAll('[data-neoterra-graph-node]').forEach((node) => {
            node.classList.toggle('is-hovered', Boolean(nodeId)
                && node.dataset.neoterraGraphNode === nodeId);
        });
    }

    function refresh() {
        if (disposed) {
            return null;
        }
        const key = focusKey();
        const graph = model();
        if (hoveredId && !graph.nodes.some((node) => node.id === hoveredId)) {
            hoveredId = null;
        }
        root.innerHTML = renderRelationshipsMarkup(graph, { selectedId, hoveredId });
        applyHoverClasses(hoveredId);
        restoreFocus(key);
        return graph;
    }

    function nodeFromEvent(event) {
        return event.target.closest?.('[data-neoterra-graph-node]')?.dataset?.neoterraGraphNode ?? null;
    }

    function onClick(event) {
        const filter = event.target.closest?.('[data-neoterra-graph-filter]');
        if (filter && filter.dataset.neoterraGraphFilter) {
            applyFilter(filter.dataset.neoterraGraphFilter, filter);
            return;
        }
        const nodeId = nodeFromEvent(event);
        if (nodeId) {
            selectedId = nodeId;
            refresh();
        }
    }

    function onKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        const nodeId = nodeFromEvent(event);
        if (!nodeId) {
            return;
        }
        event.preventDefault();
        selectedId = nodeId;
        refresh();
        root.querySelector(`[data-neoterra-graph-node="${escapeSelector(nodeId)}"]`)?.focus?.();
    }

    function onOver(event) {
        const nodeId = nodeFromEvent(event);
        if (!nodeId || nodeId === hoveredId) {
            return;
        }
        hoveredId = nodeId;
        applyHoverClasses(hoveredId);
    }

    function onOut(event) {
        const nodeId = nodeFromEvent(event);
        if (!nodeId || nodeId !== hoveredId) {
            return;
        }
        // Moving between a node's circle and its label keeps the highlight.
        const related = event.relatedTarget;
        const stillInside = related?.closest?.('[data-neoterra-graph-node]')
            ?.dataset?.neoterraGraphNode === nodeId;
        if (stillInside) {
            return;
        }
        hoveredId = null;
        applyHoverClasses(null);
    }

    function applyFilter(name, control) {
        if (name === 'presentOnly') {
            filters.presentOnly = control.checked === true;
        } else if (name === 'side') {
            filters.side = control.value || 'all';
        } else if (name === 'type') {
            filters.type = control.value || 'all';
        } else if (name === 'minAffinity') {
            const raw = control.value;
            filters.minAffinity = raw === '' ? null : Number(raw);
        }
        refresh();
    }

    function onChange(event) {
        const filter = event.target.closest?.('[data-neoterra-graph-filter]');
        if (!filter) {
            return;
        }
        applyFilter(filter.dataset.neoterraGraphFilter, filter);
    }

    const offMap = subscribe
        ? bus.on(EVENTS.MAP_UPDATED, () => {
            // A hidden tab needs no repaint; it refreshes on activation.
            if (root.offsetParent !== null) {
                refresh();
            }
        })
        : () => {};
    const offTab = subscribe
        ? bus.on(EVENTS.TAB_CHANGED, () => {
            if (root.offsetParent !== null) {
                refresh();
            }
        })
        : () => {};

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('change', onChange);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    refresh();

    return {
        refresh,
        select: (nodeId) => {
            selectedId = nodeId ?? null;
            return refresh();
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            offMap();
            offTab();
            root.removeEventListener('click', onClick);
            root.removeEventListener('keydown', onKeydown);
            root.removeEventListener('change', onChange);
            root.removeEventListener('mouseover', onOver);
            root.removeEventListener('mouseout', onOut);
            root.innerHTML = '';
        },
    };
}
