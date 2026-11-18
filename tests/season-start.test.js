import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_CONTENT_NOTICE,
    DIRECTOR_CARD_NAME,
    SeasonStartError,
    applyCharacterFocus,
    applySeasonChatMetadata,
    buildIdentityChoices,
    buildSeasonMenuEntries,
    clearFormDataCache,
    enterSeason,
    filterSeasonEntriesByCharacter,
    loadFormData,
    mergePendingIdentity,
    resolveIdentitySelection,
    seasonWorldBookName,
    selectNarratorCard,
    startSeason,
} from '../src/flows/season-start.js';
import {
    escapeHtml,
    readIdentityRadio,
    renderIdentityStep,
    renderSeasonMenuMarkup,
    renderSetupStrip,
} from '../src/ui/season-menu.js';
import { clearProfilesCache } from '../src/data/profiles.js';
import { buildOpeningScene, getPovLabel } from '../src/flows/scene.js';
import { selectNpcPool } from '../src/state/selectors.js';
import { createWorldStateStore } from '../src/state/store.js';
import { validateWorldState } from '../src/state/world-state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const districts = readJson('data/districts.json');
const profileArtifact = readJson('data/characters/profiles.json');

const SEASON_IDS = ['s1', 's1dark', 's2', 's3', 's4', 'sandbox'];
const seasonDocuments = Object.fromEntries(
    [...SEASON_IDS, 's5'].map((id) => [
        id,
        readJson(`data/seasons/${id === 's5' ? 's5.aux.json' : `${id}.json`}`),
    ]),
);

const CONTEXT = { registry, factions, locations, formGroups, formRules };

function testFetchImpl() {
    const documents = {
        's1.json': seasonDocuments.s1,
        'index.json': registry,
        'factions.json': factions,
        'locations.json': locations,
        'form-groups.json': formGroups,
        'form-rules.json': formRules,
        'districts.json': districts,
    };
    return async (url) => {
        const key = Object.keys(documents).find((name) => String(url).endsWith(name));
        if (!key) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => documents[key] };
    };
}

function makeStore(metadata = {}, chatId = 'test-chat') {
    return createWorldStateStore({
        metadata,
        chatId,
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        now: () => 1700000000000,
        context: CONTEXT,
    });
}

function start(overrides = {}) {
    const metadata = overrides.metadata ?? {};
    const store = overrides.store ?? makeStore(metadata);
    const season = overrides.season ?? seasonDocuments.s1;
    const result = startSeason({
        store,
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: overrides.chatId ?? 'test-chat',
        identity: overrides.identity ?? {},
        mode: overrides.mode ?? 'director',
        confirmReplace: overrides.confirmReplace ?? false,
        now: 1700000000000,
        metadata,
        ...overrides.startOptions,
    });
    return { ...result, store, metadata };
}

test('season menu lists every playable entry and the disabled S5 notice', () => {
    const entries = buildSeasonMenuEntries(seasonDocuments, { registry, locations });
    assert.deepEqual(entries.map((entry) => entry.id), ['s1', 's1dark', 's2', 's3', 's4', 'sandbox', 's5']);

    const playable = entries.filter((entry) => entry.playable);
    assert.equal(playable.length, 6);
    assert.equal(playable.every((entry) => entry.castLabel.length > 0), true);

    const s5 = entries.find((entry) => entry.id === 's5');
    assert.equal(s5.disabled, true);
    assert.equal(s5.playable, false);
    assert.match(s5.disabledReason, /not yet playable|coming later|auxiliary/i);

    const s1dark = entries.find((entry) => entry.id === 's1dark');
    assert.equal(s1dark.playerRole, 'villain');
    assert.equal(s1dark.playerRoleLabel, 'Villain POV');
    assert.equal(s1dark.alt, true);
    assert.equal(s1dark.defaultPlayerCharacterId, 's1dark.carol.bleeding-heart');
    assert.match(s1dark.playAsLabel, /Bleeding Heart/);

    const s4 = entries.find((entry) => entry.id === 's4');
    assert.equal(s4.mainThreats.length, 2);

    for (const entry of entries) {
        assert.equal(typeof entry.contentNotice, 'string');
        assert.ok(entry.contentNotice.length > 0);
        if (entry.playable) {
            assert.equal(entry.contentNotice, DEFAULT_CONTENT_NOTICE);
        }
    }
});

test('every playable season seeds a schema-valid world', () => {
    for (const id of SEASON_IDS) {
        const season = seasonDocuments[id];
        const metadata = {};
        const { state, opening } = start({ season, metadata, identity: { identity: 'custom' } });

        const validation = validateWorldState(state);
        assert.equal(validation.ok, true, `${id}: ${validation.errors.map((e) => `${e.path}:${e.message}`).join('; ')}`);
        assert.equal(state.seasonId, id);
        assert.equal(state.chatId, 'test-chat');
        assert.equal(state.playerRole, season.playerRole);
        assert.equal(state.player.identity, 'custom');
        assert.equal(state.scene.locationId, season.startLocationId);
        assert.equal(state.meta.inGameDate, season.anchorDate);
        assert.equal(Object.keys(state.characters).length, season.roster.length);
        assert.equal(Object.keys(state.beats).length, season.canonBeats.length);
        assert.equal(
            Object.values(state.beats).every((beat) => beat.status === 'open'),
            true,
        );

        const mainThreats = state.threats.filter((threat) => threat.rank === 'main');
        assert.equal(mainThreats.length, season.threats.filter((threat) => threat.rank === 'main').length);

        assert.equal(opening.era, season.era);
        assert.equal(opening.locationName, state.locations[season.startLocationId].name);
        assert.equal(opening.povLabel, getPovLabel(season.playerRole));

        // Chat metadata is written once per entry, not appended as duplicates.
        assert.equal(metadata.neoterra.seasonId, id);
        assert.equal(metadata.neoterra.seasonDefinition.id, id);
        assert.equal(metadata.neoterra.worldState.seasonId, id);
        assert.ok(metadata.neoterra.worldBook.name.endsWith('test-chat'));
    }
});

test('S1Dark seeds Carol as the player and removes her from the NPC pool', () => {
    const { state, opening, identity } = start({ season: seasonDocuments.s1dark });
    assert.equal(identity.identity, 'canon');
    assert.equal(identity.characterId, 's1dark.carol.bleeding-heart');
    assert.equal(identity.nonCanon, false);
    assert.equal(state.player.characterId, 's1dark.carol.bleeding-heart');
    assert.equal(state.characters['s1dark.carol.bleeding-heart'].controlledBy, 'player');

    const carolStates = Object.values(state.characters).filter(
        (character) => character.charId === 's1dark.carol.bleeding-heart',
    );
    assert.equal(carolStates.length, 1);
    assert.equal(
        selectNpcPool(state).some((character) => character.charId === 's1dark.carol.bleeding-heart'),
        false,
    );

    assert.equal(opening.playerRole, 'villain');
    assert.equal(opening.povLabel, 'Villain POV');
    assert.equal(opening.playerName, 'Carol Fate');
    assert.match(opening.text, /2037–2040/);
    assert.match(opening.text, /Clarity HQ|clarity/i);
});

test('identity choices default to the season character and permit custom personas', () => {
    const choices = buildIdentityChoices(seasonDocuments.s1dark, { registry });
    assert.equal(choices.defaultIdentity, 'canon');
    assert.equal(choices.defaultCharacterId, 's1dark.carol.bleeding-heart');
    const canon = choices.options.filter((option) => option.identity === 'canon');
    assert.equal(canon[0].characterId, 's1dark.carol.bleeding-heart');
    assert.equal(canon[0].isDefault, true);
    assert.equal(canon[0].label, 'Play as Carol Fate');

    const custom = choices.options.find((option) => option.identity === 'custom');
    assert.ok(custom);
    assert.equal(custom.isDefault, false);

    const s1 = buildIdentityChoices(seasonDocuments.s1, { registry });
    assert.equal(s1.defaultIdentity, 'custom');
    assert.equal(s1.options.find((option) => option.identity === 'custom').isDefault, true);
});

test('playing as a canon roster character uses that character and keeps no duplicate NPC', () => {
    const { state, opening } = start({
        season: seasonDocuments.s1,
        identity: { identity: 'canon', characterId: 's1.vaiva.colorgarde' },
    });
    assert.equal(state.player.characterId, 's1.vaiva.colorgarde');
    assert.equal(state.characters['s1.vaiva.colorgarde'].controlledBy, 'player');
    assert.equal(selectNpcPool(state).some((character) => character.charId === 's1.vaiva.colorgarde'), false);
    assert.equal(opening.playerName, 'Vaiva Colorgarde');
    assert.equal(opening.povLabel, 'Hero POV');
});

test('a non-roster character is rejected outside Sandbox', () => {
    assert.throws(
        () => start({
            season: seasonDocuments.s1,
            identity: { identity: 'canon', characterId: 's2.amy.matic.seasonal.siren' },
        }),
        (error) => error instanceof SeasonStartError && error.code === 'NON_ROSTER_CHARACTER',
    );
});

test('Sandbox allows any registry character with a persistent non-canon warning', () => {
    const { state, opening } = start({
        season: seasonDocuments.sandbox,
        identity: { identity: 'canon', characterId: 's1.vaiva.colorgarde' },
    });
    assert.equal(state.player.characterId, 's1.vaiva.colorgarde');
    assert.equal(state.flags.nonCanon, true);
    assert.equal(state.beats ? Object.keys(state.beats).length : 0, 0);
    assert.equal(opening.nonCanon, true);
    assert.match(opening.text, /non-canon character: canon beats disabled/i);
});

test('non-playable S5 is rejected with a clear message', () => {
    assert.throws(
        () => start({ season: seasonDocuments.s5 }),
        (error) => error instanceof SeasonStartError
            && error.code === 'NOT_PLAYABLE'
            && /not yet playable/i.test(error.message),
    );
});

test('re-entry requires confirmation and never leaves duplicate state', () => {
    const metadata = {};
    const store = makeStore(metadata);
    const first = start({ season: seasonDocuments.s1, store, metadata });
    const before = store.get();

    assert.throws(
        () => start({ season: seasonDocuments.s2, store, metadata }),
        (error) => error instanceof SeasonStartError && error.code === 'EXISTING_WORLD',
    );
    assert.equal(store.get(), before);
    assert.equal(store.get().seasonId, 's1');

    const second = start({
        season: seasonDocuments.s2,
        store,
        metadata,
        confirmReplace: true,
        identity: { identity: 'custom' },
    });
    assert.equal(second.replaced, true);
    assert.equal(store.get().seasonId, 's2');
    assert.equal(metadata.neoterra.seasonId, 's2');
    assert.equal(metadata.neoterra.worldState.chatId, first.state.chatId);
    assert.equal(metadata.neoterra.worldState.seasonId, 's2');

    // Character ids are replaced, never appended under a second namespace.
    assert.equal(
        Object.keys(store.get().characters).some((id) => id.startsWith('s1.')),
        false,
    );
});

test('a failed identity choice cancels without touching the current world', () => {
    const store = makeStore();
    start({ season: seasonDocuments.s1, store });
    const before = store.get();

    assert.throws(
        () => start({
            season: seasonDocuments.s2,
            store,
            confirmReplace: true,
            identity: { identity: 'canon', characterId: 's1.vaiva.colorgarde' },
        }),
        (error) => error instanceof SeasonStartError && error.code === 'NON_ROSTER_CHARACTER',
    );
    assert.equal(store.get(), before);
});

test('character-first filtering narrows seasons by roster and keeps Sandbox', () => {
    const entries = buildSeasonMenuEntries(seasonDocuments, { registry, locations });
    const filtered = filterSeasonEntriesByCharacter(entries, 's1.vaiva.colorgarde', {
        registry,
        seasons: seasonDocuments,
    });
    const ids = filtered.map((entry) => entry.id);
    assert.ok(ids.includes('s1'));
    assert.ok(ids.includes('sandbox'));
    assert.ok(!ids.includes('s2'));
});

test('narrator card detection is read-only and never switches cards', () => {
    const called = [];
    const ctx = {
        characters: [{ name: DIRECTOR_CARD_NAME, avatar: 'director.png' }],
        selectCharacterById: (id) => called.push(id),
    };
    const result = selectNarratorCard(ctx, {
        season: seasonDocuments.s1,
        identity: { identity: 'custom' },
        mode: 'director',
        registry,
    });
    assert.equal(result.status, 'available');
    assert.equal(result.role, 'director');
    assert.equal(result.characterId, 'director.png');
    assert.deepEqual(called, []);

    const missing = selectNarratorCard({ characters: [] }, {
        season: seasonDocuments.s1,
        identity: { identity: 'custom' },
        mode: 'director',
        registry,
    });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.characterId, null);
});

test('solo mode reports the played canon card instead of the Director', () => {
    const ctx = {
        characters: [{ name: 'Carol', avatar: 'carol.png' }],
        selectCharacterById() {},
    };
    const result = selectNarratorCard(ctx, {
        season: seasonDocuments.s1dark,
        identity: { identity: 'canon', characterId: 's1dark.carol.bleeding-heart' },
        mode: 'solo',
        registry,
    });
    assert.equal(result.role, 'canon');
    assert.equal(result.name, 'Carol');
    assert.equal(result.status, 'available');
    assert.equal(result.characterId, 'carol.png');
});

test('opening scene is deterministic and names era, location, and POV', () => {
    const { state } = start({ season: seasonDocuments.s1 });
    const first = buildOpeningScene({ state, season: seasonDocuments.s1 });
    const second = buildOpeningScene({ state, season: seasonDocuments.s1 });
    assert.equal(first.text, second.text);
    assert.match(first.text, /Season 1/);
    assert.match(first.text, new RegExp(state.locations[state.scene.locationId].name));
    assert.match(first.text, /Hero POV/);
    assert.equal(first.playerRole, 'hero');
});

test('resolveIdentitySelection and metadata helpers validate their input', () => {
    const custom = resolveIdentitySelection(seasonDocuments.s1, {}, { registry });
    assert.equal(custom.identity, 'custom');
    assert.equal(custom.characterId, null);

    const canon = resolveIdentitySelection(
        seasonDocuments.s1,
        { identity: 'canon', characterId: 's1.claire.atropos' },
        { registry },
    );
    assert.equal(canon.characterId, 's1.claire.atropos');
    assert.equal(canon.nonCanon, false);

    assert.throws(
        () => resolveIdentitySelection(seasonDocuments.s1, { identity: 'canon', characterId: 'nope' }, { registry }),
        (error) => error instanceof SeasonStartError && error.code === 'INVALID_IDENTITY',
    );
    assert.throws(
        () => resolveIdentitySelection(seasonDocuments.s1, { identity: 'canon', characterId: 's1.atropos.couple' }, { registry }),
        (error) => error instanceof SeasonStartError && error.code === 'INVALID_IDENTITY',
    );

    const metadata = { neoterra: { keepMe: true } };
    applySeasonChatMetadata(metadata, { seasonId: 's1', season: seasonDocuments.s1 });
    assert.equal(metadata.neoterra.keepMe, true);
    assert.equal(metadata.neoterra.seasonId, 's1');
    assert.equal(
        seasonWorldBookName(seasonDocuments.s1, 'abc'),
        `Neo Terra — ${seasonDocuments.s1.title} — abc`,
    );
});

test('Sandbox identity choices expose every registry character as non-canon', () => {
    const choices = buildIdentityChoices(seasonDocuments.sandbox, { registry, limit: 5 });
    const canon = choices.options.filter((option) => option.identity === 'canon');
    assert.equal(canon.length, 5);
    assert.equal(canon.every((option) => option.nonCanon === true), true);
    assert.equal(choices.defaultIdentity, 'custom');
});

test('character focus preselects a canon identity and survives the confirm step', () => {
    const choices = applyCharacterFocus(
        buildIdentityChoices(seasonDocuments.s1, { registry }),
        's1.vaiva.colorgarde',
    );
    assert.equal(choices.defaultIdentity, 'canon');
    assert.equal(choices.focusedCharacterId, 's1.vaiva.colorgarde');
    const focused = choices.options.find((option) => option.characterId === 's1.vaiva.colorgarde');
    assert.equal(focused.isDefault, true);
    assert.equal(choices.options.find((option) => option.identity === 'custom').isDefault, false);

    const pending = mergePendingIdentity(null, {
        identity: 'canon',
        characterId: 's1.vaiva.colorgarde',
        displayName: undefined,
        personaNotes: 'notes',
    });
    const confirmed = mergePendingIdentity(pending, {});
    assert.equal(confirmed.identity, 'canon');
    assert.equal(confirmed.characterId, 's1.vaiva.colorgarde');
    assert.equal(confirmed.personaNotes, 'notes');
});

test('the selected canon radio yields a characterId that resolveIdentitySelection accepts', () => {
    // Mirrors the DOM: the radio carries the registry id in data-character-id.
    const radio = {
        value: 'canon',
        dataset: { characterId: 's1.vaiva.colorgarde' },
    };
    const selection = readIdentityRadio(radio);
    assert.deepEqual(selection, { identity: 'canon', characterId: 's1.vaiva.colorgarde' });
    const resolved = resolveIdentitySelection(seasonDocuments.s1, selection, { registry });
    assert.equal(resolved.identity, 'canon');
    assert.equal(resolved.characterId, 's1.vaiva.colorgarde');

    const customRadio = { value: 'custom', dataset: { characterId: '' } };
    assert.deepEqual(readIdentityRadio(customRadio), { identity: 'custom', characterId: null });
    assert.equal(resolveIdentitySelection(seasonDocuments.s1, readIdentityRadio(customRadio), { registry }).identity, 'custom');

    // A radio that only exposes the rendered attribute is still readable.
    const attributeOnly = {
        value: 'canon',
        getAttribute: (name) => (name === 'data-character-id' ? 's1.claire.atropos' : null),
    };
    assert.deepEqual(readIdentityRadio(attributeOnly), { identity: 'canon', characterId: 's1.claire.atropos' });

    assert.deepEqual(readIdentityRadio(null), { identity: undefined, characterId: null });
});

test('the identity step renders canon radios with data-character-id and keeps the default selected', () => {
    for (const season of [seasonDocuments.s1, seasonDocuments.s1dark]) {
        const choices = buildIdentityChoices(season, { registry });
        const markup = renderIdentityStep({ entry: season, choices, error: null });
        const radios = [...markup.matchAll(/<input[^>]*data-neoterra-identity[^>]*>/g)].map((match) => match[0]);
        assert.equal(radios.length, choices.options.length);
        const canonRadios = radios.filter((tag) => tag.includes('value="canon"'));
        assert.ok(canonRadios.length > 0);
        for (const tag of canonRadios) {
            const match = tag.match(/data-character-id="([^"]*)"/);
            assert.ok(match, `canon radio is missing data-character-id: ${tag}`);
            assert.notEqual(match[1], '', `canon radio has an empty data-character-id: ${tag}`);
        }
        assert.equal(radios.filter((tag) => tag.includes('checked')).length, 1);
        const checked = radios.find((tag) => tag.includes('checked'));
        const checkedId = checked.match(/data-character-id="([^"]*)"/)?.[1] ?? '';
        assert.equal(checkedId, choices.defaultIdentity === 'canon' ? choices.defaultCharacterId : '');
    }
});

test('season start hands the opening frame back to the chat', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const shell = readFileSync(join(root, 'src/ui/shell.js'), 'utf8');
    const defaults = readFileSync(join(root, 'src/core/defaults.js'), 'utf8');
    const settingsHtml = readFileSync(join(root, 'src/ui/settings.html'), 'utf8');

    // The season menu reports a completed start; the shell owns the chat write.
    assert.match(shell, /onEntered:\s*\(result\)\s*=>/);
    assert.match(shell, /postSceneMessage\(/);
    assert.match(shell, /SCENE_KINDS\.OPENING/);
    assert.match(shell, /buildOpeningFrameText\(/);
    assert.match(shell, /closeShell\(\)/);
    assert.match(shell, /send_textarea'\)\?\.focus/);

    // Auto-kickoff is off by default and sends the prompt through ST's send path.
    assert.match(defaults, /kickoff:\s*\{[\s\S]*?auto:\s*false/);
    assert.match(shell, /settings\?\.kickoff\?\.auto === true/);
    assert.match(shell, /sendChoiceText\(prompt\)/);
    assert.doesNotMatch(shell, /Generate\(/);
    // An empty kickoff prompt must still request CYOA for the posted frame.
    assert.match(shell, /if \(!\(auto && freshChat && prompt\.length > 0\)\)/);
    assert.match(settingsHtml, /data-neoterra-path="kickoff\.auto"/);
    assert.match(settingsHtml, /data-neoterra-path="kickoff\.prompt"/);
});

test('season menu markup escapes registry-sourced labels', () => {
    assert.equal(escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    const entries = buildSeasonMenuEntries(seasonDocuments, { registry, locations });
    const s1dark = entries.find((entry) => entry.id === 's1dark');
    const markup = renderSeasonMenuMarkup([s1dark], {});
    assert.match(markup, /Play as Carol Fate — Bleeding Heart/);
    assert.match(markup, /data-neoterra-season-select="s1dark"/);
    assert.match(markup, /Villain POV/);
});

test('enterSeason loads data, seeds the chat, and links a materialized book', async () => {
    clearFormDataCache();
    const metadata = {};
    const documents = {
        's1.json': seasonDocuments.s1,
        'index.json': registry,
        'factions.json': factions,
        'locations.json': locations,
        'form-groups.json': formGroups,
        'form-rules.json': formRules,
        'districts.json': districts,
    };
    const fetchImpl = async (url) => {
        const key = Object.keys(documents).find((name) => String(url).endsWith(name));
        if (!key) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => documents[key] };
    };
    let saves = 0;
    const ctx = {
        chatId: 'chat-a',
        chatMetadata: metadata,
        saveMetadataDebounced: () => { saves += 1; },
        characters: [],
    };
    const materialized = [];
    const result = await enterSeason({
        id: 's1',
        identity: { identity: 'custom', displayName: 'Tester' },
        ctx,
        fetchImpl,
        now: 1700000000000,
        worldBook: {
            ensure: async (payload) => {
                materialized.push(payload);
                return { status: 'materialized', entries: 6 };
            },
        },
    });
    assert.equal(result.state.chatId, 'chat-a');
    assert.equal(result.state.player.displayName, 'Tester');
    assert.equal(result.narrator.status, 'missing');
    assert.equal(materialized.length, 1);
    assert.equal(materialized[0].name, result.worldBook.name);
    assert.equal(metadata.neoterra.worldState.chatId, 'chat-a');
    assert.equal(metadata.neoterra.worldBook.status, 'materialized');
    assert.equal(metadata.neoterra.registry.entries.some((entry) => entry.id === 's1.vaiva.colorgarde'), true);
    assert.ok(saves >= 1);
});

test('enterSeason seeds card profiles and tolerates a missing profile file', async () => {
    clearFormDataCache();
    clearProfilesCache();
    const metadata = {};
    const documents = {
        's1.json': seasonDocuments.s1,
        'index.json': registry,
        'factions.json': factions,
        'locations.json': locations,
        'form-groups.json': formGroups,
        'form-rules.json': formRules,
        'districts.json': districts,
        'profiles.json': profileArtifact,
    };
    const fetchImpl = async (url) => {
        const key = Object.keys(documents).find((name) => String(url).endsWith(name));
        if (!key) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => documents[key] };
    };
    const ctx = {
        chatId: 'chat-profiles',
        chatMetadata: metadata,
        saveMetadataDebounced: () => {},
        characters: [],
    };
    const result = await enterSeason({
        id: 's1',
        identity: { identity: 'custom' },
        ctx,
        fetchImpl,
        now: 1700000000000,
    });
    const vaiva = result.state.characters['s1.vaiva.colorgarde'];
    assert.equal(vaiva.appearance, profileArtifact.profiles['s1.vaiva.colorgarde'].appearance);
    assert.ok(vaiva.likes.length > 0);

    // A stale install without profiles.json still starts the season.
    clearFormDataCache();
    clearProfilesCache();
    const metadata2 = {};
    const result2 = await enterSeason({
        id: 's1',
        identity: { identity: 'custom' },
        ctx: {
            chatId: 'chat-no-profiles',
            chatMetadata: metadata2,
            saveMetadataDebounced: () => {},
            characters: [],
        },
        fetchImpl: async (url) => {
            const key = Object.keys(documents).find(
                (name) => name !== 'profiles.json' && String(url).endsWith(name),
            );
            if (!key) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => documents[key] };
        },
        now: 1700000000000,
    });
    assert.equal(result2.state.characters['s1.vaiva.colorgarde'].appearance, '');
    clearProfilesCache();
});

test('enterSeason refuses to seed when the chat changed during loading', async () => {
    clearFormDataCache();
    const documents = {
        's1.json': seasonDocuments.s1,
        'index.json': registry,
        'factions.json': factions,
        'locations.json': locations,
        'form-groups.json': formGroups,
        'form-rules.json': formRules,
        'districts.json': districts,
    };
    const fetchImpl = async (url) => {
        const key = Object.keys(documents).find((name) => String(url).endsWith(name));
        if (!key) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => documents[key] };
    };
    const ctx = { chatId: 'chat-a', chatMetadata: {}, characters: [] };
    const pending = enterSeason({
        id: 's1',
        identity: { identity: 'custom' },
        ctx,
        fetchImpl,
        now: 1700000000000,
    });
    ctx.chatId = 'chat-b';
    await assert.rejects(
        pending,
        (error) => error instanceof SeasonStartError && error.code === 'CHAT_CHANGED',
    );
    assert.deepEqual(ctx.chatMetadata, {});
});

test('enterSeason resolves the live chat id through getCurrentChatId', async () => {
    clearFormDataCache();
    const metadata = {};
    let currentChatId = 'chat-live';
    const ctx = {
        // Deliberately stale/empty snapshot value.
        chatId: '',
        getCurrentChatId: () => currentChatId,
        chatMetadata: metadata,
        saveMetadataDebounced: () => {},
        characters: [],
    };
    const result = await enterSeason({
        id: 's1',
        identity: { identity: 'custom', displayName: 'Tester' },
        ctx,
        fetchImpl: testFetchImpl(),
        now: 1700000000000,
    });
    assert.equal(result.state.chatId, 'chat-live');
    assert.equal(metadata.neoterra.worldState.chatId, 'chat-live');
});

test('enterSeason prefers getCurrentChatId over a stale chatId snapshot', async () => {
    clearFormDataCache();
    const metadata = {};
    const ctx = {
        chatId: 'chat-stale',
        getCurrentChatId: () => 'chat-current',
        chatMetadata: metadata,
        saveMetadataDebounced: () => {},
        characters: [],
    };
    const result = await enterSeason({
        id: 's1',
        identity: { identity: 'custom' },
        ctx,
        fetchImpl: testFetchImpl(),
        now: 1700000000000,
    });
    assert.equal(result.state.chatId, 'chat-current');
    assert.equal(metadata.neoterra.worldState.chatId, 'chat-current');
});

test('enterSeason explains how to fix a missing chat', async () => {
    clearFormDataCache();
    const ctx = { chatMetadata: {}, characters: [] };
    await assert.rejects(
        enterSeason({ id: 's1', identity: { identity: 'custom' }, ctx, fetchImpl: testFetchImpl() }),
        (error) => error instanceof SeasonStartError
            && error.code === 'INVALID_CHAT'
            && /open a character or group chat/i.test(error.message),
    );
});

test('loadFormData validates the authored form documents', async () => {
    clearFormDataCache();
    const error = await loadFormData({
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    }).then(
        () => null,
        (caught) => caught,
    );
    assert.ok(error instanceof SeasonStartError);
    assert.equal(error.code, 'MISSING_DATA');
});

test('renderSetupStrip reports an installed Director card and hides the download CTA', () => {
    const installed = renderSetupStrip({
        mode: 'director',
        hostName: 'Neo Terra — Director',
        chatId: 'chat-1',
        directorInstalled: true,
    });
    assert.match(installed, /Director card — installed/);
    assert.doesNotMatch(installed, /data-neoterra-download-director/);
    assert.doesNotMatch(installed, /not installed/);
    assert.doesNotMatch(installed, /neoterra-setup-hint/);

    const missing = renderSetupStrip({
        mode: 'director',
        hostName: null,
        chatId: 'chat-1',
        directorInstalled: false,
    });
    assert.match(missing, /Director card — not installed/);
    assert.match(missing, /data-neoterra-download-director/);
    assert.match(missing, /neoterra-setup-hint/);

    // The status helper returns `{ installed }`; the strip must accept that
    // shape too so callers cannot reintroduce the missing-card regression.
    const normalized = renderSetupStrip({ mode: 'director', installed: true });
    assert.match(normalized, /Director card — installed/);
    assert.doesNotMatch(normalized, /data-neoterra-download-director/);

    const solo = renderSetupStrip({ mode: 'solo', hostName: 'Vaiva', directorInstalled: false });
    assert.match(solo, /Canon card — Vaiva/);
    assert.doesNotMatch(solo, /data-neoterra-download-director/);
    assert.doesNotMatch(solo, /neoterra-setup-hint/);
});
