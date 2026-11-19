/**
 * Shared, dependency-free constants for the Neo Terra Framework.
 *
 * Everything here is safe to import from Node tests: no DOM, no SillyTavern
 * globals, no side effects.
 */

export const EXTENSION_ID = 'neoterra';
export const EXTENSION_NAME = 'Neo Terra Framework';
export const EXTENSION_VERSION = '1.1.0';

/** Depth of the injected context message, measured from the end of the prompt. */
export const DEFAULT_CONTEXT_DEPTH = 4;

/** Key used inside SillyTavern's `extensionSettings` object. */
export const SETTINGS_KEY = EXTENSION_ID;

/** Current settings schema version. Bump when a migration is added. */
export const SCHEMA_VERSION = 1;

export const CONTENT_GATE_LEVELS = Object.freeze(['full', 'reduced', 'mature-only', 'strict']);
export const TIME_SLOTS = Object.freeze(['dawn', 'morning', 'afternoon', 'evening', 'night']);
export const CAST_MODES = Object.freeze(['director', 'group', 'solo']);
export const BEAT_DEADLINE_PRESSURE = Object.freeze(['off', 'generous', 'standard', 'harsh']);

export const CYOA_THEMES = Object.freeze([
    'auto',
    'heroic',
    'villainous',
    'romantic',
    'noir',
    'comedic',
    'tactical',
    'lewd',
]);

export const AGENT_IDS = Object.freeze([
    'architect',
    'storyline',
    'stateTracker',
    'castDirector',
    'lore',
    'auditor',
    'epilogue',
    'choices',
    'badEnd',
    'newspaper',
    'formArchitect',
]);

export const UI_IDS = Object.freeze({
    TOP_BUTTON: 'neoterra-top-button',
    ROOT: 'neoterra-root',
    SETTINGS_PANEL: 'neoterra-settings',
    SHELL: 'neoterra-shell',
});

export const SHELL_TABS = Object.freeze([
    { id: 'season', label: 'Story' },
    { id: 'map', label: 'Map' },
    { id: 'characters', label: 'Characters' },
    { id: 'relations', label: 'Relations' },
    { id: 'domain', label: 'Domain' },
    { id: 'player', label: 'Player' },
    { id: 'settings', label: 'Settings' },
]);

export const LOG_PREFIX = '[Neo Terra]';
