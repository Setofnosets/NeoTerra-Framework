/**
 * Form-group and transformation-rule helpers.
 *
 * The registry stores membership by group id. These helpers resolve that
 * membership into entries and provide the exclusivity contract reused by the
 * cast/state layers.
 */

import { validateFormGroups, validateFormRules } from './schema.js';

const FORM_GROUPS_URL = new URL('../../data/form-groups.json', import.meta.url);
const FORM_RULES_URL = new URL('../../data/form-rules.json', import.meta.url);

let formGroupsCache = null;
let formRulesCache = null;
let formGroupsInFlight = null;
let formRulesInFlight = null;

function ruleList(rules) {
    if (Array.isArray(rules)) {
        return rules;
    }
    return Array.isArray(rules?.rules) ? rules.rules : [];
}

function normalizePath(value) {
    return String(value ?? '')
        .split('\\')
        .join('/')
        .replace(/^Chars\//, '');
}

/**
 * Resolve a group reference that may be an entry id or a path relative to
 * `Chars/` (the authored form-group format uses paths).
 */
function resolveEntry(byId, byPath, reference) {
    if (typeof reference !== 'string' || reference.length === 0) {
        return null;
    }
    return byId[reference] ?? byPath[normalizePath(reference)] ?? null;
}

async function fetchJson(url, { fetchImpl, label }) {
    if (typeof fetchImpl !== 'function') {
        throw new Error(`${label}: no fetch implementation is available`);
    }
    const response = await fetchImpl(url.href);
    if (response && response.ok === false) {
        throw new Error(
            `${label}: failed to load ${url.href} (HTTP ${response.status ?? 'unknown'})`,
        );
    }
    return response.json();
}

function formatValidationErrors(errors) {
    return errors.map((error) => `${error.path}: ${error.message}`).join('; ');
}

/**
 * Fetch, validate, and cache `data/form-groups.json`.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function loadFormGroups({ fetchImpl = globalThis.fetch } = {}) {
    if (formGroupsCache) {
        return formGroupsCache;
    }
    if (!formGroupsInFlight) {
        formGroupsInFlight = (async () => {
            const formGroups = await fetchJson(FORM_GROUPS_URL, {
                fetchImpl,
                label: 'loadFormGroups',
            });
            const validation = validateFormGroups(formGroups);
            if (!validation.ok) {
                throw new Error(
                    `loadFormGroups: invalid form groups (${formatValidationErrors(validation.errors)})`,
                );
            }
            formGroupsCache = formGroups;
            return formGroups;
        })().finally(() => {
            formGroupsInFlight = null;
        });
    }
    return formGroupsInFlight;
}

/**
 * Fetch, validate, and cache `data/form-rules.json`.
 *
 * @param {{ fetchImpl?: typeof fetch, registry?: object|null }} [options]
 * @returns {Promise<object>}
 */
export async function loadFormRules({ fetchImpl = globalThis.fetch, registry = null } = {}) {
    if (formRulesCache) {
        return formRulesCache;
    }
    if (!formRulesInFlight) {
        formRulesInFlight = (async () => {
            const formRules = await fetchJson(FORM_RULES_URL, {
                fetchImpl,
                label: 'loadFormRules',
            });
            const validation = validateFormRules(formRules, registry);
            if (!validation.ok) {
                throw new Error(
                    `loadFormRules: invalid form rules (${formatValidationErrors(validation.errors)})`,
                );
            }
            formRulesCache = formRules;
            return formRules;
        })().finally(() => {
            formRulesInFlight = null;
        });
    }
    return formRulesInFlight;
}

/** Clear the module-level form-data caches (tests and data regeneration). */
export function clearFormsCache() {
    formGroupsCache = null;
    formRulesCache = null;
    formGroupsInFlight = null;
    formRulesInFlight = null;
}

/**
 * Build resolved form-group and rule lookups.
 *
 * @param {{ entries?: object[] }} registry
 * @param {{ groups?: object[] }} formGroups
 */
export function buildFormIndex(registry, formGroups) {
    const byId = {};
    const byPath = {};

    for (const entry of registry?.entries ?? []) {
        byId[entry.id] = entry;
        if (typeof entry.file === 'string') {
            byPath[normalizePath(entry.file)] = entry;
        }
        if (typeof entry.cardPath === 'string') {
            byPath[normalizePath(entry.cardPath)] = entry;
        }
    }

    const byGroup = {};
    const groupByMemberId = {};

    for (const group of formGroups?.groups ?? []) {
        const base = resolveEntry(byId, byPath, group.baseId ?? group.base);
        const members = (group.members ?? [])
            .map((member) => resolveEntry(byId, byPath, member))
            .filter((entry) => entry !== null);
        const alternates = base ? members.filter((entry) => entry.id !== base.id) : members.slice();

        const view = {
            id: group.id,
            seasonId: group.seasonId,
            label: group.label,
            base,
            baseId: base?.id ?? null,
            members,
            alternates,
            group,
        };
        byGroup[group.id] = view;
        for (const member of members) {
            groupByMemberId[member.id] = view;
        }
    }

    return { byGroup, groupByMemberId, byId, byPath };
}

/**
 * Look up a group by group id or by any member/entry id.
 */
export function getFormGroup(formIndex, id) {
    return formIndex?.byGroup?.[id] ?? formIndex?.groupByMemberId?.[id] ?? null;
}

export function getBaseForm(formIndex, id) {
    return getFormGroup(formIndex, id)?.base ?? null;
}

export function getAlternateForms(formIndex, id) {
    const group = getFormGroup(formIndex, id);
    return group ? group.alternates.slice() : [];
}

/**
 * Return the single member whose state is `'active'` (or `true`), else null.
 */
export function getActiveForm(formIndex, state, groupId) {
    const group = getFormGroup(formIndex, groupId);
    if (!group || !state || typeof state !== 'object') {
        return null;
    }

    const active = group.members.filter((member) => {
        const value = state[member.id];
        return value === 'active' || value === true;
    });
    return active.length === 1 ? active[0] : null;
}

export function findFormRule(rules, fromId, toId) {
    return ruleList(rules).find((rule) => rule.from === fromId && rule.to === toId) ?? null;
}

export function isLegalTransform(rules, fromId, toId) {
    return findFormRule(rules, fromId, toId) !== null;
}

/** Outgoing rules from `fromId` that can be undone. */
export function getReversibleRules(rules, fromId) {
    return ruleList(rules).filter(
        (rule) => rule.from === fromId && (rule.permanent === false || Boolean(rule.reversibleBy)),
    );
}

function normalizeActiveIds(activeIds) {
    if (activeIds instanceof Set) {
        return [...activeIds];
    }
    if (Array.isArray(activeIds)) {
        return activeIds;
    }
    if (activeIds && typeof activeIds === 'object') {
        return Object.entries(activeIds)
            .filter(([, value]) => value === 'active' || value === true)
            .map(([id]) => id);
    }
    return [];
}

/**
 * Group character ids by form group. Shared by the array/dict exclusivity
 * assertion and the WorldState helpers so both enforce the same rule.
 */
function collectGroupIds(formIndex, ids) {
    const activeByGroup = new Map();
    for (const id of new Set(ids)) {
        const group = formIndex?.groupByMemberId?.[id];
        if (!group) {
            continue;
        }
        const current = activeByGroup.get(group.id) ?? [];
        current.push(id);
        activeByGroup.set(group.id, current);
    }
    return activeByGroup;
}

/**
 * Enforce one active form per group.
 *
 * @param {object} formIndex
 * @param {string[] | Set<string> | Record<string, string | boolean>} activeIds
 * @returns {true}
 */
export function assertFormExclusivity(formIndex, activeIds) {
    const activeByGroup = collectGroupIds(formIndex, normalizeActiveIds(activeIds));
    for (const [groupId, groupIds] of activeByGroup) {
        if (groupIds.length > 1) {
            throw new Error(
                `form exclusivity violated for group "${groupId}": ${groupIds.join(', ')} are active`,
            );
        }
    }
    return true;
}

function groupForCharacter(formIndex, character) {
    if (!character || typeof character !== 'object') {
        return null;
    }
    if (typeof character.formId !== 'string' || character.formId.length === 0) {
        return null;
    }
    const byMember = formIndex?.groupByMemberId?.[character.formId];
    if (byMember) {
        return byMember;
    }
    if (typeof character.formGroup === 'string') {
        return formIndex?.byGroup?.[character.formGroup] ?? null;
    }
    return null;
}

/**
 * Current form-group membership of every WorldState character.
 *
 * Players are included: callers that cast NPCs filter separately.
 *
 * @param {object} state
 * @param {object} [formIndex]
 * @returns {Map<string, string[]>} groupId → sorted character ids
 */
export function getActiveFormGroupIds(state, formIndex = null) {
    const byGroup = new Map();
    for (const character of Object.values(state?.characters ?? {})) {
        if (!character || typeof character !== 'object') {
            continue;
        }
        const group = groupForCharacter(formIndex, character);
        if (!group) {
            continue;
        }
        const current = byGroup.get(group.id) ?? [];
        current.push(character.charId);
        byGroup.set(group.id, current);
    }
    for (const ids of byGroup.values()) {
        ids.sort();
    }
    return byGroup;
}

function isTerminalCharacter(character) {
    return character?.alive === false
        || character?.status === 'dead'
        || character?.status === 'retired'
        || character?.status === 'lost';
}

/**
 * Groups where more than one living character currently carries a member form.
 *
 * @param {object} state
 * @param {object} formIndex
 * @returns {Array<{ groupId: string, characterIds: string[] }>}
 */
export function findFormConflicts(state, formIndex) {
    const byGroup = new Map();
    for (const character of Object.values(state?.characters ?? {})) {
        if (!character || typeof character !== 'object' || isTerminalCharacter(character)) {
            continue;
        }
        const group = groupForCharacter(formIndex, character);
        if (!group) {
            continue;
        }
        const ids = byGroup.get(group.id) ?? [];
        ids.push(character.charId);
        byGroup.set(group.id, ids);
    }

    const conflicts = [];
    for (const [groupId, ids] of byGroup) {
        if (ids.length > 1) {
            conflicts.push({ groupId, characterIds: ids.slice().sort() });
        }
    }
    return conflicts.sort((a, b) => a.groupId.localeCompare(b.groupId));
}

/**
 * Assert that no two living characters share a form group.
 *
 * @param {object} state
 * @param {object} formIndex
 * @returns {true}
 */
export function assertStateFormExclusivity(state, formIndex) {
    const conflicts = findFormConflicts(state, formIndex);
    if (conflicts.length > 0) {
        const first = conflicts[0];
        throw new Error(
            `form exclusivity violated for group "${first.groupId}": ${first.characterIds.join(', ')} are active`,
        );
    }
    return true;
}

function isBaseCandidate(group, character) {
    if (!group || !character) {
        return false;
    }
    if (character.formId === group.baseId) {
        return true;
    }
    if (character.formRole === 'base') {
        return true;
    }
    return (group.members ?? []).some(
        (member) => member.id === character.formId && member.formRole === 'base',
    );
}

function compareCastCandidates(a, b, group, preferIndex) {
    const preferA = preferIndex.get(a.charId) ?? Number.POSITIVE_INFINITY;
    const preferB = preferIndex.get(b.charId) ?? Number.POSITIVE_INFINITY;
    if (preferA !== preferB) {
        return preferA - preferB;
    }
    const baseA = isBaseCandidate(group, a) ? 0 : 1;
    const baseB = isBaseCandidate(group, b) ? 0 : 1;
    if (baseA !== baseB) {
        return baseA - baseB;
    }
    return String(a.charId).localeCompare(String(b.charId));
}

/**
 * Keep at most one character per form group.
 *
 * Deterministic order: explicit `prefer` ids, then the group base form, then
 * lexicographic character id. Characters without a group pass through.
 *
 * @param {object[]} characters
 * @param {object} formIndex
 * @param {{ prefer?: string[] }} [options]
 * @returns {object[]}
 */
export function selectExclusiveCast(characters, formIndex, { prefer = [] } = {}) {
    const list = Array.isArray(characters) ? characters.filter(Boolean) : [];
    const preferOrder = Array.isArray(prefer) ? prefer : [];
    const preferIndex = new Map(preferOrder.map((id, index) => [id, index]));
    const winners = new Map();
    const passthrough = new Set();
    const seenCharIds = new Set();

    for (const character of list) {
        if (!character || typeof character !== 'object') {
            continue;
        }
        const charId = character.charId;
        if (typeof charId !== 'string' || seenCharIds.has(charId)) {
            continue;
        }
        seenCharIds.add(charId);
        const group = groupForCharacter(formIndex, character);
        if (!group) {
            passthrough.add(charId);
            continue;
        }
        const current = winners.get(group.id);
        if (!current || compareCastCandidates(character, current, group, preferIndex) < 0) {
            winners.set(group.id, character);
        }
    }

    const winnerIds = new Set([
        ...passthrough,
        ...[...winners.values()].map((character) => character.charId),
    ]);
    const result = [];
    const emitted = new Set();
    for (const character of list) {
        if (!character || typeof character !== 'object' || emitted.has(character.charId)) {
            continue;
        }
        if (winnerIds.has(character.charId)) {
            emitted.add(character.charId);
            result.push(character);
        }
    }
    return result;
}

const CAST_ELIGIBLE_STATUSES = Object.freeze(['active', 'offscreen', 'missing']);

/**
 * State-field eligibility for NPC casting. Form-group membership is handled by
 * `selectExclusiveCast`; this helper only rejects players and terminal states.
 *
 * @param {object} character
 * @param {{ formIndex?: object, season?: object, playerCharacterId?: string|null }} [options]
 * @returns {boolean}
 */
export function isCastEligible(character, { playerCharacterId = null } = {}) {
    if (!character || typeof character !== 'object') {
        return false;
    }
    if (character.controlledBy === 'player') {
        return false;
    }
    if (typeof playerCharacterId === 'string' && character.charId === playerCharacterId) {
        return false;
    }
    if (character.alive !== true) {
        return false;
    }
    return CAST_ELIGIBLE_STATUSES.includes(character.status);
}
