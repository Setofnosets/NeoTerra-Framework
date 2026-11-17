/**
 * Neo Terra bad-end panel.
 *
 * The view model is pure and safe in Node; rendering only exposes stored
 * record data. The optional DOM mount wires the three continuation choices to
 * the bad-end flow.
 */

import { createLogger } from '../core/logger.js';
import { listContinuationOptionsFor } from '../flows/bad-end.js';
import { escapeHtml } from './player-panel.js';

const logger = createLogger('bad-end-ui');

let mounted = null;

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function journalFor(state, characterId) {
    return asArray(state?.recentEvents)
        .filter((event) => asArray(event?.tags).includes('bad-end'))
        .filter((event) => asArray(event?.actors).includes(characterId))
        .map((event) => ({
            turn: event.turn,
            date: event.date ?? null,
            summary: event.summary,
            tags: asArray(event.tags),
        }));
}

function currentCharacterId(state) {
    if (state?.player?.identity === 'canon' && typeof state.player.characterId === 'string') {
        return state.player.characterId;
    }
    if (typeof state?.flags?.badEndContinuation?.characterId === 'string') {
        return state.flags.badEndContinuation.characterId;
    }
    const first = Object.keys(state?.badEnds ?? {}).sort()[0];
    return first ?? null;
}

/**
 * Pure view model for the bad-end panel.
 */
export function buildBadEndView({ state, characterId = null, settings = {} } = {}) {
    const id = characterId ?? currentCharacterId(state);
    const character = id ? state?.characters?.[id] ?? null : null;
    const record = id ? state?.badEnds?.[id] ?? null : null;
    const options = id
        ? listContinuationOptionsFor({ state, characterId: id, settings })
        : {
            self: { available: false },
            other: { available: true, characters: [], custom: { available: true } },
            end: { available: true },
        };

    return {
        available: Boolean(record),
        characterId: id,
        displayName: character?.displayName ?? id ?? 'Unknown character',
        status: character?.status ?? null,
        allowDeadContinuation: settings?.badEnds?.allowDeadContinuation === true,
        record: record
            ? {
                type: record.type,
                severity: record.severity,
                cause: record.cause,
                turn: record.turn,
                date: record.date ?? null,
                locationId: record.locationId ?? null,
                locationName: record.locationId
                    ? state?.locations?.[record.locationId]?.name ?? record.locationId
                    : null,
                epilogueText: record.epilogueText ?? '',
                playableAs: record.playableAs === true,
                continuityKey: record.continuityKey,
                reversibility: record.reversibility,
                reversed: record.reversed === true,
                reversedTurn: record.reversedTurn ?? null,
                reversalReason: record.reversalReason ?? null,
                restoredStatus: record.restoredStatus ?? null,
            }
            : null,
        epilogueText: record?.epilogueText ?? '',
        badge: record
            ? {
                type: record.type,
                severity: record.severity,
                reversed: record.reversed === true,
            }
            : null,
        journal: id ? journalFor(state, id) : [],
        options,
    };
}

function targetOptionsMarkup(options) {
    const characters = asArray(options?.other?.characters);
    const canon = characters.map((character) => (
        `<option value="canon:${escapeHtml(character.characterId)}">${escapeHtml(character.displayName)}</option>`
    )).join('');
    return `<select data-neoterra-bad-end-target aria-label="Continuation target">
        ${canon}
        <option value="custom">Custom persona</option>
    </select>`;
}

/**
 * Pure markup. No inline styles and no hardcoded colors.
 */
export function renderBadEndMarkup(view) {
    if (!view?.record) {
        return '<p class="neoterra-empty">No bad end recorded for this character.</p>';
    }
    const record = view.record;
    const location = record.locationName
        ? ` at ${escapeHtml(record.locationName)}`
        : '';
    const reversal = record.reversed
        ? `<p class="neoterra-hint">Reversed on turn ${escapeHtml(record.reversedTurn ?? '?')}: ${escapeHtml(record.reversalReason ?? '')} (restored status: ${escapeHtml(record.restoredStatus ?? 'unknown')})</p>`
        : '';
    const deadNote = record.type === 'death'
        ? (view.allowDeadContinuation
            ? '<p class="neoterra-hint">Dead continuation is enabled in settings.</p>'
            : '<p class="neoterra-hint">Dead continuation is disabled in settings.</p>')
        : '';
    const selfButton = view.options?.self?.available
        ? `<button type="button" class="menu_button" data-neoterra-bad-end-choice="self">
                Continue as ${escapeHtml(view.displayName)}
            </button>`
        : '';
    const otherButton = view.options?.other?.available
        ? `<button type="button" class="menu_button" data-neoterra-bad-end-choice="other">
                Continue as someone else
            </button>`
        : '';
    const endButton = view.options?.end?.available
        ? `<button type="button" class="menu_button" data-neoterra-bad-end-choice="end">
                End here
            </button>`
        : '';
    const journal = asArray(view.journal);
    const journalMarkup = journal.length > 0
        ? `<ul class="neoterra-bad-end-journal">${journal.map((entry) => (
            `<li>Turn ${escapeHtml(entry.turn ?? '?')}: ${escapeHtml(entry.summary ?? '')}</li>`
        )).join('')}</ul>`
        : '<p class="neoterra-empty">No journal entries for this character.</p>';

    return `
    <section class="neoterra-bad-end" data-neoterra-bad-end="${escapeHtml(view.characterId ?? '')}">
        <header class="neoterra-bad-end-head">
            <h4>${escapeHtml(view.displayName)}: ${escapeHtml(record.type)}</h4>
            <p class="neoterra-hint">
                Severity ${escapeHtml(record.severity ?? 'unknown')}
                · Continuity ${escapeHtml(record.continuityKey ?? 'unknown')}
            </p>
        </header>
        <p class="neoterra-bad-end-cause">${escapeHtml(record.cause ?? '')}</p>
        <p class="neoterra-hint">
            Turn ${escapeHtml(record.turn ?? '?')}${record.date ? ` · ${escapeHtml(record.date)}` : ''}${location}
        </p>
        <div class="neoterra-bad-end-epilogue" data-neoterra-bad-end-epilogue>
            ${escapeHtml(record.epilogueText ?? '')}
        </div>
        ${reversal}
        ${deadNote}
        <section class="neoterra-bad-end-actions">
            ${selfButton}
            ${otherButton ? `${targetOptionsMarkup(view.options)}${otherButton}` : ''}
            ${endButton}
        </section>
        <section class="neoterra-bad-end-history">
            <h5>Journal</h5>
            ${journalMarkup}
        </section>
    </section>`;
}

/**
 * Mount the panel. Click handlers delegate to the flow and refresh in place.
 */
export function mountBadEndPanel({ root, store, flow } = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountBadEndPanel requires a root element');
    }
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('mountBadEndPanel requires a WorldState store');
    }
    if (!flow) {
        throw new TypeError('mountBadEndPanel requires a bad-end flow');
    }
    disposeBadEndPanel();
    const controller = new AbortController();
    const state = { root, store, flow, controller, status: null, error: null };
    mounted = state;

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const view = buildBadEndView({
            state: store.get(),
            characterId: currentCharacterId(store.get()),
            settings: typeof flow.getSettings === 'function' ? flow.getSettings() : {},
        });
        root.innerHTML = `
            ${state.error ? `<p class="neoterra-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
            ${state.status ? `<p class="neoterra-hint" data-neoterra-bad-end-status>${escapeHtml(state.status)}</p>` : ''}
            ${renderBadEndMarkup(view)}`;
    };

    root.addEventListener('click', async (event) => {
        const button = event.target.closest?.('[data-neoterra-bad-end-choice]');
        if (!button) {
            return;
        }
        state.error = null;
        state.status = null;
        const choice = button.dataset.neoterraBadEndChoice;
        const characterId = currentCharacterId(store.get());
        try {
            if (choice === 'self') {
                await flow.continueAsBadEnded({ characterId });
                state.status = 'Continuing as the bad-ended character.';
            } else if (choice === 'other') {
                const select = root.querySelector('[data-neoterra-bad-end-target]');
                const value = select?.value ?? 'custom';
                if (value.startsWith('canon:')) {
                    await flow.continueAsSomeoneElse({
                        identity: 'canon',
                        characterId: value.slice('canon:'.length),
                    });
                } else {
                    await flow.continueAsSomeoneElse({
                        identity: 'custom',
                        displayName: 'The Player',
                    });
                }
                state.status = 'Continuing as someone else.';
            } else if (choice === 'end') {
                const result = flow.endHere({ characterId });
                state.status = result.ended
                    ? `The story ends here for ${result.characterId}.`
                    : 'The story ends here.';
            }
        } catch (error) {
            state.error = error?.message ?? String(error);
            logger.warn('Bad-end continuation failed', error);
        }
        paint();
    }, { signal: controller.signal });

    paint();
    return {
        refresh: paint,
        getView: () => buildBadEndView({
            state: store.get(),
            characterId: currentCharacterId(store.get()),
            settings: typeof flow.getSettings === 'function' ? flow.getSettings() : {},
        }),
    };
}

export function disposeBadEndPanel() {
    if (!mounted) {
        return;
    }
    mounted.controller?.abort();
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
