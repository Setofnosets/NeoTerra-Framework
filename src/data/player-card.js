/**
 * Player-card export.
 *
 * Builds a SillyTavern V2/V3 character-card envelope from a played character's
 * live state, card profile, and season context. Pure and DOM-free: the Codex
 * and the season menu only render the instruction; the download is a user
 * action handled by the UI.
 *
 * Nothing here writes to `Chars/` or installs the card. Any prompt marker that
 * leaked into stored text is stripped defensively before it reaches the card.
 */

export const PLAYER_CARD_SPEC = 'chara_card_v3';
export const PLAYER_CARD_SPEC_VERSION = '3.0';

const MARKER_PATTERN = /\[NEOTERRA_[A-Z_]+\][\s\S]*?(?=\n\n|$)/g;
const FALLBACK_NAME = 'The Player';
const FALLBACK_FIRST_MES = 'The story continues.';
const MAX_FIRST_MES = 1400;
const MAX_FILENAME = 80;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function cleanText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(MARKER_PATTERN, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Arrays join into prose; a single string is kept as written. */
function joinedText(value) {
    if (Array.isArray(value)) {
        return asArray(value)
            .map(cleanText)
            .filter((item) => item.length > 0)
            .join(', ');
    }
    return cleanText(value);
}

function firstText(...values) {
    for (const value of values) {
        const text = joinedText(value);
        if (text.length > 0) {
            return text;
        }
    }
    return '';
}

function resolvedName(character, registryEntry) {
    // `character.displayName` is the card name and is kept byte-for-byte.
    if (typeof character?.displayName === 'string' && character.displayName.length > 0) {
        return character.displayName;
    }
    if (typeof character?.charId === 'string' && character.charId.length > 0) {
        return character.charId;
    }
    if (typeof registryEntry?.displayName === 'string' && registryEntry.displayName.length > 0) {
        return registryEntry.displayName;
    }
    if (typeof registryEntry?.id === 'string' && registryEntry.id.length > 0) {
        return registryEntry.id;
    }
    return FALLBACK_NAME;
}

function locationFor({ character, registryEntry, season }) {
    return firstText(
        season?.locationName,
        season?.startLocationName,
        character?.locationName,
        character?.locationId,
        registryEntry?.locationName,
        season?.startLocationId,
    );
}

function buildDescription({ name, character, profile, goals }) {
    const identity = cleanText(profile?.identity);
    const parts = [identity ? `[${name} is ${identity}.` : `[${name}.`];

    const add = (label, value) => {
        const text = joinedText(value);
        if (text.length > 0) {
            parts.push(`${label}: ${text}`);
        }
    };

    add('Identity Status', identity);
    add('Appearance', firstText(profile?.appearance, character?.appearance));
    add('Attire', firstText(profile?.attire, character?.outfit));
    add('Abilities', firstText(profile?.abilities, character?.abilities));
    add('Personality', firstText(profile?.personality));
    add('Speech', firstText(profile?.speech));
    add('Likes', firstText(profile?.likes, character?.likes));
    add('Dislikes', firstText(profile?.dislikes, character?.dislikes));
    add('Goals/Motives', firstText(goals, profile?.goals, character?.goals));
    add('Background', firstText(profile?.background, character?.notes));
    add('Weakness', firstText(profile?.weakness));
    add('Combat Style', firstText(profile?.combatStyle));
    add('Gear', firstText(profile?.gear));

    return parts.join('\n\n');
}

function buildFirstMes({ name, locationIntro, locationName }) {
    const intro = cleanText(locationIntro);
    if (intro.length > 0) {
        return intro.slice(0, MAX_FIRST_MES);
    }
    if (locationName.length > 0) {
        return `${name} is in ${locationName}.`;
    }
    return FALLBACK_FIRST_MES;
}

function buildTags(character) {
    const seen = new Set();
    const tags = [];
    for (const value of [character?.side, 'neo-terra']) {
        if (typeof value !== 'string') {
            continue;
        }
        const text = value.trim();
        if (text.length === 0 || seen.has(text)) {
            continue;
        }
        seen.add(text);
        tags.push(text);
    }
    return tags;
}

/**
 * A SillyTavern character-card document for the played character.
 *
 * Tolerates a missing profile, registry entry, or season: a sandbox/generated
 * character still produces a valid envelope from its stored fields.
 */
export function buildPlayerCardDocument({
    character = null,
    profile = null,
    registryEntry = null,
    season = null,
    goals = null,
    locationIntro = null,
} = {}) {
    const name = resolvedName(character, registryEntry);
    const locationName = locationFor({ character, registryEntry, season });
    return {
        spec: PLAYER_CARD_SPEC,
        spec_version: PLAYER_CARD_SPEC_VERSION,
        data: {
            name,
            description: buildDescription({ name, character, profile, goals }),
            personality: '',
            scenario: '',
            mes_example: '',
            first_mes: buildFirstMes({ name, locationIntro, locationName }),
            creator_notes: `Player card exported by Neo Terra for ${name}.`,
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: buildTags(character),
            creator: 'Neo Terra',
            character_version: '',
            extensions: { neoterra: { playerCard: true } },
        },
    };
}

/** Alias for callers that call the envelope by name. One source of truth. */
export function buildPlayerCardEnvelope(options = {}) {
    return buildPlayerCardDocument(options);
}

/** One copyable sentence naming the card to create and select. */
export function buildPlayerCardInstruction({
    displayName,
    seasonTitle = null,
    locationName = null,
} = {}) {
    // Verbatim display name in the instruction string; only the empty-check and
    // the surrounding copy are trimmed.
    const name = typeof displayName === 'string' && displayName.trim().length > 0
        ? displayName
        : FALLBACK_NAME;
    const context = [];
    if (typeof seasonTitle === 'string' && seasonTitle.trim().length > 0) {
        context.push(seasonTitle.trim());
    }
    if (typeof locationName === 'string' && locationName.trim().length > 0) {
        context.push(`at ${locationName.trim()}`);
    }
    const suffix = context.length > 0 ? ` (${context.join(', ')})` : '';
    return `Create a character card named ${name} in SillyTavern (Characters → Import character), `
        + `then select it in this chat so the narrator addresses you by name.${suffix}`;
}

/** Filesystem-safe download name; the caller appends `.json`. */
export function sanitizeCardFilename(displayName) {
    const raw = typeof displayName === 'string' ? displayName : '';
    let safe = raw
        .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/\s+/g, ' ');
    safe = safe.replace(/^[\s.-]+|[\s.-]+$/g, '');
    if (safe.length > MAX_FILENAME) {
        safe = safe.slice(0, MAX_FILENAME).replace(/[\s.-]+$/g, '');
    }
    return safe.length > 0 ? safe : 'Player';
}
