/**
 * In-world newspaper: deterministic edition builder and pure view model.
 *
 * Everything here is dependency-free and DOM-free. The newspaper agent (Step
 * 7) only supplies prose; this module is the always-available fallback and the
 * single place that ranks, sections, caps, and validates an edition.
 */

import { applyContentGate } from '../core/content-gate.js';

export const NEWSROOM_MAX_EDITIONS = 20;
export const NEWSROOM_MAX_HEADLINES = 6;
export const NEWSROOM_TITLE_MAX = 90;
export const NEWSROOM_LEDE_MAX = 220;

export const NEWSPAPER_STYLES = Object.freeze(['auto', 'tabloid', 'broadsheet', 'underground']);
/** Styles an edition may be stored with (`auto` is resolved before storage). */
export const STORED_NEWSPAPER_STYLES = Object.freeze(['tabloid', 'broadsheet', 'underground']);
export const NEWSPAPER_SECTIONS = Object.freeze([
    'crime',
    'faction',
    'hero',
    'business',
    'society',
    'offscreen',
    'general',
]);
export const NEWSPAPER_TONES = Object.freeze([
    'alarmist',
    'neutral',
    'hopeful',
    'grim',
    'sensational',
]);

const MASTHEADS = Object.freeze({
    tabloid: 'THE NEO TERRA GAZETTE',
    broadsheet: 'THE NEO TERRA CHRONICLE',
    underground: 'THE UNDERGROUND PRESS',
});

const SECTION_ORDER = Object.freeze([
    'crime',
    'faction',
    'hero',
    'business',
    'society',
    'offscreen',
    'general',
]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integerSetting(value, fallback, { min = 0, max = 1000 } = {}) {
    return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Normalized newspaper settings; tolerant of a partial settings object. */
export function newspaperSettings(settings = {}) {
    const raw = isObject(settings?.newspaper) ? settings.newspaper : {};
    return {
        enabled: raw.enabled === true,
        style: NEWSPAPER_STYLES.includes(raw.style) ? raw.style : 'auto',
        everyDays: integerSetting(raw.everyDays, 3, { min: 1, max: 60 }),
        minEvents: integerSetting(raw.minEvents, 6, { min: 1, max: 50 }),
        maxHeadlines: integerSetting(raw.maxHeadlines, NEWSROOM_MAX_HEADLINES, {
            min: 1,
            max: NEWSROOM_MAX_HEADLINES,
        }),
    };
}

/** Resolve the publication style from the season and the world state. */
export function deriveNewspaperStyle({ state = null, season = null, settings = {} } = {}) {
    const configured = newspaperSettings(settings).style;
    if (configured !== 'auto') {
        return configured;
    }
    // A post-victory resistance arc reads as an underground sheet; a villain
    // POV reads as a tabloid; everything else is a broadsheet.
    if (state?.arc === 'post-victory' && state?.ending?.path === 'resistance') {
        return 'underground';
    }
    if (season?.playerRole === 'villain' || state?.playerRole === 'villain') {
        return 'tabloid';
    }
    return 'broadsheet';
}

function firstSentence(text, maxLength) {
    const value = String(text ?? '').trim();
    if (value.length === 0) {
        return '';
    }
    const match = value.match(/^.*?[.!?](?:\s|$)/);
    const sentence = (match ? match[0] : value).trim();
    return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1)}…` : sentence;
}

function trimText(text, maxLength) {
    const value = String(text ?? '').trim();
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function tagsOf(event) {
    return Array.isArray(event?.tags) ? event.tags.filter((tag) => typeof tag === 'string') : [];
}

/** Section for an event, based on the tags the rest of the world already uses. */
export function sectionForEvent(event) {
    const tags = tagsOf(event);
    if (tags.includes('offscreen')) return 'offscreen';
    if (tags.includes('crime')) return 'crime';
    if (tags.includes('hero')) return 'hero';
    if (tags.includes('business')) return 'business';
    if (tags.includes('society')) return 'society';
    if (tags.includes('faction') || tags.some((tag) => tag.startsWith('faction:'))) {
        return 'faction';
    }
    return 'general';
}

function importanceOf(event) {
    const tags = tagsOf(event);
    let score = 0;
    for (const tag of tags) {
        if (tag === 'crime') score += 30;
        else if (tag === 'hero') score += 20;
        else if (tag === 'faction' || tag.startsWith('faction:')) score += 20;
        else if (tag === 'business') score += 10;
        else if (tag === 'society') score += 5;
        else if (tag === 'offscreen') score += 2;
    }
    return score;
}

/**
 * Events newer than the last edition, ranked headline-first, then by
 * importance tags, then by recency.
 */
export function selectNewsworthyEvents(state, { sinceTurn = -1, limit = 20 } = {}) {
    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    const candidates = [];
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!isObject(event) || typeof event.summary !== 'string' || event.summary.trim().length === 0) {
            continue;
        }
        const tags = tagsOf(event);
        if (tags.includes('season-start')) {
            continue;
        }
        const turn = Number.isInteger(event.turn) ? event.turn : 0;
        if (Number.isInteger(sinceTurn) && turn <= sinceTurn) {
            continue;
        }
        const headline = typeof event.headline === 'string' && event.headline.trim().length > 0;
        candidates.push({
            event,
            index,
            turn,
            score: (headline ? 100 : 0) + importanceOf(event) + index,
        });
    }
    candidates.sort((a, b) => (b.score - a.score) || (b.turn - a.turn) || (b.index - a.index));
    return candidates.slice(0, Math.max(1, limit)).map((entry) => entry.event);
}

function gateText(text, contentGate, contentLimits) {
    return applyContentGate(
        String(text ?? ''),
        contentGate ?? 'full',
        isObject(contentLimits) ? contentLimits : {},
        { isPlayer: true },
    );
}

/**
 * Deterministic edition for the events since the last publication.
 * Returns `null` when there is nothing that can pass the content gate.
 */
export function buildDeterministicEdition({
    state = null,
    season = null,
    settings = {},
    source = 'deterministic',
} = {}) {
    const config = newspaperSettings(settings);
    const newsroom = isObject(state?.flags?.newsroom) ? state.flags.newsroom : {};
    const sinceTurn = Number.isInteger(newsroom.lastEditionTurn)
        ? newsroom.lastEditionTurn
        : -1;
    const events = selectNewsworthyEvents(state, {
        sinceTurn,
        limit: 20,
    });
    if (events.length === 0) {
        return null;
    }

    const contentGate = settings?.contentGate ?? 'full';
    const contentLimits = settings?.contentLimits ?? {};
    const style = deriveNewspaperStyle({ state, season, settings });
    const headlines = [];
    const sectionBuckets = new Map();

    for (const event of events) {
        const title = trimText(
            gateText(
                typeof event.headline === 'string' && event.headline.trim().length > 0
                    ? event.headline
                    : firstSentence(event.summary, NEWSROOM_TITLE_MAX),
                contentGate,
                contentLimits,
            ),
            NEWSROOM_TITLE_MAX,
        );
        const lede = trimText(gateText(event.summary, contentGate, contentLimits), NEWSROOM_LEDE_MAX);
        if (title.length === 0) {
            continue;
        }
        const section = sectionForEvent(event);
        const entry = {
            title,
            lede,
            section,
            tone: 'neutral',
            eventTurn: Number.isInteger(event.turn) ? event.turn : null,
            actors: Array.isArray(event.actors) ? event.actors.slice(0, 8) : [],
            locationId: typeof event.locationId === 'string' ? event.locationId : null,
        };
        if (!sectionBuckets.has(section)) {
            sectionBuckets.set(section, []);
        }
        sectionBuckets.get(section).push(entry);
    }

    for (const section of SECTION_ORDER) {
        const bucket = sectionBuckets.get(section);
        if (!bucket) {
            continue;
        }
        for (const entry of bucket) {
            if (headlines.length >= config.maxHeadlines) {
                break;
            }
            headlines.push(entry);
        }
    }
    if (headlines.length === 0) {
        return null;
    }

    const date = typeof state?.meta?.inGameDate === 'string' ? state.meta.inGameDate : null;
    const turn = Number.isInteger(state?.meta?.turn) ? state.meta.turn : 0;
    const slot = typeof state?.meta?.timeOfDay === 'string' && state.meta.timeOfDay.length > 0
        ? state.meta.timeOfDay.toUpperCase()
        : 'EVENING';
    const seasonId = season?.id ?? state?.seasonId ?? 'neoterra';

    return {
        id: `edition:${seasonId}:${date ?? `turn-${turn}`}:${turn}`,
        date,
        turn,
        masthead: MASTHEADS[style],
        dateline: `NEO TERRA — ${slot} EDITION`,
        style,
        source,
        headlines,
    };
}

/** Stable dedupe key for an edition (date when known, otherwise its id). */
export function editionKey(edition) {
    if (!isObject(edition)) {
        return null;
    }
    if (typeof edition.date === 'string' && edition.date.length > 0) {
        return `date:${edition.date}`;
    }
    if (typeof edition.id === 'string' && edition.id.length > 0) {
        return `id:${edition.id}`;
    }
    return null;
}

/**
 * Validate and sanitize an edition document. Returns
 * `{ ok, edition, errors }`; the reducer rejects an invalid edition.
 */
export function validateEdition(raw, { contentGate = 'full', contentLimits = {} } = {}) {
    const errors = [];
    if (!isObject(raw)) {
        return { ok: false, edition: null, errors: ['edition must be an object'] };
    }
    const masthead = typeof raw.masthead === 'string' ? raw.masthead.trim() : '';
    if (masthead.length === 0 || masthead.length > 80) {
        errors.push('masthead must be a non-empty string of at most 80 characters');
    }
    const dateline = typeof raw.dateline === 'string' ? raw.dateline.trim() : '';
    if (dateline.length === 0 || dateline.length > 120) {
        errors.push('dateline must be a non-empty string of at most 120 characters');
    }
    if (raw.date !== null && raw.date !== undefined && typeof raw.date !== 'string') {
        errors.push('date must be a string or null');
    }
    if (!Number.isInteger(raw.turn) || raw.turn < 0) {
        errors.push('turn must be a non-negative integer');
    }
    if (!STORED_NEWSPAPER_STYLES.includes(raw.style)) {
        errors.push(`style must be one of ${STORED_NEWSPAPER_STYLES.join(', ')}`);
    }
    if (raw.source !== 'deterministic' && raw.source !== 'agent') {
        errors.push('source must be "deterministic" or "agent"');
    }
    const sourceHeadlines = Array.isArray(raw.headlines) ? raw.headlines : null;
    if (!sourceHeadlines || sourceHeadlines.length < 1 || sourceHeadlines.length > NEWSROOM_MAX_HEADLINES) {
        errors.push(`headlines must contain 1-${NEWSROOM_MAX_HEADLINES} entries`);
    }

    const headlines = [];
    for (const [index, entry] of (sourceHeadlines ?? []).entries()) {
        if (!isObject(entry)) {
            errors.push(`headlines[${index}] must be an object`);
            continue;
        }
        const title = trimText(
            gateText(
                typeof entry.title === 'string' ? entry.title.trim() : '',
                contentGate,
                contentLimits,
            ),
            NEWSROOM_TITLE_MAX,
        );
        if (title.length === 0) {
            // Fully gated content is dropped, not stored as an empty headline.
            continue;
        }
        if (title.length > NEWSROOM_TITLE_MAX) {
            errors.push(`headlines[${index}].title must be 1-${NEWSROOM_TITLE_MAX} characters`);
            continue;
        }
        const lede = trimText(
            gateText(
                typeof entry.lede === 'string' ? entry.lede.trim() : '',
                contentGate,
                contentLimits,
            ),
            NEWSROOM_LEDE_MAX,
        );
        if (lede.length > NEWSROOM_LEDE_MAX) {
            errors.push(`headlines[${index}].lede must be at most ${NEWSROOM_LEDE_MAX} characters`);
            continue;
        }
        const section = NEWSPAPER_SECTIONS.includes(entry.section) ? entry.section : 'general';
        const tone = NEWSPAPER_TONES.includes(entry.tone) ? entry.tone : 'neutral';
        headlines.push({
            title,
            lede,
            section,
            tone,
            eventTurn: Number.isInteger(entry.eventTurn) ? entry.eventTurn : null,
            actors: Array.isArray(entry.actors)
                ? entry.actors
                    .filter((actor) => typeof actor === 'string')
                    .slice(0, 12)
                    .map((actor) => actor.slice(0, 120))
                : [],
            locationId: typeof entry.locationId === 'string'
                ? entry.locationId.slice(0, 160)
                : null,
        });
    }

    if (errors.length > 0) {
        return { ok: false, edition: null, errors };
    }
    if (headlines.length === 0) {
        return { ok: false, edition: null, errors: ['headlines filtered to nothing by the content gate'] };
    }
    return {
        ok: true,
        errors: [],
        edition: {
            id: typeof raw.id === 'string' && raw.id.length > 0
                ? raw.id.slice(0, 160)
                : `edition:${raw.date ?? `turn-${raw.turn}`}:${raw.turn}`.slice(0, 160),
            date: typeof raw.date === 'string' ? raw.date : null,
            turn: raw.turn,
            masthead,
            dateline,
            style: raw.style,
            source: raw.source,
            headlines,
        },
    };
}

/** Array of editions, newest first. */
export function selectEditions(state, { limit = NEWSROOM_MAX_EDITIONS } = {}) {
    const raw = state?.flags?.newsroom;
    const editions = Array.isArray(raw?.editions) ? raw.editions.filter(isObject) : [];
    const cap = Math.max(1, Math.min(NEWSROOM_MAX_EDITIONS, Number.isInteger(limit) ? limit : NEWSROOM_MAX_EDITIONS));
    return editions
        .slice()
        .sort((a, b) => {
            const turnA = Number.isInteger(a.turn) ? a.turn : 0;
            const turnB = Number.isInteger(b.turn) ? b.turn : 0;
            if (turnA !== turnB) {
                return turnB - turnA;
            }
            return String(b.date ?? '').localeCompare(String(a.date ?? ''));
        })
        .slice(0, cap);
}

/** Pure newspaper view model for the overlay, reader modal, and prompt block. */
export function buildNewspaperView(state, settings = {}) {
    const editions = selectEditions(state, { limit: NEWSROOM_MAX_EDITIONS });
    const latest = editions[0] ?? null;
    return {
        enabled: newspaperSettings(settings).enabled,
        hasNews: editions.length > 0,
        latest,
        editions,
        headlines: latest ? latest.headlines.slice(0, 2) : [],
        lastEditionDate: typeof state?.flags?.newsroom?.lastEditionDate === 'string'
            ? state.flags.newsroom.lastEditionDate
            : null,
        lastEditionTurn: Number.isInteger(state?.flags?.newsroom?.lastEditionTurn)
            ? state.flags.newsroom.lastEditionTurn
            : null,
    };
}
