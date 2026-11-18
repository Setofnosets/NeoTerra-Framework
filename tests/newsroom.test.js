import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    NEWSROOM_MAX_EDITIONS,
    NEWSROOM_MAX_HEADLINES,
    buildDeterministicEdition,
    buildNewspaperView,
    deriveNewspaperStyle,
    newspaperSettings,
    selectNewsworthyEvents,
    validateEdition,
} from '../src/data/newsroom.js';
import { createNewsroomFlow, editionDue } from '../src/flows/newsroom.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { createWorldState } from '../src/state/world-state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const seasonS4 = readJson('data/seasons/s4.json');
const seasonS1Dark = readJson('data/seasons/s1dark.json');

function seed(season = seasonS4) {
    return createWorldState({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'newsroom-test',
        now: 123,
    });
}

function withEvents(state, events) {
    return {
        ...state,
        meta: { ...state.meta, turn: events.length },
        recentEvents: events.map((event, index) => ({
            turn: index + 1,
            date: state.meta.inGameDate,
            actors: [],
            locationId: 'central-plaza',
            tags: [],
            ...event,
        })),
    };
}

function storeOf(state) {
    let current = state;
    return {
        get: () => current,
        replace: (next) => {
            current = next;
            return next;
        },
    };
}

const SETTINGS = Object.freeze({
    newspaper: { enabled: true, everyDays: 3, minEvents: 6, maxHeadlines: 6, maxEditions: 20 },
    contentGate: 'full',
});

test('newspaper settings normalize and clamp', () => {
    const defaults = newspaperSettings({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.style, 'auto');
    assert.equal(defaults.everyDays, 3);
    assert.equal(defaults.minEvents, 6);
    assert.equal(defaults.maxHeadlines, 6);
    assert.equal(defaults.maxEditions, undefined);

    const clamped = newspaperSettings({
        newspaper: { style: 'nope', everyDays: 0, minEvents: 999, maxHeadlines: 99, maxEditions: 99 },
    });    assert.equal(clamped.style, 'auto');
    assert.equal(clamped.everyDays, 1);
    assert.equal(clamped.minEvents, 50);
    assert.equal(clamped.maxHeadlines, NEWSROOM_MAX_HEADLINES);
    assert.equal(clamped.maxEditions, undefined);
});

test('style derives tabloid for villain POV and underground for a resistance arc', () => {
    assert.equal(
        deriveNewspaperStyle({ state: seed(seasonS1Dark), season: seasonS1Dark, settings: SETTINGS }),
        'tabloid',
    );
    assert.equal(
        deriveNewspaperStyle({ state: seed(), season: seasonS4, settings: SETTINGS }),
        'broadsheet',
    );
    assert.equal(
        deriveNewspaperStyle({
            state: { arc: 'post-victory', ending: { path: 'resistance' }, playerRole: 'villain' },
            season: seasonS1Dark,
            settings: SETTINGS,
        }),
        'underground',
    );
    assert.equal(
        deriveNewspaperStyle({
            state: seed(),
            season: seasonS4,
            settings: { newspaper: { style: 'tabloid' } },
        }),
        'tabloid',
    );
});

test('no events means no edition', () => {
    assert.equal(buildDeterministicEdition({ state: seed(), season: seasonS4, settings: SETTINGS }), null);
});

test('six events produce one edition grouped into sections', () => {
    const state = withEvents(seed(), [
        { summary: 'A patrol vanishes.', tags: ['crime'], headline: 'PATROL VANISHES' },
        { summary: 'Clarity ships arms through the docks.', tags: ['faction', 'faction:clarity'] },
        { summary: 'A hero is seen downtown.', tags: ['hero'], headline: 'HERO SPOTTED' },
        { summary: 'A new clinic opens.', tags: ['business'] },
        { summary: 'A gala fills the towers.', tags: ['society'] },
        { summary: 'Smoke rises off-screen.', tags: ['offscreen'] },
    ]);
    const edition = buildDeterministicEdition({ state, season: seasonS4, settings: SETTINGS });
    assert.ok(edition);
    assert.equal(edition.source, 'deterministic');
    assert.equal(edition.date, state.meta.inGameDate);
    assert.equal(edition.style, 'broadsheet');
    assert.match(edition.dateline, /EDITION/);
    assert.equal(edition.headlines.length, 6);
    assert.deepEqual(
        edition.headlines.map((headline) => headline.section),
        ['crime', 'faction', 'hero', 'business', 'society', 'offscreen'],
    );
    assert.equal(edition.headlines[0].title, 'PATROL VANISHES');
    assert.equal(edition.headlines[0].eventTurn, 1);
    assert.equal(validateEdition(edition).ok, true);
});

test('headline ranking is headline-first, then importance, then recency', () => {
    const state = withEvents(seed(), [
        { summary: 'Routine note.', tags: [] },
        { summary: 'Arms move.', tags: ['faction:clarity'] },
        { summary: 'Murder in the plaza.', tags: ['crime'] },
        { summary: 'A hero arrives.', tags: ['hero'], headline: 'HERO ARRIVES' },
    ]);
    const events = selectNewsworthyEvents(state, { sinceTurn: -1, limit: 10 });
    assert.equal(events[0].headline, 'HERO ARRIVES');
    assert.equal(events[1].tags[0], 'crime');
});

test('the deterministic builder is snapshot-stable and caps headlines', () => {
    const state = withEvents(seed(), Array.from({ length: 10 }, (_, index) => ({
        summary: `Event ${index + 1} happens.`,
        tags: index % 2 === 0 ? ['crime'] : ['society'],
    })));
    const first = buildDeterministicEdition({
        state,
        season: seasonS4,
        settings: { ...SETTINGS, newspaper: { ...SETTINGS.newspaper, maxHeadlines: 3 } },
    });
    const second = buildDeterministicEdition({
        state,
        season: seasonS4,
        settings: { ...SETTINGS, newspaper: { ...SETTINGS.newspaper, maxHeadlines: 3 } },
    });
    assert.deepEqual(first, second);
    assert.equal(first.headlines.length, 3);
});

test('the deterministic builder passes through the content gate', () => {
    const state = withEvents(seed(), [
        { summary: 'Graphic violence erupts downtown. Witnesses flee.', tags: ['crime'], headline: 'Graphic violence downtown' },
        { summary: 'A quiet market opens.', tags: ['business'] },
        { summary: 'A patrol moves.', tags: ['faction'] },
        { summary: 'A gala begins.', tags: ['society'] },
        { summary: 'A hero waves.', tags: ['hero'] },
        { summary: 'Rumours spread.', tags: ['offscreen'] },
    ]);
    const edition = buildDeterministicEdition({
        state,
        season: seasonS4,
        settings: { ...SETTINGS, contentGate: 'strict' },
    });
    assert.ok(edition);
    assert.equal(edition.headlines.some((entry) => /Graphic violence/i.test(entry.title)), false);
    assert.equal(edition.headlines.some((entry) => /Graphic violence/i.test(entry.lede)), false);
    assert.ok(edition.headlines.length >= 3);
});

test('cadence is off when disabled, held, ended, or nothing is new', () => {
    const state = withEvents(seed(), Array.from({ length: 6 }, () => ({ summary: 'Something happens.' })));
    assert.equal(editionDue(state, SETTINGS).due, true);
    assert.equal(editionDue(state, { newspaper: { enabled: false } }).reason, 'disabled');

    const held = {
        ...state,
        flags: { clock: { hold: { active: true } } },
    };
    assert.equal(editionDue(held, SETTINGS).reason, 'time-held');

    const ended = { ...state, ending: { status: 'epilogue' } };
    assert.equal(editionDue(ended, SETTINGS).reason, 'ending');

    const fresh = { ...state, recentEvents: [] };
    assert.equal(editionDue(fresh, SETTINGS).reason, 'no-events');

    const few = { ...state, recentEvents: state.recentEvents.slice(0, 2) };
    assert.equal(editionDue(few, SETTINGS).reason, 'not-due');
});

test('elapsed days trigger an edition even with few new events', () => {
    const state = withEvents(seed(), [{ summary: 'A small thing happens.' }]);
    const later = {
        ...state,
        meta: { ...state.meta, inGameDate: '2043-07-01', turn: 10 },
        flags: {
            newsroom: {
                lastEditionDate: state.meta.inGameDate,
                lastEditionTurn: 0,
                editions: [],
            },
        },
    };
    const decision = editionDue(later, SETTINGS);
    assert.equal(decision.due, true);
    assert.equal(decision.reason, 'days');
});

test('the publisher writes one edition and is idempotent on reload', async () => {
    const state = withEvents(seed(), Array.from({ length: 6 }, (_, index) => ({
        summary: `Story ${index + 1}.`,
        tags: index === 0 ? ['crime'] : [],
    })));
    const store = storeOf(state);
    const flow = createNewsroomFlow({ store, getSettings: () => SETTINGS });
    const first = await flow.publish({ chatId: 'newsroom-test', isCurrent: () => true });
    assert.equal(first.ok, true, first.error ?? first.reason);
    assert.equal(store.get().flags.newsroom.editions.length, 1);

    // A second call with no elapsed day and no new events does nothing.
    const second = await flow.publish({ chatId: 'newsroom-test', isCurrent: () => true });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'no-events');
    assert.equal(store.get().flags.newsroom.editions.length, 1);
});

test('the publisher is a no-op when disabled, held, or the chat changed', async () => {
    const state = withEvents(seed(), Array.from({ length: 6 }, () => ({ summary: 'Something happens.' })));
    const disabled = createNewsroomFlow({ store: storeOf(state), getSettings: () => ({}) });
    assert.equal((await disabled.publish()).reason, 'disabled');

    const heldStore = storeOf({
        ...state,
        flags: { clock: { hold: { active: true } } },
    });
    const held = createNewsroomFlow({ store: heldStore, getSettings: () => SETTINGS });
    assert.equal((await held.publish({ isCurrent: () => true })).reason, 'time-held');
    assert.equal(heldStore.get().flags.newsroom, undefined);

    const warnedStore = storeOf(state);
    const changed = createNewsroomFlow({ store: warnedStore, getSettings: () => SETTINGS });
    assert.equal(
        (await changed.publish({ chatId: 'a', isCurrent: () => false })).reason,
        'chat-changed',
    );
    assert.equal(warnedStore.get().flags.newsroom, undefined);
});

test('a second publish on the same in-game date is a no-op', async () => {
    const state = withEvents(seed(), Array.from({ length: 6 }, () => ({ summary: 'Something happens.' })));
    const dated = {
        ...state,
        flags: {
            newsroom: {
                lastEditionDate: state.meta.inGameDate,
                lastEditionTurn: 0,
                editions: [],
            },
        },
    };
    const store = storeOf(dated);
    const flow = createNewsroomFlow({ store, getSettings: () => SETTINGS });
    const result = await flow.publish({ isCurrent: () => true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'duplicate-date');
    assert.equal(store.get(), dated, 'the store document is untouched');
});

test('a chat switch during the agent call writes nothing', async () => {
    const state = withEvents(seed(), Array.from({ length: 6 }, () => ({ summary: 'Something happens.' })));
    const store = storeOf(state);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const later = {
        meta: { ...state.meta, turn: 7 },
        recentEvents: [...state.recentEvents, {
            turn: 7,
            date: state.meta.inGameDate,
            summary: 'A late event.',
            actors: [],
            locationId: 'central-plaza',
            tags: [],
        }],
    };
    const agent = {
        run: async () => {
            // The world moved on, then the chat changed, while the model ran.
            Object.assign(store, { get: () => later });
            await gate;
            return {
                masthead: 'THE NEO TERRA CHRONICLE',
                dateline: 'NEO TERRA — EVENING EDITION',
                headlines: [{ title: 'Late', section: 'general' }],
            };
        },
    };
    let current = true;
    const flow = createNewsroomFlow({
        store,
        getSettings: () => SETTINGS,
        agent,
    });
    const pending = flow.publish({ chatId: 'a', isCurrent: () => current });
    current = false;
    release();
    const result = await pending;
    assert.equal(result.reason, 'chat-changed');
    assert.equal(store.get().flags?.newsroom, undefined);
});

test('the reducer caps the archive at 20 editions and dedupes by date', () => {
    let state = seed();
    for (let index = 0; index < 25; index += 1) {
        const date = `2037-03-${String(index + 1).padStart(2, '0')}`;
        state = applyWorldEvent(state, {
            type: 'PUBLISH_EDITION',
            edition: {
                id: `edition:${index}`,
                date,
                turn: index,
                masthead: 'THE NEO TERRA CHRONICLE',
                dateline: 'NEO TERRA — EVENING EDITION',
                style: 'broadsheet',
                source: 'deterministic',
                headlines: [{ title: `Story ${index}`, lede: 'Text.', section: 'general', tone: 'neutral' }],
            },
        });
    }
    assert.equal(state.flags.newsroom.editions.length, NEWSROOM_MAX_EDITIONS);
    assert.equal(state.flags.newsroom.lastEditionDate, '2037-03-25');
    const before = state;
    const duplicate = applyWorldEvent(state, {
        type: 'PUBLISH_EDITION',
        edition: {
            id: 'edition:dup',
            date: '2037-03-25',
            turn: 25,
            masthead: 'THE NEO TERRA CHRONICLE',
            dateline: 'NEO TERRA — EVENING EDITION',
            style: 'broadsheet',
            source: 'deterministic',
            headlines: [{ title: 'Duplicate', lede: '', section: 'general', tone: 'neutral' }],
        },
    });
    assert.equal(duplicate, before, 'a duplicate date returns the same document');
});

test('the reducer rejects an invalid edition without changing state', () => {
    const state = seed();
    assert.throws(
        () => applyWorldEvent(state, {
            type: 'PUBLISH_EDITION',
            edition: { masthead: '', dateline: '', style: 'nope', source: 'x', headlines: [] },
        }),
        /PUBLISH_EDITION rejected/,
    );
    assert.equal(state.flags.newsroom, undefined);
});

test('the view model is newest first and exposes at most two teaser headlines', () => {
    const state = {
        ...seed(),
        flags: {
            newsroom: {
                lastEditionDate: '2037-03-05',
                lastEditionTurn: 5,
                editions: [
                    {
                        id: 'a',
                        date: '2037-03-02',
                        turn: 2,
                        masthead: 'A',
                        dateline: 'A',
                        style: 'broadsheet',
                        source: 'deterministic',
                        headlines: [{ title: 'Old', lede: '', section: 'general', tone: 'neutral' }],
                    },
                    {
                        id: 'b',
                        date: '2037-03-05',
                        turn: 5,
                        masthead: 'B',
                        dateline: 'B',
                        style: 'broadsheet',
                        source: 'deterministic',
                        headlines: [
                            { title: 'New 1', lede: '', section: 'general', tone: 'neutral' },
                            { title: 'New 2', lede: '', section: 'general', tone: 'neutral' },
                            { title: 'New 3', lede: '', section: 'general', tone: 'neutral' },
                        ],
                    },
                ],
            },
        },
    };
    const view = buildNewspaperView(state, SETTINGS);
    assert.equal(view.enabled, true);
    assert.equal(view.latest.id, 'b');
    assert.deepEqual(view.editions.map((edition) => edition.id), ['b', 'a']);
    assert.deepEqual(view.headlines.map((headline) => headline.title), ['New 1', 'New 2']);
});

test('an old world without flags.newsroom works', () => {
    const state = seed();
    assert.equal(state.flags.newsroom, undefined);
    const view = buildNewspaperView(state, SETTINGS);
    assert.equal(view.hasNews, false);
    assert.equal(view.latest, null);
    assert.deepEqual(view.headlines, []);
    assert.equal(editionDue(state, SETTINGS).due, false);
});
