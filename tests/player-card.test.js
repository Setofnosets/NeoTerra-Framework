import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLAYER_CARD_SPEC,
    PLAYER_CARD_SPEC_VERSION,
    buildPlayerCardDocument,
    buildPlayerCardEnvelope,
    buildPlayerCardInstruction,
    sanitizeCardFilename,
} from '../src/data/player-card.js';
import { buildPlayerCardToast } from '../src/ui/toasts.js';

const CHARACTER = {
    charId: 's2.leila.renya',
    formId: 's2.leila.renya',
    displayName: 'Leila Renya',
    side: 'vigilante',
    locationId: 'maple-heights',
};

const PROFILE = {
    identity: 'Public',
    appearance: 'A tall, dark-skinned woman with long wild black hair and red eyes.',
    attire: 'Loose white robes and a silver circlet.',
    abilities: 'Speed, terrain mastery, curses, and a spine-like whip.',
    personality: 'Confident, commanding, and fiercely proud.',
    speech: 'Measured and regal.',
    likes: ['Nature', 'Fair fights'],
    dislikes: ['Technology', 'Cowardice'],
    goals: ['Prove herself superior to Vaiva'],
    background: 'A former supervillain turned vigilante.',
    weakness: 'Jealous possessiveness.',
    combatStyle: 'Curses and lunging strikes.',
    gear: 'A spine-like whip.',
};

const ENTRY = {
    id: 's2.leila.renya',
    displayName: 'Leila Renya',
    side: 'vigilante',
};

test('a registry-like character yields a V3 envelope with the exact name', () => {
    const doc = buildPlayerCardDocument({
        character: CHARACTER,
        profile: PROFILE,
        registryEntry: ENTRY,
        season: { title: 'Season 2 — Leila Arc', locationName: 'Maple Heights' },
        goals: ['Show the city her strength'],
        locationIntro: 'Maple Heights is quiet at dusk.',
    });

    assert.equal(doc.spec, PLAYER_CARD_SPEC);
    assert.equal(doc.spec_version, PLAYER_CARD_SPEC_VERSION);
    assert.equal(doc.data.name, 'Leila Renya');
    assert.equal(typeof doc.data.description, 'string');
    assert.equal(typeof doc.data.first_mes, 'string');
    assert.equal(doc.data.first_mes, 'Maple Heights is quiet at dusk.');
    assert.match(doc.data.description, /Identity Status: Public/);
    assert.match(doc.data.description, /Goals\/Motives: Show the city her strength/);
    assert.equal(doc.data.creator, 'Neo Terra');
    assert.equal(doc.data.extensions.neoterra.playerCard, true);
    assert.deepEqual(doc.data.tags, ['vigilante', 'neo-terra']);

    const alias = buildPlayerCardEnvelope({ character: CHARACTER, profile: PROFILE });
    assert.deepEqual(alias, buildPlayerCardDocument({ character: CHARACTER, profile: PROFILE }));
});

test('description strips leaked prompt markers defensively', () => {
    const doc = buildPlayerCardDocument({
        character: CHARACTER,
        profile: {
            ...PROFILE,
            background: 'Before the fall.\n\n[NEOTERRA_PLAYER]\nName: Leila\n\nAfter the fall.',
        },
    });
    assert.doesNotMatch(doc.data.description, /\[NEOTERRA_/);
    assert.match(doc.data.description, /Before the fall\./);
    assert.match(doc.data.description, /After the fall\./);
});

test('the download filename is safe and never empty', () => {
    const safe = sanitizeCardFilename('Leila / Renya: "Femme Feral"?');
    assert.ok(safe.length > 0);
    assert.doesNotMatch(safe, /[<>:"/\\|?*]/);
    assert.equal(sanitizeCardFilename(''), 'Player');
    assert.equal(sanitizeCardFilename('   '), 'Player');
    assert.ok(sanitizeCardFilename('x'.repeat(200)).length <= 80);
});

test('the instruction names the character and the season/location', () => {
    const instruction = buildPlayerCardInstruction({
        displayName: 'Leila Renya',
        seasonTitle: 'Season 2 — Leila Arc',
        locationName: 'Maple Heights',
    });
    assert.match(instruction, /Leila Renya/);
    assert.match(instruction, /\(Season 2 — Leila Arc, at Maple Heights\)/);
});

test('a sandbox character without profile or registry still yields a valid envelope', () => {
    const doc = buildPlayerCardDocument({
        character: {
            charId: 'generated.hero',
            displayName: 'Sandbox Hero',
            side: 'hero',
            appearance: 'Tall and scarred.',
            outfit: 'A patched coat.',
            abilities: ['Speed', 'Grit'],
            notes: 'A drifter with no past.',
        },
    });

    assert.equal(doc.spec, 'chara_card_v3');
    assert.equal(doc.data.name, 'Sandbox Hero');
    assert.match(doc.data.description, /Appearance: Tall and scarred\./);
    assert.match(doc.data.description, /Attire: A patched coat\./);
    assert.match(doc.data.description, /Abilities: Speed, Grit/);
    assert.match(doc.data.description, /Background: A drifter with no past\./);
    assert.equal(doc.data.first_mes, 'The story continues.');
});

test('a missing display name falls back to the exact charId', () => {
    const doc = buildPlayerCardDocument({
        character: { charId: 's2.leila.renya', displayName: '' },
    });
    assert.equal(doc.data.name, 's2.leila.renya');
});

test('the player-card toast dedupes by character id and offers the download action', () => {
    const toast = buildPlayerCardToast({
        characterId: 's2.leila.renya',
        displayName: 'Leila Renya',
        instruction: 'Create a character card named Leila Renya.',
        filename: 'Leila Renya.json',
    });
    assert.equal(toast.id, 'player-card:s2.leila.renya');
    assert.equal(toast.type, 'player-card');
    assert.equal(toast.tone, 'info');
    assert.equal(toast.title, 'Create a card named Leila Renya');
    assert.deepEqual(toast.action, { id: 'download-player-card', label: 'Download card' });
    assert.ok(toast.ttlMs > 0);

    // Two characters with the same display name cannot collide.
    const twin = buildPlayerCardToast({
        characterId: 's2.other.renya',
        displayName: 'Leila Renya',
        instruction: 'Create a character card named Leila Renya.',
        filename: 'Leila Renya.json',
    });
    assert.notEqual(twin.id, toast.id);
});

test('the instruction keeps a whitespace-padded display name verbatim', () => {
    const instruction = buildPlayerCardInstruction({ displayName: ' Leila Renya ' });
    assert.ok(instruction.includes(' Leila Renya '));
});
