/**
 * Bundled Director/narrator card helpers.
 *
 * Installation is download-only: the extension never writes into the user's
 * character library. The user imports the downloaded JSON through SillyTavern's
 * Characters UI. Detection is read-only and never switches characters.
 */

import { DIRECTOR_CARD_NAME, findStCharacter } from '../flows/season-start.js';
import { downloadJson } from './download.js';

export const DIRECTOR_CARD_URL = new URL('../../assets/neoterra-director.json', import.meta.url);
export const DIRECTOR_CARD_FILENAME = 'Neo Terra — Director.json';

/** Fetch the bundled card document. */
export async function loadDirectorCard({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('loadDirectorCard: no fetch implementation is available');
    }
    const response = await fetchImpl(DIRECTOR_CARD_URL.href);
    if (response?.ok === false) {
        throw new Error(`loadDirectorCard: could not load the card (${response.status ?? 'error'})`);
    }
    return response.json();
}

/** Read-only detection of the installed Director card. */
export function directorCardStatus(ctx) {
    const character = findStCharacter(ctx, DIRECTOR_CARD_NAME);
    return {
        name: DIRECTOR_CARD_NAME,
        installed: Boolean(character),
        avatar: character?.avatar ?? character?.id ?? null,
    };
}

/** Download the bundled card for import through SillyTavern's Characters UI. */
export async function downloadDirectorCard({
    fetchImpl = globalThis.fetch,
    filename = DIRECTOR_CARD_FILENAME,
} = {}) {
    const card = await loadDirectorCard({ fetchImpl });
    const downloaded = downloadJson(filename, card);
    if (!downloaded) {
        throw new Error('downloadDirectorCard: the browser download API is unavailable');
    }
    return card;
}
