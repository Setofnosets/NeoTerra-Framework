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

function cloneRelationship(relationship) {
    if (!relationship || typeof relationship !== 'object') {
        return null;
    }
    return {
        ...relationship,
        ...(Array.isArray(relationship.notes) ? { notes: [...relationship.notes] } : {}),
    };
}

/**
 * Relationship records, shallow-cloned so callers cannot mutate state.
 *
 * `presentOnly` uses the same presence rule as `selectPresentCast` and keeps a
 * record when either side is present.
 */
export function selectRelationships(state, {
    characterId = null,
    presentOnly = false,
    type = null,
    minAffinity = null,
} = {}) {
    const records = Array.isArray(state?.relationships) ? state.relationships : [];
    const present = presentOnly ? new Set(presentIds(state)) : null;
    return records
        .filter((relationship) => relationship && typeof relationship === 'object')
        .filter((relationship) => {
            if (typeof characterId === 'string') {
                return relationship.a === characterId || relationship.b === characterId;
            }
            return true;
        })
        .filter((relationship) => (present
            ? present.has(relationship.a) || present.has(relationship.b)
            : true))
        .filter((relationship) => (type === null ? true : relationship.type === type))
        .filter((relationship) => {
            if (!Number.isFinite(minAffinity)) {
                return true;
            }
            const affinity = Number(relationship.affinity);
            return Number.isFinite(affinity) ? affinity >= minAffinity : true;
        })
        .map(cloneRelationship)
        .filter(Boolean);
}

/** One relationship record regardless of stored `a`/`b` order, or null. */
export function selectRelationshipBetween(state, a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return null;
    }
    const records = Array.isArray(state?.relationships) ? state.relationships : [];
    const found = records.find((relationship) => relationship
        && ((relationship.a === a && relationship.b === b)
            || (relationship.a === b && relationship.b === a)));
    return cloneRelationship(found ?? null);
}

/** Relationships involving at least one present character. */
export function selectPresentRelationships(state) {
    return selectRelationships(state, { presentOnly: true });
}
