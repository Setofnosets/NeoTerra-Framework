/**
 * Card-profile overlays for alternate forms.
 *
 * A character can belong to a form group whose members are separate registry
 * cards. Seeding stores one overlay per form so a transform can swap the
 * profile (appearance, attire, abilities, skills, traits, likes, dislikes,
 * goals, aliases, tags, and notes) without touching live combat, resources,
 * relationships, or manual edits. The reducer never calls an LLM; it only
 * applies a stored overlay.
 */

import { splitListText } from '../data/card-profile.js';
import { abilitySummaryLines } from '../data/card-facets.js';

/** Fields an overlay may replace on the live CharacterState. */
export const FORM_PROFILE_FIELDS = Object.freeze([
    'appearance',
    'outfit',
    'abilities',
    'skills',
    'traits',
    'likes',
    'dislikes',
    'goals',
    'notes',
]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listLikeTraits(text) {
    const items = splitListText(text);
    return items.length >= 2 ? items : [];
}

function cardTraits(profile) {
    if (Array.isArray(profile.traits) && profile.traits.length > 0) {
        return profile.traits.slice();
    }
    return listLikeTraits(profile.personality || profile.speech);
}

function cardAbilities(profile) {
    if (Array.isArray(profile.abilitySummary) && profile.abilitySummary.length > 0) {
        return abilitySummaryLines(profile.abilitySummary);
    }
    return splitListText(profile.abilities);
}

/**
 * Convert a parsed card profile into the overlay shape stored on a character.
 *
 * @param {object|null} profile
 * @param {{ source?: string, formId?: string|null, entry?: object|null }} [options]
 * @returns {object|null}
 */
export function buildFormProfileOverlay(profile, { source = 'card', formId = null, entry = null } = {}) {
    if (!isObject(profile) || profile.actors) {
        return null;
    }
    const overlay = {
        formId,
        source,
        appearance: typeof profile.appearance === 'string' ? profile.appearance : '',
        outfit: typeof profile.attire === 'string' ? profile.attire : '',
        abilities: cardAbilities(profile),
        skills: Array.isArray(profile.skills) ? profile.skills.slice() : [],
        traits: cardTraits(profile),
        likes: Array.isArray(profile.likes) ? profile.likes.slice() : [],
        dislikes: Array.isArray(profile.dislikes) ? profile.dislikes.slice() : [],
        goals: Array.isArray(profile.goals) ? profile.goals.slice() : [],
        notes: typeof profile.background === 'string' ? profile.background : '',
    };
    if (Array.isArray(entry?.aliases) && entry.aliases.length > 0) {
        overlay.aliases = entry.aliases.slice();
    }
    if (Array.isArray(entry?.tags) && entry.tags.length > 0) {
        overlay.tags = entry.tags.slice();
    }
    return overlay;
}

/**
 * Apply one overlay to a live character.
 *
 * `manualFields` is an optional list of field names that were edited by the
 * player and must survive the transform.
 *
 * @param {object} character
 * @param {object|null} overlay
 * @param {string[]} [manualFields]
 * @returns {boolean} whether a profile was applied
 */
export function applyFormProfileOverlay(character, overlay, manualFields = []) {
    if (!character || !isObject(overlay)) {
        return false;
    }
    const preserve = new Set(Array.isArray(manualFields) ? manualFields : []);
    for (const field of FORM_PROFILE_FIELDS) {
        if (preserve.has(field)) {
            continue;
        }
        // An overlay that never carried aliases/tags (older chats) must not
        // blank the base values.
        if ((field === 'aliases' || field === 'tags')) {
            continue;
        }
        if (field === 'appearance' || field === 'outfit' || field === 'notes') {
            character[field] = typeof overlay[field] === 'string' ? overlay[field] : '';
        } else {
            character[field] = Array.isArray(overlay[field]) ? overlay[field].slice() : [];
        }
    }
    return true;
}

/** Overlay for the base form of a group, used when reverting. */
export function baseFormOverlay(formProfiles, baseFormId) {
    if (!isObject(formProfiles) || typeof baseFormId !== 'string') {
        return null;
    }
    return formProfiles[baseFormId] ?? null;
}
