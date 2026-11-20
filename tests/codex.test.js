import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    backfillCardProfiles,
    buildCodexView,
    buildFormSwapOptions,
    buildPlayAsConfirmation,
    buildPlayAsOptions,
    gateCardProfile,
    performFormSwap,
    performPlayAs,
    performPlayAsCustom,
    rederiveCardFacets,
    renderCodexMarkup,
    renderPlayAsDialog,
} from '../src/ui/codex.js';
import {
    buildAgentConfigMarkup,
    buildCharacterLimitMarkup,
} from '../src/ui/settings.js';
import { buildFormIndex } from '../src/data/forms.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { createWorldStateStore } from '../src/state/store.js';
import { cloneDefaults } from '../src/core/defaults.js';
import { createGoalInference, ensurePlayerGoals } from '../src/agents/goal-inference.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1700000000000;

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const profiles = readJson('data/characters/profiles.json').profiles;
const seasons = {
    s1: readJson('data/seasons/s1.json'),
    s1dark: readJson('data/seasons/s1dark.json'),
    sandbox: readJson('data/seasons/sandbox.json'),
};
const CONTEXT = { registry, factions, locations, formGroups, formRules };
const CAROL = 's1dark.carol.bleeding-heart';
const CAROL_CLEANSED = 's1dark.carol.cleansed.bleeding.heart';

function makeStore(seasonId = 's1dark', player = { identity: 'custom' }) {
    const metadata = {};
    const store = createWorldStateStore({
        metadata,
        chatId: `codex-test-${seasonId}`,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season: seasons[seasonId],
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: `codex-test-${seasonId}`,
        player,
        now: NOW,
    });
    return store;
}

function mutate(store, event) {
    const next = applyWorldEvent(store.get(), event, CONTEXT);
    store.replace(next);
    return next;
}

function viewFor(store, seasonId = 's1dark', extra = {}) {
    return buildCodexView({
        state: store.get(),
        season: seasons[seasonId],
        registry,
        formGroups,
        formRules,
        ...extra,
    });
}

test('codex lists the season roster, marks the played character, and filters', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    const view = viewFor(store);
    assert.equal(view.total, seasons.s1dark.roster.length);
    assert.equal(view.sandbox, false);
    const carol = view.items.find((item) => item.characterId === CAROL);
    assert.equal(carol.isPlayer, true);
    assert.equal(carol.displayName, 'Carol Fate');

    const filtered = viewFor(store, 's1dark', {
        filters: { query: 'carol' },
    });
    assert.ok(filtered.filtered.length >= 1);
    assert.ok(filtered.filtered.every((item) => item.searchText.includes('carol')));

    const villains = viewFor(store, 's1dark', {
        filters: { side: 'villain' },
    });
    assert.ok(villains.filtered.length > 0);
    assert.ok(villains.filtered.every((item) => item.side === 'villain'));

    const byLocation = viewFor(store, 's1dark', {
        filters: { location: 'clarity-hq' },
    });
    assert.ok(byLocation.filtered.length >= 1);
    assert.ok(byLocation.filtered.every((item) => item.locationId === 'clarity-hq'));
});

test('codex reflects a declared transformation immediately', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    const next = mutate(store, {
        type: 'TRANSFORM',
        characterId: CAROL,
        formId: CAROL_CLEANSED,
    });
    assert.equal(next.characters[CAROL].formId, CAROL_CLEANSED);
    const view = viewFor(store);
    const carol = view.items.find((item) => item.characterId === CAROL);
    assert.equal(carol.formId, CAROL_CLEANSED);
    assert.equal(view.selected.characterId, CAROL);
    assert.equal(view.selected.lineage.current, CAROL_CLEANSED);
    assert.ok(view.selected.lineage.members.some((member) => member.active && member.formId === CAROL_CLEANSED));
    const markup = renderCodexMarkup(view);
    assert.match(markup, /Form lineage/);
    assert.match(markup, /Active/);
});

test('illegal form swaps are rejected with the reducer reason', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    const view = viewFor(store);
    const formIndex = buildFormIndex(registry, formGroups);
    const options = buildFormSwapOptions({
        state: store.get(),
        characterId: CAROL,
        formIndex,
        formRules,
    });
    assert.ok(view.selected.swap.options.some((option) => option.formId === CAROL_CLEANSED));

    assert.throws(
        () => performFormSwap({
            store,
            context: CONTEXT,
            characterId: CAROL,
            formId: 's1dark.heart.attack.knighted.cyber.sakura',
        }),
        /not in the character's form group/,
    );
    assert.throws(
        () => performFormSwap({
            store,
            context: CONTEXT,
            characterId: CAROL,
            formId: CAROL,
        }),
        /already active/,
    );
    assert.equal(options.group.id, 's1dark.carol');
    assert.equal(store.get().characters[CAROL].formId, CAROL);
});

test('bad-end badges and stored epilogues are read-only and escaped', () => {
    const store = makeStore('s1dark', { identity: 'custom' });
    mutate(store, {
        type: 'RECORD_BAD_END',
        characterId: CAROL,
        badEndType: 'identity-loss',
        severity: 'major',
        cause: '<script>alert(1)</script>',
        epilogueText: '<b>Ended</b>',
        playableAs: true,
        continuityKey: `s1dark:${CAROL}`,
    });
    const view = viewFor(store, 's1dark', { selectedId: CAROL });
    assert.equal(view.selected.badEnd.type, 'identity-loss');
    assert.equal(view.selected.badEnd.epilogueText, '<b>Ended</b>');
    const markup = renderCodexMarkup(view);
    assert.match(markup, /Bad end: identity-loss/);
    assert.match(markup, /&lt;b&gt;Ended&lt;\/b&gt;/);
    assert.match(markup, /aria-readonly="true"/);
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('Play-as lists roster characters, explains the POV/NPC swap, and is reversible', () => {
    const store = makeStore('s1dark', { identity: 'custom' });
    const options = buildPlayAsOptions({
        state: store.get(),
        season: seasons.s1dark,
        registry,
    });
    assert.equal(options.sandbox, false);
    assert.deepEqual(
        options.options.map((option) => option.characterId).sort(),
        seasons.s1dark.roster.map((member) => member.characterId).sort(),
    );
    const carol = options.options.find((option) => option.characterId === CAROL);
    assert.equal(carol.eligible, true);
    const confirmation = buildPlayAsConfirmation({ option: carol, state: store.get() });
    assert.match(confirmation, /narration/i);
    assert.match(confirmation, /NPC pool/i);
    // A same-location swap says the POV stays; a cross-location swap says the
    // scene moves (covered in the dedicated test below).
    assert.match(confirmation, /scene moves to|POV stays at/i);
    assert.match(confirmation, /clarity-hq|Clarity/i);

    const next = performPlayAs({
        store,
        context: CONTEXT,
        season: seasons.s1dark,
        registry,
        characterId: CAROL,
    });
    assert.equal(next.ok, true);
    assert.equal(next.changed, 'identity');
    assert.equal(next.locationId, next.state.scene.locationId);
    const nextState = next.state;
    assert.equal(nextState.player.identity, 'canon');
    assert.equal(nextState.player.characterId, CAROL);
    assert.equal(nextState.characters[CAROL].controlledBy, 'player');
    assert.equal(nextState.flags.nonCanon, false);

    const custom = performPlayAsCustom({ store, context: CONTEXT });
    assert.equal(custom.player.identity, 'custom');
    assert.equal(custom.characters[CAROL].controlledBy, 'npc');
    assert.equal(custom.flags.nonCanon, false);
});

test('Sandbox Play-as seeds any registry character and marks them non-canon', () => {
    const store = makeStore('sandbox', { identity: 'custom' });
    const entry = registry.entries.find(
        (candidate) => candidate.bundle !== true && candidate.seasonId === 's1',
    );
    assert.ok(entry);
    const view = viewFor(store, 'sandbox');
    assert.equal(view.sandbox, true);
    assert.ok(view.items.some((item) => item.characterId === entry.id));
    assert.ok(view.items.every((item) => item.nonCanon === true));
    const options = buildPlayAsOptions({
        state: store.get(),
        season: seasons.sandbox,
        registry,
    });
    assert.ok(options.options.length > seasons.sandbox.roster.length);
    const option = options.options.find((candidate) => candidate.characterId === entry.id);
    assert.equal(option.eligible, true);
    assert.equal(option.needsSeed, true);

    const result = performPlayAs({
        store,
        context: CONTEXT,
        season: seasons.sandbox,
        registry,
        characterId: entry.id,
    });
    assert.equal(result.ok, true);
    // The registry entry was absent from the roster, so this call seeded it.
    assert.equal(result.changed, 'seeded');
    assert.equal(result.locationId, result.state.scene.locationId);
    const next = result.state;
    assert.equal(next.player.characterId, entry.id);
    assert.equal(next.characters[entry.id].controlledBy, 'player');
    assert.equal(next.flags.nonCanon, true);
    const sandboxView = viewFor(store, 'sandbox', { selectedId: entry.id });
    assert.equal(sandboxView.selected.isPlayer, true);
    assert.equal(sandboxView.selected.nonCanon, true);
    const markup = renderCodexMarkup(sandboxView);
    assert.match(markup, /Non-canon character/);
    assert.match(markup, /role="alert"/);
});

test('Play-as confirmation names the location the POV moves to', () => {
    const store = makeStore('s1dark', { identity: 'custom' });
    const options = buildPlayAsOptions({
        state: store.get(),
        season: seasons.s1dark,
        registry,
    });
    const aurelia = options.options.find(
        (option) => option.characterId === 's1dark.aurelia.season-dark-version',
    );
    assert.equal(aurelia.locationId, 'old-subway');
    const confirmation = buildPlayAsConfirmation({ option: aurelia, state: store.get() });
    assert.match(confirmation, /The scene moves to The Old Subway\./);
    // The existing promises are still stated verbatim.
    assert.match(confirmation, /narration/i);
    assert.match(confirmation, /NPC pool/i);
});

test('performPlayAs mutates only the store it is given', () => {
    const store = makeStore('s1dark', { identity: 'custom' });
    const calls = { replace: 0, dispatch: 0 };
    // A thin spy proves the helper writes through the caller's store instead of
    // creating a second one that could cache a stale document for the map.
    const spy = {
        get: () => store.get(),
        replace: (state) => {
            calls.replace += 1;
            return store.replace(state);
        },
        dispatch: (event) => {
            calls.dispatch += 1;
            return store.dispatch(event);
        },
    };
    const result = performPlayAs({
        store: spy,
        context: CONTEXT,
        season: seasons.s1dark,
        registry,
        characterId: CAROL,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.replace + calls.dispatch, 1);
    // The returned document matches what the passed-in store now holds.
    assert.equal(result.state.player.characterId, CAROL);
    assert.equal(store.get().player.characterId, CAROL);
    // The POV landed exactly where the document says (old-subway from the seed).
    assert.equal(result.locationId, result.state.scene.locationId);
    // `applyIdentity`'s status line is a DOM-side side effect of mountCodex;
    // the pure helper above is what a DOM-less test can assert.
});

test('Play-as confirmation dialog and codex markup are rendered safely', () => {
    const store = makeStore('s1dark', { identity: 'custom' });
    const view = viewFor(store, 's1dark', { selectedId: CAROL });
    const dialog = renderPlayAsDialog({ detail: view.selected, mode: 'canon' });
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /data-neoterra-codex-dialog-confirm/);
    assert.match(dialog, /Switch the player identity/);

    const markup = renderCodexMarkup(view);
    assert.match(markup, /data-neoterra-codex-search/);
    assert.match(markup, /data-neoterra-codex-filter="side"/);
    assert.match(markup, /data-neoterra-codex-filter="form"/);
    assert.match(markup, /data-neoterra-codex-filter="location"/);
    assert.match(markup, /data-neoterra-codex-filter="status"/);
    assert.match(markup, /Play as Carol Fate/);
    assert.match(markup, /data-neoterra-form-swap-target/);
});

test('the played character is always reachable in the codex', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    const impossible = viewFor(store, 's1dark', {
        filters: { query: 'zzzz-no-such-name', side: 'hero', status: 'dead' },
        selectedId: CAROL,
    });
    assert.ok(impossible.items.some((item) => item.characterId === CAROL));
    assert.ok(impossible.filtered.some((item) => item.characterId === CAROL));
    assert.equal(impossible.selected.isPlayer, true);

    const markup = renderCodexMarkup(impossible);
    assert.match(markup, /data-neoterra-codex-player-section="1"/);

    // A non-player detail never carries the marker.
    const other = viewFor(store, 's1dark', { selectedId: 's1dark.aurelia.season-dark-version' });
    assert.doesNotMatch(renderCodexMarkup(other), /data-neoterra-codex-player-section/);
});

test('codex reads aliases, tags, and abilities from the active form', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    const before = viewFor(store, 's1dark', { profiles, selectedId: CAROL });
    assert.ok(before.selected.profile.aliases.includes('Bleeding Heart'));
    const baseAliases = before.selected.profile.aliases.slice();
    const baseAbilities = before.selected.profile.abilities.slice();

    mutate(store, { type: 'TRANSFORM', characterId: CAROL, formId: CAROL_CLEANSED });
    const after = viewFor(store, 's1dark', { profiles, selectedId: CAROL });
    const current = store.get().characters[CAROL];
    assert.equal(after.selected.form.id, CAROL_CLEANSED);
    // Aliases/tags follow the active form; the base list remains a hint.
    assert.deepEqual(after.selected.profile.aliases, current.aliases);
    assert.deepEqual(after.selected.profile.baseAliases, baseAliases);
    assert.notDeepEqual(after.selected.profile.abilities, baseAbilities);
    const markup = renderCodexMarkup(after);
    assert.match(markup, /Base:/);
});

test('the Abilities tile renders lead + gloss items, never one paragraph', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const view = viewFor(store, 's1', { profiles, selectedId: 's1.vaiva.colorgarde' });
    const markup = renderCodexMarkup(view);
    assert.match(markup, /neoterra-codex-abilities/);
    // Each item is a bold lead with an optional muted gloss.
    assert.match(markup, /<li class="neoterra-codex-ability">\s*<strong>/);
    const raw = profiles['s1.vaiva.colorgarde'].abilities;
    assert.ok(raw.length > 400);
    assert.match(markup, /Abilities:/); // raw prose lives on the card block
});

test('live goals win over the card and the card value is labelled', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const state = store.get();
    state.characters[vaiva].goals = ['Live goal from the tracker'];
    state.characters[vaiva].goalsSource = 'live';
    store.replace(state);
    const view = viewFor(store, 's1', { profiles, selectedId: vaiva });
    assert.deepEqual(view.selected.profile.goals, ['Live goal from the tracker']);
    const markup = renderCodexMarkup(view);
    assert.match(markup, /Live goal from the tracker/);
});

test('a card without goals shows an honest empty state', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const view = viewFor(store, 's1', { profiles, selectedId: 's1.vaiva.colorgarde' });
    assert.deepEqual(view.selected.profile.goals, []);
    assert.match(renderCodexMarkup(view), /No goals recorded in the card/);
});

test('re-derive overwrites abilities, skills, and traits but never goals', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const state = store.get();
    state.characters[vaiva].abilities = ['stale ability'];
    state.characters[vaiva].goals = ['Plot goal'];
    state.characters[vaiva].goalsSource = 'live';
    store.replace(state);

    const character = store.get().characters[vaiva];
    const result = rederiveCardFacets(character, profiles[vaiva]);
    assert.equal(result.changed, true);
    assert.notDeepEqual(result.character.abilities, ['stale ability']);
    assert.ok(result.character.skills.length > 0);
    // Goals are plot-owned and untouched.
    assert.deepEqual(result.character.goals, ['Plot goal']);
    assert.equal(result.character.goalsSource, 'live');

    // The helper is idempotent.
    assert.equal(rederiveCardFacets(result.character, profiles[vaiva]).changed, false);
});

test('tracker-written goals survive a form swap', () => {
    const store = makeStore('s1dark', { identity: 'canon', characterId: CAROL });
    mutate(store, { type: 'SET_CHARACTER_FIELDS', characterId: CAROL, goals: ['Steal the crown'] });
    assert.equal(store.get().characters[CAROL].goalsSource, 'live');
    mutate(store, { type: 'TRANSFORM', characterId: CAROL, formId: CAROL_CLEANSED });
    assert.deepEqual(store.get().characters[CAROL].goals, ['Steal the crown']);
});

test('card profiles fill empty live fields and never override live values', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const view = viewFor(store, 's1', { profiles, selectedId: vaiva });
    assert.ok(view.selected.profile.card);
    assert.match(view.selected.profile.appearance, /captivating 25-year-old/);
    assert.match(view.selected.profile.outfit, /chic fashion/);
    // The Abilities tile is the structured summary; the raw prose lives on
    // the card block (`From the character card`).
    assert.ok(view.selected.profile.abilities.length > 0);
    assert.ok(view.selected.profile.abilities.length <= 6);
    assert.ok(view.selected.profile.abilities.every((item) => item.length <= 120));
    assert.match(view.selected.profile.card.abilities, /normal human/);
    assert.match(view.selected.profile.personality, /Vaiva's personality/);
    assert.ok(view.selected.profile.speech.length > 0);
    assert.ok(view.selected.profile.likes.length >= 2);
    assert.ok(view.selected.profile.dislikes.length >= 2);
    assert.match(view.selected.profile.background, /PetraByte/);
    assert.equal(view.selected.profile.gender, 'Female');
    assert.equal(view.selected.profile.species, 'Human');

    const markup = renderCodexMarkup(view);
    assert.match(markup, /From the character card/);
    assert.match(markup, /Female · Human/);
    assert.match(markup, /data-neoterra-codex-card-profile/);

    // Canonical card rows (occupation/gear/etc.) render even though the S1
    // cards used above leave most of them empty.
    const withRows = viewFor(store, 's1', {
        profiles: {
            ...profiles,
            [vaiva]: {
                ...profiles[vaiva],
                occupation: 'Engineer',
                faction: 'PetraByte',
                combatStyle: 'Suit-assisted',
                gear: 'Light suit',
                weakness: 'Overconfidence',
            },
        },
        selectedId: vaiva,
    });
    const rowsMarkup = renderCodexMarkup(withRows);
    assert.match(rowsMarkup, /Occupation/);
    assert.match(rowsMarkup, /Combat style/);
    assert.match(rowsMarkup, /Light suit/);

    // A non-empty live value wins over the card and is what the panel shows.
    const state = store.get();
    state.characters[vaiva].appearance = 'Live appearance wins.';
    store.replace(state);
    const live = viewFor(store, 's1', { profiles, selectedId: vaiva });
    assert.equal(live.selected.profile.appearance, 'Live appearance wins.');
    assert.match(renderCodexMarkup(live), /Live appearance wins\./);

    // Goals exist on the corrupted Carol card.
    const fate = viewFor(store, 's1', {
        profiles,
        selectedId: 's1.twisting.fate.corrupted.carol.fate',
    });
    assert.ok(fate.selected.profile.goals.length > 0);
});

test('profiles: {} reproduces the live-only codex with no card block', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const view = viewFor(store, 's1', { profiles: {}, selectedId: 's1.vaiva.colorgarde' });
    assert.equal(view.selected.profile.appearance, '');
    assert.equal(view.selected.profile.card, null);
    assert.deepEqual(view.selected.profile.likes, []);
    const markup = renderCodexMarkup(view);
    assert.doesNotMatch(markup, /From the character card/);
    assert.match(markup, /No appearance recorded\./);

    // An unknown profile id and a missing profile map are safe.
    assert.doesNotThrow(() => viewFor(store, 's1', {
        profiles: { 'not.a.real.entry': { appearance: 'ghost' } },
        selectedId: 's1.vaiva.colorgarde',
    }));
});

test('card profile backfill is idempotent and never overwrites live values', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const state = store.get();
    state.characters[vaiva].appearance = 'Live appearance.';
    store.replace(state);

    const first = backfillCardProfiles({ state: store.get(), ids: [vaiva], profiles });
    assert.equal(first.changed, true);
    assert.equal(first.state.characters[vaiva].appearance, 'Live appearance.');
    assert.deepEqual(first.state.characters[vaiva].likes, profiles[vaiva].likes);
    assert.equal(first.state.characters[vaiva].notes, profiles[vaiva].background);

    const saved = store.replace(first.state);
    const second = backfillCardProfiles({ state: saved, ids: [vaiva], profiles });
    assert.equal(second.changed, false);
    assert.equal(second.state, saved);

    // A full sync also becomes a no-op after one pass.
    const allIds = Object.keys(saved.characters);
    const sync = backfillCardProfiles({ state: saved, ids: allIds, profiles });
    const synced = store.replace(sync.state);
    const again = backfillCardProfiles({ state: synced, ids: allIds, profiles });
    assert.equal(again.changed, false);
});

test('live state that came from a card is also gated at render time', () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const state = store.get();
    state.characters[vaiva].appearance = 'A sex scene in the rain.';
    state.characters[vaiva].likes = ['fuck'];
    state.characters[vaiva].notes = 'A sex scene in the past.';
    store.replace(state);

    const full = viewFor(store, 's1', { profiles: {}, selectedId: vaiva });
    assert.match(full.selected.profile.appearance, /sex scene/);

    const strict = viewFor(store, 's1', {
        profiles: {},
        settings: { contentGate: 'strict' },
        selectedId: vaiva,
    });
    assert.equal(strict.selected.profile.appearance, '');
    assert.deepEqual(strict.selected.profile.likes, []);
    assert.equal(strict.selected.profile.notes, '');
    assert.doesNotMatch(renderCodexMarkup(strict), /sex scene/);
});

test('the content gate is applied to card profiles at render time', () => {
    const card = {
        appearance: 'Graphic gore covers the street.',
        sensitive: [{ label: 'Sexual Information', text: 'A sex scene with moaning.' }],
        extras: [{ label: 'Weakness', text: 'None recorded.' }],
        forms: { 'Night Form': 'A sex scene in the dark.' },
        likes: ['fuck'],
        dislikes: [],
        goals: [],
    };

    const full = gateCardProfile(card, { settings: { contentGate: 'full' } });
    assert.equal(full.sensitive[0].text, 'A sex scene with moaning.');
    assert.equal(full.forms['Night Form'], 'A sex scene in the dark.');

    const mature = gateCardProfile(card, { settings: { contentGate: 'mature-only' } });
    assert.match(mature.sensitive[0].text, /\[sexual content omitted\]/);
    assert.match(mature.forms['Night Form'], /\[sexual content omitted\]/);
    assert.equal(mature.appearance, card.appearance);

    const reduced = gateCardProfile(card, { settings: { contentGate: 'reduced' } });
    assert.match(reduced.appearance, /\[violence elided\]/);

    const strict = gateCardProfile(card, {
        settings: { contentGate: 'strict' },
        characterId: 's1.vaiva.colorgarde',
        isPlayer: true,
    });
    assert.equal(strict.appearance, '');
    assert.deepEqual(strict.sensitive, []);
    assert.deepEqual(strict.forms, {});

    // Hard limits only tighten the global level.
    const limit = gateCardProfile(card, {
        settings: {
            contentGate: 'full',
            contentLimits: { player: '', characters: { 's1.vaiva.colorgarde': 'mature-only' } },
        },
        characterId: 's1.vaiva.colorgarde',
    });
    assert.match(limit.sensitive[0].text, /\[sexual content omitted\]/);

    const playerLimit = gateCardProfile(card, {
        settings: { contentGate: 'full', contentLimits: { player: 'mature-only', characters: {} } },
        isPlayer: true,
    });
    assert.match(playerLimit.sensitive[0].text, /\[sexual content omitted\]/);

    // The stored profile is never mutated.
    assert.equal(card.sensitive[0].text, 'A sex scene with moaning.');
});

test('settings expose agent routing/prompts and character hard limits', () => {
    const agents = buildAgentConfigMarkup();
    for (const agent of ['architect', 'storyline', 'stateTracker', 'choices', 'badEnd']) {
        assert.match(agents, new RegExp(`data-neoterra-agent="${agent}"`));
        assert.match(agents, new RegExp(`data-neoterra-path="agents\\.${agent}\\.prompt"`));
        assert.match(agents, new RegExp(`data-neoterra-path="agents\\.${agent}\\.connectionProfileId"`));
        assert.match(agents, new RegExp(`data-neoterra-path="agents\\.${agent}\\.cadence"`));
    }
    assert.match(agents, /data-neoterra-reset-prompt="agents\.storyline\.prompt"/);

    const settings = cloneDefaults();
    settings.contentLimits.characters[CAROL] = 'strict';
    const limits = buildCharacterLimitMarkup(
        [{ id: CAROL, displayName: 'Carol Fate' }],
        settings,
    );
    assert.match(limits, /data-neoterra-limit-character="s1dark\.carol\.bleeding-heart"/);
    assert.match(limits, /value="strict" selected/);
    assert.match(limits, /Inherit global gate/);
});

test('Play-as fills goals exactly once for a card with no usable goals', async () => {
    const store = makeStore('s1', { identity: 'custom' });
    const vaiva = 's1.vaiva.colorgarde';
    const goals = [
        'Protect Neo Terra from the Atropos threat',
        'Expose Claire Atropos',
        'Keep her family safe',
    ];
    const runner = {
        calls: 0,
        async runAgent() {
            this.calls += 1;
            return { value: { goals, rationale: 'Grounded in the card.' } };
        },
    };
    const goalInference = createGoalInference({
        runner,
        getSettings: () => ({ agents: { goalInference: { enabled: true, model: 'test-model' } } }),
    });
    const first = await ensurePlayerGoals({
        store,
        registry,
        profiles,
        goalInference,
        settings: cloneDefaults(),
        characterId: vaiva,
        season: seasons.s1,
    });
    assert.equal(first.ok, true);
    assert.equal(first.inferred, true);
    assert.equal(runner.calls, 1);
    assert.deepEqual(store.get().characters[vaiva].goals, goals);
    assert.equal(store.get().characters[vaiva].goalsSource, 'live');
    assert.equal(store.get().flags.goalInference.characterId, vaiva);

    const second = await ensurePlayerGoals({
        store,
        registry,
        profiles,
        goalInference,
        settings: cloneDefaults(),
        characterId: vaiva,
        season: seasons.s1,
    });
    assert.equal(second.inferred, false);
    assert.equal(runner.calls, 1);
});

test('the played character renders an Infer goals button and a goal source hint', () => {
    const store = makeStore('s1', { identity: 'canon', characterId: 's1.vaiva.colorgarde' });
    const view = viewFor(store, 's1', {
        profiles,
        selectedId: 's1.vaiva.colorgarde',
        goalInferenceAvailable: true,
    });
    const markup = renderCodexMarkup(view);
    assert.match(markup, /data-neoterra-infer-goals="s1\.vaiva\.colorgarde"/);
    assert.match(markup, /data-neoterra-goals-source="card"/);
    assert.match(markup, /Source: card/);

    const noAgent = viewFor(store, 's1', {
        profiles,
        selectedId: 's1.vaiva.colorgarde',
        goalInferenceAvailable: false,
    });
    assert.doesNotMatch(renderCodexMarkup(noAgent), /data-neoterra-infer-goals/);
});

