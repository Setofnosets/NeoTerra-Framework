/**
 * Form-group and transformation-rule helpers.
 *
 * The registry stores membership by group id. These helpers resolve that
 * membership into entries and provide the exclusivity contract reused by the
 * cast/state layers.
 */

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

/**
 * Enforce one active form per group.
 *
 * @param {object} formIndex
 * @param {string[] | Set<string> | Record<string, string | boolean>} activeIds
 * @returns {true}
 */
export function assertFormExclusivity(formIndex, activeIds) {
    let ids;
    if (activeIds instanceof Set) {
        ids = [...activeIds];
    } else if (Array.isArray(activeIds)) {
        ids = activeIds;
    } else if (activeIds && typeof activeIds === 'object') {
        ids = Object.entries(activeIds)
            .filter(([, value]) => value === 'active' || value === true)
            .map(([id]) => id);
    } else {
        ids = [];
    }

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

    for (const [groupId, groupIds] of activeByGroup) {
        if (groupIds.length > 1) {
            throw new Error(
                `form exclusivity violated for group "${groupId}": ${groupIds.join(', ')} are active`,
            );
        }
    }

    return true;
}
