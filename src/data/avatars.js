/**
 * Portrait resolution for the character registry.
 *
 * Precedence (highest first):
 *   1. the generated `data/characters/avatars.json` manifest;
 *   2. a per-user sync override written by Settings → Sync portraits;
 *   3. the user's installed SillyTavern character card, matched by exact
 *      `dataName`, display name, or alias;
 *   4. no URL at all, so the caller shows initials.
 *
 * This module is browser-safe and pure apart from the manifest fetch/cache and
 * the two localStorage helpers. Tests can inject fetch, characters, and a URL
 * base.
 */

const AVATARS_URL = new URL('../../data/characters/avatars.json', import.meta.url);

export const AVATAR_OVERRIDES_STORAGE_KEY = 'neoterra.avatarOverrides';

let manifestCache = null;
let manifestInFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAvatarName(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Validate the shape of a generated manifest. */
export function validateAvatarManifest(value) {
    if (!isObject(value)) {
        return { ok: false, errors: ['manifest must be an object'] };
    }
    if (value.schemaVersion !== 1) {
        return { ok: false, errors: ['schemaVersion must be 1'] };
    }
    if (!isObject(value.avatars)) {
        return { ok: false, errors: ['avatars must be an object'] };
    }
    const errors = [];
    for (const [id, entry] of Object.entries(value.avatars)) {
        if (!isObject(entry)) {
            errors.push(`avatars.${id} must be an object`);
            continue;
        }
        if (entry.file !== null && typeof entry.file !== 'string') {
            errors.push(`avatars.${id}.file must be a string or null`);
        }
        if (entry.source !== null && entry.source !== undefined && typeof entry.source !== 'string') {
            errors.push(`avatars.${id}.source must be a string when present`);
        }
    }
    return { ok: errors.length === 0, errors };
}

/** Fetch, validate, and cache the generated portrait manifest. */
export async function loadAvatarManifest({ fetchImpl = globalThis.fetch } = {}) {
    if (manifestCache) {
        return manifestCache;
    }
    if (!manifestInFlight) {
        if (typeof fetchImpl !== 'function') {
            throw new Error('loadAvatarManifest: no fetch implementation is available');
        }
        manifestInFlight = (async () => {
            const response = await fetchImpl(AVATARS_URL.href);
            if (response && response.ok === false) {
                throw new Error(
                    `loadAvatarManifest: failed to load ${AVATARS_URL.href} (HTTP ${response.status ?? 'unknown'})`,
                );
            }
            const manifest = await response.json();
            const validation = validateAvatarManifest(manifest);
            if (!validation.ok) {
                throw new Error(`loadAvatarManifest: invalid manifest (${validation.errors.join('; ')})`);
            }
            manifestCache = manifest;
            return manifest;
        })().finally(() => {
            manifestInFlight = null;
        });
    }
    return manifestInFlight;
}

export function clearAvatarManifestCache() {
    manifestCache = null;
    manifestInFlight = null;
}

function avatarFileOf(character) {
    const avatar = character?.avatar ?? character?.avatar_url ?? null;
    return typeof avatar === 'string' && avatar.length > 0 ? avatar : null;
}

function characterNames(character) {
    const names = [];
    if (typeof character?.name === 'string') {
        names.push(character.name);
    }
    if (typeof character?.data?.name === 'string') {
        names.push(character.data.name);
    }
    const aliases = character?.data?.extensions?.neoterra?.aliases;
    if (Array.isArray(aliases)) {
        names.push(...aliases.filter((alias) => typeof alias === 'string'));
    }
    names.push(...deriveInstalledNames(character));
    return names;
}

/**
 * Full names derived from a card body.
 *
 * Short ST card names ("Claire", five cards) are not unique, but the body
 * usually opens with `[{{char}} is Claire Lachesis, a superhero.` and may carry
 * an `Aliases:` line. Those full names disambiguate duplicate short names
 * without guessing.
 *
 * @param {object} character installed ST character
 * @returns {string[]}
 */
export function deriveInstalledNames(character) {
    const description = character?.data?.description;
    if (typeof description !== 'string' || description.length === 0) {
        return [];
    }
    const names = [];
    const isLine = description.match(/\bis\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,3})/u);
    if (isLine) {
        names.push(isLine[1].trim());
    }
    const aliasLine = description.match(/^[ \t]*(?:Common\s+)?Aliases?(?:\/Codenames)?[ \t]*:[ \t]*(.+)$/im);
    if (aliasLine) {
        for (const part of aliasLine[1].split(/[;,(]/)) {
            const alias = part
                .replace(/\([^)]*\)/g, ' ')
                .replace(/[."“”]/g, '')
                .trim();
            if (alias.length > 1 && alias.length <= 60 && !/^[A-Z][A-Za-z ]{0,30}:/.test(alias)) {
                names.push(alias);
            }
        }
    }
    return names;
}

/**
 * Stable 32-bit fingerprint of a card body.
 *
 * Two PNG cards can carry the same embedded card text with different art, and
 * installed cards are often edited copies. The body fingerprint is a stronger
 * identity signal than a repeated short card name ("Claire"), so it is the
 * tie-breaker for portrait matching.
 *
 * @param {unknown} description
 * @returns {string|null}
 */
export function cardFingerprint(description) {
    if (typeof description !== 'string' || description.trim().length === 0) {
        return null;
    }
    const text = description.replace(/\r\n?/g, '\n').trim();
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** Build a normalized name → characters index. */
export function buildInstalledCharacterIndex(characters) {
    const index = new Map();
    index.byFingerprint = new Map();
    for (const character of Array.isArray(characters) ? characters : []) {
        const avatar = avatarFileOf(character);
        if (!avatar) {
            continue;
        }
        const name = character.name ?? character.data?.name ?? avatar;
        for (const candidate of characterNames(character)) {
            const key = normalizeAvatarName(candidate);
            if (!key) {
                continue;
            }
            const list = index.get(key) ?? [];
            if (!list.some((item) => item.avatar === avatar)) {
                list.push({ avatar, name });
            }
            index.set(key, list);
        }
        const fingerprint = cardFingerprint(character.data?.description);
        if (fingerprint) {
            const list = index.byFingerprint.get(fingerprint) ?? [];
            if (!list.some((item) => item.avatar === avatar)) {
                const created = Date.parse(character.create_date ?? character.date_added ?? '');
                list.push({
                    avatar,
                    name,
                    createdAt: Number.isFinite(created) ? created : null,
                });
            }
            index.byFingerprint.set(fingerprint, list);
        }
    }
    return index;
}

/**
 * Match an installed card by exact name/alias only.
 *
 * @returns {{ avatar: string, name: string, kind: string } | { ambiguous: string[] } | null}
 */
export function matchInstalledCharacter(entry, characters, { index = null } = {}) {
    if (!entry) {
        return null;
    }
    const byName = index ?? buildInstalledCharacterIndex(characters);
    // Prefer the entry's unique full names before short card names such as
    // "Claire" or "Vaiva", which repeat across cards.
    const keys = [
        ['displayName', entry.displayName],
        ['dataName', entry.dataName],
        ...(entry.aliases ?? []).map((alias) => ['alias', alias]),
    ];
    let firstAmbiguous = null;
    for (const [kind, value] of keys) {
        const key = normalizeAvatarName(value);
        if (!key) {
            continue;
        }
        const matches = byName.get(key) ?? [];
        const avatars = [...new Set(matches.map((match) => match.avatar))];
        if (avatars.length === 1) {
            return { avatar: avatars[0], name: matches[0].name, kind };
        }
        if (avatars.length > 1 && !firstAmbiguous) {
            // A short name ("Claire") may repeat; keep looking for a unique
            // full name further down the list instead of guessing.
            firstAmbiguous = { ambiguous: avatars };
        }
    }
    return firstAmbiguous;
}

function encodePathSegment(value) {
    return encodeURIComponent(value).replace(/%2F/gi, '/');
}

/** Resolve an installed avatar filename to a browser URL. */
export function installedAvatarUrl(avatar, { baseUrl = null, thumbnailUrl = null } = {}) {
    if (typeof avatar !== 'string' || avatar.length === 0) {
        return null;
    }
    if (typeof thumbnailUrl === 'function') {
        try {
            const url = thumbnailUrl('avatar', avatar);
            if (typeof url === 'string' && url.length > 0) {
                return url;
            }
        } catch {
            // fall through to the deterministic path
        }
    }
    const path = `characters/${encodePathSegment(avatar)}`;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        return new URL(path, baseUrl).href;
    }
    if (typeof document !== 'undefined' && document.baseURI) {
        return new URL(path, document.baseURI).href;
    }
    return path;
}

function manifestAvatarUrl(file) {
    if (typeof file !== 'string' || file.length === 0) {
        return null;
    }
    const clean = file.replace(/^\/+/, '');
    try {
        return new URL(`../../${clean}`, import.meta.url).href;
    } catch {
        return clean;
    }
}

/**
 * Resolve the portrait for one registry entry.
 *
 * @param {object|null} entry registry entry
 * @param {{
 *   manifest?: object|null,
 *   syncOverrides?: Record<string, string>|null,
 *   characters?: object[]|null,
 *   characterIndex?: Map|null,
 *   baseUrl?: string|null,
 *   thumbnailUrl?: Function|null,
 * }} [options]
 * @returns {{ url: string|null, kind: string, file: string|null, avatar: string|null, name: string|null } | null}
 */
export function resolveAvatarForEntry(entry, {
    manifest = null,
    syncOverrides = null,
    characters = null,
    characterIndex = null,
    baseUrl = null,
    thumbnailUrl = null,
} = {}) {
    if (!entry || typeof entry.id !== 'string') {
        return null;
    }

    const manifestEntry = manifest?.avatars?.[entry.id] ?? null;
    if (manifestEntry?.file) {
        const url = manifestAvatarUrl(manifestEntry.file);
        if (url) {
            return {
                url,
                kind: 'manifest',
                file: manifestEntry.file,
                avatar: null,
                name: entry.displayName ?? entry.dataName ?? entry.id,
            };
        }
    }

    // Runtime-only install: the manifest knows which card body it belongs to,
    // so the user's installed copy resolves by fingerprint even when the short
    // card name repeats ("Claire", "Vaiva").
    const fingerprint = manifestEntry?.fingerprint ?? null;
    const resolvedIndex = fingerprint
        ? (characterIndex ?? (characters ? buildInstalledCharacterIndex(characters) : null))
        : characterIndex;
    if (fingerprint) {
        const matches = resolvedIndex?.byFingerprint?.get(fingerprint) ?? [];
        // Identical card bodies are the same character; two installed copies
        // (an edited save or a duplicate import) must not disable portraits.
        // Pick deterministically by the oldest card, then by avatar filename.
        const winner = matches.length > 1
            ? [...matches].sort((left, right) => (
                (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER)
                || String(left.avatar).localeCompare(String(right.avatar))
            ))[0]
            : matches[0] ?? null;
        if (winner) {
            return {
                url: installedAvatarUrl(winner.avatar, { baseUrl, thumbnailUrl }),
                kind: 'fingerprint',
                file: null,
                avatar: winner.avatar,
                name: winner.name,
            };
        }
    }

    const overrideAvatar = syncOverrides?.[entry.id];
    if (typeof overrideAvatar === 'string' && overrideAvatar.length > 0) {
        return {
            url: installedAvatarUrl(overrideAvatar, { baseUrl, thumbnailUrl }),
            kind: 'sync',
            file: null,
            avatar: overrideAvatar,
            name: entry.displayName ?? entry.dataName ?? entry.id,
        };
    }

    const installed = matchInstalledCharacter(entry, characters, { index: resolvedIndex });
    if (installed && !installed.ambiguous) {
        return {
            url: installedAvatarUrl(installed.avatar, { baseUrl, thumbnailUrl }),
            kind: 'installed',
            file: null,
            avatar: installed.avatar,
            name: installed.name,
        };
    }

    return null;
}

/**
 * Scan installed cards and build the per-user override map.
 *
 * When the generated manifest is available its body fingerprint identifies the
 * installed copy even when several cards share a short name ("Claire"). Name
 * and alias matching is the fallback for new or edited cards.
 *
 * @param {object} registry
 * @param {object[]} characters
 * @param {{ manifest?: object|null }} [options]
 * @returns {{ overrides: Record<string, string>, matched: number, ambiguous: string[], unmatched: string[] }}
 */
export function buildSyncOverrides(registry, characters, { manifest = null } = {}) {
    const index = buildInstalledCharacterIndex(characters);
    const overrides = {};
    const ambiguous = [];
    const unmatched = [];
    for (const entry of registry?.entries ?? []) {
        const fingerprint = manifest?.avatars?.[entry.id]?.fingerprint ?? null;
        const byFingerprint = fingerprint ? index.byFingerprint.get(fingerprint) ?? [] : [];
        if (byFingerprint.length > 0) {
            overrides[entry.id] = [...byFingerprint]
                .sort((left, right) => (
                    (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER)
                    || String(left.avatar).localeCompare(String(right.avatar))
                ))[0].avatar;
            continue;
        }
        const match = matchInstalledCharacter(entry, characters, { index });
        if (match?.ambiguous) {
            ambiguous.push(entry.id);
            continue;
        }
        if (!match) {
            unmatched.push(entry.id);
            continue;
        }
        overrides[entry.id] = match.avatar;
    }
    return {
        overrides,
        matched: Object.keys(overrides).length,
        ambiguous,
        unmatched,
    };
}

/** Build a downloadable manifest from the installed cards (never a repo write). */
export function buildSyncedManifest(registry, characters, { now = Date.now(), manifest = null } = {}) {
    const { overrides } = buildSyncOverrides(registry, characters, { manifest });
    const avatars = {};
    for (const id of Object.keys(overrides).sort()) {
        avatars[id] = {
            file: null,
            source: `installed:${overrides[id]}`,
            hash: null,
        };
    }
    return {
        schemaVersion: 1,
        generatedBy: 'Neo Terra Settings → Download manifest',
        source: 'installed',
        generatedAt: now,
        counts: {
            matched: Object.keys(avatars).length,
            ambiguous: 0,
            unmatched: (registry?.entries ?? []).length - Object.keys(avatars).length,
        },
        avatars,
    };
}

function storageOrDefault(storage) {
    if (storage !== undefined) {
        return storage;
    }
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function readAvatarOverrides(storage) {
    const target = storageOrDefault(storage);
    if (!target || typeof target.getItem !== 'function') {
        return {};
    }
    try {
        const raw = target.getItem(AVATAR_OVERRIDES_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!isObject(parsed)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.length > 0),
        );
    } catch {
        return {};
    }
}

export function writeAvatarOverrides(overrides, storage) {
    const target = storageOrDefault(storage);
    if (!target || typeof target.setItem !== 'function') {
        return false;
    }
    try {
        target.setItem(AVATAR_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides ?? {}));
        return true;
    } catch {
        return false;
    }
}

/** Coverage summary for settings/diagnostics. */
export function countAvatarCoverage(registry, options = {}) {    const entries = (registry?.entries ?? []).filter((entry) => entry.bundle !== true);
    let covered = 0;
    const missing = [];
    for (const entry of entries) {
        if (resolveAvatarForEntry(entry, options)) {
            covered += 1;
        } else {
            missing.push(entry.id);
        }
    }
    return { total: entries.length, covered, missing };
}
