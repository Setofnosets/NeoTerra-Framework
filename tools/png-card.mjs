/**
 * Minimal, dependency-free PNG card reader.
 *
 * SillyTavern stores character cards as PNGs with the card JSON in a text
 * chunk (`chara` for V2, sometimes `ccv3` for V3). Both `tEXt` (uncompressed)
 * and `zTXt` / `iTXt` (zlib compressed) are supported. Only Node built-ins are
 * used so the tool stays installable without `npm install`.
 */

import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Text chunk keywords that can carry a character card, in preference order. */
export const CARD_KEYWORDS = Object.freeze(['ccv3', 'chara']);

/**
 * Read every PNG chunk from a buffer.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ type: string, data: Buffer }>}
 */
export function readPngChunks(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('not a PNG file (missing the PNG signature)');
    }

    const chunks = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            throw new Error(`truncated PNG chunk "${type}" at byte ${offset}`);
        }
        chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
        offset = dataEnd + 4; // skip CRC
        if (type === 'IEND') {
            break;
        }
    }
    if (chunks.length === 0 || chunks[chunks.length - 1].type !== 'IEND') {
        throw new Error('PNG is missing its IEND chunk');
    }
    return chunks;
}

function splitKeyword(data) {
    const separator = data.indexOf(0);
    if (separator <= 0) {
        return null;
    }
    return {
        keyword: data.toString('latin1', 0, separator),
        rest: data.subarray(separator + 1),
    };
}

function decodeTextChunk(type, data) {
    const split = splitKeyword(data);
    if (!split) {
        return null;
    }
    if (type === 'tEXt') {
        return { keyword: split.keyword, text: split.rest.toString('latin1') };
    }
    if (type === 'zTXt') {
        if (split.rest.length < 1) {
            return null;
        }
        const compressionMethod = split.rest[0];
        if (compressionMethod !== 0) {
            throw new Error(`unsupported zTXt compression method ${compressionMethod}`);
        }
        return {
            keyword: split.keyword,
            text: inflateSync(split.rest.subarray(1)).toString('latin1'),
        };
    }
    if (type === 'iTXt') {
        // keyword\0 compressionFlag(1) compressionMethod(1) language\0 translated\0 text
        if (split.rest.length < 2) {
            return null;
        }
        const compressionFlag = split.rest[0];
        const compressionMethod = split.rest[1];
        let rest = split.rest.subarray(2);
        const languageEnd = rest.indexOf(0);
        if (languageEnd === -1) {
            return null;
        }
        rest = rest.subarray(languageEnd + 1);
        const translatedEnd = rest.indexOf(0);
        if (translatedEnd === -1) {
            return null;
        }
        rest = rest.subarray(translatedEnd + 1);
        if (compressionFlag === 1) {
            if (compressionMethod !== 0) {
                throw new Error(`unsupported iTXt compression method ${compressionMethod}`);
            }
            rest = inflateSync(rest);
        }
        return { keyword: split.keyword, text: rest.toString('utf8') };
    }
    return null;
}

function parseCardJson(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.length === 0) {
        return null;
    }
    const json = trimmed.startsWith('{') && trimmed.endsWith('}')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf8');
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Extract the embedded character card from a PNG buffer.
 *
 * @param {Buffer} buffer
 * @returns {{ card: object, keyword: string } | null}
 */
export function extractPngCard(buffer) {
    const chunks = readPngChunks(buffer);
    const texts = [];
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') {
            continue;
        }
        const decoded = decodeTextChunk(chunk.type, chunk.data);
        if (decoded) {
            texts.push(decoded);
        }
    }

    for (const keyword of CARD_KEYWORDS) {
        const match = texts.find((entry) => entry.keyword === keyword);
        if (!match) {
            continue;
        }
        const card = parseCardJson(match.text);
        if (card) {
            return { card, keyword };
        }
    }
    return null;
}

/**
 * Extract a card, throwing a precise error when a PNG has no usable card.
 *
 * @param {Buffer} buffer
 * @param {string} [label]
 * @returns {object}
 */
export function requirePngCard(buffer, label = 'PNG') {
    let extracted;
    try {
        extracted = extractPngCard(buffer);
    } catch (error) {
        throw new Error(`${label}: malformed PNG (${error.message})`);
    }
    if (!extracted) {
        throw new Error(`${label}: no embedded character card (expected a "chara" or "ccv3" text chunk)`);
    }
    return extracted.card;
}
