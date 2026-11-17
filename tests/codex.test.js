import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildCodexView,
    buildFormSwapOptions,
    buildPlayAsConfirmation,
    buildPlayAsOptions,
    performFormSwap,
    performPlayAs,
    performPlayAsCustom,
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

    const next = performPlayAs({
        store,
        context: CONTEXT,
        season: seasons.s1dark,
        registry,
        characterId: CAROL,
    });
    assert.equal(next.player.identity, 'canon');
    assert.equal(next.player.characterId, CAROL);
    assert.equal(next.characters[CAROL].controlledBy, 'player');
    assert.equal(next.flags.nonCanon, false);

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

    const next = performPlayAs({
        store,
        context: CONTEXT,
        season: seasons.sandbox,
        registry,
        characterId: entry.id,
    });
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
