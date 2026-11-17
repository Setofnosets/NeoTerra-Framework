/**
 * Settings access for the Neo Terra Framework.
 *
 * Settings live in `extensionSettings.neoterra`, are migrated on read, merged
 * with defaults, and persisted through SillyTavern's debounced save. Unknown
 * keys are preserved. A fresh install writes defaults exactly once.
 */

import { SCHEMA_VERSION, SETTINGS_KEY } from './constants.js';
import { cloneDefaults } from './defaults.js';
import { isPlainObject, migrateSettings } from './migrations.js';

function getStore(ctx) {
    const store = ctx?.extensionSettings;
    return isPlainObject(store) ? store : null;
}

function persist(ctx) {
    try {
        ctx?.saveSettingsDebounced?.();
    } catch (error) {
        // Persistence is best-effort; the in-memory object is still usable.
        console.warn('[Neo Terra] Could not persist settings', error);
    }
}

/**
 * Read settings, applying migrations and defaults.
 *
 * - Fresh install: writes defaults once and saves them.
 * - Existing settings: never overwrites user values; only saves when a
 *   migration or normalization actually changed the document.
 */
export function getSettings(ctx) {
    const store = getStore(ctx);
    if (!store) {
        return cloneDefaults();
    }

    const raw = store[SETTINGS_KEY];
    if (!isPlainObject(raw)) {
        const fresh = cloneDefaults();
        store[SETTINGS_KEY] = fresh;
        persist(ctx);
        return fresh;
    }

    const before = safeStringify(raw);
    const migrated = migrateSettings(raw);
    const after = safeStringify(migrated);

    if (before !== after) {
        store[SETTINGS_KEY] = migrated;
        persist(ctx);
    }
    return store[SETTINGS_KEY];
}

/**
 * Persist a complete settings object. Returns the stored object.
 * The input is cloned so later caller mutations do not leak past a save.
 */
export function saveSettings(ctx, settings) {
    const store = getStore(ctx);
    const next = migrateSettings(settings ?? store?.[SETTINGS_KEY] ?? cloneDefaults());
    if (store) {
        store[SETTINGS_KEY] = next;
        persist(ctx);
    }
    return next;
}

/** Write one setting by dotted path (e.g. `cyoa.count`) and persist. */
export function setSetting(ctx, path, value) {
    const settings = getSettings(ctx);
    setByPath(settings, path, value);
    return saveSettings(ctx, settings);
}

/** Replace settings with factory defaults and persist. */
export function resetSettings(ctx) {
    return saveSettings(ctx, cloneDefaults());
}

/** True when the settings document has never been written for this install. */
export function isFreshInstall(ctx) {
    const store = getStore(ctx);
    return !store || !isPlainObject(store[SETTINGS_KEY]);
}

export function getByPath(object, path) {
    if (!path) {
        return object;
    }
    return String(path)
        .split('.')
        .reduce((value, key) => (value == null ? undefined : value[key]), object);
}

export function setByPath(object, path, value) {
    const parts = String(path).split('.');
    const last = parts.pop();
    let target = object;
    for (const part of parts) {
        if (!isPlainObject(target[part])) {
            target[part] = {};
        }
        target = target[part];
    }
    target[last] = value;
    return object;
}

export { SCHEMA_VERSION, SETTINGS_KEY };

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}
