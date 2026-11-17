/**
 * Season selection and deterministic world construction.
 *
 * The flow is intentionally split in three layers:
 *   1. menu/identity helpers (pure views over season, registry, and locations);
 *   2. `startSeason` (pure state construction through the WorldState store);
 *   3. `enterSeason` (browser-facing convenience that loads data and wires the
 *      chat metadata and the narrator card).
 *
 * No module here talks to the DOM. The season menu is a thin client of these
 * exports, and Node tests drive the same functions with fixture documents.
 */

import { buildOpeningScene } from './scene.js';
import { createLogger } from '../core/logger.js';
import { buildRegistryIndex, loadRegistry } from '../data/registry.js';
import {
    PLAYABLE_SEASON_IDS,
    assertPlayableSeason,
    getSeasonThreats,
    isPlayableSeason,
    loadSeason,
    loadSeasonDefinitions,
} from '../data/seasons.js';
import { loadFactions } from '../data/factions.js';
import { loadLocations } from '../data/locations.js';
import { validateFormGroups, validateFormRules } from '../data/schema.js';
import { createWorldStateStore } from '../state/store.js';

const logger = createLogger('season-start');

export const SEASON_MENU_ORDER = Object.freeze([
    's1',
    's1dark',
    's2',
    's3',
    's4',
    'sandbox',
    's5',
]);

export const DIRECTOR_CARD_NAME = 'Neo Terra — Director';

export const DEFAULT_CONTENT_NOTICE =
    'Mature themes: violence, corruption, mind control, and psychological horror.';

export class SeasonStartError extends Error {
    constructor(code, message, { cause } = {}) {
        super(message);
        this.name = 'SeasonStartError';
        this.code = code;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

const FORM_GROUPS_URL = new URL('../../data/form-groups.json', import.meta.url);
const FORM_RULES_URL = new URL('../../data/form-rules.json', import.meta.url);

let formGroupsCache = null;
let formRulesCache = null;
let formDataInFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seasonList(seasons) {
    if (Array.isArray(seasons)) {
        return seasons.filter(isObject);
    }
    if (isObject(seasons)) {
        return Object.values(seasons).filter(isObject);
    }
    return [];
}

function registryEntry(registry, id) {
    if (!registry || typeof id !== 'string') {
        return null;
    }
    return buildRegistryIndex(registry).byId[id] ?? null;
}

function roleLabel(playerRole) {
    if (playerRole === 'villain') {
        return 'Villain POV';
    }
    if (playerRole === 'hero') {
        return 'Hero POV';
    }
    return 'Neutral POV';
}

/**
 * Fetch and validate the form-group and form-rule documents. Both files are
 * static data; the cache keeps repeated season entries cheap.
 */
export async function loadFormData({ fetchImpl = globalThis.fetch, registry = null } = {}) {
    if (formGroupsCache && formRulesCache) {
        return { formGroups: formGroupsCache, formRules: formRulesCache };
    }
    if (typeof fetchImpl !== 'function') {
        throw new SeasonStartError(
            'MISSING_DATA',
            'loadFormData: no fetch implementation is available',
        );
    }
    if (!formDataInFlight) {
        formDataInFlight = (async () => {
            const [groupsResponse, rulesResponse] = await Promise.all([
                fetchImpl(FORM_GROUPS_URL.href),
                fetchImpl(FORM_RULES_URL.href),
            ]);
            if (groupsResponse?.ok === false || rulesResponse?.ok === false) {
                throw new SeasonStartError(
                    'MISSING_DATA',
                    'loadFormData: could not load the form-group or form-rule document',
                );
            }
            const formGroups = await groupsResponse.json();
            const formRules = await rulesResponse.json();

            const groupValidation = validateFormGroups(formGroups);
            if (!groupValidation.ok) {
                throw new SeasonStartError(
                    'MISSING_DATA',
                    `loadFormData: invalid form groups (${groupValidation.errors[0]?.path}: ${groupValidation.errors[0]?.message})`,
                );
            }
            const ruleValidation = validateFormRules(formRules, registry);
            if (!ruleValidation.ok) {
                throw new SeasonStartError(
                    'MISSING_DATA',
                    `loadFormData: invalid form rules (${ruleValidation.errors[0]?.path}: ${ruleValidation.errors[0]?.message})`,
                );
            }
            formGroupsCache = formGroups;
            formRulesCache = formRules;
            return { formGroups, formRules };
        })().finally(() => {
            formDataInFlight = null;
        });
    }
    return formDataInFlight;
}

export function clearFormDataCache() {
    formGroupsCache = null;
    formRulesCache = null;
    formDataInFlight = null;
}

/**
 * Entry-menu cards: every playable season, plus the disabled S5 notice.
 *
 * @param {object|object[]} seasons season map or array
 * @param {{ registry?: object }} [options]
 */
export function buildSeasonMenuEntries(seasons, options = {}) {
    const { registry = null } = options;
    const byId = new Map(seasonList(seasons).map((season) => [season.id, season]));
    const ordered = [
        ...SEASON_MENU_ORDER.filter((id) => byId.has(id)).map((id) => byId.get(id)),
        ...seasonList(seasons).filter((season) => !SEASON_MENU_ORDER.includes(season.id)),
    ];

    return ordered.map((season) => {
        const playable = isPlayableSeason(season);
        const castCount = Array.isArray(season.roster) ? season.roster.length : 0;
        const threats = [
            ...getSeasonThreats(season, 'main'),
            ...getSeasonThreats(season, 'secondary'),
        ].map((threat) => ({
            id: threat.id,
            name: threat.name,
            rank: threat.rank,
        }));
        const mainThreats = threats.filter((threat) => threat.rank === 'main');
        const defaultCharacter = registryEntry(registry, season.defaultPlayerCharacterId);
        const defaultPlayerName = defaultCharacter?.displayName
            ?? season.defaultPlayerCharacterId
            ?? null;
        const villainPov = season.playerRole === 'villain';
        const villainAlias = villainPov
            ? season.playAsAlias
                ?? (defaultCharacter?.aliases ?? []).find(
                    (alias) => typeof alias === 'string'
                        && alias.toLowerCase() !== String(defaultPlayerName ?? '').toLowerCase(),
                )
                ?? null
            : null;
        const playAsLabel = playable && defaultPlayerName
            ? `Play as ${defaultPlayerName}${villainAlias ? ` — ${villainAlias}` : ''}`
            : null;
        const disabledReason = !playable
            ? season.notPlayableReason ?? 'Auxiliary data present — coming later'
            : null;

        return {
            id: season.id,
            title: season.title,
            era: season.era,
            premise: season.premise,
            toneNotes: season.toneNotes ?? '',
            contentNotice: season.contentNotice ?? DEFAULT_CONTENT_NOTICE,
            playerRole: season.playerRole,
            playerRoleLabel: roleLabel(season.playerRole),
            villainPov,
            alt: season.alt === true,
            altOf: season.altOf ?? null,
            sandbox: season.sandbox === true,
            playable,
            disabled: !playable,
            disabledReason,
            notice: disabledReason ?? (villainPov ? playAsLabel : null),
            castCount,
            castLabel: season.sandbox === true ? 'Any character' : `${castCount} cast`,
            threats,
            mainThreats,
            mainThreatNames: mainThreats.map((threat) => threat.name),
            defaultPlayerCharacterId: season.defaultPlayerCharacterId ?? null,
            defaultPlayerName,
            playAsLabel,
            startLocationId: season.startLocationId ?? null,
            startLocationName: (options.locations?.locations ?? [])
                .find((location) => location.id === season.startLocationId)?.name ?? null,
        };
    });
}

/** Async menu view built from the authored season documents. */
export async function getSeasonMenuEntries(options = {}) {
    const [seasons, registry] = await Promise.all([
        options.seasons ?? loadSeasonDefinitions(options),
        options.registry ?? loadRegistry(options),
    ]);
    const locations = options.locations ?? await loadLocations(options);
    return buildSeasonMenuEntries(seasons, { registry, locations });
}

/**
 * Character-first filter: seasons whose roster contains the character or one
 * of its alternate forms. Sandbox is always available.
 */
export function filterSeasonEntriesByCharacter(entries, characterId, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (typeof characterId !== 'string' || characterId.length === 0) {
        return list.slice();
    }
    const { registry = null, seasons = null } = options;
    const entry = registryEntry(registry, characterId);
    const group = entry?.formGroup ?? null;
    const linkedIds = new Set([characterId]);
    if (group) {
        for (const candidate of registry?.entries ?? []) {
            if (candidate.formGroup === group) {
                linkedIds.add(candidate.id);
            }
        }
    }
    const seasonById = new Map(seasonList(seasons).map((season) => [season.id, season]));
    return list.filter((menuEntry) => {
        if (menuEntry.sandbox) {
            return true;
        }
        const season = seasonById.get(menuEntry.id) ?? null;
        if (!season) {
            return false;
        }
        return (season.roster ?? []).some((member) => linkedIds.has(member.characterId));
    });
}

/**
 * Identity options for one season.
 *
 * Custom persona is first; canon options follow in roster order. The season
 * default is flagged, so S1Dark visibly offers "Play as Bleeding Heart".
 */
export function buildIdentityChoices(season, options = {}) {
    if (!isObject(season)) {
        throw new SeasonStartError('INVALID_SEASON', 'buildIdentityChoices requires a season');
    }
    const { registry = null, includeRegistry = false, limit = 200 } = options;
    const roster = Array.isArray(season.roster) ? season.roster : [];
    const rosterIds = new Set(roster.map((member) => member.characterId));

    const canonOptions = [];
    if (roster.length > 0) {
        for (const member of roster) {
            const entry = registryEntry(registry, member.characterId);
            const form = registryEntry(registry, member.formId);
            canonOptions.push({
                identity: 'canon',
                characterId: member.characterId,
                formId: member.formId,
                displayName: entry?.displayName ?? member.characterId,
                side: form?.side ?? entry?.side ?? 'neutral',
                formKind: form?.formKind ?? 'base',
                inRoster: true,
                isDefault: member.characterId === season.defaultPlayerCharacterId,
                label: `Play as ${entry?.displayName ?? member.characterId}`,
                nonCanon: false,
            });
        }
    } else if ((season.allowAnyCharacter === true || includeRegistry) && registry) {
        const entries = (registry.entries ?? [])
            .filter((entry) => (
                entry.bundle !== true
                && (season.allowAnyCharacter === true || entry.seasonId === season.id)
            ))
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, Math.max(1, limit));
        for (const entry of entries) {
            canonOptions.push({
                identity: 'canon',
                characterId: entry.id,
                formId: entry.id,
                displayName: entry.displayName,
                side: entry.side,
                formKind: entry.formKind,
                inRoster: false,
                isDefault: entry.id === season.defaultPlayerCharacterId,
                label: `Play as ${entry.displayName}`,
                nonCanon: !rosterIds.has(entry.id),
            });
        }
    }

    if (season.defaultPlayerCharacterId && rosterIds.has(season.defaultPlayerCharacterId)) {
        const index = canonOptions.findIndex(
            (option) => option.characterId === season.defaultPlayerCharacterId,
        );
        if (index > 0) {
            const [defaultOption] = canonOptions.splice(index, 1);
            canonOptions.unshift(defaultOption);
        }
    }

    return {
        seasonId: season.id,
        defaultIdentity: season.defaultPlayerCharacterId ? 'canon' : 'custom',
        defaultCharacterId: season.defaultPlayerCharacterId ?? null,
        allowAnyCharacter: season.allowAnyCharacter === true,
        options: [
            {
                identity: 'custom',
                characterId: null,
                displayName: 'Custom persona',
                label: 'Custom persona',
                inRoster: false,
                isDefault: !season.defaultPlayerCharacterId,
                nonCanon: false,
            },
            ...canonOptions,
        ],
    };
}

/**
 * Mark one character option as the preselected identity. Used by the
 * character-first entry point so the focused character becomes the opening
 * focus rather than merely narrowing the list.
 */
export function applyCharacterFocus(choices, characterId) {
    if (!isObject(choices) || !Array.isArray(choices.options)) {
        return choices;
    }
    if (typeof characterId !== 'string' || characterId.length === 0) {
        return choices;
    }
    const index = choices.options.findIndex(
        (option) => option.identity === 'canon' && option.characterId === characterId,
    );
    if (index === -1) {
        return choices;
    }
    const options = choices.options.map((option, optionIndex) => ({
        ...option,
        isDefault: optionIndex === index,
    }));
    return {
        ...choices,
        defaultIdentity: 'canon',
        defaultCharacterId: characterId,
        focusedCharacterId: characterId,
        options,
    };
}

/**
 * Preserve a pending identity across the replace-world confirmation step.
 * The confirmation view has no identity inputs, so the menu passes the last
 * captured selection here instead of rebuilding it from missing fields.
 */
export function mergePendingIdentity(pending, patch = {}) {
    const base = isObject(pending) ? pending : {};
    const next = isObject(patch) ? patch : {};
    return {
        identity: next.identity ?? base.identity ?? (next.characterId ? 'canon' : 'custom'),
        characterId: next.characterId ?? base.characterId ?? null,
        displayName: next.displayName ?? base.displayName,
        personaNotes: next.personaNotes ?? base.personaNotes,
    };
}

/**
 * Validate and normalize an identity choice. Non-roster characters are only
 * legal when the season is an any-character sandbox.
 */
export function resolveIdentitySelection(season, selection = {}, options = {}) {
    const { registry = null } = options;
    if (!isObject(season)) {
        throw new SeasonStartError('INVALID_SEASON', 'resolveIdentitySelection requires a season');
    }
    const requested = isObject(selection) ? selection : {};
    const identity = requested.identity
        ?? (requested.characterId ? 'canon' : season.defaultPlayerCharacterId ? 'canon' : 'custom');

    if (identity === 'custom') {
        return {
            identity: 'custom',
            characterId: null,
            displayName: requested.displayName ?? 'The Player',
            personaNotes: requested.personaNotes ?? '',
            nonCanon: false,
        };
    }

    if (identity !== 'canon') {
        throw new SeasonStartError(
            'INVALID_IDENTITY',
            `Unknown player identity "${String(identity)}"`,
        );
    }

    const characterId = requested.characterId ?? season.defaultPlayerCharacterId ?? null;
    if (typeof characterId !== 'string' || characterId.length === 0) {
        throw new SeasonStartError(
            'INVALID_IDENTITY',
            'A canon identity requires a characterId',
        );
    }
    const entry = registryEntry(registry, characterId);
    if (!entry) {
        throw new SeasonStartError(
            'INVALID_IDENTITY',
            `Unknown registry character "${characterId}"`,
        );
    }
    if (entry.bundle === true) {
        throw new SeasonStartError(
            'INVALID_IDENTITY',
            `"${characterId}" is a multi-actor card and cannot be played as one character`,
        );
    }

    const inRoster = (season.roster ?? []).some(
        (member) => member.characterId === characterId,
    );
    if (!inRoster && season.allowAnyCharacter !== true) {
        throw new SeasonStartError(
            'NON_ROSTER_CHARACTER',
            `"${characterId}" is not on the ${season.id} roster; only Sandbox allows non-roster characters`,
        );
    }

    return {
        identity: 'canon',
        characterId,
        displayName: requested.displayName ?? entry.displayName ?? characterId,
        personaNotes: requested.personaNotes ?? '',
        nonCanon: !inRoster,
    };
}

/** Chat-scoped world-book name. Step 8 materializes the book behind it. */
export function seasonWorldBookName(season, chatId) {
    const title = season?.title ?? season?.id ?? 'Neo Terra';
    const chat = typeof chatId === 'string' && chatId.length > 0 ? chatId : 'unlinked-chat';
    return `Neo Terra — ${title} — ${chat}`;
}

function buildChatRegistrySlice(registry, season, playerCharacterId) {
    if (!isObject(registry)) {
        return null;
    }
    const rosterIds = new Set((season.roster ?? []).map((member) => member.characterId));
    if (typeof playerCharacterId === 'string') {
        rosterIds.add(playerCharacterId);
    }
    const groups = new Set();
    for (const id of rosterIds) {
        const entry = registryEntry(registry, id);
        if (entry?.formGroup) {
            groups.add(entry.formGroup);
        }
        if (entry?.altOf) {
            groups.add(registryEntry(registry, entry.altOf)?.formGroup ?? null);
        }
    }
    const entries = (registry.entries ?? []).filter(
        (entry) => rosterIds.has(entry.id) || (entry.formGroup && groups.has(entry.formGroup)),
    );
    return {
        schemaVersion: registry.schemaVersion,
        generatedBy: registry.generatedBy,
        source: registry.source,
        counts: {
            ...(registry.counts ?? {}),
            total: entries.length,
        },
        entries,
    };
}

/**
 * Write the chat-level season metadata that is not part of WorldState.
 * Unknown keys under `chatMetadata.neoterra` are preserved.
 */
export function applySeasonChatMetadata(metadata, payload = {}) {
    if (!isObject(metadata)) {
        throw new SeasonStartError('INVALID_METADATA', 'applySeasonChatMetadata requires metadata');
    }
    const existing = isObject(metadata.neoterra) ? metadata.neoterra : {};
    metadata.neoterra = {
        ...existing,
        schemaVersion: 1,
        seasonId: payload.seasonId ?? existing.seasonId ?? null,
        seasonDefinition: payload.season ?? existing.seasonDefinition ?? null,
        registry: payload.registry ?? existing.registry ?? null,
        castMode: payload.castMode ?? existing.castMode ?? 'director',
        playerIdentity: payload.playerIdentity ?? existing.playerIdentity ?? null,
        worldBook: payload.worldBook !== undefined
            ? payload.worldBook
            : existing.worldBook ?? null,
        updatedAt: payload.now ?? Date.now(),
    };
    return metadata.neoterra;
}

/**
 * Construct a fresh WorldState for a season. This is the deterministic core
 * of the season-start flow and the only function that writes to the store.
 *
 * @param {{
 *   store: ReturnType<typeof createWorldStateStore>,
 *   season: object,
 *   registry: object,
 *   factions: object,
 *   locations: object,
 *   formGroups: object,
 *   formRules: object,
 *   chatId: string,
 *   mode?: string,
 *   identity?: object,
 *   confirmReplace?: boolean,
 *   now?: number,
 *   metadata?: object|null,
 *   worldBookName?: string|null,
 * }} options
 */
export function startSeason(options = {}) {
    const {
        store,
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId,
        mode = 'director',
        identity = {},
        confirmReplace = false,
        now = Date.now(),
        metadata = null,
        worldBookName = null,
    } = options;

    if (!store || typeof store.seed !== 'function') {
        throw new SeasonStartError('INVALID_STORE', 'startSeason requires a WorldState store');
    }
    if (!isObject(season)) {
        throw new SeasonStartError('INVALID_SEASON', 'startSeason requires a season definition');
    }
    if (!isPlayableSeason(season)) {
        throw new SeasonStartError(
            'NOT_PLAYABLE',
            `Season "${season.id}" is not yet playable: ${season.notPlayableReason ?? 'auxiliary data only'}`,
        );
    }
    if (typeof chatId !== 'string' || chatId.trim().length === 0) {
        throw new SeasonStartError('INVALID_CHAT', 'startSeason requires a chat id');
    }

    const existing = store.get();
    if (existing && !confirmReplace) {
        throw new SeasonStartError(
            'EXISTING_WORLD',
            `This chat already has a ${existing.seasonId ?? 'Neo Terra'} world. Confirm to replace it.`,
        );
    }

    const selection = resolveIdentitySelection(season, identity, { registry });
    const effectiveMode = selection.identity === 'custom' && mode === 'solo' ? 'director' : mode;

    let state = store.seed({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        chatId,
        mode: effectiveMode,
        now,
        player: {
            identity: selection.identity,
            characterId: selection.characterId,
            personaNotes: selection.personaNotes,
            displayName: selection.displayName,
        },
    });

    if (selection.nonCanon && state.flags?.nonCanon !== true) {
        state = {
            ...state,
            flags: {
                ...(state.flags ?? {}),
                nonCanon: true,
            },
        };
        state = store.replace(state);
    }

    const opening = buildOpeningScene({ state, season });
    const worldBook = {
        name: worldBookName ?? seasonWorldBookName(season, chatId),
        status: 'pending',
    };

    if (metadata) {
        applySeasonChatMetadata(metadata, {
            seasonId: season.id,
            season,
            registry: buildChatRegistrySlice(registry, season, selection.characterId),
            castMode: effectiveMode,
            playerIdentity: {
                identity: selection.identity,
                characterId: selection.characterId,
                nonCanon: selection.nonCanon,
            },
            worldBook,
            now,
        });
        try {
            store.saveNow?.();
        } catch (error) {
            logger.warn('Could not persist the seeded world immediately', error);
        }
    }

    return {
        state,
        opening,
        identity: selection,
        mode: effectiveMode,
        replaced: Boolean(existing),
        worldBook,
    };
}

function findStCharacter(ctx, name) {
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const target = String(name ?? '').toLowerCase();
    const match = characters.find((character) => (
        String(character?.name ?? character?.data?.name ?? '').toLowerCase() === target
    ));
    return match ?? null;
}

/**
 * Best-effort narrator-card selection. Step 7 does not create ST cards: a
 * missing Director card is reported, never fabricated.
 */
export function selectNarratorCard(ctx, options = {}) {
    const { season, identity, mode, registry } = options;
    const solo = mode === 'solo' && identity?.identity === 'canon';
    const entry = solo ? registryEntry(registry, identity.characterId) : null;
    const name = solo
        ? entry?.dataName ?? entry?.displayName ?? identity.characterId
        : DIRECTOR_CARD_NAME;
    const character = findStCharacter(ctx, name);

    if (!character) {
        return {
            role: solo ? 'canon' : 'director',
            name,
            characterId: null,
            status: 'missing',
        };
    }

    const avatar = character.avatar ?? character.id ?? null;
    try {
        if (typeof ctx?.selectCharacterById === 'function' && avatar) {
            ctx.selectCharacterById(avatar);
        }
        return {
            role: solo ? 'canon' : 'director',
            name,
            characterId: avatar,
            status: 'selected',
        };
    } catch (error) {
        logger.warn('Could not select the narrator card', error);
        return {
            role: solo ? 'canon' : 'director',
            name,
            characterId: avatar,
            status: 'failed',
        };
    }
}

/**
 * Browser-facing season entry: load all static data, seed the world, write the
 * chat metadata, optionally materialize the world book, and select the card.
 *
 * @param {{
 *   id: string,
 *   identity?: object,
 *   mode?: string,
 *   ctx?: object,
 *   chatId?: string,
 *   confirmReplace?: boolean,
 *   fetchImpl?: typeof fetch,
 *   now?: number,
 *   store?: object,
 *   worldBook?: { ensure?: Function, sync?: Function } | null,
 *   metadata?: object|null,
 * }} options
 */
export async function enterSeason(options = {}) {
    const {
        id,
        identity = {},
        mode = 'director',
        ctx = null,
        confirmReplace = false,
        fetchImpl = globalThis.fetch,
        now = Date.now(),
        worldBook: worldBookAdapter = null,
        metadata: metadataOption = null,
    } = options;

    const requestedChatId = typeof options.chatId === 'string' ? options.chatId : null;
    const initialChatId = requestedChatId ?? ctx?.chatId ?? null;
    if (typeof initialChatId !== 'string' || initialChatId.length === 0) {
        throw new SeasonStartError('INVALID_CHAT', 'enterSeason requires an active chat');
    }

    const [season, registry, factions, locations, formData] = await Promise.all([
        loadSeason(id, { fetchImpl }),
        loadRegistry({ fetchImpl }),
        loadFactions({ fetchImpl }),
        loadLocations({ fetchImpl }),
        loadFormData({ fetchImpl }),
    ]);
    assertPlayableSeason(season);

    // Loading static data can take long enough for the user to switch chats.
    // Never seed the world of chat A into chat B's metadata.
    const chatId = requestedChatId ?? ctx?.chatId ?? initialChatId;
    if (!requestedChatId && ctx && chatId !== initialChatId) {
        throw new SeasonStartError(
            'CHAT_CHANGED',
            'The active chat changed while the season data was loading. Try again.',
        );
    }

    const metadata = metadataOption ?? ctx?.chatMetadata ?? null;
    let store = options.store ?? null;
    if (!store) {
        if (!isObject(metadata)) {
            throw new SeasonStartError(
                'INVALID_METADATA',
                'enterSeason requires ctx.chatMetadata or an explicit metadata object',
            );
        }
        let storage = null;
        try {
            storage = globalThis.localStorage ?? null;
        } catch {
            storage = null;
        }
        store = createWorldStateStore({
            metadata,
            saveMetadataDebounced: () => ctx?.saveMetadataDebounced?.(),
            storage,
            chatId,
            context: {
                registry,
                formGroups: formData.formGroups,
                formRules: formData.formRules,
                factions,
                locations,
            },
        });
    }

    const result = startSeason({
        store,
        season,
        registry,
        factions,
        locations,
        formGroups: formData.formGroups,
        formRules: formData.formRules,
        chatId,
        mode,
        identity,
        confirmReplace,
        now,
        metadata,
    });

    if (metadata && worldBookAdapter && typeof worldBookAdapter.ensure === 'function') {
        try {
            const materialized = await worldBookAdapter.ensure({
                name: result.worldBook.name,
                season,
                registry,
                state: result.state,
                chatId,
            });
            if (materialized) {
                result.worldBook = {
                    ...result.worldBook,
                    ...materialized,
                    status: materialized.status ?? 'materialized',
                };
                applySeasonChatMetadata(metadata, {
                    seasonId: season.id,
                    worldBook: result.worldBook,
                    now,
                });
            }
        } catch (error) {
            logger.warn('World-book materialization failed; the world is still playable', error);
            result.worldBook = {
                ...result.worldBook,
                status: 'failed',
                error: error?.message ?? String(error),
            };
            applySeasonChatMetadata(metadata, {
                seasonId: season.id,
                worldBook: result.worldBook,
                now,
            });
        }
    }

    result.narrator = ctx
        ? selectNarratorCard(ctx, {
            season,
            identity: result.identity,
            mode: result.mode,
            registry,
        })
        : null;

    if (metadata) {
        try {
            ctx?.saveMetadataDebounced?.();
        } catch (error) {
            logger.warn('Could not persist season metadata', error);
        }
    }

    return { ...result, season, registry };
}

export { PLAYABLE_SEASON_IDS, isPlayableSeason };
