/**
 * Small scoped logger with an in-memory ring buffer.
 *
 * The ring buffer feeds the in-game agent log later; the console output keeps
 * normal operation quiet unless `debug` is enabled.
 */

import { LOG_PREFIX } from './constants.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MAX_RECORDS = 500;

let minimumLevel = LEVELS.info;
const records = [];

export function setLogLevel(level) {
    if (Object.hasOwn(LEVELS, level)) {
        minimumLevel = LEVELS[level];
    }
}

export function getLogLevel() {
    return Object.entries(LEVELS).find(([, value]) => value === minimumLevel)?.[0] ?? 'info';
}

export function getLogRecords() {
    return records.slice();
}

export function clearLogRecords() {
    records.length = 0;
}

function record(level, scope, message, data) {
    const entry = {
        time: new Date().toISOString(),
        level,
        scope,
        message,
        data: data === undefined ? undefined : safeClone(data),
    };
    records.push(entry);
    if (records.length > MAX_RECORDS) {
        records.splice(0, records.length - MAX_RECORDS);
    }
    return entry;
}

function emit(entry) {
    if (LEVELS[entry.level] < minimumLevel) {
        return;
    }
    const line = `${LOG_PREFIX}[${entry.scope}] ${entry.message}`;
    const method = entry.level === 'debug' ? 'debug' : entry.level;
    if (entry.data === undefined) {
        console[method]?.(line);
    } else {
        console[method]?.(line, entry.data);
    }
}

/** Create a logger bound to a feature scope (e.g. `shell`, `settings`). */
export function createLogger(scope = 'app') {
    const write = (level, message, data) => {
        const entry = record(level, scope, String(message), data);
        emit(entry);
        return entry;
    };
    return {
        debug: (message, data) => write('debug', message, data),
        info: (message, data) => write('info', message, data),
        warn: (message, data) => write('warn', message, data),
        error: (message, data) => write('error', message, data),
        scope,
    };
}

export const logger = createLogger('app');

function safeClone(value) {
    try {
        return structuredClone(value);
    } catch {
        return String(value);
    }
}
