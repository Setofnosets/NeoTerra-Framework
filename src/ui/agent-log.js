/**
 * In-memory agent terminal log.
 *
 * This module is deliberately safe to import in Node: it never reads the DOM
 * at import time. `renderAgentLog` is the only DOM-facing export and it
 * requires an explicit document/container when called.
 */

const MAX_TEXT_CHARS = 20000;
const DEFAULT_MAX_ENTRIES = 200;
const VALID_STATUSES = new Set(['running', 'ok', 'repaired', 'failed', 'aborted']);

/**
 * Create an isolated agent log.
 *
 * Entries are stored oldest-first; `entries()` returns a newest-last copy.
 * Subscribers receive a fresh snapshot of the entry list.
 */
export function createAgentLog({ maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
    const limit = positiveInteger(maxEntries) ?? DEFAULT_MAX_ENTRIES;
    const entries = [];
    const listeners = new Set();
    let nextId = 1;

    function begin({ agentId, request = '', route = null } = {}) {
        const entry = {
            id: nextId,
            time: now(),
            agentId,
            status: 'running',
            route: route ?? null,
            request: truncateText(request),
            response: '',
            errors: [],
            attempts: 0,
            durationMs: null,
        };
        nextId += 1;
        entries.push(entry);
        trim();
        notify();
        return snapshot(entry);
    }

    function update(id, patch = {}) {
        const entry = find(id);
        if (!entry || !patch || typeof patch !== 'object') {
            return entry ? snapshot(entry) : null;
        }

        for (const [key, value] of Object.entries(patch)) {
            if (key === 'id' || key === 'time') {
                continue;
            }
            if (key === 'request' || key === 'response') {
                entry[key] = truncateText(value);
            } else if (key === 'errors') {
                entry.errors = normalizeErrors(value);
            } else {
                entry[key] = value;
            }
        }

        notify();
        return snapshot(entry);
    }

    function finish(id, patch = {}) {
        const entry = find(id);
        if (!entry) {
            return null;
        }
        const next = { ...patch };
        if (next.status !== undefined && !VALID_STATUSES.has(next.status)) {
            throw new Error(`Unknown agent log status "${String(next.status)}"`);
        }
        return update(id, next);
    }

    function get(id) {
        const entry = find(id);
        return entry ? snapshot(entry) : null;
    }

    function snapshotEntries() {
        return entries.map(snapshot);
    }

    function clear() {
        entries.length = 0;
        notify();
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    function dispose() {
        listeners.clear();
    }

    function find(id) {
        const idValue = id && typeof id === 'object' ? id.id : id;
        return entries.find((entry) => entry.id === idValue);
    }

    function trim() {
        if (entries.length > limit) {
            entries.splice(0, entries.length - limit);
        }
    }

    function notify() {
        const payload = snapshotEntries();
        for (const listener of [...listeners]) {
            try {
                listener(payload);
            } catch {
                // A throwing listener must never break logging.
            }
        }
    }

    return {
        begin,
        update,
        finish,
        get,
        entries: snapshotEntries,
        clear,
        subscribe,
        dispose,
    };
}

/** Shared log used by the agent client/runner unless one is injected. */
export const agentLog = createAgentLog();

/**
 * Render a compact, escaped agent log into a container element.
 *
 * @returns {{render: () => void, destroy: () => void}}
 */
export function renderAgentLog(container, options = {}) {
    const { log = agentLog, document: documentOption } = options;
    const doc = documentOption ?? globalThis.document;

    if (!doc || typeof doc.createElement !== 'function') {
        throw new Error('renderAgentLog requires a DOM document');
    }
    if (!container || typeof container.appendChild !== 'function') {
        throw new Error('renderAgentLog requires a container element');
    }

    const wrapper = doc.createElement('div');
    wrapper.className = 'neoterra-agent-log';

    const header = doc.createElement('div');
    header.className = 'neoterra-agent-log-header';

    const title = doc.createElement('span');
    title.className = 'neoterra-agent-log-title';
    title.textContent = 'Agent log';

    const clearButton = doc.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'neoterra-agent-log-clear';
    clearButton.textContent = 'Clear';

    header.appendChild(title);
    header.appendChild(clearButton);

    const list = doc.createElement('div');
    list.className = 'neoterra-agent-log-list';

    wrapper.appendChild(header);
    wrapper.appendChild(list);

    const unsubscribe = typeof log.subscribe === 'function'
        ? log.subscribe(() => render())
        : () => {};

    function onClear() {
        try {
            log.clear?.();
        } catch {
            // Clearing the log is best-effort.
        }
        render();
    }

    clearButton.addEventListener('click', onClear);

    function render() {
        clearNode(list);
        let rows = [];
        try {
            rows = typeof log.entries === 'function' ? log.entries() : [];
        } catch {
            rows = [];
        }

        if (rows.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'neoterra-agent-log-empty';
            empty.textContent = 'No agent requests yet.';
            list.appendChild(empty);
            return;
        }

        for (const entry of rows) {
            list.appendChild(renderEntry(doc, entry));
        }
    }

    clearNode(container);
    container.appendChild(wrapper);
    render();

    return {
        render,
        destroy() {
            unsubscribe();
            clearButton.removeEventListener?.('click', onClear);
            if (typeof wrapper.remove === 'function') {
                wrapper.remove();
            } else if (wrapper.parentNode === container) {
                container.removeChild(wrapper);
            }
        },
    };
}

/** Convenience alias for callers mounting into a panel. */
export function mountAgentLog(panel, options) {
    return renderAgentLog(panel, options);
}

function renderEntry(doc, entry) {
    const row = doc.createElement('div');
    row.className = 'neoterra-agent-log-entry';

    const heading = doc.createElement('div');
    heading.className = 'neoterra-agent-log-entry-heading';

    const agent = doc.createElement('span');
    agent.className = 'neoterra-agent-log-agent';
    agent.textContent = String(entry.agentId ?? 'unknown');

    const status = doc.createElement('span');
    status.className = `neoterra-agent-log-status is-${entry.status ?? 'running'}`;
    status.textContent = String(entry.status ?? 'running');

    const route = doc.createElement('span');
    route.className = 'neoterra-agent-log-route';
    route.textContent = entry.route ? `route: ${entry.route}` : 'route: -';

    const duration = doc.createElement('span');
    duration.className = 'neoterra-agent-log-duration';
    duration.textContent = entry.durationMs === null || entry.durationMs === undefined
        ? '-'
        : `${entry.durationMs}ms`;

    heading.appendChild(agent);
    heading.appendChild(status);
    heading.appendChild(route);
    heading.appendChild(duration);

    const request = doc.createElement('details');
    request.className = 'neoterra-agent-log-request';
    const requestSummary = doc.createElement('summary');
    requestSummary.textContent = 'Request';
    const requestBody = doc.createElement('pre');
    requestBody.textContent = entry.request ?? '';
    request.appendChild(requestSummary);
    request.appendChild(requestBody);

    const response = doc.createElement('details');
    response.className = 'neoterra-agent-log-response';
    const responseSummary = doc.createElement('summary');
    responseSummary.textContent = entry.response ? 'Response' : 'Response (empty)';
    const responseBody = doc.createElement('pre');
    responseBody.textContent = entry.response ?? '';
    response.appendChild(responseSummary);
    response.appendChild(responseBody);

    const errors = doc.createElement('div');
    errors.className = 'neoterra-agent-log-errors';
    errors.textContent = formatErrors(entry.errors);

    row.appendChild(heading);
    row.appendChild(request);
    row.appendChild(response);
    if (errors.textContent) {
        row.appendChild(errors);
    }
    return row;
}

function formatErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
        return '';
    }
    return errors
        .map((error) => {
            if (error && typeof error === 'object') {
                return `${error.path ?? '$'}: ${error.message ?? 'invalid value'}`;
            }
            return String(error);
        })
        .join('\n');
}

function snapshot(entry) {
    return {
        ...entry,
        errors: entry.errors.map((error) => (
            error && typeof error === 'object' ? { ...error } : error
        )),
    };
}

function normalizeErrors(errors) {
    if (!Array.isArray(errors)) {
        return [];
    }
    return errors.map((error) => (
        error && typeof error === 'object' ? { ...error } : error
    ));
}

function truncateText(value) {
    const text = typeof value === 'string'
        ? value
        : value === undefined || value === null
            ? ''
            : safeStringify(value);
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

function clearNode(node) {
    while (node.firstChild) {
        node.removeChild(node.firstChild);
    }
}
