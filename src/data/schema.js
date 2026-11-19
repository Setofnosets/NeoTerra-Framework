/**
 * Tiny, dependency-free validators for the generated character registry and
 * the authored form data.
 *
 * These validators never throw for ordinary validation failures; callers get
 * `{ ok, errors }` and decide whether to print, repair, or abort.
 */

export const SEASON_IDS = Object.freeze(['s1', 's1dark', 's2', 's3', 's4', 'others']);

export const SIDES = Object.freeze(['hero', 'villain', 'vigilante', 'civilian', 'neutral']);

export const FORM_KINDS = Object.freeze([
    'base',
    'corrupted',
    'cleansed',
    'treated',
    'infected',
    'coldhearted',
    'knighted',
    'poisoned',
    'alt-version',
]);

const FORM_ROLES = Object.freeze(['base', 'alt']);

function result(errors) {
    return { ok: errors.length === 0, errors };
}

function add(errors, path, message) {
    errors.push({ path, message });
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPosixRelativePath(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        !value.includes('\\') &&
        !value.startsWith('/') &&
        !/^[a-zA-Z]:/.test(value)
    );
}

function checkCounts(errors, counts, entries, seasonIds = SEASON_IDS, path = 'counts') {
    if (!isObject(counts)) {
        add(errors, path, 'counts must be an object');
        return;
    }

    const actual = Object.fromEntries(seasonIds.map((seasonId) => [seasonId, 0]));
    for (const entry of entries) {
        if (isObject(entry) && Object.hasOwn(actual, entry.seasonId)) {
            actual[entry.seasonId] += 1;
        }
    }
    actual.total = entries.length;

    for (const seasonId of seasonIds) {
        if (counts[seasonId] !== actual[seasonId]) {
            add(
                errors,
                `${path}.${seasonId}`,
                `expected ${actual[seasonId]} entries, found ${String(counts[seasonId])}`,
            );
        }
    }
    if (counts.total !== actual.total) {
        add(errors, `${path}.total`, `expected ${actual.total} entries, found ${String(counts.total)}`);
    }
}

/**
 * Validate `data/characters/index.json`.
 *
 * @param {unknown} registry
 * @param {{ seasonIds?: string[] }} [options] discovered season ids
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateRegistry(registry, options = {}) {
    const errors = [];
    const inferred = new Set(SEASON_IDS);
    if (isObject(registry) && Array.isArray(registry.entries)) {
        for (const entry of registry.entries) {
            if (isObject(entry) && typeof entry.seasonId === 'string' && entry.seasonId.length > 0) {
                inferred.add(entry.seasonId);
            }
        }
    }
    const seasonIds = Array.isArray(options.seasonIds) && options.seasonIds.length > 0
        ? [...options.seasonIds]
        : [...inferred];

    if (!isObject(registry)) {
        add(errors, '$', 'registry must be an object');
        return result(errors);
    }
    if (registry.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (registry.generatedBy !== 'tools/build-data.mjs') {
        add(errors, 'generatedBy', 'must be "tools/build-data.mjs"');
    }
    if (registry.source !== 'Chars') {
        add(errors, 'source', 'must be "Chars"');
    }

    const entries = registry.entries;
    if (!Array.isArray(entries)) {
        add(errors, 'entries', 'must be an array');
        return result(errors);
    }

    const byId = new Map();
    entries.forEach((entry, index) => {
        const path = `entries[${index}]`;

        if (!isObject(entry)) {
            add(errors, path, 'must be an object');
            return;
        }

        const required = [
            'id',
            'file',
            'cardPath',
            'seasonId',
            'dataName',
            'displayName',
            'aliases',
            'side',
            'threatLevel',
            'formRole',
            'altOf',
            'formKind',
            'formGroup',
            'tags',
            'bundle',
            'actors',
            'npcEligible',
        ];
        for (const field of required) {
            if (!Object.hasOwn(entry, field)) {
                add(errors, `${path}.${field}`, 'required field is missing');
            }
        }

        if (typeof entry.id !== 'string' || entry.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (byId.has(entry.id)) {
            add(errors, `${path}.id`, `duplicate id "${entry.id}"`);
        } else {
            byId.set(entry.id, entry);
        }

        if (!seasonIds.includes(entry.seasonId)) {
            add(errors, `${path}.seasonId`, `unknown season "${String(entry.seasonId)}"`);
        } else if (typeof entry.id === 'string' && !entry.id.startsWith(`${entry.seasonId}.`)) {
            add(errors, `${path}.id`, `id must start with "${entry.seasonId}."`);
        }

        for (const field of ['file', 'cardPath']) {
            if (!isPosixRelativePath(entry[field])) {
                add(errors, `${path}.${field}`, 'must be a repo-relative POSIX path');
            }
        }
        if (typeof entry.cardPath === 'string' && !entry.cardPath.startsWith('Chars/')) {
            add(errors, `${path}.cardPath`, 'must start with "Chars/"');
        }
        if (Object.hasOwn(entry, 'avatarPath')
            && !/^Chars\/.+\.png$/i.test(String(entry.avatarPath ?? ''))) {
            add(errors, `${path}.avatarPath`, 'must be a PNG path under Chars/ when present');
        }

        if (typeof entry.dataName !== 'string' || entry.dataName.trim().length === 0) {
            add(errors, `${path}.dataName`, 'must be a non-empty string');
        }
        if (typeof entry.displayName !== 'string' || entry.displayName.trim().length === 0) {
            add(errors, `${path}.displayName`, 'must be a non-empty string');
        }
        if (!isStringArray(entry.aliases)) {
            add(errors, `${path}.aliases`, 'must be an array of strings');
        }
        if (!SIDES.includes(entry.side)) {
            add(errors, `${path}.side`, `unknown side "${String(entry.side)}"`);
        }
        if (entry.threatLevel !== null && typeof entry.threatLevel !== 'string') {
            add(errors, `${path}.threatLevel`, 'must be a string or null');
        }
        if (
            Object.hasOwn(entry, 'threatLevelRaw') &&
            entry.threatLevelRaw !== null &&
            typeof entry.threatLevelRaw !== 'string'
        ) {
            add(errors, `${path}.threatLevelRaw`, 'must be a string when present');
        }

        if (!FORM_ROLES.includes(entry.formRole)) {
            add(errors, `${path}.formRole`, `unknown form role "${String(entry.formRole)}"`);
        }
        if (entry.altOf !== null && typeof entry.altOf !== 'string') {
            add(errors, `${path}.altOf`, 'must be a string or null');
        }
        if (entry.formRole === 'base' && entry.altOf !== null) {
            add(errors, `${path}.altOf`, 'base forms must have a null altOf');
        }
        if (entry.formRole === 'alt' && typeof entry.altOf !== 'string') {
            add(errors, `${path}.altOf`, 'alternate forms must reference a base id');
        }
        if (!FORM_KINDS.includes(entry.formKind)) {
            add(errors, `${path}.formKind`, `unknown form kind "${String(entry.formKind)}"`);
        }
        if (entry.formGroup !== null && typeof entry.formGroup !== 'string') {
            add(errors, `${path}.formGroup`, 'must be a string or null');
        }
        if (entry.formRole === 'alt' && typeof entry.formGroup !== 'string') {
            add(errors, `${path}.formGroup`, 'alternate forms must belong to a group');
        }
        if (!isStringArray(entry.tags)) {
            add(errors, `${path}.tags`, 'must be an array of strings');
        }

        if (typeof entry.bundle !== 'boolean') {
            add(errors, `${path}.bundle`, 'must be a boolean');
        }
        if (entry.bundle === true) {
            if (!Array.isArray(entry.actors) || entry.actors.length === 0) {
                add(errors, `${path}.actors`, 'bundles must declare at least one actor');
            } else {
                entry.actors.forEach((actor, actorIndex) => {
                    const actorPath = `${path}.actors[${actorIndex}]`;
                    if (!isObject(actor)) {
                        add(errors, actorPath, 'actor must be an object');
                        return;
                    }
                    if (typeof actor.name !== 'string' || actor.name.trim().length === 0) {
                        add(errors, `${actorPath}.name`, 'must be a non-empty string');
                    }
                    if (!isStringArray(actor.aliases)) {
                        add(errors, `${actorPath}.aliases`, 'must be an array of strings');
                    }
                });
            }
            if (entry.npcEligible !== false) {
                add(errors, `${path}.npcEligible`, 'bundles must not be NPC-eligible');
            }
        } else if (entry.bundle === false) {
            if (entry.actors !== null) {
                add(errors, `${path}.actors`, 'single characters must have null actors');
            }
            if (entry.npcEligible !== true) {
                add(errors, `${path}.npcEligible`, 'single characters must be NPC-eligible');
            }
        }
    });

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!isObject(entry) || typeof entry.altOf !== 'string') {
            continue;
        }
        const base = byId.get(entry.altOf);
        if (!base) {
            add(errors, `entries[${index}].altOf`, `unresolved base id "${entry.altOf}"`);
            continue;
        }
        if (base.formRole !== 'base') {
            add(errors, `entries[${index}].altOf`, `"${entry.altOf}" is not a base form`);
        }
        // Cross-season packs are allowed: an alternate may join a group that is
        // rooted in another season (e.g. Blazing Prism joins the S1 Vaiva pack).
    }

    checkCounts(errors, registry.counts, entries, seasonIds);

    return result(errors);
}

/**
 * Validate `data/form-groups.json`.
 *
 * @param {unknown} formGroups
 * @param {{ seasonIds?: string[] }} [options]
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateFormGroups(formGroups, options = {}) {
    const errors = [];
    const inferred = new Set(SEASON_IDS);
    if (isObject(formGroups) && Array.isArray(formGroups.groups)) {
        for (const group of formGroups.groups) {
            if (isObject(group) && typeof group.seasonId === 'string' && group.seasonId.length > 0) {
                inferred.add(group.seasonId);
            }
        }
    }
    const seasonIds = Array.isArray(options.seasonIds) && options.seasonIds.length > 0
        ? [...options.seasonIds]
        : [...inferred];

    if (!isObject(formGroups)) {
        add(errors, '$', 'form groups must be an object');
        return result(errors);
    }
    if (formGroups.schemaVersion !== 1) {
        add(errors, 'schemaVersion', 'must be 1');
    }
    if (!Array.isArray(formGroups.groups)) {
        add(errors, 'groups', 'must be an array');
        return result(errors);
    }

    const groupIds = new Set();
    const memberOwners = new Map();

    formGroups.groups.forEach((group, index) => {
        const path = `groups[${index}]`;
        if (!isObject(group)) {
            add(errors, path, 'must be an object');
            return;
        }

        if (typeof group.id !== 'string' || group.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (groupIds.has(group.id)) {
            add(errors, `${path}.id`, `duplicate group id "${group.id}"`);
        } else {
            groupIds.add(group.id);
        }

        if (!seasonIds.includes(group.seasonId)) {
            add(errors, `${path}.seasonId`, `unknown season "${String(group.seasonId)}"`);
        } else if (typeof group.id === 'string' && !group.id.startsWith(`${group.seasonId}.`)) {
            add(errors, `${path}.id`, `group id must start with "${group.seasonId}."`);
        }

        if (typeof group.label !== 'string' || group.label.trim().length === 0) {
            add(errors, `${path}.label`, 'must be a non-empty string');
        }
        if (!isPosixRelativePath(group.base)) {
            add(errors, `${path}.base`, 'must be a path relative to Chars/');
        }
        if (!Array.isArray(group.members) || group.members.length === 0) {
            add(errors, `${path}.members`, 'must be a non-empty array');
            return;
        }

        const seen = new Set();
        group.members.forEach((member, memberIndex) => {
            const memberPath = `${path}.members[${memberIndex}]`;
            if (!isPosixRelativePath(member)) {
                add(errors, memberPath, 'must be a path relative to Chars/');
                return;
            }
            if (seen.has(member)) {
                add(errors, memberPath, `duplicate member "${member}"`);
            }
            seen.add(member);
            const owner = memberOwners.get(member);
            if (owner && owner !== group.id) {
                add(errors, memberPath, `"${member}" already belongs to group "${owner}"`);
            } else {
                memberOwners.set(member, group.id);
            }
        });

        if (typeof group.base === 'string' && !seen.has(group.base)) {
            add(errors, `${path}.base`, 'base must be one of the group members');
        }
    });

    return result(errors);
}

/**
 * Validate `data/form-rules.json`.
 *
 * @param {unknown} rules
 * @param {{ entries?: unknown[] } | null | undefined} registry
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateFormRules(rules, registry) {
    const errors = [];

    let list = null;
    if (Array.isArray(rules)) {
        list = rules;
    } else if (isObject(rules)) {
        if (rules.schemaVersion !== 1) {
            add(errors, 'schemaVersion', 'must be 1');
        }
        if (!Array.isArray(rules.rules)) {
            add(errors, 'rules', 'must be an array');
            return result(errors);
        }
        list = rules.rules;
    } else {
        add(errors, '$', 'form rules must be an object or an array');
        return result(errors);
    }

    const byId = new Map();
    const registryEntries = Array.isArray(registry?.entries)
        ? registry.entries
        : isObject(registry?.byId)
          ? Object.values(registry.byId)
          : null;
    if (registryEntries) {
        for (const entry of registryEntries) {
            if (isObject(entry) && typeof entry.id === 'string') {
                byId.set(entry.id, entry);
            }
        }
    }

    const ids = new Set();
    const pairs = new Set();
    const inbound = new Set();

    list.forEach((rule, index) => {
        const path = `rules[${index}]`;
        if (!isObject(rule)) {
            add(errors, path, 'must be an object');
            return;
        }

        if (typeof rule.id !== 'string' || rule.id.length === 0) {
            add(errors, `${path}.id`, 'must be a non-empty string');
        } else if (ids.has(rule.id)) {
            add(errors, `${path}.id`, `duplicate rule id "${rule.id}"`);
        } else {
            ids.add(rule.id);
        }

        for (const field of ['from', 'to', 'trigger']) {
            if (typeof rule[field] !== 'string' || rule[field].length === 0) {
                add(errors, `${path}.${field}`, 'must be a non-empty string');
            }
        }
        if (rule.sourceFaction !== null && typeof rule.sourceFaction !== 'string') {
            add(errors, `${path}.sourceFaction`, 'must be a string or null');
        }
        if (rule.reversibleBy !== null && typeof rule.reversibleBy !== 'string') {
            add(errors, `${path}.reversibleBy`, 'must be a string or null');
        }
        if (typeof rule.permanent !== 'boolean') {
            add(errors, `${path}.permanent`, 'must be a boolean');
        }

        if (typeof rule.from === 'string' && typeof rule.to === 'string') {
            if (rule.from === rule.to) {
                add(errors, `${path}.to`, 'a rule cannot transform a form into itself');
            }
            const pair = `${rule.from}->${rule.to}`;
            if (pairs.has(pair)) {
                add(errors, path, `duplicate rule for ${pair}`);
            }
            pairs.add(pair);
            inbound.add(rule.to);
        }

        if (byId.size > 0) {
            const from = byId.get(rule.from);
            const to = byId.get(rule.to);
            if (!from) {
                add(errors, `${path}.from`, `unresolved registry id "${String(rule.from)}"`);
            }
            if (!to) {
                add(errors, `${path}.to`, `unresolved registry id "${String(rule.to)}"`);
            }
            // Cross-season packs are allowed; the build check verifies the ids
            // and reachability instead of banning the edge outright.
        }
    });

    if (byId.size > 0) {
        for (const entry of byId.values()) {
            if (entry.formRole === 'alt' && !inbound.has(entry.id)) {
                add(errors, `rules`, `alternate form "${entry.id}" has no inbound rule`);
            }
        }
    }

    return result(errors);
}

/**
 * Validate a raw SillyTavern character card. Only `data.*` is authoritative;
 * the legacy top-level block is intentionally ignored.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateCardSource(raw) {
    const errors = [];

    if (!isObject(raw)) {
        add(errors, '$', 'card must be an object');
        return result(errors);
    }
    if (!isObject(raw.data)) {
        add(errors, 'data', 'card is missing its data object');
        return result(errors);
    }
    if (typeof raw.data.name !== 'string' || raw.data.name.trim().length === 0) {
        add(errors, 'data.name', 'must be a non-empty string');
    }
    if (typeof raw.data.description !== 'string') {
        add(errors, 'data.description', 'must be a string');
    }
    if (Object.hasOwn(raw.data, 'tags') && !isStringArray(raw.data.tags)) {
        add(errors, 'data.tags', 'must be an array of strings when present');
    }

    return result(errors);
}
