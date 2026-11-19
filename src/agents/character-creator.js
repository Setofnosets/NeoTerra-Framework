/**
 * Neo Terra Character Creator.
 *
 * Best-effort drafting of a non-canon supporting character from a short
 * concept. The module is split in two halves:
 *
 *  - pure helpers (schema, prompt, validation, description assembly, and the
 *    CharacterState builder) used by the Codex preview and by tests;
 *  - `createCharacterCreator`, the thin runner wrapper that performs exactly
 *    one request (plus one larger-budget retry) and never mutates state.
 *
 * The model only proposes structured fields. The labelled card description is
 * assembled deterministically, so section order and labels cannot drift.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGateToPrompt } from '../core/content-gate.js';
import { splitListText } from '../data/card-profile.js';

export const MAX_NAME = 60;
export const MAX_IDENTITY = 140;
export const MAX_APPEARANCE = 700;
export const MAX_ATTIRE = 600;
export const MAX_ABILITIES = 800;
export const MAX_PERSONALITY = 1000;
export const MAX_SPEECH = 700;
export const MAX_BACKGROUND = 900;
export const MAX_WEAKNESS = 260;
export const MAX_COMBAT_STYLE = 260;
export const MAX_GEAR = 260;
export const MAX_FIRST_MES = 1400;
export const MIN_FIRST_MES = 400;
export const MAX_MES_EXAMPLE = 800;
export const MAX_TAGS = 12;
export const MIN_TAGS = 6;
export const MAX_LIST_ITEMS = 8;
export const MAX_EXEMPLAR_CHARS = 8000;
export const MAX_CANON_LINKS = 8;

export const CARD_SIDES = Object.freeze(['hero', 'villain', 'vigilante', 'civilian', 'neutral']);
export const THREAT_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** Fields the model must return. Optional-but-useful fields may be empty. */
export const REQUIRED_CARD_FIELDS = Object.freeze([
    'name',
    'side',
    'appearance',
    'abilities',
    'personality',
    'speech',
    'background',
    'firstMes',
    'mesExample',
]);

export const CHARACTER_CREATOR_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: REQUIRED_CARD_FIELDS,
    properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        aliases: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', maxLength: 40 },
        },
        identity: { type: 'string', maxLength: MAX_IDENTITY },
        side: { type: 'string', enum: CARD_SIDES },
        threatLevel: { type: ['string', 'null'], enum: [...THREAT_LEVELS, null] },
        gender: { type: 'string', maxLength: 40 },
        species: { type: 'string', maxLength: 60 },
        occupation: { type: 'string', maxLength: 80 },
        faction: { type: 'string', maxLength: 80 },
        appearance: { type: 'string', minLength: 1, maxLength: MAX_APPEARANCE * 2 },
        attire: { type: 'string', maxLength: MAX_ATTIRE * 2 },
        abilities: { type: 'string', minLength: 1, maxLength: MAX_ABILITIES * 2 },
        personality: { type: 'string', minLength: 1, maxLength: MAX_PERSONALITY * 2 },
        speech: { type: 'string', minLength: 1, maxLength: MAX_SPEECH * 2 },
        likes: {
            type: 'array',
            maxItems: MAX_LIST_ITEMS,
            items: { type: 'string', maxLength: 120 },
        },
        dislikes: {
            type: 'array',
            maxItems: MAX_LIST_ITEMS,
            items: { type: 'string', maxLength: 120 },
        },
        goals: {
            type: 'array',
            maxItems: MAX_LIST_ITEMS,
            items: { type: 'string', maxLength: 160 },
        },
        background: { type: 'string', minLength: 1, maxLength: MAX_BACKGROUND * 2 },
        combatStyle: { type: 'string', maxLength: MAX_COMBAT_STYLE * 2 },
        gear: { type: 'string', maxLength: MAX_GEAR * 2 },
        weakness: { type: 'string', maxLength: MAX_WEAKNESS * 2 },
        firstMes: { type: 'string', minLength: 1, maxLength: MAX_FIRST_MES * 3 },
        mesExample: { type: 'string', minLength: 1, maxLength: MAX_MES_EXAMPLE * 3 },
        tags: {
            type: 'array',
            maxItems: MAX_TAGS,
            items: { type: 'string', maxLength: 40 },
        },
        canonLinks: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threatIds: {
                    type: 'array',
                    maxItems: MAX_CANON_LINKS,
                    items: { type: 'string' },
                },
                factionIds: {
                    type: 'array',
                    maxItems: MAX_CANON_LINKS,
                    items: { type: 'string' },
                },
                characterIds: {
                    type: 'array',
                    maxItems: MAX_CANON_LINKS,
                    items: { type: 'string' },
                },
            },
        },
    },
});

/** Fields that may be clamped; `null` disables a limit. */
export const FIELD_CAPS = Object.freeze({
    name: MAX_NAME,
    identity: MAX_IDENTITY,
    appearance: MAX_APPEARANCE,
    attire: MAX_ATTIRE,
    abilities: MAX_ABILITIES,
    personality: MAX_PERSONALITY,
    speech: MAX_SPEECH,
    background: MAX_BACKGROUND,
    weakness: MAX_WEAKNESS,
    combatStyle: MAX_COMBAT_STYLE,
    gear: MAX_GEAR,
    firstMes: MAX_FIRST_MES,
    mesExample: MAX_MES_EXAMPLE,
});

const DESCRIPTION_SECTIONS = Object.freeze([
    ['Setting/World', null],
    ['Gender', 'gender'],
    ['Species', 'species'],
    ['Occupation', 'occupation'],
    ['Faction', 'faction'],
    ['Identity Status', 'identity'],
    ['Appearance', 'appearance'],
    ['Attire', 'attire'],
    ['Abilities', 'abilities'],
    ['Background', 'background'],
    ['Personality', 'personality'],
    ['Speech', 'speech'],
    ['Likes', 'likes'],
    ['Dislikes', 'dislikes'],
    ['Goals/Motives', 'goals'],
    ['Combat Style', 'combatStyle'],
    ['Gear', 'gear'],
    ['Weakness', 'weakness'],
]);

const DEFAULT_WORLD_LINE = 'A massive, well-maintained city called Neo Terra in a comic-book style world.';

const META_PHRASES = Object.freeze([
    'the player',
    'neo terra extension',
    'as an ai',
    'language model',
    'system prompt',
    'you feel',
    'your feelings',
]);

const LABEL_LEAK_PATTERN = /^[ \t]*(?:Name|Setting\/World|Gender|Species|Occupation|Faction|Appearance|Attire|Abilities|Background|Personality|Speech|Likes|Dislikes|Goals\/Motives|Combat Style|Gear|Weakness)[ \t]*:/im;

const DISTRICT_STOP_WORDS = new Set([
    'the', 'a', 'an', 'in', 'at', 'on', 'from', 'of', 'near', 'by', 'to',
    'and', 'out', 'into', 'across', 'over', 'under', 'through', 'within',
    'around', 'past', 'off', 'up', 'down', 'for', 'with', 'she', 'he',
    'they', 'it', 'we', 'you', 'i', 'his', 'her', 'their', 'our', 'my',
    'your', 'its', 'this', 'that', 'these', 'those',
]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function text(value, max = null) {
    if (typeof value !== 'string') {
        return '';
    }
    const trimmed = value.trim();
    return max === null ? trimmed : trimmed.slice(0, max);
}

function list(value, { maxItems = MAX_LIST_ITEMS, maxLength = 160 } = {}) {
    return asArray(value)
        .map((item) => text(item, maxLength))
        .filter(Boolean)
        .slice(0, maxItems);
}

function clampText(value, cap) {
    const source = text(value);
    if (!cap || source.length <= cap) {
        return { value: source, trimmed: false, over: source.length > cap };
    }
    if (source.length <= Math.floor(cap * 1.25)) {
        return { value: source, trimmed: false, over: true };
    }
    const window = source.slice(0, cap);
    const boundary = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('\n'),
    );
    const cut = boundary >= Math.floor(cap * 0.6) ? window.slice(0, boundary + 1) : window;
    return { value: cut.trim(), trimmed: true, over: true };
}

/** Normalize a name for collision checks (case, diacritics, punctuation). */
export function normalizeCardName(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Stable, collision-friendly id slug for a generated card. */
export function slugifyCardName(value, max = 40) {
    return normalizeCardName(value).replace(/\s+/g, '-').slice(0, max).replace(/^-+|-+$/g, '');
}

function registryEntries(registry) {
    if (Array.isArray(registry)) {
        return registry;
    }
    return asArray(registry?.entries);
}

function registryNames(registry) {
    const names = new Map();
    for (const entry of registryEntries(registry)) {
        if (!isObject(entry)) {
            continue;
        }
        const label = entry.displayName ?? entry.dataName ?? entry.id;
        for (const candidate of [entry.displayName, entry.dataName, ...asArray(entry.aliases)]) {
            const key = normalizeCardName(candidate);
            if (key && !names.has(key)) {
                names.set(key, label);
            }
        }
    }
    return names;
}

function seasonThreatIds(season) {
    return asArray(season?.threats).map((threat) => threat?.id).filter(Boolean);
}

function seasonFactionIds(season, factions) {
    if (isObject(season) && Array.isArray(season.factions) && season.factions.length > 0) {
        // Season membership is authoritative: the global factions document only
        // supplies display names, so a cross-season id can never be kept.
        return new Set(season.factions.map((faction) => faction?.id).filter(Boolean));
    }
    const source = Array.isArray(factions) ? factions : asArray(factions?.factions);
    return new Set(source
        .map((faction) => (isObject(faction) ? faction.id : null))
        .filter(Boolean));
}

function seasonFactionNames(season, factions) {
    const source = Array.isArray(factions) ? factions : asArray(factions?.factions);
    const byId = new Map();
    for (const faction of source) {
        if (isObject(faction) && typeof faction.id === 'string') {
            byId.set(faction.id, typeof faction.name === 'string' ? faction.name : faction.id);
        }
    }
    const names = new Set();
    for (const faction of asArray(season?.factions)) {
        if (!isObject(faction) || typeof faction.id !== 'string') {
            continue;
        }
        names.add(normalizeCardName(byId.get(faction.id) ?? faction.id));
    }
    return names;
}

function seasonCharacterIds(season) {
    return new Set(asArray(season?.roster).map((member) => member?.characterId).filter(Boolean));
}

function districtNames(districts) {
    const source = Array.isArray(districts) ? districts : asArray(districts?.districts);
    return source
        .map((district) => (isObject(district) ? district.name : null))
        .filter(Boolean);
}

function eraYears(season) {
    const matches = String(season?.era ?? '').match(/\d{4}/g) ?? [];
    const years = matches.map(Number).filter(Number.isFinite);
    if (years.length === 0) {
        return { min: null, max: null };
    }
    return { min: Math.min(...years), max: Math.max(...years) };
}

function mainThreatName(season) {
    const threats = asArray(season?.threats);
    return (threats.find((threat) => threat?.rank === 'main') ?? threats[0])?.name ?? null;
}

function agendaFor(side, season) {
    const threat = mainThreatName(season);
    if (side === 'villain') {
        return threat ? `Advance ${threat}'s agenda` : 'Advance your own criminal agenda';
    }
    if (side === 'hero') {
        return threat ? `Oppose ${threat} and protect Neo Terra` : 'Protect Neo Terra from the city\'s threats';
    }
    if (side === 'vigilante') {
        return threat ? `Undermine ${threat} on your own terms` : 'Protect Neo Terra on your own terms';
    }
    return `Survive the events of ${season?.title ?? 'Neo Terra'}`;
}

/**
 * Assemble the deterministic labelled card description from structured fields.
 *
 * The shared world line always comes from the season's comic-book premise, so
 * a generated card cannot rewrite the setting.
 */
export function assembleCardDescription(card, { worldLine = DEFAULT_WORLD_LINE } = {}) {
    const value = isObject(card) ? card : {};
    const name = text(value.name, MAX_NAME) || 'Unnamed';
    const identity = text(value.identity, MAX_IDENTITY);
    const intro = identity ? `[{{char}} is ${name}, ${identity}.` : `[{{char}} is ${name}.`;
    const lines = [intro];
    for (const [label, key] of DESCRIPTION_SECTIONS) {
        if (key === null) {
            lines.push(`${label}: ${text(worldLine)}`);
            continue;
        }
        const raw = value[key];
        const body = Array.isArray(raw) ? raw.map((item) => text(item)).filter(Boolean).join(', ') : text(raw);
        if (body) {
            lines.push(`${label}: ${body}`);
        }
    }
    return `${lines.join('\n\n')}\n`;
}

/** Build the deterministic `chara_card_v3` envelope for export and storage. */
export function buildGeneratedCardEnvelope(card, { description, creatorNotes = 'Generated by the Neo Terra character creator. Non-canon.' } = {}) {
    const value = isObject(card) ? card : {};
    const name = text(value.name, MAX_NAME) || 'Unnamed';
    const body = typeof description === 'string' ? description : assembleCardDescription(value);
    const tags = list(value.tags, { maxItems: MAX_TAGS, maxLength: 40 });
    const firstMes = text(value.firstMes);
    const mesExample = text(value.mesExample);
    const data = {
        name,
        description: body,
        personality: '',
        scenario: '',
        first_mes: firstMes,
        mes_example: mesExample,
        creator_notes: creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags,
        creator: 'Neo Terra (generated)',
        character_version: '',
        extensions: {
            depth_prompt: { prompt: '', depth: 0, role: 'system' },
            fav: false,
            talkativeness: '0.5',
            world: '',
            neoterra: {
                generated: true,
                canonLinks: isObject(value.canonLinks) ? value.canonLinks : {},
            },
        },
    };
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data,
        name,
        description: body,
        personality: '',
        scenario: '',
        first_mes: firstMes,
        mes_example: mesExample,
        tags,
        creatorcomment: creatorNotes,
        avatar: 'none',
        talkativeness: '0.5',
    };
}

/** Build the profile shape `parseCardProfile` emits, for the Codex. */
export function buildGeneratedProfile(card) {
    const value = isObject(card) ? card : {};
    const name = text(value.name, MAX_NAME) || 'Unnamed';
    return {
        name,
        gender: text(value.gender, 40),
        species: text(value.species, 60),
        occupation: text(value.occupation, 80),
        faction: text(value.faction, 80),
        appearance: text(value.appearance),
        attire: text(value.attire),
        abilities: text(value.abilities),
        personality: text(value.personality),
        speech: text(value.speech),
        likes: list(value.likes, { maxLength: 120 }),
        dislikes: list(value.dislikes, { maxLength: 120 }),
        goals: list(value.goals, { maxLength: 160 }),
        background: text(value.background),
        identity: text(value.identity, MAX_IDENTITY),
        combatStyle: text(value.combatStyle),
        gear: text(value.gear),
        weakness: text(value.weakness),
        sensitive: [],
        extras: [],
        forms: {},
        missing: [],
        source: { file: null, cardPath: null, dataName: name },
    };
}

/**
 * Build the pre-validated `CharacterState` for a generated card.
 *
 * The reducer accepts this object as-is via `ADD_GENERATED_CHARACTER`; the
 * shape matches `seedCharacter` in `src/state/world-state.js`.
 */
export function buildGeneratedCharacter(card, {
    seasonId = 'sandbox',
    season = null,
    locationId = null,
    turn = 0,
} = {}) {
    const value = isObject(card) ? card : {};
    const name = text(value.name, MAX_NAME) || 'Unnamed';
    const charId = `gen.${seasonId}.${slugifyCardName(name) || 'character'}`;
    const side = CARD_SIDES.includes(value.side) ? value.side : 'neutral';
    const abilitiesText = text(value.abilities);
    const traitsSource = text(value.personality) || text(value.speech);
    const traits = splitListText(traitsSource);
    return {
        charId,
        formId: charId,
        formGroup: null,
        displayName: name,
        side,
        controlledBy: 'npc',
        status: 'active',
        badEndType: null,
        locationId,
        alive: true,
        threatLevel: THREAT_LEVELS.includes(value.threatLevel) ? value.threatLevel : null,
        stamina: { current: 100, max: 100 },
        willpower: { current: 100, max: 100 },
        agenda: agendaFor(side, season),
        goals: list(value.goals, { maxLength: 160 }),
        mood: 'neutral',
        allegiance: side,
        appearance: text(value.appearance),
        outfit: text(value.attire),
        abilities: splitListText(abilitiesText),
        skills: [],
        traits: traits.length >= 2 ? traits : [],
        likes: list(value.likes, { maxLength: 120 }),
        dislikes: list(value.dislikes, { maxLength: 120 }),
        personality: text(value.personality),
        speech: text(value.speech),
        relationships: [],
        corruption: { stage: 0, source: null, progress: 0 },
        lastUpdatedTurn: Number.isInteger(turn) && turn >= 0 ? turn : 0,
        notes: text(value.background),
    };
}

/**
 * Build the reducer event for a kept card. `portrait` must already be a
 * validated data URL (the UI downsizes and checks it).
 */
export function buildGeneratedCharacterEvent({
    draft,
    season = null,
    seasonId = null,
    locationId = null,
    turn = 0,
    now = 0,
    portrait = null,
    model = '',
    warnings = [],
} = {}) {
    const card = isObject(draft) ? draft : {};
    const resolvedSeasonId = seasonId ?? season?.id ?? 'sandbox';
    const character = buildGeneratedCharacter(card, {
        seasonId: resolvedSeasonId,
        season,
        locationId,
        turn,
    });
    return {
        type: 'ADD_GENERATED_CHARACTER',
        character,
        profile: buildGeneratedProfile(card),
        card: buildGeneratedCardEnvelope(card),
        portrait,
        model,
        generatedAt: Number.isFinite(now) && now > 0 ? now : 0,
        warnings: asArray(warnings).filter((warning) => typeof warning === 'string').slice(0, 20),
    };
}

/**
 * Validate and normalize one generated card.
 *
 * Returns `{ ok, value, errors, warnings, blockedReason }`. Nothing throws on
 * ordinary bad output: the caller shows the reason and offers a regenerate.
 */
export function validateGeneratedCard(value, {
    registry = null,
    season = null,
    factions = null,
    districts = null,
    reservedIds = [],
} = {}) {
    const errors = [];
    const warnings = [];
    if (!isObject(value)) {
        return {
            ok: false,
            value: null,
            errors: ['generated card must be an object'],
            warnings,
            blockedReason: 'The model did not return a card object.',
        };
    }

    const normalized = {};
    for (const field of REQUIRED_CARD_FIELDS) {
        const raw = value[field];
        if (field === 'tags' || field === 'likes' || field === 'dislikes' || field === 'goals') {
            continue;
        }
        if (typeof raw !== 'string' || raw.trim().length === 0) {
            errors.push(`${field} is required`);
        }
    }
    if (errors.length > 0) {
        return {
            ok: false,
            value: null,
            errors,
            warnings,
            blockedReason: `Missing required fields: ${errors.join(', ')}.`,
        };
    }

    // Text fields: clamp and report overruns. A card is never rejected because
    // a model cannot count characters.
    for (const [field, cap] of Object.entries(FIELD_CAPS)) {
        const source = text(value[field]);
        const clamped = clampText(source, cap);
        normalized[field] = clamped.value;
        if (clamped.over) {
            warnings.push(`${field} is over the ${cap}-character guide`);
        }
        if (clamped.trimmed) {
            warnings.push(`${field} was trimmed to the ${cap}-character cap`);
        }
    }

    normalized.side = CARD_SIDES.includes(value.side) ? value.side : 'neutral';
    if (normalized.side !== value.side) {
        warnings.push(`side "${String(value.side)}" was normalized to neutral`);
    }
    normalized.threatLevel = THREAT_LEVELS.includes(value.threatLevel)
        ? value.threatLevel
        : null;
    normalized.gender = text(value.gender, 40);
    normalized.species = text(value.species, 60);
    normalized.occupation = text(value.occupation, 80);
    normalized.faction = text(value.faction, 80);
    normalized.likes = list(value.likes, { maxLength: 120 });
    normalized.dislikes = list(value.dislikes, { maxLength: 120 });
    normalized.goals = list(value.goals, { maxLength: 160 });
    normalized.aliases = list(value.aliases, { maxItems: 3, maxLength: 40 });
    normalized.tags = list(value.tags, { maxItems: MAX_TAGS, maxLength: 40 });
    if (normalized.tags.length < MIN_TAGS) {
        warnings.push(`tags has ${normalized.tags.length} item(s); ${MIN_TAGS}–${MAX_TAGS} is the house range`);
    }

    // A human-readable faction must name a season faction (or Unaffiliated).
    if (normalized.faction) {
        const factionNames = seasonFactionNames(season, factions);
        const key = normalizeCardName(normalized.faction);
        if (factionNames.size > 0 && key !== 'unaffiliated' && !factionNames.has(key)) {
            warnings.push(`faction "${normalized.faction}" is not a season faction; set to Unaffiliated`);
            normalized.faction = 'Unaffiliated';
        }
    }

    // --- Structural checks ------------------------------------------------
    if (LABEL_LEAK_PATTERN.test(normalized.firstMes) || /^\[\{\{char\}\} is/i.test(normalized.firstMes)) {
        errors.push('firstMes contains the card description instead of a scene');
    }
    if (normalized.firstMes.length < MIN_FIRST_MES) {
        warnings.push(`firstMes is shorter than ${MIN_FIRST_MES} characters`);
    }

    normalized.mesExample = normalized.mesExample.replace(
        /^([ \t]*(?:<START>[ \t]*(?:\n[ \t]*)?)?)([A-Z][^\n:]{1,60}?)[ \t]*:/gm,
        (match, prefix, label) => {
            const labelWords = normalizeCardName(label).split(' ').filter(Boolean);
            if (labelWords.length === 0) {
                return match;
            }
            const knownWords = new Set(
                [normalized.name, ...normalized.aliases]
                    .flatMap((candidate) => normalizeCardName(candidate).split(' '))
                    .filter(Boolean),
            );
            if (!labelWords.every((word) => knownWords.has(word))) {
                return match;
            }
            return `${prefix}{{char}}:`;
        },
    );

    // --- Canon safety -----------------------------------------------------
    const names = registryNames(registry);
    const collisions = [normalized.name, ...normalized.aliases]
        .map((candidate) => ({ candidate, key: normalizeCardName(candidate) }))
        .filter(({ key }) => key && names.has(key));
    if (collisions.length > 0) {
        errors.push(`name collides with an existing character: ${collisions.map((entry) => entry.candidate).join(', ')}`);
    }

    const scannedText = [
        normalized.identity,
        normalized.gender,
        normalized.species,
        normalized.occupation,
        normalized.faction,
        normalized.appearance,
        normalized.attire,
        normalized.abilities,
        normalized.personality,
        normalized.speech,
        normalized.background,
        normalized.combatStyle,
        normalized.gear,
        normalized.weakness,
        normalized.firstMes,
        normalized.mesExample,
        ...normalized.likes,
        ...normalized.dislikes,
        ...normalized.goals,
        ...normalized.tags,
        ...normalized.aliases,
    ].join('\n');
    const lowerText = scannedText.toLowerCase();
    for (const phrase of META_PHRASES) {
        if (lowerText.includes(phrase)) {
            errors.push(`card text mentions "${phrase}"`);
        }
    }

    const { max: eraMax } = eraYears(season);
    if (eraMax) {
        const years = [...lowerText.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
        const future = years.filter((year) => year > eraMax);
        if (future.length > 0) {
            errors.push(`future knowledge: ${future[0]} is after the season era (${eraMax})`);
        }
    }

    const districtList = districtNames(districts).map(normalizeCardName);
    if (districtList.length > 0) {
        for (const match of lowerText.matchAll(/\b([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\s+district\b/g)) {
            const words = match[1].trim().split(/\s+/);
            const meaningful = words.filter((word) => !DISTRICT_STOP_WORDS.has(word));
            const candidates = [
                meaningful.slice(-3).join(' '),
                meaningful.slice(-2).join(' '),
                meaningful.slice(-1).join(' '),
            ].filter(Boolean);
            if (candidates.length > 0 && !candidates.some((candidate) => districtList.includes(candidate))) {
                warnings.push(`unknown district "${candidates[0]}"`);
            }
        }
    }

    const allowedThreats = new Set(seasonThreatIds(season));
    const allowedFactions = seasonFactionIds(season, factions);
    const allowedCharacters = seasonCharacterIds(season);
    const canonLinks = isObject(value.canonLinks) ? value.canonLinks : {};
    const keepIds = (ids, allowed, label) => {
        const kept = [];
        for (const id of asArray(ids)) {
            if (typeof id !== 'string' || !id.trim()) {
                continue;
            }
            if (allowed.size > 0 && !allowed.has(id)) {
                warnings.push(`dropped unknown ${label} id "${id}"`);
                continue;
            }
            if (!kept.includes(id)) {
                kept.push(id);
            }
        }
        return kept.slice(0, MAX_CANON_LINKS);
    };
    normalized.canonLinks = {
        threatIds: keepIds(canonLinks.threatIds, allowedThreats, 'threat'),
        factionIds: keepIds(canonLinks.factionIds, allowedFactions, 'faction'),
        characterIds: keepIds(canonLinks.characterIds, allowedCharacters, 'character'),
    };

    // --- Balance ----------------------------------------------------------
    const abilitiesLead = normalized.abilities.slice(0, 200);
    const noPowers = /^\s*(?:none\b|no (?:metahuman |super ?)?powers?\b|unpowered\b|non-?powered\b|ordinary human\b)/i.test(abilitiesLead)
        || /\bno (?:metahuman |super ?)?powers?\b/i.test(abilitiesLead);
    const hasPowers = !noPowers && normalized.abilities.length > 40;
    if (hasPowers && normalized.weakness.length === 0 && !['civilian', 'neutral'].includes(normalized.side)) {
        errors.push('a powered character must state a weakness or limit');
    }

    // --- Uniqueness -------------------------------------------------------
    const id = `gen.${season?.id ?? 'sandbox'}.${slugifyCardName(normalized.name) || 'character'}`;
    const taken = new Set(asArray(reservedIds).filter((entry) => typeof entry === 'string'));
    if (taken.has(id)) {
        errors.push(`id "${id}" already exists in this chat`);
    }

    return {
        ok: errors.length === 0,
        value: errors.length === 0 ? { ...normalized, id } : null,
        errors,
        warnings: [...new Set(warnings)],
        blockedReason: errors.length === 0 ? null : errors.join('; '),
    };
}

/**
 * Normalize a card without throwing. Returns the validated value or `null`.
 * UI callers that only need the cleaned draft can use this; validation errors
 * are still available through `validateGeneratedCard`.
 */
export function normalizeGeneratedCard(value, options = {}) {
    const result = validateGeneratedCard(value, options);
    return result.ok ? result.value : null;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

function normalizeFactions(factions) {
    const source = Array.isArray(factions) ? factions : asArray(factions?.factions);
    return source
        .filter((faction) => isObject(faction) && typeof faction.id === 'string')
        .map((faction) => ({
            id: faction.id,
            name: faction.name ?? faction.id,
            side: faction.side ?? faction.role ?? '',
        }));
}

function normalizeDistricts(districts) {
    const source = Array.isArray(districts) ? districts : asArray(districts?.districts);
    return source
        .filter((district) => isObject(district) && typeof district.name === 'string')
        .map((district) => district.name);
}

function normalizeLocations(locations) {
    const source = Array.isArray(locations) ? locations : asArray(locations?.locations);
    return source
        .filter((location) => isObject(location) && typeof location.name === 'string')
        .map((location) => (location.district ? `${location.name} (${location.district})` : location.name))
        .slice(0, 32);
}

function normalizeExemplars(exemplars) {
    return asArray(exemplars)
        .map((exemplar) => {
            if (typeof exemplar === 'string') {
                return { name: null, description: text(exemplar, MAX_EXEMPLAR_CHARS) };
            }
            if (!isObject(exemplar)) {
                return null;
            }
            return {
                name: typeof exemplar.name === 'string' ? exemplar.name : null,
                description: text(exemplar.description ?? exemplar.text, MAX_EXEMPLAR_CHARS),
            };
        })
        .filter((exemplar) => exemplar && exemplar.description.length > 0);
}

const SCHEMA_TEXT = `{
  "name": "string, display name (<= 60)",
  "aliases": ["0-3 short aliases"],
  "identity": "string (<= 140), public identity / codename status",
  "side": "hero | villain | vigilante | civilian | neutral",
  "threatLevel": "low | medium | high | null",
  "gender": "string (<= 40)",
  "species": "string (<= 60)",
  "occupation": "string (<= 80)",
  "faction": "string (<= 80), a season faction name or Unaffiliated",
  "appearance": "string (<= 700)",
  "attire": "string (<= 600)",
  "abilities": "string (<= 800), specific and limited",
  "personality": "string (<= 1000), the longest section after background",
  "speech": "string (<= 700)",
  "likes": ["0-8 short items"],
  "dislikes": ["0-8 short items"],
  "goals": ["0-8 short items"],
  "background": "string (<= 900), specific history",
  "combatStyle": "string (<= 260)",
  "gear": "string (<= 260)",
  "weakness": "string (<= 260); required for a powered character",
  "firstMes": "string ${MIN_FIRST_MES}-${MAX_FIRST_MES}, pure scene prose",
  "mesExample": "string (<= 800), one <START> exchange using {{char}}:",
  "tags": ["6-12 short tags"],
  "canonLinks": { "threatIds": [], "factionIds": [], "characterIds": [] }
}`;

/**
 * Build the creator prompt. Every input is plain data so the function is
 * testable without the DOM or SillyTavern.
 */
export function buildCharacterCreatorPrompt({
    season = null,
    factions = null,
    districts = null,
    locations = null,
    exemplars = [],
    concept = {},
    settings = {},
} = {}) {
    const factionLines = normalizeFactions(factions).map(
        (faction) => `${faction.id} — ${faction.name}${faction.side ? ` — ${faction.side}` : ''}`,
    );
    const threatLines = asArray(season?.threats).map(
        (threat) => `${threat.id} — ${threat.name} — ${threat.rank} — ${threat.agenda}`,
    );
    const districtList = normalizeDistricts(districts);
    const locationList = normalizeLocations(locations);
    const exemplarBlocks = normalizeExemplars(exemplars).map((exemplar, index) => (
        `### EXEMPLAR ${index + 1}${exemplar.name ? `: ${exemplar.name}` : ''}\n${exemplar.description}`
    ));

    const sections = [
        '## SEASON BIBLE',
        `Season: ${season?.title ?? season?.id ?? 'Neo Terra'}`,
        `Era: ${season?.era ?? 'unknown'}`,
        `Premise: ${season?.premise ?? ''}`,
        `Tone notes: ${season?.toneNotes ?? ''}`,
        `Player role: ${season?.playerRole ?? 'neutral'}`,
        '',
        'Factions:',
        factionLines.length > 0 ? factionLines.join('\n') : '(none supplied)',
        '',
        'Threats:',
        threatLines.length > 0 ? threatLines.join('\n') : '(none supplied)',
        '',
        `Canon cast ids: ${asArray(season?.roster).map((member) => member?.characterId).filter(Boolean).join(', ') || '(none)'}`,
        '',
        `Districts (closed list): ${districtList.length > 0 ? districtList.join(', ') : '(none supplied)'}`,
        `Key locations: ${locationList.length > 0 ? locationList.join(', ') : '(none supplied)'}`,
        '',
        '## EXEMPLAR CARDS (house style — copy structure, density and voice, never content)',
        exemplarBlocks.length > 0 ? exemplarBlocks.join('\n\n') : '(no exemplars supplied)',
        '',
        '## CONCEPT BRIEF',
        JSON.stringify({
            name: text(concept?.name, MAX_NAME) || null,
            role: CARD_SIDES.includes(concept?.side) ? concept.side : (text(concept?.role) || 'supporting cast'),
            concept: text(concept?.concept, 600),
            powers: text(concept?.powers, 400) || null,
            ties: text(concept?.ties, 400) || null,
            contentNote: text(concept?.contentNote, 200) || null,
        }, null, 2),
        '',
        '## HARD LIMITS (a deterministic validator rejects the card if you break these)',
        `- Field caps: name ${MAX_NAME}; identity ${MAX_IDENTITY}; appearance ${MAX_APPEARANCE}; attire ${MAX_ATTIRE}; abilities ${MAX_ABILITIES}; personality ${MAX_PERSONALITY}; speech ${MAX_SPEECH}; background ${MAX_BACKGROUND}; weakness ${MAX_WEAKNESS}; combatStyle ${MAX_COMBAT_STYLE}; gear ${MAX_GEAR}; mesExample ${MAX_MES_EXAMPLE}.`,
        `- firstMes MUST be ${MIN_FIRST_MES}-${MAX_FIRST_MES} characters of pure scene prose. It must NOT contain "Label:" lines and must not start with "[{{char}} is".`,
        '- mesExample MUST use "{{char}}:" as the speaker label, not the character name.',
        `- Districts are exactly the closed list above. You may name streets, shops, and unnamed minor extras, but never invent a district, faction, hero, or major villain.`,
        '- canonLinks may contain ONLY ids that appear in the season bible above.',
        '- No future knowledge, no reference to the player, the Director, or this system. No player-agency narration.',
        '- Powered characters must state a real cost or counter in "weakness".',
        '- Return one JSON object. No markdown fences, no prose before or after it.',
        '',
        '## OUTPUT SCHEMA',
        SCHEMA_TEXT,
        '',
        '## TASK',
        `Write the new character as supporting cast for ${season?.id ?? 'this season'} without contradicting canon. Return only the JSON object.`,
    ];

    return applyContentGateToPrompt(
        sections.join('\n'),
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        {},
    );
}

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block a generation.
    }
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

/**
 * Create the character creator agent.
 *
 * `run` accepts the season, data documents, exemplars and a concept, and
 * resolves to `{ ok, value?, card?, profile?, character?, warnings, prompt }`.
 * It never mutates state and never throws for model failures; abort errors
 * propagate.
 */
export function createCharacterCreator({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    async function run(request = {}) {
        const settings = settingsFor(request);
        const prompt = buildCharacterCreatorPrompt({
            season: request.season,
            factions: request.factions,
            districts: request.districts,
            locations: request.locations,
            exemplars: request.exemplars,
            concept: request.concept,
            settings,
        });
        const agentSettings = settings?.agents?.characterCreator ?? {};
        if (agentSettings.enabled === false || typeof runner?.runAgent !== 'function') {
            return {
                ok: false,
                reason: 'disabled',
                prompt,
                calls: 0,
                warnings: [],
                blockedReason: 'The character creator agent is disabled.',
            };
        }

        const reservedIds = [
            ...asArray(request.reservedIds),
            ...registryEntries(request.registry).map((entry) => entry.id),
        ].filter((entry) => typeof entry === 'string');
        const validate = (value) => validateGeneratedCard(value, {
            registry: request.registry,
            season: request.season,
            factions: request.factions,
            districts: request.districts,
            reservedIds,
        });

        const maxTokens = Number.isFinite(agentSettings.maxTokens)
            ? Math.max(500, Math.round(agentSettings.maxTokens))
            : 4000;
        const modelOverride = typeof request.model === 'string' ? request.model.trim() : '';
        let calls = 0;
        let lastError = null;
        let lastValidation = null;

        // Retry once, with a larger budget, only when the first card was
        // structurally unusable (missing fields, leaked description, truncated
        // JSON, transport error). A canon/name/balance rejection is final.
        const isRetryable = (validation) => Boolean(validation)
            && !validation.ok
            && validation.errors.every((error) => /required|scene|object|firstMes|JSON/i.test(error));

        for (const tokenBudget of [maxTokens, Math.round(maxTokens * 1.5)]) {
            calls += 1;
            try {
                const response = await runner.runAgent({
                    agentId: 'characterCreator',
                    prompt,
                    // The prompt already carries the schema. Skipping the client
                    // schema avoids its same-budget repair pass, which cannot
                    // help a truncated reasoning-model response; our validator
                    // retries once with a larger budget instead.
                    overrides: {
                        maxTokens: tokenBudget,
                        ...(modelOverride ? { model: modelOverride } : {}),
                    },
                    signal: request.signal,
                });
                const validation = validate(responseValue(response));
                lastValidation = validation;
                if (!validation.ok) {
                    lastError = validation.blockedReason ?? 'Generated card was rejected';
                    if (!isRetryable(validation)) {
                        break;
                    }
                    continue;
                }
                return {
                    ok: true,
                    value: validation.value,
                    card: buildGeneratedCardEnvelope(validation.value),
                    profile: buildGeneratedProfile(validation.value),
                    character: buildGeneratedCharacter(validation.value, {
                        seasonId: request.season?.id ?? 'sandbox',
                        season: request.season,
                        locationId: request.locationId ?? null,
                        turn: request.turn ?? 0,
                    }),
                    warnings: validation.warnings,
                    prompt,
                    calls,
                };
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                lastError = error?.message ?? String(error);
                // A transport/parse failure is retryable; the previous card's
                // reasons must not leak into this attempt's report.
                lastValidation = null;
            }
        }

        logWarning(log, 'Character creation failed', lastError);
        return {
            ok: false,
            reason: 'failed',
            error: lastError,
            warnings: lastValidation?.warnings ?? [],
            blockedReason: lastValidation?.blockedReason ?? null,
            prompt,
            calls,
        };
    }

    return { run, prompt: buildCharacterCreatorPrompt };
}
