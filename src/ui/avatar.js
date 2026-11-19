/**
 * Avatar markup shared by every character surface.
 *
 * The heavy lifting lives in `src/data/avatars.js`; this module owns the
 * module-level cache, the initials fallback, and the HTML. It is deliberately
 * tolerant: a missing manifest, a missing installed card, or a broken image
 * always degrades to initials and never blocks a panel.
 */

import {
    buildInstalledCharacterIndex,
    loadAvatarManifest,
    readAvatarOverrides,
    resolveAvatarForEntry,
} from '../data/avatars.js';

let state = null;
let errorListenerBound = false;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function escapeAvatarHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function initialsFor(name) {
    return String(name ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || '?';
}

function thumbnailUrlFromContext(ctx) {
    return typeof ctx?.getThumbnailUrl === 'function'
        ? (type, file) => ctx.getThumbnailUrl(type, file)
        : null;
}

function bindImageFallback() {
    if (errorListenerBound || typeof document === 'undefined') {
        return;
    }
    errorListenerBound = true;
    document.addEventListener('error', (event) => {
        const image = event.target;
        if (!image?.matches?.('img[data-neoterra-avatar-img]')) {
            return;
        }
        image.style.display = 'none';
        const container = image.closest?.('[data-neoterra-avatar]');
        const fallback = container?.querySelector?.('[data-neoterra-avatar-fallback]');
        if (fallback) {
            fallback.style.display = '';
        }
    }, true);
}

/**
 * Load the manifest and prepare resolution for one registry/context pair.
 *
 * @param {{
 *   registry?: object|null,
 *   ctx?: object|null,
 *   characters?: object[]|null,
 *   fetchImpl?: typeof fetch,
 *   baseUrl?: string|null,
 *   reload?: boolean,
 * }} [options]
 */
export async function initAvatars(options = {}) {
    const registry = options.registry ?? state?.registry ?? null;
    const ctx = options.ctx ?? null;
    const characters = options.characters ?? ctx?.characters ?? state?.characters ?? null;
    let manifest = options.reload ? null : state?.manifest ?? null;
    if (!manifest) {
        try {
            manifest = await loadAvatarManifest({ fetchImpl: options.fetchImpl });
        } catch {
            manifest = null;
        }
    }
    state = {
        registry,
        characters,
        manifest,
        overrides: readAvatarOverrides(),
        baseUrl: options.baseUrl ?? state?.baseUrl ?? null,
        thumbnailUrl: thumbnailUrlFromContext(ctx) ?? state?.thumbnailUrl ?? null,
        characterIndex: buildInstalledCharacterIndex(characters),
    };
    bindImageFallback();
    return state;
}

/** Update the installed-card list after a chat switch or a sync. */
export function refreshAvatarContext({ registry, ctx, characters } = {}) {
    state = {
        registry: registry ?? state?.registry ?? null,
        characters: characters ?? ctx?.characters ?? state?.characters ?? null,
        manifest: state?.manifest ?? null,
        overrides: readAvatarOverrides(),
        baseUrl: state?.baseUrl ?? null,
        thumbnailUrl: thumbnailUrlFromContext(ctx) ?? state?.thumbnailUrl ?? null,
        characterIndex: null,
    };
    if (state.characters) {
        state.characterIndex = buildInstalledCharacterIndex(state.characters);
    }
    return state;
}

export function getAvatarState() {
    return state;
}

/** Resolve the portrait for a scene frame: the player, else the season lead. */
export function resolveSceneAvatar(ctx) {
    if (!state) {
        return null;
    }
    const neoterra = ctx?.chatMetadata?.neoterra ?? null;
    const world = neoterra?.worldState ?? null;
    const characterId = (world?.player?.identity === 'canon' ? world.player.characterId : null)
        ?? neoterra?.playerIdentity?.characterId
        ?? neoterra?.seasonDefinition?.defaultPlayerCharacterId
        ?? null;
    if (!characterId) {
        return null;
    }
    return resolveCharacterAvatar(characterId)?.url ?? null;
}

/** Display name for a character id, with the id as a last resort. */
export function characterNameFor(id) {
    const entry = findEntry(id);
    return entry?.displayName ?? entry?.dataName ?? String(id ?? '');
}

function findEntry(id) {
    if (!id || !state) {
        return null;
    }
    if (isObject(id) && typeof id.id === 'string') {
        return id;
    }
    return (state.registry?.entries ?? []).find((entry) => entry.id === id) ?? null;
}

/** Resolve once; returns null when only initials are available. */
export function resolveCharacterAvatar(id) {
    const entry = findEntry(id);
    if (!entry || !state) {
        return null;
    }
    return resolveAvatarForEntry(entry, {
        manifest: state.manifest,
        syncOverrides: state.overrides,
        characters: state.characters,
        characterIndex: state.characterIndex,
        baseUrl: state.baseUrl,
        thumbnailUrl: state.thumbnailUrl,
    });
}

/**
 * Portrait markup with an initials fallback.
 *
 * @param {string|object|null} id registry id or entry
 * @param {{ size?: 'sm'|'md'|'lg'|'xl', name?: string, className?: string, label?: string }} [options]
 */
export function avatarMarkup(id, options = {}) {
    const entry = findEntry(id);
    const name = options.name ?? entry?.displayName ?? entry?.dataName ?? '';
    const resolved = entry ? resolveCharacterAvatar(entry) : null;
    const size = options.size ?? 'md';
    const classes = ['neoterra-avatar', `neoterra-avatar-${size}`, options.className ?? '']
        .filter(Boolean)
        .join(' ');
    const fallback = initialsFor(name);
    const alt = options.label ?? name;
    if (!resolved?.url) {
        return `<span class="${classes}" data-neoterra-avatar data-avatar-source="initials">
            <span class="neoterra-avatar-fallback" data-neoterra-avatar-fallback aria-hidden="true">${escapeAvatarHtml(fallback)}</span>
        </span>`;
    }
    return `<span class="${classes}" data-neoterra-avatar data-avatar-source="${escapeAvatarHtml(resolved.kind)}">
        <img data-neoterra-avatar-img src="${escapeAvatarHtml(resolved.url)}"
            alt="${escapeAvatarHtml(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">
        <span class="neoterra-avatar-fallback" data-neoterra-avatar-fallback aria-hidden="true" style="display:none">${escapeAvatarHtml(fallback)}</span>
    </span>`;
}

/** Portrait for the character's active form, falling back to the base id. */
export function avatarMarkupForCharacter(character, fallbackId = null, options = {}) {
    const formId = character?.formId
        ?? character?.profileFormId
        ?? fallbackId
        ?? character?.charId
        ?? null;
    const id = formId && findEntry(formId) ? formId : (fallbackId ?? character?.charId ?? formId);
    return avatarMarkup(id, options);
}

/** Portrait row for present cast, ordered by the supplied ids. */
export function avatarStripMarkup(ids, { size = 'sm', className = '' } = {}) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (list.length === 0) {
        return '';
    }
    const portraits = list.map((id) => avatarMarkup(id, { size })).join('');
    return `<div class="neoterra-avatar-strip ${escapeAvatarHtml(className)}" data-neoterra-avatar-strip>${portraits}</div>`;
}
