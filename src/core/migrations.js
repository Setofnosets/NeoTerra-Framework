/**
 * Versioned settings migrations and normalization.
 *
 * Migrations run on read, before defaults are merged, so a settings object
 * written by an older build is upgraded in place (and persisted once) rather
 * than silently discarded. Unknown keys are never removed.
 */

import {
    AGENT_IDS,
    BEAT_DEADLINE_PRESSURE,
    CAST_MODES,
    CONTENT_GATE_LEVELS,
    CYOA_THEMES,
    SCHEMA_VERSION,
    TIME_SLOTS,
} from './constants.js';
import {
    DEFAULT_BAD_END_EPILOGUE_PROMPT,
    DEFAULT_BAD_END_PROMPT,
    DEFAULT_SETTINGS,
    cloneDefaults,
} from './defaults.js';
import {
    NEWSROOM_MAX_HEADLINES,
    NEWSPAPER_STYLES,
} from '../data/newsroom.js';

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepClone(value) {
    if (value === undefined) {
        return undefined;
    }
    return structuredClone(value);
}

/**
 * Fill in missing defaults without overwriting values the user already has.
 * Unknown keys in `value` are preserved verbatim.
 */
export function mergeSettings(defaults, value) {
    if (Array.isArray(defaults)) {
        return Array.isArray(value) ? deepClone(value) : deepClone(defaults);
    }
    if (!isPlainObject(defaults)) {
        return value === undefined ? defaults : value;
    }

    const source = isPlainObject(value) ? value : {};
    const out = {};
    for (const [key, defaultValue] of Object.entries(defaults)) {
        out[key] = mergeSettings(defaultValue, source[key]);
    }
    for (const [key, unknownValue] of Object.entries(source)) {
        if (!Object.hasOwn(out, key)) {
            out[key] = deepClone(unknownValue);
        }
    }
    return out;
}

function asBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    const rounded = integer ? Math.round(number) : number;
    return Math.min(max, Math.max(min, rounded));
}

function asEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function asString(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}

function normalizeContentMix(mix, fallback) {
    const source = isPlainObject(mix) ? mix : {};
    const out = {};
    for (const [key, defaultValue] of Object.entries(fallback)) {
        out[key] = asNumber(source[key], defaultValue, { min: 0, max: 10 });
    }
    for (const [key, value] of Object.entries(source)) {
        if (!Object.hasOwn(out, key)) {
            out[key] = value;
        }
    }
    return out;
}

function normalizeCyoa(cyoa, defaults) {
    const combatDefaults = defaults.combatChoices;
    const combat = isPlainObject(cyoa.combatChoices) ? cyoa.combatChoices : {};
    return {
        ...cyoa,
        enabled: asBoolean(cyoa.enabled, defaults.enabled),
        count: asNumber(cyoa.count, defaults.count, { min: 2, max: 6, integer: true }),
        theme: asEnum(cyoa.theme, CYOA_THEMES, defaults.theme),
        maxLabelLength: asNumber(cyoa.maxLabelLength, defaults.maxLabelLength, {
            min: 1,
            max: 100,
            integer: true,
        }),
        contentMix: normalizeContentMix(cyoa.contentMix, defaults.contentMix),
        promptOverride: asString(cyoa.promptOverride, defaults.promptOverride),
        combatChoices: {
            ...combat,
            enabled: asBoolean(combat.enabled, combatDefaults.enabled),
            count: asNumber(combat.count, combatDefaults.count, { min: 2, max: 6, integer: true }),
            theme: asEnum(combat.theme, CYOA_THEMES, combatDefaults.theme),
            maxLabelLength: asNumber(combat.maxLabelLength, combatDefaults.maxLabelLength, {
                min: 1,
                max: 100,
                integer: true,
            }),
            contentMix: normalizeContentMix(combat.contentMix, combatDefaults.contentMix),
            promptOverride: asString(combat.promptOverride, combatDefaults.promptOverride),
        },
    };
}

function normalizeBadEnds(badEnds, defaults) {
    const minConfidence = badEnds.minConfidence === undefined || badEnds.minConfidence === null
        ? defaults.minConfidence
        : asNumber(badEnds.minConfidence, defaults.minConfidence, { min: 0, max: 1 });
    return {
        ...badEnds,
        enabled: asBoolean(badEnds.enabled, defaults.enabled),
        allowDeadContinuation: asBoolean(badEnds.allowDeadContinuation, defaults.allowDeadContinuation),
        minConfidence,
        prompt: asString(badEnds.prompt, defaults.prompt),
        epiloguePrompt: asString(badEnds.epiloguePrompt, defaults.epiloguePrompt),
    };
}

function normalizeAgent(agent, defaults) {
    const out = {
        ...agent,
        enabled: asBoolean(agent.enabled, defaults.enabled),
        connectionProfileId: asString(agent.connectionProfileId, defaults.connectionProfileId),
        model: asString(agent.model, defaults.model),
        temperature: asNumber(agent.temperature, defaults.temperature, { min: 0, max: 2 }),
        maxTokens: asNumber(agent.maxTokens, defaults.maxTokens, {
            min: 64,
            max: 65536,
            integer: true,
        }),
        cadence: asString(agent.cadence, defaults.cadence),
    };
    // A stored value from an older build can be below the documented safe
    // floor (the creator needs room for a full card). Raise only to the floor.
    if (Number.isFinite(defaults.minMaxTokens)) {
        out.maxTokens = Math.max(out.maxTokens, defaults.minMaxTokens);
    }
    if (Object.hasOwn(defaults, 'timeoutMs') || Object.hasOwn(agent, 'timeoutMs')) {
        out.timeoutMs = asNumber(agent.timeoutMs, defaults.timeoutMs ?? 60000, {
            min: 1000,
            max: 600000,
            integer: true,
        });
    }
    if (Object.hasOwn(defaults, 'everyNTurns')) {
        out.everyNTurns = asNumber(agent.everyNTurns, defaults.everyNTurns, {
            min: 1,
            max: 100,
            integer: true,
        });
    }
    if (Object.hasOwn(defaults, 'onLocationChange')) {
        out.onLocationChange = asBoolean(agent.onLocationChange, defaults.onLocationChange);
    }
    return out;
}

function normalizeAgents(agents, defaults) {
    const out = { ...agents };
    for (const id of AGENT_IDS) {
        out[id] = normalizeAgent(isPlainObject(agents[id]) ? agents[id] : {}, defaults[id]);
    }
    return out;
}

function normalizeTokenBudget(budget, defaults) {
    const out = { ...budget };
    for (const [key, defaultValue] of Object.entries(defaults)) {
        out[key] = asNumber(budget[key], defaultValue, { min: 0, max: 1000000, integer: true });
    }
    return out;
}

function normalizeContext(context, defaults) {
    const blocks = isPlainObject(context.blocks) ? context.blocks : {};
    const outBlocks = { ...blocks };
    for (const [key, defaultValue] of Object.entries(defaults.blocks)) {
        outBlocks[key] = asBoolean(blocks[key], defaultValue);
    }
    return {
        ...context,
        enabled: asBoolean(context.enabled, defaults.enabled),
        depth: asNumber(context.depth, defaults.depth, { min: 0, max: 100, integer: true }),
        blocks: outBlocks,
    };
}

function normalizeClock(clock, defaults) {
    const source = isPlainObject(clock) ? clock : {};
    const autoHold = isPlainObject(source.autoHold) ? source.autoHold : {};
    const autoHoldDefaults = defaults.autoHold;
    return {
        ...source,
        enabled: asBoolean(source.enabled, defaults.enabled),
        slotsPerDay: asNumber(source.slotsPerDay, defaults.slotsPerDay, {
            min: 1,
            max: 12,
            integer: true,
        }),
        timeOfDayStart: asEnum(source.timeOfDayStart, TIME_SLOTS, defaults.timeOfDayStart),
        autoHold: {
            ...autoHold,
            combat: asBoolean(autoHold.combat, autoHoldDefaults.combat),
            encounter: asBoolean(autoHold.encounter, autoHoldDefaults.encounter),
            beat: asBoolean(autoHold.beat, autoHoldDefaults.beat),
        },
        maxHoldTurns: asNumber(source.maxHoldTurns, defaults.maxHoldTurns, {
            min: 1,
            max: 1000,
            integer: true,
        }),
    };
}

function normalizeWorldTick(worldTick, defaults) {
    const source = isPlainObject(worldTick) ? worldTick : {};
    return {
        ...source,
        enabled: asBoolean(source.enabled, defaults.enabled),
        allowNpcMovesDuringCombat: asBoolean(
            source.allowNpcMovesDuringCombat,
            defaults.allowNpcMovesDuringCombat,
        ),
    };
}

function normalizeNewspaper(newspaper, defaults) {
    const source = isPlainObject(newspaper) ? newspaper : {};
    return {
        ...source,
        enabled: asBoolean(source.enabled, defaults.enabled),
        style: NEWSPAPER_STYLES.includes(source.style) ? source.style : defaults.style,
        everyDays: asNumber(source.everyDays, defaults.everyDays, { min: 1, max: 60, integer: true }),
        minEvents: asNumber(source.minEvents, defaults.minEvents, { min: 1, max: 50, integer: true }),
        maxHeadlines: asNumber(source.maxHeadlines, defaults.maxHeadlines, {
            min: 1,
            max: NEWSROOM_MAX_HEADLINES,
            integer: true,
        }),
    };
}

function normalizePacing(pacing, defaults) {
    const source = isPlainObject(pacing) ? pacing : {};
    const clamped = (key, min, max) => asNumber(source[key], defaults[key], {
        min,
        max,
        integer: true,
    });
    return {
        ...source,
        enabled: asBoolean(source.enabled, defaults.enabled),
        stallTurns: clamped('stallTurns', 1, 100),
        sceneMaxTurns: clamped('sceneMaxTurns', 2, 500),
        threatNudgeTurns: clamped('threatNudgeTurns', 1, 500),
        cutScore: clamped('cutScore', 1, 20),
        nudgeScore: clamped('nudgeScore', 1, 20),
        cutSlots: clamped('cutSlots', 1, 12),
        snoozeTurns: clamped('snoozeTurns', 1, 100),
    };
}

function normalizeUi(source, defaults = {}) {
    const flag = (value, fallback) => {
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            if (text === 'true') {
                return true;
            }
            if (text === 'false') {
                return false;
            }
        }
        return asBoolean(value, fallback);
    };
    return {
        ...source,
        hudEnabled: flag(source.hudEnabled, defaults.hudEnabled !== false),
        hudCollapsed: flag(source.hudCollapsed, defaults.hudCollapsed === true),
        cinematicChat: flag(source.cinematicChat, defaults.cinematicChat !== false),
        firstRunWizardSeen: flag(source.firstRunWizardSeen, defaults.firstRunWizardSeen === true),
    };
}

/** Normalize known settings fields after defaults and migrations are applied. */
export function normalizeSettings(settings) {    const defaults = DEFAULT_SETTINGS;
    return {
        ...settings,
        contentGate: asEnum(settings.contentGate, CONTENT_GATE_LEVELS, defaults.contentGate),
        castMode: asEnum(settings.castMode, CAST_MODES, defaults.castMode),
        beatDeadlinePressure: asEnum(
            settings.beatDeadlinePressure,
            BEAT_DEADLINE_PRESSURE,
            defaults.beatDeadlinePressure,
        ),
        cyoa: normalizeCyoa(isPlainObject(settings.cyoa) ? settings.cyoa : {}, defaults.cyoa),
        badEnds: normalizeBadEnds(isPlainObject(settings.badEnds) ? settings.badEnds : {}, defaults.badEnds),
        agents: normalizeAgents(isPlainObject(settings.agents) ? settings.agents : {}, defaults.agents),
        tokenBudget: normalizeTokenBudget(
            isPlainObject(settings.tokenBudget) ? settings.tokenBudget : {},
            defaults.tokenBudget,
        ),
        context: normalizeContext(
            isPlainObject(settings.context) ? settings.context : {},
            defaults.context,
        ),
        clock: normalizeClock(
            isPlainObject(settings.clock) ? settings.clock : {},
            defaults.clock,
        ),
        pacing: normalizePacing(
            isPlainObject(settings.pacing) ? settings.pacing : {},
            defaults.pacing,
        ),
        worldTick: normalizeWorldTick(
            isPlainObject(settings.worldTick) ? settings.worldTick : {},
            defaults.worldTick,
        ),
        newspaper: normalizeNewspaper(
            isPlainObject(settings.newspaper) ? settings.newspaper : {},
            defaults.newspaper,
        ),
        contentLimits: {
            ...(isPlainObject(settings.contentLimits) ? settings.contentLimits : {}),
            player: asString(settings.contentLimits?.player, defaults.contentLimits.player),
            characters: isPlainObject(settings.contentLimits?.characters)
                ? settings.contentLimits.characters
                : {},
        },
        ui: normalizeUi(isPlainObject(settings.ui) ? settings.ui : {}, defaults.ui),
        map: {
            ...(isPlainObject(settings.map) ? settings.map : {}),
            showFogOfWar: asBoolean(settings.map?.showFogOfWar, defaults.map.showFogOfWar),
            fog: {
                ...(isPlainObject(settings.map?.fog) ? settings.map.fog : {}),
                mode: settings.map?.fog?.mode === 'hard' ? 'hard' : 'rumors',
                revealOnTravel: asBoolean(settings.map?.fog?.revealOnTravel, defaults.map.fog.revealOnTravel),
                showRumoredLabels: asBoolean(
                    settings.map?.fog?.showRumoredLabels,
                    defaults.map.fog.showRumoredLabels,
                ),
                gateTravel: asBoolean(settings.map?.fog?.gateTravel, defaults.map.fog.gateTravel),
                revealNeighbors: asBoolean(
                    settings.map?.fog?.revealNeighbors,
                    defaults.map.fog.revealNeighbors,
                ),
            },
            showOverlay: asBoolean(settings.map?.showOverlay, defaults.map.showOverlay),
            showThreats: asBoolean(settings.map?.showThreats, defaults.map.showThreats),
            showFactions: asBoolean(settings.map?.showFactions, defaults.map.showFactions),
            showRumors: asBoolean(settings.map?.showRumors, defaults.map.showRumors),
            showHeadlines: asBoolean(settings.map?.showHeadlines, defaults.map.showHeadlines),
            showOffscreen: asBoolean(settings.map?.showOffscreen, defaults.map.showOffscreen),
            showFactionTint: asBoolean(settings.map?.showFactionTint, defaults.map.showFactionTint),
            closeOnTravel: asBoolean(settings.map?.closeOnTravel, defaults.map.closeOnTravel),
            arrivalFeedback: asBoolean(settings.map?.arrivalFeedback, defaults.map.arrivalFeedback),
            maxHeadlines: asNumber(settings.map?.maxHeadlines, defaults.map.maxHeadlines, {
                min: 1,
                max: 20,
                integer: true,
            }),
            editorEnabled: asBoolean(settings.map?.editorEnabled, defaults.map.editorEnabled),
        },
        debug: asBoolean(settings.debug, defaults.debug),
    };
}

/**
 * Migrations keyed by the version they upgrade *from*.
 * Each function receives a mutable clone and must return it.
 */
const MIGRATIONS = {
    // 0 = pre-versioned install (schemaVersion absent or 0).
    0: (settings) => {
        // Pre-versioned builds had no nested combat-choice settings and did not
        // carry the bad-end epilogue prompt. Fill them so normalization has a
        // stable shape; user values are left untouched.
        if (!isPlainObject(settings.cyoa)) {
            settings.cyoa = {};
        }
        if (!isPlainObject(settings.cyoa.combatChoices)) {
            settings.cyoa.combatChoices = {};
        }
        if (!isPlainObject(settings.badEnds)) {
            settings.badEnds = {};
        }
        if (typeof settings.badEnds.epiloguePrompt !== 'string') {
            settings.badEnds.epiloguePrompt = DEFAULT_BAD_END_EPILOGUE_PROMPT;
        }
        if (typeof settings.badEnds.prompt !== 'string') {
            settings.badEnds.prompt = DEFAULT_BAD_END_PROMPT;
        }
        settings.schemaVersion = 1;
        return settings;
    },
};

export function needsMigration(raw) {
    if (!isPlainObject(raw)) {
        return false;
    }
    const version = Number(raw.schemaVersion) || 0;
    return version < SCHEMA_VERSION;
}

/**
 * Upgrade a raw settings object to the current schema, then merge defaults and
 * normalize known fields. The input is not mutated.
 */
export function migrateSettings(raw) {
    if (!isPlainObject(raw)) {
        return cloneDefaults();
    }

    let settings = deepClone(raw);
    let version = Number(settings.schemaVersion) || 0;

    // A settings object from a newer build is merged as-is; do not downgrade it.
    if (version > SCHEMA_VERSION) {
        return mergeSettings(DEFAULT_SETTINGS, settings);
    }

    while (version < SCHEMA_VERSION) {
        const migration = MIGRATIONS[version];
        if (!migration) {
            // No migration registered for this version: jump to the current
            // schema and let normalization fill the gaps.
            settings.schemaVersion = SCHEMA_VERSION;
            break;
        }
        settings = migration(settings) ?? settings;
        const nextVersion = Number(settings.schemaVersion) || version + 1;
        version = nextVersion > version ? nextVersion : version + 1;
        settings.schemaVersion = version;
    }

    const merged = mergeSettings(DEFAULT_SETTINGS, settings);
    merged.schemaVersion = SCHEMA_VERSION;
    return normalizeSettings(merged);
}
