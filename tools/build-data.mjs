#!/usr/bin/env node
/**
 * Build the season-scoped Neo Terra character/form registry.
 *
 * Runtime rule: Node built-ins only. The generated JSON is consumed by the
 * browser-side modules in `src/data/*`; the authored inputs live next to it.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCardProfile } from '../src/data/card-profile.js';
import { requirePngCard } from './png-card.mjs';
import {
    FORM_KINDS,
    SEASON_IDS,
    SIDES,
    validateCardSource,
    validateFormGroups,
    validateFormRules,
    validateRegistry,
} from '../src/data/schema.js';
import { validateSeasonDefinition } from '../src/data/seasons.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'data', 'characters', 'index.json');
const PROFILES_PATH = join(ROOT, 'data', 'characters', 'profiles.json');
const OVERRIDES_PATH = join(ROOT, 'data', 'characters', 'overrides.json');
const FORM_GROUPS_PATH = join(ROOT, 'data', 'form-groups.json');
const FORM_RULES_PATH = join(ROOT, 'data', 'form-rules.json');
const SEASON_DIR_PATH = join(ROOT, 'data', 'seasons');
const SEASON_INDEX_PATH = join(SEASON_DIR_PATH, 'index.json');

export const SEASON_DIRS = Object.freeze({
    s1: 'S1',
    s1dark: 'S1Dark',
    s2: 'S2',
    s3: 'S3',
    s4: 'S4',
    others: 'Others',
});

const SEASON_ORDER = new Map([
    ['s1', 0],
    ['s1dark', 1],
    ['s2', 2],
    ['s3', 3],
    ['s4', 4],
    ['others', 100],
]);

function seasonSortKey(seasonId) {
    if (SEASON_ORDER.has(seasonId)) {
        return [SEASON_ORDER.get(seasonId), seasonId];
    }
    const match = /^s(\d+)(dark)?$/.exec(seasonId);
    if (match) {
        return [10 + Number(match[1]), match[2] ? 1 : 0];
    }
    return [50, seasonId];
}

function compareSeasonIds(left, right) {
    const a = seasonSortKey(left);
    const b = seasonSortKey(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const av = a[index] ?? 0;
        const bv = b[index] ?? 0;
        if (av < bv) {
            return -1;
        }
        if (av > bv) {
            return 1;
        }
    }
    return 0;
}

/**
 * Discover card folders under `Chars/`.
 *
 * A new season is added by dropping `Chars/<Season>/` plus
 * `data/seasons/<id>.json`; no code change is required.
 */
export function discoverSeasonDirs(root = ROOT) {
    const charsDir = join(root, 'Chars');
    let entries;
    try {
        entries = readdirSync(charsDir, { withFileTypes: true });
    } catch (error) {
        throw new Error(`Cannot read ${charsDir}. Run this tool from the repository root (${error.message}).`);
    }
    const found = [];
    for (const dirent of entries) {
        if (!dirent.isDirectory()) {
            continue;
        }
        const seasonId = dirent.name.toLowerCase();
        if (seasonId === 'neohorizon' || seasonId === 'lore' || seasonId === 'lorebooks') {
            continue;
        }
        found.push({ seasonId, dir: dirent.name });
    }
    return found.sort((left, right) => compareSeasonIds(left.seasonId, right.seasonId));
}

const FORM_WORD_KINDS = new Set([
    'corrupted',
    'cleansed',
    'treated',
    'infected',
    'coldhearted',
    'knighted',
    'poisoned',
]);

const OVERRIDE_FIELDS = new Set([
    'id',
    'displayName',
    'aliases',
    'side',
    'threatLevel',
    'formKind',
    'tags',
    'bundle',
    'actors',
    'npcEligible',
]);

function toPosix(value) {
    return value.split('\\').join('/');
}

function normalizeKey(file) {
    return toPosix(file).replace(/^Chars\//, '');
}

function assertKnownSeason(seasonId, seasonIds = SEASON_IDS) {
    if (!seasonIds.includes(seasonId)) {
        throw new Error(`unknown season id "${String(seasonId)}"`);
    }
}

/**
 * Deterministic slug used by registry IDs.
 *
 * NFKD -> strip combining marks -> lowercase -> `&` becomes `and` -> remove
 * apostrophes -> every non `[a-z0-9]` run becomes a dot.
 */
export function slugify(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

/**
 * Split a filename into its display label and transformation label.
 *
 * The final parenthetical decides `formKind`; unrecognised parentheticals are
 * codenames, not transformations, so the card remains a base form.
 */
export function classifyFilename(filename) {
    const stem = basename(String(filename)).replace(/\.(?:json|png)$/i, '');
    const match = stem.match(/\(([^()]*)\)\s*$/);

    let formLabel = null;
    let rawBase = stem;
    if (match) {
        formLabel = match[1].trim();
        rawBase = stem.slice(0, match.index).trim();
    }

    rawBase = rawBase.replace(/\)+\s*$/, '').trim();
    const baseLabel = rawBase.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const firstWord = formLabel ? formLabel.toLowerCase().split(/\s+/)[0] : '';

    let formKind = 'base';
    if (FORM_WORD_KINDS.has(firstWord)) {
        formKind = firstWord;
    } else if (firstWord === 'recorrupted') {
        formKind = 'corrupted';
    } else if (firstWord === 'season' || firstWord === 'vampire') {
        formKind = 'alt-version';
    }

    return { formKind, baseLabel, formLabel };
}

function matchesTag(tag, candidates) {
    const normalized = String(tag).toLowerCase().replace(/[^a-z]/g, '');
    return candidates.has(normalized);
}

/** Parse aliases from the first `Aliases:` / `Common Aliases:` line(s). */
export function parseAliases(description) {
    if (typeof description !== 'string' || description.length === 0) {
        return [];
    }

    const aliases = [];
    const blockPattern =
        /^[ \t]*[^\n:]{0,60}?Aliases?(?:\/Codenames)?[ \t]*:[ \t]*([\s\S]*?)(?=\r?\n[ \t]*\r?\n|$)/gim;
    let match;
    while ((match = blockPattern.exec(description)) !== null) {
        // Dialogue often follows an alias list; drop quoted material before
        // splitting so a prose paragraph never becomes an alias.
        const value = match[1]
            .replace(/"[^"]*"/g, ' ')
            .replace(/\u201c[^\u201d]*\u201d/g, ' ');

        const fragments = value.split(/;[ \t]*|\.(?=\s|$)|[\r\n]+/);
        for (const fragment of fragments) {
            let alias = fragment
                .replace(/\([^)]*\)/g, ' ')
                .replace(/["\u201c\u201d]/g, '')
                .replace(/^[\s,;.\-\u2013\u2014]+|[\s,;.\-\u2013\u2014]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (!alias) {
                continue;
            }
            if (alias.length > 80 || alias.split(/\s+/).length > 10) {
                continue;
            }
            // A following metadata field (e.g. `Occupation: ...`) is not an
            // alias even when the card omits the blank line between fields.
            if (/^[A-Za-z][A-Za-z0-9 /'()-]{0,30}\s*:/.test(alias)) {
                continue;
            }
            if (!aliases.some((existing) => existing.toLowerCase() === alias.toLowerCase())) {
                aliases.push(alias);
            }
        }
    }

    return aliases;
}

/**
 * Resolve a side using the documented precedence:
 * explicit `Side:` line -> form kind -> tags -> neutral.
 */
export function parseSide(description, formKind = 'base', tags = []) {
    if (typeof description === 'string') {
        const sideLine = description.match(/^[ \t]*Side[ \t]*:[ \t]*(.+)$/im);
        if (sideLine) {
            // Parentheticals usually describe a former faction; the leading
            // affiliation is the current side.
            const raw = sideLine[1].replace(/\([^)]*\)/g, ' ').trim().toLowerCase();
            if (raw.includes('noah') || raw.includes('ginny') || raw.includes('regime') || raw.includes('army')) {
                return 'villain';
            }
            if (raw.includes('crisis coalition')) {
                return 'hero';
            }
            const normalized = raw.replace(/[^a-z]/g, '');
            if (SIDES.includes(normalized)) {
                return normalized;
            }
        }
    }

    if (['corrupted', 'treated', 'infected', 'coldhearted', 'knighted', 'poisoned'].includes(formKind)) {
        return 'villain';
    }
    if (formKind === 'cleansed') {
        return 'hero';
    }

    const normalizedTags = Array.isArray(tags) ? tags : [];
    if (
        normalizedTags.some((tag) =>
            matchesTag(tag, new Set(['villain', 'villainess', 'evil', 'supervillain'])),
        )
    ) {
        return 'villain';
    }
    if (
        normalizedTags.some((tag) =>
            matchesTag(tag, new Set(['hero', 'heroine', 'superhero', 'superheroine'])),
        )
    ) {
        return 'hero';
    }
    if (normalizedTags.some((tag) => matchesTag(tag, new Set(['vigilante'])))) {
        return 'vigilante';
    }

    return 'neutral';
}

/**
 * Parse `Threat Level:`. Returns the normalized first token plus the raw line.
 */
export function parseThreatLevel(description) {
    if (typeof description !== 'string') {
        return { level: null, raw: null };
    }
    const match = description.match(/^[ \t]*Threat Level[ \t]*:[ \t]*(.+)$/im);
    if (!match) {
        return { level: null, raw: null };
    }
    const raw = match[1].trim();
    const first = raw.split(/\s+/)[0].replace(/[,.;:]+$/, '');
    return { level: first || null, raw };
}

/**
 * Parse one card into a registry entry before overrides/group resolution.
 */
export function parseCard(raw, { file, seasonId, seasonIds = SEASON_IDS, avatarPath = null }) {
    assertKnownSeason(seasonId, seasonIds);
    const validation = validateCardSource(raw);
    if (!validation.ok) {
        const reason = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
        throw new Error(`${file}: invalid character card (${reason})`);
    }

    const data = raw.data;
    const description = data.description;
    const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [];
    const filename = basename(file);
    const { formKind, baseLabel } = classifyFilename(filename);
    const stem = filename.replace(/\.(?:json|png)$/i, '');
    const dataName = data.name.trim();
    const displayName = baseLabel || dataName;
    const aliases = parseAliases(description);
    const side = parseSide(description, formKind, tags);
    const threat = parseThreatLevel(description);

    const entry = {
        id: `${seasonId}.${slugify(stem)}`,
        file: toPosix(file),
        cardPath: toPosix(file).startsWith('Chars/') ? toPosix(file) : `Chars/${toPosix(file)}`,
        seasonId,
        dataName,
        displayName,
        aliases,
        side,
        threatLevel: threat.level,
        formRole: 'base',
        altOf: null,
        formKind,
        formGroup: null,
        tags,
        bundle: false,
        actors: null,
        npcEligible: true,
    };
    if (threat.raw !== null) {
        entry.threatLevelRaw = threat.raw;
    }
    if (typeof avatarPath === 'string' && avatarPath.length > 0) {
        entry.avatarPath = toPosix(avatarPath);
    }
    return entry;
}

function applyOverride(entry, override, key) {
    if (override === null || typeof override !== 'object') {
        throw new Error(`${key}: override must be an object`);
    }

    for (const field of Object.keys(override)) {
        if (!OVERRIDE_FIELDS.has(field)) {
            continue; // `notes` and future metadata stay out of the registry
        }
        if (field === 'id') {
            if (typeof override.id !== 'string' || override.id.length === 0) {
                throw new Error(`${key}: override id must be a non-empty string`);
            }
            entry.id = override.id;
        } else if (field === 'displayName') {
            if (typeof override.displayName !== 'string' || override.displayName.trim().length === 0) {
                throw new Error(`${key}: override displayName must be a non-empty string`);
            }
            entry.displayName = override.displayName.trim();
        } else if (field === 'aliases') {
            if (!Array.isArray(override.aliases) || !override.aliases.every((item) => typeof item === 'string')) {
                throw new Error(`${key}: override aliases must be an array of strings`);
            }
            entry.aliases = [...override.aliases];
        } else if (field === 'side') {
            if (!SIDES.includes(override.side)) {
                throw new Error(`${key}: override side "${String(override.side)}" is not valid`);
            }
            entry.side = override.side;
        } else if (field === 'threatLevel') {
            if (override.threatLevel !== null && typeof override.threatLevel !== 'string') {
                throw new Error(`${key}: override threatLevel must be a string or null`);
            }
            entry.threatLevel = override.threatLevel;
            if (override.threatLevel === null) {
                delete entry.threatLevelRaw;
            }
        } else if (field === 'formKind') {
            if (!FORM_KINDS.includes(override.formKind)) {
                throw new Error(`${key}: override formKind "${String(override.formKind)}" is not valid`);
            }
            entry.formKind = override.formKind;
        } else if (field === 'tags') {
            if (!Array.isArray(override.tags) || !override.tags.every((item) => typeof item === 'string')) {
                throw new Error(`${key}: override tags must be an array of strings`);
            }
            entry.tags = [...override.tags];
        } else if (field === 'bundle') {
            if (typeof override.bundle !== 'boolean') {
                throw new Error(`${key}: override bundle must be a boolean`);
            }
            entry.bundle = override.bundle;
        } else if (field === 'actors') {
            if (override.actors !== null && !Array.isArray(override.actors)) {
                throw new Error(`${key}: override actors must be an array or null`);
            }
            entry.actors = override.actors === null ? null : override.actors.map((actor) => ({ ...actor }));
        }
        // npcEligible is derived from bundle at the end of buildRegistry.
    }
}

function applyOverrides(entries, overrides) {
    const entriesByKey = new Map(entries.map((entry) => [normalizeKey(entry.file), entry]));
    const overrideEntries = overrides && typeof overrides === 'object' ? overrides.entries : null;
    if (!overrideEntries || typeof overrideEntries !== 'object') {
        throw new Error(`${OVERRIDES_PATH}: overrides.entries must be an object`);
    }

    for (const [key, override] of Object.entries(overrideEntries)) {
        const entry = entriesByKey.get(normalizeKey(key));
        if (!entry) {
            throw new Error(`overrides.json: no card found for override "${key}"`);
        }
        applyOverride(entry, override, key);
    }
}

function resolveGroups(entries, formGroups) {
    const entriesByKey = new Map(entries.map((entry) => [normalizeKey(entry.file), entry]));

    for (const group of formGroups.groups) {
        const baseKey = normalizeKey(group.base);
        const baseEntry = entriesByKey.get(baseKey);
        if (!baseEntry) {
            throw new Error(`form group "${group.id}": base card "${group.base}" does not exist`);
        }

        for (const member of group.members) {
            const memberKey = normalizeKey(member);
            const entry = entriesByKey.get(memberKey);
            if (!entry) {
                throw new Error(`form group "${group.id}": member card "${member}" does not exist`);
            }
            // Cross-season packs are allowed: a form group may collect an
            // alternate from another season (e.g. Blazing Prism / Light Shade).
            if (entry.formGroup !== null && entry.formGroup !== group.id) {
                throw new Error(
                    `form group "${group.id}": member "${member}" already belongs to "${entry.formGroup}"`,
                );
            }

            entry.formGroup = group.id;
            if (memberKey === baseKey) {
                entry.formRole = 'base';
                entry.altOf = null;
            } else {
                entry.formRole = 'alt';
                entry.altOf = baseEntry.id;
            }
        }
    }
}

function sortEntries(entries, seasonIds = SEASON_IDS) {
    const order = new Map(seasonIds.map((seasonId, index) => [seasonId, index]));
    return entries.sort((left, right) => {
        const leftSeason = order.get(left.seasonId) ?? Number.MAX_SAFE_INTEGER;
        const rightSeason = order.get(right.seasonId) ?? Number.MAX_SAFE_INTEGER;
        if (leftSeason !== rightSeason) {
            return leftSeason - rightSeason;
        }
        if (left.id < right.id) {
            return -1;
        }
        if (left.id > right.id) {
            return 1;
        }
        return 0;
    });
}

/**
 * Build a deterministic registry from raw cards and authored inputs.
 *
 * @param {{
 *   cards: Array<{ file: string, seasonId?: string, raw: unknown }>,
 *   overrides: { entries: Record<string, object> },
 *   formGroups: { groups: Array<object> },
 * }} input
 */
export function buildRegistry({ cards, overrides, formGroups, seasonIds = SEASON_IDS }) {
    if (!Array.isArray(cards)) {
        throw new Error('buildRegistry: cards must be an array');
    }
    if (!formGroups || !Array.isArray(formGroups.groups)) {
        throw new Error('buildRegistry: formGroups.groups must be an array');
    }
    if (!Array.isArray(seasonIds) || seasonIds.length === 0) {
        throw new Error('buildRegistry: seasonIds must be a non-empty array');
    }

    const entries = cards.map((card) => {
        if (!card || typeof card !== 'object') {
            throw new Error('buildRegistry: every card must be an object');
        }
        const file = toPosix(card.file);
        const seasonId = card.seasonId ?? seasonIdFromPath(file, seasonIds);
        return parseCard(card.raw, {
            file,
            seasonId,
            seasonIds,
            avatarPath: card.avatarPath ?? null,
        });
    });

    applyOverrides(entries, overrides);
    resolveGroups(entries, formGroups);

    for (const entry of entries) {
        entry.npcEligible = entry.bundle ? false : true;
        if (!entry.bundle) {
            entry.actors = null;
        }
    }

    const unique = new Set();
    for (const entry of entries) {
        if (unique.has(entry.id)) {
            throw new Error(`duplicate registry id "${entry.id}"`);
        }
        unique.add(entry.id);
    }

    sortEntries(entries, seasonIds);

    const counts = Object.fromEntries(seasonIds.map((seasonId) => [seasonId, 0]));
    for (const entry of entries) {
        counts[entry.seasonId] = (counts[entry.seasonId] ?? 0) + 1;
    }
    counts.total = entries.length;

    return {
        schemaVersion: 1,
        generatedBy: 'tools/build-data.mjs',
        source: 'Chars',
        counts,
        entries,
    };
}

/**
 * Build the generated `data/characters/profiles.json` artifact.
 *
 * Keys are the final registry ids (after overrides), and each profile records
 * the card it came from so a stale entry cannot silently point at a different
 * file. Unreadable descriptions are build errors, not empty profiles.
 *
 * @param {{
 *   cards: Array<{ file: string, raw: unknown }>,
 *   registry: { entries: Array<{ id: string, file: string, cardPath: string }> },
 * }} input
 */
export function buildProfiles({ cards, registry }) {
    if (!Array.isArray(cards)) {
        throw new Error('buildProfiles: cards must be an array');
    }
    if (!Array.isArray(registry?.entries)) {
        throw new Error('buildProfiles: registry.entries must be an array');
    }

    const cardsByFile = new Map(cards.map((card) => [normalizeKey(card.file), card]));
    const profiles = {};
    const errors = [];
    let missingAppearance = 0;

    for (const entry of registry.entries) {
        const card = cardsByFile.get(normalizeKey(entry.file));
        if (!card) {
            errors.push(`${entry.file}: no card source found for registry entry "${entry.id}"`);
            continue;
        }
        // Derive the path from the file, not from the entry, so a registry entry
        // whose cardPath drifts is a real error instead of a tautology.
        const file = toPosix(entry.file);
        const expectedCardPath = file.startsWith('Chars/') ? file : `Chars/${file}`;
        const profile = parseCardProfile(card.raw, {
            file: entry.file,
            cardPath: expectedCardPath,
        });
        if (!profile) {
            errors.push(`${entry.file}: cannot read data.description for profile "${entry.id}"`);
            continue;
        }
        if (profile.source.cardPath !== entry.cardPath) {
            errors.push(
                `${entry.file}: profile cardPath "${profile.source.cardPath}" does not match registry cardPath "${entry.cardPath}"`,
            );
            continue;
        }
        if (profile.missing.includes('appearance')) {
            missingAppearance += 1;
        }
        profiles[entry.id] = profile;
    }

    return {
        artifact: {
            schemaVersion: 1,
            generatedBy: 'tools/build-data.mjs',
            source: 'Chars',
            counts: {
                profiles: Object.keys(profiles).length,
                missingAppearance,
            },
            profiles,
        },
        errors,
    };
}

export function seasonIdFromPath(file, seasonIds = SEASON_IDS) {
    const normalized = normalizeKey(file);
    const top = normalized.split('/')[0];
    for (const dir of Object.values(SEASON_DIRS)) {
        if (dir === top) {
            return dir.toLowerCase();
        }
    }
    const inferred = top.toLowerCase();
    if (seasonIds.includes(inferred)) {
        return inferred;
    }
    throw new Error(`${file}: cannot infer a season from its folder`);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Read one season folder. JSON cards are the primary source; a `.png` with a
 * matching JSON twin only contributes its art (`avatarPath`), while a PNG with
 * no twin is read as a full card from its embedded `chara`/`ccv3` chunk.
 *
 * @param {{ absolute: string, seasonId: string, dir: string }} input
 * @returns {{ cards: Array<object>, errors: Array<{ file: string, reason: string }> }}
 */
export function readCardsFromDirectory({ absolute, seasonId, dir }) {
    const cards = [];
    const errors = [];
    const byStem = new Map();
    const pngs = [];

    for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
        if (!dirent.isFile()) {
            continue;
        }
        const lower = dirent.name.toLowerCase();
        if (lower.endsWith('.json')) {
            const file = `Chars/${dir}/${dirent.name}`;
            try {
                const raw = readJson(join(absolute, dirent.name));
                const validation = validateCardSource(raw);
                if (!validation.ok) {
                    errors.push({
                        file,
                        reason: validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
                    });
                    continue;
                }
                const card = { file, seasonId, raw };
                cards.push(card);
                byStem.set(basename(dirent.name, '.json').toLowerCase(), card);
            } catch (error) {
                errors.push({ file, reason: error instanceof Error ? error.message : String(error) });
            }
        } else if (lower.endsWith('.png')) {
            pngs.push(dirent.name);
        }
    }

    for (const name of pngs.sort()) {
        const pngFile = `Chars/${dir}/${name}`;
        const stem = basename(name, '.png').toLowerCase();
        const twin = byStem.get(stem) ?? null;
        if (twin) {
            twin.avatarPath = pngFile;
            continue;
        }
        try {
            const buffer = readFileSync(join(absolute, name));
            const raw = requirePngCard(buffer, pngFile);
            const validation = validateCardSource(raw);
            if (!validation.ok) {
                errors.push({
                    file: pngFile,
                    reason: validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
                });
                continue;
            }
            const card = { file: pngFile, seasonId, raw, avatarPath: pngFile };
            cards.push(card);
            byStem.set(stem, card);
        } catch (error) {
            errors.push({ file: pngFile, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    return { cards, errors };
}

function readCards(seasonDirs) {
    const cards = [];
    const errors = [];

    for (const { seasonId, dir } of seasonDirs) {
        const result = readCardsFromDirectory({
            absolute: join(ROOT, 'Chars', dir),
            seasonId,
            dir,
        });
        cards.push(...result.cards);
        errors.push(...result.errors);
    }

    return { cards, errors };
}

function seasonIdFromFilename(filename) {
    return basename(filename)
        .replace(/\.json$/i, '')
        .replace(/\.aux$/i, '');
}

/**
 * Read and structurally check `data/seasons/*.json`.
 *
 * `index.json` is generated output, not an authored season.
 */
export function readSeasonDocuments(directory = SEASON_DIR_PATH) {
    const documents = [];
    const errors = [];

    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
        if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.json') || dirent.name === 'index.json') {
            continue;
        }
        const file = `data/seasons/${dirent.name}`;
        let document;
        try {
            document = readJson(join(directory, dirent.name));
        } catch (error) {
            errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        const expectedId = seasonIdFromFilename(dirent.name);
        if (!document || typeof document !== 'object') {
            errors.push(`${file}: season document must be an object`);
            continue;
        }
        if (document.id !== expectedId) {
            errors.push(`${file}: id "${document.id}" does not match filename id "${expectedId}"`);
            continue;
        }
        documents.push({ ...document, file: dirent.name });
    }

    documents.sort((left, right) => compareSeasonIds(left.id, right.id));
    const seen = new Set();
    for (const document of documents) {
        if (seen.has(document.id)) {
            errors.push(`${document.file}: duplicate season id "${document.id}"`);
        }
        seen.add(document.id);
    }

    return { documents, errors };
}

/** Build the generated `data/seasons/index.json` manifest. */
export function buildSeasonIndex(documents, seasonDirs = []) {
    const folderById = new Map(
        seasonDirs.map((entry) => [entry.seasonId, entry.dir]),
    );
    const seasons = documents
        .map((document) => ({
            id: document.id,
            file: document.file,
            playable: document.playable !== false,
            folder: folderById.get(document.id) ?? null,
        }))
        .sort((left, right) => compareSeasonIds(left.id, right.id));
    return {
        schemaVersion: 1,
        generatedBy: 'tools/build-data.mjs',
        seasons,
    };
}

function formatValidationErrors(label, validation) {
    return validation.errors.map((error) => `${label}: ${error.path}: ${error.message}`);
}

/**
 * Form-data coverage gate: every alternate card belongs to a group and every
 * group member is reachable from at least one declared rule.
 */
export function validateFormCoverage(registry, formRules, documents = []) {
    const errors = [];
    const rules = Array.isArray(formRules) ? formRules : (formRules?.rules ?? []);
    const targets = new Set(rules.map((rule) => rule?.to).filter(Boolean));
    const byId = new Map((registry?.entries ?? []).map((entry) => [entry.id, entry]));
    for (const entry of registry?.entries ?? []) {
        if (entry.formRole === 'alt' && !entry.formGroup) {
            errors.push(`form coverage: alternate card "${entry.id}" belongs to no form group`);
        }
        if (entry.formRole === 'alt' && entry.formGroup && !targets.has(entry.id)) {
            errors.push(`form coverage: alternate card "${entry.id}" has no incoming transformation rule`);
        }
    }
    for (const document of documents) {
        for (const id of document.altFormsAllowed ?? []) {
            const entry = byId.get(id);
            if (!entry) {
                errors.push(`form coverage: ${document.id}.altFormsAllowed references unknown id "${id}"`);
            } else if (!entry.formGroup) {
                errors.push(`form coverage: ${document.id}.altFormsAllowed id "${id}" is not in a form group`);
            }
        }
    }
    return errors;
}

function validateSeasonDocuments(documents, registry) {    const errors = [];
    const factions = readJson(join(ROOT, 'data', 'factions.json'));
    const locations = readJson(join(ROOT, 'data', 'locations.json'));
    const districts = readJson(join(ROOT, 'data', 'districts.json'));
    const seasonIds = documents.map((document) => document.id);

    for (const document of documents) {
        const validation = validateSeasonDefinition(document, {
            registry,
            factions,
            locations,
            districts,
            seasonIds,
        });
        if (!validation.ok) {
            errors.push(...formatValidationErrors(document.file, validation));
        }
    }

    return errors;
}

function buildAndValidate() {
    const seasonDirs = discoverSeasonDirs();
    const seasonIds = seasonDirs.map((entry) => entry.seasonId);
    const { cards, errors: cardErrors } = readCards(seasonDirs);
    if (cardErrors.length > 0) {
        return { errors: cardErrors.map((error) => `${error.file}: ${error.reason}`) };
    }

    const overrides = readJson(OVERRIDES_PATH);
    const formGroups = readJson(FORM_GROUPS_PATH);
    const formRules = readJson(FORM_RULES_PATH);

    const errors = [];
    const groupsValidation = validateFormGroups(formGroups, { seasonIds });
    if (!groupsValidation.ok) {
        errors.push(...formatValidationErrors('form-groups.json', groupsValidation));
    }

    let registry;
    try {
        registry = buildRegistry({ cards, overrides, formGroups, seasonIds });
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { errors };
    }

    const registryValidation = validateRegistry(registry, { seasonIds });
    if (!registryValidation.ok) {
        errors.push(...formatValidationErrors('index.json', registryValidation));
    }

    const { artifact: profiles, errors: profileErrors } = buildProfiles({ cards, registry });
    errors.push(...profileErrors);
    if (profileErrors.length > 0) {
        return { errors };
    }

    const rulesValidation = validateFormRules(formRules, registry);
    if (!rulesValidation.ok) {
        errors.push(...formatValidationErrors('form-rules.json', rulesValidation));
    }

    const { documents, errors: seasonErrors } = readSeasonDocuments();
    errors.push(...seasonErrors);
    errors.push(...validateFormCoverage(registry, formRules, documents));
    if (seasonErrors.length === 0) {
        errors.push(...validateSeasonDocuments(documents, registry));
    }
    const seasonIndex = buildSeasonIndex(documents, seasonDirs);

    return { registry, seasonIndex, profiles, errors };
}

function summary(registry, seasonIndex, profiles) {
    const lines = [];
    const seasonIds = [...new Set([
        ...seasonIndex.seasons.map((season) => season.id),
        ...Object.keys(registry.counts).filter((key) => key !== 'total'),
    ])];
    lines.push(
        `Neo Terra registry: ${registry.counts.total} cards (` +
            seasonIds
                .filter((seasonId) => Object.hasOwn(registry.counts, seasonId))
                .map((seasonId) => `${seasonId}=${registry.counts[seasonId]}`)
                .join(', ') +
            ')',
    );
    lines.push(`Bundles: ${registry.entries.filter((entry) => entry.bundle).length}`);
    lines.push(`Form groups: ${new Set(registry.entries.map((entry) => entry.formGroup).filter(Boolean)).size}`);
    lines.push(
        `Profiles: ${profiles.counts.profiles} (${profiles.counts.missingAppearance} without Appearance)`,
    );
    lines.push(`Seasons: ${seasonIndex.seasons.map((season) => `${season.id}${season.playable ? '' : ' (not playable)'}`).join(', ')}`);
    return lines.join('\n');
}

function printErrors(errors) {
    for (const error of errors) {
        console.error(`[build-data] ${error}`);
    }
}

export function compareGeneratedFile(path, serialized, label, errors) {
    let existing;
    try {
        existing = readFileSync(path, 'utf8');
    } catch (error) {
        errors.push(`${relative(ROOT, path)}: cannot read generated file (${error.message})`);
        return;
    }
    if (existing !== serialized) {
        errors.push(`${relative(ROOT, path)}: ${label} out of date; run node tools/build-data.mjs`);
    }
}

export function main(argv = process.argv.slice(2)) {
    const check = argv.includes('--check');
    const { registry, seasonIndex, profiles, errors } = buildAndValidate();

    if (errors.length > 0) {
        printErrors(errors);
        return 1;
    }

    const registryText = `${JSON.stringify(registry, null, 2)}\n`;
    const seasonIndexText = `${JSON.stringify(seasonIndex, null, 2)}\n`;
    const profilesText = `${JSON.stringify(profiles, null, 2)}\n`;

    if (check) {
        const checkErrors = [];
        compareGeneratedFile(REGISTRY_PATH, registryText, 'registry', checkErrors);
        compareGeneratedFile(SEASON_INDEX_PATH, seasonIndexText, 'season index', checkErrors);
        compareGeneratedFile(PROFILES_PATH, profilesText, 'character profiles', checkErrors);
        if (checkErrors.length > 0) {
            printErrors(checkErrors);
            return 1;
        }
        console.log(`Registry is up to date. ${summary(registry, seasonIndex, profiles)}`);
        return 0;
    }

    writeFileSync(REGISTRY_PATH, registryText);
    writeFileSync(SEASON_INDEX_PATH, seasonIndexText);
    writeFileSync(PROFILES_PATH, profilesText);
    console.log(
        `Wrote ${relative(ROOT, REGISTRY_PATH)}, ${relative(ROOT, SEASON_INDEX_PATH)} and ${relative(ROOT, PROFILES_PATH)}.`,
    );
    console.log(summary(registry, seasonIndex, profiles));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main();
}
