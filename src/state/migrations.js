/**
 * WorldState document migrations.
 *
 * Migrations are pure: they clone the incoming document, preserve unknown
 * keys, and never downgrade a newer document. The reducer and store only ever
 * consume the current version.
 */

export const CURRENT_WORLD_STATE_VERSION = 1;

const STATUSES = Object.freeze([
    'active',
    'offscreen',
    'captured',
    'corrupted',
    'dead',
    'retired',
    'missing',
    'lost',
    'imprisoned',
]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asObject(value) {
    return isObject(value) ? value : {};
}

function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function asNullableString(value) {
    return typeof value === 'string' ? value : null;
}

function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function asInteger(value, fallback = 0) {
    return Number.isInteger(value) ? value : fallback;
}

function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * Normalize an unversioned (v0) or partially authored document into the v1
 * shape. Unknown keys survive this migration: the spread comes first.
 */
function migrateV0ToV1(raw) {
    const meta = asObject(raw.meta);
    const scene = asObject(raw.scene);
    const ending = asObject(raw.ending);
    const player = asObject(raw.player);
    const stamina = asObject(player.stamina);
    const willpower = asObject(player.willpower);
    const corruption = asObject(player.corruption);
    const playerIdentity = player.identity === 'canon' && typeof player.characterId === 'string'
        ? 'canon'
        : 'custom';

    return {
        ...raw,
        schemaVersion: CURRENT_WORLD_STATE_VERSION,
        chatId: asString(raw.chatId, ''),
        seasonId: asString(raw.seasonId, 'sandbox'),
        mode: ['director', 'group', 'solo'].includes(raw.mode) ? raw.mode : 'director',
        meta: {
            ...meta,
            turn: Number.isInteger(meta.turn) ? meta.turn : Number(meta.turn) || 0,
            inGameDate: asNullableString(meta.inGameDate),
            timeOfDay: asString(meta.timeOfDay, 'evening'),
            sceneId: asString(meta.sceneId, 'opening'),
            inCombat: asBoolean(meta.inCombat),
            startedAt: Number.isFinite(meta.startedAt) ? meta.startedAt : 0,
        },
        arc: raw.arc === 'post-victory' ? 'post-victory' : 'season',
        ending: {
            ...ending,
            status: ['none', 'epilogue', 'continued', 'ended'].includes(ending.status)
                ? ending.status
                : 'none',
        },
        playerRole: ['hero', 'villain', 'neutral'].includes(raw.playerRole)
            ? raw.playerRole
            : 'neutral',
        player: {
            ...player,
            identity: playerIdentity,
            characterId: playerIdentity === 'canon' ? player.characterId : null,
            personaNotes: asString(player.personaNotes, ''),
            stamina: {
                current: asNumber(stamina.current, 100),
                max: asNumber(stamina.max, 100),
            },
            willpower: {
                current: asNumber(willpower.current, 100),
                max: asNumber(willpower.max, 100),
            },
            corruption: {
                ...corruption,
                stage: Number.isInteger(corruption.stage) ? corruption.stage : 0,
                source: asNullableString(corruption.source),
                progress: Number(corruption.progress) || 0,
            },
        },
        characters: asObject(raw.characters),
        locations: asObject(raw.locations),
        factions: asObject(raw.factions),
        threats: asArray(raw.threats),
        beats: asObject(raw.beats),
        badEnds: asObject(raw.badEnds),
        relationships: asArray(raw.relationships),
        recentEvents: asArray(raw.recentEvents),
        scene: {
            ...scene,
            locationId: asNullableString(scene.locationId),
            present: asArray(scene.present),
            combat: isObject(scene.combat) ? scene.combat : null,
            framing: asString(scene.framing, ''),
        },
        flags: asObject(raw.flags),
        log: asArray(raw.log),
    };
}

/**
 * Versioned migration table. Keys are the *source* version; each function
 * returns the next version's document.
 */
export const WORLD_STATE_MIGRATIONS = Object.freeze({
    0: migrateV0ToV1,
});

/**
 * Migrate an arbitrary stored document to the current WorldState version.
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function migrateWorldState(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (!isObject(raw)) {
        throw new Error('Invalid WorldState document');
    }

    const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
    if (version > CURRENT_WORLD_STATE_VERSION) {
        // Same policy as settings: keep a newer document intact. Validation may
        // flag it, but a migration must never destroy user data.
        return clone(raw);
    }

    let document = clone(raw);
    let current = version;
    while (current < CURRENT_WORLD_STATE_VERSION) {
        const migration = WORLD_STATE_MIGRATIONS[current];
        if (typeof migration !== 'function') {
            break;
        }
        document = migration(document);
        current += 1;
        document.schemaVersion = current;
    }

    document.schemaVersion = CURRENT_WORLD_STATE_VERSION;
    return document;
}

/** True when a stored document needs migration. */
export function needsWorldStateMigration(raw) {
    if (!isObject(raw)) {
        return false;
    }
    const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
    return version < CURRENT_WORLD_STATE_VERSION;
}

/** Exposed for tests and future migration helpers. */
export const WORLD_STATE_STATUSES = STATUSES;
