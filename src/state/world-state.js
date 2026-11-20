/**
 * Authoritative, versioned WorldState document.
 *
 * A WorldState is seeded once from a season definition and then only changed
 * through typed events (see `reducer.js`). Seeding is deterministic: the same
 * inputs and `now` produce byte-identical JSON.
 */

import { BEAT_STATUSES } from '../data/beats.js';
import { splitListText } from '../data/card-profile.js';
import { abilitySummaryLines } from '../data/card-facets.js';
import { TIME_SLOTS } from '../core/constants.js';
import { FACTION_STATUSES, buildFactionIndex } from '../data/factions.js';
import {
    LOCATION_KINDS,
    LOCATION_STATUSES,
    buildLocationIndex,
} from '../data/locations.js';
import { buildRegistryIndex } from '../data/registry.js';
import {
    PLAYER_ROLES,
    THREAT_RANKS,
    resolveSeasonRoster,
} from '../data/seasons.js';
import { SIDES } from '../data/schema.js';
import { buildFormProfileOverlay } from './form-profiles.js';
import { seedExplorationFor } from './exploration.js';

export const WORLD_STATE_SCHEMA_VERSION = 2;

export const CHARACTER_STATUSES = Object.freeze([
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

export const BAD_END_TYPES = Object.freeze([
    'death',
    'identity-loss',
    'autonomy-loss',
    'corruption',
    'imprisonment',
    'retirement',
]);

export const WORLD_MODES = Object.freeze(['director', 'group', 'solo']);
export const WORLD_ARCS = Object.freeze(['season', 'post-victory']);
export const ENDING_STATUSES = Object.freeze(['none', 'epilogue', 'continued', 'ended']);
export const ENDING_PATHS = Object.freeze(['resistance', 'join-villain', 'end']);
export const THREAT_STATUSES = Object.freeze(['active', 'dormant', 'defeated', 'contained']);

export const BAD_END_STATUS = Object.freeze({
    death: 'dead',
    'identity-loss': 'lost',
    'autonomy-loss': 'captured',
    corruption: 'corrupted',
    imprisonment: 'imprisoned',
    retirement: 'retired',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** Deep clone a state document (structuredClone with a JSON fallback). */
export function cloneWorldState(state) {
    if (typeof structuredClone === 'function') {
        return structuredClone(state);
    }
    return JSON.parse(JSON.stringify(state));
}

function emptyResource() {
    return { current: 100, max: 100 };
}

function emptyCorruption() {
    return { stage: 0, source: null, progress: 0 };
}

export function createCustomPlayer({ displayName = 'The Player', personaNotes = '', locationId = null } = {}) {
    return {
        identity: 'custom',
        characterId: null,
        personaNotes,
        charId: null,
        formId: null,
        formGroup: null,
        displayName,
        side: 'neutral',
        controlledBy: 'player',
        status: 'active',
        badEndType: null,
        locationId,
        alive: true,
        threatLevel: null,
        stamina: emptyResource(),
        willpower: emptyResource(),
        agenda: 'Write your own story in Neo Terra',
        goals: [],
        mood: 'neutral',
        allegiance: 'neutral',
        appearance: '',
        outfit: '',
        abilities: [],
        skills: [],
        traits: [],
        likes: [],
        dislikes: [],
        relationships: [],
        corruption: emptyCorruption(),
        lastUpdatedTurn: 0,
        notes: '',
    };
}

function deriveAgenda(side, season, isPlayer) {
    const threats = season?.threats ?? [];
    const mainThreat = threats.find((threat) => threat.rank === 'main') ?? threats[0] ?? null;

    if (isPlayer) {
        return season?.playerRole === 'villain'
            ? 'Secure your rule over Neo Terra'
            : 'Write your own story in Neo Terra';
    }
    if (side === 'villain' && mainThreat) {
        return `Advance ${mainThreat.name}'s agenda`;
    }
    if (side === 'hero' && mainThreat) {
        return `Oppose ${mainThreat.name} and protect Neo Terra`;
    }
    if (side === 'villain') {
        return 'Advance your own criminal agenda';
    }
    if (side === 'hero') {
        return 'Protect Neo Terra from the city\'s threats';
    }
    return `Survive the events of ${season?.title ?? 'Neo Terra'}`;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * A card body is only promoted to live list state when the tolerant splitter
 * finds a real list; a prose paragraph stays out of `traits`.
 */
function listLikeTraits(text) {
    const items = splitListText(text);
    return items.length >= 2 ? items : [];
}

function cardProfileFor(member, profiles) {
    if (!profiles || typeof profiles !== 'object' || member.character?.bundle === true) {
        return null;
    }
    return profiles[member.formId] ?? profiles[member.characterId] ?? null;
}

function cardFacets(card) {
    if (!card) {
        return { skills: [], traits: [], abilities: [] };
    }
    return {
        skills: Array.isArray(card.skills) ? card.skills.slice() : [],
        traits: Array.isArray(card.traits) && card.traits.length > 0
            ? card.traits.slice()
            : listLikeTraits(card.personality || card.speech),
        abilities: Array.isArray(card.abilitySummary) && card.abilitySummary.length > 0
            ? abilitySummaryLines(card.abilitySummary)
            : splitListText(card.abilities),
    };
}

/**
 * Store every form's card profile on the character so a later transform can
 * swap the profile without another fetch. Bundles are never form groups.
 */
function buildFormProfilesFor(member, formGroups, profiles, registry = null) {
    if (!profiles || typeof profiles !== 'object' || member.character?.bundle === true) {
        return null;
    }
    // The registry form group is authoritative; resolve members by profile id
    // through the entry's group rather than through profile card paths.
    const groupId = member.character?.formGroup ?? null;
    const group = groupId && formGroups
        ? (formGroups.groups ?? []).find((candidate) => candidate.id === groupId) ?? null
        : null;
    if (!group) {
        return null;
    }
    const byPath = new Map(
        Object.entries(profiles).map(([id, profile]) => [profile?.source?.cardPath ?? id, id]),
    );
    const entriesById = new Map(
        asArray(registry?.entries).map((entry) => [entry.id, entry]),
    );
    const formProfiles = {};
    for (const path of group.members ?? []) {
        const normalized = String(path).split('\\').join('/').replace(/^Chars\//, '');
        const id = byPath.get(`Chars/${normalized}`) ?? byPath.get(normalized) ?? null;
        if (!id) {
            continue;
        }
        const overlay = buildFormProfileOverlay(profiles[id], {
            formId: id,
            source: 'card',
            entry: entriesById.get(id) ?? null,
        });
        if (overlay) {
            formProfiles[id] = overlay;
        }
    }
    return Object.keys(formProfiles).length > 0 ? formProfiles : null;
}

function seedCharacter(member, { isPlayer, season, profiles = null, formGroups = null, registry = null }) {
    const character = member.character;
    const form = member.form;
    const side = form?.side ?? character?.side ?? 'neutral';
    const card = cardProfileFor(member, profiles);
    const facets = cardFacets(card);
    const formProfiles = buildFormProfilesFor(member, formGroups, profiles, registry);
    const activeOverlay = formProfiles?.[member.formId] ?? formProfiles?.[member.characterId] ?? null;
    const activeEntry = member.form ?? character ?? null;

    return {
        charId: member.characterId,
        formId: member.formId,
        formGroup: form?.formGroup ?? character?.formGroup ?? null,
        // The person's name comes from the base card, not the active form's
        // display label: a seeded villain form is still Leila Renya, and the
        // Codex renders the form label separately (`formName`). This also keeps
        // the exported player card named after the character, not the form.
        displayName: character?.displayName ?? form?.displayName ?? member.characterId,
        side,
        controlledBy: isPlayer ? 'player' : 'npc',
        status: 'active',
        badEndType: null,
        locationId: member.locationId ?? null,
        alive: true,
        threatLevel: form?.threatLevel ?? character?.threatLevel ?? null,
        stamina: emptyResource(),
        willpower: emptyResource(),
        agenda: deriveAgenda(side, season, isPlayer),
        goals: activeOverlay?.goals ?? (Array.isArray(card?.goals) ? card.goals.slice() : []),
        goalsSource: 'card',
        mood: 'neutral',
        allegiance: side,
        appearance: activeOverlay?.appearance ?? card?.appearance ?? '',
        outfit: activeOverlay?.outfit ?? card?.attire ?? '',
        abilities: activeOverlay?.abilities ?? facets.abilities,
        skills: activeOverlay?.skills ?? facets.skills,
        traits: activeOverlay?.traits ?? facets.traits,
        aliases: activeOverlay?.aliases ?? asArray(activeEntry?.aliases),
        tags: activeOverlay?.tags ?? asArray(activeEntry?.tags),
        likes: activeOverlay?.likes ?? (Array.isArray(card?.likes) ? card.likes.slice() : []),
        dislikes: activeOverlay?.dislikes ?? (Array.isArray(card?.dislikes) ? card.dislikes.slice() : []),
        relationships: [],
        corruption: emptyCorruption(),
        lastUpdatedTurn: 0,
        notes: activeOverlay?.notes ?? card?.background ?? '',
        ...(formProfiles ? { formProfiles, profileFormId: member.formId, profileSource: 'card' } : {}),
    };
}

function mergeFaction(ref, globalIndex) {
    const global = globalIndex?.byId?.[ref.id] ?? {};
    return {
        id: ref.id,
        name: global.name ?? ref.id,
        side: global.side ?? 'neutral',
        influence: ref.influence,
        status: ref.status,
        goals: Array.isArray(ref.goals) && ref.goals.length > 0
            ? ref.goals.slice()
            : Array.isArray(global.goals) ? global.goals.slice() : [],
        description: global.description ?? '',
        headquartersLocationId: global.headquartersLocationId ?? null,
    };
}

function seedLocation(location, startLocationId) {
    return {
        id: location.id,
        name: location.name,
        district: location.district,
        kind: location.kind,
        factionId: location.factionId ?? null,
        status: location.defaultStatus,
        capacity: location.capacity,
        present: [],
        tags: Array.isArray(location.tags) ? location.tags.slice() : [],
        visited: location.id === startLocationId,
        notes: location.description ?? '',
    };
}

function seedThreat(threat) {
    return {
        id: threat.id,
        name: threat.name,
        rank: threat.rank,
        sourceFactionId: threat.sourceFactionId ?? null,
        agenda: threat.agenda,
        stages: Array.isArray(threat.stages) ? threat.stages.slice() : [],
        progress: threat.progress ?? 0,
        stage: 0,
        status: 'active',
        locationId: threat.locationId ?? null,
    };
}

function seedBeat() {
    return {
        status: 'open',
        resolvedTurn: null,
        adaptedFrom: null,
        adaptedTo: null,
        reason: null,
        deferredUntilTurn: null,
    };
}

/**
 * Build a deterministic WorldState from a validated season definition.
 *
 * @param {{
 *   season: object,
 *   registry?: object,
 *   factions?: object,
 *   locations?: object,
 *   formGroups?: object,
 *   formRules?: object,
 *   chatId: string,
 *   mode?: 'director'|'group'|'solo',
 *   now?: number,
 *   profiles?: Record<string, object>|null,
 *   player?: { identity?: 'custom'|'canon', characterId?: string|null, personaNotes?: string, displayName?: string },
 * }} options
 * @returns {object}
 */
export function createWorldState(options = {}) {
    const {
        season,
        registry,
        factions,
        locations,
        formGroups = null,
        chatId,
        mode = 'director',
        now = Date.now(),
        profiles = null,
        player,
        timeOfDayStart = 'evening',
        allowGuestPlayer = false,
    } = options;

    if (!isObject(season)) {
        throw new Error('createWorldState requires a season definition');
    }
    if (typeof chatId !== 'string' || chatId.trim().length === 0) {
        throw new Error('createWorldState requires a non-empty chatId');
    }
    if (!WORLD_MODES.includes(mode)) {
        throw new Error(`Unknown world mode "${String(mode)}"`);
    }
    if (!locations || !Array.isArray(locations.locations)) {
        throw new Error('createWorldState requires location data');
    }

    let roster = resolveSeasonRoster(season, registry);
    const rosterById = new Map(roster.map((member) => [member.characterId, member]));
    const startLocationId = season.startLocationId ?? null;
    const globalFactions = factions ? buildFactionIndex(factions) : null;
    const registryIndex = buildRegistryIndex(registry);

    let playerConfig = player;
    if (playerConfig === undefined || playerConfig === null) {
        playerConfig = season.defaultPlayerCharacterId
            ? { identity: 'canon', characterId: season.defaultPlayerCharacterId }
            : { identity: 'custom' };
    }
    if (!isObject(playerConfig)) {
        throw new Error('createWorldState player option must be an object');
    }

    const identity = playerConfig.identity
        ?? (playerConfig.characterId ? 'canon' : 'custom');
    if (identity !== 'custom' && identity !== 'canon') {
        throw new Error(`Unknown player identity "${String(identity)}"`);
    }

    let playerCharacterId = null;
    if (identity === 'canon') {
        playerCharacterId = playerConfig.characterId ?? season.defaultPlayerCharacterId ?? null;
        if (playerCharacterId && !rosterById.has(playerCharacterId)) {
            // Sandbox / any-character seasons may cast a registry character that
            // is not on a predefined roster, and a warned cross-season guest may
            // join any playable season. The chosen identity is still the single
            // CharacterState key for that card.
            const entry = registryIndex.byId[playerCharacterId];
            const guestAllowed = options.allowGuestPlayer === true;
            if (
                (season.allowAnyCharacter !== true && !guestAllowed)
                || !entry
                || entry.bundle === true
            ) {
                throw new Error(
                    `createWorldState: player character "${String(playerCharacterId)}" is not on the season roster`,
                );
            }
            const member = {
                characterId: entry.id,
                formId: entry.id,
                character: entry,
                form: entry,
                locationId: startLocationId,
            };
            roster = [...roster, member];
            rosterById.set(member.characterId, member);
        }
        if (!playerCharacterId) {
            throw new Error('createWorldState: canon player identity requires a characterId');
        }
    }

    // A chosen/roster form may override the authored roster form. The override
    // is advisory: an unknown or unrelated form is ignored so a stale identity
    // picker can never break a season start. The non-roster (sandbox/guest)
    // member created above travels through the same rule and falls back to the
    // base card when the requested form is not a legal alternate.
    if (identity === 'canon' && playerCharacterId) {
        const requestedFormId = typeof playerConfig.formId === 'string'
            && playerConfig.formId.length > 0
            ? playerConfig.formId
            : null;
        const member = requestedFormId ? rosterById.get(playerCharacterId) ?? null : null;
        const candidate = requestedFormId ? registryIndex.byId[requestedFormId] ?? null : null;
        const characterEntry = member?.character
            ?? registryIndex.byId[playerCharacterId]
            ?? null;
        const legal = candidate !== null
            && candidate.bundle !== true
            && candidate.id !== member?.formId
            && (
                candidate.id === playerCharacterId
                || candidate.altOf === playerCharacterId
                || (candidate.formGroup != null
                    && candidate.formGroup === characterEntry?.formGroup)
            );
        if (member && legal) {
            member.formId = candidate.id;
            member.form = candidate;
        }
    }

    const characters = {};
    for (const member of roster) {
        characters[member.characterId] = seedCharacter(member, {
            isPlayer: member.characterId === playerCharacterId,
            season,
            profiles,
            formGroups,
            registry,
        });
    }

    const locationsState = {};
    for (const location of locations.locations) {
        locationsState[location.id] = seedLocation(location, startLocationId);
    }
    for (const character of Object.values(characters)) {
        // Presence is NPC-only: the played character lives in `state.player`
        // and `state.characters`, never on the stage roster.
        if (character.controlledBy === 'player') {
            continue;
        }
        if (character.locationId && locationsState[character.locationId]) {
            locationsState[character.locationId].present.push(character.charId);
        }
    }

    const factionsState = {};
    for (const ref of season.factions ?? []) {
        factionsState[ref.id] = mergeFaction(ref, globalFactions);
    }

    const threats = (season.threats ?? []).map(seedThreat);

    const beats = {};
    for (const beat of season.canonBeats ?? []) {
        if (beat && typeof beat.id === 'string') {
            beats[beat.id] = seedBeat();
        }
    }

    const present = roster
        .filter((member) => member.locationId === startLocationId)
        .filter((member) => member.characterId !== playerCharacterId)
        .map((member) => member.characterId);

    let playerState;
    if (identity === 'canon') {
        const character = characters[playerCharacterId];
        playerState = {
            ...cloneWorldState(character),
            identity: 'canon',
            characterId: playerCharacterId,
            personaNotes: playerConfig.personaNotes ?? '',
        };
    } else {
        playerState = createCustomPlayer({
            displayName: playerConfig.displayName ?? 'The Player',
            personaNotes: playerConfig.personaNotes ?? '',
            locationId: startLocationId,
        });
    }

    const state = {
        schemaVersion: WORLD_STATE_SCHEMA_VERSION,
        chatId,
        seasonId: season.id,
        mode,
        meta: {
            turn: 0,
            storyTurn: 0,
            inGameDate: season.anchorDate ?? null,
            timeOfDay: TIME_SLOTS.includes(timeOfDayStart) ? timeOfDayStart : 'evening',
            sceneId: 'opening',
            inCombat: false,
            startedAt: now,
        },
        arc: 'season',
        ending: { status: 'none' },
        playerRole: PLAYER_ROLES.includes(season.playerRole) ? season.playerRole : 'neutral',
        player: playerState,
        characters,
        locations: locationsState,
        factions: factionsState,
        threats,
        beats,
        badEnds: {},
        relationships: [],
        recentEvents: [
            {
                turn: 0,
                date: season.anchorDate ?? null,
                summary: `${season.title} begins.`,
                actors: [],
                locationId: startLocationId,
                tags: ['season-start'],
                headline: season.title,
            },
        ],
        scene: {
            locationId: startLocationId,
            present,
            combat: null,
            framing: season.premise ?? '',
        },
        flags: {
            clock: {
                hold: {
                    active: false,
                    reason: null,
                    sinceTurn: 0,
                    sinceDate: season.anchorDate ?? null,
                },
            },
            map: {
                exploration: seedExplorationFor({
                    locations,
                    startLocationId,
                    turn: 0,
                }),
            },
        },
        log: [],
    };

    const validation = validateWorldState(state);
    if (!validation.ok) {
        const details = validation.errors
            .map((error) => `${error.path}: ${error.message}`)
            .join('; ');
        throw new Error(`Invalid WorldState seed: ${details}`);
    }
    return state;
}

/**
 * Minimal valid skeleton for migration and store tests.
 *
 * @param {{ chatId?: string }} [options]
 */
export function createEmptyWorldState({ chatId = 'empty-chat' } = {}) {
    return {
        schemaVersion: WORLD_STATE_SCHEMA_VERSION,
        chatId,
        seasonId: 'sandbox',
        mode: 'director',
        meta: {
            turn: 0,
            storyTurn: 0,
            inGameDate: null,
            timeOfDay: 'evening',
            sceneId: 'opening',
            inCombat: false,
            startedAt: 0,
        },
        arc: 'season',
        ending: { status: 'none' },
        playerRole: 'neutral',
        player: createCustomPlayer({ locationId: null }),
        characters: {},
        locations: {},
        factions: {},
        threats: [],
        beats: {},
        badEnds: {},
        relationships: [],
        recentEvents: [],
        scene: { locationId: null, present: [], combat: null, framing: '' },
        flags: {
            clock: {
                hold: {
                    active: false,
                    reason: null,
                    sinceTurn: 0,
                    sinceDate: null,
                },
            },
        },
        log: [],
    };
}

/**
 * State-aware availability for the "join the villain" ending path.
 *
 * Always available to villain-POV, corrupted, brainwashed, or coerced players;
 * unavailable to an unambiguously heroic player with no leverage.
 */
export function isJoinVillainPathAvailable(state) {
    if (!isObject(state)) {
        return false;
    }
    const playerCharacterId = state.player?.identity === 'canon'
        && typeof state.player.characterId === 'string'
        ? state.player.characterId
        : null;
    const playerCharacter = playerCharacterId
        ? state.characters?.[playerCharacterId] ?? null
        : null;
    const allegiance = String(
        state.player?.allegiance
        ?? playerCharacter?.allegiance
        ?? '',
    ).toLowerCase();
    const playerRelationship = (state.relationships ?? []).some(
        (relationship) => relationship?.type === 'owner/servant'
            && (
                (playerCharacterId && (relationship.a === playerCharacterId || relationship.b === playerCharacterId))
                || (!playerCharacterId && (relationship.a === 'player' || relationship.b === 'player'))
            ),
    );
    return state.playerRole === 'villain'
        || Number(state.player?.corruption?.stage ?? 0) > 0
        || state.flags?.brainwashed === true
        || state.flags?.identityLoss === true
        || state.flags?.coercedHero === true
        || state.flags?.coercion === true
        || allegiance === 'villain'
        || playerRelationship;
}

/** Resistance is unavailable to a player whose agency the world has removed. */
export function isResistancePathAvailable(state) {
    if (!isObject(state)) {
        return false;
    }
    const badEnd = state.player?.identity === 'canon' && state.player.characterId
        ? state.badEnds?.[state.player.characterId] ?? null
        : null;
    if (badEnd && badEnd.reversed !== true && [
        'death',
        'identity-loss',
        'imprisonment',
        'autonomy-loss',
        'corruption',
    ].includes(badEnd.type)) {
        return false;
    }
    return state.flags?.brainwashed !== true && state.flags?.identityLoss !== true;
}

export function isCanonPlayer(state) {
    return state?.player?.identity === 'canon' && typeof state.player.characterId === 'string';
}

export function getPlayerCharacter(state) {
    if (!isCanonPlayer(state)) {
        return null;
    }
    return state.characters?.[state.player.characterId] ?? null;
}

function add(errors, path, message) {
    errors.push({ path, message });
}

function requireString(errors, path, value, { nonEmpty = true } = {}) {
    if (typeof value !== 'string' || (nonEmpty && value.trim().length === 0)) {
        add(errors, path, nonEmpty ? 'must be a non-empty string' : 'must be a string');
        return false;
    }
    return true;
}

function requireNullableString(errors, path, value) {
    if (value !== null && typeof value !== 'string') {
        add(errors, path, 'must be a string or null');
        return false;
    }
    return true;
}

function requireEnum(errors, path, value, allowed) {
    if (!allowed.includes(value)) {
        add(errors, path, `must be one of ${allowed.join(', ')}`);
        return false;
    }
    return true;
}

function requireInteger(errors, path, value, { min = null, max = null } = {}) {
    if (!Number.isInteger(value)) {
        add(errors, path, 'must be an integer');
        return false;
    }
    if (min !== null && value < min) {
        add(errors, path, `must be >= ${min}`);
        return false;
    }
    if (max !== null && value > max) {
        add(errors, path, `must be <= ${max}`);
        return false;
    }
    return true;
}

function requireNumber(errors, path, value, { min = null, max = null } = {}) {
    if (!isFiniteNumber(value)) {
        add(errors, path, 'must be a number');
        return false;
    }
    if (min !== null && value < min) {
        add(errors, path, `must be >= ${min}`);
        return false;
    }
    if (max !== null && value > max) {
        add(errors, path, `must be <= ${max}`);
        return false;
    }
    return true;
}

function requireStringArray(errors, path, value) {
    if (!isStringArray(value)) {
        add(errors, path, 'must be an array of strings');
        return false;
    }
    return true;
}

function validateResource(errors, path, resource) {
    if (!isObject(resource)) {
        add(errors, path, 'must be an object');
        return;
    }
    const currentOk = requireNumber(errors, `${path}.current`, resource.current, { min: 0 });
    const maxOk = requireNumber(errors, `${path}.max`, resource.max, { min: 0 });
    if (currentOk && maxOk && resource.current > resource.max) {
        add(errors, `${path}.current`, 'must not exceed max');
    }
}

function validateCharacter(errors, id, character, state) {
    const path = `characters.${id}`;
    if (!isObject(character)) {
        add(errors, path, 'must be an object');
        return;
    }
    if (character.charId !== id) {
        add(errors, `${path}.charId`, 'must match the key in characters');
    }
    requireString(errors, `${path}.formId`, character.formId);
    requireNullableString(errors, `${path}.formGroup`, character.formGroup);
    requireString(errors, `${path}.displayName`, character.displayName);
    requireEnum(errors, `${path}.side`, character.side, SIDES);
    requireEnum(errors, `${path}.controlledBy`, character.controlledBy, ['npc', 'player']);
    requireEnum(errors, `${path}.status`, character.status, CHARACTER_STATUSES);
    if (character.badEndType !== null && character.badEndType !== undefined) {
        requireEnum(errors, `${path}.badEndType`, character.badEndType, BAD_END_TYPES);
    }
    requireNullableString(errors, `${path}.locationId`, character.locationId);
    if (typeof character.locationId === 'string' && !state.locations?.[character.locationId]) {
        add(errors, `${path}.locationId`, `unresolved location "${character.locationId}"`);
    }
    if (typeof character.alive !== 'boolean') {
        add(errors, `${path}.alive`, 'must be a boolean');
    }
    requireNullableString(errors, `${path}.threatLevel`, character.threatLevel);
    validateResource(errors, `${path}.stamina`, character.stamina);
    validateResource(errors, `${path}.willpower`, character.willpower);
    requireString(errors, `${path}.agenda`, character.agenda, { nonEmpty: false });
    requireStringArray(errors, `${path}.goals`, character.goals);
    requireString(errors, `${path}.mood`, character.mood, { nonEmpty: false });
    requireString(errors, `${path}.allegiance`, character.allegiance, { nonEmpty: false });
    requireString(errors, `${path}.appearance`, character.appearance, { nonEmpty: false });
    requireString(errors, `${path}.outfit`, character.outfit, { nonEmpty: false });
    for (const field of ['abilities', 'skills', 'traits', 'likes', 'dislikes']) {
        requireStringArray(errors, `${path}.${field}`, character[field]);
    }
    for (const field of ['aliases', 'tags']) {
        if (character[field] !== undefined) {
            requireStringArray(errors, `${path}.${field}`, character[field]);
        }
    }
    if (character.goalsSource !== undefined
        && character.goalsSource !== 'card'
        && character.goalsSource !== 'live') {
        add(errors, `${path}.goalsSource`, 'must be "card" or "live"');
    }
    if (!Array.isArray(character.relationships)) {
        add(errors, `${path}.relationships`, 'must be an array');
    }
    if (!isObject(character.corruption)) {
        add(errors, `${path}.corruption`, 'must be an object');
    } else {
        requireInteger(errors, `${path}.corruption.stage`, character.corruption.stage, { min: 0 });
        requireNullableString(errors, `${path}.corruption.source`, character.corruption.source);
        requireNumber(errors, `${path}.corruption.progress`, character.corruption.progress, {
            min: 0,
            max: 100,
        });
    }
    for (const field of ['personality', 'speech']) {
        if (character[field] !== undefined) {
            requireString(errors, `${path}.${field}`, character[field], { nonEmpty: false });
            if (typeof character[field] === 'string' && character[field].length > 1200) {
                add(errors, `${path}.${field}`, 'must be at most 1200 characters');
            }
        }
    }
    requireInteger(errors, `${path}.lastUpdatedTurn`, character.lastUpdatedTurn, { min: 0 });
    requireString(errors, `${path}.notes`, character.notes, { nonEmpty: false });
}

/**
 * Validate one candidate CharacterState against a live world.
 *
 * Used by the reducer's `ADD_GENERATED_CHARACTER` handler so the card creator
 * cannot insert a shape the document contract would reject on reload.
 *
 * @param {object} state
 * @param {object} character
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateCharacterState(state, character) {
    const errors = [];
    if (!isObject(state)) {
        add(errors, '$', 'state must be an object');
        return { ok: false, errors };
    }
    const id = isObject(character) && typeof character.charId === 'string'
        ? character.charId
        : '';
    if (!id) {
        add(errors, 'character.charId', 'is required');
        return { ok: false, errors };
    }
    validateCharacter(errors, id, character, state);
    return { ok: errors.length === 0, errors };
}

function validateLocation(errors, id, location, state) {
    const path = `locations.${id}`;
    if (!isObject(location)) {
        add(errors, path, 'must be an object');
        return;
    }
    if (location.id !== id) {
        add(errors, `${path}.id`, 'must match the key in locations');
    }
    requireString(errors, `${path}.name`, location.name);
    requireString(errors, `${path}.district`, location.district);
    requireEnum(errors, `${path}.kind`, location.kind, LOCATION_KINDS);
    requireNullableString(errors, `${path}.factionId`, location.factionId);
    requireEnum(errors, `${path}.status`, location.status, LOCATION_STATUSES);
    requireInteger(errors, `${path}.capacity`, location.capacity, { min: 1 });
    requireStringArray(errors, `${path}.present`, location.present);
    for (const characterId of location.present ?? []) {
        if (!state.characters?.[characterId]) {
            add(errors, `${path}.present`, `unresolved character "${characterId}"`);
        }
    }
    requireStringArray(errors, `${path}.tags`, location.tags);
    if (typeof location.visited !== 'boolean') {
        add(errors, `${path}.visited`, 'must be a boolean');
    }
    requireString(errors, `${path}.notes`, location.notes, { nonEmpty: false });
}

function validateFaction(errors, id, faction, state) {
    const path = `factions.${id}`;
    if (!isObject(faction)) {
        add(errors, path, 'must be an object');
        return;
    }
    if (faction.id !== id) {
        add(errors, `${path}.id`, 'must match the key in factions');
    }
    requireString(errors, `${path}.name`, faction.name);
    requireEnum(errors, `${path}.side`, faction.side, SIDES);
    requireInteger(errors, `${path}.influence`, faction.influence, { min: 0, max: 100 });
    requireEnum(errors, `${path}.status`, faction.status, FACTION_STATUSES);
    requireStringArray(errors, `${path}.goals`, faction.goals);
    requireString(errors, `${path}.description`, faction.description, { nonEmpty: false });
    requireNullableString(errors, `${path}.headquartersLocationId`, faction.headquartersLocationId);
    if (
        typeof faction.headquartersLocationId === 'string'
        && !state.locations?.[faction.headquartersLocationId]
    ) {
        add(
            errors,
            `${path}.headquartersLocationId`,
            `unresolved location "${faction.headquartersLocationId}"`,
        );
    }
}

function validateThreat(errors, threat, index, state) {
    const path = `threats[${index}]`;
    if (!isObject(threat)) {
        add(errors, path, 'must be an object');
        return;
    }
    requireString(errors, `${path}.id`, threat.id);
    requireString(errors, `${path}.name`, threat.name);
    requireEnum(errors, `${path}.rank`, threat.rank, THREAT_RANKS);
    requireNullableString(errors, `${path}.sourceFactionId`, threat.sourceFactionId);
    requireString(errors, `${path}.agenda`, threat.agenda);
    if (!isStringArray(threat.stages) || threat.stages.length === 0) {
        add(errors, `${path}.stages`, 'must be a non-empty array of strings');
    }
    requireInteger(errors, `${path}.progress`, threat.progress, { min: 0, max: 100 });
    const stageMax = Array.isArray(threat.stages) ? Math.max(0, threat.stages.length - 1) : 0;
    requireInteger(errors, `${path}.stage`, threat.stage, { min: 0, max: stageMax });
    requireEnum(errors, `${path}.status`, threat.status, THREAT_STATUSES);
    requireNullableString(errors, `${path}.locationId`, threat.locationId);
    if (typeof threat.locationId === 'string' && !state.locations?.[threat.locationId]) {
        add(errors, `${path}.locationId`, `unresolved location "${threat.locationId}"`);
    }
}

function validateBeatState(errors, id, beat) {
    const path = `beats.${id}`;
    if (!isObject(beat)) {
        add(errors, path, 'must be an object');
        return;
    }
    requireEnum(errors, `${path}.status`, beat.status, BEAT_STATUSES);
    if (beat.resolvedTurn !== null && beat.resolvedTurn !== undefined) {
        requireInteger(errors, `${path}.resolvedTurn`, beat.resolvedTurn, { min: 0 });
    }
    for (const field of ['adaptedFrom', 'adaptedTo', 'reason']) {
        if (beat[field] !== null && beat[field] !== undefined) {
            requireString(errors, `${path}.${field}`, beat[field], { nonEmpty: false });
        }
    }
    if (beat.deferredUntilTurn !== null && beat.deferredUntilTurn !== undefined) {
        requireInteger(errors, `${path}.deferredUntilTurn`, beat.deferredUntilTurn, { min: 0 });
    }
}

function validateBadEnd(errors, characterId, record, state) {
    const path = `badEnds.${characterId}`;
    if (!isObject(record)) {
        add(errors, path, 'must be an object');
        return;
    }
    if (!state.characters?.[characterId]) {
        add(errors, path, `unresolved character "${characterId}"`);
    }
    requireEnum(errors, `${path}.type`, record.type, BAD_END_TYPES);
    if (typeof record.severity !== 'string' && typeof record.severity !== 'number') {
        add(errors, `${path}.severity`, 'must be a string or number');
    }
    requireString(errors, `${path}.cause`, record.cause, { nonEmpty: false });
    requireNullableString(errors, `${path}.sourceCharacterId`, record.sourceCharacterId);
    if (
        typeof record.sourceCharacterId === 'string'
        && !state.characters?.[record.sourceCharacterId]
    ) {
        add(
            errors,
            `${path}.sourceCharacterId`,
            `unresolved character "${record.sourceCharacterId}"`,
        );
    }
    requireNullableString(errors, `${path}.sourceFactionId`, record.sourceFactionId);
    requireInteger(errors, `${path}.turn`, record.turn, { min: 0 });
    requireNullableString(errors, `${path}.date`, record.date);
    requireNullableString(errors, `${path}.locationId`, record.locationId);
    if (typeof record.locationId === 'string' && !state.locations?.[record.locationId]) {
        add(errors, `${path}.locationId`, `unresolved location "${record.locationId}"`);
    }
    requireString(errors, `${path}.epilogueText`, record.epilogueText, { nonEmpty: false });
    if (typeof record.playableAs !== 'boolean') {
        add(errors, `${path}.playableAs`, 'must be a boolean');
    }
    requireString(errors, `${path}.continuityKey`, record.continuityKey);
    requireString(errors, `${path}.reversibility`, record.reversibility, { nonEmpty: false });
    requireString(errors, `${path}.notes`, record.notes, { nonEmpty: false });
    if (!Array.isArray(record.records)) {
        add(errors, `${path}.records`, 'must be an array');
    }
    if (typeof record.reversed !== 'boolean') {
        add(errors, `${path}.reversed`, 'must be a boolean');
    }
    if (record.reversedTurn !== null && record.reversedTurn !== undefined) {
        requireInteger(errors, `${path}.reversedTurn`, record.reversedTurn, { min: 0 });
    }
    requireNullableString(errors, `${path}.reversalReason`, record.reversalReason);
}

function validateRelationship(errors, relationship, index, state) {
    const path = `relationships[${index}]`;
    if (!isObject(relationship)) {
        add(errors, path, 'must be an object');
        return;
    }
    for (const field of ['a', 'b']) {
        if (typeof relationship[field] !== 'string') {
            add(errors, `${path}.${field}`, 'must be a character id');
        } else if (!state.characters?.[relationship[field]]) {
            add(errors, `${path}.${field}`, `unresolved character "${relationship[field]}"`);
        }
    }
    requireString(errors, `${path}.type`, relationship.type, { nonEmpty: false });
    requireNumber(errors, `${path}.affinity`, relationship.affinity, { min: -100, max: 100 });
    requireNumber(errors, `${path}.tension`, relationship.tension, { min: -100, max: 100 });
    requireString(errors, `${path}.notes`, relationship.notes, { nonEmpty: false });
    requireInteger(errors, `${path}.sinceTurn`, relationship.sinceTurn, { min: 0 });
}

function validateEvent(errors, event, index, state) {
    const path = `recentEvents[${index}]`;
    if (!isObject(event)) {
        add(errors, path, 'must be an object');
        return;
    }
    requireInteger(errors, `${path}.turn`, event.turn, { min: 0 });
    requireNullableString(errors, `${path}.date`, event.date);
    requireString(errors, `${path}.summary`, event.summary);
    requireStringArray(errors, `${path}.actors`, event.actors);
    for (const actorId of event.actors ?? []) {
        if (!state.characters?.[actorId]) {
            add(errors, `${path}.actors`, `unresolved character "${actorId}"`);
        }
    }
    requireNullableString(errors, `${path}.locationId`, event.locationId);
    if (typeof event.locationId === 'string' && !state.locations?.[event.locationId]) {
        add(errors, `${path}.locationId`, `unresolved location "${event.locationId}"`);
    }
    requireStringArray(errors, `${path}.tags`, event.tags);
    if (event.headline !== undefined && typeof event.headline !== 'string') {
        add(errors, `${path}.headline`, 'must be a string when present');
    }
    if (event.beatId !== undefined && event.beatId !== null) {
        if (typeof event.beatId !== 'string' || !state.beats?.[event.beatId]) {
            add(errors, `${path}.beatId`, `unresolved beat "${String(event.beatId)}"`);
        }
    }
}

function validateInner(state, errors) {
    if (!isObject(state)) {
        add(errors, '$', 'WorldState must be an object');
        return;
    }
    if (state.schemaVersion !== WORLD_STATE_SCHEMA_VERSION) {
        add(errors, 'schemaVersion', `must be ${WORLD_STATE_SCHEMA_VERSION}`);
    }
    requireString(errors, 'chatId', state.chatId);
    requireString(errors, 'seasonId', state.seasonId);
    requireEnum(errors, 'mode', state.mode, WORLD_MODES);
    requireEnum(errors, 'arc', state.arc, WORLD_ARCS);
    requireEnum(errors, 'playerRole', state.playerRole, PLAYER_ROLES);

    if (!isObject(state.meta)) {
        add(errors, 'meta', 'must be an object');
    } else {
        requireInteger(errors, 'meta.turn', state.meta.turn, { min: 0 });
        if (state.meta.storyTurn !== undefined && state.meta.storyTurn !== null) {
            requireInteger(errors, 'meta.storyTurn', state.meta.storyTurn, { min: 0 });
        }
        requireNullableString(errors, 'meta.inGameDate', state.meta.inGameDate);
        requireString(errors, 'meta.timeOfDay', state.meta.timeOfDay);
        requireString(errors, 'meta.sceneId', state.meta.sceneId);
        if (typeof state.meta.inCombat !== 'boolean') {
            add(errors, 'meta.inCombat', 'must be a boolean');
        }
        if (!isFiniteNumber(state.meta.startedAt)) {
            add(errors, 'meta.startedAt', 'must be a number');
        }
    }

    if (!isObject(state.ending)) {
        add(errors, 'ending', 'must be an object');
    } else {
        requireEnum(errors, 'ending.status', state.ending.status, ENDING_STATUSES);
        if (state.ending.path !== undefined && state.ending.path !== null) {
            requireEnum(errors, 'ending.path', state.ending.path, ENDING_PATHS);
        }
        if (
            state.ending.epilogueText !== undefined
            && typeof state.ending.epilogueText !== 'string'
        ) {
            add(errors, 'ending.epilogueText', 'must be a string when present');
        }
        if (state.ending.firedTurn !== undefined && state.ending.firedTurn !== null) {
            requireInteger(errors, 'ending.firedTurn', state.ending.firedTurn, { min: 0 });
        }
        if (state.ending.status === 'continued' && state.ending.path !== 'resistance'
            && state.ending.path !== 'join-villain') {
            add(errors, 'ending.path', 'continued endings require a resistance or join-villain path');
        }
        if (state.ending.status === 'none' && state.ending.path != null) {
            add(errors, 'ending.path', 'must be absent while the ending has not fired');
        }
        if (state.ending.status !== 'none' && !Number.isInteger(state.ending.firedTurn)) {
            add(errors, 'ending.firedTurn', 'a fired ending requires firedTurn');
        }
        if (state.ending.status === 'continued' && state.arc !== 'post-victory') {
            add(errors, 'arc', 'continued endings require the post-victory arc');
        }
        if (state.ending.status === 'none' && state.arc !== 'season') {
            add(errors, 'arc', 'the season arc precedes the ending');
        }
        if (
            (state.ending.status === 'ended' || state.ending.status === 'epilogue')
            && state.arc === 'post-victory'
        ) {
            add(errors, 'arc', 'the epilogue and the end choice keep the season arc');
        }
    }

    if (!isObject(state.player)) {
        add(errors, 'player', 'must be an object');
    } else {
        requireEnum(errors, 'player.identity', state.player.identity, ['custom', 'canon']);
        requireNullableString(errors, 'player.characterId', state.player.characterId);
        requireString(errors, 'player.personaNotes', state.player.personaNotes, { nonEmpty: false });
        if (state.player.identity === 'canon') {
            if (typeof state.player.characterId !== 'string') {
                add(errors, 'player.characterId', 'a canon player requires a characterId');
            } else if (!state.characters?.[state.player.characterId]) {
                add(
                    errors,
                    'player.characterId',
                    `unresolved character "${state.player.characterId}"`,
                );
            } else if (state.characters[state.player.characterId].controlledBy !== 'player') {
                add(
                    errors,
                    `characters.${state.player.characterId}.controlledBy`,
                    'the player-controlled character must be marked player',
                );
            }
        } else if (state.player.characterId !== null) {
            add(errors, 'player.characterId', 'a custom player must have characterId null');
        }
        if (state.player.stamina !== undefined) {
            validateResource(errors, 'player.stamina', state.player.stamina);
        }
        if (state.player.willpower !== undefined) {
            validateResource(errors, 'player.willpower', state.player.willpower);
        }
        if (state.player.corruption !== undefined) {
            if (!isObject(state.player.corruption)) {
                add(errors, 'player.corruption', 'must be an object');
            } else {
                requireInteger(errors, 'player.corruption.stage', state.player.corruption.stage, {
                    min: 0,
                });
                requireNumber(errors, 'player.corruption.progress', state.player.corruption.progress, {
                    min: 0,
                    max: 100,
                });
            }
        }
    }

    if (!isObject(state.characters)) {
        add(errors, 'characters', 'must be an object');
    } else {
        for (const [id, character] of Object.entries(state.characters)) {
            validateCharacter(errors, id, character, state);
        }
    }

    if (!isObject(state.locations)) {
        add(errors, 'locations', 'must be an object');
    } else {
        for (const [id, location] of Object.entries(state.locations)) {
            validateLocation(errors, id, location, state);
        }
    }

    if (!isObject(state.factions)) {
        add(errors, 'factions', 'must be an object');
    } else {
        for (const [id, faction] of Object.entries(state.factions)) {
            validateFaction(errors, id, faction, state);
        }
    }

    if (!Array.isArray(state.threats)) {
        add(errors, 'threats', 'must be an array');
    } else {
        const threatIds = new Set();
        state.threats.forEach((threat, index) => {
            validateThreat(errors, threat, index, state);
            if (typeof threat?.id === 'string') {
                if (threatIds.has(threat.id)) {
                    add(errors, `threats[${index}].id`, `duplicate threat "${threat.id}"`);
                }
                threatIds.add(threat.id);
            }
        });
    }

    if (!isObject(state.beats)) {
        add(errors, 'beats', 'must be an object');
    } else {
        for (const [id, beat] of Object.entries(state.beats)) {
            validateBeatState(errors, id, beat);
        }
    }

    if (!isObject(state.badEnds)) {
        add(errors, 'badEnds', 'must be an object');
    } else {
        for (const [characterId, record] of Object.entries(state.badEnds)) {
            validateBadEnd(errors, characterId, record, state);
        }
    }

    if (!Array.isArray(state.relationships)) {
        add(errors, 'relationships', 'must be an array');
    } else {
        state.relationships.forEach((relationship, index) => {
            validateRelationship(errors, relationship, index, state);
        });
    }

    if (!Array.isArray(state.recentEvents)) {
        add(errors, 'recentEvents', 'must be an array');
    } else {
        state.recentEvents.forEach((event, index) => {
            validateEvent(errors, event, index, state);
        });
    }

    if (!isObject(state.scene)) {
        add(errors, 'scene', 'must be an object');
    } else {
        requireNullableString(errors, 'scene.locationId', state.scene.locationId);
        if (typeof state.scene.locationId === 'string' && !state.locations?.[state.scene.locationId]) {
            add(errors, 'scene.locationId', `unresolved location "${state.scene.locationId}"`);
        }
        requireStringArray(errors, 'scene.present', state.scene.present);
        for (const characterId of state.scene.present ?? []) {
            if (!state.characters?.[characterId]) {
                add(errors, 'scene.present', `unresolved character "${characterId}"`);
            }
        }
        if (state.scene.combat !== null && state.scene.combat !== undefined) {
            if (!isObject(state.scene.combat)) {
                add(errors, 'scene.combat', 'must be an object or null');
            } else {
                requireNullableString(
                    errors,
                    'scene.combat.locationId',
                    state.scene.combat.locationId,
                );
                if (
                    typeof state.scene.combat.locationId === 'string'
                    && !state.locations?.[state.scene.combat.locationId]
                ) {
                    add(
                        errors,
                        'scene.combat.locationId',
                        `unresolved location "${state.scene.combat.locationId}"`,
                    );
                }
                if (state.scene.combat.participants !== undefined) {
                    requireStringArray(
                        errors,
                        'scene.combat.participants',
                        state.scene.combat.participants,
                    );
                    for (const characterId of state.scene.combat.participants ?? []) {
                        if (characterId === 'player' && state.player?.identity === 'custom') {
                            continue;
                        }
                        if (!state.characters?.[characterId]) {
                            add(
                                errors,
                                'scene.combat.participants',
                                `unresolved character "${characterId}"`,
                            );
                        }
                    }
                }
            }
        }
        requireString(errors, 'scene.framing', state.scene.framing, { nonEmpty: false });
    }

    if (!isObject(state.flags)) {
        add(errors, 'flags', 'must be an object');
    }
    if (!Array.isArray(state.log)) {
        add(errors, 'log', 'must be an array');
    }
}

/**
 * Structural, enum, and referential validation. Never throws for ordinary
 * invalid input; an internal failure is reported as a single `$` error.
 *
 * @param {unknown} state
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateWorldState(state) {
    const errors = [];
    try {
        validateInner(state, errors);
    } catch (error) {
        add(errors, '$', `validation failed: ${error?.message ?? String(error)}`);
    }
    return { ok: errors.length === 0, errors };
}

export { clamp };
