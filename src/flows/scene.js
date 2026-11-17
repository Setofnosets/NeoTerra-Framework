/**
 * Scene helpers.
 *
 * Step 7 uses this module to describe a constructed world and to build the
 * deterministic opening scene from the chosen POV. Step 8 extends the same
 * module with scene transitions and cast direction.
 *
 * Everything here is pure and browser-safe: no DOM, no SillyTavern globals.
 */

export const POV_LABELS = Object.freeze({
    hero: 'Hero POV',
    villain: 'Villain POV',
    neutral: 'Neutral POV',
});

export const PLAYER_ROLE_LABELS = Object.freeze({
    hero: 'Hero',
    villain: 'Villain',
    neutral: 'Neutral',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human label for a player role, tolerant of unknown values. */
export function getPovLabel(playerRole) {
    return POV_LABELS[playerRole] ?? POV_LABELS.neutral;
}

export function getPlayerRoleLabel(playerRole) {
    return PLAYER_ROLE_LABELS[playerRole] ?? PLAYER_ROLE_LABELS.neutral;
}

/** Name of the player's current identity (custom persona or canon character). */
export function getPlayerDisplayName(state) {
    const player = state?.player ?? {};
    if (player.displayName) {
        return player.displayName;
    }
    if (player.identity === 'canon' && typeof player.characterId === 'string') {
        return state?.characters?.[player.characterId]?.displayName ?? player.characterId;
    }
    return 'The Player';
}

/** NPC names on stage; the player-controlled character is never listed as cast. */
export function getSceneCastNames(state) {
    const present = Array.isArray(state?.scene?.present) ? state.scene.present : [];
    return present
        .filter((characterId) => characterId !== state?.player?.characterId)
        .map((characterId) => state?.characters?.[characterId]?.displayName ?? characterId);
}

/**
 * Build the opening scene text and its structured facts.
 *
 * The text is deterministic: the same state and season always produce the same
 * opening. The narrator may elaborate on it, but this is the canonical frame
 * written when a season starts.
 *
 * @param {{ state: object, season: object }} options
 */
export function buildOpeningScene({ state, season } = {}) {
    if (!isObject(state) || !isObject(season)) {
        throw new TypeError('buildOpeningScene requires a WorldState and a season definition');
    }

    const locationId = state.scene?.locationId ?? season.startLocationId ?? null;
    const location = locationId ? state.locations?.[locationId] ?? null : null;
    const playerRole = state.playerRole ?? season.playerRole ?? 'neutral';
    const povLabel = getPovLabel(playerRole);
    const playerName = getPlayerDisplayName(state);
    const nonCanon = state.flags?.nonCanon === true;
    const castNames = getSceneCastNames(state);

    const heading = `${season.title} — ${season.era}`;
    const locationLine = location
        ? `Opening: ${location.name}${location.district ? `, ${location.district}` : ''}`
        : 'Opening: an unrecorded part of the city';
    const povLine = `POV: ${playerName} (${povLabel})${nonCanon ? ' — non-canon character: canon beats disabled' : ''}`;

    const lines = [heading, locationLine, povLine, ''];
    if (typeof season.premise === 'string' && season.premise.trim().length > 0) {
        lines.push(season.premise.trim());
        lines.push('');
    }
    if (castNames.length > 0) {
        lines.push(`Present: ${castNames.join(', ')}`);
        lines.push('');
    }
    const framing = state.scene?.framing;
    if (typeof framing === 'string' && framing.trim().length > 0 && framing.trim() !== season.premise) {
        lines.push(framing.trim());
        lines.push('');
    }
    lines.push(`The story begins on ${state.meta?.inGameDate ?? season.anchorDate ?? 'an unrecorded day'}.`);

    return {
        text: lines.join('\n').trim(),
        title: season.title,
        era: season.era,
        seasonId: season.id,
        locationId,
        locationName: location?.name ?? null,
        district: location?.district ?? null,
        playerRole,
        povLabel,
        playerName,
        playerIdentity: state.player?.identity ?? 'custom',
        playerCharacterId: state.player?.characterId ?? null,
        castNames,
        nonCanon,
    };
}

/**
 * Short human summary of the current scene for the shell/UI (not the prompt).
 */
export function describeScene(state) {
    if (!isObject(state)) {
        return null;
    }
    const locationId = state.scene?.locationId ?? null;
    const location = locationId ? state.locations?.[locationId] ?? null : null;
    return {
        turn: state.meta?.turn ?? 0,
        locationId,
        locationName: location?.name ?? null,
        district: location?.district ?? null,
        inCombat: state.meta?.inCombat === true,
        present: Array.isArray(state.scene?.present) ? state.scene.present.slice() : [],
        castNames: getSceneCastNames(state),
        framing: state.scene?.framing ?? '',
    };
}
