/**
 * Neo Terra Continuity Auditor.
 *
 * Read-only: the auditor compares WorldState, the Canon Beat Ledger, and recent
 * prose, then reports findings. It never returns reducer events and never
 * writes state. The deterministic checks are cheap enough to run every pass;
 * the optional agent pass only adds prose-level ambiguities.
 */

import { AgentAbortedError } from './client.js';
import {
    getBeatStatus,
    getCurrentAct,
    isBeatTerminal,
    summarizeBeatLedger,
} from '../data/beats.js';

export const AUDITOR_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'rationale'],
    properties: {
        findings: {
            type: 'array',
            maxItems: 20,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'severity', 'message'],
                properties: {
                    code: {
                        type: 'string',
                        enum: [
                            'unrecorded-beat',
                            'unsupported-beat',
                            'ending-mismatch',
                            'threat-mismatch',
                            'character-mismatch',
                            'continuity',
                        ],
                    },
                    severity: {
                        type: 'string',
                        enum: ['info', 'warning', 'error'],
                    },
                    message: { type: 'string', maxLength: 400 },
                    referenceId: { type: 'string', maxLength: 160 },
                },
            },
        },
        rationale: { type: 'string', maxLength: 600 },
    },
});

const SEVERITY_ORDER = Object.freeze({ info: 0, warning: 1, error: 2 });

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function finding(code, severity, message, referenceId = null) {
    return { code, severity, message, referenceId };
}

function beatMentionedInProse(beat, prose) {
    if (typeof prose !== 'string' || prose.length === 0) {
        return false;
    }
    const haystack = prose.toLowerCase();
    const title = String(beat.title ?? '').toLowerCase();
    if (title.length >= 4 && haystack.includes(title)) {
        return true;
    }
    return false;
}

function eventsForBeat(state, beatId) {
    return asArray(state?.recentEvents).filter(
        (event) => event?.beatId === beatId
            || (Array.isArray(event?.tags) && event.tags.includes(beatId)),
    );
}

/**
 * Deterministic audit of the ledger and the state.
 *
 * @param {{
 *   state: object,
 *   season: object,
 *   recentProse?: string,
 *   recentMessages?: string[],
 * }} options
 */
export function auditWorldState({
    state,
    season,
    recentProse = '',
    recentMessages = [],
} = {}) {
    const findings = [];
    if (!isObject(state) || !isObject(season)) {
        return {
            findings: [finding('continuity', 'error', 'The auditor requires a WorldState and a season.')],
            summary: { errors: 1, warnings: 0, info: 0 },
            act: null,
        };
    }
    const prose = [
        typeof recentProse === 'string' ? recentProse : '',
        ...asArray(recentMessages).filter((message) => typeof message === 'string'),
    ].join('\n');

    for (const beat of asArray(season.canonBeats)) {
        if (!isObject(beat) || typeof beat.id !== 'string') {
            continue;
        }
        const status = getBeatStatus(state, beat.id);
        const events = eventsForBeat(state, beat.id);

        // Narrated but never recorded.
        if (!isBeatTerminal(state, beat.id) && beatMentionedInProse(beat, prose)) {
            findings.push(finding(
                'unrecorded-beat',
                'warning',
                `Beat "${beat.title}" appears in recent prose but is still ${status}.`,
                beat.id,
            ));
        }

        // Recorded without support.
        if (isBeatTerminal(state, beat.id) && events.length === 0) {
            findings.push(finding(
                'unsupported-beat',
                'warning',
                `Beat "${beat.title}" is ${status} but no recent event references it.`,
                beat.id,
            ));
        }
    }

    if (state.ending?.status === 'none'
        && asArray(state.recentEvents).some(
            (event) => Array.isArray(event?.tags) && event.tags.includes('villain-victory'),
        )) {
        findings.push(finding(
            'ending-mismatch',
            'error',
            'A villain-victory event exists while ending.status is still "none".',
            'ending',
        ));
    }

    for (const threat of asArray(state.threats).filter(isObject)) {
        if (!Array.isArray(threat.stages) || threat.stages.length === 0) {
            findings.push(finding(
                'threat-mismatch',
                'error',
                `Threat "${threat.name ?? threat.id}" declares no stages.`,
                threat.id,
            ));
            continue;
        }
        const maxStage = threat.stages.length - 1;
        if (Number(threat.stage) > maxStage) {
            findings.push(finding(
                'threat-mismatch',
                'error',
                `Threat "${threat.name ?? threat.id}" is beyond its final stage.`,
                threat.id,
            ));
        }
    }

    for (const record of Object.values(state.badEnds ?? {}).filter(isObject)) {
        if (record.reversed !== true && typeof record.epilogueText === 'string'
            && record.epilogueText.trim().length === 0) {
            findings.push(finding(
                'character-mismatch',
                'warning',
                'A bad-end record has no stored epilogue.',
                record.continuityKey ?? null,
            ));
        }
    }

    const errors = findings.filter((entry) => entry.severity === 'error').length;
    const warnings = findings.filter((entry) => entry.severity === 'warning').length;
    return {
        findings,
        summary: {
            errors,
            warnings,
            info: findings.length - errors - warnings,
        },
        act: getCurrentAct(state, season),
        ledger: summarizeBeatLedger(state, season),
    };
}

export function buildAuditorPrompt({ state, season, recentProse = '' } = {}) {
    const deterministic = auditWorldState({ state, season, recentProse });
    const lines = [];
    lines.push(`# Neo Terra Continuity Auditor — ${season?.title ?? season?.id ?? 'Season'}`);
    lines.push('');
    lines.push(`Act: ${deterministic.act ?? 'unknown'}`);
    lines.push(`Turn: ${state?.meta?.turn ?? 0}`);
    lines.push(`Ending: ${state?.ending?.status ?? 'none'}`);
    lines.push('');
    lines.push('## Ledger');
    lines.push(JSON.stringify(deterministic.ledger ?? {}));
    lines.push('');
    lines.push('## Recent events');
    for (const event of asArray(state?.recentEvents).slice(-15)) {
        lines.push(`- turn ${event.turn}: ${event.summary} [${asArray(event.tags).join(', ')}]`);
    }
    lines.push('');
    lines.push('## Deterministic findings');
    if (deterministic.findings.length === 0) {
        lines.push('(none)');
    } else {
        for (const entry of deterministic.findings) {
            lines.push(`${entry.severity} — ${entry.code} — ${entry.message}`);
        }
    }
    lines.push('');
    lines.push('## Recent prose');
    lines.push(recentProse.length > 0 ? recentProse.slice(0, 4000) : '(none supplied)');
    lines.push('');
    lines.push('## Rules');
    lines.push('Report only contradictions you can support from the supplied evidence.');
    lines.push('Never propose writing state or prose. Never invent ids.');
    lines.push('Return JSON only. No prose.');
    lines.push('');
    lines.push('## Response shape');
    lines.push(JSON.stringify(AUDITOR_SCHEMA));
    return lines.join('\n');
}

/**
 * Merge agent findings with the deterministic report. Duplicate codes and
 * references collapse; the strictest severity wins.
 */
export function normalizeAuditorResult({ result, deterministic } = {}) {
    const base = isObject(deterministic)
        ? deterministic
        : { findings: [], summary: { errors: 0, warnings: 0, info: 0 }, act: null };
    const output = isObject(result) ? result : {};
    const byKey = new Map();

    for (const entry of asArray(base.findings)) {
        const key = `${entry.code}:${entry.referenceId ?? ''}:${entry.message}`;
        byKey.set(key, entry);
    }
    for (const entry of asArray(output.findings).slice(0, 20)) {
        if (!isObject(entry) || typeof entry.code !== 'string'
            || typeof entry.message !== 'string') {
            continue;
        }
        const severity = ['info', 'warning', 'error'].includes(entry.severity)
            ? entry.severity
            : 'warning';
        const normalized = {
            code: entry.code,
            severity,
            message: entry.message.slice(0, 400),
            referenceId: typeof entry.referenceId === 'string' ? entry.referenceId : null,
        };
        const key = `${normalized.code}:${normalized.referenceId ?? ''}:${normalized.message}`;
        const existing = byKey.get(key);
        if (!existing || SEVERITY_ORDER[severity] > SEVERITY_ORDER[existing.severity]) {
            byKey.set(key, normalized);
        }
    }

    const findings = [...byKey.values()];
    const errors = findings.filter((entry) => entry.severity === 'error').length;
    const warnings = findings.filter((entry) => entry.severity === 'warning').length;
    return {
        ...base,
        findings,
        summary: {
            errors,
            warnings,
            info: findings.length - errors - warnings,
        },
        rationale: typeof output.rationale === 'string' ? output.rationale.slice(0, 600) : '',
    };
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never break the audit.
    }
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

/**
 * Thin runner wrapper. The auditor never returns events; only findings.
 */
export function createAuditor({
    runner = null,
    getSettings = null,
    log = null,
} = {}) {
    function plan(request = {}) {
        const deterministic = auditWorldState(request);
        if (typeof request.propose !== 'function') {
            return { ...deterministic, source: 'deterministic', prompt: null };
        }
        return {
            ...normalizeAuditorResult({
                result: request.propose({
                    prompt: buildAuditorPrompt(request),
                    schema: AUDITOR_SCHEMA,
                }),
                deterministic,
            }),
            source: 'agent',
            prompt: buildAuditorPrompt(request),
        };
    }

    async function run(request = {}) {
        const deterministic = auditWorldState(request);
        const settings = (typeof getSettings === 'function' ? getSettings() : request.settings) ?? {};
        const enabled = settings?.agents?.auditor?.enabled !== false;
        if (!enabled || typeof runner?.runAgent !== 'function') {
            return { ...deterministic, source: 'deterministic', prompt: null };
        }
        const prompt = buildAuditorPrompt(request);
        try {
            const response = await runner.runAgent({
                agentId: 'auditor',
                prompt,
                schema: AUDITOR_SCHEMA,
                signal: request.signal,
            });
            const result = isObject(response) && Object.hasOwn(response, 'value')
                ? response.value
                : response;
            return {
                ...normalizeAuditorResult({ result, deterministic }),
                source: 'agent',
                prompt,
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Auditor agent failed; keeping deterministic findings', error);
            return {
                ...deterministic,
                source: 'deterministic',
                prompt,
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run };
}
