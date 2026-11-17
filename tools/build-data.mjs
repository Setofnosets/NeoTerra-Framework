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

import {
    FORM_KINDS,
    SEASON_IDS,
    SIDES,
    validateCardSource,
    validateFormGroups,
    validateFormRules,
    validateRegistry,
} from '../src/data/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'data', 'characters', 'index.json');
const OVERRIDES_PATH = join(ROOT, 'data', 'characters', 'overrides.json');
const FORM_GROUPS_PATH = join(ROOT, 'data', 'form-groups.json');
const FORM_RULES_PATH = join(ROOT, 'data', 'form-rules.json');

export const SEASON_DIRS = Object.freeze({
    s1: 'S1',
    s1dark: 'S1Dark',
    s2: 'S2',
    s3: 'S3',
    s4: 'S4',
    others: 'Others',
});

const SEASON_INDEX = new Map(SEASON_IDS.map((seasonId, index) => [seasonId, index]));

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

function assertKnownSeason(seasonId) {
    if (!SEASON_INDEX.has(seasonId)) {
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
    const stem = basename(String(filename)).replace(/\.json$/i, '');
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
export function parseCard(raw, { file, seasonId }) {
    assertKnownSeason(seasonId);
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
    const stem = filename.replace(/\.json$/i, '');
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
            if (entry.seasonId !== group.seasonId) {
                throw new Error(
                    `form group "${group.id}": member "${member}" belongs to ${entry.seasonId}, not ${group.seasonId}`,
                );
            }
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

function sortEntries(entries) {
    return entries.sort((left, right) => {
        const leftSeason = SEASON_INDEX.get(left.seasonId) ?? Number.MAX_SAFE_INTEGER;
        const rightSeason = SEASON_INDEX.get(right.seasonId) ?? Number.MAX_SAFE_INTEGER;
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
export function buildRegistry({ cards, overrides, formGroups }) {
    if (!Array.isArray(cards)) {
        throw new Error('buildRegistry: cards must be an array');
    }
    if (!formGroups || !Array.isArray(formGroups.groups)) {
        throw new Error('buildRegistry: formGroups.groups must be an array');
    }

    const entries = cards.map((card) => {
        if (!card || typeof card !== 'object') {
            throw new Error('buildRegistry: every card must be an object');
        }
        const file = toPosix(card.file);
        const seasonId = card.seasonId ?? seasonIdFromPath(file);
        return parseCard(card.raw, { file, seasonId });
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

    sortEntries(entries);

    const counts = Object.fromEntries(SEASON_IDS.map((seasonId) => [seasonId, 0]));
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

export function seasonIdFromPath(file) {
    const normalized = normalizeKey(file);
    const top = normalized.split('/')[0];
    for (const [seasonId, dir] of Object.entries(SEASON_DIRS)) {
        if (dir === top) {
            return seasonId;
        }
    }
    throw new Error(`${file}: cannot infer a season from its folder`);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readCards() {
    const cards = [];
    const errors = [];

    for (const seasonId of SEASON_IDS) {
        const dir = SEASON_DIRS[seasonId];
        const absolute = join(ROOT, 'Chars', dir);
        for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
            if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.json')) {
                continue;
            }
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
                cards.push({ file, seasonId, raw });
            } catch (error) {
                errors.push({ file, reason: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    return { cards, errors };
}

function formatValidationErrors(label, validation) {
    return validation.errors.map((error) => `${label}: ${error.path}: ${error.message}`);
}

function buildAndValidate() {
    const { cards, errors: cardErrors } = readCards();
    if (cardErrors.length > 0) {
        return { errors: cardErrors.map((error) => `${error.file}: ${error.reason}`) };
    }

    const overrides = readJson(OVERRIDES_PATH);
    const formGroups = readJson(FORM_GROUPS_PATH);
    const formRules = readJson(FORM_RULES_PATH);

    const errors = [];
    const groupsValidation = validateFormGroups(formGroups);
    if (!groupsValidation.ok) {
        errors.push(...formatValidationErrors('form-groups.json', groupsValidation));
    }

    let registry;
    try {
        registry = buildRegistry({ cards, overrides, formGroups });
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { errors };
    }

    const registryValidation = validateRegistry(registry);
    if (!registryValidation.ok) {
        errors.push(...formatValidationErrors('index.json', registryValidation));
    }

    const rulesValidation = validateFormRules(formRules, registry);
    if (!rulesValidation.ok) {
        errors.push(...formatValidationErrors('form-rules.json', rulesValidation));
    }

    return { registry, errors };
}

function summary(registry) {
    const lines = [];
    lines.push(
        `Neo Terra registry: ${registry.counts.total} cards (` +
            SEASON_IDS.map((seasonId) => `${seasonId}=${registry.counts[seasonId]}`).join(', ') +
            ')',
    );
    lines.push(`Bundles: ${registry.entries.filter((entry) => entry.bundle).length}`);
    lines.push(`Form groups: ${new Set(registry.entries.map((entry) => entry.formGroup).filter(Boolean)).size}`);
    return lines.join('\n');
}

function printErrors(errors) {
    for (const error of errors) {
        console.error(`[build-data] ${error}`);
    }
}

export function main(argv = process.argv.slice(2)) {
    const check = argv.includes('--check');
    const { registry, errors } = buildAndValidate();

    if (errors.length > 0) {
        printErrors(errors);
        return 1;
    }

    const serialized = `${JSON.stringify(registry, null, 2)}\n`;

    if (check) {
        let existing;
        try {
            existing = readFileSync(REGISTRY_PATH, 'utf8');
        } catch (error) {
            printErrors([`${REGISTRY_PATH}: cannot read existing registry (${error.message})`]);
            return 1;
        }
        if (existing !== serialized) {
            printErrors(['registry out of date; run node tools/build-data.mjs']);
            return 1;
        }
        console.log(`Registry is up to date. ${summary(registry)}`);
        return 0;
    }

    writeFileSync(REGISTRY_PATH, serialized);
    console.log(`Wrote ${relative(ROOT, REGISTRY_PATH)}.`);
    console.log(summary(registry));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main();
}
