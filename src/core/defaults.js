/**
 * Default settings for the Neo Terra Framework.
 *
 * The defaults are deep-frozen so feature modules cannot accidentally mutate
 * shared state. `cloneDefaults()` returns a fresh, mutable copy.
 */

import { DEFAULT_CONTEXT_DEPTH, SCHEMA_VERSION } from './constants.js';

export const DEFAULT_BAD_END_PROMPT = `You are the Neo Terra Bad End Detector. Decide only whether a character has reached a terminal state.

Evaluate deterministic evidence first: stamina at 0 with lethal intent, willpower at 0 with captivity, maximum corruption, a completed brainwashing or possession, a declared permanent transformation, or indefinite imprisonment with no escape path.

Never infer a bad end from prose alone. When ambiguous, return confidence below the threshold and let the deterministic evidence win. Never delete, resurrect, or duplicate a character. Return JSON only.`;

export const DEFAULT_BAD_END_EPILOGUE_PROMPT = `Write a 1-3 paragraph epilogue for the recorded bad end. State what happened, what it means for the character and the people around them, and what (if anything) remains possible. Keep it consistent with the recorded cause, location, and continuity key. Do not resolve the wider season.`;

export const BAD_END_PROMPT_PLACEHOLDERS = Object.freeze([
    '{{character}}',
    '{{state}}',
    '{{recentEvents}}',
    '{{limits}}',
    '{{candidates}}',
]);

function freezeDeep(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            freezeDeep(child);
        }
    }
    return value;
}

export const DEFAULT_SETTINGS = freezeDeep({
    schemaVersion: SCHEMA_VERSION,

    // Content gate is opt-in; `full` is a strict no-op.
    contentGate: 'full',

    // Director/Narrator is the default cast strategy.
    castMode: 'director',

    // Cross-season guests. When allowed, any registry character can be played
    // in any playable season after an explicit warning acknowledgment. Canon
    // beats then adapt instead of failing; Sandbox behavior is unchanged.
    identity: {
        allowGuests: true,
        guestCanonBeats: 'adapt',
    },

    // Soft canon-beat deadlines; `off` disables escalation.
    beatDeadlinePressure: 'standard',

    // Fiction time. The mechanical turn always increments; a hold freezes the
    // in-game date and slot.
    clock: {
        enabled: true,
        slotsPerDay: 5,
        timeOfDayStart: 'evening',
        autoHold: { combat: true, encounter: false, beat: false },
        maxHoldTurns: 20,
    },

    // Deterministic scene-drift analyzer plus the explicit cut.
    pacing: {
        enabled: true,
        stallTurns: 3,
        sceneMaxTurns: 12,
        threatNudgeTurns: 10,
        cutScore: 4,
        nudgeScore: 2,
        cutSlots: 2,
        snoozeTurns: 3,
    },

    // Off-screen world tick. A day must pass in fiction time before factions,
    // threats, NPCs, and rumors move; rates are authored in data/agendas.json.
    worldTick: {
        enabled: true,
        allowNpcMovesDuringCombat: false,
    },

    // In-world newspaper. Opt-in: when disabled there is no edition, no agent
    // call, and no state write. With the feature on but the agent off, a
    // deterministic edition is always available.
    newspaper: {
        enabled: false,
        style: 'auto',
        everyDays: 3,
        minEvents: 6,
        maxHeadlines: 6,
    },

    cyoa: {
        enabled: false,
        count: 4,
        theme: 'auto',
        maxLabelLength: 100,
        contentMix: {
            action: 3,
            dialogue: 3,
            romance: 1,
            investigation: 1,
            travel: 1,
            lewd: 0,
        },
        promptOverride: '',
        // Combat choices are a second, independent setting.
        combatChoices: {
            enabled: false,
            count: 4,
            theme: 'tactical',
            maxLabelLength: 100,
            contentMix: {
                action: 4,
                dialogue: 1,
                romance: 0,
                investigation: 0,
                travel: 0,
                lewd: 0,
            },
            promptOverride: '',
        },
    },

    ending: {
        // Default villain-victory epilogue length. Clamped to 3-8 by the flow.
        paragraphs: 5,
        prompt: '',
        // Dynamic Epilogue-agent prose is review-gated and off by default. The
        // deterministic season template always works without a model call.
        dynamic: false,
    },

    // Season kickoff. The opening frame and the "your move" card are always
    // posted; `auto` additionally sends `prompt` as the player on a fresh chat,
    // which triggers one narrator turn. Off by default.
    kickoff: {
        auto: false,
        prompt: 'I take in my surroundings and step into the story.',
    },

    badEnds: {
        enabled: false,
        allowDeadContinuation: false,
        minConfidence: 0.6,
        prompt: DEFAULT_BAD_END_PROMPT,
        epiloguePrompt: DEFAULT_BAD_END_EPILOGUE_PROMPT,
    },

    agents: {
        architect: {
            // The agent stays available for explicit runs; the automatic
            // season-start pass is opt-in (`seasonStart`, default off). The
            // deterministic season seed always works without it.
            enabled: true,
            seasonStart: false,
            connectionProfileId: '',
            model: '',
            temperature: 0.4,
            maxTokens: 1600,
            cadence: 'once',
        },
        storyline: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.5,
            maxTokens: 1600,
            cadence: 'everyNTurns',
            everyNTurns: 6,
            onLocationChange: true,
        },
        stateTracker: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.2,
            maxTokens: 900,
            cadence: 'everyTurn',
        },
        castDirector: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.3,
            maxTokens: 1000,
            // Re-runs on travel/arrival and every N turns without a scene change.
            cadence: 'sceneChange',
            everyNTurns: 4,
        },
        lore: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.4,
            maxTokens: 900,
            cadence: 'everyNTurns',
            everyNTurns: 10,
        },
        auditor: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.1,
            maxTokens: 700,
            // Continuity is checked when the act changes, with a turn fallback.
            cadence: 'actChange',
            everyNTurns: 8,
        },
        epilogue: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.8,
            maxTokens: 2400,
            cadence: 'once',
        },
        choices: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.8,
            maxTokens: 500,
            cadence: 'afterAssistantTurn',
        },
        badEnd: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.2,
            maxTokens: 700,
            cadence: 'afterTracker',
        },
        newspaper: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.7,
            maxTokens: 900,
            cadence: 'newspaper',
        },
        formArchitect: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.6,
            maxTokens: 1600,
            cadence: 'onTransform',
        },
        characterCreator: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.9,
            maxTokens: 9000,
            timeoutMs: 180000,
            minMaxTokens: 6000,
            cadence: 'onRequest',
        },
        // Fills a played character's goals when the card yields nothing usable.
        // `onIdentityChange` is a marker: the Codex mount and the bad-end
        // self-continuation call it explicitly, never on every turn.
        goalInference: {
            enabled: true,
            connectionProfileId: '',
            model: '',
            temperature: 0.3,
            maxTokens: 500,
            timeoutMs: 20000,
            cadence: 'onIdentityChange',
        },
    },

    tokenBudget: {
        total: 6000,
        scene: 700,
        cast: 2200,
        player: 800,
        combat: 500,
        world: 900,
        continuity: 500,
        lore: 900,
        pacing: 350,
        news: 350,
        domain: 350,
        characterProfile: 1200,
    },

    combat: {
        // Dice conflict cap; the flow clamps the effective value to 3-20.
        maxRounds: 8,
    },

    // Prompt blocks are injected by the manifest generate_interceptor.
    // Each block can be toggled off; depth is measured from the end of chat.
    context: {
        enabled: true,
        depth: DEFAULT_CONTEXT_DEPTH,
        blocks: {
            scene: true,
            cast: true,
            player: true,
            combat: true,
            world: true,
            continuity: true,
            lore: true,
            pacing: true,
            news: true,
            // Villain-POV domain sensorium. Hero seasons render nothing even
            // when this is on.
            domain: true,
        },
    },

    contentLimits: {
        // Inherit the global gate unless explicitly overridden per character.
        player: '',
        characters: {},
    },

    map: {
        showFogOfWar: false,
        // Fog of war: per-chat exploration layered over the generated map.
        fog: {
            mode: 'rumors',
            revealOnTravel: true,
            showRumoredLabels: true,
            gateTravel: true,
            revealNeighbors: true,
        },
        // A successful travel posts the arrival frame and then closes the shell
        // so the chat is visible. A rejected travel keeps the map open.
        closeOnTravel: true,
        // Announce arrivals with a destination toast (and, while the map stays
        // open, the Return-to-chat pulse and sidebar card).
        arrivalFeedback: true,
        // World overlay ("where am I in the story") on the map tab.
        showOverlay: true,
        showThreats: true,
        showFactions: true,
        showRumors: true,
        showHeadlines: true,
        // Off-screen city activity (world tick) in the overlay; no LLM needed.
        showOffscreen: true,
        showFactionTint: true,
        maxHeadlines: 5,
        // Override editor (never touches the SVGs).
        editorEnabled: true,
    },

    // Gameplay UI surfaces. Settings, export/import, and agent configuration are
    // not part of this block: they stay in the Extensions drawer.
    ui: {
        // The HUD is a collapsible right rail; visible only while a world exists.
        hudEnabled: true,
        hudCollapsed: false,
        // Cinematic chat decorations for Neo Terra scene frames (header/portraits).
        cinematicChat: true,
        // First-run wizard opens once; the flag is per user.
        firstRunWizardSeen: false,
    },

    debug: false,
});

/** Return a fresh, mutable copy of the default settings. */
export function cloneDefaults() {
    return structuredClone(DEFAULT_SETTINGS);
}

/** Recommended first-run presets (applied to a settings document). */
export const UI_PRESETS = Object.freeze([
    {
        id: 'cinematic',
        label: 'Cinematic',
        description: 'Clock, world tick, pacing, choices, HUD, and scene cards on.',
    },
    {
        id: 'classic',
        label: 'Classic',
        description: 'The V1.1 defaults: deterministic trackers, no extra chrome.',
    },
    {
        id: 'sandbox',
        label: 'Sandbox',
        description: 'Loose deadlines and pacing; play without canon pressure.',
    },
]);

/**
 * Apply a recommended preset. Unknown ids return a clone of the input; the
 * caller owns persistence so this stays pure and testable.
 */
export function applyUiPreset(settings, id) {
    const base = settings && typeof settings === 'object'
        ? structuredClone(settings)
        : cloneDefaults();
    if (id === 'cinematic') {
        return {
            ...base,
            clock: { ...(base.clock ?? {}), enabled: true },
            worldTick: { ...(base.worldTick ?? {}), enabled: true },
            pacing: { ...(base.pacing ?? {}), enabled: true },
            cyoa: { ...(base.cyoa ?? {}), enabled: true },
            ui: {
                ...(base.ui ?? {}),
                hudEnabled: true,
                hudCollapsed: false,
                cinematicChat: true,
            },
            agents: {
                ...(base.agents ?? {}),
                stateTracker: { ...(base.agents?.stateTracker ?? {}), enabled: true },
                storyline: { ...(base.agents?.storyline ?? {}), enabled: true },
            },
        };
    }
    if (id === 'sandbox') {
        return {
            ...base,
            beatDeadlinePressure: 'off',
            pacing: { ...(base.pacing ?? {}), enabled: false },
            clock: { ...(base.clock ?? {}), enabled: false },
            agents: {
                ...(base.agents ?? {}),
                storyline: { ...(base.agents?.storyline ?? {}), enabled: false },
            },
        };
    }
    if (id === 'classic') {
        return {
            ...base,
            clock: { ...(base.clock ?? {}), enabled: true },
            worldTick: { ...(base.worldTick ?? {}), enabled: true },
            pacing: { ...(base.pacing ?? {}), enabled: true },
            cyoa: { ...(base.cyoa ?? {}), enabled: true },
            ui: { ...(base.ui ?? {}), hudEnabled: true, cinematicChat: false },
        };
    }
    return base;
}
