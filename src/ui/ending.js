/**
 * Neo Terra ending screen.
 *
 * The view model is pure and Node-testable. It shows the stored epilogue and
 * the state-aware Resistance / Join the villain / End here choices, plus the
 * resulting post-victory arc summary. The DOM mount is optional.
 */

import { createLogger } from '../core/logger.js';
import { isEndingScreenActive, listEndingChoices } from '../flows/ending.js';
import { escapeHtml } from './player-panel.js';

const logger = createLogger('ending-ui');

let mounted = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/** True while the ending screen owns the next pass (used by CYOA guards). */
export function endingSuppressesChoices(state) {
    return isEndingScreenActive(state);
}

function postVictorySummary(state) {
    const flags = state?.flags?.postVictory ?? null;
    if (!flags) {
        return null;
    }
    return {
        path: flags.path,
        title: flags.title,
        victorFactionId: flags.victorFactionId,
        resistanceFactionId: flags.resistanceFactionId,
        threatId: flags.threatId,
        beats: asArray(flags.beats),
        conquest: flags.conquest ?? null,
        startedTurn: flags.startedTurn ?? null,
    };
}

export function buildEndingView({ state, season = null, settings = {} } = {}) {
    const choices = listEndingChoices({ state, season });
    return {
        visible: state?.ending?.status === 'epilogue' || state?.ending?.status === 'ended'
            || state?.ending?.status === 'continued',
        status: state?.ending?.status ?? 'none',
        path: state?.ending?.path ?? null,
        epilogueText: state?.ending?.epilogueText ?? '',
        victor: state?.ending?.victor ?? choices.ending?.victor ?? null,
        playerStatus: state?.ending?.playerStatus ?? '',
        castFates: asArray(state?.ending?.castFates),
        paragraphs: state?.ending?.paragraphs ?? null,
        source: state?.ending?.source ?? null,
        firedTurn: state?.ending?.firedTurn ?? null,
        arc: state?.arc ?? 'season',
        choices,
        postVictory: postVictorySummary(state),
        showChoices: state?.ending?.status === 'epilogue',
        suppressChoices: endingSuppressesChoices(state),
        epilogueParagraphs: String(state?.ending?.epilogueText ?? '')
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean),
        settingsHint: settings?.ending?.paragraphs
            ? `Epilogue target: ${settings.ending.paragraphs} paragraphs.`
            : null,
    };
}

function renderChoice(option) {
    const disabled = option?.available !== true;
    const reason = disabled && option?.reason
        ? `<span class="neoterra-hint">${escapeHtml(option.reason)}</span>`
        : '';
    return `<button type="button" class="menu_button" data-neoterra-ending-choice="${escapeHtml(option.path)}"
        ${disabled ? 'disabled aria-disabled="true"' : ''}>
        ${escapeHtml(option.label)}
    </button>${reason}`;
}

export function renderEndingMarkup(view) {
    if (!view?.visible) {
        return '<p class="neoterra-empty">No ending has fired in this chat.</p>';
    }
    const paragraphs = asArray(view.epilogueParagraphs);
    const epilogue = paragraphs.length > 0
        ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')
        : `<p>${escapeHtml(view.epilogueText || 'The epilogue is not available yet.')}</p>`;
    const choices = view.showChoices
        ? `<section class="neoterra-ending-choices" data-neoterra-ending-choices>
            ${renderChoice(view.choices.resistance)}
            ${renderChoice(view.choices['join-villain'])}
            ${renderChoice(view.choices.end)}
        </section>`
        : '';
    const postVictory = view.postVictory
        ? `<section class="neoterra-ending-post">
            <h4>${escapeHtml(view.postVictory.title ?? 'Post-victory arc')}</h4>
            <p class="neoterra-hint">
                Path: ${escapeHtml(view.postVictory.path ?? '')}
                · Threat: ${escapeHtml(view.postVictory.threatId ?? '')}
            </p>
            <p class="neoterra-hint">New beats: ${escapeHtml(asArray(view.postVictory.beats).join(', ') || 'none')}</p>
            ${view.postVictory.conquest
                ? `<p class="neoterra-hint">Conquest targets: ${escapeHtml(asArray(view.postVictory.conquest.targets).join(', ') || 'none')}</p>`
                : ''}
        </section>`
        : '';
    const castFates = asArray(view.castFates).length > 0
        ? `<section class="neoterra-ending-cast">
            <h4>Cast fates</h4>
            <ul>${view.castFates.map((fate) => (
                `<li>${escapeHtml(fate.characterId)}: ${escapeHtml(fate.fate ?? '')}</li>`
            )).join('')}</ul>
        </section>`
        : '';

    return `
    <section class="neoterra-ending" data-neoterra-ending-status="${escapeHtml(view.status)}">
        <header class="neoterra-ending-head">
            <h3>${view.status === 'ended' ? 'The story ends here' : 'Villain victory'}</h3>
            <p class="neoterra-hint">
                Victor: ${escapeHtml(view.victor ?? 'unknown')}
                ${view.firedTurn !== null ? ` · Turn ${escapeHtml(view.firedTurn)}` : ''}
                ${view.source ? ` · ${escapeHtml(view.source)}` : ''}
            </p>
        </header>
        <div class="neoterra-ending-epilogue" data-neoterra-ending-epilogue>${epilogue}</div>
        ${castFates}
        ${choices}
        ${postVictory}
    </section>`;
}

/**
 * Mount the ending screen. Choice buttons delegate to the ending flow exactly
 * once; the flow itself validates state-aware availability.
 */
export function mountEndingPanel({ root, store, flow } = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountEndingPanel requires a root element');
    }
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('mountEndingPanel requires a WorldState store');
    }
    if (!flow || typeof flow.choosePath !== 'function') {
        throw new TypeError('mountEndingPanel requires an ending flow');
    }
    disposeEndingPanel();
    const controller = new AbortController();
    const state = { root, store, flow, controller, status: null, error: null };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const view = buildEndingView({
            state: store.get(),
            season: flow.season ?? null,
            settings: typeof flow.getSettings === 'function' ? flow.getSettings() : {},
        });
        root.innerHTML = `
            ${state.error ? `<p class="neoterra-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
            ${state.status ? `<p class="neoterra-hint" data-neoterra-ending-status>${escapeHtml(state.status)}</p>` : ''}
            ${renderEndingMarkup(view)}`;
    };

    root.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-neoterra-ending-choice]');
        if (!button || button.disabled) {
            return;
        }
        state.error = null;
        state.status = null;
        const path = button.dataset.neoterraEndingChoice;
        try {
            const result = flow.choosePath(path);
            state.status = path === 'end'
                ? 'The story ends here. The world remains viewable.'
                : `Post-victory arc started: ${result.postVictory?.title ?? path}.`;
        } catch (error) {
            state.error = error?.message ?? String(error);
            logger.warn('Ending choice failed', error);
        }
        paint();
    }, { signal: controller.signal });

    paint();
    return {
        refresh: paint,
        getView: () => buildEndingView({
            state: store.get(),
            season: flow.season ?? null,
            settings: typeof flow.getSettings === 'function' ? flow.getSettings() : {},
        }),
    };
}

export function disposeEndingPanel() {
    if (!mounted) {
        return;
    }
    mounted.controller?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
