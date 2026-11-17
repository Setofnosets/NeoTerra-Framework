/**
 * Per-chat WorldState persistence.
 *
 * `chatMetadata.neoterra` is the durable store; a small localStorage WAL keeps
 * in-flight state safe if the tab closes before SillyTavern flushes its
 * debounced metadata save. The module has no direct `ctx` or DOM assumptions,
 * so Node tests can inject metadata, storage, timing, and an error reporter.
 */

import { applyWorldEvent } from './reducer.js';
import {
    CURRENT_WORLD_STATE_VERSION,
    migrateWorldState,
} from './migrations.js';
import { cloneWorldState, createWorldState, validateWorldState } from './world-state.js';

export const METADATA_KEY = 'neoterra';
export const WAL_PREFIX = 'neoterra:wal:';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatErrors(validation) {
    return validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
}

/**
 * Read and migrate a WorldState from a chat metadata object.
 *
 * @param {object} metadata
 * @returns {object|null}
 */
export function loadWorldStateFromMetadata(metadata) {
    const raw = metadata?.[METADATA_KEY]?.worldState;
    if (raw === null || raw === undefined) {
        return null;
    }
    return migrateWorldState(raw);
}

/**
 * Write a WorldState into a chat metadata object. The caller owns the actual
 * metadata save; this helper never touches storage.
 *
 * @param {object} metadata
 * @param {object} state
 * @param {number} [savedAt]
 * @returns {object} the same metadata object
 */
export function saveWorldStateToMetadata(metadata, state, savedAt = Date.now()) {
    if (!isObject(metadata)) {
        throw new Error('saveWorldStateToMetadata requires a metadata object');
    }
    const existing = isObject(metadata[METADATA_KEY]) ? metadata[METADATA_KEY] : {};
    metadata[METADATA_KEY] = {
        ...existing,
        schemaVersion: CURRENT_WORLD_STATE_VERSION,
        worldState: cloneWorldState(state),
        savedAt,
    };
    return metadata;
}

/**
 * Create a per-chat store.
 *
 * @param {{
 *   metadata?: object,
 *   saveMetadataDebounced?: () => void,
 *   storage?: { getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void } | null,
 *   debounceMs?: number,
 *   schedule?: (callback: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 *   now?: () => number,
 *   onError?: (error: unknown) => void,
 *   context?: { registry?: object, formGroups?: object, formRules?: object },
 *   chatId?: string,
 * }} [options]
 */
export function createWorldStateStore(options = {}) {
    const metadata = isObject(options.metadata) ? options.metadata : {};
    const saveMetadataDebounced = typeof options.saveMetadataDebounced === 'function'
        ? options.saveMetadataDebounced
        : null;
    const saveMetadata = typeof options.saveMetadata === 'function' ? options.saveMetadata : null;
    const storage = options.storage ?? null;
    const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 400;
    const schedule = typeof options.schedule === 'function' ? options.schedule : setTimeout;
    const cancel = typeof options.cancel === 'function' ? options.cancel : clearTimeout;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const onError = typeof options.onError === 'function' ? options.onError : null;
    const context = isObject(options.context)
        ? {
            factions: options.factions,
            locations: options.locations,
            ...options.context,
        }
        : {
            registry: options.registry,
            formGroups: options.formGroups,
            formRules: options.formRules,
            factions: options.factions,
            locations: options.locations,
        };
    const fixedChatId = typeof options.chatId === 'string' ? options.chatId : null;

    let current = null;
    let timer = null;

    function report(error) {
        if (onError) {
            try {
                onError(error);
            } catch {
                // An error reporter must never break persistence.
            }
            return;
        }
        console.warn('[neoterra] world state persistence error', error);
    }

    function expectedChatId() {
        return current?.chatId
            ?? metadata?.[METADATA_KEY]?.worldState?.chatId
            ?? fixedChatId
            ?? '';
    }

    function walKey() {
        return `${WAL_PREFIX}${expectedChatId()}`;
    }

    function writeWal() {
        if (!storage || !current) {
            return;
        }
        try {
            storage.setItem(
                walKey(),
                JSON.stringify({
                    schemaVersion: CURRENT_WORLD_STATE_VERSION,
                    savedAt: now(),
                    worldState: current,
                }),
            );
        } catch (error) {
            report(error);
        }
    }

    function clearWal() {
        if (!storage) {
            return;
        }
        try {
            storage.removeItem(walKey());
        } catch (error) {
            report(error);
        }
    }

    function readWal() {
        if (!storage) {
            return null;
        }
        try {
            const raw = storage.getItem(walKey());
            if (!raw) {
                return null;
            }
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!isObject(parsed)) {
                return null;
            }
            const state = migrateWorldState(parsed.worldState ?? parsed);
            if (!state) {
                return null;
            }
            const savedAt = Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0;
            return { state, savedAt };
        } catch (error) {
            report(error);
            return null;
        }
    }

    function readMetadataState() {
        try {
            return loadWorldStateFromMetadata(metadata);
        } catch (error) {
            report(error);
            return null;
        }
    }

    function recoverFromWal(expectedChat = null) {
        const wal = readWal();
        if (!wal) {
            return null;
        }
        const expected = expectedChat ?? expectedChatId();
        if (expected && wal.state.chatId !== expected) {
            return null;
        }
        const hasMetadataState = metadata?.[METADATA_KEY]?.worldState !== undefined
            && metadata?.[METADATA_KEY]?.worldState !== null;
        const metadataSavedAt = Number(metadata?.[METADATA_KEY]?.savedAt ?? 0);
        if (hasMetadataState && !(wal.savedAt > metadataSavedAt)) {
            return null;
        }
        current = wal.state;
        return current;
    }

    function adopt(state) {
        const normalized = migrateWorldState(state);
        if (!normalized) {
            throw new Error('WorldState store requires a document');
        }
        const validation = validateWorldState(normalized);
        if (!validation.ok) {
            throw new Error(`Invalid WorldState: ${formatErrors(validation)}`);
        }
        current = normalized;
        writeWal();
        scheduleSave();
        return current;
    }

    function scheduleSave() {
        if (timer !== null) {
            return;
        }
        const handle = schedule(() => {
            timer = null;
            saveNow();
        }, debounceMs);
        timer = handle ?? true;
    }

    function cancelPending() {
        if (timer === null) {
            return;
        }
        const handle = timer;
        timer = null;
        try {
            cancel(handle);
        } catch (error) {
            report(error);
        }
    }

    function saveNow() {
        if (!current) {
            return null;
        }
        try {
            saveWorldStateToMetadata(metadata, current, now());
            if (saveMetadataDebounced) {
                saveMetadataDebounced();
            } else if (saveMetadata) {
                saveMetadata();
            }
            clearWal();
            return current;
        } catch (error) {
            report(error);
            return null;
        }
    }

    const store = {
        /** Current migrated state, recovering from metadata/WAL when needed. */
        get() {
            if (current) {
                return current;
            }
            current = readMetadataState();
            const recovered = recoverFromWal();
            if (recovered) {
                return recovered;
            }
            return current;
        },

        /** Install an already-built state, validating it first. */
        setInitial(state) {
            return adopt(state);
        },

        /** Build and install a state from `createWorldState` options. */
        seed(seedOptions = {}) {
            return adopt(createWorldState({
                registry: context.registry,
                formGroups: context.formGroups,
                formRules: context.formRules,
                factions: context.factions,
                locations: context.locations,
                ...seedOptions,
            }));
        },

        /** Apply one event through the reducer and persist it. */
        dispatch(event) {
            if (!current) {
                throw new Error('WorldState store is empty');
            }
            current = applyWorldEvent(current, event, context);
            writeWal();
            scheduleSave();
            return current;
        },

        /** Migrate, validate, and persist a replacement document. */
        replace(state) {
            return adopt(state);
        },

        /** Persist immediately and drop the WAL. */
        saveNow,

        /** Cancel a pending debounce and persist immediately. */
        flush() {
            cancelPending();
            return saveNow();
        },

        walKey,

        /** Recover a WAL document for the current (or supplied) chat. */
        recoverFromWal,

        /** Write an exact copy of the current state for one swipe. */
        snapshotForSwipe(message, swipeId) {
            if (!current) {
                throw new Error('No WorldState to snapshot');
            }
            if (!isObject(message)) {
                throw new Error('snapshotForSwipe requires a message object');
            }
            message.extra = isObject(message.extra) ? message.extra : {};
            message.extra[METADATA_KEY] = isObject(message.extra[METADATA_KEY])
                ? message.extra[METADATA_KEY]
                : {};
            const root = message.extra[METADATA_KEY];
            root.snapshots = isObject(root.snapshots) ? root.snapshots : {};
            const snapshot = cloneWorldState(current);
            root.snapshots[String(swipeId)] = snapshot;
            return snapshot;
        },

        /** Restore a swipe snapshot exactly, or return null when absent. */
        restoreSnapshot(message, swipeId) {
            const raw = message?.extra?.[METADATA_KEY]?.snapshots?.[String(swipeId)];
            if (!raw) {
                return null;
            }
            let normalized = null;
            try {
                normalized = migrateWorldState(raw);
            } catch (error) {
                report(error);
                return null;
            }
            if (!normalized) {
                return null;
            }
            try {
                return adopt(normalized);
            } catch (error) {
                report(error);
                return null;
            }
        },

        hasSnapshot(message, swipeId) {
            return Boolean(message?.extra?.[METADATA_KEY]?.snapshots?.[String(swipeId)]);
        },

        /** Cancel a pending timer without saving or clearing state/WAL. */
        dispose() {
            cancelPending();
        },
    };

    return store;
}
