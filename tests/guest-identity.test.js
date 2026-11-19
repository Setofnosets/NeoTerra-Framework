import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SeasonStartError,
    buildGuestWarning,
    buildIdentityChoices,
    mergePendingIdentity,
    resolveIdentitySelection,
    startSeason,
} from '../src/flows/season-start.js';
import { buildOpeningScene } from '../src/flows/scene.js';
import { renderIdentityStep } from '../src/ui/season-menu.js';
import { createWorldStateStore } from '../src/state/store.js';
import { renderContextText } from '../src/context/renderer.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const s1 = readJson('data/seasons/s1.json');
const s4 = readJson('data/seasons/s4.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');

// A roster character from S1 and a non-roster guest from S4.
const s1RosterId = s1.roster[0].characterId;
const guestEntry = registry.entries.find(
    (entry) => entry.seasonId === 's4' && entry.bundle !== true,
);

test('guests are rejected when the setting is off', () => {
    assert.throws(
        () => resolveIdentitySelection(s1, { identity: 'canon', characterId: guestEntry.id }, {
            registry,
            allowGuests: false,
        }),
        (error) => error instanceof SeasonStartError && error.code === 'NON_ROSTER_CHARACTER',
    );
});

test('a guest without the acknowledgment is rejected', () => {
    assert.throws(
        () => resolveIdentitySelection(s1, { identity: 'canon', characterId: guestEntry.id }, {
            registry,
            allowGuests: true,
            allowAnyCharacter: true,
            requireGuestAcknowledgement: true,
        }),
        (error) => error instanceof SeasonStartError && error.code === 'GUEST_WARNING_REQUIRED',
    );
});

test('an acknowledged guest resolves with its home season', () => {
    const selection = resolveIdentitySelection(s1, {
        identity: 'canon',
        characterId: guestEntry.id,
        warningAccepted: true,
    }, { registry, allowGuests: true, allowAnyCharacter: true });
    assert.equal(selection.guest, true);
    assert.equal(selection.guestSeasonId, 's4');
    assert.equal(selection.nonCanon, false);
    assert.equal(selection.warningAccepted, true);
});

test('guests do not change the Sandbox non-canon path', () => {
    const sandbox = readJson('data/seasons/sandbox.json');
    const selection = resolveIdentitySelection(sandbox, {
        identity: 'canon',
        characterId: guestEntry.id,
    }, { registry, allowGuests: true, allowAnyCharacter: true });
    assert.equal(selection.nonCanon, true);
    assert.equal(selection.guest, false);
});

test('the guest warning names the home season and the adaptation policy', () => {
    const warning = buildGuestWarning(guestEntry, s1);
    assert.equal(warning.characterId, guestEntry.id);
    assert.equal(warning.homeSeasonId, 's4');
    assert.match(warning.eraMismatch, /s4/);
    assert.match(warning.canonBeatPolicy, /adapt/i);
    assert.match(warning.acknowledgment, /non-canon guest/i);
});

test('the acknowledgment survives the replace confirmation step', () => {
    const merged = mergePendingIdentity(
        { identity: 'canon', characterId: guestEntry.id, warningAccepted: true },
        {},
    );
    assert.equal(merged.warningAccepted, true);
});

test('guest identity choices are grouped apart from the canon roster', () => {
    const choices = buildIdentityChoices(s1, { registry, allowGuests: true });
    const roster = choices.options.filter((option) => option.identity === 'canon' && !option.guest);
    const guests = choices.options.filter((option) => option.guest);
    assert.ok(roster.length > 0);
    assert.ok(guests.length > 0);
    assert.ok(guests.some((option) => option.characterId === guestEntry.id));
    assert.ok(guests.every((option) => option.homeSeasonId !== 's1'));
});

test('the identity step renders the guest warning and disables Begin until acknowledged', () => {
    const choices = buildIdentityChoices(s1, { registry, allowGuests: true });
    const guest = choices.options.find((option) => option.guest);
    const warning = buildGuestWarning(
        registry.entries.find((entry) => entry.id === guest.characterId),
        s1,
    );
    const blocked = renderIdentityStep({
        entry: s1,
        choices,
        error: null,
        guestWarning: warning,
        acknowledged: false,
        selectedCharacterId: guest.characterId,
    });
    assert.match(blocked, /data-neoterra-guest-warning/);
    assert.match(blocked, /data-neoterra-guest-ack/);
    assert.match(blocked, /data-neoterra-identity-confirm[^>]*disabled/);

    const allowed = renderIdentityStep({
        entry: s1,
        choices,
        error: null,
        guestWarning: warning,
        acknowledged: true,
        selectedCharacterId: guest.characterId,
    });
    assert.doesNotMatch(allowed, /data-neoterra-identity-confirm[^>]*disabled/);
});

test('a seeded guest world records the flags and adapts the opening frame', () => {
    const store = createWorldStateStore({
        metadata: {},
        storage: null,
        chatId: 'guest-chat',
        context: { registry, formGroups, formRules, factions, locations },
    });
    const result = startSeason({
        store,
        season: s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'guest-chat',
        identity: { identity: 'canon', characterId: guestEntry.id, warningAccepted: true },
        allowGuests: true,
        now: 1,
    });
    assert.equal(result.identity.guest, true);
    assert.equal(result.state.flags.guestCharacter.characterId, guestEntry.id);
    assert.equal(result.state.flags.guestCharacter.homeSeasonId, 's4');
    assert.equal(result.state.flags.canonMode, 'adapted');
    assert.equal(result.state.flags.nonCanon, undefined);
    assert.ok(result.state.characters[guestEntry.id]);

    const opening = buildOpeningScene({ state: result.state, season: s1 });
    assert.match(opening.text, /guest character: home season s4/);
    assert.match(opening.text, /canon beats adapt/);
    assert.equal(opening.guest.characterId, guestEntry.id);
});

test('the prompt contains a non-canon guest block with no future knowledge', () => {
    const store = createWorldStateStore({
        metadata: {},
        storage: null,
        chatId: 'guest-prompt',
        context: { registry, formGroups, formRules, factions, locations },
    });
    const result = startSeason({
        store,
        season: s1,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId: 'guest-prompt',
        identity: { identity: 'canon', characterId: guestEntry.id, warningAccepted: true },
        allowGuests: true,
        now: 1,
    });
    const text = renderContextText(result.state, {
        settings: DEFAULT_SETTINGS,
        season: s1,
        registry,
    });
    assert.match(text, /Non-canon guest/);
    assert.match(text, /no future knowledge/i);
    assert.match(text, /adapt instead of failing/i);
});

test('a roster identity still resolves without the guest flag', () => {
    const selection = resolveIdentitySelection(s1, {
        identity: 'canon',
        characterId: s1RosterId,
    }, { registry, allowGuests: true, allowAnyCharacter: true });
    assert.equal(selection.guest, false);
    assert.equal(selection.nonCanon, false);
});

test('the guest defaults ship on, with adapted canon beats', () => {
    assert.equal(DEFAULT_SETTINGS.identity.allowGuests, true);
    assert.equal(DEFAULT_SETTINGS.identity.guestCanonBeats, 'adapt');
});
