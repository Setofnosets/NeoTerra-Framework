import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { extractPngCard, readPngChunks, requirePngCard } from '../tools/png-card.mjs';
import { readCardsFromDirectory } from '../tools/build-data.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function png(chunks) {
    return Buffer.concat([
        SIGNATURE,
        ...chunks,
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function textChunk(keyword, text) {
    return chunk('tEXt', Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'latin1')]));
}

function cardJson(name, description = '') {
    return JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, description } });
}

test('a tEXt chara chunk is decoded', () => {
    const buffer = png([textChunk('chara', cardJson('Vaiva'))]);
    const result = extractPngCard(buffer);
    assert.equal(result.keyword, 'chara');
    assert.equal(result.card.data.name, 'Vaiva');
});

test('a base64 chara chunk is decoded', () => {
    const encoded = Buffer.from(cardJson('Claire')).toString('base64');
    const buffer = png([textChunk('chara', encoded)]);
    assert.equal(extractPngCard(buffer)?.card?.data?.name, 'Claire');
});

test('a zTXt chunk is inflated', () => {
    const payload = Buffer.concat([
        Buffer.from('chara\0', 'latin1'),
        Buffer.from([0]),
        deflateSync(Buffer.from(cardJson('Shade'), 'latin1')),
    ]);
    const buffer = png([chunk('zTXt', payload)]);
    assert.equal(extractPngCard(buffer)?.card?.data?.name, 'Shade');
});

test('ccv3 wins over chara when both exist', () => {
    const buffer = png([
        textChunk('chara', cardJson('Old')),
        textChunk('ccv3', cardJson('New')),
    ]);
    assert.equal(extractPngCard(buffer)?.card?.data?.name, 'New');
});

test('a PNG with no card chunk returns null and a clear error from requirePngCard', () => {
    const buffer = png([textChunk('Comment', 'hello')]);
    assert.equal(extractPngCard(buffer), null);
    assert.throws(() => requirePngCard(buffer, 'card.png'), /no embedded character card/);
});

test('a malformed PNG is rejected with an actionable message', () => {
    assert.throws(() => readPngChunks(Buffer.from('not a png')), /not a PNG/);
    const truncated = Buffer.concat([SIGNATURE, Buffer.from([0, 0, 0, 12]), Buffer.from('tEXt')]);
    assert.throws(() => readPngChunks(truncated), /truncated PNG chunk/);
    assert.throws(() => requirePngCard(truncated, 'bad.png'), /malformed PNG/);
});

test('a PNG-only card is registered with an avatarPath', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neoterra-png-'));
    try {
        writeFileSync(join(directory, 'Netrunner.png'), png([
            textChunk('chara', cardJson('Netrunner', 'Appearance: neon coat.\n\nSide: hero')),
        ]));
        const result = readCardsFromDirectory({ absolute: directory, seasonId: 's1', dir: 'S1' });
        assert.equal(result.errors.length, 0);
        assert.equal(result.cards.length, 1);
        assert.equal(result.cards[0].file, 'Chars/S1/Netrunner.png');
        assert.equal(result.cards[0].avatarPath, 'Chars/S1/Netrunner.png');
        assert.equal(result.cards[0].raw.data.name, 'Netrunner');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a JSON + PNG pair produces one entry that keeps the PNG as its art', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neoterra-png-'));
    try {
        const card = { spec: 'chara_card_v2', data: { name: 'Vaiva', description: 'Appearance: tall.' } };
        writeFileSync(join(directory, 'Vaiva.json'), JSON.stringify(card));
        writeFileSync(join(directory, 'Vaiva.png'), png([textChunk('chara', cardJson('Ignored'))]));
        const result = readCardsFromDirectory({ absolute: directory, seasonId: 's1', dir: 'S1' });
        assert.equal(result.cards.length, 1);
        assert.equal(result.cards[0].file, 'Chars/S1/Vaiva.json');
        assert.equal(result.cards[0].avatarPath, 'Chars/S1/Vaiva.png');
        // The JSON text wins over the embedded PNG card.
        assert.equal(result.cards[0].raw.data.description, 'Appearance: tall.');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a malformed PNG fails with the file name and writes no card', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neoterra-png-'));
    try {
        writeFileSync(join(directory, 'Broken.png'), Buffer.from('still not a png'));
        const result = readCardsFromDirectory({ absolute: directory, seasonId: 's1', dir: 'S1' });
        assert.equal(result.cards.length, 0);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0].file, /Broken\.png$/);
        assert.match(result.errors[0].reason, /malformed PNG/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
