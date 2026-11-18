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
    goals: ['Goals/Motives', 'Goals/Motive', 'Goal/Motives', 'Motive', 'Ultimate Goal'],
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
    // Aliases are already derived into registry entries.
    if (/alias|codename/.test(normalized)) {
        return { ignored: true };
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
        if (classified.sensitive) {
            sensitive.push({ label: section.rawLabel, text: section.body });
            continue;
        }
        extras.push({ label: section.rawLabel, text: section.body });
    }

    return { fields, forms, sensitive, extras };
}

function buildProfile({ sections, name, source }) {
    const { fields, forms, sensitive, extras } = collectFields(sections);

    const profile = {
        name,
        gender: pickSection(fields, 'gender'),
        species: pickSection(fields, 'species'),
        occupation: pickSection(fields, 'occupation'),
        faction: pickSection(fields, 'faction'),
        appearance: pickSection(fields, 'appearance'),
        attire: pickSection(fields, 'attire'),
        abilities: pickSection(fields, 'abilities'),
        personality: pickSection(fields, 'personality'),
        speech: pickSection(fields, 'speech'),
        likes: splitListText(pickSection(fields, 'likes')),
        dislikes: splitListText(pickSection(fields, 'dislikes')),
        goals: splitListText(pickSection(fields, 'goals')),
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
        });
    }

    const actorProfiles = blocks.actors.map((actorSections) => buildProfile({
        // Actor text wins; the shared preamble only fills fields it owns.
        sections: [...actorSections, ...blocks.preamble],
        name: actorName(actorSections, dataName),
        source: sourceInfo,
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
