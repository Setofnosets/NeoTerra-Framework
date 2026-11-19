import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildArrivalSummary } from '../src/ui/arrival-summary.js';
import {
    buildArrivalCard,
    dismissArrival,
    readArrivalDismissedKey,
    readArrivalIntro,
    readArrivalSnapshot,
    renderArrivalCardMarkup,
    writeArrivalDismissedKey,
    writeArrivalIntro,
} from '../src/ui/arrival-summary.js';
import { buildArrivalToast, renderToastMarkup, toastLifetime } from '../src/ui/toasts.js';
import { shouldAnnounceArrival, shouldPulseReturn } from '../src/ui/shell.js';
import { pulseReturnButton } from '../src/ui/map-panel.js';

function makeState({
    flags = {},
    timeOfDay = 'evening',
    turn = 12,
    locationId = 'loc.b',
    encounter = null,
    characters = {},
} = {}) {
    return {
        chatId: 'arrival-summary-test',
        seasonId: 's1',
        characters,
        locations: {
            'loc.a': { id: 'loc.a', name: 'Arcade', district: 'Hub', status: 'quiet' },
            'loc.b': { id: 'loc.b', name: 'Docks', district: 'West', status: 'quiet' },
            'loc.c': { id: 'loc.c', name: 'Tower', status: 'quiet' },
        },
        scene: { locationId, present: [], encounter, framing: '' },
        meta: { turn, timeOfDay, inCombat: false },
        flags,
    };
}

const LAST_AT = 1763500000000;

const TRAVEL_FLAGS = {
    travel: {
        lastFrom: 'loc.a',
        lastTo: 'loc.b',
        lastPath: ['loc.a', 'loc.b'],
        lastBridges: [],
        lastTurns: 2,
        lastAt: LAST_AT,
    },
};

test('returns null when nothing has travelled', () => {
    assert.equal(buildArrivalSummary({ state: makeState() }), null);
    assert.equal(buildArrivalSummary({ state: null }), null);
    assert.equal(buildArrivalSummary({}), null);
});

test('builds a summary from a fresh travel result', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    const result = {
        ok: true,
        from: 'loc.a',
        to: 'loc.b',
        toName: 'Docks',
        turns: 2,
        state,
    };
    const summary = buildArrivalSummary({ result, state });
    assert.ok(summary);
    assert.equal(summary.key, `travel:loc.a:loc.b:${LAST_AT}`);
    assert.equal(summary.fromId, 'loc.a');
    assert.equal(summary.toId, 'loc.b');
    assert.equal(summary.destination, 'Docks');
    assert.equal(summary.district, 'West');
    assert.equal(summary.timeSlot, 'Evening');
    assert.equal(summary.turns, 2);
    assert.equal(summary.hasEncounter, false);
    assert.deepEqual(summary.hostiles, []);
    assert.equal(summary.encounterKey, null);
    assert.match(summary.text, /Docks/);
    assert.match(summary.text, /evening/);
    assert.match(summary.text, /No hostiles detected/);
});

test('derives the summary from WorldState after a remount', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    state.locations['loc.b'].name = 'The Docks';
    const fresh = buildArrivalSummary({
        result: { ok: true, from: 'loc.a', to: 'loc.b', toName: 'Docks', turns: 2, state: makeState({ flags: TRAVEL_FLAGS }) },
        state: makeState({ flags: TRAVEL_FLAGS }),
    });
    const summary = buildArrivalSummary({ result: null, state });
    assert.ok(summary);
    assert.equal(summary.key, `travel:loc.a:loc.b:${LAST_AT}`);
    // Fresh and remount paths must agree on the arrival identity.
    assert.equal(fresh.key, summary.key);
    assert.equal(summary.destination, 'The Docks');
    assert.equal(summary.turns, 2);
    assert.match(summary.text, /The Docks/);
});

test('a stale encounter at a different location yields no encounter', () => {
    const state = makeState({
        flags: TRAVEL_FLAGS,
        encounter: {
            locationId: 'loc.a',
            characterIds: ['npc.ghost'],
            threatNames: ['A Stale Threat'],
            source: 'travel',
        },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.hasEncounter, false);
    assert.equal(summary.encounterKey, null);
    assert.deepEqual(summary.hostiles, []);
    assert.match(summary.text, /No hostiles detected/);
    assert.doesNotMatch(summary.text, /Ghost/);
    assert.doesNotMatch(summary.text, /Stale Threat/);
});

test('a current encounter names its hostiles', () => {
    const state = makeState({
        flags: TRAVEL_FLAGS,
        encounter: {
            locationId: 'loc.b',
            characterIds: ['npc.ghost'],
            threatNames: ['Dock Riot'],
            source: 'travel',
        },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.hasEncounter, true);
    assert.deepEqual(summary.hostiles, ['Ghost', 'Dock Riot']);
    assert.equal(summary.encounterKey, 'loc.b|npc.ghost|Dock Riot');
    assert.match(summary.text, /Ghost, Dock Riot are present/);
});

test('alreadyThere and rejected results yield null even with a travel history', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    assert.equal(buildArrivalSummary({
        result: { ok: true, alreadyThere: true, from: 'loc.b', to: 'loc.b' },
        state,
    }), null);
    assert.equal(buildArrivalSummary({
        result: { ok: false, reason: 'in-combat', from: 'loc.a', to: 'loc.b' },
        state,
    }), null);
});

test('text never invents hostiles and handles a missing time slot', () => {
    const state = makeState({ flags: TRAVEL_FLAGS, timeOfDay: null });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.timeSlot, null);
    assert.equal(summary.hostiles.length, 0);
    assert.match(summary.text, /Docks/);
    assert.match(summary.text, /now/);
    assert.match(summary.text, /No hostiles detected/);
});

test('a first trip with no flags history keys from the fresh result and turn', () => {
    const state = makeState({ flags: {} });
    const summary = buildArrivalSummary({
        result: { ok: true, to: 'loc.b', toName: 'Docks', turns: '1', state },
        state,
    });
    assert.ok(summary);
    // No durable `lastAt` yet: the scene turn is the fallback identity.
    assert.equal(summary.key, 'travel::loc.b:12');
    assert.equal(summary.fromId, null);
    assert.equal(summary.turns, 1);
    assert.equal(summary.district, 'West');
});

test('a fresh result without its own state still uses the supplied state', () => {
    const state = makeState({ flags: {} });
    const summary = buildArrivalSummary({
        result: { ok: true, from: 'loc.a', to: 'loc.b', toName: 'Docks', turns: 2 },
        state,
    });
    assert.ok(summary);
    assert.equal(summary.key, 'travel:loc.a:loc.b:12');
    assert.equal(summary.district, 'West');
});

test('a malformed successful result never falls back to an older arrival', () => {
    const state = makeState({ flags: TRAVEL_FLAGS });
    assert.equal(buildArrivalSummary({ result: { ok: true }, state }), null);
    assert.equal(buildArrivalSummary({ result: { ok: true, to: '' }, state }), null);
});

test('a location without a district still yields a summary', () => {
    const state = makeState({
        flags: {
            travel: { lastFrom: 'loc.a', lastTo: 'loc.c', lastTurns: 1, lastAt: 4 },
        },
        locationId: 'loc.c',
        timeOfDay: 'dawn',
    });
    const summary = buildArrivalSummary({ state });
    assert.ok(summary);
    assert.equal(summary.destination, 'Tower');
    assert.equal(summary.district, null);
    assert.equal(summary.timeSlot, 'Dawn');
});

test('the arrival toast carries the destination, slot, district, and encounter', () => {
    const summary = buildArrivalSummary({ state: makeState({ flags: TRAVEL_FLAGS }) });
    const toast = buildArrivalToast(summary, { mapStayedOpen: true });
    assert.equal(toast.id, `travel:loc.a:loc.b:${LAST_AT}`);
    assert.equal(toast.type, 'travel-arrival');
    assert.equal(toast.title, 'Arrived at Docks');
    assert.match(toast.message, /Evening/);
    assert.match(toast.message, /West/);
    assert.match(toast.message, /No hostiles/);
    assert.equal(toast.tone, 'info');
    assert.equal(toast.ttlMs, 9000);
    assert.deepEqual(toast.action, { id: 'return-to-chat', label: 'Return to chat' });

    // Close-on-travel is informational: the map is already gone.
    const informational = buildArrivalToast(summary, { mapStayedOpen: false });
    assert.equal(informational.action, null);
    assert.equal(buildArrivalToast(null), null);
});

test('the toast markup renders an optional action and existing toasts are unchanged', () => {
    const summary = buildArrivalSummary({ state: makeState({ flags: TRAVEL_FLAGS }) });
    const withAction = renderToastMarkup(buildArrivalToast(summary, { mapStayedOpen: true }));
    assert.match(withAction, /data-neoterra-toast-action="return-to-chat"/);
    assert.match(withAction, />Return to chat</);

    const withoutAction = renderToastMarkup(buildArrivalToast(summary, { mapStayedOpen: false }));
    assert.doesNotMatch(withoutAction, /data-neoterra-toast-action/);

    const plain = renderToastMarkup({ id: 'x', title: 'Title', message: 'Body', tone: 'info' });
    assert.doesNotMatch(plain, /neoterra-toast-action/);
    assert.match(plain, /data-neoterra-toast="x"/);
});

test('shouldAnnounceArrival gates rejected, no-op, switched-chat, and disabled cases', () => {
    const settings = { map: { arrivalFeedback: true } };
    const ok = { ok: true, from: 'loc.a', to: 'loc.b' };
    assert.equal(shouldAnnounceArrival({ result: ok, settings, liveChatId: 'c1', chatId: 'c1' }), true);
    // No arrival for a rejected travel or `alreadyThere`.
    assert.equal(shouldAnnounceArrival({ result: { ok: false }, settings, chatId: 'c1' }), false);
    assert.equal(shouldAnnounceArrival({ result: { ok: true, alreadyThere: true }, settings }), false);
    assert.equal(shouldAnnounceArrival({ result: null, settings }), false);
    // The setting is the single switch.
    assert.equal(shouldAnnounceArrival({
        result: ok,
        settings: { map: { arrivalFeedback: false } },
        liveChatId: 'c1',
        chatId: 'c1',
    }), false);
    // A chat switch during the awaited post never lands in the new chat.
    assert.equal(shouldAnnounceArrival({ result: ok, settings, liveChatId: 'c2', chatId: 'c1' }), false);
    assert.equal(shouldAnnounceArrival({ result: ok, settings, liveChatId: null, chatId: 'c1' }), false);
});

test('toastLifetime prefers the per-push ttl and falls back to the stack default', () => {
    assert.equal(toastLifetime({ ttlMs: 9000 }, 6500), 9000);
    assert.equal(toastLifetime({}, 6500), 6500);
    assert.equal(toastLifetime(null, 6500), 6500);
    assert.equal(toastLifetime({ ttlMs: 0 }, 6500), 6500);
    assert.equal(toastLifetime({ ttlMs: 'soon' }, 6500), 6500);
});

test('shouldPulseReturn pulses only when the cues are on and the map stays open', () => {
    const posted = { posted: true, index: 3 };
    assert.equal(shouldPulseReturn({ settings: { map: { closeOnTravel: false } }, posted }), true);
    assert.equal(shouldPulseReturn({ settings: { map: { closeOnTravel: false, arrivalFeedback: false } }, posted }), false);
    // Close-on-travel (the default) closes the map: nothing to pulse at.
    assert.equal(shouldPulseReturn({ settings: { map: {} }, posted }), false);
    assert.equal(shouldPulseReturn({ settings: { map: { closeOnTravel: false } }, posted: null }), true);
});

test('the map panel exposes pulseArrival and the CSS ships the pulse plus a reduced-motion opt-out', () => {
    const panel = readFileSync(new URL('../src/ui/map-panel.js', import.meta.url), 'utf8');
    const shell = readFileSync(new URL('../src/ui/shell.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(panel, /pulseArrival: \(payload\) => pulseArrival\(state, payload \?\? \{\}\)/);
    assert.match(shell, /panelRef\?\.pulseArrival\?\.\(\{ key: summary\?\.key \?\? null \}\)/);
    assert.match(css, /\[data-neoterra-map-return\]\.is-pulsing\s*\{[^}]*animation:/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\[data-neoterra-map-return\]\.is-pulsing\s*\{[^}]*animation:\s*none/);
    assert.match(css, /\[data-neoterra-map-return\]\[data-neoterra-arrival-cue\]::after/);
});

function fakeButton() {
    const classes = new Set();
    const listeners = new Map();
    return {
        dataset: {},
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
        },
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: (type) => listeners.delete(type),
        fire: (type) => listeners.get(type)?.(),
        listenerCount: () => listeners.size,
    };
}

test('pulseReturnButton fires once per arrival key and never on a repeat', () => {
    const button = fakeButton();
    const first = pulseReturnButton(button, { key: 'travel:a:b:1', now: 1 });
    assert.equal(first.pulsed, true);
    assert.equal(first.state.key, 'travel:a:b:1');
    assert.equal(button.classList.contains('is-pulsing'), true);
    // The same arrival (double refresh) must not pulse again.
    const repeat = pulseReturnButton(button, { key: 'travel:a:b:1', previous: first.state, now: 2 });
    assert.equal(repeat.pulsed, false);
    assert.equal(repeat.state.key, 'travel:a:b:1');
    // A new arrival pulses and replaces the key.
    const next = pulseReturnButton(button, { key: 'travel:b:c:2', previous: first.state, now: 3 });
    assert.equal(next.pulsed, true);
    assert.equal(next.state.key, 'travel:b:c:2');
});

test('pulseReturnButton clears on animationend or the timeout fallback', () => {
    const button = fakeButton();
    const first = pulseReturnButton(button, { key: 'k1', now: 1 });
    assert.equal(button.classList.contains('is-pulsing'), true);
    button.fire('animationend');
    assert.equal(button.classList.contains('is-pulsing'), false);
    assert.equal(button.listenerCount(), 0);

    // The dispose path calls `clear` directly; it is idempotent.
    const second = fakeButton();
    const result = pulseReturnButton(second, { key: 'k2', now: 2 });
    result.clear();
    assert.equal(second.classList.contains('is-pulsing'), false);
    result.clear();
    // A missing button never consumes the key.
    const missing = pulseReturnButton(null, { key: 'k3' });
    assert.equal(missing.pulsed, false);
    assert.equal(missing.state, null);
});

test('pulseReturnButton shows the static badge instead of animating under reduced motion', () => {
    const button = fakeButton();
    const result = pulseReturnButton(button, { key: 'k1', reducedMotion: true, now: 1 });
    assert.equal(result.pulsed, true);
    assert.equal(button.dataset.neoterraArrivalCue, 'New arrival');
    assert.equal(button.classList.contains('is-pulsing'), false);
    assert.equal(button.listenerCount(), 0);
});

test('the sidebar card carries destination, district, slot, turns, and encounter', () => {
    const state = makeState({
        flags: TRAVEL_FLAGS,
        encounter: { locationId: 'loc.b', characterIds: ['npc.ghost'], threatNames: [], source: 'travel' },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state });
    const card = buildArrivalCard({ summary, introText: 'You walk in.\nThe door shuts.' });
    assert.ok(card);
    assert.equal(card.key, summary.key);
    assert.equal(card.destination, 'Docks');
    assert.equal(card.district, 'West');
    assert.equal(card.timeSlot, 'Evening');
    assert.equal(card.turns, 2);
    assert.equal(card.hasEncounter, true);
    assert.equal(card.encounterLine, 'Ghost is present.');
    assert.equal(card.introText, 'You walk in.\nThe door shuts.');

    const markup = renderArrivalCardMarkup(card);
    assert.match(markup, /data-neoterra-arrival-summary/);
    assert.match(markup, /data-arrival-key="[^"]+"/);
    assert.match(markup, /Docks/);
    assert.match(markup, /West/);
    assert.match(markup, /Evening/);
    assert.match(markup, /2 turns/);
    assert.match(markup, /Ghost is present/);
    // The prose stays reachable and the spike selector still resolves.
    assert.match(markup, /<details data-neoterra-map-intro>/);
    assert.match(markup, /You walk in\.<br>The door shuts\./);
    // Dismiss remains the same selector as before.
    assert.match(markup, /data-neoterra-intro-dismiss/);
});

test('a peaceful arrival card says no hostiles and omits the prose disclosure', () => {
    const summary = buildArrivalSummary({ state: makeState({ flags: TRAVEL_FLAGS }) });
    const card = buildArrivalCard({ summary });
    assert.equal(card.hasEncounter, false);
    assert.equal(card.encounterLine, 'No hostiles detected.');
    const markup = renderArrivalCardMarkup(card);
    assert.match(markup, /No hostiles detected/);
    assert.doesNotMatch(markup, /<details/);
    assert.equal(buildArrivalCard({ summary: null }), null);
    assert.equal(renderArrivalCardMarkup(null), '');
});

test('dismissing hides only that arrival and the next travel shows again', () => {
    const context = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    const summary = buildArrivalSummary({ state: makeState({ flags: TRAVEL_FLAGS }) });
    assert.equal(readArrivalDismissedKey(context), null);
    assert.equal(writeArrivalDismissedKey(context, summary.key), true);
    assert.equal(readArrivalDismissedKey(context), summary.key);
    assert.equal(buildArrivalCard({ summary, dismissedKey: readArrivalDismissedKey(context) }), null);

    // A later trip has a different key, so the new card shows untouched.
    const nextSummary = { ...summary, key: 'travel:loc.b:loc.a:999' };
    const nextCard = buildArrivalCard({ summary: nextSummary, dismissedKey: readArrivalDismissedKey(context) });
    assert.ok(nextCard);
    assert.equal(nextCard.key, 'travel:loc.b:loc.a:999');

    // The write is scoped to neoterra.ui.map.
    assert.equal(context.chatMetadata.neoterra.ui.map.arrivalDismissedKey, summary.key);
});

test('the arrival prose persists per chat for the reopen path', () => {
    const context = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    assert.equal(readArrivalIntro(context), null);
    assert.equal(writeArrivalIntro(context, 'travel:a:b:1', 'Full prose.'), true);
    assert.equal(readArrivalIntro(context), 'Full prose.');
    assert.equal(readArrivalIntro(context, 'travel:a:b:1'), 'Full prose.');
    // A different arrival never shows the previous prose.
    assert.equal(readArrivalIntro(context, 'travel:b:c:2'), null);
    assert.equal(context.chatMetadata.neoterra.ui.map.lastArrivalIntro.text, 'Full prose.');
    // The canonical metadata slot keeps its schema marker.
    assert.equal(context.chatMetadata.neoterra.schemaVersion, 1);
});

test('a stored arrival keeps its arrival-time facts after the world moves on', () => {
    const context = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    const arrivalState = makeState({
        flags: TRAVEL_FLAGS,
        timeOfDay: 'evening',
        encounter: { locationId: 'loc.b', characterIds: ['npc.ghost'], threatNames: [], source: 'travel' },
        characters: { 'npc.ghost': { displayName: 'Ghost' } },
    });
    const summary = buildArrivalSummary({ state: arrivalState });
    writeArrivalIntro(context, summary.key, 'You arrive.', {
        timeSlot: summary.timeSlot,
        district: summary.district,
        turns: summary.turns,
        hasEncounter: summary.hasEncounter,
        hostiles: summary.hostiles,
    });
    // A later turn changes the clock and clears the encounter.
    const laterState = makeState({ flags: TRAVEL_FLAGS, timeOfDay: 'night', encounter: null });
    const laterSummary = buildArrivalSummary({ state: laterState });
    assert.notEqual(laterSummary.timeSlot, summary.timeSlot);
    const snapshot = readArrivalSnapshot(context, laterSummary.key);
    assert.ok(snapshot);
    const card = buildArrivalCard({ summary: laterSummary, snapshot });
    assert.equal(card.timeSlot, 'Evening');
    assert.equal(card.turns, 2);
    assert.equal(card.hasEncounter, true);
    assert.equal(card.encounterLine, 'Ghost is present.');
    assert.equal(card.introText, 'You arrive.');
});

test('dismissArrival persists the key and reports a failed write', () => {
    const context = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    const state = makeState({ flags: TRAVEL_FLAGS });
    const key = dismissArrival(context, state);
    assert.equal(key, `travel:loc.a:loc.b:${LAST_AT}`);
    assert.equal(readArrivalDismissedKey(context), key);
    assert.equal(dismissArrival(context, makeState()), null);
    // A metadata-less context cannot persist, so the card must stay.
    assert.equal(dismissArrival(null, state), null);
});

test('arrivalFeedback:false suppresses the card in the panel', () => {
    const panel = readFileSync(new URL('../src/ui/map-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /state\.settings\?\.arrivalFeedback === false[\s\S]{0,80}\? null/);
    assert.match(panel, /state\.settings\?\.arrivalFeedback !== false && state\.lastIntro\?\.text/);
});

test('no card when the chat has no travel history', () => {
    const state = makeState();
    assert.equal(buildArrivalSummary({ state }), null);
    assert.equal(buildArrivalCard({ summary: null, introText: 'orphan prose' }), null);
});
