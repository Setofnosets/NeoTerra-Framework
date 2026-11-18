/**
 * Neo Terra Character Codex.
 *
 * The codex is a thin DOM client over pure view-model builders. It lists the
 * current season cast (plus manual/sandbox additions), filters by side, form,
 * location, and status, and shows a detail view with live state, full profile,
 * form lineage, relationships, bad-end records, and the "Play as" action.
 *
 * Form swaps and identity changes go through the WorldState reducer; illegal
 * swaps are rejected with the reducer's reason instead of mutating state.
 */

import { applyWorldEvent } from '../state/reducer.js';
import { buildFormIndex, isLegalTransform } from '../data/forms.js';
import { findFormSection, splitListText } from '../data/card-profile.js';
import { applyContentGate } from '../core/content-gate.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('codex-ui');

let mounted = null;

const SIDE_ORDER = Object.freeze(['hero', 'villain', 'vigilante', 'civilian', 'neutral']);
const STATUS_ORDER = Object.freeze([
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
const IDENTITY_EVENT = 'SET_PLAYER_IDENTITY';
const TRANSFORM_EVENT = 'TRANSFORM';

function hasDom() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export function escapeCodexHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function registryIndex(registry) {
    const byId = {};
    for (const entry of registry?.entries ?? []) {
        if (entry && typeof entry.id === 'string') {
            byId[entry.id] = entry;
        }
    }
    return byId;
}

function rosterIds(season) {
    return new Set(asArray(season?.roster).map((member) => member?.characterId).filter(Boolean));
}

function isSandbox(season) {
    return season?.allowAnyCharacter === true || season?.sandbox === true;
}

function resolveFormIndex({ registry, formGroups, formIndex }) {
    if (formIndex?.byGroup && formIndex?.groupByMemberId) {
        return formIndex;
    }
    return buildFormIndex(registry ?? { entries: [] }, formGroups ?? { groups: [] });
}

function findGroup(formIndex, character, entry) {
    if (formIndex?.groupByMemberId?.[character?.formId]) {
        return formIndex.groupByMemberId[character.formId];
    }
    if (character?.formGroup && formIndex?.byGroup?.[character.formGroup]) {
        return formIndex.byGroup[character.formGroup];
    }
    if (entry?.formGroup && formIndex?.byGroup?.[entry.formGroup]) {
        return formIndex.byGroup[entry.formGroup];
    }
    return null;
}

function formLabel(formIndex, formId, fallback = null) {
    if (!formId) {
        return fallback;
    }
    return formIndex?.byId?.[formId]?.displayName ?? formId;
}

function buildItem({ id, state, entry, formIndex, roster }) {
    const character = state?.characters?.[id] ?? null;
    const formId = character?.formId ?? entry?.id ?? id;
    const inRoster = roster.has(id);
    const record = state?.badEnds?.[id] ?? null;
    const displayName = character?.displayName ?? entry?.displayName ?? id;
    const side = character?.side ?? entry?.side ?? 'neutral';
    const status = character?.status ?? 'active';
    const locationId = character?.locationId ?? null;
    const locationName = locationId
        ? state?.locations?.[locationId]?.name ?? locationId
        : null;
    const formName = formLabel(formIndex, formId, entry?.displayName ?? id);
    const aliases = asArray(entry?.aliases);
    return {
        characterId: id,
        displayName,
        aliases,
        side,
        formId,
        formGroup: character?.formGroup ?? entry?.formGroup ?? null,
        formName,
        formKind: entry?.formKind ?? null,
        status,
        statusLabel: record?.type ? `${status} · ${record.type}` : status,
        locationId,
        locationName,
        alive: character ? character.alive !== false && status !== 'dead' : true,
        controlledBy: character?.controlledBy ?? 'npc',
        isPlayer: state?.player?.identity === 'canon'
            && state?.player?.characterId === id,
        nonCanon: inRoster !== true,
        hasState: Boolean(character),
        badEndType: record?.type ?? character?.badEndType ?? null,
        badEnd: record
            ? {
                type: record.type,
                severity: record.severity ?? null,
                epilogueText: record.epilogueText ?? '',
                reversed: record.reversed === true,
            }
            : null,
        searchText: [
            displayName,
            ...aliases,
            formName,
            side,
            status,
            locationName ?? '',
            ...asArray(entry?.tags),
        ].join(' ').toLowerCase(),
    };
}

function buildFacet(items, key, labelFor = (value) => value) {
    const counts = new Map();
    for (const item of items) {
        const value = item[key];
        if (value === null || value === undefined || value === '') {
            continue;
        }
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([value, count]) => ({ value, label: labelFor(value, items), count }));
}

function orderFacet(items, key, order) {
    const facet = buildFacet(items, key);
    const rank = new Map(order.map((value, index) => [value, index]));
    return facet.sort((a, b) => {
        const rankA = rank.has(a.value) ? rank.get(a.value) : order.length;
        const rankB = rank.has(b.value) ? rank.get(b.value) : order.length;
        return rankA - rankB || String(a.value).localeCompare(String(b.value));
    });
}

function matchesFilters(item, filters) {
    if (filters.query) {
        const query = String(filters.query).trim().toLowerCase();
        if (query && !item.searchText.includes(query)) {
            return false;
        }
    }
    for (const key of ['side', 'form', 'location', 'status']) {
        const value = filters[key];
        if (!value || value === 'all') {
            continue;
        }
        const actual = key === 'form'
            ? item.formId
            : key === 'location'
                ? item.locationId
                : item[key];
        if (actual !== value) {
            return false;
        }
    }
    return true;
}

function relationshipName(state, relationship, selfId) {
    const other = relationship?.a === selfId ? relationship.b : relationship.a;
    if (!other) {
        return 'Unknown';
    }
    return state?.characters?.[other]?.displayName ?? other;
}

function buildRelationships(state, characterId) {
    return asArray(state?.relationships)
        .filter((relationship) => relationship
            && (relationship.a === characterId || relationship.b === characterId))
        .map((relationship) => ({
            name: relationshipName(state, relationship, characterId),
            type: relationship.type ?? 'neutral',
            affinity: Number.isFinite(relationship.affinity) ? relationship.affinity : 0,
            tension: Number.isFinite(relationship.tension) ? relationship.tension : 0,
            notes: relationship.notes ?? '',
        }));
}

function reasonForIllegalSwap(formIndex, formRules, character, formId) {
    if (!character) {
        return 'No live state exists for this character.';
    }
    if (typeof formId !== 'string' || formId.length === 0) {
        return 'Choose a form to swap to.';
    }
    if (formId === character.formId) {
        return `"${formId}" is already active.`;
    }
    const group = findGroup(formIndex, character, null);
    const targetGroup = formIndex?.groupByMemberId?.[formId] ?? null;
    if (!targetGroup) {
        return `Unknown form "${formId}".`;
    }
    if (!group || group.id !== targetGroup.id) {
        return `"${formId}" is not in the character's form group.`;
    }
    if (!isLegalTransform(formRules, character.formId, formId)) {
        return `No declared rule from "${character.formId}" to "${formId}".`;
    }
    return null;
}

/**
 * Legal and blocked form-swap targets for one character.
 */
export function buildFormSwapOptions({
    state,
    characterId,
    formIndex = null,
    formRules = null,
}) {
    const character = state?.characters?.[characterId] ?? null;
    if (!character) {
        return { current: null, group: null, options: [], blocked: [] };
    }
    const group = findGroup(formIndex, character, null);
    if (!group) {
        return { current: character.formId ?? null, group: null, options: [], blocked: [] };
    }
    const options = [];
    const blocked = [];
    for (const member of group.members ?? []) {
        if (member.id === character.formId) {
            continue;
        }
        const view = {
            formId: member.id,
            displayName: member.displayName ?? member.id,
            legal: isLegalTransform(formRules, character.formId, member.id),
        };
        if (view.legal) {
            options.push(view);
        } else {
            blocked.push({
                ...view,
                reason: reasonForIllegalSwap(formIndex, formRules, character, member.id),
            });
        }
    }
    return {
        current: character.formId ?? null,
        group: {
            id: group.id,
            label: group.label ?? group.id,
            baseId: group.baseId ?? null,
        },
        options,
        blocked,
    };
}

function formLineage(formIndex, character, entry, formRules) {
    const group = findGroup(formIndex, character, entry);
    if (!group) {
        return {
            group: null,
            members: [],
            current: character?.formId ?? entry?.id ?? null,
            swap: buildFormSwapOptions({
                state: { characters: character ? { [character.charId]: character } : {} },
                characterId: character?.charId,
                formIndex,
                formRules,
            }),
        };
    }
    const members = (group.members ?? []).map((member) => ({
        formId: member.id,
        displayName: member.displayName ?? member.id,
        base: member.id === group.baseId,
        active: member.id === (character?.formId ?? entry?.id),
        formKind: member.formKind ?? null,
    }));
    return {
        group: {
            id: group.id,
            label: group.label ?? group.id,
            baseId: group.baseId ?? null,
        },
        members,
        current: character?.formId ?? entry?.id ?? null,
        swap: character
            ? buildFormSwapOptions({
                state: { characters: { [character.charId]: character } },
                characterId: character.charId,
                formIndex,
                formRules,
            })
            : { current: null, group: null, options: [], blocked: [] },
    };
}

/**
 * Build the Play-as candidate list.
 *
 * Outside Sandbox only the current-season roster is eligible. Sandbox accepts
 * any non-bundle registry character; a character not yet in WorldState is
 * marked `needsSeed` and is added atomically by `performPlayAs`.
 */
export function buildPlayAsOptions({
    state,
    season = null,
    registry = null,
    settings = {},
} = {}) {
    const byId = registryIndex(registry);
    const roster = rosterIds(season);
    const sandbox = isSandbox(season);
    const ids = [];
    const seen = new Set();
    const push = (id) => {
        if (typeof id === 'string' && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    };

    if (sandbox) {
        for (const entry of registry?.entries ?? []) {
            if (entry && entry.bundle !== true) {
                push(entry.id);
            }
        }
        for (const id of Object.keys(state?.characters ?? {})) {
            push(id);
        }
    } else {
        for (const member of asArray(season?.roster)) {
            push(member?.characterId);
        }
        // Manual additions are visible but non-canon; never eligible as a
        // roster replacement unless the reducer accepts the character.
        for (const id of Object.keys(state?.characters ?? {})) {
            push(id);
        }
    }

    const options = ids.map((id) => {
        const entry = byId[id] ?? null;
        const character = state?.characters?.[id] ?? null;
        const inRoster = roster.has(id);
        const isCurrent = state?.player?.identity === 'canon'
            && state?.player?.characterId === id;
        const dead = character
            ? character.alive === false || character.status === 'dead'
            : false;
        const missing = character?.status === 'missing';
        const deadRecord = state?.badEnds?.[id] ?? null;
        const deadContinuation = dead
            && settings?.badEnds?.allowDeadContinuation === true
            && Boolean(deadRecord);
        let reason = null;
        if (entry?.bundle === true) {
            reason = 'Multi-actor cards cannot be played as a single character.';
        } else if (isCurrent) {
            reason = 'Already playing as this character.';
        } else if (missing) {
            reason = 'The character is missing.';
        } else if (dead && !deadContinuation) {
            reason = 'The character is dead.';
        } else if (!sandbox && !inRoster) {
            reason = 'Only the current season roster can be selected here.';
        }
        const displayName = character?.displayName ?? entry?.displayName ?? id;
        return {
            characterId: id,
            displayName,
            side: character?.side ?? entry?.side ?? 'neutral',
            inRoster,
            nonCanon: !inRoster,
            isCurrent,
            needsSeed: !character && Boolean(entry),
            eligible: reason === null,
            reason,
        };
    });

    return {
        sandbox,
        options: options.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
}

export function buildPlayAsConfirmation({ option, state } = {}) {
    if (!option) {
        return '';
    }
    const currentName = state?.player?.identity === 'canon'
        ? state?.characters?.[state.player.characterId]?.displayName
            ?? state.player.characterId
        : 'your custom persona';
    const parts = [
        `Switch the player identity from ${currentName} to ${option.displayName}?`,
        'The narration and POV change: the narrator will treat this character as the player and stop deciding their actions, dialogue, and defeats.',
        'The previous player character returns to the NPC pool; this character is removed from NPC casting and group-chat speaker selection.',
        'This also changes the opening frame and the "Playing as" badge for this chat timeline.',
    ];
    if (option.nonCanon) {
        parts.push('This character is not on the current season roster: the world is marked non-canon and canon beats stay disabled.');
    }
    parts.push('You can switch back to a custom persona or another eligible character later from the Codex.');
    return parts.join(' ');
}

function buildCharacterStateFromEntry(entry, state, season) {
    const side = entry.side ?? 'neutral';
    return {
        charId: entry.id,
        formId: entry.id,
        formGroup: entry.formGroup ?? null,
        displayName: entry.displayName ?? entry.id,
        side,
        controlledBy: 'player',
        status: 'active',
        badEndType: null,
        locationId: state?.scene?.locationId ?? null,
        alive: true,
        threatLevel: entry.threatLevel ?? null,
        stamina: { current: 100, max: 100 },
        willpower: { current: 100, max: 100 },
        agenda: state?.playerRole === 'villain'
            ? 'Secure your rule over Neo Terra'
            : 'Write your own story in Neo Terra',
        goals: [],
        mood: 'neutral',
        allegiance: side,
        appearance: '',
        outfit: '',
        abilities: [],
        skills: [],
        traits: [],
        likes: [],
        dislikes: [],
        relationships: [],
        corruption: { stage: 0, source: null, progress: 0 },
        lastUpdatedTurn: state?.meta?.turn ?? 0,
        notes: '',
    };
}

/**
 * Live state wins when it holds a value; otherwise the card text is shown.
 */
function liveText(value, card) {
    const live = typeof value === 'string' ? value : '';
    if (live.trim().length > 0) {
        return live;
    }
    return typeof card === 'string' ? card : '';
}

/**
 * Live lists win when non-empty; otherwise the card body is split tolerantly.
 */
function liveList(value, card) {
    if (Array.isArray(value) && value.length > 0) {
        return value;
    }
    if (Array.isArray(card)) {
        return card.slice();
    }
    return splitListText(card);
}

function gateField(text, settings, context) {
    return applyContentGate(
        typeof text === 'string' ? text : '',
        settings?.contentGate ?? 'full',
        settings?.contentLimits ?? {},
        context,
    );
}

function gateList(values, settings, context) {
    return asArray(values)
        .map((value) => gateField(value, settings, context))
        .filter((value) => value.trim().length > 0);
}

/**
 * Apply the content gate to one card profile at render time.
 *
 * The stored profile is never mutated: changing `contentGate` or a hard limit
 * re-gates the same parsed text on the next render.
 */
export function gateCardProfile(card, { settings = {}, characterId = null, isPlayer = false } = {}) {
    if (!card || typeof card !== 'object') {
        return null;
    }
    const context = { characterId, isPlayer };
    const text = (value) => gateField(value, settings, context);
    const forms = {};
    for (const [name, body] of Object.entries(card.forms ?? {})) {
        const gated = text(body);
        if (gated.trim().length > 0) {
            forms[name] = gated;
        }
    }
    const actors = asArray(card.actors)
        .map((actor) => gateCardProfile(actor, { settings, characterId, isPlayer }))
        .filter(Boolean);
    return {
        ...card,
        appearance: text(card.appearance),
        attire: text(card.attire),
        abilities: text(card.abilities),
        personality: text(card.personality),
        speech: text(card.speech),
        background: text(card.background),
        gender: text(card.gender),
        species: text(card.species),
        occupation: text(card.occupation),
        faction: text(card.faction),
        identity: text(card.identity),
        combatStyle: text(card.combatStyle),
        gear: text(card.gear),
        weakness: text(card.weakness),
        likes: gateList(card.likes, settings, context),
        dislikes: gateList(card.dislikes, settings, context),
        goals: gateList(card.goals, settings, context),
        sensitive: asArray(card.sensitive)
            .map((section) => ({
                label: section?.label ?? '',
                text: text(section?.text),
            }))
            .filter((section) => section.text.trim().length > 0),
        extras: asArray(card.extras)
            .map((section) => ({
                label: section?.label ?? '',
                text: text(section?.text),
            }))
            .filter((section) => section.text.trim().length > 0),
        forms,
        ...(card.actors ? { actors } : {}),
    };
}

function listLikeCardTraits(profile) {
    const items = splitListText(profile?.personality || profile?.speech);
    return items.length >= 2 ? items : [];
}

/**
 * Merge one card profile into a live character, filling only empty fields.
 *
 * Raw card text is stored (no content gate): the codex gates at render time and
 * the prompt renderer gates again, so changing the setting later still works.
 *
 * @returns {{ character: object, changed: boolean }}
 */
export function mergeCardProfileIntoCharacter(character, profile) {
    if (!character || !profile || profile.actors) {
        return { character, changed: false };
    }
    const next = { ...character };
    let changed = false;

    const setText = (field, value) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return;
        }
        const current = typeof next[field] === 'string' ? next[field] : '';
        if (current.trim().length === 0) {
            next[field] = value;
            changed = true;
        }
    };
    const setList = (field, values) => {
        if (!Array.isArray(values) || values.length === 0) {
            return;
        }
        if (!Array.isArray(next[field]) || next[field].length === 0) {
            next[field] = values.slice();
            changed = true;
        }
    };

    setText('appearance', profile.appearance);
    setText('outfit', profile.attire);
    setText('notes', profile.background);
    setList('abilities', splitListText(profile.abilities));
    setList('likes', profile.likes);
    setList('dislikes', profile.dislikes);
    setList('goals', profile.goals);
    setList('traits', listLikeCardTraits(profile));

    return { character: changed ? next : character, changed };
}

/**
 * Fill missing character fields for the supplied ids from the card profiles.
 * Idempotent: a second call with the same state reports no change.
 */
export function backfillCardProfiles({ state, ids = null, profiles = null } = {}) {
    if (!state || !profiles || typeof profiles !== 'object') {
        return { state, changed: false, updated: [] };
    }
    const targetIds = Array.isArray(ids) ? ids : Object.keys(state.characters ?? {});
    const characters = { ...(state.characters ?? {}) };
    const updated = [];

    for (const id of targetIds) {
        const character = characters[id];
        if (!character) {
            continue;
        }
        // Match the Codex display key (the state/roster id), not the current
        // form: an imported profile must be the one the panel shows.
        const profile = profiles[id] ?? null;
        const result = mergeCardProfileIntoCharacter(character, profile);
        if (result.changed) {
            characters[id] = result.character;
            updated.push(id);
        }
    }

    if (updated.length === 0) {
        return { state, changed: false, updated: [] };
    }
    return {
        state: { ...state, characters },
        changed: true,
        updated,
    };
}

function buildDetail({
    state,
    season,
    registry,
    formIndex,
    formRules,
    profiles,
    settings,
    selectedId,
    playAs,
}) {
    if (!selectedId) {
        return null;
    }
    const entry = registryIndex(registry)[selectedId] ?? null;
    const character = state?.characters?.[selectedId] ?? null;
    if (!entry && !character) {
        return null;
    }
    const roster = rosterIds(season);
    const record = state?.badEnds?.[selectedId] ?? null;
    const playAsOption = playAs.options.find((option) => option.characterId === selectedId)
        ?? null;
    const swap = character
        ? buildFormSwapOptions({
            state,
            characterId: selectedId,
            formIndex,
            formRules,
        })
        : { current: null, group: null, options: [], blocked: [] };

    const stamina = character?.stamina ?? {};
    const willpower = character?.willpower ?? {};
    const staminaMax = Number.isFinite(stamina.max) && stamina.max > 0 ? stamina.max : 100;
    const willpowerMax = Number.isFinite(willpower.max) && willpower.max > 0 ? willpower.max : 100;
    const isPlayer = state?.player?.identity === 'canon'
        && state?.player?.characterId === selectedId;
    const card = gateCardProfile(profiles?.[selectedId] ?? null, {
        settings,
        characterId: selectedId,
        isPlayer,
    });
    const gateContext = { characterId: selectedId, isPlayer };
    const gateValue = (value) => gateField(value, settings, gateContext);

    return {
        characterId: selectedId,
        displayName: character?.displayName ?? entry?.displayName ?? selectedId,
        side: character?.side ?? entry?.side ?? 'neutral',
        status: character?.status ?? 'active',
        alive: character ? character.alive !== false && character.status !== 'dead' : true,
        isPlayer,
        nonCanon: !roster.has(selectedId),
        locationId: character?.locationId ?? null,
        locationName: character?.locationId
            ? state?.locations?.[character.locationId]?.name ?? character.locationId
            : null,
        threatLevel: character?.threatLevel ?? entry?.threatLevel ?? null,
        resource: {
            stamina: {
                current: Number.isFinite(stamina.current) ? clamp(stamina.current, 0, staminaMax) : 0,
                max: staminaMax,
            },
            willpower: {
                current: Number.isFinite(willpower.current) ? clamp(willpower.current, 0, willpowerMax) : 0,
                max: willpowerMax,
            },
        },
        form: {
            id: character?.formId ?? entry?.id ?? null,
            group: character?.formGroup ?? entry?.formGroup ?? null,
            label: formLabel(formIndex, character?.formId ?? entry?.id, selectedId),
        },
        lineage: formLineage(formIndex, character, entry, formRules),
        swap,
        corruption: {
            stage: Number(character?.corruption?.stage ?? 0),
            progress: clamp(Number(character?.corruption?.progress ?? 0), 0, 100),
            source: character?.corruption?.source ?? null,
        },
        profile: {
            aliases: asArray(entry?.aliases),
            tags: asArray(entry?.tags),
            formKind: entry?.formKind ?? null,
            formRole: entry?.formRole ?? null,
            cardPath: entry?.cardPath ?? entry?.file ?? null,
            mood: character?.mood ?? '',
            allegiance: character?.allegiance ?? '',
            agenda: character?.agenda ?? '',
            // Live and card values both pass the gate: imported/seeded card text
            // is stored raw, so the render layer is the single policy point.
            goals: gateList(liveList(character?.goals, card?.goals), settings, gateContext),
            appearance: gateValue(liveText(character?.appearance, card?.appearance)),
            outfit: gateValue(liveText(character?.outfit, card?.attire)),
            abilities: gateList(liveList(character?.abilities, card?.abilities), settings, gateContext),
            skills: gateList(asArray(character?.skills), settings, gateContext),
            traits: gateList(asArray(character?.traits), settings, gateContext),
            likes: gateList(liveList(character?.likes, card?.likes), settings, gateContext),
            dislikes: gateList(liveList(character?.dislikes, card?.dislikes), settings, gateContext),
            notes: gateValue(character?.notes ?? ''),
            // Live-only values let the renderer avoid repeating seeded card text.
            liveAppearance: gateValue(typeof character?.appearance === 'string' ? character.appearance : ''),
            liveOutfit: gateValue(typeof character?.outfit === 'string' ? character.outfit : ''),
            liveNotes: gateValue(character?.notes ?? ''),
            liveGoals: gateList(asArray(character?.goals), settings, gateContext),
            liveAbilities: gateList(asArray(character?.abilities), settings, gateContext),
            liveLikes: gateList(asArray(character?.likes), settings, gateContext),
            liveDislikes: gateList(asArray(character?.dislikes), settings, gateContext),
            gender: card?.gender ?? '',
            species: card?.species ?? '',
            identity: card?.identity ?? '',
            speech: card?.speech ?? '',
            personality: card?.personality ?? '',
            background: card?.background ?? '',
            combatStyle: card?.combatStyle ?? '',
            gear: card?.gear ?? '',
            weakness: card?.weakness ?? '',
            sensitive: card?.sensitive ?? [],
            extras: card?.extras ?? [],
            forms: card?.forms ?? {},
            card,
        },
        relationships: character ? buildRelationships(state, selectedId) : [],
        badEnd: record
            ? {
                type: record.type,
                severity: record.severity ?? null,
                cause: record.cause ?? '',
                turn: record.turn ?? null,
                date: record.date ?? null,
                epilogueText: record.epilogueText ?? '',
                playableAs: record.playableAs === true,
                reversed: record.reversed === true,
                continuityKey: record.continuityKey ?? null,
            }
            : null,
        playAs: playAsOption
            ? {
                eligible: playAsOption.eligible,
                reason: playAsOption.reason,
                confirmation: buildPlayAsConfirmation({ option: playAsOption, state }),
            }
            : null,
    };
}

/**
 * Pure codex view model.
 */
export function buildCodexView({
    state = null,
    season = null,
    registry = null,
    formGroups = null,
    formRules = null,
    formIndex = null,
    profiles = null,
    settings = {},
    filters = {},
    selectedId = null,
} = {}) {
    const index = resolveFormIndex({ registry, formGroups, formIndex });
    const byId = registryIndex(registry);
    const roster = rosterIds(season);
    const sandbox = isSandbox(season);
    const ids = [];
    const seen = new Set();
    const push = (id) => {
        if (typeof id === 'string' && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    };

    if (sandbox) {
        for (const id of Object.keys(state?.characters ?? {})) {
            push(id);
        }
        for (const entry of registry?.entries ?? []) {
            if (entry && entry.bundle !== true) {
                push(entry.id);
            }
        }
    } else {
        for (const member of asArray(season?.roster)) {
            push(member?.characterId);
        }
        for (const id of Object.keys(state?.characters ?? {})) {
            push(id);
        }
    }

    const items = ids.map((id) => buildItem({
        id,
        state,
        entry: byId[id] ?? null,
        formIndex: index,
        roster,
    }));

    const normalizedFilters = {
        query: String(filters.query ?? ''),
        side: filters.side ?? 'all',
        form: filters.form ?? 'all',
        location: filters.location ?? 'all',
        status: filters.status ?? 'all',
    };
    const filtered = items.filter((item) => matchesFilters(item, normalizedFilters));
    const playAs = buildPlayAsOptions({ state, season, registry, settings });
    const effectiveSelected = selectedId && items.some((item) => item.characterId === selectedId)
        ? selectedId
        : filtered[0]?.characterId ?? items[0]?.characterId ?? null;

    return {
        seasonId: season?.id ?? state?.seasonId ?? null,
        seasonTitle: season?.title ?? null,
        sandbox,
        hasProfiles: Boolean(profiles && Object.keys(profiles).length > 0),
        player: {
            identity: state?.player?.identity ?? 'custom',
            characterId: state?.player?.characterId ?? null,
            displayName: state?.player?.identity === 'canon'
                ? state?.characters?.[state.player.characterId]?.displayName
                    ?? state.player.characterId
                : state?.player?.displayName ?? 'The Player',
            nonCanon: state?.flags?.nonCanon === true,
        },
        filters: normalizedFilters,
        facets: {
            sides: orderFacet(items, 'side', SIDE_ORDER),
            forms: buildFacet(items, 'formId', (value) => formLabel(index, value, value)),
            locations: buildFacet(items, 'locationId', (value, list) => (
                list.find((item) => item.locationId === value)?.locationName ?? value
            )),
            statuses: orderFacet(items, 'status', STATUS_ORDER),
        },
        items,
        filtered,
        total: items.length,
        selectedId: effectiveSelected,
        selected: buildDetail({
            state,
            season,
            registry,
            formIndex: index,
            formRules,
            profiles,
            settings,
            selectedId: effectiveSelected,
            playAs,
        }),
        playAs,
    };
}

/* ------------------------------------------------------------------ */
/* Reducer dispatch helpers                                            */
/* ------------------------------------------------------------------ */

function dispatchWithContext(store, event, context) {
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('A WorldState store is required');
    }
    if (context && (context.registry || context.formGroups || context.formRules)) {
        const next = applyWorldEvent(store.get(), event, context);
        return store.replace(next);
    }
    return store.dispatch(event);
}

/** Validate and apply a declared form transition. Throws on an illegal swap. */
export function performFormSwap({
    store,
    context = null,
    characterId,
    formId,
    formIndex = null,
    formRules = null,
}) {
    const state = store?.get?.();
    const character = state?.characters?.[characterId] ?? null;
    const index = formIndex ?? resolveFormIndex({
        registry: context?.registry,
        formGroups: context?.formGroups,
    });
    const rules = formRules ?? context?.formRules ?? null;
    const reason = reasonForIllegalSwap(index, rules, character, formId);
    if (reason) {
        throw new Error(reason);
    }
    return dispatchWithContext(store, {
        type: TRANSFORM_EVENT,
        characterId,
        formId,
    }, {
        ...(context ?? {}),
        // The reducer accepts either raw groups or a resolved form index.
        formGroups: context?.formGroups
            ?? (formIndex?.byGroup && formIndex?.groupByMemberId ? formIndex : null),
        formRules: rules,
    });
}

/** Switch the player identity, seeding a Sandbox registry character if needed. */
export function performPlayAs({
    store,
    context = null,
    season = null,
    registry = null,
    settings = {},
    characterId,
}) {
    const state = store?.get?.();
    const byId = registryIndex(registry);
    const entry = byId[characterId] ?? null;
    const roster = rosterIds(season);
    const sandbox = isSandbox(season);
    const option = buildPlayAsOptions({ state, season, registry, settings })
        .options.find((candidate) => candidate.characterId === characterId);
    if (!option) {
        throw new Error(`Unknown or ineligible character "${String(characterId)}"`);
    }
    if (!option.eligible) {
        throw new Error(option.reason ?? `Cannot play as "${characterId}"`);
    }
    if (!sandbox && !roster.has(characterId)) {
        throw new Error(`"${characterId}" is not on the current season roster`);
    }
    const character = !state.characters?.[characterId] && entry
        ? buildCharacterStateFromEntry(entry, state, season)
        : undefined;
    return dispatchWithContext(store, {
        type: IDENTITY_EVENT,
        identity: 'canon',
        characterId,
        nonCanon: !roster.has(characterId),
        allowDeadContinuation: settings?.badEnds?.allowDeadContinuation === true,
        ...(character ? { character } : {}),
    }, context);
}

/** Return to a custom persona (reversible identity change). */
export function performPlayAsCustom({
    store,
    context = null,
    displayName = 'The Player',
    personaNotes = '',
}) {
    return dispatchWithContext(store, {
        type: IDENTITY_EVENT,
        identity: 'custom',
        displayName,
        personaNotes,
        nonCanon: false,
    }, context);
}

/* ------------------------------------------------------------------ */
/* Markup                                                              */
/* ------------------------------------------------------------------ */

function filterSelect(name, label, facet, current) {
    const options = facet.map((entry) => (
        `<option value="${escapeCodexHtml(entry.value)}" ${entry.value === current ? 'selected' : ''}>${escapeCodexHtml(entry.label)} (${entry.count})</option>`
    )).join('');
    return `<label class="neoterra-field neoterra-codex-filter">
        <span>${escapeCodexHtml(label)}</span>
        <select data-neoterra-codex-filter="${escapeCodexHtml(name)}">
            <option value="all" ${current === 'all' ? 'selected' : ''}>All</option>
            ${options}
        </select>
    </label>`;
}

function resourceMarkup(label, resource) {
    const percent = Math.round((resource.current / resource.max) * 100);
    return `<div class="neoterra-codex-resource">
        <div class="neoterra-codex-resource-head"><span>${escapeCodexHtml(label)}</span><span>${resource.current}/${resource.max}</span></div>
        <div class="neoterra-codex-meter" role="meter" aria-valuemin="0" aria-valuemax="${resource.max}"
            aria-valuenow="${resource.current}" aria-label="${escapeCodexHtml(label)}">
            <span class="neoterra-codex-meter-fill" style="width:${percent}%"></span>
        </div>
    </div>`;
}

function listMarkup(values, empty = 'None') {
    if (values.length === 0) {
        return `<p class="neoterra-empty">${escapeCodexHtml(empty)}</p>`;
    }
    // A single long body is prose, not a one-line bullet.
    if (values.length === 1 && values[0].length > 200) {
        return `<p class="neoterra-codex-card-text">${escapeCodexHtml(values[0])}</p>`;
    }
    return `<ul class="neoterra-codex-list-inline">${values.map((value) => (
        `<li>${escapeCodexHtml(value)}</li>`
    )).join('')}</ul>`;
}

function badge(text, tone = 'default') {
    return `<span class="neoterra-badge neoterra-badge-${escapeCodexHtml(tone)}">${escapeCodexHtml(text)}</span>`;
}

function renderItem(item, view) {
    const active = item.characterId === view.selectedId;
    const badges = [
        item.isPlayer ? badge('Playing as', 'accent') : '',
        item.nonCanon ? badge('Non-canon', 'warning') : '',
        item.badEnd ? badge(item.badEnd.type, 'danger') : '',
        item.controlledBy === 'player' && !item.isPlayer ? badge('Player-controlled', 'accent') : '',
    ].join('');
    return `<button type="button" class="neoterra-codex-card${active ? ' is-active' : ''}"
        data-neoterra-codex-select="${escapeCodexHtml(item.characterId)}"
        aria-current="${active ? 'true' : 'false'}">
        <span class="neoterra-codex-card-name">${escapeCodexHtml(item.displayName)}</span>
        <span class="neoterra-codex-card-meta">${escapeCodexHtml(item.side)} · ${escapeCodexHtml(item.formName)}</span>
        <span class="neoterra-codex-card-meta">${escapeCodexHtml(item.statusLabel)}${item.locationName ? ` · ${escapeCodexHtml(item.locationName)}` : ''}</span>
        ${badges ? `<span class="neoterra-codex-card-badges">${badges}</span>` : ''}
    </button>`;
}

function renderLineage(detail) {
    const lineage = detail.lineage;
    if (!lineage?.group) {
        return '<p class="neoterra-empty">No alternate forms are declared for this character.</p>';
    }
    const members = lineage.members.map((member) => `
        <li class="${member.active ? 'is-active' : ''}">
            <span>${escapeCodexHtml(member.displayName)}</span>
            ${member.base ? badge('Base') : ''}
            ${member.active ? badge('Active', 'accent') : ''}
        </li>`).join('');
    const options = lineage.swap?.options ?? [];
    const blocked = lineage.swap?.blocked ?? [];
    const swapControl = detail.isPlayer || detail.alive
        ? (options.length > 0
            ? `<div class="neoterra-codex-swap">
                <label class="neoterra-field">
                    <span>Swap active form (declared rules only)</span>
                    <select data-neoterra-form-swap-target>
                        ${options.map((option) => (
                            `<option value="${escapeCodexHtml(option.formId)}">${escapeCodexHtml(option.displayName)}</option>`
                        )).join('')}
                    </select>
                </label>
                <button type="button" class="menu_button neoterra-primary" data-neoterra-form-swap>Swap form</button>
            </div>`
            : '<p class="neoterra-empty">No legal form swaps are currently declared.</p>')
        : '<p class="neoterra-empty">This character cannot change form in their current state.</p>';
    const blockedMarkup = blocked.length > 0
        ? `<details class="neoterra-codex-blocked"><summary>Blocked forms (${blocked.length})</summary>
            <ul>${blocked.map((entry) => (
                `<li><span>${escapeCodexHtml(entry.displayName)}</span>: ${escapeCodexHtml(entry.reason)}</li>`
            )).join('')}</ul></details>`
        : '';
    return `<div class="neoterra-codex-lineage">
        <p class="neoterra-hint">Form group: ${escapeCodexHtml(lineage.group.label)}</p>
        <ul class="neoterra-codex-form-list">${members}</ul>
        ${swapControl}
        ${blockedMarkup}
    </div>`;
}

function cardParagraph(label, text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }
    return `<p class="neoterra-codex-card-text"><strong>${escapeCodexHtml(label)}:</strong> ${escapeCodexHtml(text)}</p>`;
}

function cardRow(label, text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }
    return `<div class="neoterra-codex-card-row">
        <span>${escapeCodexHtml(label)}</span>
        <p>${escapeCodexHtml(text)}</p>
    </div>`;
}

function sameList(left, right) {
    return JSON.stringify(asArray(left)) === JSON.stringify(asArray(right));
}

function renderCardProfile(card, detail) {
    if (!card) {
        return '';
    }
    const live = detail.profile;
    const paragraphs = [
        card.appearance !== live.liveAppearance
            ? cardParagraph('Appearance', card.appearance)
            : '',
        card.attire !== live.liveOutfit ? cardParagraph('Attire', card.attire) : '',
        cardParagraph('Personality', card.personality),
        cardParagraph('Speech', card.speech),
        card.background !== live.liveNotes ? cardParagraph('Background', card.background) : '',
    ].join('');

    const lists = [
        ['Likes', card.likes, live.liveLikes],
        ['Dislikes', card.dislikes, live.liveDislikes],
        ['Goals', card.goals, live.liveGoals],
    ].map(([label, values, liveValues]) => (values.length > 0 && !sameList(values, liveValues)
        ? `<section class="neoterra-codex-profile-block">
            <h6>${escapeCodexHtml(label)}</h6>
            ${listMarkup(values)}
        </section>`
        : '')).join('');

    const canonicalRows = [
        ['Identity', card.identity],
        ['Occupation', card.occupation],
        ['Faction', card.faction],
        ['Combat style', card.combatStyle],
        ['Gear', card.gear],
        ['Weakness', card.weakness],
    ].map(([label, value]) => cardRow(label, value)).join('');
    const extras = asArray(card.extras).map((entry) => cardRow(entry.label, entry.text)).join('');
    const sensitive = asArray(card.sensitive).map((entry) => cardRow(entry.label, entry.text)).join('');
    const formBody = findFormSection(card, detail.form?.label);
    const actorProfiles = asArray(card.actors).slice(1).map((actor) => `
        <details class="neoterra-codex-card-actor">
            <summary>${escapeCodexHtml(actor.name || 'Actor')}</summary>
            ${cardParagraph('Appearance', actor.appearance)}
            ${cardParagraph('Personality', actor.personality)}
            ${cardParagraph('Background', actor.background)}
        </details>`).join('');
    const actorNames = asArray(card.actors).map((actor) => actor.name).filter(Boolean);

    return `<section class="neoterra-codex-section neoterra-codex-card-profile" data-neoterra-codex-card-profile>
        <div class="neoterra-codex-card-profile-head">
            <h5>From the character card</h5>
            <button type="button" class="menu_button" data-neoterra-import-profile="${escapeCodexHtml(detail.characterId)}">Import card profile</button>
        </div>
        ${actorNames.length > 1 ? `<p class="neoterra-hint">Multi-actor card: ${escapeCodexHtml(actorNames.join(' & '))}</p>` : ''}
        ${paragraphs}
        ${lists}
        ${canonicalRows ? `<div class="neoterra-codex-card-rows">${canonicalRows}</div>` : ''}
        ${extras ? `<h6>Other card notes</h6><div class="neoterra-codex-card-rows">${extras}</div>` : ''}
        ${formBody ? `<section class="neoterra-codex-form-notes" data-neoterra-codex-form-notes>
            <h6>Form notes: ${escapeCodexHtml(detail.form?.label ?? 'current form')}</h6>
            ${cardParagraph('Transformation', formBody)}
        </section>` : ''}
        ${actorProfiles}
        ${sensitive ? `<section class="neoterra-codex-sensitive" data-neoterra-codex-sensitive>
            <h6>Sensitive</h6>
            <div class="neoterra-codex-card-rows">${sensitive}</div>
        </section>` : ''}
    </section>`;
}

function renderDetail(detail, state) {
    if (!detail) {
        return '<p class="neoterra-empty">Select a character to see their codex entry.</p>';
    }
    const profile = detail.profile;
    const identityLine = [profile.gender, profile.species].filter(Boolean).join(' · ');
    const badges = [
        badge(detail.side, detail.side === 'villain' ? 'danger' : 'accent'),
        badge(detail.status),
        detail.isPlayer ? badge('Playing as', 'accent') : '',
        detail.nonCanon ? badge('Non-canon', 'warning') : '',
        detail.badEnd ? badge(`Bad end: ${detail.badEnd.type}`, 'danger') : '',
    ].join('');
    const playAsButton = detail.isPlayer
        ? '<p class="neoterra-codex-playing">You are playing as this character.</p>'
        : (detail.playAs?.eligible
            ? `<button type="button" class="menu_button neoterra-primary" data-neoterra-play-as="${escapeCodexHtml(detail.characterId)}">Play as ${escapeCodexHtml(detail.displayName)}</button>`
            : `<p class="neoterra-hint">Play as unavailable: ${escapeCodexHtml(detail.playAs?.reason ?? 'not eligible')}</p>`);
    const badEndMarkup = detail.badEnd
        ? `<section class="neoterra-codex-bad-end" data-neoterra-codex-bad-end="${escapeCodexHtml(detail.badEnd.type)}">
            <h5>Bad end: ${escapeCodexHtml(detail.badEnd.type)}</h5>
            <p class="neoterra-hint">Severity ${escapeCodexHtml(detail.badEnd.severity ?? 'unknown')}${detail.badEnd.reversed ? ' · reversed' : ''}${detail.badEnd.continuityKey ? ` · ${escapeCodexHtml(detail.badEnd.continuityKey)}` : ''}</p>
            ${detail.badEnd.cause ? `<p>${escapeCodexHtml(detail.badEnd.cause)}</p>` : ''}
            <div class="neoterra-codex-epilogue" data-neoterra-codex-epilogue aria-readonly="true">${escapeCodexHtml(detail.badEnd.epilogueText || 'No epilogue was stored.')}</div>
        </section>`
        : '';
    const relationships = detail.relationships.length > 0
        ? `<ul class="neoterra-codex-relationships">${detail.relationships.map((relationship) => `
            <li>
                <span class="neoterra-codex-rel-name">${escapeCodexHtml(relationship.name)}</span>
                <span class="neoterra-codex-rel-type">${escapeCodexHtml(relationship.type)}</span>
                <span class="neoterra-hint">affinity ${relationship.affinity}; tension ${relationship.tension}</span>
                ${relationship.notes ? `<span class="neoterra-hint">${escapeCodexHtml(relationship.notes)}</span>` : ''}
            </li>`).join('')}</ul>`
        : '<p class="neoterra-empty">No tracked relationships.</p>';
    const profileList = (label, values, empty = 'None') => `
        <section class="neoterra-codex-profile-block">
            <h6>${escapeCodexHtml(label)}</h6>
            ${listMarkup(values, empty)}
        </section>`;

    return `<article class="neoterra-codex-detail" data-neoterra-codex-detail="${escapeCodexHtml(detail.characterId)}">
        <header class="neoterra-codex-detail-head">
            <div>
                <h4>${escapeCodexHtml(detail.displayName)}</h4>
                <p class="neoterra-hint">${escapeCodexHtml(detail.form.label)}${identityLine ? ` · ${escapeCodexHtml(identityLine)}` : ''}${detail.locationName ? ` · ${escapeCodexHtml(detail.locationName)}` : ''}${detail.threatLevel ? ` · threat ${escapeCodexHtml(detail.threatLevel)}` : ''}</p>
            </div>
            <div class="neoterra-codex-badges">${badges}</div>
        </header>

        ${detail.nonCanon ? '<p class="neoterra-warning" role="alert">Non-canon character: this timeline is outside the season roster, so canon beats stay disabled.</p>' : ''}

        <div class="neoterra-codex-status-grid">
            <section class="neoterra-codex-section">
                <h5>Live state</h5>
                ${resourceMarkup('Stamina', detail.resource.stamina)}
                ${resourceMarkup('Willpower', detail.resource.willpower)}
                <p class="neoterra-hint">Alive: ${detail.alive ? 'yes' : 'no'} · Controlled by ${escapeCodexHtml(detail.isPlayer ? 'player' : 'NPC')}</p>
            </section>
            <section class="neoterra-codex-section">
                <h5>Corruption</h5>
                <p>Stage ${detail.corruption.stage} — ${detail.corruption.progress}%</p>
                <p class="neoterra-hint">Source: ${escapeCodexHtml(detail.corruption.source ?? 'none')}</p>
            </section>
            <section class="neoterra-codex-section">
                <h5>Agenda</h5>
                <p>${escapeCodexHtml(profile.agenda || 'No agenda recorded.')}</p>
                <p class="neoterra-hint">Mood ${escapeCodexHtml(profile.mood || 'unknown')} · Allegiance ${escapeCodexHtml(profile.allegiance || 'neutral')}</p>
            </section>
            <section class="neoterra-codex-section">
                <h5>Identity</h5>
                <p>${escapeCodexHtml(detail.isPlayer ? 'Playing as this character' : (detail.playAs?.eligible ? 'Eligible to play as' : 'NPC'))}</p>
                ${playAsButton}
                ${detail.isPlayer ? '<button type="button" class="menu_button" data-neoterra-play-as-custom>Return to custom persona</button>' : ''}
            </section>
        </div>

        ${badEndMarkup}

        <section class="neoterra-codex-section">
            <h5>Form lineage</h5>
            ${renderLineage(detail)}
        </section>

        <div class="neoterra-codex-profile-grid">
            ${profileList('Aliases', profile.aliases)}
            ${profileList('Tags', profile.tags)}
            ${profileList('Goals', profile.goals)}
            ${profileList('Abilities', profile.abilities)}
            ${profileList('Skills', profile.skills)}
            ${profileList('Traits', profile.traits)}
            ${profileList('Likes', profile.likes)}
            ${profileList('Dislikes', profile.dislikes)}
        </div>

        <section class="neoterra-codex-section">
            <h5>Profile</h5>
            <p>${escapeCodexHtml(profile.liveAppearance || 'No appearance recorded.')}</p>
            <p class="neoterra-hint">Outfit: ${escapeCodexHtml(profile.liveOutfit || 'none recorded')}</p>
            <p class="neoterra-hint">Form kind: ${escapeCodexHtml(profile.formKind ?? 'unknown')} · Role: ${escapeCodexHtml(profile.formRole ?? 'unknown')}</p>
            <p class="neoterra-hint">Card: ${escapeCodexHtml(profile.cardPath ?? 'not linked')}</p>
            ${profile.liveNotes ? `<p>${escapeCodexHtml(profile.liveNotes)}</p>` : ''}
        </section>

        ${renderCardProfile(profile.card, detail)}

        <section class="neoterra-codex-section">
            <h5>Relationships</h5>
            ${relationships}
        </section>
    </article>`;
}

export function renderPlayAsDialog({ detail, mode = 'canon' }) {
    if (!detail) {
        return '';
    }
    const isCustom = mode === 'custom';
    const title = isCustom ? 'Return to a custom persona' : `Play as ${detail.displayName}`;
    const body = isCustom
        ? 'Switch back to a custom persona? The canon character returns to the NPC pool, the narrator stops treating them as the player, and the "Playing as" badge is cleared.'
        : detail.playAs?.confirmation ?? '';
    return `<div class="neoterra-dialog-backdrop" data-neoterra-codex-dialog-close></div>
        <section class="neoterra-dialog" role="dialog" aria-modal="true" aria-labelledby="neoterra-codex-dialog-title"
            data-neoterra-codex-dialog="${escapeCodexHtml(mode)}" tabindex="-1">
            <h4 id="neoterra-codex-dialog-title">${escapeCodexHtml(title)}</h4>
            <p>${escapeCodexHtml(body)}</p>
            <div class="neoterra-dialog-actions">
                <button type="button" class="menu_button" data-neoterra-codex-dialog-close>Cancel</button>
                <button type="button" class="menu_button neoterra-primary" data-neoterra-codex-dialog-confirm>Confirm</button>
            </div>
        </section>`;
}

export function renderCodexMarkup(view) {
    if (!view || view.total === 0) {
        return `<section class="neoterra-codex" data-neoterra-codex>
            <p class="neoterra-empty">No character world is active in this chat. Start a season to build the codex.</p>
        </section>`;
    }
    const filters = view.filters;
    return `<section class="neoterra-codex" data-neoterra-codex data-codex-season="${escapeCodexHtml(view.seasonId ?? '')}">
        <header class="neoterra-codex-head">
            <div>
                <h4>Character Codex</h4>
                <p class="neoterra-hint">${escapeCodexHtml(view.seasonTitle ?? view.seasonId ?? 'Neo Terra')} · ${view.filtered.length}/${view.total} characters${view.sandbox ? ' · Sandbox' : ''}</p>
            </div>
            <div class="neoterra-codex-head-actions">
                <p class="neoterra-codex-playing">Playing as <strong>${escapeCodexHtml(view.player.displayName)}</strong>${view.player.nonCanon ? ' (non-canon)' : ''}</p>
                ${view.hasProfiles ? '<button type="button" class="menu_button" data-neoterra-sync-profiles>Sync card profiles</button>' : ''}
            </div>
        </header>
        <div class="neoterra-codex-filters">
            <label class="neoterra-field neoterra-codex-search">
                <span>Search</span>
                <input type="search" data-neoterra-codex-search value="${escapeCodexHtml(filters.query)}"
                    placeholder="Name, alias, form, tag…">
            </label>
            ${filterSelect('side', 'Side', view.facets.sides, filters.side)}
            ${filterSelect('form', 'Form', view.facets.forms, filters.form)}
            ${filterSelect('location', 'Location', view.facets.locations, filters.location)}
            ${filterSelect('status', 'Status', view.facets.statuses, filters.status)}
        </div>
        <div class="neoterra-codex-layout">
            <div class="neoterra-codex-list">
                ${view.filtered.length > 0
                    ? view.filtered.map((item) => renderItem(item, view)).join('')
                    : '<p class="neoterra-empty">No characters match these filters.</p>'}
            </div>
            <div class="neoterra-codex-detail-host">
                ${renderDetail(view.selected, view)}
            </div>
        </div>
        <div class="neoterra-codex-dialog-host" data-neoterra-codex-dialog-host></div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

function focusableWithin(root) {
    return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.disabled && element.offsetParent !== null);
}

function trapDialogFocus(event, root) {
    if (event.key === 'Escape') {
        event.preventDefault();
        return 'close';
    }
    if (event.key !== 'Tab') {
        return null;
    }
    const dialog = root.querySelector('[data-neoterra-codex-dialog]');
    if (!dialog) {
        return null;
    }
    const focusable = focusableWithin(dialog);
    if (focusable.length === 0) {
        return 'trap';
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return 'trap';
    }
    if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
        return 'trap';
    }
    return null;
}

/**
 * Mount the codex into the Characters tab.
 *
 * `root` is a container element, `store` a WorldState store. The optional
 * `onIdentityChange` callback receives the new state and identity metadata so
 * the shell can persist `chatMetadata` and refresh other panels.
 */
export function mountCodex({
    root,
    store,
    season = null,
    registry = null,
    formGroups = null,
    formRules = null,
    profiles = null,
    getSettings = () => ({}),
    onIdentityChange = null,
    onWorldChange = null,
} = {}) {
    if (!hasDom()) {
        return null;
    }
    if (!root) {
        throw new TypeError('mountCodex requires a root element');
    }
    if (!store || typeof store.get !== 'function') {
        throw new TypeError('mountCodex requires a WorldState store');
    }
    disposeCodex();
    const controller = new AbortController();
    const state = {
        root,
        store,
        season,
        registry,
        formGroups,
        formRules,
        profiles,
        formIndex: resolveFormIndex({ registry, formGroups }),
        getSettings,
        onIdentityChange,
        onWorldChange,
        controller,
        returnFocus: null,
        filters: {
            query: '',
            side: 'all',
            form: 'all',
            location: 'all',
            status: 'all',
        },
        selectedId: null,
        dialog: null,
        error: null,
        status: null,
    };
    mounted = state;

    const buildView = () => buildCodexView({
        state: store.get(),
        season,
        registry,
        formGroups,
        formRules,
        formIndex: state.formIndex,
        profiles,
        settings: getSettings(),
        filters: state.filters,
        selectedId: state.selectedId,
    });

    const paint = () => {
        if (mounted !== state || !root.isConnected) {
            return;
        }
        const view = buildView();
        root.innerHTML = `
            ${state.error ? `<p class="neoterra-error" role="alert">${escapeCodexHtml(state.error)}</p>` : ''}
            ${state.status ? `<p class="neoterra-hint" data-neoterra-codex-status>${escapeCodexHtml(state.status)}</p>` : ''}
            ${renderCodexMarkup(view)}
            ${state.dialog ? renderPlayAsDialog({ detail: view.selected, mode: state.dialog.mode }) : ''}`;
        document.body?.classList?.toggle('neoterra-dialog-open', Boolean(state.dialog));
        if (state.dialog) {
            root.querySelector('[data-neoterra-codex-dialog]')?.focus?.();
        }
    };

    const closeDialog = () => {
        const returnFocus = state.returnFocus;
        state.returnFocus = null;
        state.dialog = null;
        state.error = null;
        paint();
        if (returnFocus?.isConnected) {
            returnFocus.focus();
        } else {
            root.querySelector('[data-neoterra-codex-select][aria-current="true"]')?.focus?.();
        }
    };

    const applyIdentity = (characterId) => {
        const context = {
            registry,
            formGroups,
            formRules,
        };
        const before = store.get();
        const next = performPlayAs({
            store,
            context,
            season,
            registry,
            settings: getSettings(),
            characterId,
        });
        const identity = {
            identity: 'canon',
            characterId,
            nonCanon: next.flags?.nonCanon === true,
        };
        state.status = `Now playing as ${next.characters?.[characterId]?.displayName ?? characterId}.`;
        state.dialog = null;
        state.returnFocus = null;
        state.error = null;
        state.selectedId = characterId;
        onIdentityChange?.({ state: next, previous: before, identity });
        paint();
        [...root.querySelectorAll('[data-neoterra-codex-select]')]
            .find((element) => element.dataset.neoterraCodexSelect === characterId)
            ?.focus?.();
    };

    const applyCustom = () => {
        const context = {
            registry,
            formGroups,
            formRules,
        };
        const before = store.get();
        const next = performPlayAsCustom({
            store,
            context,
            displayName: 'The Player',
            personaNotes: store.get()?.player?.personaNotes ?? '',
        });
        const identity = { identity: 'custom', characterId: null, nonCanon: false };
        state.status = 'Returned to a custom persona.';
        state.dialog = null;
        state.returnFocus = null;
        state.error = null;
        onIdentityChange?.({ state: next, previous: before, identity });
        paint();
    };

    const applyProfileBackfill = (ids, mode) => {
        try {
            const before = store.get();
            const result = backfillCardProfiles({ state: before, ids, profiles });
            if (!result.changed) {
                state.error = null;
                state.status = mode === 'sync'
                    ? 'Card profiles are already in sync.'
                    : 'No missing card fields to import for this character.';
                paint();
                return;
            }
            const next = store.replace(result.state);
            state.error = null;
            state.status = mode === 'sync'
                ? `Synced card profiles for ${result.updated.length} character(s).`
                : `Imported card profile for ${next.characters?.[ids[0]]?.displayName ?? ids[0]}.`;
            onWorldChange?.({ state: next, reason: 'card-profiles', updated: result.updated });
        } catch (error) {
            state.error = error?.message ?? String(error);
            state.status = null;
            logger.warn('Card profile import failed', error);
        }
        paint();
    };

    root.addEventListener('input', (event) => {
        const input = event.target.closest?.('[data-neoterra-codex-search]');
        if (!input) {
            return;
        }
        state.filters.query = input.value;
        const caret = input.selectionStart;
        paint();
        const nextInput = root.querySelector('[data-neoterra-codex-search]');
        if (nextInput) {
            nextInput.focus();
            if (Number.isInteger(caret)) {
                nextInput.setSelectionRange(caret, caret);
            }
        }
    }, { signal: controller.signal });

    root.addEventListener('change', (event) => {
        const select = event.target.closest?.('[data-neoterra-codex-filter]');
        if (!select) {
            return;
        }
        state.filters[select.dataset.neoterraCodexFilter] = select.value;
        paint();
    }, { signal: controller.signal });

    root.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-neoterra-sync-profiles]')) {
            state.status = null;
            state.error = null;
            applyProfileBackfill(Object.keys(store.get()?.characters ?? {}), 'sync');
            return;
        }
        const importProfile = event.target.closest?.('[data-neoterra-import-profile]');
        if (importProfile) {
            state.status = null;
            state.error = null;
            applyProfileBackfill([importProfile.dataset.neoterraImportProfile], 'one');
            return;
        }
        const selectCard = event.target.closest?.('[data-neoterra-codex-select]');
        if (selectCard) {
            state.selectedId = selectCard.dataset.neoterraCodexSelect;
            state.error = null;
            state.status = null;
            paint();
            return;
        }
        const swap = event.target.closest?.('[data-neoterra-form-swap]');
        if (swap) {
            state.error = null;
            state.status = null;
            const target = root.querySelector('[data-neoterra-form-swap-target]')?.value;
            const characterId = buildView().selected?.characterId;
            try {
                const next = performFormSwap({
                    store,
                    context: { registry, formGroups, formRules },
                    characterId,
                    formId: target,
                    formIndex: state.formIndex,
                    formRules,
                });
                state.status = `${next.characters?.[characterId]?.displayName ?? characterId} is now ${target}.`;
                onWorldChange?.({ state: next, characterId, formId: target });
            } catch (error) {
                state.error = error?.message ?? String(error);
                logger.warn('Form swap rejected', error);
            }
            paint();
            return;
        }
        const playAs = event.target.closest?.('[data-neoterra-play-as]');
        if (playAs) {
            state.returnFocus = playAs;
            state.dialog = { mode: 'canon', characterId: playAs.dataset.neoterraPlayAs };
            state.error = null;
            state.status = null;
            paint();
            return;
        }
        if (event.target.closest?.('[data-neoterra-play-as-custom]')) {
            state.returnFocus = event.target.closest('[data-neoterra-play-as-custom]');
            state.dialog = { mode: 'custom' };
            state.error = null;
            state.status = null;
            paint();
            return;
        }
        if (event.target.closest?.('[data-neoterra-codex-dialog-confirm]')) {
            const dialog = state.dialog;
            if (!dialog) {
                return;
            }
            try {
                if (dialog.mode === 'custom') {
                    applyCustom();
                } else {
                    applyIdentity(dialog.characterId);
                }
            } catch (error) {
                state.error = error?.message ?? String(error);
                state.dialog = null;
                logger.warn('Identity change rejected', error);
                paint();
            }
            return;
        }
        if (event.target.closest?.('[data-neoterra-codex-dialog-close]')) {
            closeDialog();
        }
    }, { signal: controller.signal });

    window.addEventListener('keydown', (event) => {
        if (!state.dialog) {
            return;
        }
        const outcome = trapDialogFocus(event, root);
        if (outcome === 'close') {
            closeDialog();
        }
    }, { signal: controller.signal });

    paint();
    return {
        refresh: paint,
        getView: () => buildView(),
        getState: () => store.get(),
    };
}

export function disposeCodex() {
    if (!mounted) {
        return;
    }
    mounted.controller?.abort();
    // Cancel the codex store's pending debounce so a reset that clears the chat
    // metadata cannot be overwritten by a stale timer. The WAL still holds the
    // in-flight document for a normal chat switch.
    mounted.store?.dispose?.();
    if (hasDom()) {
        document.body?.classList?.remove('neoterra-dialog-open');
    }
    if (mounted.root?.isConnected) {
        mounted.root.innerHTML = '';
    }
    mounted = null;
}
