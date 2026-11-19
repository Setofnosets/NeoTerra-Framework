/**
 * Pure arrival summary for the travel feedback cues.
 *
 * The summary is derived from `WorldState` alone so it survives the map panel
 * being disposed and remounted (close → reopen, tab switch). A fresh travel
 * `result` may be supplied right after the move; without one the last travel
 * recorded in `flags.travel` is used.
 *
 * No DOM, no store access, no clocks: the caller passes the state it already
 * holds.
 */

import { describeEncounter, encounterKey, encounterNames } from '../flows/encounter.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function capitalise(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }
    return value[0].toUpperCase() + value.slice(1);
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {{
 *   result?: object|null,
 *   state?: object|null,
 *   season?: object|null,
 * }} options
 * @returns {null | {
 *   key: string,
 *   fromId: string|null,
 *   toId: string,
 *   destination: string,
 *   district: string|null,
 *   timeSlot: string|null,
 *   turns: number,
 *   encounterKey: string|null,
 *   hostiles: string[],
 *   hasEncounter: boolean,
 *   text: string,
 * }}
 */
export function buildArrivalSummary({ result = null, state = null } = {}) {
    if (!isObject(state)) {
        return null;
    }
    const fresh = result !== null && result !== undefined;
    // A rejected travel or an `alreadyThere` no-op is not an arrival. When a
    // result is supplied it is authoritative: never fall back to an older
    // arrival recorded in the state.
    if (fresh && (!isObject(result) || result.ok !== true || result.alreadyThere === true)) {
        return null;
    }
    if (fresh && !result.to) {
        return null;
    }
    // Prefer the post-travel state carried by a fresh result so a caller that
    // still holds the pre-travel state cannot mix the old scene into the card.
    const sourceState = fresh && isObject(result.state) ? result.state : state;
    const travel = isObject(sourceState.flags?.travel) ? sourceState.flags.travel : null;
    const toId = fresh ? result.to : travel?.lastTo ?? null;
    if (!toId) {
        return null;
    }
    // Only trust a flags record that describes this arrival; a previous trip's
    // timestamp must not become the key for a malformed fresh result.
    const travelMatches = isObject(travel) && travel.lastTo === toId;
    const fromId = (fresh ? result.from : null) ?? (travelMatches ? travel.lastFrom : null) ?? null;
    const location = sourceState.locations?.[toId] ?? null;
    const destination = (fresh ? result.toName : null) ?? location?.name ?? toId;
    const district = location?.district ?? null;
    const timeSlot = capitalise(sourceState.meta?.timeOfDay ?? null);
    const turns = fresh
        ? finiteNumber(result.turns, 0)
        : finiteNumber(travel?.lastTurns, 0);
    // `flags.travel.lastAt` is the durable arrival identity (`Date.now` at the
    // move), so it wins on both the fresh and remount paths. `meta.turn` is the
    // fallback when a state predates the flags record.
    const keyTurn = (travelMatches ? travel.lastAt : null)
        ?? sourceState.meta?.turn
        ?? state.meta?.turn
        ?? '';
    const key = `travel:${fromId ?? ''}:${toId}:${keyTurn}`;

    // `describeEncounter` already blanks an encounter recorded for a different
    // location (a stale record after a failed cast refresh). Reuse that guard
    // instead of reading `scene.encounter` raw.
    const encounter = sourceState.scene?.encounter ?? null;
    const hasEncounter = describeEncounter(sourceState, encounter).length > 0;
    const hostiles = hasEncounter ? encounterNames(sourceState, encounter) : [];
    const encounterId = hasEncounter ? encounterKey(encounter) : null;

    const slotPhrase = timeSlot ? `during the ${timeSlot.toLowerCase()}` : 'now';
    const heading = district ? `${destination}, ${district}` : destination;
    const encounterSentence = hasEncounter
        ? `${hostiles.join(', ')} ${hostiles.length === 1 ? 'is' : 'are'} present.`
        : 'No hostiles detected.';
    const text = `You arrive at ${heading}${district ? ',' : ''} ${slotPhrase}. ${encounterSentence}`;

    return {
        key,
        fromId: fromId ?? null,
        toId,
        destination,
        district,
        timeSlot,
        turns,
        encounterKey: encounterId,
        hostiles,
        hasEncounter,
        text,
    };
}

/** The arrival the player dismissed in this chat, if any. */
export function readArrivalDismissedKey(context) {
    const key = context?.chatMetadata?.neoterra?.ui?.map?.arrivalDismissedKey;
    return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * The stored arrival snapshot (prose plus the arrival-time facts) so a card
 * rendered after a remount does not borrow the live clock or a later encounter.
 */
export function readArrivalSnapshot(context, key = null) {
    const stored = context?.chatMetadata?.neoterra?.ui?.map?.lastArrivalIntro;
    if (!stored || typeof stored !== 'object' || typeof stored.text !== 'string' || stored.text.trim().length === 0) {
        return null;
    }
    if (key && stored.key && stored.key !== key) {
        return null;
    }
    return stored;
}

/**
 * The prose of the last arrival, persisted per chat so the "Full arrival text"
 * disclosure still works after the map is closed and reopened.
 */
export function readArrivalIntro(context, key = null) {
    return readArrivalSnapshot(context, key)?.text ?? null;
}

/**
 * Persist the arrival prose and its arrival-time facts (slot, hostiles, turns,
 * district). The card reads these back after a remount instead of re-deriving
 * them from a state that has since moved on.
 */
export function writeArrivalIntro(context, key, text, extra = {}) {
    try {
        const metadata = context?.chatMetadata;
        if (!metadata || typeof metadata !== 'object' || !key || typeof text !== 'string') {
            return false;
        }
        const ui = mapUiSlot(metadata);
        ui.lastArrivalIntro = {
            key,
            text,
            timeSlot: typeof extra.timeSlot === 'string' ? extra.timeSlot : null,
            district: typeof extra.district === 'string' ? extra.district : null,
            turns: Number.isFinite(extra.turns) ? extra.turns : 0,
            hasEncounter: extra.hasEncounter === true,
            hostiles: Array.isArray(extra.hostiles) ? extra.hostiles.filter(Boolean) : [],
        };
        context.saveMetadataDebounced?.();
        return true;
    } catch {
        return false;
    }
}

function mapUiSlot(metadata) {
    const neoterra = metadata.neoterra && typeof metadata.neoterra === 'object'
        ? metadata.neoterra
        : (metadata.neoterra = { schemaVersion: 1 });
    if (neoterra.schemaVersion === undefined) {
        neoterra.schemaVersion = 1;
    }
    const ui = neoterra.ui && typeof neoterra.ui === 'object'
        ? neoterra.ui
        : (neoterra.ui = {});
    return ui.map && typeof ui.map === 'object' ? ui.map : (ui.map = {});
}

/**
 * Remember that this arrival was dismissed. Scoped to `neoterra.ui.map`; the
 * next travel has a different key, so it shows again without clearing this.
 */
export function writeArrivalDismissedKey(context, key) {
    try {
        const metadata = context?.chatMetadata;
        if (!metadata || typeof metadata !== 'object' || !key) {
            return false;
        }
        mapUiSlot(metadata).arrivalDismissedKey = key;
        context.saveMetadataDebounced?.();
        return true;
    } catch {
        return false;
    }
}

/**
 * Model for the sidebar arrival card. `null` when there is no arrival or the
 * player dismissed this exact one.
 *
 * `snapshot` is the persisted arrival (`readArrivalSnapshot`): its arrival-time
 * slot, district, turns, and hostiles win over the live state, so a card that
 * renders turns later still describes the arrival rather than the present.
 */
export function buildArrivalCard({ summary = null, introText = null, snapshot = null, dismissedKey = null } = {}) {
    if (!summary?.key) {
        return null;
    }
    if (dismissedKey && dismissedKey === summary.key) {
        return null;
    }
    const stored = snapshot && snapshot.key === summary.key ? snapshot : null;
    const intro = typeof introText === 'string' && introText.trim().length > 0
        ? introText
        : (typeof stored?.text === 'string' && stored.text.trim().length > 0 ? stored.text : null);
    const timeSlot = stored?.timeSlot ?? summary.timeSlot;
    const district = stored?.district ?? summary.district;
    const turns = Number.isFinite(stored?.turns) ? stored.turns : summary.turns;
    const hasEncounter = stored ? stored.hasEncounter === true : summary.hasEncounter;
    const hostiles = stored ? (Array.isArray(stored.hostiles) ? stored.hostiles : []) : summary.hostiles;
    return {
        key: summary.key,
        destination: summary.destination,
        district,
        timeSlot,
        turns,
        hostiles,
        hasEncounter,
        encounterLine: hasEncounter ? hostilesLine(hostiles) : 'No hostiles detected.',
        text: summary.text,
        introText: intro,
    };
}

/**
 * Dismiss an arrival: persist the key (so it survives a remount) and return it.
 * Returns `null` when there is no arrival or the write failed, in which case
 * the caller should keep the card rather than hide it behind a lost write.
 */
export function dismissArrival(context, state) {
    const summary = state ? buildArrivalSummary({ state }) : null;
    if (!summary?.key) {
        return null;
    }
    return writeArrivalDismissedKey(context, summary.key) ? summary.key : null;
}

function hostilesLine(hostiles = []) {
    const names = Array.isArray(hostiles) ? hostiles.filter(Boolean) : [];
    if (names.length === 0) {
        return 'No hostiles detected.';
    }
    return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} present.`;
}

function escapeMarkup(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/** Sidebar markup for the card; the prose stays reachable in `<details>`. */
export function renderArrivalCardMarkup(card) {
    if (!card) {
        return '';
    }
    const facts = [
        card.timeSlot ? `${card.timeSlot}` : null,
        card.district ? card.district : null,
        Number.isFinite(card.turns) && card.turns > 0
            ? `${card.turns} turn${card.turns === 1 ? '' : 's'}`
            : null,
    ].filter(Boolean);
    return `<section class="neoterra-map-arrival" data-neoterra-arrival-summary
        data-arrival-key="${escapeMarkup(card.key)}">
        <header>
            <h5>Arrival</h5>
            <button type="button" class="neoterra-icon-button" data-neoterra-intro-dismiss
                data-neoterra-arrival-dismiss aria-label="Dismiss arrival">&times;</button>
        </header>
        <p class="neoterra-map-arrival-destination">${escapeMarkup(card.destination)}</p>
        ${facts.length > 0 ? `<p class="neoterra-map-arrival-facts">${escapeMarkup(facts.join(' · '))}</p>` : ''}
        <p class="neoterra-map-arrival-encounter${card.hasEncounter ? ' is-hostile' : ''}">${escapeMarkup(card.encounterLine)}</p>
        ${card.introText
            ? `<details data-neoterra-map-intro>
                    <summary>Full arrival text</summary>
                    <p>${escapeMarkup(card.introText).replaceAll('\n', '<br>')}</p>
               </details>`
            : ''}
    </section>`;
}

