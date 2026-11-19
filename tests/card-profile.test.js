import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    findFormSection,
    parseAliases,
    parseCardProfile,
    splitListText,
} from '../src/data/card-profile.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readCard(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function card(description, name = 'Test Character') {
    return { data: { name, description } };
}

test('real cards yield the profile fields the codex needs', () => {
    const vaiva = parseCardProfile(readCard('Chars/S1/Vaiva-Colorgarde.json'), {
        file: 'Chars/S1/Vaiva-Colorgarde.json',
        cardPath: 'Chars/S1/Vaiva-Colorgarde.json',
    });
    assert.ok(vaiva);
    assert.equal(vaiva.gender, 'Female');
    assert.equal(vaiva.species, 'Human');
    assert.match(vaiva.appearance, /captivating 25-year-old/);
    assert.match(vaiva.attire, /chic fashion style/);
    assert.match(vaiva.abilities, /normal human/);
    assert.match(vaiva.personality, /Vaiva's personality/);
    assert.ok(vaiva.likes.length >= 2);
    assert.ok(vaiva.dislikes.length >= 2);
    assert.equal(vaiva.source.cardPath, 'Chars/S1/Vaiva-Colorgarde.json');

    const couple = parseCardProfile(readCard('Chars/S1/Atropos couple.json'));
    assert.ok(couple);
    assert.match(couple.gender, /Claire/);
    assert.match(couple.appearance, /Claire appears/);
    assert.ok(couple.abilities.length > 0);
    assert.ok(couple.personality.length > 0);

    const birdCage = parseCardProfile(readCard('Chars/S4/Bird Cage (Corrupted Hula Hawk).json'));
    assert.ok(birdCage);
    assert.match(birdCage.appearance, /Bird Cage appears/);
    assert.ok(birdCage.abilities.length > 0);
    assert.ok(birdCage.personality.length > 0);
    assert.deepEqual(Object.keys(birdCage.forms), ['Bird Cage']);
    assert.ok(birdCage.forms['Bird Cage'].length > 50);
    assert.equal(findFormSection(birdCage, 'bird cage'), birdCage.forms['Bird Cage']);
});

test('a minimal card lists the missing sections and never throws', () => {
    const profile = parseCardProfile(card(
        'Personality: Quiet and watchful.\n\nBackground: Raised in the capital.',
    ));
    assert.ok(profile);
    assert.equal(profile.personality, 'Quiet and watchful.');
    assert.equal(profile.background, 'Raised in the capital.');
    assert.equal(profile.appearance, '');
    assert.deepEqual(profile.likes, []);
    assert.equal(profile.missing.includes('appearance'), true);
    assert.equal(profile.missing.includes('personality'), false);
    assert.equal(profile.missing.includes('background'), false);

    assert.equal(parseCardProfile(null), null);
    assert.equal(parseCardProfile([]), null);
    assert.equal(parseCardProfile({}), null);
    assert.equal(parseCardProfile({ data: {} }), null);
    assert.equal(parseCardProfile({ data: { description: 42 } }), null);
});

test('CRLF and blank lines inside a section parse like LF input', () => {
    const description = [
        'Gender: Female',
        '',
        'Appearance: First line.',
        '',
        'Second paragraph of the same section.',
        '',
        'Likes: Tea, books, and rain.',
        '',
        'Transformation into Night Form: Taller and shadowed.',
    ].join('\n');

    const lf = parseCardProfile(card(description));
    const crlf = parseCardProfile(card(description.replace(/\n/g, '\r\n')));
    assert.deepEqual(crlf, lf);
    assert.equal(lf.appearance, 'First line.\n\nSecond paragraph of the same section.');
    assert.deepEqual(lf.likes, ['Tea', 'books', 'rain']);
    assert.equal(lf.forms['Night Form'], 'Taller and shadowed.');
});

test('splitListText is tolerant but keeps prose as one item', () => {
    assert.deepEqual(splitListText('A, B, and C.'), ['A', 'B', 'C']);
    assert.deepEqual(splitListText('Wealth. Sex. Power.'), ['Wealth', 'Sex', 'Power']);
    assert.deepEqual(splitListText('Tea; books; rain'), ['Tea', 'books', 'rain']);

    const prose = 'word '.repeat(80).trim();
    assert.equal(prose.length > 300, true);
    assert.deepEqual(splitListText(prose), [prose]);

    assert.deepEqual(splitListText(''), []);
    assert.deepEqual(splitListText(123), []);
});

test('sensitive sections are kept for the content gate to decide', () => {
    const profile = parseCardProfile(card([
        'Appearance: Practical clothes.',
        '',
        'Sexual Information: Explicit material.',
        '',
        'Kink: Something specific.',
    ].join('\n')));
    assert.ok(profile);
    assert.deepEqual(profile.sensitive.map((section) => section.label), [
        'Sexual Information',
        'Kink',
    ]);
    assert.match(profile.sensitive[0].text, /Explicit material/);

    const plain = parseCardProfile(card('Appearance: Practical clothes.'));
    assert.deepEqual(plain.sensitive, []);
});

test('bundle framing lines split into per-actor profiles without leaking', () => {
    const couple = parseCardProfile(readCard('Chars/S1/Atropos couple.json'));
    assert.ok(couple);
    assert.equal(couple.actors.length, 2);
    assert.match(couple.actors[0].name, /Claire/);
    assert.match(couple.actors[1].name, /Noah/);
    assert.match(couple.actors[0].appearance, /Claire appears/);
    assert.match(couple.actors[1].appearance, /Noah appears/);

    const profiled = JSON.stringify(couple);
    assert.doesNotMatch(profiled, /\[Character \d/);
    assert.doesNotMatch(profiled, /\]\s*"/);
    assert.equal(couple.species, 'Human (Both)');
    assert.equal(couple.gender, 'Female (Claire) & Male (Noah)');
});

test('a body line that looks like a label is an extra and does not leak', () => {
    const profile = parseCardProfile(card([
        'Personality: Calm on the surface.',
        'Note: this line looks like a label.',
        '',
        'Background: Raised in the capital.',
    ].join('\n')));
    assert.ok(profile);
    assert.equal(profile.personality, 'Calm on the surface.');
    assert.deepEqual(profile.extras.map((section) => section.label), ['Note']);
    assert.match(profile.extras[0].text, /looks like a label/);

    const emptyLabel = parseCardProfile(card('Appearance:\n\nBackground: Raised in the capital.'));
    assert.ok(emptyLabel);
    assert.equal(emptyLabel.missing.includes('appearance'), true);
});

test('aliases are derived once and never leak into extras', () => {
    const bloodBound = parseCardProfile(readCard('Chars/S3/Blood Bound (Corrupted Emeral Allure).json'));
    assert.deepEqual(bloodBound.aliases, ['Blood Bound', 'Emerald Allure', 'Tessa Ervone']);
    assert.equal(bloodBound.extras.some((entry) => /alias/i.test(entry.label)), false);

    const aurelia = parseCardProfile(readCard('Chars/S1/Aurelia-Longshot.json'));
    assert.deepEqual(aurelia.aliases, ['Longshot', 'Aurelia Selwind']);

    const brie = parseCardProfile(readCard('Chars/S4/Brie Anderson-Hula Hawk.json'));
    assert.deepEqual(brie.aliases, ['Hula Hawk', 'Brie Anderson', 'Brjiip Haadge']);

    // `Common Aliases/Codenames` is a label variant, not an extras section.
    const bittersweet = parseCardProfile(readCard('Chars/S1Dark/Bittersweet (Knighted Poisoness).json'));
    assert.deepEqual(bittersweet.aliases, ['Bittersweet', 'Poisoness', 'Jacqueline Webb']);
    assert.equal(bittersweet.extras.some((entry) => /alias/i.test(entry.label)), false);

    // A card with no alias information returns an empty list, never a guess.
    const minimal = parseCardProfile(card('Personality: Quiet and watchful.'));
    assert.deepEqual(minimal.aliases, []);
    assert.deepEqual(parseAliases(null), []);
    assert.deepEqual(parseAliases(42), []);
    assert.deepEqual(parseAliases(''), []);
    assert.deepEqual(parseAliases('Aliases:  "A long quoted paragraph, not an alias." '), []);
});

test('explicit trait labels become profile traits instead of extras', () => {
    const bittersweet = parseCardProfile(readCard('Chars/S1Dark/Bittersweet (Knighted Poisoness).json'));
    assert.ok(bittersweet.traits.length >= 2, JSON.stringify(bittersweet.traits));
    assert.equal(bittersweet.extras.some((entry) => /traits/i.test(entry.label)), false);
    assert.ok(!bittersweet.traits.some((trait) => /weakness/i.test(trait)));
});

test('profiles are JSON-serialisable and deterministic', () => {
    const raw = readCard('Chars/S1/Vaiva-Colorgarde.json');
    const first = parseCardProfile(raw);
    const second = parseCardProfile(raw);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
