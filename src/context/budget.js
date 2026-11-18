/**
 * Deterministic token estimation and budget enforcement.
 *
 * SillyTavern does not expose a synchronous tokenizer to extensions, so the
 * budget uses a deliberately conservative character estimate. The same
 * estimate is used for per-block caps and for the total ceiling, which makes
 * the result reproducible in tests and in the browser.
 */

export const CONTEXT_BLOCK_IDS = Object.freeze([
    'scene',
    'cast',
    'player',
    'combat',
    'world',
    'continuity',
    'lore',
    'pacing',
    'news',
]);

/**
 * Lower rank = higher priority. The budget reduces the highest rank first.
 */
export const BLOCK_PRIORITY = Object.freeze({
    scene: 0,
    cast: 1,
    player: 2,
    combat: 3,
    world: 4,
    // Above continuity, below world: headlines are cheaper than the ledger.
    news: 4.5,
    continuity: 5,
    lore: 6,
    // The pacing nudge is the most disposable block: it is advisory and the
    // next turn regenerates it, so it is dropped before narrative context.
    pacing: 7,
});

export const DEFAULT_TOKEN_BUDGET = Object.freeze({
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
    characterProfile: 1200,
});

const CHARS_PER_TOKEN = 4;

/** Estimate tokens from text length. Never negative, never NaN. */
export function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return 0;
    }
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text so `estimateTokens(text) <= maxTokens`.
 * Cuts at a line or word boundary when possible and marks the cut with `…`.
 */
export function truncateToTokens(text, maxTokens, { ellipsis = '…' } = {}) {
    if (typeof text !== 'string') {
        throw new TypeError('truncateToTokens requires a string');
    }
    const limit = Number(maxTokens);
    if (!Number.isFinite(limit) || limit <= 0) {
        return { text: '', tokens: 0, truncated: text.length > 0 };
    }
    if (estimateTokens(text) <= limit) {
        return { text, tokens: estimateTokens(text), truncated: false };
    }

    const maxChars = Math.max(0, Math.floor(limit) * CHARS_PER_TOKEN);
    const marker = text.length > 0 ? ellipsis : '';
    const budgetChars = Math.max(0, maxChars - marker.length);
    let slice = text.slice(0, budgetChars);

    const lastNewline = slice.lastIndexOf('\n');
    const lastSpace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
    const cut = Math.max(lastNewline, lastSpace);
    if (cut > Math.floor(budgetChars * 0.5)) {
        slice = slice.slice(0, cut);
    }
    slice = slice.replace(/[\s,;:.\-]+$/, '');

    const output = `${slice}${marker}`;
    // Guard against rounding surprises in the estimator.
    if (estimateTokens(output) > limit) {
        return truncateToTokens(output, limit, { ellipsis: '' });
    }
    return { text: output, tokens: estimateTokens(output), truncated: true };
}

function normalizeBudget(budget = {}) {
    const out = { ...DEFAULT_TOKEN_BUDGET };
    for (const [key, fallback] of Object.entries(DEFAULT_TOKEN_BUDGET)) {
        const value = Number(budget?.[key]);
        out[key] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
    }
    return out;
}

function blockText(block) {
    const heading = String(block.heading ?? '');
    const body = String(block.body ?? '');
    return body.length > 0 ? `${heading}\n${body}` : heading;
}

function joinTexts(blocks) {
    return blocks.map((block) => block.text).filter(Boolean).join('\n\n');
}

/**
 * Enforce per-block caps, then the total ceiling.
 *
 * @param {Array<{id: string, heading?: string, body?: string, priority?: number}>} blocks
 * @param {object} [budget]
 * @returns {{
 *   blocks: Array<object>,
 *   text: string,
 *   totalTokens: number,
 *   dropped: string[],
 *   truncated: string[],
 * }}
 */
export function applyTokenBudget(blocks, budget = DEFAULT_TOKEN_BUDGET) {
    const limits = normalizeBudget(budget);
    const dropped = new Set();
    const truncated = new Set();

    let active = [];
    for (const block of blocks ?? []) {
        if (!block || typeof block.id !== 'string') {
            continue;
        }
        const heading = String(block.heading ?? '');
        const body = String(block.body ?? '');
        if (body.length === 0 && heading.length === 0) {
            continue;
        }
        const blockLimit = limits[block.id] ?? Infinity;
        if (blockLimit <= 0) {
            dropped.add(block.id);
            continue;
        }
        const raw = blockText({ heading, body });
        const cut = truncateToTokens(raw, blockLimit);
        if (cut.text.length === 0) {
            dropped.add(block.id);
            continue;
        }
        if (cut.truncated) {
            truncated.add(block.id);
        }
        active.push({
            ...block,
            heading,
            body,
            text: cut.text,
            tokens: cut.tokens,
            priority: Number.isFinite(block.priority)
                ? block.priority
                : BLOCK_PRIORITY[block.id] ?? 99,
        });
    }

    let totalTokens = estimateTokens(joinTexts(active));
    while (totalTokens > limits.total && active.length > 0) {
        const victim = [...active].sort(
            (a, b) => a.priority - b.priority,
        )[active.length > 1 ? active.length - 1 : 0];

        const excess = totalTokens - limits.total;
        if (active.length === 1) {
            const cut = truncateToTokens(victim.text, limits.total);
            victim.text = cut.text;
            victim.tokens = cut.tokens;
            truncated.add(victim.id);
            totalTokens = estimateTokens(joinTexts(active));
            if (victim.tokens === 0) {
                dropped.add(victim.id);
                active = [];
                totalTokens = 0;
            }
            break;
        }

        if (victim.tokens <= excess) {
            dropped.add(victim.id);
            active = active.filter((block) => block !== victim);
        } else {
            const target = Math.max(0, victim.tokens - excess);
            const cut = truncateToTokens(victim.text, target);
            if (cut.text.length === 0) {
                dropped.add(victim.id);
                active = active.filter((block) => block !== victim);
            } else {
                victim.text = cut.text;
                victim.tokens = cut.tokens;
                truncated.add(victim.id);
            }
        }
        totalTokens = estimateTokens(joinTexts(active));
    }

    return {
        blocks: active,
        text: joinTexts(active),
        totalTokens,
        dropped: [...dropped],
        truncated: [...truncated],
    };
}
