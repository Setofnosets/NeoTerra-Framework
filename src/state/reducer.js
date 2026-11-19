/**
 * Pure WorldState event reducer.
 *
 * Agents never mutate state directly: they emit small typed events. Every
 * handler clones the incoming document, validates references, applies the
 * event, and returns the new state. Same events + same context => same state.
 */

import { nextBeatStatus } from '../data/beats.js';
import { editionKey, validateEdition, NEWSROOM_MAX_EDITIONS } from '../data/newsroom.js';
import { EXPLORATION_STATES } from './exploration.js';
import { effectiveStoryTurn } from '../core/world-clock.js';
import { FACTION_STATUSES } from '../data/factions.js';
import { buildFormIndex, isLegalTransform } from '../data/forms.js';
import { applyFormProfileOverlay, FORM_PROFILE_FIELDS } from './form-profiles.js';
import { LOCATION_STATUSES } from '../data/locations.js';
import {
    BAD_END_STATUS,
    BAD_END_TYPES,
    CHARACTER_STATUSES,
    cloneWorldState,
    clamp,
    createCustomPlayer,
    THREAT_STATUSES,
    WORLD_ARCS,
    ENDING_PATHS,
    isJoinVillainPathAvailable,
    isResistancePathAvailable,
    validateCharacterState,
} from './world-state.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
    throw new Error(message);
}

/** Stable idempotency key shared by the pre-check and RECORD_BAD_END. */
function badEndContinuityKey(state, event) {
    return typeof event.continuityKey === 'string' && event.continuityKey.length > 0
        ? event.continuityKey
        : `${state.seasonId}:${event.characterId}`;
}

function requireCharacter(state, characterId) {
    if (typeof characterId !== 'string' || !state.characters[characterId]) {
        fail(`Unknown character "${String(characterId)}"`);
    }
    return state.characters[characterId];
}

function requireLocation(state, locationId) {
    if (typeof locationId !== 'string' || !state.locations[locationId]) {
        fail(`Unknown location "${String(locationId)}"`);
    }
    return state.locations[locationId];
}

function requireThreat(state, threatId) {
    const threat = (state.threats ?? []).find((entry) => entry.id === threatId);
    if (!threat) {
        fail(`Unknown threat "${String(threatId)}"`);
    }
    return threat;
}

function requireBeat(state, beatId) {
    if (typeof beatId !== 'string' || !state.beats[beatId]) {
        fail(`Unknown beat "${String(beatId)}"`);
    }
    return state.beats[beatId];
}

function requireFaction(state, factionId) {
    if (typeof factionId !== 'string' || !state.factions?.[factionId]) {
        fail(`Unknown faction "${String(factionId)}"`);
    }
    return state.factions[factionId];
}

function requireStringList(value, label) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        fail(`${label} must be an array of strings`);
    }
    return value.slice();
}

const GENERATED_PORTRAIT_PATTERN = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
// ~128 KB decoded; higher blobs multiply through the WAL and every swipe snapshot.
const MAX_GENERATED_PORTRAIT_CHARS = 175000;
const MAX_GENERATED_WARNING_CHARS = 240;

/** Keep only a plausible, size-capped image data URL. */
function generatedPortrait(value) {
    return typeof value === 'string'
        && value.length <= MAX_GENERATED_PORTRAIT_CHARS
        && GENERATED_PORTRAIT_PATTERN.test(value)
        ? value
        : null;
}

function ensureExploration(state) {
    if (!isObject(state.flags)) {
        state.flags = {};
    }
    if (!isObject(state.flags.map)) {
        state.flags.map = {};
    }
    if (!isObject(state.flags.map.exploration)) {
        state.flags.map.exploration = { regions: {}, keyLocations: {}, updatedAt: 0 };
    }
    const exploration = state.flags.map.exploration;
    if (!isObject(exploration.regions)) {
        exploration.regions = {};
    }
    if (!isObject(exploration.keyLocations)) {
        exploration.keyLocations = {};
    }
    return exploration;
}

function markExploration(exploration, target, id, source, turn) {
    const previous = isObject(target[id]) ? target[id] : null;
    const stateValue = previous && EXPLORATION_STATES.includes(previous.state)
        ? previous.state
        : 'unknown';
    // Discovery is monotonic: never downgrade a discovered feature.
    if (stateValue === 'discovered') {
        return;
    }
    target[id] = {
        state: 'discovered',
        turn,
        source: typeof source === 'string' ? source : 'editor',
    };
    exploration.updatedAt = turn;
}

function discoverySource(source) {
    return typeof source === 'string' && source.length > 0 ? source : 'editor';
}

function syncPresence(state) {
    // Presence is NPC-only by construction: the played character is a person,
    // not a stage prop, and never appears in `locations[].present` or
    // `scene.present`. Tolerate a partial document (no locations/characters/
    // scene) so a hand-built state cannot crash the reducer.
    const locations = isObject(state?.locations) ? state.locations : null;
    const characters = isObject(state?.characters) ? state.characters : {};
    for (const location of Object.values(locations ?? {})) {
        if (isObject(location)) {
            location.present = [];
        }
    }
    for (const characterId of Object.keys(characters).sort()) {
        const character = characters[characterId];
        if (!isObject(character) || character.controlledBy === 'player') {
            continue;
        }
        if (character.locationId && isObject(locations?.[character.locationId])) {
            locations[character.locationId].present.push(characterId);
        }
    }
    if (isObject(state?.scene)) {
        const sceneLocationId = state.scene.locationId;
        state.scene.present = sceneLocationId
            ? Object.keys(characters)
                .filter((characterId) => isObject(characters[characterId])
                    && characters[characterId].controlledBy !== 'player'
                    && characters[characterId].locationId === sceneLocationId)
                .sort()
            : [];
    }
}

function syncPlayerMirror(state) {
    if (state.player?.identity !== 'canon') {
        return;
    }
    const character = state.characters[state.player.characterId];
    if (!character) {
        return;
    }
    state.player = {
        ...cloneWorldState(character),
        identity: 'canon',
        characterId: state.player.characterId,
        personaNotes: state.player.personaNotes ?? '',
    };
}

function applyStatus(character, status) {
    if (!CHARACTER_STATUSES.includes(status)) {
        fail(`Unknown character status "${String(status)}"`);
    }
    character.status = status;
    if (status === 'dead') {
        character.alive = false;
    } else if (status !== 'retired' && status !== 'lost') {
        character.alive = true;
    }
}

function moveCharacter(state, character, locationId) {
    requireLocation(state, locationId);
    character.locationId = locationId;
    character.lastUpdatedTurn = state.meta.turn;
}

/**
 * Make `character` the player: move the scene to them (unless a fight is
 * already pinned to the current scene), mirror the player state so
 * `player.locationId === scene.locationId`, and rebuild presence so the new
 * player leaves every NPC list and the previous player re-enters the pool.
 * The caller owns the `controlledBy` flips.
 */
function enterPlayerCharacter(state, character, personaNotes) {
    if (!isObject(state.scene?.combat)) {
        const targetLocationId = character.locationId ?? state.scene?.locationId ?? null;
        if (targetLocationId
            && isObject(state.locations?.[targetLocationId])
            && isObject(state.scene)
            && state.scene.locationId !== targetLocationId) {
            state.scene.locationId = targetLocationId;
            state.locations[targetLocationId].visited = true;
        }
    }
    state.player = {
        ...cloneWorldState(character),
        identity: 'canon',
        characterId: character.charId,
        personaNotes,
    };
    // player.locationId === scene.locationId after any identity change.
    if (!isObject(state.scene)) {
        state.player.locationId = null;
    } else if (state.player.locationId !== state.scene.locationId) {
        state.player.locationId = state.scene.locationId ?? null;
    }
    syncPresence(state);
}

function pushEvent(state, event) {
    const entry = {
        turn: Number.isInteger(event.turn) ? event.turn : state.meta.turn,
        date: event.date !== undefined ? event.date : state.meta.inGameDate,
        summary: event.summary,
        actors: Array.isArray(event.actors) ? event.actors.slice() : [],
        locationId: event.locationId !== undefined ? event.locationId : state.scene?.locationId ?? null,
        tags: Array.isArray(event.tags) ? event.tags.slice() : [],
    };
    if (event.headline !== undefined) {
        entry.headline = event.headline;
    }
    if (event.beatId !== undefined) {
        entry.beatId = event.beatId;
    }
    state.recentEvents.push(entry);
    if (state.recentEvents.length > 200) {
        state.recentEvents = state.recentEvents.slice(-200);
    }
}

function resolveFormContext(context) {
    if (!context?.formRules || !context?.formGroups) {
        fail('TRANSFORM requires form context (formRules and formGroups)');
    }
    if (context.formGroups.groupByMemberId && context.formGroups.byGroup) {
        return context.formGroups;
    }
    if (!context.registry) {
        fail('TRANSFORM requires form context (a registry or a resolved form index)');
    }
    return buildFormIndex(context.registry, context.formGroups);
}

const HANDLERS = Object.freeze({
    SET_LOCATION(state, event) {
        const location = requireLocation(state, event.locationId);
        state.scene.locationId = location.id;
        location.visited = true;
        if (event.characterId !== undefined && event.characterId !== null) {
            const character = requireCharacter(state, event.characterId);
            moveCharacter(state, character, location.id);
            syncPlayerMirror(state);
        }
        syncPresence(state);
    },

    MOVE_CHARACTER(state, event) {
        const character = requireCharacter(state, event.characterId);
        moveCharacter(state, character, event.locationId);
        syncPresence(state);
        syncPlayerMirror(state);
    },

    /**
     * Insert a character built by the character creator. The event carries a
     * pre-validated payload; the reducer never calls an LLM and never invents
     * fields. The profile and card are stored beside the world so the Codex and
     * export can read them after a reload.
     */
    ADD_GENERATED_CHARACTER(state, event) {
        if (!isObject(event.character)) {
            fail('ADD_GENERATED_CHARACTER requires a character object');
        }
        if (!isObject(event.profile)) {
            fail('ADD_GENERATED_CHARACTER requires a profile object');
        }
        const character = event.character;
        const charId = character.charId;
        if (typeof charId !== 'string' || charId.trim().length === 0) {
            fail('ADD_GENERATED_CHARACTER requires a character id');
        }
        if (charId !== charId.trim()) {
            fail('ADD_GENERATED_CHARACTER requires a trimmed character id');
        }
        if (!charId.startsWith('gen.')) {
            fail(`ADD_GENERATED_CHARACTER requires a generated id (got "${charId}")`);
        }
        if (Object.hasOwn(state.characters, charId)) {
            fail(`Character "${charId}" already exists`);
        }
        if (typeof character.locationId !== 'string' || character.locationId.length === 0) {
            fail('ADD_GENERATED_CHARACTER requires a location for the new character');
        }
        const validation = validateCharacterState(state, character);
        if (!validation.ok) {
            const first = validation.errors[0];
            fail(`ADD_GENERATED_CHARACTER rejected: ${first?.path ?? 'character'} ${first?.message ?? 'is invalid'}`);
        }

        state.characters[charId] = cloneWorldState(character);
        state.flags = isObject(state.flags) ? state.flags : {};

        const manual = Array.isArray(state.flags.manualCharacters)
            ? state.flags.manualCharacters.filter((id) => typeof id === 'string')
            : [];
        if (!manual.includes(charId)) {
            manual.push(charId);
        }
        state.flags.manualCharacters = manual;

        const generated = isObject(state.flags.generatedCards) ? state.flags.generatedCards : {};
        generated[charId] = {
            card: isObject(event.card) ? cloneWorldState(event.card) : null,
            profile: cloneWorldState(event.profile),
            portrait: generatedPortrait(event.portrait),
            model: typeof event.model === 'string' ? event.model : '',
            generatedAt: Number.isFinite(event.generatedAt) && event.generatedAt >= 0
                ? Math.floor(event.generatedAt)
                : 0,
            approved: false,
            warnings: Array.isArray(event.warnings)
                ? event.warnings
                    .filter((warning) => typeof warning === 'string')
                    .map((warning) => warning.slice(0, MAX_GENERATED_WARNING_CHARS))
                    .slice(0, 20)
                : [],
        };
        state.flags.generatedCards = generated;

        syncPresence(state);
        syncPlayerMirror(state);
    },

    TRANSFORM(state, event, context) {
        const character = requireCharacter(state, event.characterId);
        const formId = event.formId;
        if (typeof formId !== 'string' || formId.length === 0) {
            fail('TRANSFORM requires a formId');
        }
        if (formId === character.formId) {
            fail(`TRANSFORM rejected: "${formId}" is already active`);
        }

        const formIndex = resolveFormContext(context);
        const dynamicForm = isObject(event.dynamicForm) ? event.dynamicForm : null;
        const currentGroup = formIndex.groupByMemberId?.[character.formId]
            ?? (character.formGroup ? formIndex.byGroup?.[character.formGroup] : null);
        const targetGroup = formIndex.groupByMemberId?.[formId] ?? null;
        const targetEntry = formIndex.byId?.[formId]
            ?? targetGroup?.members?.find((member) => member.id === formId)
            ?? null;

        if (!targetEntry || !targetGroup) {
            if (!dynamicForm) {
                fail(`Unknown form "${formId}"`);
            }
        }
        if (targetGroup && currentGroup && currentGroup.id !== targetGroup.id) {
            fail(`TRANSFORM rejected: "${formId}" is not in the character's form group`);
        }
        // A generated form still needs a declared rule unless the flow already
        // validated the transition (the reducer accepts only a complete,
        // pre-validated dynamicForm payload).
        if (!dynamicForm && !isLegalTransform(context.formRules, character.formId, formId)) {
            fail(`TRANSFORM rejected: no declared rule from "${character.formId}" to "${formId}"`);
        }

        character.formId = formId;
        character.formGroup = targetGroup?.id ?? currentGroup?.id ?? character.formGroup;
        character.lastUpdatedTurn = state.meta.turn;
        if (context.registry && targetEntry) {
            character.side = targetEntry.side ?? character.side;
            character.displayName = targetEntry.displayName ?? character.displayName;
            character.threatLevel = targetEntry.threatLevel ?? character.threatLevel;
        }
        if (dynamicForm) {
            character.side = dynamicForm.side ?? character.side;
            character.displayName = dynamicForm.displayName ?? character.displayName;
            character.formKind = dynamicForm.formKind ?? character.formKind ?? null;
        }

        // Apply the target form's card profile. Live resources, status,
        // relationships, and manually edited fields survive the transform.
        const manualPaths = state.player?.identity === 'canon'
            && state.player.characterId === character.charId
            ? Object.keys(state.flags?.playerTracker?.manualEdits ?? {})
            : [];
        const manualFields = [
            ...(Array.isArray(character.manualFields) ? character.manualFields : []),
            ...manualPaths,
        ];
        // Goals are plot-owned once a tracker writes them: a swap must not
        // overwrite a live goal with the card's starting list.
        if (character.goalsSource === 'live') {
            manualFields.push('goals');
        }
        const overlay = dynamicForm?.overlay ?? character.formProfiles?.[formId] ?? null;
        if (overlay) {
            applyFormProfileOverlay(character, overlay, manualFields);
            character.profileFormId = formId;
            character.profileSource = overlay.source ?? (dynamicForm ? 'generated' : 'card');
            delete character.profileMissing;
        } else {
            character.profileFormId = formId;
            character.profileSource = 'missing';
            character.profileMissing = formId;
        }
        // Aliases and tags follow the active form, so a form with no metadata
        // clears them instead of inheriting the previous form's list. The
        // overlay value is a fallback for generated forms that have no
        // registry entry.
        character.aliases = Array.isArray(overlay?.aliases)
            ? overlay.aliases.slice()
            : (Array.isArray(targetEntry?.aliases) ? targetEntry.aliases.slice() : []);
        character.tags = Array.isArray(overlay?.tags)
            ? overlay.tags.slice()
            : (Array.isArray(targetEntry?.tags) ? targetEntry.tags.slice() : []);
        if (character.goalsSource !== 'live') {
            character.goalsSource = 'card';
        }
        if (dynamicForm) {
            const generated = isObject(state.flags?.generatedForms) ? state.flags.generatedForms : {};
            const forCharacter = isObject(generated[character.charId]) ? generated[character.charId] : {};
            state.flags = {
                ...(isObject(state.flags) ? state.flags : {}),
                generatedForms: {
                    ...generated,
                    [character.charId]: {
                        ...forCharacter,
                        [formId]: {
                            ...dynamicForm,
                            generated: true,
                            formId,
                        },
                    },
                },
            };
        }
        syncPlayerMirror(state);
    },

    SET_STATUS(state, event) {
        const character = requireCharacter(state, event.characterId);
        applyStatus(character, event.status);
        character.lastUpdatedTurn = state.meta.turn;
        syncPlayerMirror(state);
    },

    ADVANCE_THREAT(state, event) {
        const threat = requireThreat(state, event.threatId);
        const stageCount = Math.max(1, threat.stages.length);
        const step = 100 / stageCount;

        let progress = Number(threat.progress ?? 0);
        if (event.amount !== undefined || event.stage === undefined) {
            const amount = event.amount ?? 10;
            if (!Number.isFinite(amount)) {
                fail('ADVANCE_THREAT amount must be a number');
            }
            progress = clamp(progress + amount, 0, 100);
        }

        let stage;
        if (event.stage !== undefined) {
            if (!Number.isFinite(event.stage)) {
                fail('ADVANCE_THREAT stage must be a number');
            }
            stage = clamp(Math.round(event.stage), 0, stageCount - 1);
        } else {
            stage = clamp(Math.floor(progress / step), 0, stageCount - 1);
        }

        threat.progress = Math.round(progress);
        threat.stage = stage;
    },

    TICK_TIME(state, event) {
        const turns = event.turns ?? 1;
        if (!Number.isInteger(turns) || turns < 0) {
            fail('TICK_TIME turns must be a non-negative integer');
        }
        const storyTurns = event.storyTurns ?? turns;
        if (!Number.isInteger(storyTurns) || storyTurns < 0) {
            fail('TICK_TIME storyTurns must be a non-negative integer');
        }
        // Read fiction time before the mechanical turn moves: V1 documents
        // without `storyTurn` fall back to the pre-tick `meta.turn`.
        const baseStoryTurn = effectiveStoryTurn(state);
        state.meta.turn += turns;
        state.meta.storyTurn = baseStoryTurn + storyTurns;
        if (Object.hasOwn(event, 'date')) {
            if (event.date !== null && typeof event.date !== 'string') {
                fail('TICK_TIME date must be a string or null');
            }
            state.meta.inGameDate = event.date;
        }
        if (event.timeOfDay !== undefined) {
            if (typeof event.timeOfDay !== 'string' || event.timeOfDay.length === 0) {
                fail('TICK_TIME timeOfDay must be a non-empty string');
            }
            state.meta.timeOfDay = event.timeOfDay;
        }
    },

    RELATIONSHIP_DELTA(state, event) {
        const a = requireCharacter(state, event.a);
        const b = requireCharacter(state, event.b);
        if (a.charId === b.charId) {
            fail('RELATIONSHIP_DELTA requires two different characters');
        }
        const affinityDelta = event.affinityDelta ?? 0;
        const tensionDelta = event.tensionDelta ?? 0;
        if (!Number.isFinite(affinityDelta) || !Number.isFinite(tensionDelta)) {
            fail('RELATIONSHIP_DELTA deltas must be numbers');
        }
        // `event.type` is the envelope discriminator, so the relationship kind
        // travels as `relationshipType` (with `kind` / `relationship.type` as
        // convenience aliases).
        const relationshipType = event.relationshipType
            ?? event.kind
            ?? event.relationship?.type
            ?? null;

        const existing = state.relationships.find(
            (relationship) =>
                (relationship.a === a.charId && relationship.b === b.charId)
                || (relationship.a === b.charId && relationship.b === a.charId),
        );
        if (existing) {
            if (relationshipType !== null) {
                existing.type = String(relationshipType);
            }
            existing.affinity = clamp(existing.affinity + affinityDelta, -100, 100);
            existing.tension = clamp(existing.tension + tensionDelta, -100, 100);
            if (event.notes !== undefined) {
                existing.notes = String(event.notes);
            }
            if (event.sinceTurn !== undefined) {
                existing.sinceTurn = event.sinceTurn;
            }
        } else {
            state.relationships.push({
                a: a.charId,
                b: b.charId,
                type: relationshipType !== null ? String(relationshipType) : 'neutral',
                affinity: clamp(affinityDelta, -100, 100),
                tension: clamp(tensionDelta, -100, 100),
                notes: event.notes !== undefined ? String(event.notes) : '',
                sinceTurn: Number.isInteger(event.sinceTurn) ? event.sinceTurn : state.meta.turn,
            });
        }
    },

    ADD_EVENT(state, event) {
        if (typeof event.summary !== 'string' || event.summary.trim().length === 0) {
            fail('ADD_EVENT requires a non-empty summary');
        }
        if (event.locationId !== undefined && event.locationId !== null) {
            requireLocation(state, event.locationId);
        }
        if (event.beatId !== undefined && event.beatId !== null) {
            requireBeat(state, event.beatId);
        }
        const actors = Array.isArray(event.actors) ? event.actors : [];
        for (const actorId of actors) {
            requireCharacter(state, actorId);
        }
        if (event.turn !== undefined && (!Number.isInteger(event.turn) || event.turn < 0)) {
            fail('ADD_EVENT turn must be a non-negative integer');
        }

        pushEvent(state, { ...event, actors });
        for (const actorId of actors) {
            const character = state.characters[actorId];
            character.lastUpdatedTurn = state.meta.turn;
        }
        syncPlayerMirror(state);
    },

    RESOLVE_BEAT(state, event) {
        const beat = requireBeat(state, event.beatId);
        beat.status = nextBeatStatus(beat.status, 'resolved');
        beat.resolvedTurn = Number.isInteger(event.turn) ? event.turn : state.meta.turn;
        if (event.reason !== undefined) {
            beat.reason = event.reason;
        }
    },

    ADAPT_BEAT(state, event) {
        const beat = requireBeat(state, event.beatId);
        if (typeof event.adaptedFrom !== 'string' || typeof event.adaptedTo !== 'string') {
            fail('ADAPT_BEAT requires adaptedFrom and adaptedTo');
        }
        beat.status = nextBeatStatus(beat.status, 'adapted');
        beat.resolvedTurn = Number.isInteger(event.turn) ? event.turn : state.meta.turn;
        beat.adaptedFrom = event.adaptedFrom;
        beat.adaptedTo = event.adaptedTo;
        if (event.reason !== undefined) {
            beat.reason = event.reason;
        }
    },

    DEFER_BEAT(state, event) {
        const beat = requireBeat(state, event.beatId);
        if (typeof event.reason !== 'string' || event.reason.trim().length === 0) {
            fail('DEFER_BEAT requires a reason');
        }
        beat.status = nextBeatStatus(beat.status, 'deferred');
        beat.reason = event.reason;
        beat.deferredUntilTurn = Number.isInteger(event.untilTurn) ? event.untilTurn : null;
    },

    // Invariant: after any identity change the player mirror and the scene
    // agree on the location, so the POV, the map, and presence never diverge.
    SET_PLAYER_IDENTITY(state, event) {
        const identity = event.identity;
        if (identity !== 'custom' && identity !== 'canon') {
            fail(`Unknown player identity "${String(identity)}"`);
        }
        const applyNonCanon = () => {
            if (typeof event.nonCanon !== 'boolean') {
                return;
            }
            state.flags = {
                ...(isObject(state.flags) ? state.flags : {}),
                nonCanon: event.nonCanon,
            };
        };

        const previousCharacter = state.player.identity === 'canon'
            ? state.characters[state.player.characterId] ?? null
            : null;
        const personaNotes = event.personaNotes ?? state.player.personaNotes ?? '';

        if (identity === 'custom') {
            if (previousCharacter) {
                previousCharacter.controlledBy = 'npc';
            }
            // A custom persona starts fresh. Only the notes (and an optional
            // explicit display name) transfer; no canon state is inherited.
            state.player = createCustomPlayer({
                displayName: event.displayName ?? 'The Player',
                personaNotes,
                locationId: state.scene?.locationId ?? null,
            });
            // The previously played character is an NPC again: re-enter them
            // into presence at their own location. A return to a custom persona
            // never moves the scene.
            syncPresence(state);
            applyNonCanon();
            return;
        }

        const characterId = event.characterId;
        // Sandbox / any-character timelines may start playing as a registry
        // character that was not part of the seeded roster. The codex supplies
        // the fully-formed CharacterState; insert it exactly once.
        if (!state.characters[characterId] && isObject(event.character)) {
            state.characters[characterId] = {
                ...cloneWorldState(event.character),
                charId: characterId,
            };
        }
        const character = requireCharacter(state, characterId);
        if (character.status === 'missing') {
            fail(`Cannot play as "${characterId}": the character is missing`);
        }
        if (character.alive === false || character.status === 'dead') {
            const badEndRecord = state.badEnds?.[characterId] ?? null;
            const allowed = event.allowDeadContinuation === true
                && character.status === 'dead'
                && Boolean(badEndRecord);
            if (!allowed) {
                fail(`Cannot play as "${characterId}": the character is dead or missing`);
            }
        }

        if (previousCharacter && previousCharacter.charId !== character.charId) {
            previousCharacter.controlledBy = 'npc';
        }
        character.controlledBy = 'player';
        enterPlayerCharacter(state, character, personaNotes);
        applyNonCanon();
    },

    CONTINUE_BAD_END(state, event) {
        const action = event.action;
        if (action !== 'self' && action !== 'other' && action !== 'end') {
            fail(`Unknown bad-end continuation "${String(action)}"`);
        }
        if (action === 'end') {
            // End-here is a UI choice, not a mutation. Do not invent an ending.
            return;
        }

        const previousCharacter = state.player.identity === 'canon'
            ? state.characters[state.player.characterId] ?? null
            : null;
        const personaNotes = state.player?.personaNotes ?? '';
        const turn = state.meta?.turn ?? 0;

        if (action === 'self') {
            const characterId = event.characterId;
            const character = requireCharacter(state, characterId);
            const record = state.badEnds?.[characterId] ?? null;
            if (!record) {
                fail(`Cannot continue as "${characterId}": no bad end record exists`);
            }
            if (character.status === 'missing') {
                fail(`Cannot continue as "${characterId}": the character is missing`);
            }
            const isDead = character.status === 'dead' || character.alive === false;
            if (isDead && (event.allowDeadContinuation !== true || character.status !== 'dead')) {
                fail(`Cannot continue as "${characterId}": dead continuation is not enabled`);
            }
            if (previousCharacter && previousCharacter.charId !== character.charId) {
                previousCharacter.controlledBy = 'npc';
            }
            character.controlledBy = 'player';
            enterPlayerCharacter(state, character, personaNotes);
            state.flags = {
                ...(isObject(state.flags) ? state.flags : {}),
                badEndContinuation: {
                    characterId: character.charId,
                    choice: 'self',
                    turn,
                },
            };
            return;
        }

        if (event.identity !== 'custom' && event.identity !== 'canon') {
            fail(`Unknown player identity "${String(event.identity)}"`);
        }

        if (event.identity === 'custom') {
            if (previousCharacter) {
                previousCharacter.controlledBy = 'npc';
            }
            state.player = createCustomPlayer({
                displayName: typeof event.displayName === 'string' && event.displayName.length > 0
                    ? event.displayName
                    : 'The Player',
                personaNotes,
                locationId: state.scene?.locationId ?? null,
            });
            state.flags = {
                ...(isObject(state.flags) ? state.flags : {}),
                badEndContinuation: {
                    characterId: null,
                    choice: 'other',
                    turn,
                },
            };
            // The previous player is an NPC again: re-pool them. A custom
            // persona never moves the scene.
            syncPresence(state);
            return;
        }

        const characterId = event.characterId;
        const character = requireCharacter(state, characterId);
        if (character.alive !== true || character.status === 'dead' || character.status === 'missing') {
            fail(`Cannot play as "${characterId}": the character is not alive`);
        }
        const targetBadEnd = state.badEnds?.[characterId] ?? null;
        if (targetBadEnd && targetBadEnd.reversed !== true) {
            fail(`Cannot play as "${characterId}": the character has an active bad-end record`);
        }
        if (previousCharacter && previousCharacter.charId !== character.charId) {
            previousCharacter.controlledBy = 'npc';
        }
        character.controlledBy = 'player';
        enterPlayerCharacter(state, character, personaNotes);
        state.flags = {
            ...(isObject(state.flags) ? state.flags : {}),
            badEndContinuation: {
                characterId: character.charId,
                choice: 'other',
                turn,
            },
        };
    },

    TRIGGER_ENDING(state, event) {
        if (state.ending?.status !== 'none') {
            return state;
        }
        state.ending.status = 'epilogue';
        state.ending.firedTurn = Number.isInteger(event.firedTurn)
            ? event.firedTurn
            : state.meta.turn;
    },

    CHOOSE_ENDING_PATH(state, event) {
        if (state.ending?.status !== 'epilogue') {
            fail('CHOOSE_ENDING_PATH requires an epilogue ending');
        }
        const path = event.path;
        if (!ENDING_PATHS.includes(path)) {
            fail(`Invalid ending path "${String(path)}"`);
        }
        if (path === 'join-villain' && !isJoinVillainPathAvailable(state)) {
            fail('Ending path "join-villain" is not available in this state');
        }
        if (path === 'resistance' && !isResistancePathAvailable(state)) {
            fail('Ending path "resistance" is not available in this state');
        }

        state.ending.path = path;
        if (path === 'end') {
            state.ending.status = 'ended';
        } else {
            state.ending.status = 'continued';
            state.arc = 'post-victory';
        }

        const summary = path === 'resistance'
            ? 'The player chooses to continue as resistance against the victor.'
            : path === 'join-villain'
                ? 'The player chooses to join the victor.'
                : 'The player chooses to end the story at the epilogue.';
        pushEvent(state, {
            turn: state.meta.turn,
            date: state.meta.inGameDate,
            summary,
            actors: state.player.identity === 'canon' ? [state.player.characterId] : [],
            locationId: state.scene.locationId,
            tags: ['ending', path],
        });
    },

    SET_ARC(state, event) {
        if (!WORLD_ARCS.includes(event.arc)) {
            fail(`Unknown world arc "${String(event.arc)}"`);
        }
        if (state.arc === event.arc) {
            return;
        }
        const status = state.ending?.status ?? 'none';
        if (event.arc === 'post-victory' && status !== 'continued') {
            fail('The post-victory arc requires a continued ending');
        }
        if (event.arc === 'season' && status === 'continued') {
            fail('A continued ending requires the post-victory arc');
        }
        state.arc = event.arc;
    },

    RECORD_BAD_END(state, event) {
        const character = requireCharacter(state, event.characterId);
        // The envelope's `event.type` is always "RECORD_BAD_END"; the bad-end
        // kind itself travels as `badEndType` (aliases: endType, recordType,
        // record.type).
        const badEndType = event.badEndType
            ?? event.endType
            ?? event.recordType
            ?? event.record?.type
            ?? event.badEnd?.type
            ?? event.badEnd;
        if (!BAD_END_TYPES.includes(badEndType)) {
            fail(`Unknown bad end type "${String(badEndType)}"`);
        }
        const continuityKey = badEndContinuityKey(state, event);
        if (event.sourceCharacterId !== undefined && event.sourceCharacterId !== null) {
            requireCharacter(state, event.sourceCharacterId);
        }
        if (event.locationId !== undefined && event.locationId !== null) {
            requireLocation(state, event.locationId);
        }

        const existing = state.badEnds?.[character.charId];
        if (existing && existing.continuityKey === continuityKey) {
            return state;
        }

        const record = {
            type: badEndType,
            severity: event.severity ?? 'major',
            cause: event.cause ?? '',
            sourceCharacterId: event.sourceCharacterId ?? null,
            sourceFactionId: event.sourceFactionId ?? null,
            turn: Number.isInteger(event.turn) ? event.turn : state.meta.turn,
            date: event.date !== undefined ? event.date : state.meta.inGameDate,
            locationId: event.locationId !== undefined ? event.locationId : character.locationId,
            epilogueText: event.epilogueText ?? '',
            playableAs: event.playableAs === true,
            continuityKey,
            reversibility: event.reversibility ?? 'none',
            notes: event.notes ?? '',
            records: Array.isArray(existing?.records) ? existing.records.slice() : [],
            reversed: false,
            reversedTurn: null,
            reversalReason: null,
        };

        if (existing) {
            const prior = { ...existing };
            delete prior.records;
            record.records.push(prior);
        }

        state.badEnds[character.charId] = record;
        character.badEndType = badEndType;
        applyStatus(character, BAD_END_STATUS[badEndType]);
        character.lastUpdatedTurn = state.meta.turn;
        syncPlayerMirror(state);
    },

    REVERSE_BAD_END(state, event) {
        const character = requireCharacter(state, event.characterId);
        const record = state.badEnds?.[character.charId];
        if (!record) {
            fail(`No bad end record for character "${character.charId}"`);
        }
        const restoredStatus = event.restoredStatus ?? 'active';
        if (!CHARACTER_STATUSES.includes(restoredStatus)) {
            fail(`Unknown character status "${String(restoredStatus)}"`);
        }

        record.reversed = true;
        record.reversedTurn = state.meta.turn;
        record.reversalReason = event.reason ?? '';
        record.restoredStatus = restoredStatus;

        character.badEndType = null;
        applyStatus(character, restoredStatus);
        character.lastUpdatedTurn = state.meta.turn;
        syncPlayerMirror(state);
    },

    DISCOVER_MAP_FEATURE(state, event) {
        if (event.kind !== 'region' && event.kind !== 'keyLocation') {
            fail('DISCOVER_MAP_FEATURE kind must be "region" or "keyLocation"');
        }
        if (typeof event.id !== 'string' || event.id.length === 0) {
            fail('DISCOVER_MAP_FEATURE requires an id');
        }
        const exploration = ensureExploration(state);
        const turn = Number.isInteger(state.meta?.turn) ? state.meta.turn : 0;
        const target = event.kind === 'region' ? exploration.regions : exploration.keyLocations;
        markExploration(exploration, target, event.id, discoverySource(event.source), turn);
    },

    REVEAL_REGION(state, event) {
        const regionId = typeof event.regionId === 'string' && event.regionId.length > 0
            ? event.regionId
            : event.id;
        if (typeof regionId !== 'string' || regionId.length === 0) {
            fail('REVEAL_REGION requires a regionId');
        }
        const exploration = ensureExploration(state);
        const turn = Number.isInteger(state.meta?.turn) ? state.meta.turn : 0;
        markExploration(exploration, exploration.regions, regionId, discoverySource(event.source), turn);
    },

    RESET_EXPLORATION(state, event) {
        const turn = Number.isInteger(state.meta?.turn) ? state.meta.turn : 0;
        const exploration = ensureExploration(state);
        exploration.regions = {};
        exploration.keyLocations = {};
        exploration.updatedAt = turn;
        for (const regionId of Array.isArray(event.regionIds) ? event.regionIds : []) {
            if (typeof regionId === 'string' && regionId.length > 0) {
                markExploration(
                    exploration,
                    exploration.regions,
                    regionId,
                    discoverySource(event.source ?? 'editor'),
                    turn,
                );
            }
        }
    },

    PUBLISH_EDITION(state, event) {
        const validation = validateEdition(event.edition);
        if (!validation.ok) {
            fail(`PUBLISH_EDITION rejected: ${validation.errors.join('; ')}`);
        }
        const edition = validation.edition;
        if (!isObject(state.flags)) {
            state.flags = {};
        }
        const newsroom = isObject(state.flags.newsroom) ? state.flags.newsroom : {};
        const editions = Array.isArray(newsroom.editions) ? newsroom.editions.slice() : [];
        const key = editionKey(edition);
        // The applyWorldEvent pre-check already returns the same document for a
        // duplicate; this keeps a direct handler call idempotent too.
        if (key && editions.some((entry) => editionKey(entry) === key)) {
            return;
        }
        editions.push(edition);
        if (editions.length > NEWSROOM_MAX_EDITIONS) {
            editions.splice(0, editions.length - NEWSROOM_MAX_EDITIONS);
        }
        state.flags.newsroom = {
            ...newsroom,
            lastEditionDate: edition.date,
            lastEditionTurn: edition.turn,
            editions,
        };
    },

    SET_CLOCK_HOLD(state, event) {
        if (typeof event.active !== 'boolean') {
            fail('SET_CLOCK_HOLD active must be a boolean');
        }
        const reason = event.active
            ? (typeof event.reason === 'string' ? event.reason : 'manual')
            : (typeof event.reason === 'string' ? event.reason : null);
        if (!isObject(state.flags)) {
            state.flags = {};
        }
        if (!isObject(state.flags.clock)) {
            state.flags.clock = {};
        }
        state.flags.clock.hold = {
            active: event.active,
            reason,
            sinceTurn: Number.isInteger(state.meta?.turn) ? state.meta.turn : 0,
            sinceDate: state.meta?.inGameDate ?? null,
        };
    },

    COMBAT_START(state, event) {
        const locationId = event.locationId ?? state.scene.locationId;
        if (locationId !== null && locationId !== undefined) {
            requireLocation(state, locationId);
        }
        const participants = Array.isArray(event.participants)
            ? event.participants.slice()
            : state.scene.present.slice();
        // Presence is NPC-only. The default participant list must still include
        // the canon player, or a caller that omits `participants` would start a
        // fight with no player actor.
        const playerCharacterId = state.player?.identity === 'canon'
            ? state.player.characterId
            : null;
        if (typeof playerCharacterId === 'string'
            && playerCharacterId.length > 0
            && !participants.includes(playerCharacterId)) {
            participants.push(playerCharacterId);
        }
        for (const characterId of participants) {
            // A custom persona has no character record; the combat flow
            // represents it as "player" and adopts the reducer contract.
            if (characterId === 'player' && state.player?.identity === 'custom') {
                continue;
            }
            requireCharacter(state, characterId);
        }
        const combat = {
            locationId: locationId ?? null,
            participants,
            kind: typeof event.kind === 'string' ? event.kind : 'skirmish',
            startedTurn: state.meta.turn,
        };
        // Additive combat metadata. Absent fields stay absent so the minimal
        // shape emitted by older callers is unchanged.
        if (typeof event.id === 'string' && event.id.length > 0) {
            combat.id = event.id;
        }
        if (typeof event.stakes === 'string') {
            combat.stakes = event.stakes;
        }
        if (typeof event.intent === 'string') {
            combat.intent = event.intent;
        }
        if (event.seed !== undefined && event.seed !== null) {
            combat.seed = event.seed;
        }
        if (isObject(event.sides)) {
            combat.sides = { ...event.sides };
        }
        if (Number.isInteger(event.round) && event.round >= 0) {
            combat.round = event.round;
        }
        if (Number.isInteger(event.maxRounds) && event.maxRounds > 0) {
            combat.maxRounds = event.maxRounds;
        }
        if (typeof event.status === 'string' && event.status.length > 0) {
            combat.status = event.status;
        }
        if (Array.isArray(event.actions)) {
            combat.actions = event.actions.map((entry) => (isObject(entry) ? { ...entry } : entry));
        }
        state.scene.combat = combat;
        state.meta.inCombat = true;
        // Combat freezes fiction time unless a hold already belongs to another
        // cause (manual/encounter/beat wins) or the caller opts out.
        if (event.hold !== false && state.flags?.clock?.hold?.active !== true) {
            if (!isObject(state.flags)) {
                state.flags = {};
            }
            if (!isObject(state.flags.clock)) {
                state.flags.clock = {};
            }
            state.flags.clock.hold = {
                active: true,
                reason: 'combat',
                sinceTurn: state.meta.turn,
                sinceDate: state.meta.inGameDate ?? null,
            };
        }
    },

    COMBAT_END(state, event) {
        state.scene.combat = null;
        state.meta.inCombat = false;
        const hold = state.flags?.clock?.hold;
        if (hold?.active === true && hold.reason === 'combat' && event?.releaseHold !== false) {
            state.flags.clock.hold = {
                active: false,
                reason: null,
                sinceTurn: state.meta.turn,
                sinceDate: state.meta.inGameDate ?? null,
            };
        }
    },

    SET_FACTION_INFLUENCE(state, event) {
        const faction = requireFaction(state, event.factionId);
        if (event.influence !== undefined) {
            if (!Number.isFinite(event.influence)) {
                fail('SET_FACTION_INFLUENCE influence must be a number');
            }
            faction.influence = Math.round(clamp(event.influence, 0, 100));
        }
        if (event.status !== undefined) {
            if (!FACTION_STATUSES.includes(event.status)) {
                fail(`Unknown faction status "${String(event.status)}"`);
            }
            faction.status = event.status;
        }
        if (event.goals !== undefined) {
            faction.goals = requireStringList(event.goals, 'SET_FACTION_INFLUENCE goals');
        }
    },

    SET_LOCATION_STATUS(state, event) {
        const location = requireLocation(state, event.locationId);
        if (event.status !== undefined) {
            if (!LOCATION_STATUSES.includes(event.status)) {
                fail(`Unknown location status "${String(event.status)}"`);
            }
            location.status = event.status;
        }
        if (event.factionId !== undefined) {
            if (event.factionId !== null) {
                requireFaction(state, event.factionId);
            }
            location.factionId = event.factionId;
        }
        if (event.notes !== undefined) {
            if (typeof event.notes !== 'string') {
                fail('SET_LOCATION_STATUS notes must be a string');
            }
            location.notes = event.notes;
        }
    },

    SET_CHARACTER_FIELDS(state, event) {
        const character = requireCharacter(state, event.characterId);
        if (event.status !== undefined) {
            applyStatus(character, event.status);
        }
        if (event.agenda !== undefined) {
            if (typeof event.agenda !== 'string') {
                fail('SET_CHARACTER_FIELDS agenda must be a string');
            }
            character.agenda = event.agenda;
        }
        if (event.goals !== undefined) {
            character.goals = requireStringList(event.goals, 'SET_CHARACTER_FIELDS goals');
            character.goalsSource = event.goalsSource === 'card' ? 'card' : 'live';
        }
        if (event.allegiance !== undefined) {
            if (typeof event.allegiance !== 'string') {
                fail('SET_CHARACTER_FIELDS allegiance must be a string');
            }
            character.allegiance = event.allegiance;
        }
        if (event.mood !== undefined) {
            if (typeof event.mood !== 'string') {
                fail('SET_CHARACTER_FIELDS mood must be a string');
            }
            character.mood = event.mood;
        }
        if (event.skills !== undefined) {
            character.skills = requireStringList(event.skills, 'SET_CHARACTER_FIELDS skills');
        }
        if (event.traits !== undefined) {
            character.traits = requireStringList(event.traits, 'SET_CHARACTER_FIELDS traits');
        }
        if (event.outfit !== undefined) {
            if (typeof event.outfit !== 'string') {
                fail('SET_CHARACTER_FIELDS outfit must be a string');
            }
            character.outfit = event.outfit;
        }
        if (event.notes !== undefined) {
            if (typeof event.notes !== 'string') {
                fail('SET_CHARACTER_FIELDS notes must be a string');
            }
            character.notes = event.notes;
        }
        if (event.injuries !== undefined) {
            character.injuries = requireStringList(event.injuries, 'SET_CHARACTER_FIELDS injuries');
        }
        // Player/Codex edits may mark fields that must survive a form swap.
        if (event.manualFields !== undefined) {
            const manual = new Set([
                ...(Array.isArray(character.manualFields) ? character.manualFields : []),
                ...requireStringList(event.manualFields, 'SET_CHARACTER_FIELDS manualFields'),
            ]);
            character.manualFields = [...manual];
        }
        character.lastUpdatedTurn = state.meta.turn;
        syncPlayerMirror(state);
    },

    SET_SCENE_FRAMING(state, event) {
        if (typeof event.framing !== 'string') {
            fail('SET_SCENE_FRAMING framing must be a string');
        }
        state.scene.framing = event.framing;
    },

    SET_THREAT_STATUS(state, event) {
        const threat = requireThreat(state, event.threatId);
        if (!THREAT_STATUSES.includes(event.status)) {
            fail(`Unknown threat status "${String(event.status)}"`);
        }
        threat.status = event.status;
        if (event.locationId !== undefined) {
            if (event.locationId !== null) {
                requireLocation(state, event.locationId);
            }
            threat.locationId = event.locationId;
        }
    },

    SHORT_CIRCUIT_BEAT(state, event) {
        const beat = requireBeat(state, event.beatId);
        if (typeof event.reason !== 'string' || event.reason.trim().length === 0) {
            fail('SHORT_CIRCUIT_BEAT requires a reason');
        }
        beat.status = nextBeatStatus(beat.status, 'short-circuited');
        beat.resolvedTurn = Number.isInteger(event.turn) ? event.turn : state.meta.turn;
        beat.reason = event.reason;
    },

    SET_PLAYER_FIELDS(state, event) {
        const player = state.player;
        if (!isObject(player)) {
            fail('SET_PLAYER_FIELDS requires a player state');
        }
        const character = player.identity === 'canon' && player.characterId
            ? state.characters?.[player.characterId] ?? null
            : null;

        const applyTo = (target) => {
            if (!target) {
                return;
            }
            if (event.status !== undefined) {
                applyStatus(target, event.status);
            }
            if (event.agenda !== undefined) {
                target.agenda = String(event.agenda);
            }
            if (event.goals !== undefined) {
                target.goals = requireStringList(event.goals, 'SET_PLAYER_FIELDS goals');
                target.goalsSource = event.goalsSource === 'card' ? 'card' : 'live';
            }
            if (event.allegiance !== undefined) {
                target.allegiance = String(event.allegiance);
            }
            if (event.mood !== undefined) {
                target.mood = String(event.mood);
            }
            if (event.outfit !== undefined) {
                target.outfit = String(event.outfit);
            }
            if (event.appearance !== undefined) {
                target.appearance = String(event.appearance);
            }
            if (event.notes !== undefined) {
                target.notes = String(event.notes);
            }
            if (event.skills !== undefined) {
                target.skills = requireStringList(event.skills, 'SET_PLAYER_FIELDS skills');
            }
            if (event.traits !== undefined) {
                target.traits = requireStringList(event.traits, 'SET_PLAYER_FIELDS traits');
            }
            if (event.injuries !== undefined) {
                target.injuries = requireStringList(event.injuries, 'SET_PLAYER_FIELDS injuries');
            }
            target.lastUpdatedTurn = state.meta.turn;
        };

        applyTo(player);
        if (character) {
            applyTo(character);
        }
    },

    PLAYER_RELATIONSHIP_DELTA(state, event) {
        const player = state.player;
        const target = requireCharacter(state, event.withCharacterId);
        if (player.identity === 'canon' && player.characterId === target.charId) {
            fail('PLAYER_RELATIONSHIP_DELTA cannot target the player character');
        }
        const affinityDelta = event.affinityDelta ?? 0;
        const tensionDelta = event.tensionDelta ?? 0;
        if (!Number.isFinite(affinityDelta) || !Number.isFinite(tensionDelta)) {
            fail('PLAYER_RELATIONSHIP_DELTA deltas must be numbers');
        }
        const relationships = Array.isArray(player.relationships)
            ? player.relationships.map((relationship) => ({ ...relationship }))
            : [];
        const existing = relationships.find(
            (relationship) => relationship.withCharacterId === target.charId,
        );
        if (existing) {
            existing.type = event.relationshipType ?? existing.type ?? 'neutral';
            existing.affinity = clamp(existing.affinity + affinityDelta, -100, 100);
            existing.tension = clamp(existing.tension + tensionDelta, -100, 100);
            if (event.notes !== undefined) {
                existing.notes = String(event.notes);
            }
        } else {
            relationships.push({
                withCharacterId: target.charId,
                type: event.relationshipType ?? 'neutral',
                affinity: clamp(affinityDelta, -100, 100),
                tension: clamp(tensionDelta, -100, 100),
                notes: event.notes !== undefined ? String(event.notes) : '',
                sinceTurn: Number.isInteger(event.sinceTurn) ? event.sinceTurn : state.meta.turn,
            });
        }
        player.relationships = relationships;
        if (player.identity === 'canon' && player.characterId) {
            const character = state.characters?.[player.characterId];
            if (character) {
                character.relationships = relationships.map((relationship) => ({ ...relationship }));
            }
        }
    },

    SET_PLAYER_STAT(state, event) {
        const path = event.path;
        const value = event.value;
        const player = state.player;

        if (!isObject(player)) {
            fail('SET_PLAYER_STAT requires a player state');
        }

        const numeric = (label) => {
            if (!Number.isFinite(value)) {
                fail(`SET_PLAYER_STAT ${label} requires a number`);
            }
            return value;
        };

        switch (path) {
            case 'stamina.current':
                player.stamina.current = clamp(numeric(path), 0, player.stamina.max);
                break;
            case 'stamina.max': {
                const max = Math.max(0, numeric(path));
                player.stamina.max = max;
                player.stamina.current = Math.min(player.stamina.current, max);
                break;
            }
            case 'willpower.current':
                player.willpower.current = clamp(numeric(path), 0, player.willpower.max);
                break;
            case 'willpower.max': {
                const max = Math.max(0, numeric(path));
                player.willpower.max = max;
                player.willpower.current = Math.min(player.willpower.current, max);
                break;
            }
            case 'corruption.stage':
                if (!Number.isInteger(value) || value < 0) {
                    fail('SET_PLAYER_STAT corruption.stage requires a non-negative integer');
                }
                player.corruption.stage = value;
                break;
            case 'corruption.progress':
                player.corruption.progress = clamp(numeric(path), 0, 100);
                break;
            case 'mood':
            case 'outfit':
            case 'notes':
                if (typeof value !== 'string') {
                    fail(`SET_PLAYER_STAT ${path} requires a string`);
                }
                player[path] = value;
                break;
            default:
                fail(`Unknown SET_PLAYER_STAT path "${String(path)}"`);
        }

        player.lastUpdatedTurn = state.meta.turn;
        if (state.player.identity === 'canon') {
            const character = state.characters[state.player.characterId];
            if (character) {
                if (path.startsWith('stamina.')) {
                    character.stamina = { ...player.stamina };
                } else if (path.startsWith('willpower.')) {
                    character.willpower = { ...player.willpower };
                } else if (path.startsWith('corruption.')) {
                    character.corruption = { ...player.corruption };
                } else if (path === 'mood' || path === 'outfit' || path === 'notes') {
                    character[path] = player[path];
                }
                character.lastUpdatedTurn = state.meta.turn;
            }
        }
    },
    SET_CHARACTER_STAT(state, event) {
        const character = requireCharacter(state, event.characterId);
        const path = event.path;
        const value = event.value;

        const numeric = () => {
            if (!Number.isFinite(value)) {
                fail(`SET_CHARACTER_STAT ${String(path)} requires a number`);
            }
            return value;
        };

        switch (path) {
            case 'stamina.current':
                character.stamina.current = clamp(numeric(), 0, character.stamina.max);
                break;
            case 'stamina.max': {
                const max = Math.max(0, numeric());
                character.stamina.max = max;
                character.stamina.current = Math.min(character.stamina.current, max);
                break;
            }
            case 'willpower.current':
                character.willpower.current = clamp(numeric(), 0, character.willpower.max);
                break;
            case 'willpower.max': {
                const max = Math.max(0, numeric());
                character.willpower.max = max;
                character.willpower.current = Math.min(character.willpower.current, max);
                break;
            }
            case 'corruption.stage':
                if (!Number.isInteger(value) || value < 0) {
                    fail('SET_CHARACTER_STAT corruption.stage requires a non-negative integer');
                }
                character.corruption.stage = value;
                break;
            case 'corruption.progress':
                character.corruption.progress = clamp(numeric(), 0, 100);
                break;
            default:
                fail(`Unknown SET_CHARACTER_STAT path "${String(path)}"`);
        }

        character.lastUpdatedTurn = state.meta.turn;
        if (state.player?.identity === 'canon' && state.player.characterId === character.charId) {
            syncPlayerMirror(state);
        }
    },
});

/**
 * Apply one typed world event.
 *
 * @param {object} state
 * @param {{ type: string, [key: string]: unknown }} event
 * @param {{ registry?: object, formGroups?: object, formRules?: object }} [context]
 * @returns {object} a new state; the input is never mutated
 */
export function applyWorldEvent(state, event, context = {}) {
    if (!isObject(state)) {
        fail('applyWorldEvent requires a WorldState object');
    }
    if (!isObject(event) || typeof event.type !== 'string' || event.type.length === 0) {
        fail('World event must have a type');
    }
    const handler = HANDLERS[event.type];
    if (typeof handler !== 'function') {
        fail(`Unknown world event "${event.type}"`);
    }

    // Idempotent events can return the exact same document; this is the only
    // path where a reducer returns its input rather than a clone.
    if (
        (event.type === 'TRIGGER_ENDING'
            && state.ending?.status !== undefined
            && state.ending.status !== 'none')
        || (event.type === 'RECORD_BAD_END'
            && state.badEnds?.[event.characterId]?.continuityKey !== undefined
            && state.badEnds[event.characterId].continuityKey === badEndContinuityKey(state, event))
        || (event.type === 'SET_CLOCK_HOLD'
            && typeof event.active === 'boolean'
            && (state.flags?.clock?.hold?.active === true) === (event.active === true))
        || (event.type === 'PUBLISH_EDITION'
            && validateEdition(event.edition).ok
            && (
                (typeof event.edition.date === 'string'
                    && state.flags?.newsroom?.lastEditionDate === event.edition.date)
                || (typeof editionKey(event.edition) === 'string'
                    && Array.isArray(state.flags?.newsroom?.editions)
                    && state.flags.newsroom.editions.some(
                        (entry) => editionKey(entry) === editionKey(event.edition),
                    ))
            ))
    ) {
        return state;
    }

    const next = cloneWorldState(state);
    handler(next, event, context);
    return next;
}

/**
 * Apply a list of events in order.
 *
 * @param {object} state
 * @param {Array<object>} events
 * @param {{ registry?: object, formGroups?: object, formRules?: object }} [context]
 * @returns {object}
 */
export function applyWorldEvents(state, events, context = {}) {
    if (!Array.isArray(events)) {
        fail('applyWorldEvents requires an array of events');
    }
    return events.reduce(
        (current, event) => applyWorldEvent(current, event, context),
        state,
    );
}
