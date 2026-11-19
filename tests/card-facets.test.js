import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCardProfile } from '../src/data/card-profile.js';
import {
    MAX_ABILITY_DETAIL,
    MAX_ABILITY_LEAD,
    MAX_ABILITY_ITEMS,
    MAX_SKILL_ITEMS,
    abilityItems,
    abilityLine,
    abilitySummaryLines,
    deriveAbilitySummary,
    deriveCardFacets,
    parseAbilityLine,
} from '../src/data/card-facets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function profileFor(path) {
    const card = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    return parseCardProfile(card, { file: path, cardPath: path });
}

function assertWellFormed(summary) {
    for (const item of summary) {
        assert.equal(typeof item.lead, 'string');
        assert.ok(item.lead.length > 0, `empty lead in ${JSON.stringify(item)}`);
        assert.ok(
            item.lead.length <= MAX_ABILITY_LEAD,
            `lead too long (${item.lead.length}): ${item.lead}`,
        );
        assert.equal(typeof item.detail, 'string');
        assert.ok(
            item.detail.length <= MAX_ABILITY_DETAIL,
            `detail too long (${item.detail.length}): ${item.detail}`,
        );
        assert.ok(!/[.!?]\s+\S/.test(item.lead), `lead is a run-on: ${item.lead}`);
    }
}

test('Vaiva yields structured abilities, skills, and traits', () => {
    const facets = deriveCardFacets(profileFor('Chars/S1/Vaiva-Colorgarde.json'));
    assert.ok(facets.abilitySummary.length >= 3, JSON.stringify(facets.abilitySummary));
    assert.ok(facets.traits.length >= 1, JSON.stringify(facets.traits));
    assert.ok(facets.skills.length >= 1, JSON.stringify(facets.skills));
    assertWellFormed(facets.abilitySummary);
});

test('Blood Bound yields the stolen-power skills from her card prose', () => {
    const facets = deriveCardFacets(profileFor('Chars/S3/Blood Bound (Corrupted Emeral Allure).json'));
    const joined = facets.skills.join(' | ').toLowerCase();
    assert.match(joined, /steal superpowers/);
    assert.ok(facets.traits.includes('Superhuman physiology'));
    assert.ok(facets.abilitySummary.length > 0);
    assertWellFormed(facets.abilitySummary);
});

test('Brie yields an energy-ring skill and the flight trait', () => {
    const facets = deriveCardFacets(profileFor('Chars/S4/Brie Anderson-Hula Hawk.json'));
    assert.ok(
        facets.skills.some((skill) => /energy ring/i.test(skill)),
        JSON.stringify(facets.skills),
    );
    assert.ok(facets.traits.includes('Flight'), JSON.stringify(facets.traits));
    assertWellFormed(facets.abilitySummary);
});

test('Light Shade keeps physical and light-manipulation facets', () => {
    const facets = deriveCardFacets(profileFor('Chars/S1/Light Shade (Corrupted Colorgarde).json'));
    assert.ok(facets.traits.includes('Superhuman physiology'));
    assert.ok(facets.traits.includes('Invisibility'));
    assert.ok(facets.skills.length > 0, JSON.stringify(facets.skills));
    assertWellFormed(facets.abilitySummary);
});

test('Aurelia keeps luck, agility, and danger-sense facets apart', () => {
    const facets = deriveCardFacets(profileFor('Chars/S1/Aurelia-Longshot.json'));
    assert.ok(facets.traits.includes('Agility'));
    assert.ok(facets.traits.includes('Enhanced senses'));
    assert.ok(facets.skills.length >= 2);
    assertWellFormed(facets.abilitySummary);
});

test('Bittersweet accepts explicit trait labels without folding weakness in', () => {
    const profile = profileFor('Chars/S1Dark/Bittersweet (Knighted Poisoness).json');
    const facets = deriveCardFacets(profile);
    assert.ok(facets.traits.length >= 2, JSON.stringify(facets.traits));
    assert.ok(facets.skills.length >= 1, JSON.stringify(facets.skills));
    // A weakness is never a trait.
    assert.ok(!facets.traits.some((trait) => /weakness/i.test(trait)));
    assertWellFormed(facets.abilitySummary);
});

test('the same profile always derives the same facets', () => {
    const profile = profileFor('Chars/S1/Vaiva-Colorgarde.json');
    assert.deepEqual(deriveCardFacets(profile), deriveCardFacets(profile));
});

test('an empty abilities block emits nothing', () => {
    assert.deepEqual(deriveCardFacets({ abilities: '' }), {
        skills: [],
        traits: [],
        abilitySummary: [],
    });
    assert.deepEqual(deriveCardFacets({}), {
        skills: [],
        traits: [],
        abilitySummary: [],
    });
    assert.deepEqual(deriveAbilitySummary(undefined), []);
});

test('quoted dialogue never becomes a capability', () => {
    const summary = deriveAbilitySummary(
        'She can summon crystal shards. "You cannot hit me, loser. Kneel now, blood bag!"',
    );
    assert.equal(summary.length, 1);
    assert.match(summary[0].lead, /Summon crystal shards/);
});

test('an extremely long single sentence is capped on a word boundary', () => {
    const summary = deriveAbilitySummary(
        `She can ${'control gravity over a wide area and '.repeat(20)}lift buildings.`,
    );
    assertWellFormed(summary);
    assert.ok(summary[0].lead.length <= MAX_ABILITY_LEAD);
    assert.ok(!summary[0].lead.endsWith(' '));
});

test('caps: skills, traits, and ability items stay within their limits', () => {
    const abilities = Array.from({ length: 20 }, (_, index) => (
        `She can summon creature ${index} from the void.`
    )).join(' ');
    const facets = deriveCardFacets({ abilities });
    assert.ok(facets.abilitySummary.length <= MAX_ABILITY_ITEMS);
    assert.ok(facets.skills.length <= MAX_SKILL_ITEMS);
});

test('stored ability lines round-trip through parse/format helpers', () => {
    const line = abilityLine({ lead: 'Gravity manipulation', detail: 'Lightens or weights herself' });
    assert.equal(line, 'Gravity manipulation — Lightens or weights herself');
    assert.deepEqual(parseAbilityLine(line), {
        lead: 'Gravity manipulation',
        detail: 'Lightens or weights herself',
    });
    assert.deepEqual(abilitySummaryLines([{ lead: 'Flight', detail: '' }]), ['Flight']);
});

test('old chats holding a prose paragraph still render as short items', () => {
    const items = abilityItems([
        'Aurelia has superhuman physiology and can fly. Her main superpower creates yellow energy rings by gyrating parts of her body.',
    ]);
    assert.ok(items.length >= 2, JSON.stringify(items));
    assert.ok(items.every((item) => item.lead.length <= MAX_ABILITY_LEAD));
    assert.ok(items.every((item) => !/[.!?]\s+\S/.test(item.lead)));
});

test('a run-on legacy paragraph is kept whole rather than chopped mid-thought', () => {
    const runOn = 'A one-clause run-on that simply never ends and keeps going without any punctuation to break on';
    const items = abilityItems([runOn]);
    assert.equal(items.length, 1);
    assert.equal(items[0].lead, runOn);
    assert.equal(items[0].detail, '');
});
