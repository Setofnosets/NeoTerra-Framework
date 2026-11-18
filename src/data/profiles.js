/**
 * Load the generated character-card profiles.
 *
 * Mirrors `registry.js`: one fetch per session, validated envelope, injectable
 * `fetch` for Node tests. A missing file is a load error; callers that can run
 * without profiles (the codex, season start) catch it and degrade to `{}`.
 */

const PROFILES_URL = new URL('../../data/characters/profiles.json', import.meta.url);

let cachedProfiles = null;
let inFlight = null;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fetch, validate, and cache the `profiles` map from
 * `data/characters/profiles.json`.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Record<string, object>>}
 */
export async function loadProfiles({ fetchImpl = globalThis.fetch } = {}) {
    if (cachedProfiles) {
        return cachedProfiles;
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadProfiles: no fetch implementation is available');
    }
    if (!inFlight) {
        inFlight = (async () => {
            const response = await fetchImpl(PROFILES_URL.href);
            if (response && response.ok === false) {
                throw new Error(
                    `loadProfiles: failed to load ${PROFILES_URL.href} (HTTP ${response.status ?? 'unknown'})`,
                );
            }
            const artifact = await response.json();
            if (!isObject(artifact)) {
                throw new Error('loadProfiles: character profiles must be an object');
            }
            if (artifact.schemaVersion !== 1) {
                throw new Error('loadProfiles: character profiles schemaVersion must be 1');
            }
            if (!isObject(artifact.profiles)) {
                throw new Error('loadProfiles: character profiles are missing the profiles map');
            }
            cachedProfiles = artifact.profiles;
            return cachedProfiles;
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

/** Clear the module-level cache (tests and data regeneration). */
export function clearProfilesCache() {
    cachedProfiles = null;
    inFlight = null;
}
