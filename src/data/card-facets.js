/**
 * Deterministic facet derivation for character cards.
 *
 * Cards keep their capabilities as prose in an `Abilities:` block. The codex
 * and the prompt renderer need short, structured values instead of a wall of
 * text, so this module derives:
 *
 *   - `abilitySummary`: `{ lead, detail }[]` (lead = capability name, detail =
 *     one-line gloss),
 *   - `skills`: short active capabilities,
 *   - `traits`: passive qualities.
 *
 * The module is browser-safe: no IO, no clocks, and no randomness. Every
 * result is a pure function of the supplied profile text. Empty arrays are
 * preferred over guesses when the prose does not support a value.
 */

export const MAX_ABILITY_LEAD = 40;
export const MAX_ABILITY_DETAIL = 120;
export const MAX_ABILITY_ITEMS = 8;
export const MAX_SKILL_ITEMS = 6;
export const MAX_SKILL_CHARS = 60;
export const MAX_TRAIT_ITEMS = 8;
export const MAX_TRAIT_CHARS = 60;

export const ABILITY_SEPARATOR = ' — ';

const TRAILING_JUNK = /[\s,;:.!?\-\u2013\u2014]+$/;
const LEADING_JUNK = /^[\s,;:.!?\-\u2013\u2014]+/;

function normalizeText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * Remove dialogue so a quoted aside never becomes a capability.
 *
 * Short inline quotes keep their words (without quote marks), so
 * `she's truly "normal"` does not become broken prose. Long quoted lines are
 * spoken dialogue and are dropped.
 */
function stripQuotes(text) {
    const inline = (value) => (value.length > 18 ? ' ' : value);
    return text
        .replace(/"([^"]*)"/g, (_, value) => inline(value))
        .replace(/\u201c([^\u201d]*)\u201d/g, (_, value) => inline(value))
        .replace(/\u2018([^\u2019]*)\u2019/g, (_, value) => value)
        .replace(/\s+/g, ' ')
        .trim();
}

function splitSentences(text) {
    return stripQuotes(normalizeText(text))
        .split(/(?<=[.!?])\s+|\n+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

function capText(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) {
        return value;
    }
    const slice = value.slice(0, max);
    const boundary = slice.lastIndexOf(' ');
    const cut = boundary > Math.floor(max * 0.5) ? slice.slice(0, boundary) : slice;
    return cut.replace(TRAILING_JUNK, '').trim();
}

function capitalize(text) {
    const value = String(text ?? '').trim();
    if (value.length === 0) {
        return '';
    }
    return value[0].toUpperCase() + value.slice(1);
}

function stripDeterminers(text) {
    return String(text ?? '')
        .replace(/^(?:the|a|an|some|any|her|his|their|its|our|my|this|that)\s+/i, '')
        .replace(/^(?:to|and|or|then|also)\s+/i, '')
        .trim();
}

const LEAD_STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'and', 'or', 'but', 'to', 'in', 'on', 'at', 'by',
    'for', 'with', 'from', 'her', 'his', 'their', 'its', 'is', 'are', 'was',
    'were', 'has', 'have', 'had', 'as', 'that', 'which', 'who', 'some', 'any',
    'this', 'these', 'those', 'more', 'most', 'such', 'than', 'so', 'into',
    'single', 'entire', 'whole', 'very', 'own',
]);

function looksUnfinished(value) {
    const words = String(value ?? '').trim().toLowerCase().split(/\s+/);
    const last = words[words.length - 1] ?? '';
    return words.length > 0 && (LEAD_STOPWORDS.has(last) || /'s?$/.test(last));
}

function cleanDetail(value) {
    return capText(
        String(value ?? '').trim()
            .replace(LEADING_JUNK, '')
            .replace(/^(?:and|or|but)\s+/i, '')
            .trim(),
        MAX_ABILITY_DETAIL,
    );
}

const LEAD_NOISE = new Set([
    'gained', 'gain', 'gains', 'the', 'ability', 'to', 'can', 'could', 'is', 'are',
    'able', 'capable', 'of', 'has', 'have', 'her', 'his', 'their', 'its', 'she',
    'he', 'they', 'a', 'an', 'new', 'also', 'even', 'now',
]);

function leadTokens(lead) {
    return new Set(String(lead ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9' ]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !LEAD_NOISE.has(word)));
}

/** True when one lead's words are already covered by another lead. */
function leadsOverlap(left, right) {
    if (left.size === 0 || right.size === 0) {
        return false;
    }
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    let shared = 0;
    for (const word of small) {
        if (large.has(word)) {
            shared += 1;
        }
    }
    return shared / small.size >= 0.75;
}

const STRONG_VERB = /\b(?:can|could|able to|ability to|capable of|has access to|allows?|enables?|lets?|creates?|summons?|shoots?|casts?|controls?|manipulates?|teleports?|wields?|extends?|steals?|produces?|emits?|generates?|grants?|specializes? in|mastery over|expert (?:at|in)|powers are|power is|signature is)\b/i;

/** Where a capability object stops being a noun phrase. */
const OBJECT_STOP = /\s+(?:that|which|who|whom|whose|as|by|to|from|thanks|because|while|so|when|where|if|than|and|or|with|without|in|on|at|into|upon|that)\s+/i;

const BAD_LEAD_START = /^(?:a|an|the|to|that|which|who|how|what|it|this|these|those|there|then|and|or|but|if|as|be|being|been|is|are|was|were|has|have|had|do|does|did|make|makes|made|use|using|used|get|gets|got|become|becomes|way)\b/i;

function splitObject(objectText) {
    const text = String(objectText ?? '').trim();
    const cutBy = text.search(/\s+by\s+|\s+such as\s+/i);
    if (cutBy !== -1) {
        return { head: text.slice(0, cutBy).trim(), tail: text.slice(cutBy).trim() };
    }
    const cut = text.search(OBJECT_STOP);
    if (cut !== -1) {
        return { head: text.slice(0, cut).trim(), tail: text.slice(cut).trim() };
    }
    return { head: text, tail: '' };
}

function finishLead(raw) {
    let value = stripDeterminers(String(raw ?? ''))
        .replace(/^(?:her|his|their|its|the character|they|she|he|it)\s+/i, '')
        .replace(TRAILING_JUNK, '')
        .trim();
    // "gained the ability to steal superpowers" and "ability to steal
    // superpowers" are the same capability.
    let previous;
    do {
        previous = value;
        value = value
            .replace(/^(?:gained|gains?|acquired|now has|the ability to|ability to|the power to|power to)\s+/i, '')
            .trim();
    } while (value !== previous);
    if (!value) {
        return '';
    }
    const words = value.split(/\s+/).filter(Boolean).slice(0, 6);
    while (words.length > 0 && LEAD_STOPWORDS.has(words[words.length - 1].toLowerCase())) {
        words.pop();
    }
    value = words.join(' ').replace(TRAILING_JUNK, '');
    if (!value || BAD_LEAD_START.test(value)) {
        return '';
    }
    return capitalize(capText(value, MAX_ABILITY_LEAD));
}

const ABILITY_VERB = /\b(?:can|could|is able to|are able to|able to|ability to|capable of|allows?|enables?|lets?|creates?|summons?|shoots?|casts?|controls?|manipulates?|teleports?|wields?|extends?|steals?|produces?|emits?|generates?|grants?|specializes? in|mastery over|expert (?:at|in)|powers are|power is|signature is)\s+(.+)$/gi;

function escapeRegExp(text) {
    return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop a leading `Name to …` / `Name can …` prefix so a subject is not a lead. */
function stripSubject(objectText, name) {
    const text = String(objectText ?? '').trim();
    if (!name || name.length < 3) {
        return text;
    }
    const pattern = new RegExp(`^${escapeRegExp(name)}\\s+(?:is\\s+able\\s+to|can|could|to|has the ability to|is capable of)\\s+`, 'i');
    return text.replace(pattern, '').trim();
}

function abilityCandidates(sentence, name = '') {
    const text = stripQuotes(sentence)
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^[^A-Za-z0-9]+/, '')
        .trim();
    if (text.length < 3) {
        return [];
    }
    if (/\bnormal (?:human|person)\b/i.test(text)) {
        return [];
    }
    if (/^(?:notable|the following|in addition|that aside)\b/i.test(text)) {
        return [];
    }
    if (/\b(?:what|which|who|how)\s+\w*\s*(?:can|could|is able to)\b/i.test(text)) {
        return [];
    }
    if (!STRONG_VERB.test(text)) {
        return [];
    }

    const candidates = [];
    let match;
    // "allows her to <verb phrase>" — the capability is the verb phrase, not
    // the pronoun or the device that grants it.
    const allowPattern = /\b(?:allows?|enables?|lets?)\s+(?:it|her|him|them|you|someone|anyone|the (?:user|wearer|suit))\s+to\s+(.+)$/gi;
    while ((match = allowPattern.exec(text)) !== null) {
        const { head, tail } = splitObject(stripSubject(match[1], name));
        const lead = finishLead(head);
        if (lead) {
            candidates.push({ lead, detail: cleanDetail(tail) });
        }
    }

    ABILITY_VERB.lastIndex = 0;
    while ((match = ABILITY_VERB.exec(text)) !== null) {
        const { head, tail } = splitObject(stripSubject(match[1], name));
        const lead = finishLead(head);
        if (lead) {
            candidates.push({ lead, detail: cleanDetail(tail) });
        }
    }

    const hasPattern = /\b(?:has|have|possesses?)\s+(?:access to\s+)?(.+)$/gi;
    while ((match = hasPattern.exec(text)) !== null) {
        const { head, tail } = splitObject(stripSubject(match[1], name));
        const lead = finishLead(head);
        if (!lead) {
            continue;
        }
        // "has access to <thing>" is a capability; a bare "has <noun>" is not
        // (it is usually a possession or a body part).
        if (!/^has\s+access\s+to/i.test(match[0]) && !/^access\b/i.test(lead)) {
            continue;
        }
        candidates.push({ lead, detail: cleanDetail(tail) });
    }
    return candidates;
}

/**
 * Turn prose into structured ability items.
 *
 * @param {unknown} value
 * @param {string} [name] character display name, used to drop `Name can …`
 *   subjects so the lead is the capability itself.
 * @returns {Array<{ lead: string, detail: string }>}
 */
export function deriveAbilitySummary(value, name = '') {
    const items = [];
    const seen = [];
    const push = (item) => {
        if (!item) {
            return;
        }
        const key = item.lead.toLowerCase();
        if (key.length < 3) {
            return;
        }
        const tokens = leadTokens(item.lead);
        if (seen.some((existing) => existing.key === key || leadsOverlap(tokens, existing.tokens))) {
            // Keep the more specific wording of two overlapping leads.
            const match = seen.find((existing) => existing.key === key || leadsOverlap(tokens, existing.tokens));
            if (match && item.lead.length > match.lead.length && key !== match.key) {
                const index = items.findIndex((entry) => entry.lead === match.lead);
                if (index !== -1) {
                    items[index] = item;
                    match.lead = item.lead;
                    match.key = key;
                    match.tokens = tokens;
                }
            }
            return;
        }
        seen.push({ key, tokens, lead: item.lead });
        items.push(item);
    };
    for (const sentence of splitSentences(value)) {
        const candidates = abilityCandidates(sentence, name);
        if (candidates.length === 0) {
            continue;
        }
        // Two strong clauses in one sentence ("has superhuman physiology and
        // can fly") describe two capabilities; take up to two per sentence,
        // most specific first.
        for (const candidate of candidates.slice(0, 2)) {
            push(candidate);
            if (items.length >= MAX_ABILITY_ITEMS) {
                break;
            }
        }
        if (items.length >= MAX_ABILITY_ITEMS) {
            break;
        }
    }
    return items;
}

const PASSIVE_SKILLS = new Set([
    'fly',
    'flight',
    'regenerate',
    'regeneration',
    'heal',
    'immortal',
    'immortality',
]);

const MAX_SKILL_WORDS = 6;

const SKILL_REJECT_START = /^(?:way|how|it|them|that|which|who|what|he|she|they|this|these|those|there|then|and|or|but|if|as|be|being|is|are|was|were|has|have|had|do|does|did|make|makes|use|using|get|gets|become|becomes|reply|respond|even|also|only|just|more|most|some|such|someone)\b/i;

function skillCandidate(raw) {
    let value = stripDeterminers(String(raw ?? '').trim())
        .replace(/^(?:her|his|their|its|it|them)\s+to\s+/i, '')
        .replace(/^(?:her|his|their|its|it|them)\s+/i, '');
    value = value.replace(TRAILING_JUNK, '').trim();
    if (!value || SKILL_REJECT_START.test(value)) {
        return '';
    }
    if (looksUnfinished(value)) {
        return '';
    }
    if (value.split(/\s+/).length > MAX_SKILL_WORDS) {
        return '';
    }
    return capitalize(capText(value, MAX_SKILL_CHARS));
}

function deriveSkills({ explicitSkills, abilitySummary }) {
    const out = [];
    const seen = new Set();
    const push = (raw) => {
        const skill = skillCandidate(raw);
        if (!skill) {
            return false;
        }
        const key = skill.toLowerCase();
        if (PASSIVE_SKILLS.has(key) || seen.has(key)) {
            return false;
        }
        seen.add(key);
        out.push(skill);
        return out.length >= MAX_SKILL_ITEMS;
    };

    const explicit = normalizeText(explicitSkills);
    if (explicit) {
        const parts = explicit
            .split(/\n+|;|,(?=\s)|\.(?=\s|$)/)
            .map((part) => part.replace(/^[\s*•\-–—]+/, '').trim())
            .filter(Boolean);
        for (const part of parts) {
            if (push(part)) {
                return out;
            }
        }
    }

    for (const item of asArray(abilitySummary)) {
        if (push(item?.lead)) {
            return out;
        }
    }
    return out;
}

const TRAIT_PATTERNS = Object.freeze([
    [/superhuman physiology/i, 'Superhuman physiology'],
    [/superhuman strength|super strength|physically stronger/i, 'Superhuman strength'],
    [/regenerat\w*|healing factor|heals? (?:quickly|fast)/i, 'Regeneration'],
    [/agile|agility|acrobat\w*|flexible body/i, 'Agility'],
    [/durab\w*|invulnerab\w*|resistant to damage/i, 'Durability'],
    [/\bimmortal\w*/i, 'Immortality'],
    [/\bcan fly\b|\bflies\b|\bflight\b|\bwings?\b/i, 'Flight'],
    [/danger sense|enhanced senses|heightened senses/i, 'Enhanced senses'],
    [/hypno\w*|trance\b|entrancing/i, 'Hypnosis'],
    [/\bgenius\b|most intelligent|highly intelligent|intelligence\b/i, 'Genius intellect'],
    [/invisib\w*|cloak\w*|chameleon/i, 'Invisibility'],
    [/psychic link|telepath\w*/i, 'Psychic link'],
    [/shapeshift\w*|shift(?:s|ing)? into (?:crystal|shards?|animals?)/i, 'Shapeshifting'],
    [/venom|poison\w*/i, 'Poison'],
    [/vampir\w*/i, 'Vampirism'],
    [/crystal(?:s|\b)|crystalline/i, 'Crystal affinity'],
]);

function traitFromText(text, out, seen) {
    const plain = stripQuotes(normalizeText(text));
    if (!plain) {
        return;
    }
    for (const [pattern, label] of TRAIT_PATTERNS) {
        if (pattern.test(plain) && !seen.has(label.toLowerCase())) {
            seen.add(label.toLowerCase());
            out.push(label);
            if (out.length >= MAX_TRAIT_ITEMS) {
                return;
            }
        }
    }
}

function explicitTraitItems(text, out, seen) {
    for (const sentence of splitSentences(text)) {
        const match = sentence.match(
            /\b(?:has|have|possesses?|gains?|gained|sprouts?|sprouted|sports?)\s+(?:a |an |the )?([^.;,]{3,70})/i,
        );
        if (!match) {
            continue;
        }
        const value = capitalize(capText(stripDeterminers(match[1]), MAX_TRAIT_CHARS));
        if (!value || /\b(?:appearance|feature|way|form|ability|power)\b/i.test(value)) {
            continue;
        }
        const key = value.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(value);
        if (out.length >= MAX_TRAIT_ITEMS) {
            return;
        }
    }
}

function deriveTraits({ explicitTraits, abilities, abilitySummary }) {
    const out = [];
    const seen = new Set();
    traitFromText(explicitTraits, out, seen);
    explicitTraitItems(explicitTraits, out, seen);
    for (const sentence of splitSentences(abilities)) {
        traitFromText(sentence, out, seen);
        if (out.length >= MAX_TRAIT_ITEMS) {
            return out;
        }
    }
    for (const item of asArray(abilitySummary)) {
        traitFromText(`${item?.lead ?? ''}. ${item?.detail ?? ''}`, out, seen);
        if (out.length >= MAX_TRAIT_ITEMS) {
            return out;
        }
    }
    return out;
}

/**
 * Derive skills, traits, and structured ability summaries from a card profile.
 *
 * @param {{ abilities?: unknown, explicitSkills?: unknown, explicitTraits?: unknown }|null} profile
 * @returns {{ skills: string[], traits: string[], abilitySummary: Array<{ lead: string, detail: string }> }}
 */
export function deriveCardFacets(profile) {
    if (!profile || typeof profile !== 'object') {
        return { skills: [], traits: [], abilitySummary: [] };
    }
    const abilities = normalizeText(profile.abilities);
    const name = typeof profile.name === 'string' ? profile.name : '';
    const abilitySummary = deriveAbilitySummary(abilities, name);
    return {
        skills: deriveSkills({
            explicitSkills: profile.explicitSkills,
            abilitySummary,
        }),
        traits: deriveTraits({
            explicitTraits: profile.explicitTraits,
            abilities,
            abilitySummary,
        }),
        abilitySummary,
    };
}

/** Serialize one ability item into the stored `abilities` string form. */
export function abilityLine(item, max = 120) {
    const lead = capText(item?.lead ?? '', MAX_ABILITY_LEAD);
    if (!lead) {
        return '';
    }
    const detail = capText(item?.detail ?? '', MAX_ABILITY_DETAIL);
    return capText(detail ? `${lead}${ABILITY_SEPARATOR}${detail}` : lead, max);
}

/** Serialize an ability summary into the stored `abilities` string array. */
export function abilitySummaryLines(summary, max = 120) {
    return asArray(summary)
        .map((item) => abilityLine(item, max))
        .filter(Boolean);
}

/**
 * Read one stored ability line back into a lead/detail pair.
 *
 * A line without the explicit separator is a lead; the codex only splits on
 * text this module wrote, so it never guesses at prose boundaries.
 */
export function parseAbilityLine(line) {
    const value = String(line ?? '').replace(/\s+/g, ' ').trim();
    if (!value) {
        return null;
    }
    const index = value.indexOf(ABILITY_SEPARATOR);
    if (index === -1) {
        return { lead: capText(value, MAX_ABILITY_LEAD), detail: '' };
    }
    return {
        lead: capText(value.slice(0, index), MAX_ABILITY_LEAD),
        detail: capText(value.slice(index + ABILITY_SEPARATOR.length), MAX_ABILITY_DETAIL),
    };
}

/**
 * Normalize any stored ability list (old chats may hold one paragraph) into
 * short lead/detail items for rendering.
 */
export function abilityItems(values) {
    const items = [];
    const seen = new Set();
    const push = (item) => {
        if (!item || !item.lead) {
            return;
        }
        const key = item.lead.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        items.push(item);
    };

    for (const value of asArray(values)) {
        const line = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!line) {
            continue;
        }
        if (line.includes(ABILITY_SEPARATOR)) {
            push(parseAbilityLine(line));
            continue;
        }
        if (line.length > 90 || /\.\s+/.test(line)) {
            const derived = deriveAbilitySummary(line);
            if (derived.length > 0) {
                for (const item of derived) {
                    push(item);
                }
                continue;
            }
            // Unparseable legacy prose stays whole rather than being chopped
            // into invented fragments.
            push({ lead: capText(line, MAX_ABILITY_DETAIL), detail: '' });
            continue;
        }
        push(parseAbilityLine(line));
    }

    return items.slice(0, MAX_ABILITY_ITEMS);
}
