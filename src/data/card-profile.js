/**
 * Banner-style character-card profile parser.
 *
 * Character cards keep their prose in `data.description` as `Label: value`
 * sections separated by blank lines. The registry only stores derived metadata
 * (aliases, side, threat level), so the codex and the prompt renderer need the
 * labelled bodies too. This module is browser-safe: no IO, no globals, and no
 * throws on malformed input.
 *
 * The parser is deliberately label-tolerant: the card vocabulary has a long
 * tail (`Speech/Mannerism`, `Goals/Motive`, condition-prefixed abilities and
 * attire). Unknown labels are kept in `extras` rather than dropped.
 */

import { deriveCardFacets } from './card-facets.js';

const LABEL_PATTERN = /^[ \t]*([A-Z][^\n:]{1,40}?)[ \t]*:[ \t]*/gm;
const FIELD_LABELS = Object.freeze({
    appearance: [
        'Appearance',
        'Civilian Appearance',
        'Superhero Appearance',
        'Supervillain Appearance',
        'Metahuman Appearance',
        'New Appearance',
        'Original Appearance',
    ],
    attire: [
        'Attire',
        'Other Attire',
        'Current Attire',
        'Casual Attire',
        'Non-themed Attire',
        'Civilian Attire',
        'Hero Attire',
        'Superhero Attire',
        'Supervillain Attire',
        'Villain Attire',
        'Vigilante Attire',
        'Supervillain/Hero Attire',
    ],
    abilities: [
        'Abilities',
        'Original Abilities',
        'New Abilities',
        'Former Abilities',
        'Natural Abilities',
        'Corrupted Abilities',
        'Cursed Abilities',
        'Knight Abilities',
        'Suit Abilities',
        'Old (still useable) Abilities',
        'Phoenix Soul',
    ],
    personality: ['Personality', 'Behavior', 'Worldview/Morals'],
    speech: ['Speech', 'Speech/Mannerisms', 'Speech/Mannerism', 'Communication'],
    likes: ['Likes', 'Like', 'Loves'],
    dislikes: ['Dislikes', 'Dislike', 'Most Hated'],
    goals: [
        'Goals/Motives',
        'Goals/Motive',
        'Goal/Motives',
        'Motive',
        'Ultimate Goal',
        'Goals',
        'Motivation',
        'Motivations',
        'Drive',
        'Main drive',
        'Ambition',
        'Objective',
    ],
    skills: ['Skills', 'Skill', 'Abilities/Skills'],
    traits: [
        'Traits',
        'Trait',
        'Passives',
        'Passive',
        'New Traits',
        'Corrupted Traits',
        'Former Traits',
    ],
    background: ['Background', 'Old Life'],
    identity: ['Identity Status', 'Name'],
    gender: ['Gender'],
    species: ['Species'],
    occupation: ['Occupation'],
    faction: ['Faction'],
    gear: ['Gear', 'Special Weapon'],
    weakness: ['Weakness'],
    combatStyle: ['Combat Style', 'Fighting Style'],
});

const SENSITIVE_LABELS = Object.freeze([
    'Sexual Information',
    'Sexual Preference',
    'Sexual Personality',
    'Kink',
]);

const IGNORED_LABELS = new Set([
    'setting world',
    'threat level',
    'side',
    'ooc reminder',
    'important',
]);

/** Display keys reported in `missing` when a card has no such section. */
const PROFILE_KEYS = Object.freeze([
    'appearance',
    'attire',
    'abilities',
    'personality',
    'speech',
    'likes',
    'dislikes',
    'goals',
    'background',
    'identity',
    'gender',
    'species',
    'occupation',
    'faction',
    'combatStyle',
    'gear',
    'weakness',
]);

const LIST_KEYS = new Set(['likes', 'dislikes', 'goals']);

const MAX_GOALS = 5;
const MAX_GOAL_CHARS = 160;
const TRAILING_GOAL_JUNK = /[\s,;:.\-\u2013\u2014]+$/;

const ALIAS_LABEL_PATTERN = /^[ \t]*[^\n:]{0,60}?Aliases?(?:\/Codenames)?[ \t]*:[ \t]*([\s\S]*?)(?=\r?\n[ \t]*\r?\n|$)/gim;

/** Alias fragments that are really role notes, not names. */
const ALIAS_STOPWORDS = new Set(['supervillain name', 'superhero name', 'former superhero name', 'civilian name', 'former civilian name', 'official supervillain name', 'knight name']);

function cleanAlias(fragment) {
    return String(fragment ?? '')
        .replace(/["\u201c\u201d\u2018\u2019]/g, '')
        .replace(/^[\s,;.\-\u2013\u2014:]+|[\s,;.\-\u2013\u2014:]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isAliasCandidate(value) {
    if (!value) {
        return false;
    }
    if (value.length > 60 || value.includes(':')) {
        return false;
    }
    if (value.split(/\s+/).length > 6) {
        return false;
    }
    return !ALIAS_STOPWORDS.has(value.toLowerCase());
}

function pushAlias(list, value) {
    const alias = cleanAlias(value);
    if (!isAliasCandidate(alias)) {
        return;
    }
    if (list.some((existing) => existing.toLowerCase() === alias.toLowerCase())) {
        return;
    }
    if (list.length < 6) {
        list.push(alias);
    }
}

/**
 * Derive aliases from a card description.
 *
 * Alias labels are preferred; a card without one still yields the names in
 * the opening line (`known as X`, `is X, a …`). Both the registry build and
 * the profile parser use this single implementation so they cannot disagree.
 *
 * @param {unknown} description
 * @param {{ displayName?: string }} [options]
 * @returns {string[]}
 */
export function parseAliases(description, { displayName = '' } = {}) {
    if (typeof description !== 'string' || description.length === 0) {
        return [];
    }
    const text = normalizeCardText(description);
    const aliases = [];

    // An alias label owns the rest of its line(s) up to a blank line.
    const labelPattern = new RegExp(ALIAS_LABEL_PATTERN.source, 'gim');
    let labelled = false;
    let match;
    while ((match = labelPattern.exec(text)) !== null) {
        labelled = true;
        const body = match[1]
            .replace(/"[^"]*"/g, ' ')
            .replace(/\u201c[^\u201d]*\u201d/g, ' ');
        // A parenthetical is a role marker (`(supervillain name)`); it splits
        // the names on both sides instead of swallowing the next one.
        for (const fragment of body.replace(/\([^)]*\)/g, ';').split(/[.;\n\/]|,(?=\s)/)) {
            pushAlias(aliases, fragment);
        }
    }

    if (!labelled) {
        // A derived alias that merely repeats the display name adds nothing.
        const derived = [];
        // `a superhero known as 'Hula Hawk'` / `known as Longshot`
        const known = text.match(/known as\s+['\u2018\u201c]?([A-Z][^'\u2019\u201d.,;\n]{1,40})/);
        if (known) {
            pushAlias(derived, known[1]);
        }
        // `is Aurelia Selwind, a superhero …`
        const identity = text.match(/\bis\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3}),\s*(?:a|an|the)\s/);
        if (identity) {
            pushAlias(derived, identity[1]);
        }
        for (const alias of derived) {
            if (!displayName || alias.toLowerCase() !== displayName.toLowerCase()) {
                aliases.push(alias);
            }
        }
    }

    return aliases;
}

function normalizeLabel(label) {
    return String(label ?? '')
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .trim();
}

const KEY_BY_LABEL = new Map();
const PREFERRED_LABEL = new Map();
for (const [key, labels] of Object.entries(FIELD_LABELS)) {
    PREFERRED_LABEL.set(key, normalizeLabel(labels[0]));
    for (const label of labels) {
        KEY_BY_LABEL.set(normalizeLabel(label), key);
    }
}

const SENSITIVE_KEYS = new Set(SENSITIVE_LABELS.map(normalizeLabel));

/**
 * Normalize card text without touching its wording.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCardText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

/**
 * Split a list-like body into short items when it clearly is a list.
 *
 * The fallback is the whole body as one item: a 400-character paragraph must
 * stay a paragraph, not become a one-line bullet.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitListText(value) {
    const text = normalizeCardText(value).trim();
    if (!text) {
        return [];
    }

    const parts = text
        .split(/\n+|;|,(?=\s)|\.(?=\s|$)/)
        .map((part) => part
            .replace(/^[\s*•\-–—]+/, '')
            .replace(/^\s*(?:and|&)\s+/i, '')
            .replace(/^\s*\d+[.)]\s*/, '')
            .replace(/[\s.;:]+$/, '')
            .trim())
        .filter(Boolean);

    if (parts.length < 2 || parts.length > 20) {
        return [text];
    }
    if (parts.some((part) => part.length > 80 || part.includes('. '))) {
        return [text];
    }
    return parts;
}

function classifyLabel(rawLabel) {
    const label = String(rawLabel ?? '').trim();
    const normalized = normalizeLabel(label);

    if (!normalized) {
        return { ignored: true };
    }
    if (IGNORED_LABELS.has(normalized)) {
        return { ignored: true };
    }
    // Aliases are registry metadata and a profile field; both are derived by
    // `parseAliases` from the same text so they cannot disagree.
    if (/alias|codename/.test(normalized)) {
        return { alias: true };
    }

    const formMatch = label.match(/^(?:transformation into|transform into)\s+(.+)$/i);
    if (formMatch) {
        return { form: formMatch[1].trim().replace(/\s+/g, ' ') };
    }
    if (/^.+['\u2019]s personality$/i.test(label)) {
        return { key: 'personality' };
    }
    if (/^former (?:motive|goal) as .+$/i.test(label)) {
        return { key: 'goals' };
    }
    if (SENSITIVE_KEYS.has(normalized)) {
        return { sensitive: true };
    }
    const key = KEY_BY_LABEL.get(normalized);
    if (key) {
        return { key };
    }
    return { extra: true };
}

function collectSections(text) {
    const sections = [];
    const matches = [...text.matchAll(LABEL_PATTERN)];
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const next = matches[index + 1];
        const start = (match.index ?? 0) + match[0].length;
        const end = next ? next.index : text.length;
        sections.push({
            rawLabel: match[1].trim(),
            normalizedLabel: normalizeLabel(match[1]),
            body: text.slice(start, end).trim(),
        });
    }
    return sections;
}

function pickSection(fields, key) {
    const entries = fields[key];
    if (!entries || entries.length === 0) {
        return '';
    }
    const preferred = PREFERRED_LABEL.get(key);
    const exact = entries.find((entry) => entry.normalizedLabel === preferred);
    return (exact ?? entries[0]).body;
}

/**
 * Look up the `Transformation into <form>` body for a selected form label.
 *
 * @param {{ forms?: Record<string, string> }|null} profile
 * @param {unknown} formName
 * @returns {string|null}
 */
export function findFormSection(profile, formName) {
    const target = String(formName ?? '').trim().toLowerCase();
    if (!target) {
        return null;
    }
    for (const [name, body] of Object.entries(profile?.forms ?? {})) {
        if (name.trim().toLowerCase() === target) {
            return body;
        }
    }
    return null;
}

function collectFields(sections) {
    const fields = {};
    const forms = {};
    const sensitive = [];
    const extras = [];

    for (const section of sections) {
        const classified = classifyLabel(section.rawLabel);
        if (classified.ignored) {
            continue;
        }
        if (classified.form) {
            forms[classified.form] = section.body;
            continue;
        }
        if (classified.key) {
            (fields[classified.key] ??= []).push(section);
            continue;
        }
        // Alias labels are registry/profile metadata derived by `parseAliases`
        // from the whole description; they are never prose for the card block.
        if (classified.alias) {
            continue;
        }
        if (classified.sensitive) {
            sensitive.push({ label: section.rawLabel, text: section.body });
            continue;
        }
        extras.push({ label: section.rawLabel, text: section.body });
    }

    return { fields, forms, sensitive, extras };
}

function buildProfile({ sections, name, source, description = '' }) {
    const { fields, forms, sensitive, extras } = collectFields(sections);

    const goals = splitListText(pickSection(fields, 'goals'))
        .map((goal) => (goal.length > MAX_GOAL_CHARS
            ? goal.slice(0, MAX_GOAL_CHARS).replace(/\s+\S*$/, '').replace(TRAILING_GOAL_JUNK, '').trim()
            : goal))
        .filter(Boolean)
        .slice(0, MAX_GOALS);
    const explicitTraits = pickSection(fields, 'traits');
    const explicitSkills = pickSection(fields, 'skills');
    const abilities = pickSection(fields, 'abilities');
    const facets = deriveCardFacets({
        name,
        abilities,
        explicitSkills,
        explicitTraits,
    });

    const profile = {
        name,
        gender: pickSection(fields, 'gender'),
        species: pickSection(fields, 'species'),
        occupation: pickSection(fields, 'occupation'),
        faction: pickSection(fields, 'faction'),
        aliases: parseAliases(description, { displayName: name }),
        appearance: pickSection(fields, 'appearance'),
        attire: pickSection(fields, 'attire'),
        abilities,
        abilitySummary: facets.abilitySummary,
        skills: facets.skills,
        traits: facets.traits,
        personality: pickSection(fields, 'personality'),
        speech: pickSection(fields, 'speech'),
        likes: splitListText(pickSection(fields, 'likes')),
        dislikes: splitListText(pickSection(fields, 'dislikes')),
        goals,
        background: pickSection(fields, 'background'),
        identity: pickSection(fields, 'identity'),
        combatStyle: pickSection(fields, 'combatStyle'),
        gear: pickSection(fields, 'gear'),
        weakness: pickSection(fields, 'weakness'),
        sensitive,
        extras,
        forms,
        // A present-but-empty label does not provide a value.
        missing: PROFILE_KEYS.filter((key) => pickSection(fields, key).trim().length === 0),
        source,
    };
    for (const key of ['skills', 'traits']) {
        if (profile[key].length === 0) {
            profile.missing.push(key);
        }
    }

    // Keep list fields stable even if a future field joins LIST_KEYS.
    for (const key of LIST_KEYS) {
        if (!Array.isArray(profile[key])) {
            profile[key] = [];
        }
    }

    return profile;
}

/**
 * Split a multi-actor bundle card at `[Character N;` framing lines.
 *
 * Card framing (`[Character 1;` … `]`) is not a label, so without this split it
 * leaks into the previous section and merges two actors into one profile.
 */
function splitActorBlocks(text) {
    const lines = text.split('\n');
    const preamble = [];
    const actors = [];
    let current = null;

    for (const line of lines) {
        if (/^[ \t]*\[Character\s+\d+\s*[;:]/i.test(line)) {
            current = [];
            actors.push(current);
            continue;
        }
        (current ?? preamble).push(line);
    }

    const clean = (blockLines) => blockLines
        .join('\n')
        .replace(/\]\s*$/, '')
        .trim();

    return {
        preamble: collectSections(clean(preamble)),
        actors: actors.map((blockLines) => collectSections(clean(blockLines))),
    };
}

function actorName(sections, fallback) {
    const section = sections.find((entry) => entry.normalizedLabel === 'name');
    const value = section?.body.split('\n')[0].trim() ?? '';
    return value.length > 0 ? value : fallback;
}

/**
 * Parse a raw V2 character card into a stable profile object.
 *
 * Bundle cards with `[Character N;` blocks expose per-actor profiles under
 * `actors`; the top-level fields describe the first actor (with shared
 * preamble fields such as `Gender` and `Species` merged in).
 *
 * @param {unknown} card
 * @param {{ file?: string|null, cardPath?: string|null }|null} [source]
 * @returns {object|null} `null` when the card or its description is unreadable.
 */
export function parseCardProfile(card, source = {}) {
    if (card === null || typeof card !== 'object' || Array.isArray(card)) {
        return null;
    }
    const data = card.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return null;
    }
    if (typeof data.description !== 'string') {
        return null;
    }

    const sourceInfo = {
        file: source?.file ?? null,
        cardPath: source?.cardPath ?? null,
        dataName: typeof data.name === 'string' ? data.name : '',
    };
    const dataName = typeof data.name === 'string' ? data.name : '';
    const text = normalizeCardText(data.description);
    const blocks = splitActorBlocks(text);

    if (blocks.actors.length === 0) {
        return buildProfile({
            sections: collectSections(text),
            name: dataName,
            source: sourceInfo,
            description: text,
        });
    }

    const actorProfiles = blocks.actors.map((actorSections) => buildProfile({
        // Actor text wins; the shared preamble only fills fields it owns.
        sections: [...actorSections, ...blocks.preamble],
        name: actorName(actorSections, dataName),
        source: sourceInfo,
        description: text,
    }));

    if (actorProfiles.length === 1) {
        return actorProfiles[0];
    }

    const first = actorProfiles[0];
    return {
        ...first,
        name: dataName,
        actors: actorProfiles,
    };
}
