/**
 * Pure shell-tab visibility.
 *
 * The Domain tab is authored data driven: it appears only for a villain-POV
 * season that declares a `domain` block. Keeping the rule here (instead of in
 * the shell) makes the conditional navigation testable in Node.
 */

import { SHELL_TABS } from '../core/constants.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Domain is visible only for a villain-POV season with a `domain` block. */
export function isDomainTabVisible(state, season) {
    return season?.playerRole === 'villain' && isObject(season?.domain);
}

/**
 * Tabs that may be shown for a state/season pair, in shell order.
 *
 * @param {object|null} state
 * @param {object|null} season
 * @returns {Array<{id: string, label: string}>}
 */
export function resolveVisibleTabs(state, season) {
    return SHELL_TABS.filter((tab) => {
        if (tab.id === 'domain') {
            return isDomainTabVisible(state, season);
        }
        return true;
    });
}

/**
 * Resolve the tab the shell should actually show.
 *
 * When the requested tab is hidden (for example Domain after a chat switch to
 * a hero season) the active tab falls back to Characters, then to the first
 * visible tab.
 */
export function resolveActiveTab(requested, state, season) {
    const visible = resolveVisibleTabs(state, season).map((tab) => tab.id);
    if (visible.includes(requested)) {
        return requested;
    }
    if (visible.includes('characters')) {
        return 'characters';
    }
    return visible[0] ?? 'season';
}
