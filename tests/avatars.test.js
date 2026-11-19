import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildAvatarManifest,
    buildPngCandidates,
    matchPngToRegistry,
    normalizeAvatarName,
} from '../tools/build-avatars.mjs';
import { extractPngCard } from '../tools/png-card.mjs';
import {
    AVATAR_OVERRIDES_STORAGE_KEY,
    buildSyncedManifest,
    buildSyncOverrides,
    countAvatarCoverage,
    matchInstalledCharacter,
    readAvatarOverrides,
    resolveAvatarForEntry,
    validateAvatarManifest,
    writeAvatarOverrides,
} from '../src/data/avatars.js';

const REGISTRY = {
    entries: [
        {
            id: 's1.vaiva',
            seasonId: 's1',
            dataName: 'Vaiva',
            displayName: 'Vaiva Colorgarde',
            aliases: ['Colorgarde'],
            bundle: false,
            formGroup: null,
        },
        {
            id: 's1.vaiva.light-shade',
            seasonId: 's1',
            dataName: 'Vaiva',
            displayName: 'Light Shade',
            aliases: ['Corrupted Colorgarde'],
            bundle: false,
            formGroup: 's1.vaiva',
        },
        {
            id: 's1.claire',
            seasonId: 's1',
            dataName: 'Claire',
            displayName: 'Claire Atropos',
            aliases: ['Claire Atropos'],
            bundle: false,
            formGroup: null,
        },
    ],
};

function pngWithCard(card) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = Buffer.from(`chara\0${JSON.stringify(card)}`, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(text.length, 0);
    const type = Buffer.from('tEXt', 'latin1');
    const crc = Buffer.alloc(4);
    const end = Buffer.concat([
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('IEND', 'latin1'),
        Buffer.alloc(4),
    ]);
    return Buffer.concat([signature, length, type, text, crc, end]);
}

test('avatar names normalize accents, punctuation, and spacing', () => {
    assert.equal(normalizeAvatarName('  Vaivà   Petrauskaitė '), 'vaiva petrauskaite');
    assert.equal(normalizeAvatarName("Claire's"), 'claires');
});

test('an embedded card name matches a registry entry', () => {
    const card = { spec: 'chara_card_v2', data: { name: 'Vaiva Colorgarde', description: '' } };
    const buffer = pngWithCard(card);
    assert.equal(extractPngCard(buffer)?.card?.data?.name, 'Vaiva Colorgarde');
    const result = buildPngCandidates(buffer, 'unknown.png');
    assert.ok(result.candidates.some((candidate) => candidate.key === 'vaiva colorgarde'));
    const manifest = buildAvatarManifest({
        sourceDir: fixtureDir([['vaiva.png', buffer]]),
        registry: { entries: [{ ...REGISTRY.entries[0], displayName: 'Vaiva Colorgarde' }] },
        copy: false,
    });
    assert.equal(manifest.manifest.avatars['s1.vaiva']?.source, 'vaiva.png');
});

test('ambiguous short names are reported, never guessed', () => {
    const entries = [
        { id: 's1.claire', dataName: 'Claire', displayName: 'Claire Atropos', aliases: [] },
        { id: 's4.claire', dataName: 'Claire', displayName: 'Claire Atropos', aliases: [] },
    ];
    const index = new Map([
        ['claire', [{ id: 's1.claire', kind: 'dataName' }, { id: 's4.claire', kind: 'dataName' }]],
        ['claire atropos', [{ id: 's1.claire', kind: 'displayName' }, { id: 's4.claire', kind: 'displayName' }]],
    ]);
    const card = { data: { name: 'Claire', description: '' } };
    const result = matchPngToRegistry(
        { buffer: pngWithCard(card), relativePath: 'claire.png' },
        index,
        {},
    );
    assert.equal(result.registryId, null);
    assert.equal(result.reason, 'ambiguous');
});

test('an override resolves an ambiguous filename deterministically', () => {
    const index = new Map([
        ['claire', [{ id: 's1.claire', kind: 'dataName' }, { id: 's4.claire', kind: 'dataName' }]],
    ]);
    const result = matchPngToRegistry(
        { buffer: Buffer.from('unused'), relativePath: 'claire.png' },
        index,
        { 'claire.png': 's4.claire' },
    );
    assert.equal(result.registryId, 's4.claire');
    assert.equal(result.reason, 'override');
});

test('installed matching prefers dataName, then display name, then alias', () => {
    const characters = [
        { name: 'Vaiva Colorgarde', avatar: 'vaiva.png' },
        { name: 'Light Shade', avatar: 'shade.png' },
    ];
    assert.equal(matchInstalledCharacter(REGISTRY.entries[0], characters)?.avatar, 'vaiva.png');
    assert.equal(matchInstalledCharacter(REGISTRY.entries[1], characters)?.avatar, 'shade.png');
    assert.equal(matchInstalledCharacter(REGISTRY.entries[2], characters), null);
});

test('duplicate installed names resolve to no avatar instead of a swap', () => {
    const characters = [
        { name: 'Claire Atropos', avatar: 'claire-a.png' },
        { name: 'Claire Atropos', avatar: 'claire-b.png' },
    ];
    const result = matchInstalledCharacter(REGISTRY.entries[2], characters);
    assert.deepEqual(result?.ambiguous?.sort(), ['claire-a.png', 'claire-b.png']);
});

test('a repeated short name falls through to a unique full name', () => {
    const characters = [
        {
            name: 'Claire',
            avatar: 'claire-a.png',
            data: { name: 'Claire', description: '[{{char}} is Claire Atropos, a supervillainess.' },
        },
        {
            name: 'Claire',
            avatar: 'claire-b.png',
            data: { name: 'Claire', description: '[{{char}} is Claire Lachesis, a superhero.' },
        },
    ];
    assert.equal(matchInstalledCharacter(REGISTRY.entries[2], characters)?.avatar, 'claire-a.png');
    const lachesis = {
        ...REGISTRY.entries[2],
        id: 's1.claire.lachesis',
        displayName: 'Claire Lachesis',
        aliases: [],
    };
    assert.equal(matchInstalledCharacter(lachesis, characters)?.avatar, 'claire-b.png');
});

test('a sync override wins over the installed-card fallback', () => {
    const installed = [{ name: 'Vaiva Colorgarde', avatar: 'vaiva.png' }];
    const resolved = resolveAvatarForEntry(REGISTRY.entries[0], {
        characters: installed,
        syncOverrides: { 's1.vaiva': 'custom vaiva.png' },
        baseUrl: 'http://127.0.0.1:8000/',
    });
    assert.equal(resolved.kind, 'sync');
    assert.equal(resolved.avatar, 'custom vaiva.png');
    assert.match(resolved.url, /characters\/custom%20vaiva\.png$/);
});

test('the manifest wins over every runtime fallback', () => {
    const resolved = resolveAvatarForEntry(REGISTRY.entries[0], {
        manifest: {
            schemaVersion: 1,
            avatars: { 's1.vaiva': { file: 'assets/avatars/s1.vaiva.png', source: 'x.png', hash: 'abc' } },
        },
        characters: [{ name: 'Vaiva Colorgarde', avatar: 'vaiva.png' }],
        baseUrl: 'http://127.0.0.1:8000/',
    });
    assert.equal(resolved.kind, 'manifest');
    assert.match(resolved.url, /assets\/avatars\/s1\.vaiva\.png$/);
});

test('a missing portrait falls back to null so the caller shows initials', () => {
    assert.equal(resolveAvatarForEntry(REGISTRY.entries[2], { characters: [] }), null);
});

test('sync overrides and coverage are deterministic', () => {
    const characters = [
        { name: 'Vaiva Colorgarde', avatar: 'vaiva.png' },
        { name: 'Light Shade', avatar: 'shade.png' },
        { name: 'Claire Atropos', avatar: 'claire.png' },
    ];
    const result = buildSyncOverrides(REGISTRY, characters);
    assert.equal(result.matched, 3);
    assert.equal(result.overrides['s1.vaiva'], 'vaiva.png');
    const coverage = countAvatarCoverage(REGISTRY, {
        syncOverrides: result.overrides,
        characters,
    });
    assert.equal(coverage.covered, 3);
    assert.deepEqual(coverage.missing, []);
});

test('a downloaded manifest is mergeable and keeps the empty file slot', () => {    const manifest = buildSyncedManifest(REGISTRY, [{ name: 'Vaiva Colorgarde', avatar: 'vaiva.png' }], {
        now: 1234,
    });
    assert.equal(manifest.generatedAt, 1234);
    assert.deepEqual(manifest.avatars['s1.vaiva'], {
        file: null,
        source: 'installed:vaiva.png',
        hash: null,
    });
    assert.equal(validateAvatarManifest(manifest).ok, true);
});

test('localStorage overrides round-trip and reject malformed values', () => {
    const storage = {
        value: null,
        getItem() { return this.value; },
        setItem(_key, next) { this.value = next; },
    };
    assert.deepEqual(readAvatarOverrides(storage), {});
    assert.equal(writeAvatarOverrides({ 's1.vaiva': 'vaiva.png' }, storage), true);
    assert.deepEqual(readAvatarOverrides(storage), { 's1.vaiva': 'vaiva.png' });
    storage.value = JSON.stringify({ 's1.vaiva': 42 });
    assert.deepEqual(readAvatarOverrides(storage), {});
    assert.equal(AVATAR_OVERRIDES_STORAGE_KEY, 'neoterra.avatarOverrides');
});

test('the manifest validator rejects an unknown schema', () => {
    assert.equal(validateAvatarManifest({ schemaVersion: 2, avatars: {} }).ok, false);
    assert.equal(validateAvatarManifest({ schemaVersion: 1, avatars: {} }).ok, true);
});

function fixtureDir(files) {
    const directory = mkdtempSync(join(tmpdir(), 'neoterra-avatars-'));
    for (const [name, buffer] of files) {
        const parts = name.split('/');
        if (parts.length > 1) {
            mkdirSync(join(directory, ...parts.slice(0, -1)), { recursive: true });
        }
        writeFileSync(join(directory, ...parts), buffer);
    }
    after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}
