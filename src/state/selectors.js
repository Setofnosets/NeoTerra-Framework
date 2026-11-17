/**
 * Read-only WorldState selectors for prompt blocks and UI views.
 *
 * Selectors never mutate state and always return fresh arrays/objects where
 * consumers could otherwise accidentally modify the document.
 */

function presentIds(state) {
    const scene = state?.scene ?? {};
    if (Array.isArray(scene.present) && scene.present.length > 0) {
        return scene.present;
    }
    if (!scene.locationId) {
        return [];
    }
    return Object.values(state?.characters ?? {})
        .filter((character) => character.locationId === scene.locationId)
        .map((character) => character.charId);
}

/** CharacterStates currently on stage (falls back to location residents). */
export function selectPresentCast(state) {
    return presentIds(state)
        .map((characterId) => state?.characters?.[characterId] ?? null)
        .filter(Boolean);
}

/**
 * NPCs eligible for speaker selection: not player-controlled, alive, and in a
 * non-terminal status.
 */
export function selectNpcPool(state) {
    const allowed = new Set(['active', 'offscreen', 'missing']);
    return Object.values(state?.characters ?? {}).filter(
        (character) =>
            character.controlledBy === 'npc'
            && character.alive === true
            && allowed.has(character.status),
    );
}

export function selectLocation(state, id) {
    return state?.locations?.[id] ?? null;
}

export function selectFaction(state, id) {
    return state?.factions?.[id] ?? null;
}

export function selectThreat(state, id) {
    return (state?.threats ?? []).find((threat) => threat.id === id) ?? null;
}

export function selectBeat(state, id) {
    return state?.beats?.[id] ?? null;
}

export function selectCharacter(state, id) {
    return state?.characters?.[id] ?? null;
}

/** Player mirror plus the played character and its active form. */
export function selectPlayerView(state) {
    const player = state?.player ?? {};
    const character = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    return {
        ...player,
        character,
        form: character?.formId ?? null,
    };
}

/**
 * Merge state beat statuses with authored beat metadata.
 *
 * @param {object} state
 * @param {{ canonBeats?: object[] }} season
 */
export function selectOpenBeats(state, season) {
    const records = state?.beats ?? {};
    return (season?.canonBeats ?? [])
        .map((beat) => {
            const record = records[beat.id];
            const status = record?.status ?? 'open';
            return { ...beat, ...(record ?? {}), status };
        })
        .filter((beat) => beat.status === 'open' || beat.status === 'deferred')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Bad-end records as an array, each tagged with its character id. */
export function selectBadEnds(state) {
    return Object.entries(state?.badEnds ?? {}).map(([characterId, record]) => ({
        characterId,
        ...record,
    }));
}
