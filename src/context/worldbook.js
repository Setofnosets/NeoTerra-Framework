/**
 * Compact character profiles for prompt context.
 *
 * The codex and the materialized world book may use full card text, but prompt
 * blocks must not. This module turns a registry entry plus live CharacterState
 * into a short, budget-aware profile. Step 8 extends this module with the
 * chat-linked world-book materializer; Step 6 only needs the trimmed view.
 */

import { applyContentGate } from '../core/content-gate.js';
import { estimateTokens, truncateToTokens } from './budget.js';

const FIELD_MAX_ITEMS = 8;

function asArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function joinList(value, max = FIELD_MAX_ITEMS) {
    return asArray(value).slice(0, max).join(', ');
}

function formatResource(resource) {
    if (!resource || !Number.isFinite(resource.current) || !Number.isFinite(resource.max)) {
        return null;
    }
    return `${Math.round(resource.current)}/${Math.round(resource.max)}`;
}

function locationName(location) {
    if (!location) {
        return null;
    }
    if (typeof location === 'string') {
        return location;
    }
    return location.name ?? location.id ?? null;
}

/**
 * Build the fact lines for one character. Empty fields are omitted so a seeded
 * character does not produce a wall of blank labels.
 */
export function buildProfileLines({ entry = null, character = null, location = null } = {}) {
    const lines = [];
    const name = character?.displayName ?? entry?.displayName ?? character?.charId ?? entry?.id;
    if (!name) {
        return lines;
    }

    const descriptors = [];
    const side = character?.side ?? entry?.side;
    if (side) {
        descriptors.push(side);
    }
    if (character?.status) {
        descriptors.push(character.status);
    }
    const formKind = entry?.formKind && entry.formKind !== 'base' ? entry.formKind : null;
    if (formKind) {
        descriptors.push(formKind);
    }
    if (entry?.threatLevel) {
        descriptors.push(`threat ${entry.threatLevel}`);
    } else if (character?.threatLevel) {
        descriptors.push(`threat ${character.threatLevel}`);
    }
    lines.push(descriptors.length > 0 ? `${name} — ${descriptors.join(', ')}` : name);

    const place = locationName(location);
    if (place) {
        lines.push(`Location: ${place}`);
    }
    if (character?.agenda) {
        lines.push(`Agenda: ${character.agenda}`);
    }
    const goals = joinList(character?.goals);
    if (goals) {
        lines.push(`Goals: ${goals}`);
    }
    if (character?.mood) {
        lines.push(`Mood: ${character.mood}`);
    }
    if (character?.outfit) {
        lines.push(`Outfit: ${character.outfit}`);
    }
    if (character?.appearance) {
        lines.push(`Appearance: ${character.appearance}`);
    }
    const abilities = joinList(character?.abilities);
    if (abilities) {
        lines.push(`Abilities: ${abilities}`);
    }
    const traits = joinList(character?.traits);
    if (traits) {
        lines.push(`Traits: ${traits}`);
    }
    const stamina = formatResource(character?.stamina);
    const willpower = formatResource(character?.willpower);
    if (stamina || willpower) {
        lines.push(
            `Resources: stamina ${stamina ?? '—'}; willpower ${willpower ?? '—'}`,
        );
    }
    const corruption = character?.corruption;
    if (corruption && (Number(corruption.stage) > 0 || Number(corruption.progress) > 0)) {
        lines.push(`Corruption: stage ${corruption.stage ?? 0} (${corruption.progress ?? 0}%)`);
    }
    return lines;
}

/**
 * Render a profile as plain text, gated and trimmed.
 *
 * @param {{
 *   entry?: object|null,
 *   character?: object|null,
 *   location?: object|string|null,
 *   maxTokens?: number,
 *   gateLevel?: string,
 *   limits?: object,
 * }} options
 * @returns {{ text: string, tokens: number, truncated: boolean, characterId: string|null }}
 */
export function buildCharacterProfile(options = {}) {
    const {
        entry = null,
        character = null,
        location = null,
        maxTokens = 1200,
        gateLevel = 'full',
        limits = {},
    } = options;

    const characterId = character?.charId ?? entry?.id ?? null;
    const lines = buildProfileLines({ entry, character, location });
    const raw = lines.join('\n');
    const gated = applyContentGate(raw, gateLevel, limits, {
        characterId,
        isPlayer: false,
    });
    const trimmed = truncateToTokens(gated, maxTokens);
    return {
        text: trimmed.text,
        tokens: trimmed.tokens,
        truncated: trimmed.truncated,
        characterId,
    };
}

/**
 * Build profiles for a list of characters, distributing the available profile
 * budget across them. Each profile is also capped by `characterMaxTokens`.
 */
export function buildCastProfiles(characters, options = {}) {
    const list = Array.isArray(characters) ? characters.filter(Boolean) : [];
    if (list.length === 0) {
        return [];
    }
    const {
        registryIndex = null,
        getLocation = null,
        maxTokens = 1200,
        totalTokens = null,
        gateLevel = 'full',
        limits = {},
    } = options;

    const share = Number.isFinite(totalTokens)
        ? Math.max(40, Math.floor(totalTokens / list.length))
        : maxTokens;
    const perProfile = Math.min(maxTokens, share);

    return list.map((character) => {
        const entry = registryIndex?.byId?.[character.formId]
            ?? registryIndex?.byId?.[character.charId]
            ?? null;
        const location = getLocation ? getLocation(character.locationId) : null;
        return buildCharacterProfile({
            entry,
            character,
            location,
            maxTokens: perProfile,
            gateLevel,
            limits,
        });
    });
}

export { estimateTokens };
