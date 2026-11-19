import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildJournalEntries,
    buildJournalMarkdown,
    buildJournalRecap,
    filterJournalEntries,
    renderJournalMarkup,
} from '../src/ui/journal.js';

const season = {
    id: 's1',
    title: 'Season 1 — Emergence',
    premise: 'The city wakes.',
    canonBeats: [
        { id: 's1.opening.first-move', title: 'First Move', act: 'opening' },
    ],
};

function worldState(overrides = {}) {
    return {
        seasonId: 's1',
        meta: { turn: 4, inGameDate: '2031-04-12', timeOfDay: 'evening' },
        scene: { locationId: 'plaza' },
        locations: { plaza: { name: 'Central Plaza' }, docks: { name: 'Docks' } },
        characters: {
            a: { charId: 'a', displayName: 'A' },
            b: { charId: 'b', displayName: 'B' },
        },
        beats: {
            's1.opening.first-move': { status: 'done', turn: 2 },
        },
        relationships: [
            { a: 'a', b: 'b', type: 'ally', affinity: 10, tension: 0, notes: ['They agreed to work together.'] },
        ],
        recentEvents: [
            { turn: 1, summary: 'The season begins.' },
            { turn: 3, summary: 'A rumor spreads.', tags: ['offscreen', 'tick'], locationId: 'docks' },
        ],
        flags: {
            travel: { history: [{ from: 'plaza', to: 'docks', at: 3 }] },
            newsroom: { editions: [{ date: '2031-04-12', turn: 4, headlines: ['Docks reopen'] }] },
        },
        ...overrides,
    };
}

test('entries come from events, travel, beats, relationships, and newspapers', () => {
    const entries = buildJournalEntries(worldState(), season);
    const types = new Set(entries.map((entry) => entry.type));
    for (const type of ['event', 'rumor', 'travel', 'beat', 'relationship', 'newspaper']) {
        assert.equal(types.has(type), true, `expected a ${type} entry`);
    }
    const ids = entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    // Sorted by turn.
    const turns = entries.map((entry) => entry.turn).filter((turn) => Number.isFinite(turn));
    assert.deepEqual(turns, [...turns].sort((a, b) => a - b));
    assert.equal(entries.find((entry) => entry.type === 'travel').text, 'Central Plaza → Docks');
});

test('a repeated build is stable and does not duplicate entries', () => {
    const first = buildJournalEntries(worldState(), season);
    const second = buildJournalEntries(worldState(), season);
    assert.deepEqual(second.map((entry) => entry.id), first.map((entry) => entry.id));
});

test('filtering handles type, text query, and location', () => {
    const entries = buildJournalEntries(worldState(), season);
    assert.equal(filterJournalEntries(entries, { type: 'travel' }).length, 1);
    assert.equal(filterJournalEntries(entries, { query: 'rumor' }).length, 1);
    assert.equal(filterJournalEntries(entries, { query: 'DOCKS' }).length >= 1, true);
    const atDocks = filterJournalEntries(entries, { locationId: 'docks' });
    assert.equal(atDocks.length >= 1, true);
    assert.equal(atDocks.every((entry) => !entry.locationId || entry.locationId === 'docks'), true);
});

test('the recap prefers a Lore recap and falls back to the deterministic paragraph', () => {
    const state = worldState();
    assert.match(buildJournalRecap(state, season), /The season begins/);
    state.flags.lore = { recap: 'Previously, the city changed.' };
    assert.equal(buildJournalRecap(state, season), 'Previously, the city changed.');
});

test('markdown export is readable and includes the timeline', () => {
    const entries = buildJournalEntries(worldState(), season);
    const markdown = buildJournalMarkdown({
        season,
        recap: 'Previously on…',
        entries,
    });
    assert.match(markdown, /^# Season 1/);
    assert.match(markdown, /## Previously on/);
    assert.match(markdown, /## Timeline/);
    assert.match(markdown, /A rumor spreads/);
});

test('journal markup renders filters and entries', () => {
    const entries = buildJournalEntries(worldState(), season);
    const markup = renderJournalMarkup({ recap: 'Recap', entries, type: 'all', query: '' });
    assert.match(markup, /data-neoterra-journal/);
    assert.match(markup, /data-neoterra-journal-export/);
    assert.match(markup, /data-neoterra-journal-filter="travel"/);
    assert.match(markup, /A rumor spreads/);
});
