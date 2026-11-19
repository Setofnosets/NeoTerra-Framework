#!/usr/bin/env node
/**
 * Build the generated portrait manifest (`data/characters/avatars.json`).
 *
 * The manifest maps a registry character id to a portrait file. Sources are
 * PNG character cards: the embedded `chara` JSON provides the card name and
 * aliases, and the filename provides a second chance when the embedded card is
 * missing. Ambiguous matches are never guessed; they need an explicit entry in
 * `data/characters/avatar-overrides.json`.
 *
 * Runtime reads the manifest, then a per-user sync override, then the user's
 * installed SillyTavern cards. The browser never writes this repository.
 */

import { createHash } from 'node:crypto';
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseAliases } from './build-data.mjs';
import { extractPngCard } from './png-card.mjs';
import { cardFingerprint } from '../src/data/avatars.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'data', 'characters', 'index.json');
const AVATARS_PATH = join(ROOT, 'data', 'characters', 'avatars.json');
const OVERRIDES_PATH = join(ROOT, 'data', 'characters', 'avatar-overrides.json');
const ASSETS_DIR = join(ROOT, 'assets', 'avatars');

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

function toPosix(value) {
    return String(value).split('\\').join('/');
}

function walkPngs(directory, base = directory) {
    const found = [];
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, dirent.name);
        if (dirent.isDirectory()) {
            found.push(...walkPngs(absolute, base));
        } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.png')) {
            found.push({ absolute, relative: toPosix(relative(base, absolute)) });
        }
    }
    return found.sort((left, right) => left.relative.localeCompare(right.relative));
}

function filenameCandidates(name) {
    const stem = basename(name).replace(/\.png$/i, '');
    const candidates = new Set([stem]);
    const withoutForm = stem.replace(/\s*\([^()]*\)\s*$/g, '').trim();
    if (withoutForm) {
        candidates.add(withoutForm);
    }
    // `Vaiva Petrauskait_Colorgarde _ Spoiled heiress Superhero` → the part
    // before the first underscore is the canonical card name.
    const underscore = stem.split(/\s*_\s*/)[0]?.trim();
    if (underscore) {
        candidates.add(underscore);
    }
    const dash = stem.split(/\s+-\s+/)[0]?.trim();
    if (dash) {
        candidates.add(dash);
    }
    return [...candidates].filter(Boolean);
}

/** Candidate names for one PNG, strongest first. */
export function buildPngCandidates(buffer, filename) {
    const candidates = [];
    let card = null;
    try {
        card = extractPngCard(buffer)?.card ?? null;
    } catch {
        card = null;
    }
    const dataName = typeof card?.data?.name === 'string' ? card.data.name.trim() : '';
    if (dataName) {
        candidates.push({ key: normalizeAvatarName(dataName), source: 'card', weight: 100 });
    }
    const description = typeof card?.data?.description === 'string' ? card.data.description : '';
    for (const alias of parseAliases(description)) {
        candidates.push({ key: normalizeAvatarName(alias), source: 'alias', weight: 90 });
    }
    for (const candidate of filenameCandidates(filename)) {
        candidates.push({ key: normalizeAvatarName(candidate), source: 'filename', weight: 70 });
    }
    return {
        candidates: candidates.filter((candidate) => candidate.key.length > 0),
        embedded: Boolean(card),
    };
}

export function buildRegistryNameIndex(registry) {
    const index = new Map();
    const add = (name, entry, kind) => {
        const key = normalizeAvatarName(name);
        if (!key) {
            return;
        }
        const list = index.get(key) ?? [];
        if (!list.some((item) => item.id === entry.id && item.kind === kind)) {
            list.push({ id: entry.id, kind });
        }
        index.set(key, list);
    };
    for (const entry of registry?.entries ?? []) {
        if (entry?.bundle === true) {
            continue;
        }
        add(entry.dataName, entry, 'dataName');
        add(entry.displayName, entry, 'displayName');
        for (const alias of entry.aliases ?? []) {
            add(alias, entry, 'alias');
        }
    }
    return index;
}

/**
 * Match one PNG to registry entries.
 *
 * @returns {{ registryId: string|null, reason: string, candidates: string[] }}
 */
export function matchPngToRegistry({ buffer, relativePath }, registryIndex, overrides = {}) {
    const override = overrides[toPosix(relativePath)];
    if (typeof override === 'string') {
        return { registryId: override, reason: 'override', candidates: [] };
    }

    const { candidates } = buildPngCandidates(buffer, relativePath);
    const scores = new Map();
    for (const candidate of candidates) {
        for (const match of registryIndex.get(candidate.key) ?? []) {
            const current = scores.get(match.id) ?? 0;
            const kindBoost = match.kind === 'dataName' ? 2 : match.kind === 'displayName' ? 1 : 0;
            scores.set(match.id, Math.max(current, candidate.weight + kindBoost));
        }
    }
    if (scores.size === 0) {
        return { registryId: null, reason: 'no-match', candidates: candidates.map((entry) => entry.key) };
    }
    const ranked = [...scores.entries()].sort((left, right) => (
        right[1] - left[1] || left[0].localeCompare(right[0])
    ));
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
        return {
            registryId: null,
            reason: 'ambiguous',
            candidates: ranked.filter(([, score]) => score === ranked[0][1]).map(([id]) => id),
        };
    }
    return { registryId: ranked[0][0], reason: 'match', candidates: [] };
}

function hashBuffer(buffer) {
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/**
 * Build the manifest from a directory of PNG cards.
 *
 * @param {{
 *   sourceDir: string,
 *   registry: object,
 *   overrides?: Record<string, string>,
 *   copy?: boolean,
 *   assetsDir?: string,
 *   root?: string,
 * }} options
 */
export function buildAvatarManifest({
    sourceDir,
    registry,
    overrides = {},
    copy = true,
    assetsDir = ASSETS_DIR,
    root = ROOT,
}) {
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
        throw new Error('buildAvatarManifest requires a source directory');
    }
    const absoluteSource = resolve(sourceDir);
    let pngs;
    try {
        pngs = walkPngs(absoluteSource);
    } catch (error) {
        throw new Error(`Cannot read avatar source "${sourceDir}" (${error.message})`);
    }

    const registryIndex = buildRegistryNameIndex(registry);
    const registryIds = new Set((registry?.entries ?? []).map((entry) => entry.id));
    const avatars = {};
    const ambiguous = [];
    const unmatchedPngs = [];
    const used = new Map();
    const copied = [];

    for (const png of pngs) {
        const buffer = readFileSync(png.absolute);
        let card = null;
        try {
            card = extractPngCard(buffer)?.card ?? null;
        } catch {
            card = null;
        }
        const match = matchPngToRegistry(
            { buffer, relativePath: png.relative },
            registryIndex,
            overrides,
        );
        if (!match.registryId) {
            if (match.reason === 'ambiguous') {
                ambiguous.push({ file: png.relative, candidates: match.candidates });
            } else {
                unmatchedPngs.push(png.relative);
            }
            continue;
        }
        if (!registryIds.has(match.registryId)) {
            throw new Error(
                `avatar override "${png.relative}" points at unknown registry id "${match.registryId}"`,
            );
        }
        if (used.has(match.registryId)) {
            ambiguous.push({
                file: png.relative,
                candidates: [match.registryId],
                reason: `already matched by ${used.get(match.registryId)}`,
            });
            continue;
        }
        used.set(match.registryId, png.relative);

        let file = null;
        if (copy) {
            const target = `assets/avatars/${match.registryId}.png`;
            const absoluteTarget = join(root, ...target.split('/'));
            mkdirSync(dirname(absoluteTarget), { recursive: true });
            copyFileSync(png.absolute, absoluteTarget);
            copied.push(target);
            file = target;
        }
        avatars[match.registryId] = {
            file,
            source: png.relative,
            hash: hashBuffer(buffer),
            fingerprint: cardFingerprint(card?.data?.description) ?? null,
        };
    }

    const sorted = {};
    for (const id of Object.keys(avatars).sort()) {
        sorted[id] = avatars[id];
    }
    const unmatchedRegistry = [...registryIds]
        .filter((id) => !sorted[id])
        .sort();

    return {
        manifest: {
            schemaVersion: 1,
            generatedBy: 'tools/build-avatars.mjs',
            source: 'avatars',
            counts: {
                matched: Object.keys(sorted).length,
                ambiguous: ambiguous.length,
                unmatched: unmatchedRegistry.length,
            },
            avatars: sorted,
        },
        ambiguous,
        unmatchedPngs,
        unmatchedRegistry,
        copied,
    };
}

function readJson(path, label) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`${label}: ${error.message}`);
    }
}

function parseArgs(argv) {
    const options = { check: false, copy: true, source: join(ROOT, 'Chars'), sourceExplicit: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--check') {
            options.check = true;
        } else if (arg === '--no-copy') {
            options.copy = false;
        } else if (arg === '--source') {
            options.source = argv[index + 1];
            options.sourceExplicit = true;
            index += 1;
        } else if (arg.startsWith('--source=')) {
            options.source = arg.slice('--source='.length);
            options.sourceExplicit = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            throw new Error(`Unknown argument "${arg}"`);
        }
    }
    if (!options.source) {
        throw new Error('--source requires a directory');
    }
    return options;
}

/**
 * `--check` without `--source` validates the committed manifest instead of
 * regenerating it: CI has no access to the user's external PNG folder.
 */
function checkCommittedManifest(registry) {
    let manifest;
    try {
        manifest = readJson(AVATARS_PATH, 'data/characters/avatars.json');
    } catch (error) {
        console.error(`[build-avatars] ${error.message}`);
        return 1;
    }
    const validation = validateManifestShape(manifest);
    if (!validation.ok) {
        for (const error of validation.errors) {
            console.error(`[build-avatars] ${error}`);
        }
        return 1;
    }
    const registryIds = new Set((registry?.entries ?? []).map((entry) => entry.id));
    const errors = [];
    for (const id of Object.keys(manifest.avatars)) {
        if (!registryIds.has(id)) {
            errors.push(`avatars.${id}: unknown registry id`);
        }
    }
    if (errors.length > 0) {
        for (const error of errors) {
            console.error(`[build-avatars] ${error}`);
        }
        return 1;
    }
    console.log(
        `Portrait manifest is up to date. ${Object.keys(manifest.avatars).length} portrait(s), ` +
        `${registryIds.size} registry entries.`,
    );
    return 0;
}

function validateManifestShape(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { ok: false, errors: ['manifest must be an object'] };
    }
    if (manifest.schemaVersion !== 1) {
        return { ok: false, errors: ['manifest.schemaVersion must be 1'] };
    }
    if (!manifest.avatars || typeof manifest.avatars !== 'object' || Array.isArray(manifest.avatars)) {
        return { ok: false, errors: ['manifest.avatars must be an object'] };
    }
    return { ok: true, errors: [] };
}

function printReport(result, options) {
    const { manifest, ambiguous, unmatchedPngs, unmatchedRegistry } = result;
    console.log(
        `Portraits: ${manifest.counts.matched} matched, ${manifest.counts.ambiguous} ambiguous, ` +
        `${manifest.counts.unmatched} registry entries without a portrait.`,
    );
    if (options.copy) {
        console.log(`Copied ${result.copied.length} PNG(s) into assets/avatars/.`);
    }
    if (ambiguous.length > 0) {
        console.log('Ambiguous matches (add an entry to data/characters/avatar-overrides.json):');
        for (const item of ambiguous) {
            console.log(`  ${item.file} → ${item.candidates.join(' | ')}${item.reason ? ` (${item.reason})` : ''}`);
        }
    }
    if (unmatchedPngs.length > 0) {
        console.log('PNGs that match no registry entry:');
        for (const file of unmatchedPngs) {
            console.log(`  ${file}`);
        }
    }
    if (unmatchedRegistry.length > 0) {
        console.log('Registry characters without a portrait:');
        for (const id of unmatchedRegistry) {
            console.log(`  ${id}`);
        }
    }
}

export function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        console.error(`[build-avatars] ${error.message}`);
        return 1;
    }
    if (options.help) {
        console.log('Usage: node tools/build-avatars.mjs [--source <dir>] [--check] [--no-copy]');
        return 0;
    }

    let registry;
    let overridesDocument;
    try {
        registry = readJson(REGISTRY_PATH, 'data/characters/index.json');
        overridesDocument = readJson(OVERRIDES_PATH, 'data/characters/avatar-overrides.json');
    } catch (error) {
        console.error(`[build-avatars] ${error.message}`);
        return 1;
    }
    const overrides = overridesDocument?.entries ?? {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        console.error('[build-avatars] avatar-overrides.json: entries must be an object');
        return 1;
    }

    if (options.check && !options.sourceExplicit) {
        return checkCommittedManifest(registry);
    }

    let result;
    try {
        result = buildAvatarManifest({
            sourceDir: options.source,
            registry,
            overrides,
            copy: options.copy,
        });
    } catch (error) {
        console.error(`[build-avatars] ${error.message}`);
        return 1;
    }

    printReport(result, options);
    const text = `${JSON.stringify(result.manifest, null, 2)}\n`;
    const unresolved = result.ambiguous.filter((item) => !item.reason);

    if (options.check) {
        let existing = null;
        try {
            existing = readFileSync(AVATARS_PATH, 'utf8');
        } catch {
            existing = null;
        }
        const errors = [];
        if (existing !== text) {
            errors.push('data/characters/avatars.json is out of date; run node tools/build-avatars.mjs');
        }
        if (unresolved.length > 0) {
            errors.push(`${unresolved.length} ambiguous portrait match(es) need an override`);
        }
        if (errors.length > 0) {
            for (const error of errors) {
                console.error(`[build-avatars] ${error}`);
            }
            return 1;
        }
        console.log('Portrait manifest is up to date.');
        return 0;
    }

    writeFileSync(AVATARS_PATH, text);
    console.log(`Wrote ${relative(ROOT, AVATARS_PATH)}.`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main();
}
