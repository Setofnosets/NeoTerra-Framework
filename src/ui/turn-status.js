/**
 * Turn progress chip.
 *
 * The turn pipeline reports stage start/done/failed events; this module turns
 * them into one compact "Director is updating" chip with the active stage and a
 * timeout state. Progress is advisory: a slow or failed stage never blocks the
 * turn or the CYOA request.
 */

export const TURN_STAGE_ORDER = Object.freeze([
    'clock',
    'world-tick',
    'pacing',
    'tracker',
    'storyline',
    'lore',
    'auditor',
    'cast',
    'bad-end',
    'choices',
]);

export const TURN_STAGE_LABELS = Object.freeze({
    clock: 'Advancing the clock',
    'world-tick': 'Updating the city',
    pacing: 'Reading the pace',
    tracker: 'Tracking the world',
    storyline: 'Advancing the story',
    lore: 'Writing the recap',
    auditor: 'Checking continuity',
    cast: 'Refreshing the cast',
    'bad-end': 'Checking bad ends',
    choices: 'Writing choices',
});

export const TURN_TIMEOUT_MS = 45000;

function isStage(id) {
    return TURN_STAGE_ORDER.includes(id);
}

/** Fresh tracker state; `startedAt` is 0 until the first stage starts. */
export function createStageState() {
    return { startedAt: 0, finishedAt: 0, events: {} };
}

/**
 * Fold one pipeline event into the tracker. Unknown stages and duplicate
 * transitions are ignored instead of throwing.
 */
export function applyTurnStage(state, event, now = Date.now()) {
    const id = event?.stage;
    if (!isStage(id)) {
        return state;
    }
    const previous = state?.events?.[id] ?? null;
    const status = event?.status;
    let next = null;
    if (status === 'start') {
        next = { status: 'running', startedAt: now, endedAt: 0, error: null };
    } else if (status === 'done') {
        next = { status: 'done', startedAt: previous?.startedAt ?? now, endedAt: now, error: null };
    } else if (status === 'failed') {
        next = {
            status: 'failed',
            startedAt: previous?.startedAt ?? now,
            endedAt: now,
            error: typeof event?.error === 'string' ? event.error : 'failed',
        };
    } else if (status === 'skipped') {
        next = { status: 'skipped', startedAt: now, endedAt: now, error: null, reason: event?.reason ?? null };
    } else {
        return state;
    }
    return {
        ...state,
        startedAt: state?.startedAt || now,
        events: { ...(state?.events ?? {}), [id]: next },
    };
}

/**
 * Pure chip view model. `finished` starts the small linger window so the user
 * sees a completed chip instead of it vanishing mid-paint.
 */
export function summarizeTurnStatus(state, {
    now = Date.now(),
    timeoutMs = TURN_TIMEOUT_MS,
    finished = false,
    lingerMs = 1200,
} = {}) {
    const events = state?.events ?? {};
    const stages = TURN_STAGE_ORDER.map((id) => {
        const record = events[id] ?? null;
        return {
            id,
            label: TURN_STAGE_LABELS[id],
            status: record?.status ?? 'pending',
            error: record?.error ?? null,
            durationMs: record?.startedAt && record?.endedAt
                ? Math.max(0, record.endedAt - record.startedAt)
                : null,
        };
    });
    const running = stages.find((stage) => stage.status === 'running') ?? null;
    const failed = stages.filter((stage) => stage.status === 'failed');
    const current = running
        ?? stages.find((stage) => stage.status === 'pending')
        ?? stages[stages.length - 1];
    const elapsed = state?.startedAt ? Math.max(0, now - state.startedAt) : 0;
    const visible = Boolean(state?.startedAt)
        && (!finished || elapsed < lingerMs);
    const detail = failed.length > 0
        ? `${failed[0].label} failed`
        : (running ? `${running.label}…` : 'Finishing the turn…');
    return {
        visible,
        title: 'Director is updating',
        detail,
        stages,
        current: current?.id ?? null,
        failed: failed.length > 0,
        stale: elapsed > timeoutMs,
        elapsed,
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/** Pure chip markup for tests and the mounted element. */
export function renderTurnStatusMarkup(model) {
    if (!model?.visible) {
        return '';
    }
    const dots = model.stages
        .filter((stage) => stage.status === 'running' || stage.status === 'failed')
        .map((stage) => `<span class="neoterra-turn-stage is-${escapeHtml(stage.status)}">${escapeHtml(stage.label)}</span>`)
        .join('');
    return `
    <div class="neoterra-turn-status" data-neoterra-turn-status
        data-failed="${model.failed ? 'true' : 'false'}" data-stale="${model.stale ? 'true' : 'false'}"
        role="status" aria-live="polite">
        <span class="neoterra-turn-spinner" aria-hidden="true"></span>
        <span class="neoterra-turn-title">${escapeHtml(model.title)}</span>
        <span class="neoterra-turn-detail">${escapeHtml(model.stale ? 'This is taking longer than usual' : model.detail)}</span>
        ${dots ? `<span class="neoterra-turn-stages">${dots}</span>` : ''}
    </div>`;
}

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Mount the chip into a host above the send form. Returns a controller; every
 * method is a no-op without a DOM.
 */
export function mountTurnStatus({
    host = null,
    now = () => Date.now(),
    timeoutMs = TURN_TIMEOUT_MS,
    intervalMs = 250,
    lingerMs = 1200,
    finished = null,
} = {}) {
    if (!hasDom() || !host) {
        return null;
    }
    const element = document.createElement('div');
    element.className = 'neoterra-turn-host';
    element.hidden = true;
    host.prepend(element);
    let state = createStageState();
    let timer = null;
    let hideTimer = null;
    let isFinished = false;

    const paint = () => {
        const model = summarizeTurnStatus(state, {
            now: now(),
            timeoutMs,
            finished: isFinished,
            lingerMs,
        });
        element.innerHTML = renderTurnStatusMarkup(model);
        element.hidden = !model.visible;
        return model;
    };

    const stopTimer = () => {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };

    return {
        element,
        start: () => {
            state = createStageState();
            isFinished = false;
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            state.startedAt = now();
            stopTimer();
            timer = setInterval(paint, intervalMs);
            paint();
        },
        event: (event) => {
            if (!state.startedAt) {
                state.startedAt = now();
            }
            state = applyTurnStage(state, event, now());
            paint();
        },
        finish: ({ errors = [] } = {}) => {
            isFinished = true;
            if (Array.isArray(errors) && errors.length > 0) {
                for (const error of errors) {
                    state = applyTurnStage(state, {
                        stage: error?.stage ?? 'tracker',
                        status: 'failed',
                        error: error?.error ?? 'failed',
                    }, now());
                }
            }
            stopTimer();
            paint();
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
            }
            hideTimer = setTimeout(() => {
                element.hidden = true;
                element.innerHTML = '';
            }, lingerMs);
            finished?.(errors);
            return summarizeTurnStatus(state, { now: now(), timeoutMs, finished: true, lingerMs });
        },
        fail: (error) => {
            isFinished = true;
            state = applyTurnStage(state, {
                stage: error?.stage ?? 'tracker',
                status: 'failed',
                error: error?.error ?? String(error ?? 'failed'),
            }, now());
            stopTimer();
            paint();
        },
        getState: () => state,
        dispose: () => {
            stopTimer();
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            element.remove?.();
        },
    };
}
