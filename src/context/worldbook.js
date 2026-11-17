/**
 * Compact character profiles for prompt context.
 *
 * The codex and the materialized world book may use full card text, but prompt
 * blocks must not. This module turns a registry entry plus live CharacterState
 * into a short, budget-aware profile. Step 8 extends this module with the
 * chat-linked world-book materializer; Step 6 only needs the trimmed view.
 */

import { applyContentGate } from '../core/content-gate.js';
import { buildRegistryIndex } from '../data/registry.js';
import { estimateTokens, truncateToTokens } from './budget.js';

const FIELD_MAX_ITEMS = 8;
const MAX_ENTRY_KEYS = 12;

export const WORLD_BOOK_MARKER = 'neoterra:character:';

/**
 * Full SillyTavern world-info entry shape. Generated entries always carry every
 * field so a host-side editor sees a complete entry rather than a sparse one.
 */
export const ST_WORLD_INFO_ENTRY_DEFAULTS = Object.freeze({
    uid: 0,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: null,
    vectorized: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [],
});

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

/* ------------------------------------------------------------------ */
/* World-book materialization                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueKeys(candidates) {
    const keys = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const value = candidate.trim();
        if (value.length === 0) {
            continue;
        }
        const normalized = value.toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        keys.push(value);
        if (keys.length >= MAX_ENTRY_KEYS) {
            break;
        }
    }
    return keys;
}

function asKeyList(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return value === undefined || value === null ? [] : [value];
}

/** Build an empty ST world-book document. */
export function buildWorldBookDocument(name = 'Neo Terra — World Book') {
    return { name, entries: {} };
}

/**
 * Build one complete SillyTavern world-info entry for a character.
 *
 * `key` is an optional override. Without it, keys are the display name, data
 * name, and aliases of both the character and its active form.
 */
export function buildWorldBookEntry({
    characterId,
    entry = null,
    form = null,
    character = null,
    location = null,
    key = null,
    content = null,
    uid = 0,
    order = 100,
    depth = 4,
    gateLevel = 'full',
    limits = {},
    maxTokens = 600,
} = {}) {
    if (typeof characterId !== 'string' || characterId.length === 0) {
        return null;
    }

    const displayName = character?.displayName
        ?? form?.displayName
        ?? entry?.displayName
        ?? characterId;
    const keys = uniqueKeys([
        ...asKeyList(key),
        displayName,
        form?.displayName,
        entry?.displayName,
        entry?.dataName,
        form?.dataName,
        ...(entry?.aliases ?? []),
        ...(form?.aliases ?? []),
    ]);

    const rawContent = typeof content === 'string' && content.length > 0
        ? content
        : buildProfileLines({
            entry: form ?? entry,
            character,
            location,
        }).join('\n');

    const gated = applyContentGate(rawContent, gateLevel, limits, {
        characterId,
        isPlayer: false,
    });
    const trimmed = truncateToTokens(gated, maxTokens);
    if (trimmed.text.trim().length === 0) {
        return null;
    }

    return {
        ...ST_WORLD_INFO_ENTRY_DEFAULTS,
        key: keys,
        keysecondary: [],
        comment: `Neo Terra — ${displayName} [${WORLD_BOOK_MARKER}${characterId}]`,
        content: trimmed.text,
        uid: Number.isInteger(uid) ? uid : 0,
        order: Number.isInteger(order) ? order : 100,
        depth: Number.isInteger(depth) ? depth : 4,
        triggers: [],
    };
}

/** Extract the generated character id from an entry, if this is one of ours. */
export function parseGeneratedEntryId(entry) {
    if (!isPlainObject(entry)) {
        return null;
    }
    if (typeof entry.neoterraId === 'string' && entry.neoterraId.length > 0) {
        return entry.neoterraId;
    }
    if (typeof entry.comment !== 'string') {
        return null;
    }
    const marker = `[${WORLD_BOOK_MARKER}`;
    const start = entry.comment.indexOf(marker);
    if (start === -1) {
        return null;
    }
    const rest = entry.comment.slice(start + marker.length);
    const end = rest.indexOf(']');
    const id = (end === -1 ? rest : rest.slice(0, end)).trim();
    return id.length > 0 ? id : null;
}

function defaultWorldBookName(season, chatId) {
    const title = season?.title ?? season?.id ?? 'Neo Terra';
    const chat = typeof chatId === 'string' && chatId.length > 0 ? chatId : 'unlinked-chat';
    return `Neo Terra — ${title} — ${chat}`;
}

const SKIPPED_STATUSES = new Set([
    'dead',
    'retired',
    'lost',
    'imprisoned',
    'missing',
]);

function entryList(entries) {
    if (Array.isArray(entries)) {
        return entries;
    }
    if (isPlainObject(entries)) {
        return Object.values(entries);
    }
    return [];
}

/**
 * Build one trimmed world-book entry per eligible roster character.
 *
 * Pure: the state, registry, and season are never mutated. No blanket
 * "Neo Terra" entry is produced and non-roster characters are ignored.
 */
export function materializeSeasonWorldBook({
    season,
    registry,
    state,
    name = null,
    settings = null,
    gateLevel = 'full',
    limits = {},
    maxTokensPerProfile = 600,
    now = Date.now,
} = {}) {
    const chatId = state?.chatId ?? null;
    const bookName = typeof name === 'string' && name.length > 0
        ? name
        : defaultWorldBookName(season, chatId);
    const registryIndex = buildRegistryIndex(registry);
    const roster = Array.isArray(season?.roster) ? season.roster : [];
    const playerCharacterId = state?.player?.characterId ?? null;
    const generated = [];
    const skipped = [];
    const seenIds = new Set();

    for (const member of roster) {
        const characterId = member?.characterId;
        if (typeof characterId !== 'string' || characterId.length === 0) {
            skipped.push({ charId: String(characterId ?? ''), reason: 'invalid-member' });
            continue;
        }
        if (seenIds.has(characterId)) {
            skipped.push({ charId: characterId, reason: 'duplicate' });
            continue;
        }
        seenIds.add(characterId);

        const character = state?.characters?.[characterId] ?? null;
        if (!character) {
            skipped.push({ charId: characterId, reason: 'not-seeded' });
            continue;
        }
        if (character.controlledBy === 'player' || characterId === playerCharacterId) {
            skipped.push({ charId: characterId, reason: 'player-controlled' });
            continue;
        }
        if (character.alive === false) {
            skipped.push({ charId: characterId, reason: 'dead' });
            continue;
        }
        if (SKIPPED_STATUSES.has(character.status)) {
            skipped.push({ charId: characterId, reason: character.status });
            continue;
        }

        const entry = registryIndex.byId[characterId] ?? null;
        if (!entry) {
            skipped.push({ charId: characterId, reason: 'missing-entry' });
            continue;
        }
        if (entry.bundle === true) {
            skipped.push({ charId: characterId, reason: 'bundle' });
            continue;
        }

        const form = registryIndex.byId[character.formId] ?? entry;
        const location = state?.locations?.[character.locationId] ?? null;
        const raw = buildProfileLines({ entry: form, character, location }).join('\n');
        const gated = applyContentGate(raw, gateLevel, limits, {
            characterId,
            isPlayer: false,
        });
        if (gated.trim().length === 0) {
            skipped.push({ charId: characterId, reason: 'gated' });
            continue;
        }

        const worldBookEntry = buildWorldBookEntry({
            characterId,
            entry,
            form,
            character,
            location,
            content: gated,
            gateLevel: 'full',
            limits,
            maxTokens: maxTokensPerProfile,
        });
        if (!worldBookEntry) {
            skipped.push({ charId: characterId, reason: 'empty' });
            continue;
        }

        generated.push({ charId: characterId, entry: worldBookEntry });
    }

    generated.sort((a, b) => a.charId.localeCompare(b.charId));
    const document = buildWorldBookDocument(bookName);
    let tokens = 0;
    generated.forEach((item, index) => {
        const entry = { ...item.entry, uid: index, order: 100 + index };
        item.entry = entry;
        document.entries[String(index)] = entry;
        tokens += estimateTokens(entry.content);
    });

    return {
        name: bookName,
        document,
        generated: generated.map((item) => item.entry),
        skipped,
        stats: {
            rosterCount: roster.length,
            generated: generated.length,
            skipped,
            tokens,
        },
    };
}

/**
 * Merge newly generated entries into an existing world book.
 *
 * Non-generated (user) entries are preserved. Generated entries from previous
 * runs are replaced, so stale characters disappear and no charId is duplicated.
 */
export function mergeWorldBookDocuments(existing, generated) {
    const existingDocument = isPlainObject(existing) ? existing : {};
    const existingEntries = entryList(existingDocument.entries).filter(isPlainObject);
    const generatedSource = Array.isArray(generated)
        ? generated
        : isPlainObject(generated?.document)
            ? entryList(generated.document.entries)
            : entryList(generated?.entries);
    const generatedEntries = Array.isArray(generatedSource) ? generatedSource : [];
    const generatedName = isPlainObject(generated?.document)
        ? generated.document.name
        : isPlainObject(generated) ? generated.name : null;

    const preserved = [];
    for (const entry of existingEntries) {
        if (parseGeneratedEntryId(entry) === null) {
            preserved.push({ ...entry });
        }
    }

    const byCharId = new Map();
    for (const entry of generatedEntries) {
        if (!isPlainObject(entry)) {
            continue;
        }
        const charId = parseGeneratedEntryId(entry);
        if (!charId) {
            continue;
        }
        if (!byCharId.has(charId)) {
            byCharId.set(charId, { ...entry });
        }
    }
    const fresh = [...byCharId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, entry]) => entry);

    const mergedEntries = {};
    [...preserved, ...fresh].forEach((entry, index) => {
        mergedEntries[String(index)] = { ...entry, uid: index };
    });

    return {
        name: existingDocument.name ?? generatedName ?? 'Neo Terra — World Book',
        entries: mergedEntries,
    };
}

/* ------------------------------------------------------------------ */
/* SillyTavern adapter and chat linkage                                */
/* ------------------------------------------------------------------ */

/**
 * Create a thin adapter over SillyTavern's world-info API.
 *
 * All host functions are injectable, so Node tests can drive the same adapter
 * without a browser or a SillyTavern context.
 */
export function createWorldBookAdapter({
    ctx = null,
    saveWorldInfo = null,
    loadWorldInfo = null,
    deleteWorldInfo = null,
    getSettings = null,
    logger = null,
    now = Date.now,
} = {}) {
    function logWarn(message, error) {
        try {
            if (typeof logger === 'function') {
                logger(message, error);
            } else if (logger && typeof logger.warn === 'function') {
                logger.warn(message, error);
            }
        } catch {
            // Logging must never break the world-book path.
        }
    }

    function read(name) {
        try {
            if (typeof loadWorldInfo === 'function') {
                return loadWorldInfo(name);
            }
            if (typeof ctx?.loadWorldInfo === 'function') {
                return ctx.loadWorldInfo(name);
            }
            return null;
        } catch (error) {
            logWarn('Could not read the world book', error);
            return null;
        }
    }

    function save(name, document) {
        if (typeof saveWorldInfo === 'function') {
            return saveWorldInfo(name, document);
        }
        if (typeof ctx?.saveWorldInfo === 'function') {
            return ctx.saveWorldInfo(name, document);
        }
        throw new Error('World book adapter: no saveWorldInfo implementation is available');
    }

    function saveAvailable() {
        return typeof saveWorldInfo === 'function' || typeof ctx?.saveWorldInfo === 'function';
    }

    function link(name) {
        const metadata = ctx?.chatMetadata;
        if (!isPlainObject(metadata)) {
            return { linked: false, primary: null };
        }
        try {
            const root = isPlainObject(metadata.neoterra)
                ? metadata.neoterra
                : (metadata.neoterra = {});
            const previousBook = isPlainObject(root.worldBook) ? root.worldBook : null;

            let primary = null;
            if (Array.isArray(metadata.world_info)) {
                if (!metadata.world_info.includes(name)) {
                    metadata.world_info.push(name);
                }
            } else if (typeof metadata.world_info === 'string' && metadata.world_info.length > 0) {
                primary = metadata.world_info;
            } else {
                metadata.world_info = name;
                primary = name;
            }

            root.worldBook = {
                name,
                linked: true,
                updatedAt: now(),
            };
            if (primary && primary !== name) {
                root.worldBook.previousPrimary = primary;
            } else if (previousBook?.previousPrimary !== undefined) {
                root.worldBook.previousPrimary = previousBook.previousPrimary;
            }

            try {
                ctx?.saveMetadataDebounced?.();
            } catch (error) {
                logWarn('Could not persist world-book metadata', error);
            }

            return {
                linked: true,
                primary: typeof metadata.world_info === 'string'
                    ? metadata.world_info
                    : null,
            };
        } catch (error) {
            logWarn('Could not link the world book to the chat', error);
            return { linked: false, primary: null };
        }
    }

    async function ensure({
        name,
        season,
        registry,
        state,
        settings = null,
        gateLevel = undefined,
        limits = undefined,
    } = {}) {
        const bookName = typeof name === 'string' && name.length > 0
            ? name
            : defaultWorldBookName(season, state?.chatId);
        try {
            const effectiveSettings = settings ?? (getSettings ? getSettings() : null) ?? {};
            const level = gateLevel
                ?? effectiveSettings?.contentGate
                ?? effectiveSettings?.contentGateLevel
                ?? 'full';
            const contentLimits = limits ?? effectiveSettings?.contentLimits ?? {};

            const existing = await Promise.resolve(read(bookName));
            const materialized = materializeSeasonWorldBook({
                season,
                registry,
                state,
                name: bookName,
                settings: effectiveSettings,
                gateLevel: level,
                limits: contentLimits,
            });
            const document = mergeWorldBookDocuments(existing, materialized);
            const entryCount = Object.keys(document.entries).length;
            const changed = !isPlainObject(existing)
                || JSON.stringify(existing.entries ?? {}) !== JSON.stringify(document.entries);

            let linked = { linked: false, primary: null };
            if (changed) {
                await Promise.resolve(save(bookName, document));
                linked = link(bookName);
            }
            return {
                name: bookName,
                document,
                entryCount,
                status: changed ? 'materialized' : 'unchanged',
                linked: linked.linked,
                primary: linked.primary,
            };
        } catch (error) {
            logWarn('World-book materialization failed', error);
            return {
                name: bookName,
                document: null,
                entryCount: 0,
                status: 'failed',
                linked: false,
                error: error?.message ?? String(error),
            };
        }
    }

    function remove(name) {
        try {
            let status = 'unavailable';
            if (typeof deleteWorldInfo === 'function') {
                deleteWorldInfo(name);
                status = 'deleted';
            } else if (typeof ctx?.deleteWorldInfo === 'function') {
                ctx.deleteWorldInfo(name);
                status = 'deleted';
            } else if (saveAvailable()) {
                save(name, { name, entries: {} });
                status = 'cleared';
            }

            const metadata = ctx?.chatMetadata;
            if (isPlainObject(metadata)) {
                const root = isPlainObject(metadata.neoterra) ? metadata.neoterra : null;
                if (root && isPlainObject(root.worldBook) && root.worldBook.name === name) {
                    root.worldBook = null;
                }
                if (Array.isArray(metadata.world_info)) {
                    metadata.world_info = metadata.world_info.filter((book) => book !== name);
                } else if (metadata.world_info === name) {
                    delete metadata.world_info;
                }
                try {
                    ctx?.saveMetadataDebounced?.();
                } catch (error) {
                    logWarn('Could not persist world-book removal', error);
                }
            }

            return { name, status, removed: status !== 'unavailable' };
        } catch (error) {
            logWarn('Could not remove the world book', error);
            return {
                name,
                status: 'failed',
                removed: false,
                error: error?.message ?? String(error),
            };
        }
    }

    return { ensure, read, save, remove, link };
}
