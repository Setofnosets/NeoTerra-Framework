/**
 * Neo Terra Lore Agent.
 *
 * Every N turns the agent summarizes recent play into compact lore entries,
 * proposes which existing entries to inject, and proposes bounded relationship
 * deltas. It is a pure planner: `runLorePass` applies relationship events
 * atomically through the reducer and commits lore entries to the chat-scoped
 * world book through the shared adapter.
 *
 * Lore entries use their own marker (`neoterra:lore:`), so writing lore never
 * replaces generated character entries and vice versa.
 */

import { AgentAbortedError } from './client.js';
import { applyContentGate, applyContentGateToPrompt } from '../core/content-gate.js';
import { renderPromptTemplate } from './prompts.js';
import {
    buildLoreWorldBookEntry,
    mergeLoreEntries,
    parseGeneratedLoreEntryId,
} from '../context/worldbook.js';
import { applyEventBatch } from '../flows/initiative.js';
import { selectPresentRelationships } from '../state/selectors.js';

/** Relationship kinds the Lore Agent may record. */
export const RELATIONSHIP_TYPES = Object.freeze([
    'likes',
    'dislikes',
    'attraction',
    'rivalry',
    'owner/servant',
    'ally',
    'neutral',
]);

/** Hard bound for a single normalized relationship delta. */
export const LORE_RELATIONSHIP_MAX_DELTA = 20;

const MAX_ENTRIES = 5;
const MAX_SELECTIONS = 8;
const MAX_RELATIONSHIPS = 8;
const MAX_TITLE = 160;
const MAX_CONTENT = 1600;
const MAX_NOTES = 240;
const MAX_ID = 120;

/** Sentinels the agent may use for the custom persona. */
const PLAYER_SENTINELS = Object.freeze(['player', 'custom-player']);

/** Dependency-free JSON-schema subset for the Lore Agent response. */
export const LORE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['entries', 'selections', 'relationships', 'rationale'],
    properties: {
        entries: {
            type: 'array',
            maxItems: MAX_ENTRIES,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'keys', 'content'],
                properties: {
                    id: { type: 'string', maxLength: MAX_ID },
                    title: { type: 'string', maxLength: MAX_TITLE },
                    keys: {
                        type: 'array',
                        maxItems: 12,
                        items: { type: 'string', maxLength: 100 },
                    },
                    content: { type: 'string', maxLength: MAX_CONTENT },
                    tags: {
                        type: 'array',
                        maxItems: 12,
                        items: { type: 'string', maxLength: 100 },
                    },
                    importance: { type: 'number', minimum: 0, maximum: 10 },
                    depth: { type: 'integer', minimum: 0, maximum: 20 },
                    order: { type: 'integer', minimum: 0, maximum: 1000 },
                },
            },
        },
        selections: {
            type: 'array',
            maxItems: MAX_SELECTIONS,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', maxLength: MAX_ID },
                    reason: { type: 'string', maxLength: 240 },
                },
            },
        },
        relationships: {
            type: 'array',
            maxItems: MAX_RELATIONSHIPS,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['a', 'b', 'type'],
                properties: {
                    a: { type: 'string', maxLength: MAX_ID },
                    b: { type: 'string', maxLength: MAX_ID },
                    type: { type: 'string', enum: [...RELATIONSHIP_TYPES] },
                    affinityDelta: { type: 'number', minimum: -100, maximum: 100 },
                    tensionDelta: { type: 'number', minimum: -100, maximum: 100 },
                    notes: { type: 'string', maxLength: MAX_NOTES },
                },
            },
        },
        rationale: { type: 'string', maxLength: 600 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Stable per-pass idempotency key for one merged relationship proposal.
 * A retried pass in the same turn produces the same key and is skipped.
 */
function relationshipEventKey(turn, combined) {
    return [
        'lore',
        Number.isInteger(turn) ? turn : 0,
        combined.custom ? `player:${combined.withCharacterId}` : `${combined.a}::${combined.b}`,
        combined.type ?? '',
        combined.affinityDelta,
        combined.tensionDelta,
        combined.notes.join('; '),
    ].join('|');
}

const MAX_APPLIED_KEYS = 200;

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break a lore pass.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/** Stable, marker-safe slug for a lore title. */
export function slugifyLoreId(value) {
    return String(value ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'entry';
}

function sanitizeLoreId(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, MAX_ID);
}

function characterName(state, characterId) {
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function playerView(state) {
    const player = state?.player;
    if (!isObject(player)) {
        return { identity: 'custom', characterId: null, name: 'The Player' };
    }
    const character = player.identity === 'canon' && player.characterId
        ? state?.characters?.[player.characterId] ?? null
        : null;
    return {
        identity: player.identity ?? 'custom',
        characterId: player.characterId ?? null,
        name: character?.displayName ?? player.displayName ?? 'The Player',
    };
}

function isPlayerSentinel(value) {
    return typeof value === 'string' && PLAYER_SENTINELS.includes(value.toLowerCase());
}

/** Is this id a valid relationship side? */
function isKnownSide(state, id, view) {
    if (typeof id !== 'string' || id.length === 0) {
        return false;
    }
    if (state?.characters?.[id]) {
        return true;
    }
    if (isPlayerSentinel(id) && view.identity === 'custom') {
        return true;
    }
    if (isPlayerSentinel(id) && view.identity === 'canon' && typeof view.characterId === 'string') {
        return true;
    }
    return false;
}

/** Resolve a side to a character id, the custom player, or null. */
function resolveSide(state, id, view) {
    if (state?.characters?.[id]) {
        return { characterId: id, customPlayer: false };
    }
    if (!isPlayerSentinel(id)) {
        return null;
    }
    if (view.identity === 'custom') {
        return { characterId: null, customPlayer: true };
    }
    if (view.identity === 'canon' && typeof view.characterId === 'string') {
        return { characterId: view.characterId, customPlayer: false };
    }
    return null;
}

function locationLine(state) {
    const locationId = state?.scene?.locationId ?? null;
    const location = locationId ? state?.locations?.[locationId] ?? null : null;
    if (!location) {
        return locationId ?? 'unknown';
    }
    const parts = [location.name ?? locationId];
    if (location.district) {
        parts.push(location.district);
    }
    return parts.join(', ');
}

function recallBlock(value, limit) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Deterministic Lore Agent prompt.
 *
 * It always names the supplied ids only, states the compact-entry rule, and
 * carries the response schema so the model cannot invent a shape.
 */
export function buildLorePrompt({
    state = null,
    season = null,
    recentProse = '',
    recentMessages = [],
    candidates = [],
    existingEntries = [],
    presentCharacterIds = [],
    settings = null,
} = {}) {
    const view = playerView(state);
    const present = Array.isArray(presentCharacterIds) && presentCharacterIds.length > 0
        ? presentCharacterIds
        : asArray(state?.scene?.present);
    const cast = present
        .map((characterId) => state?.characters?.[characterId] ?? null)
        .filter(Boolean);
    const events = asArray(state?.recentEvents).slice(-8);
    const entries = asArray(existingEntries).filter(isObject);
    const candidateList = asArray(candidates).filter(isObject);
    const gateLevel = settings?.contentGate ?? settings?.contentGateLevel ?? 'full';
    const limits = settings?.contentLimits ?? {};

    const lines = [];
    lines.push(`# Neo Terra Lore Keeper — ${season?.title ?? season?.id ?? 'Neo Terra'}`);
    lines.push('');
    lines.push('## Scene');
    lines.push(`Turn: ${state?.meta?.turn ?? 0}`);
    lines.push(`Date: ${state?.meta?.inGameDate ?? 'unknown'} (${state?.meta?.timeOfDay ?? 'unknown'})`);
    lines.push(`Act: ${state?.arc ?? 'season'}`);
    lines.push(`Location: ${locationLine(state)}`);
    if (state?.scene?.framing) {
        lines.push(`Framing: ${state.scene.framing}`);
    }
    lines.push('');

    lines.push('## Present cast');
    if (cast.length === 0) {
        lines.push('(nobody)');
    } else {
        for (const character of cast) {
            lines.push(`- ${character.charId} — ${character.displayName ?? character.charId} [${character.status ?? 'active'}${character.alive === false ? ', dead' : ''}]`);
        }
    }
    lines.push(`Player: ${view.name}${view.identity === 'canon' && view.characterId ? ` (${view.characterId})` : ' (custom persona — use the literal id "player")'}`);
    lines.push('');

    lines.push('## Relationships involving present characters');
    const relationships = selectPresentRelationships(state);
    if (relationships.length === 0) {
        lines.push('(none recorded)');
    } else {
        for (const relationship of relationships) {
            const facts = [
                relationship.type,
                Number.isFinite(relationship.affinity) ? `affinity ${relationship.affinity}` : null,
                Number.isFinite(relationship.tension) ? `tension ${relationship.tension}` : null,
            ].filter(Boolean).join(', ');
            lines.push(`- ${characterName(state, relationship.a)} (${relationship.a}) ↔ ${characterName(state, relationship.b)} (${relationship.b})${facts ? ` — ${facts}` : ''}`);
        }
    }
    lines.push('');

    lines.push('## Recent events');
    if (events.length === 0) {
        lines.push('(none)');
    } else {
        for (const event of events) {
            const headline = event?.headline ? `${event.headline}: ` : '';
            lines.push(`- [turn ${event?.turn ?? '?'}] ${headline}${recallBlock(event?.summary ?? '', 400)}`);
        }
    }
    lines.push('');

    lines.push('## Existing lore entries (select by id)');
    if (entries.length === 0) {
        lines.push('(none)');
    } else {
        for (const entry of entries.slice(0, 40)) {
            const id = entry.id ?? parseGeneratedLoreEntryId(entry) ?? '';
            const title = loreTitle(entry);
            lines.push(`- ${id} — ${title}: ${recallBlock(entry.content ?? '', 240)}`);
        }
    }
    lines.push('');

    if (candidateList.length > 0) {
        lines.push('## Candidate entries');
        for (const candidate of candidateList.slice(0, 40)) {
            lines.push(`- ${candidate.id ?? loreTitle(candidate)} — ${loreTitle(candidate)}: ${recallBlock(candidate.content ?? '', 240)}`);
        }
        lines.push('');
    }

    lines.push('## Recent prose');
    lines.push(recallBlock(recentProse, 6000) || '(none)');
    lines.push('');
    const messages = asArray(recentMessages).slice(-4);
    if (messages.length > 0) {
        lines.push('## Recent messages');
        for (const message of messages) {
            lines.push(recallBlock(typeof message === 'string' ? message : JSON.stringify(message), 1200));
        }
        lines.push('');
    }

    lines.push('## Rules');
    lines.push('Summarize durable facts, not the current mood of the scene. Write compact entries of 120 words or fewer.');
    lines.push('Use only the character and entry ids supplied above. Never invent characters, places, or ids.');
    lines.push(`Relationship types are limited to: ${RELATIONSHIP_TYPES.join(', ')}.`);
    lines.push(`Propose relationship deltas of at most ±${LORE_RELATIONSHIP_MAX_DELTA} and only when the prose supports them.`);
    lines.push('Return at most 5 entries, 8 selections, and 8 relationship updates.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(renderPromptTemplate('{{schema}}', { schema: JSON.stringify(LORE_SCHEMA) }));

    const prompt = lines.join('\n');
    return applyContentGateToPrompt(prompt, gateLevel, limits, { isPlayer: false });
}

function loreTitle(entry) {
    if (isObject(entry) && typeof entry.title === 'string' && entry.title.trim().length > 0) {
        return entry.title.trim();
    }
    const comment = typeof entry?.comment === 'string' ? entry.comment : '';
    const match = comment.match(/Lore:\s*(.*?)\s*\[/);
    if (match) {
        return match[1];
    }
    return entry?.id ?? 'Lore';
}

/**
 * Normalize a raw Lore Agent result into entry inputs, selections, and reducer
 * events. Never throws for malformed output: bad items are reported in
 * `rejected` instead.
 */
export function normalizeLoreResult({
    result,
    state = null,
    season = null,
    gateLevel = 'full',
    limits = {},
    existingEntries = [],
    candidates = [],
} = {}) {
    const output = isObject(result) ? result : {};
    const view = playerView(state);
    const rejected = [];
    const notes = [];
    const seasonId = state?.seasonId ?? season?.id ?? 'sandbox';

    /* ---------------- entries ---------------- */
    const byId = new Map();
    const order = [];
    for (const raw of asArray(output.entries).slice(0, MAX_ENTRIES)) {
        if (!isObject(raw)) {
            continue;
        }
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        if (title.length === 0 || content.length === 0) {
            rejected.push({ path: 'entries', reason: 'empty-entry' });
            continue;
        }
        const suppliedId = sanitizeLoreId(raw.id);
        const id = suppliedId.length > 0
            ? suppliedId
            : `${seasonId}.lore.${slugifyLoreId(title)}`;
        const gated = applyContentGate(content, gateLevel, limits, { characterId: null, isPlayer: false });
        if (gated.trim().length === 0) {
            rejected.push({ path: 'entries', reason: `gated:${id}` });
            continue;
        }
        const entry = {
            id,
            title: title.slice(0, MAX_TITLE),
            keys: asArray(raw.keys).filter((key) => typeof key === 'string' && key.trim().length > 0),
            content: gated.slice(0, MAX_CONTENT),
            tags: asArray(raw.tags).filter((tag) => typeof tag === 'string' && tag.trim().length > 0),
            ...(Number.isFinite(raw.importance) ? { importance: clamp(raw.importance, 0, 10) } : {}),
            ...(Number.isInteger(raw.depth) && raw.depth >= 0 ? { depth: raw.depth } : {}),
            ...(Number.isInteger(raw.order) ? { order: raw.order } : {}),
        };
        if (byId.has(id)) {
            const existing = byId.get(id);
            existing.keys = [...new Set([...existing.keys, ...entry.keys])];
            existing.tags = [...new Set([...existing.tags, ...entry.tags])];
            if (entry.content.length > existing.content.length) {
                existing.content = entry.content;
            }
            rejected.push({ path: 'entries', reason: `duplicate:${id}` });
            continue;
        }
        byId.set(id, entry);
        order.push(entry);
    }
    const entries = order.slice(0, MAX_ENTRIES);

    /* ---------------- selections ---------------- */
    const knownIds = new Set();
    for (const entry of asArray(existingEntries)) {
        if (!isObject(entry)) {
            continue;
        }
        const id = parseGeneratedLoreEntryId(entry) ?? entry.id;
        if (typeof id === 'string') {
            knownIds.add(id);
        }
    }
    for (const candidate of asArray(candidates)) {
        if (isObject(candidate) && typeof candidate.id === 'string') {
            knownIds.add(candidate.id);
        }
    }
    for (const entry of entries) {
        knownIds.add(entry.id);
    }

    const selections = [];
    const seenSelections = new Set();
    for (const raw of asArray(output.selections).slice(0, MAX_SELECTIONS)) {
        const id = typeof raw === 'string' ? raw : sanitizeLoreId(raw?.id);
        if (!id) {
            continue;
        }
        if (seenSelections.has(id)) {
            rejected.push({ path: 'selections', reason: `duplicate:${id}` });
            continue;
        }
        if (!knownIds.has(id)) {
            rejected.push({ path: 'selections', reason: `unknown-id:${id}` });
            continue;
        }
        seenSelections.add(id);
        selections.push({
            id,
            ...(isObject(raw) && typeof raw.reason === 'string'
                ? { reason: raw.reason.slice(0, 240) }
                : {}),
        });
    }

    /* ---------------- relationships ---------------- */
    const pairs = new Map();
    const pairOrder = [];
    for (const raw of asArray(output.relationships).slice(0, MAX_RELATIONSHIPS)) {
        if (!isObject(raw)) {
            continue;
        }
        const sideA = resolveSide(state, raw.a, view);
        const sideB = resolveSide(state, raw.b, view);
        if (!isKnownSide(state, raw.a, view) || !isKnownSide(state, raw.b, view)) {
            rejected.push({ path: 'relationships', reason: `unknown-relationship-side:${String(raw.a)}:${String(raw.b)}` });
            continue;
        }
        if (!sideA || !sideB) {
            rejected.push({ path: 'relationships', reason: 'unknown-relationship-side' });
            continue;
        }

        const aId = sideA.characterId;
        const bId = sideB.characterId;
        if (aId === bId) {
            rejected.push({ path: 'relationships', reason: `self-target:${String(aId ?? raw.a)}` });
            continue;
        }

        const affinity = Number.isFinite(raw.affinityDelta)
            ? clamp(raw.affinityDelta, -LORE_RELATIONSHIP_MAX_DELTA, LORE_RELATIONSHIP_MAX_DELTA)
            : 0;
        const tension = Number.isFinite(raw.tensionDelta)
            ? clamp(raw.tensionDelta, -LORE_RELATIONSHIP_MAX_DELTA, LORE_RELATIONSHIP_MAX_DELTA)
            : 0;
        const type = RELATIONSHIP_TYPES.includes(raw.type) ? raw.type : null;
        const noteText = typeof raw.notes === 'string' && raw.notes.trim().length > 0
            ? raw.notes.trim().slice(0, MAX_NOTES)
            : null;
        if (affinity === 0 && tension === 0 && type === null && noteText === null) {
            continue;
        }

        // A custom-player side is a distinct record; everything else is an
        // undirected character pair canonicalized lexicographically.
        const customSide = sideA.customPlayer ? sideB : sideB.customPlayer ? sideA : null;
        const key = customSide
            ? `player:${customSide.characterId}`
            : [aId, bId].sort().join('::');

        if (!pairs.has(key)) {
            pairs.set(key, {
                key,
                a: aId,
                b: bId,
                custom: customSide !== null,
                withCharacterId: customSide?.characterId ?? null,
                affinityDelta: 0,
                tensionDelta: 0,
                type: null,
                notes: [],
            });
            pairOrder.push(key);
        }
        const combined = pairs.get(key);
        combined.affinityDelta = clamp(
            combined.affinityDelta + affinity,
            -LORE_RELATIONSHIP_MAX_DELTA,
            LORE_RELATIONSHIP_MAX_DELTA,
        );
        combined.tensionDelta = clamp(
            combined.tensionDelta + tension,
            -LORE_RELATIONSHIP_MAX_DELTA,
            LORE_RELATIONSHIP_MAX_DELTA,
        );
        if (type !== null) {
            combined.type = type;
        }
        if (noteText !== null && !combined.notes.includes(noteText)) {
            combined.notes.push(noteText);
        }
        if (!customSide) {
            // Keep the pair ordered after merging reciprocal proposals.
            const sorted = [aId, bId].sort();
            combined.a = sorted[0];
            combined.b = sorted[1];
        }
    }

    const relationshipEvents = [];
    for (const key of pairOrder) {
        const combined = pairs.get(key);
        const idempotencyKey = relationshipEventKey(state?.meta?.turn, combined);
        if (combined.custom) {
            relationshipEvents.push({
                type: 'PLAYER_RELATIONSHIP_DELTA',
                withCharacterId: combined.withCharacterId,
                affinityDelta: combined.affinityDelta,
                tensionDelta: combined.tensionDelta,
                ...(combined.type ? { relationshipType: combined.type } : {}),
                ...(combined.notes.length > 0 ? { notes: combined.notes.join('; ') } : {}),
                idempotencyKey,
            });
        } else {
            relationshipEvents.push({
                type: 'RELATIONSHIP_DELTA',
                a: combined.a,
                b: combined.b,
                affinityDelta: combined.affinityDelta,
                tensionDelta: combined.tensionDelta,
                ...(combined.type ? { relationshipType: combined.type } : {}),
                ...(combined.notes.length > 0 ? { notes: combined.notes.join('; ') } : {}),
                idempotencyKey,
            });
        }
    }

    return {
        entries,
        selections,
        relationshipEvents,
        rejected,
        notes,
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 600) : '',
    };
}

function emptyResult(extra = {}) {
    return {
        entries: [],
        selections: [],
        relationshipEvents: [],
        rejected: [],
        notes: [],
        rationale: '',
        source: 'deterministic',
        ...extra,
    };
}

/**
 * Create the Lore Agent.
 *
 * `plan` honors a `request.propose` test seam; `run` calls the shared runner
 * unless the agent is disabled in settings.
 */
export function createLoreAgent({ runner = null, getSettings = null, log = null } = {}) {
    function settingsFor(request = {}) {
        const fromGetter = typeof getSettings === 'function' ? getSettings() : null;
        return fromGetter ?? request.settings ?? {};
    }

    function prepare(request = {}) {
        const state = request.state ?? null;
        const season = request.season ?? null;
        const settings = settingsFor(request);
        const existingEntries = request.existingEntries ?? [];
        const presentCharacterIds = request.presentCharacterIds
            ?? asArray(state?.scene?.present);
        const prompt = buildLorePrompt({
            state,
            season,
            recentProse: request.recentProse ?? '',
            recentMessages: request.recentMessages ?? [],
            candidates: request.candidates ?? [],
            existingEntries,
            presentCharacterIds,
            settings,
        });
        return { state, season, settings, existingEntries, presentCharacterIds, prompt };
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        if (typeof request.propose !== 'function') {
            return {
                ...emptyResult(),
                prompt: prepared.prompt,
                enabled: prepared.settings?.agents?.lore?.enabled !== false,
                calls: 0,
            };
        }
        return {
            ...normalizeLoreResult({
                result: request.propose({ prompt: prepared.prompt, schema: LORE_SCHEMA }),
                state: prepared.state,
                season: prepared.season,
                gateLevel: prepared.settings?.contentGate ?? 'full',
                limits: prepared.settings?.contentLimits ?? {},
                existingEntries: prepared.existingEntries,
                candidates: request.candidates ?? [],
            }),
            source: 'agent',
            prompt: prepared.prompt,
            enabled: true,
            calls: 1,
        };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        if (prepared.settings?.agents?.lore?.enabled === false) {
            return {
                enabled: false,
                calls: 0,
                entries: [],
                relationshipEvents: [],
                selections: [],
                rejected: [],
                notes: [],
                rationale: '',
                source: 'disabled',
                prompt: prepared.prompt,
            };
        }
        if (typeof runner?.runAgent !== 'function') {
            return {
                ...emptyResult(),
                prompt: prepared.prompt,
                enabled: true,
                calls: 0,
                ran: false,
                reason: 'no-runner',
            };
        }
        try {
            const response = await runner.runAgent({
                agentId: 'lore',
                prompt: prepared.prompt,
                schema: LORE_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            return {
                ...normalizeLoreResult({
                    result,
                    state: prepared.state,
                    season: prepared.season,
                    gateLevel: prepared.settings?.contentGate ?? 'full',
                    limits: prepared.settings?.contentLimits ?? {},
                    existingEntries: prepared.existingEntries,
                    candidates: request.candidates ?? [],
                }),
                source: 'agent',
                prompt: prepared.prompt,
                enabled: true,
                calls: 1,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Lore pass failed; no state or book change', error);
            return {
                ...emptyResult({ error: error?.message ?? String(error) }),
                prompt: prepared.prompt,
                enabled: true,
                calls: 1,
            };
        }
    }

    return { plan, run, prompt: buildLorePrompt };
}

/**
 * Apply normalized relationship events atomically.
 *
 * No events means no write at all, so a quiet pass leaves the state
 * byte-identical rather than rewriting it with an identical copy.
 */
export function applyLoreRelationships(store, result, { context = {}, log = null } = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.replace !== 'function') {
        throw new TypeError('applyLoreRelationships requires a WorldState store');
    }
    const events = asArray(result?.relationshipEvents);
    if (events.length === 0) {
        return { ok: true, state: store.get(), error: null, applied: 0, skipped: 0 };
    }

    const base = store.get();
    const appliedKeys = appliedRelationshipKeys(base);
    const fresh = [];
    const freshKeys = [];
    for (const event of events) {
        if (!isObject(event)) {
            continue;
        }
        const key = typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0
            ? event.idempotencyKey
            : relationshipEventKey(base?.meta?.turn, {
                custom: event.type === 'PLAYER_RELATIONSHIP_DELTA',
                withCharacterId: event.withCharacterId ?? null,
                a: event.a ?? null,
                b: event.b ?? null,
                type: event.relationshipType ?? null,
                affinityDelta: Number.isFinite(event.affinityDelta) ? event.affinityDelta : 0,
                tensionDelta: Number.isFinite(event.tensionDelta) ? event.tensionDelta : 0,
                notes: typeof event.notes === 'string' ? [event.notes] : [],
            });
        if (appliedKeys.has(key)) {
            continue;
        }
        appliedKeys.add(key);
        freshKeys.push(key);
        // `idempotencyKey` is a planner marker, not a reducer field.
        const { idempotencyKey: _ignored, ...clean } = event;
        fresh.push(clean);
    }

    if (fresh.length === 0) {
        return { ok: true, state: base, error: null, applied: 0, skipped: events.length, events: [] };
    }

    const nextKeys = [...freshKeys, ...appliedRelationshipKeys(base)]
        .filter((key, index, list) => list.indexOf(key) === index)
        .slice(0, MAX_APPLIED_KEYS);

    const applied = applyEventBatch(store, fresh, {
        context,
        log,
        patch: (next) => ({
            ...next,
            flags: {
                ...(next.flags ?? {}),
                lore: {
                    ...(isObject(next.flags?.lore) ? next.flags.lore : {}),
                    appliedRelationshipKeys: nextKeys,
                },
            },
        }),
    });
    return {
        ok: applied.ok,
        state: applied.state,
        error: applied.error,
        applied: applied.ok ? fresh.length : 0,
        skipped: events.length - fresh.length,
        events: applied.ok ? fresh : [],
    };
}

function appliedRelationshipKeys(state) {
    const keys = state?.flags?.lore?.appliedRelationshipKeys;
    return new Set(asArray(keys).filter((key) => typeof key === 'string'));
}

/**
 * Run one full lore pass: read → agent → relationships → book commit.
 *
 * A failed agent pass writes nothing. A failed save keeps the relationship
 * state that was already applied and reports `saved: false`.
 */
export async function runLorePass({
    store = null,
    agent = null,
    adapter = null,
    bookName = null,
    season = null,
    recentProse = '',
    recentMessages = [],
    existingDocument = null,
    candidates = [],
    settings = null,
    signal = null,
    log = null,
} = {}) {
    const base = {
        ran: false,
        source: 'deterministic',
        entries: [],
        relationships: [],
        selections: [],
        document: existingDocument ?? null,
        saved: false,
        error: null,
    };
    if (!store || typeof store.get !== 'function' || !agent || typeof agent.run !== 'function') {
        return base;
    }
    if (settings?.agents?.lore?.enabled === false) {
        return { ...base, source: 'disabled' };
    }

    let document = existingDocument;
    if (!isObject(document) && adapter && typeof bookName === 'string') {
        const readStrict = typeof adapter.readResult === 'function';
        const hasReader = readStrict || typeof adapter.read === 'function';
        if (hasReader) {
            try {
                const loaded = readStrict
                    ? await Promise.resolve(adapter.readResult(bookName))
                    : { ok: true, document: await Promise.resolve(adapter.read(bookName)) };
                if (readStrict && loaded && loaded.ok === false) {
                    return {
                        ...base,
                        document: null,
                        error: loaded.error ?? 'Could not read the lore book',
                    };
                }
                const loadedDocument = readStrict ? loaded?.document : loaded?.document ?? loaded;
                document = isObject(loadedDocument) ? loadedDocument : null;
            } catch (error) {
                logWarning(log, 'Could not read the lore book; refusing to overwrite it', error);
                return {
                    ...base,
                    document: null,
                    error: error?.message ?? String(error),
                };
            }
        }
    }

    const state = store.get();
    const entries = isObject(document) && document.entries !== undefined
        ? Object.values(document.entries).filter(isObject)
        : [];
    const loreEntries = entries.filter((entry) => parseGeneratedLoreEntryId(entry) !== null);

    let result;
    try {
        result = await agent.run({
            state,
            season,
            recentProse,
            recentMessages,
            existingEntries: loreEntries,
            candidates,
            settings,
            signal,
            bookName,
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logWarning(log, 'Lore agent failed; no writes', error);
        return { ...base, document, error: error?.message ?? String(error) };
    }

    if (result?.enabled === false) {
        return {
            ...base,
            document,
            source: 'disabled',
            selections: asArray(result.selections),
        };
    }
    if (result?.ran === false && typeof result?.reason === 'string') {
        return {
            ...base,
            document,
            source: result.source ?? 'deterministic',
            selections: asArray(result.selections),
            reason: result.reason,
        };
    }
    if (typeof result?.error === 'string' && asArray(result.relationshipEvents).length === 0
        && asArray(result.entries).length === 0) {
        return { ...base, document, source: result.source ?? 'deterministic', error: result.error };
    }

    const context = {};
    const applied = applyLoreRelationships(store, result, { context, log });
    if (!applied.ok) {
        return {
            ...base,
            document,
            source: result.source ?? 'agent',
            selections: asArray(result.selections),
            error: applied.error,
        };
    }

    const gateLevel = settings?.contentGate ?? settings?.contentGateLevel ?? 'full';
    const limits = settings?.contentLimits ?? {};
    const built = [];
    asArray(result.entries).slice(0, MAX_ENTRIES).forEach((entry, index) => {
        const builtEntry = buildLoreWorldBookEntry({
            id: entry?.id,
            title: entry?.title,
            keys: entry?.keys,
            content: entry?.content,
            tags: entry?.tags,
            depth: Number.isInteger(entry?.depth) ? entry.depth : 4,
            order: Number.isInteger(entry?.order)
                ? entry.order
                : (Number.isFinite(entry?.importance)
                    // Higher importance inserts earlier; order is the stable
                    // tie-break used by injection selection.
                    ? Math.max(0, 200 - Math.round(entry.importance * 10))
                    : 200 + index),
            uid: index,
            gateLevel: typeof gateLevel === 'string' ? gateLevel : 'full',
            limits,
        });
        if (builtEntry) {
            built.push(builtEntry);
        }
    });

    const merged = built.length > 0
        ? mergeLoreEntries(document, built)
        : document;
    const changed = built.length > 0
        && JSON.stringify(isObject(document) ? document.entries ?? {} : {}) !== JSON.stringify(merged.entries);

    let saved = false;
    let saveError = null;
    if (changed && adapter && typeof adapter.save === 'function' && typeof bookName === 'string') {
        try {
            await Promise.resolve(adapter.save(bookName, merged));
            saved = true;
        } catch (error) {
            saveError = error?.message ?? String(error);
            logWarning(log, 'Could not save the lore book; relationship state kept', error);
        }
    } else if (changed) {
        saveError = 'No world-book adapter is available to save lore entries';
    }

    const mergedEntries = built.length > 0 && isObject(merged)
        ? Object.values(merged.entries ?? {}).filter((entry) => {
            const id = parseGeneratedLoreEntryId(entry);
            return id !== null && built.some((item) => parseGeneratedLoreEntryId(item) === id);
        })
        : [];

    return {
        ran: true,
        source: result.source ?? 'agent',
        entries: mergedEntries,
        relationships: applied.ok ? asArray(applied.events) : [],
        selections: asArray(result.selections),
        rejected: asArray(result.rejected),
        document: built.length > 0 ? merged : document,
        saved,
        error: saveError,
    };
}
