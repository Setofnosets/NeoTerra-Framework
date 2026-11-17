#!/usr/bin/env node
/**
 * Dev-only map coordinate spike.
 *
 * Coordinates in `data/locations.json` are authored manually. This script can
 * optionally ask a vision-capable DeepSeek model to propose pixel coordinates
 * for the named nodes, then writes `data/locations.draft.json`. It never writes
 * `locations.json`; every proposal must be human-verified before copying over.
 *
 * It is not a runtime dependency and is never imported by the extension.
 *
 * Usage:
 *   node tools/map-coords.mjs --check
 *   DEEPSEEK_API_KEY=... node tools/map-coords.mjs --draft [--model deepseek-vl2]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isCoordinateInImage,
    validateLocations,
} from '../src/data/locations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCATIONS_PATH = join(ROOT, 'data', 'locations.json');
const IMAGE_PATH = join(ROOT, 'NeoTerra.png');
const DRAFT_PATH = join(ROOT, 'data', 'locations.draft.json');
const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-vl2';

function parseArgs(argv) {
    const args = { check: false, draft: false, model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--check') {
            args.check = true;
        } else if (arg === '--draft') {
            args.draft = true;
        } else if (arg === '--model') {
            args.model = argv[index + 1];
            index += 1;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument "${arg}"`);
        }
    }
    return args;
}

function checkLocations(document) {
    const validation = validateLocations(document);
    if (!validation.ok) {
        for (const error of validation.errors) {
            console.error(`${error.path}: ${error.message}`);
        }
        throw new Error(`locations.json failed validation with ${validation.errors.length} error(s)`);
    }
    const image = document.image;
    for (const location of document.locations) {
        if (!isCoordinateInImage(location.x, location.y, image)) {
            throw new Error(`"${location.id}" sits outside the map image`);
        }
    }
    console.log(
        `OK: ${document.locations.length} locations inside ${image.width}x${image.height} (${image.path})`,
    );
}

/**
 * Validate a draft produced by `--draft` (or hand-edited) without touching the
 * canonical `data/locations.json`.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateDraft(draft, document) {
    const errors = [];
    const warnings = [];
    if (!draft || typeof draft !== 'object' || !Array.isArray(draft.locations)) {
        return { ok: false, errors: ['draft must contain a locations array'], warnings };
    }
    const image = draft.image && typeof draft.image === 'object' ? draft.image : document.image;
    const known = new Set((document.locations ?? []).map((location) => location.id));
    const seen = new Set();
    for (const [index, location] of draft.locations.entries()) {
        if (!location || typeof location !== 'object') {
            errors.push(`locations[${index}] must be an object`);
            continue;
        }
        if (typeof location.id !== 'string' || location.id.length === 0) {
            errors.push(`locations[${index}].id must be a non-empty string`);
            continue;
        }
        if (!known.has(location.id)) {
            errors.push(`locations[${index}].id "${location.id}" is not in locations.json`);
        }
        if (seen.has(location.id)) {
            errors.push(`duplicate draft location "${location.id}"`);
        }
        seen.add(location.id);
        if (!Number.isInteger(location.x) || !Number.isInteger(location.y)) {
            errors.push(`"${location.id}" needs integer x/y coordinates`);
        } else if (!isCoordinateInImage(location.x, location.y, image)) {
            errors.push(`"${location.id}" sits outside the ${image.width}x${image.height} canvas`);
        }
    }
    for (const id of known) {
        if (!seen.has(id)) {
            warnings.push(`draft is missing location "${id}"; it will keep its authored coordinates`);
        }
    }
    if (draft.proposals !== undefined) {
        if (!draft.proposals || typeof draft.proposals !== 'object' || Array.isArray(draft.proposals)) {
            errors.push('draft.proposals must be an object keyed by location id');
        } else {
            for (const id of Object.keys(draft.proposals)) {
                if (!known.has(id)) {
                    warnings.push(`proposal for unknown location "${id}" is ignored`);
                }
            }
        }
    }
    return { ok: errors.length === 0, errors, warnings };
}

async function requestDraft(document, model) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY is required for --draft');
    }
    const endpoint = process.env.DEEPSEEK_ENDPOINT || DEFAULT_ENDPOINT;
    const imageBase64 = readFileSync(IMAGE_PATH).toString('base64');
    const names = document.locations.map((location) => ({
        id: location.id,
        name: location.name,
        district: location.district,
    }));

    const prompt = [
        'You are helping author a map for the Neo Terra superhero setting.',
        `The image is ${document.image.width} pixels wide and ${document.image.height} pixels tall.`,
        'For every location below, propose an integer pixel coordinate { "x", "y" } on the image.',
        'Return JSON only: { "locations": [{ "id", "x", "y", "confidence", "reason" }] }.',
        'Do not invent ids. Do not omit locations. Coordinates must be inside the image.',
        JSON.stringify(names),
    ].join('\n');

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${imageBase64}` },
                        },
                    ],
                },
            ],
        }),
    });
    if (!response.ok) {
        throw new Error(`DeepSeek request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
        throw new Error('DeepSeek response did not contain text content');
    }
    return text;
}

function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('No JSON object found in model response');
    }
    return JSON.parse(candidate.slice(start, end + 1));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node tools/map-coords.mjs --check | --draft [--model model]');
        return;
    }
    const document = JSON.parse(readFileSync(LOCATIONS_PATH, 'utf8'));

    if (args.check || !args.draft) {
        checkLocations(document);
    }
    if (!args.draft) {
        if (args.check && existsSync(DRAFT_PATH)) {
            const draft = JSON.parse(readFileSync(DRAFT_PATH, 'utf8'));
            const validation = validateDraft(draft, document);
            for (const warning of validation.warnings) {
                console.log(`  warning: ${warning}`);
            }
            if (!validation.ok) {
                for (const error of validation.errors) {
                    console.error(`  ${error}`);
                }
                throw new Error(`locations.draft.json failed validation with ${validation.errors.length} error(s)`);
            }
            console.log(
                `Draft OK: ${draft.locations.length} locations (${Object.keys(draft.proposals ?? {}).length} proposals).`,
            );
        }
        return;
    }

    console.log(`Requesting coordinates from ${args.model}…`);
    const text = await requestDraft(document, args.model);
    const parsed = extractJson(text);
    const rawProposals = Array.isArray(parsed?.locations) ? parsed.locations : [];
    const known = new Set((document.locations ?? []).map((location) => location.id));
    const seen = new Set();
    const proposals = [];
    for (const proposal of rawProposals) {
        if (!proposal || typeof proposal !== 'object') {
            continue;
        }
        if (typeof proposal.id !== 'string' || !known.has(proposal.id)) {
            console.warn(`Ignoring proposal for unknown location "${String(proposal?.id)}"`);
            continue;
        }
        if (!Number.isInteger(proposal.x) || !Number.isInteger(proposal.y)) {
            console.warn(`Ignoring "${proposal.id}": coordinates must be integers`);
            continue;
        }
        if (!isCoordinateInImage(proposal.x, proposal.y, document.image)) {
            console.warn(`Ignoring "${proposal.id}": coordinate falls outside the map`);
            continue;
        }
        if (seen.has(proposal.id)) {
            console.warn(`Ignoring duplicate proposal for "${proposal.id}"`);
            continue;
        }
        seen.add(proposal.id);
        proposals.push(proposal);
    }

    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const draft = {
        schemaVersion: document.schemaVersion,
        image: document.image,
        generatedBy: 'tools/map-coords.mjs',
        note: 'DRAFT ONLY. Every coordinate must be human-verified before merging into data/locations.json.',
        // Locations keep the exact production shape so the draft can be
        // validated against data/schemas and diffed safely. Vision metadata
        // stays in the sibling `proposals` map.
        locations: document.locations.map((location) => {
            const proposal = byId.get(location.id);
            const x = Number.isInteger(proposal?.x) ? proposal.x : location.x;
            const y = Number.isInteger(proposal?.y) ? proposal.y : location.y;
            return {
                ...location,
                x: isCoordinateInImage(x, y, document.image) ? x : location.x,
                y: isCoordinateInImage(x, y, document.image) ? y : location.y,
            };
        }),
        proposals: Object.fromEntries(
            proposals.map((proposal) => [
                proposal.id,
                {
                    confidence: proposal.confidence ?? null,
                    reason: proposal.reason ?? null,
                },
            ]),
        ),
    };

    const validation = validateDraft(draft, document);
    if (!validation.ok) {
        for (const error of validation.errors) {
            console.error(`  ${error}`);
        }
        throw new Error(`generated draft failed validation with ${validation.errors.length} error(s)`);
    }

    writeFileSync(DRAFT_PATH, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${DRAFT_PATH} (${proposals.length} proposals). Human-verify before commit.`);
}

main().catch((error) => {
    console.error(`map-coords: ${error.message}`);
    process.exitCode = 1;
});
