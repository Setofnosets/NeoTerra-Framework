import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIRECTOR_CARD_FILENAME, directorCardStatus, loadDirectorCard } from '../src/ui/director-card.js';
import { DIRECTOR_CARD_NAME } from '../src/flows/season-start.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readCard() {
    return JSON.parse(readFileSync(join(ROOT, 'assets/neoterra-director.json'), 'utf8'));
}

test('the bundled Director card is a valid V2 narrator card', () => {
    const card = readCard();
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.spec_version, '2.0');
    assert.equal(card.data.name, DIRECTOR_CARD_NAME);
    assert.equal(DIRECTOR_CARD_FILENAME, 'Neo Terra — Director.json');

    assert.ok(card.data.description.length > 0);
    assert.ok(card.data.system_prompt.length > 0);
    assert.match(card.data.system_prompt, /Never decide \{\{user\}\}'s actions/);
    assert.equal(card.data.first_mes, '');
    assert.equal(card.data.mes_example, '');
    assert.deepEqual(card.data.alternate_greetings, []);
    assert.equal(card.data.world, undefined);
    assert.equal(card.data.extensions.neoterra.role, 'director');
});

test('directorCardStatus detects the installed card without selecting it', () => {
    const ctx = {
        characters: [
            { name: 'Someone', avatar: 'someone.png' },
            { name: DIRECTOR_CARD_NAME, avatar: 'director.png' },
        ],
        selectCharacterById: () => {
            throw new Error('must not switch characters');
        },
    };
    assert.deepEqual(directorCardStatus(ctx), {
        name: DIRECTOR_CARD_NAME,
        installed: true,
        avatar: 'director.png',
    });
    assert.equal(directorCardStatus({ characters: [] }).installed, false);
    assert.equal(directorCardStatus(null).installed, false);
});

test('loadDirectorCard fetches the bundled asset and surfaces failures', async () => {
    const card = readCard();
    const loaded = await loadDirectorCard({
        fetchImpl: async (url) => {
            assert.match(String(url), /assets\/neoterra-director\.json$/);
            return { ok: true, status: 200, json: async () => card };
        },
    });
    assert.equal(loaded.data.name, DIRECTOR_CARD_NAME);

    await assert.rejects(
        loadDirectorCard({
            fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
        }),
        /could not load the card/i,
    );
});
