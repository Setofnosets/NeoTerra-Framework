import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildCharacterPickerView,
    renderCharacterPickerMarkup,
} from '../src/ui/character-picker.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const registry = readJson('data/characters/index.json');
const s1 = readJson('data/seasons/s1.json');

test('the picker finds a character by name and alias', () => {
    const view = buildCharacterPickerView({ registry, season: s1, query: 'vaiva' });
    const items = view.sections.flatMap((section) => section.items);
    assert.ok(items.some((item) => item.characterId === 's1.vaiva.colorgarde'));
    const aliased = buildCharacterPickerView({ registry, season: s1, query: 'colorgarde' });
    assert.ok(aliased.sections.flatMap((section) => section.items)
        .some((item) => item.characterId === 's1.vaiva.colorgarde'));
});

test('roster and guest sections are separate', () => {
    const view = buildCharacterPickerView({ registry, season: s1, allowGuests: true });
    const roster = view.sections.find((section) => section.id === 'roster');
    const guests = view.sections.find((section) => section.id === 'guests');
    assert.ok(roster.items.length > 0);
    assert.ok(guests.items.length > 0);
    assert.ok(guests.items.every((item) => item.guest && item.homeSeasonId !== 's1'));
});

test('guests are omitted when the setting is off', () => {
    const view = buildCharacterPickerView({ registry, season: s1, allowGuests: false });
    const guests = view.sections.find((section) => section.id === 'guests');
    assert.equal(guests.items.length, 0);
});

test('filters narrow the list by side and form kind', () => {
    const view = buildCharacterPickerView({ registry, season: s1, side: 'villain', formKind: 'corrupted' });
    const items = view.sections.flatMap((section) => section.items);
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.side === 'villain' && item.formKind === 'corrupted'));
});

test('form lineage is exposed on the item', () => {
    const view = buildCharacterPickerView({ registry, season: s1, query: 'vaiva' });
    const item = view.sections.flatMap((section) => section.items)
        .find((candidate) => candidate.characterId === 's1.vaiva.colorgarde');
    assert.ok(item.forms.length >= 2);
    assert.ok(item.forms.some((form) => form.id === 's1.light.shade.corrupted.colorgarde'));
});

test('markup renders portraits, search, and the guest badge', () => {
    const view = buildCharacterPickerView({
        registry,
        season: s1,
        allowGuests: true,
        selectedId: 's1.vaiva.colorgarde',
    });
    const markup = renderCharacterPickerMarkup(view);
    assert.match(markup, /data-neoterra-picker-search/);
    assert.match(markup, /data-neoterra-picker-select="s1.vaiva.colorgarde"/);
    assert.match(markup, /neoterra-avatar/);
    assert.match(markup, /Guest/);
});
