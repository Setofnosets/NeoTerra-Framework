/**
 * Neo Terra bad-end detector.
 *
 * Detection is opt-in and two-tiered: deterministic predicates run first and
 * never touch state; only a genuinely ambiguous case may ask the model for a
 * confirmation. The detector never writes WorldState and never throws for a
 * malformed model response.
 */

import { AgentAbortedError } from './client.js';
import { renderPromptTemplate } from './prompts.js';
import { applyContentGate } from '../core/content-gate.js';
import {
    DEFAULT_BAD_END_EPILOGUE_PROMPT,
    DEFAULT_BAD_END_PROMPT,
} from '../core/defaults.js';
import { BAD_END_TYPES } from '../state/world-state.js';

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_CORRUPTION_STAGE = 3;
const DEFAULT_LOW_WILLPOWER = 10;
const MAX_CAUSE = 600;

const PERMANENT_FORM_TRIGGERS = Object.freeze([
    'corrupted',
    'infected',
    'poisoned',
    'coldhearted',
    'knighted',
]);

const LETHAL_KEYWORDS = /\b(kill(?:ed|ing|s)?|slain|slays?|dead|dies|dying|lethal|executed?|fatal)\b/i;

export const BAD_END_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
        'confirmed',
        'characterId',
        'type',
        'severity',
        'confidence',
        'cause',
        'playableAs',
        'reversibility',
        'rationale',
    ],
    properties: {
        confirmed: { type: 'boolean' },
        characterId: { type: 'string' },
        type: { type: 'string', enum: [...BAD_END_TYPES] },
        severity: {
            anyOf: [
                { type: 'string', maxLength: 40 },
                { type: 'number' },
            ],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        cause: { type: 'string', maxLength: 600 },
        sourceCharacterId: { type: ['string', 'null'] },
        sourceFactionId: { type: ['string', 'null'] },
        playableAs: { type: 'boolean' },
        reversibility: { type: 'string', maxLength: 80 },
        rationale: { type: 'string', maxLength: 600 },
    },
});

export const BAD_END_EPILOGUE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['epilogueText'],
    properties: {
        epilogueText: { type: 'string', minLength: 60, maxLength: 2400 },
        notes: { type: 'string', maxLength: 600 },
    },
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function ruleList(rules) {
    if (Array.isArray(rules)) {
        return rules;
    }
    return Array.isArray(rules?.rules) ? rules.rules : [];
}

function characterFlags(state, character) {
    const global = isObject(state?.flags) ? state.flags : {};
    const local = isObject(character?.flags) ? character.flags : {};
    return { ...global, ...local };
}

function isCombatParticipant(state, characterId) {
    const combat = state?.scene?.combat;
    if (!isObject(combat)) {
        return false;
    }
    return asArray(combat.participants).includes(characterId);
}

function hasLethalIntent(text) {
    return typeof text === 'string' && LETHAL_KEYWORDS.test(text);
}

function permanentFormRule(formRules, formId) {
    if (typeof formId !== 'string' || formId.length === 0) {
        return null;
    }
    return ruleList(formRules).find(
        (rule) => rule?.to === formId
            && rule?.reversibleBy == null
            && PERMANENT_FORM_TRIGGERS.includes(rule?.trigger),
    ) ?? null;
}

function continuityKeyFor(state, characterId, options = {}) {
    if (typeof options?.continuityKey === 'string' && options.continuityKey.length > 0) {
        return options.continuityKey;
    }
    // Keep this identical to the reducer's fallback so a retry is idempotent.
    return `${state?.seasonId}:${characterId}`;
}

function clampMinConfidence(value) {
    const number = finiteNumber(value);
    return number === null ? DEFAULT_MIN_CONFIDENCE : clamp(number, 0, 1);
}

function causeFor(type, evidence) {
    const lead = {
        death: 'Death recorded',
        'identity-loss': 'Identity loss recorded',
        'autonomy-loss': 'Autonomy loss recorded',
        corruption: 'Corruption bad end recorded',
        imprisonment: 'Imprisonment bad end recorded',
        retirement: 'Retirement bad end recorded',
    }[type] ?? 'Bad end recorded';
    return `${lead}: ${evidence.join('; ')}.`.slice(0, MAX_CAUSE);
}

function makeRecord({
    state,
    character,
    type,
    severity,
    reversibility,
    playableAs,
    evidence,
    options,
    continuityKey,
}) {
    const locationId = character.locationId ?? state?.scene?.locationId ?? null;
    return {
        characterId: character.charId,
        badEndType: type,
        severity,
        cause: causeFor(type, evidence),
        sourceCharacterId: typeof options?.sourceCharacterId === 'string'
            ? options.sourceCharacterId
            : null,
        sourceFactionId: typeof options?.sourceFactionId === 'string'
            ? options.sourceFactionId
            : null,
        turn: Number.isInteger(state?.meta?.turn) ? state.meta.turn : 0,
        date: state?.meta?.inGameDate ?? null,
        locationId,
        playableAs,
        continuityKey,
        reversibility,
        evidence: evidence.slice(),
    };
}

/**
 * Evaluate a single character. Pure: reads state, returns candidate/ambiguous.
 */
export function evaluateBadEndRecord({
    state,
    characterId,
    message = '',
    recentProse = '',
    formRules = null,
    options = {},
} = {}) {
    const character = state?.characters?.[characterId];
    if (!isObject(character)) {
        return {
            candidate: null,
            ambiguous: null,
            skipped: { characterId, reason: 'unknown-character' },
        };
    }
    if (character.bundle === true) {
        return {
            candidate: null,
            ambiguous: null,
            skipped: { characterId, reason: 'bundle' },
        };
    }

    const continuityKey = continuityKeyFor(state, characterId, options);
    const existing = state?.badEnds?.[characterId];
    if (existing && existing.continuityKey === continuityKey) {
        return {
            candidate: null,
            ambiguous: null,
            skipped: { characterId, reason: 'already-recorded', continuityKey },
        };
    }

    const flags = characterFlags(state, character);
    const status = character.status;
    const stamina = finiteNumber(character.stamina?.current);
    const willpower = finiteNumber(character.willpower?.current);
    const corruptionStage = finiteNumber(character.corruption?.stage) ?? 0;
    const maxCorruptionStage = Number.isInteger(options?.maxCorruptionStage)
        && options.maxCorruptionStage >= 0
        ? options.maxCorruptionStage
        : DEFAULT_MAX_CORRUPTION_STAGE;
    const lowWillpower = Number.isFinite(options?.lowWillpower)
        ? options.lowWillpower
        : DEFAULT_LOW_WILLPOWER;
    const allowDeadContinuation = options?.allowDeadContinuation === true;
    const escapePath = flags.escapePath;
    const captive = status === 'captured'
        || status === 'imprisoned'
        || flags.enslaved === true;
    const overwrite = status === 'lost'
        || flags.brainwashed === true
        || flags.identityLoss === true
        || flags.possessed === true;
    const combinedText = [message, recentProse].filter((value) => typeof value === 'string').join('\n');
    let partialAmbiguity = null;

    // death: status, or zero stamina plus an explicit lethal signal.
    if (status === 'dead') {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'death',
                severity: 'major',
                reversibility: 'none',
                playableAs: allowDeadContinuation,
                evidence: ['status=dead'],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }

    const lethalSignals = [];
    if (flags.lethalIntent === true) {
        lethalSignals.push('lethalIntent flag');
    }
    if (isCombatParticipant(state, characterId)) {
        lethalSignals.push('active combat participant');
    }
    if (hasLethalIntent(combinedText)) {
        lethalSignals.push('lethal-intent message');
    }
    if (stamina !== null && stamina <= 0) {
        if (lethalSignals.length > 0) {
            return {
                candidate: makeRecord({
                    state,
                    character,
                    type: 'death',
                    severity: 'major',
                    reversibility: 'none',
                    playableAs: allowDeadContinuation,
                    evidence: ['stamina.current=0', ...lethalSignals],
                    options,
                    continuityKey,
                }),
                ambiguous: null,
                skipped: null,
            };
        }
        const ambiguousDeath = {
            characterId,
            badEndType: 'death',
            type: 'death',
            reason: 'stamina is at zero without an explicit lethal signal',
            evidence: ['stamina.current=0'],
            continuityKey,
        };
        // Keep the ambiguity and continue looking for a deterministic state.
        // If nothing else matches, the caller can ask the model to confirm.
        partialAmbiguity = ambiguousDeath;
    }

    // identity-loss: maximum corruption plus an explicit overwrite signal.
    if (corruptionStage >= maxCorruptionStage && overwrite) {
        const evidence = [`corruption.stage=${corruptionStage}`];
        if (status === 'lost') {
            evidence.push('status=lost');
        }
        if (flags.brainwashed === true) {
            evidence.push('brainwashed flag');
        }
        if (flags.identityLoss === true) {
            evidence.push('identityLoss flag');
        }
        if (flags.possessed === true) {
            evidence.push('possessed flag');
        }
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'identity-loss',
                severity: 'major',
                reversibility: 'none',
                playableAs: true,
                evidence,
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }

    // autonomy-loss: captivity with no willpower (or brainwashing in captivity)
    // and no declared escape path.
    if (captive && escapePath !== true) {
        if (willpower !== null && willpower <= 0) {
            return {
                candidate: makeRecord({
                    state,
                    character,
                    type: 'autonomy-loss',
                    severity: escapePath === false ? 'major' : 'moderate',
                    reversibility: escapePath === false ? 'none' : 'conditional',
                    playableAs: true,
                    evidence: [`status=${status}`, 'willpower.current=0'],
                    options,
                    continuityKey,
                }),
                ambiguous: null,
                skipped: null,
            };
        }
        if (flags.brainwashed === true) {
            return {
                candidate: makeRecord({
                    state,
                    character,
                    type: 'autonomy-loss',
                    severity: escapePath === false ? 'major' : 'moderate',
                    reversibility: escapePath === false ? 'none' : 'conditional',
                    playableAs: true,
                    evidence: [`status=${status}`, 'brainwashed flag'],
                    options,
                    continuityKey,
                }),
                ambiguous: null,
                skipped: null,
            };
        }
    }

    // imprisonment: explicit imprisonment, or capture with no escape path.
    if (status === 'imprisoned' || (status === 'captured' && escapePath === false)) {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'imprisonment',
                severity: escapePath === false ? 'major' : 'moderate',
                reversibility: 'escape',
                playableAs: true,
                evidence: [
                    `status=${status}`,
                    ...(escapePath === false ? ['escapePath=false'] : []),
                ],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }

    // corruption: maximum stage, a permanent transformed form, or an explicit
    // recorded corruption bad end.
    const permanentRule = permanentFormRule(formRules, character.formId);
    if (corruptionStage >= maxCorruptionStage) {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'corruption',
                severity: 'major',
                reversibility: 'none',
                playableAs: true,
                evidence: [`corruption.stage=${corruptionStage}`],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }
    if (permanentRule) {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'corruption',
                severity: 'major',
                reversibility: 'none',
                playableAs: true,
                evidence: [
                    `formId=${character.formId}`,
                    `permanent ${permanentRule.trigger} transformation`,
                ],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }
    if (character.badEndType === 'corruption') {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'corruption',
                severity: 'major',
                reversibility: 'none',
                playableAs: true,
                evidence: ['badEndType=corruption'],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }

    // retirement: a declared, non-violent terminal state.
    if (status === 'retired') {
        return {
            candidate: makeRecord({
                state,
                character,
                type: 'retirement',
                severity: 'moderate',
                reversibility: 'declared',
                playableAs: true,
                evidence: ['status=retired'],
                options,
                continuityKey,
            }),
            ambiguous: null,
            skipped: null,
        };
    }

    // Partial evidence that cannot safely choose a type.
    if (partialAmbiguity) {
        return { candidate: null, ambiguous: partialAmbiguity, skipped: null };
    }
    if (captive && willpower !== null && willpower > 0 && willpower <= lowWillpower
        && escapePath !== true) {
        return {
            candidate: null,
            ambiguous: {
                characterId,
                badEndType: 'autonomy-loss',
                type: 'autonomy-loss',
                reason: 'captivity with low but non-zero willpower',
                evidence: [`status=${status}`, `willpower.current=${willpower}`],
                continuityKey,
            },
            skipped: null,
        };
    }
    if (status === 'lost' && corruptionStage < maxCorruptionStage) {
        return {
            candidate: null,
            ambiguous: {
                characterId,
                badEndType: 'identity-loss',
                type: 'identity-loss',
                reason: 'lost status without maximum corruption',
                evidence: ['status=lost', `corruption.stage=${corruptionStage}`],
                continuityKey,
            },
            skipped: null,
        };
    }

    return { candidate: null, ambiguous: null, skipped: null };
}

/**
 * Evaluate every cast character. Pure and deterministic.
 *
 * @returns {{ candidates: object[], ambiguous: object[], skipped: object[] }}
 */
export function evaluateBadEndCandidates({
    state,
    message = '',
    recentProse = '',
    formRules = null,
    options = {},
} = {}) {
    const candidates = [];
    const ambiguous = [];
    const skipped = [];

    if (!isObject(state?.characters)) {
        return { candidates, ambiguous, skipped };
    }

    for (const characterId of Object.keys(state.characters).sort()) {
        const result = evaluateBadEndRecord({
            state,
            characterId,
            message,
            recentProse,
            formRules,
            options,
        });
        if (result.skipped) {
            skipped.push(result.skipped);
        }
        if (result.candidate) {
            candidates.push(result.candidate);
        }
        if (result.ambiguous) {
            ambiguous.push(result.ambiguous);
        }
    }

    return { candidates, ambiguous, skipped };
}

function safeJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '"[unserializable]"';
    }
}

function characterSnapshot(state, characterId) {
    const character = state?.characters?.[characterId];
    if (!isObject(character)) {
        return null;
    }
    return {
        characterId: character.charId,
        displayName: character.displayName,
        status: character.status,
        formId: character.formId,
        locationId: character.locationId,
        stamina: character.stamina,
        willpower: character.willpower,
        corruption: character.corruption,
        goals: character.goals,
        agenda: character.agenda,
        badEndType: character.badEndType,
    };
}

function promptContextSections({ state, message, recentProse, candidates }) {
    const ids = [...new Set(asArray(candidates).map((candidate) => candidate.characterId))];
    const snapshots = ids.length > 0
        ? ids.map((characterId) => characterSnapshot(state, characterId)).filter(Boolean)
        : [characterSnapshot(state, state?.player?.characterId)].filter(Boolean);
    const events = asArray(state?.recentEvents).slice(-8);
    return [
        '## Ambiguous candidates',
        safeJson(asArray(candidates)),
        '',
        '## Character state',
        safeJson(snapshots),
        '',
        '## Recent events',
        safeJson(events),
        '',
        '## Latest message',
        String(message ?? '').slice(0, 6000) || '(none)',
        '',
        '## Recent prose',
        String(recentProse ?? '').slice(0, 6000) || '(none)',
        '',
        '## Limits',
        [
            'A bad end requires deterministic evidence supplied above.',
            'Prose alone is never enough.',
            'Never invent ids, evidence, or events.',
            'Return JSON only.',
        ].join('\n'),
    ].join('\n');
}

function settingsOf(settings) {
    return isObject(settings) ? settings : {};
}

function badEndsOf(settings) {
    return isObject(settings?.badEnds) ? settings.badEnds : {};
}

function gatePrompt(text, settings) {
    return applyContentGate(
        text,
        settings?.contentGate ?? 'full',
        isObject(settings?.contentLimits) ? settings.contentLimits : {},
        {},
    );
}

/** Build the confirmation prompt from the user-editable template. */
export function buildBadEndPrompt({
    state,
    message = '',
    recentProse = '',
    candidates = [],
    settings = {},
} = {}) {
    const safeSettings = settingsOf(settings);
    const badEnds = badEndsOf(safeSettings);
    const template = typeof badEnds.prompt === 'string'
        ? badEnds.prompt
        : DEFAULT_BAD_END_PROMPT;
    const sections = promptContextSections({ state, message, recentProse, candidates });
    const rendered = renderPromptTemplate(template, {
        character: safeJson(
            asArray(candidates).map((candidate) => characterSnapshot(state, candidate.characterId)),
        ),
        state: safeJson({
            seasonId: state?.seasonId,
            turn: state?.meta?.turn,
            date: state?.meta?.inGameDate,
            playerRole: state?.playerRole,
            player: state?.player,
        }),
        recentEvents: safeJson(asArray(state?.recentEvents).slice(-8)),
        limits: 'Deterministic evidence only. Prose alone never records a bad end.',
        candidates: safeJson(asArray(candidates)),
    });
    return gatePrompt(`${rendered}\n\n${sections}`, safeSettings);
}

/** Build the epilogue prompt from the user-editable template. */
export function buildBadEndEpiloguePrompt({ state, record, settings = {} } = {}) {
    const safeSettings = settingsOf(settings);
    const badEnds = badEndsOf(safeSettings);
    const template = typeof badEnds.epiloguePrompt === 'string'
        ? badEnds.epiloguePrompt
        : DEFAULT_BAD_END_EPILOGUE_PROMPT;
    const characterId = record?.characterId ?? null;
    const character = characterSnapshot(state, characterId);
    const rendered = renderPromptTemplate(template, {
        character: safeJson(character),
        state: safeJson({
            seasonId: state?.seasonId,
            turn: state?.meta?.turn,
            date: state?.meta?.inGameDate,
        }),
        recentEvents: safeJson(asArray(state?.recentEvents).slice(-8)),
        limits: [
            'Write 1-3 paragraphs.',
            'Stay consistent with the recorded cause, location, and continuity key.',
            'Do not resurrect the character or resolve the wider season.',
        ].join(' '),
        candidates: safeJson(record ?? null),
    });
    const sections = [
        '',
        '## Recorded bad end',
        safeJson(record ?? null),
        '',
        '## Character',
        safeJson(character),
        '',
        '## Rules',
        'Write 1-3 paragraphs. Do not resurrect the character. Do not resolve the wider season.',
        'Return JSON with an epilogueText string only.',
    ].join('\n');
    return gatePrompt(`${rendered}\n${sections}`, safeSettings);
}

function isAbortError(error) {
    return error instanceof AgentAbortedError
        || error?.name === 'AgentAbortedError'
        || error?.code === 'AGENT_ABORTED';
}

function logWarning(log, message, error) {
    try {
        if (typeof log === 'function') {
            log(message, error);
        } else if (log && typeof log.warn === 'function') {
            log.warn(message, error);
        }
    } catch {
        // Logging must never block detection.
    }
}

function responseValue(response) {
    return isObject(response) && Object.hasOwn(response, 'value') ? response.value : response;
}

function normalizeConfirmation(response, { ambiguous, settings }) {
    const value = responseValue(response);
    if (!isObject(value) || value.confirmed !== true) {
        return null;
    }
    const minConfidence = clampMinConfidence(settings?.badEnds?.minConfidence);
    const confidence = finiteNumber(value.confidence);
    if (confidence === null || confidence < minConfidence) {
        return null;
    }
    if (!BAD_END_TYPES.includes(value.type)) {
        return null;
    }
    if (typeof value.characterId !== 'string' || value.characterId.length === 0) {
        return null;
    }
    const candidates = asArray(ambiguous).filter((candidate) => isObject(candidate));
    const anchor = candidates.find((candidate) => {
        if (candidate.characterId !== value.characterId) {
            return false;
        }
        const allowedTypes = [
            candidate.badEndType,
            ...(Array.isArray(candidate.allowedTypes) ? candidate.allowedTypes : []),
        ].filter((type) => typeof type === 'string');
        return allowedTypes.includes(value.type);
    });
    if (!anchor) {
        return null;
    }
    const cause = typeof value.cause === 'string' && value.cause.trim().length > 0
        ? value.cause.trim().slice(0, MAX_CAUSE)
        : (typeof anchor.cause === 'string' && anchor.cause.trim().length > 0
            ? anchor.cause
            : causeFor(value.type, asArray(anchor.evidence)));
    return {
        ...anchor,
        badEndType: value.type,
        type: value.type,
        severity: typeof value.severity === 'string' || typeof value.severity === 'number'
            ? value.severity
            : anchor.severity ?? 'major',
        cause,
        sourceCharacterId: typeof value.sourceCharacterId === 'string'
            ? value.sourceCharacterId
            : anchor.sourceCharacterId ?? null,
        sourceFactionId: typeof value.sourceFactionId === 'string'
            ? value.sourceFactionId
            : anchor.sourceFactionId ?? null,
        playableAs: typeof value.playableAs === 'boolean'
            ? value.playableAs
            : anchor.playableAs === true,
        reversibility: typeof value.reversibility === 'string'
            ? value.reversibility
            : anchor.reversibility ?? 'none',
        confidence,
        rationale: typeof value.rationale === 'string' ? value.rationale.slice(0, 600) : '',
    };
}

/**
 * Create the bad-end detector wrapper.
 *
 * `plan` is the deterministic test seam (`request.propose`); `run` performs at
 * most one model call for ambiguous evidence and never writes state.
 */
export function createBadEndDetector({
    runner = null,
    getSettings = null,
    log = null,
} = {}) {
    function settingsFor(request) {
        if (typeof getSettings === 'function') {
            const settings = getSettings();
            if (isObject(settings)) {
                return settings;
            }
        }
        return isObject(request?.settings) ? request.settings : {};
    }

    function prepare(request = {}) {
        const settings = settingsFor(request);
        const state = request.state ?? null;
        const message = request.message ?? request.text ?? '';
        const recentProse = request.recentProse ?? '';
        const formRules = request.formRules ?? null;
        const options = {
            allowDeadContinuation: settings?.badEnds?.allowDeadContinuation === true,
            ...(isObject(request.options) ? request.options : {}),
        };
        const evaluation = evaluateBadEndCandidates({
            state,
            message,
            recentProse,
            formRules,
            options,
        });
        const prompt = evaluation.ambiguous.length > 0
            ? buildBadEndPrompt({
                state,
                message,
                recentProse,
                candidates: evaluation.ambiguous,
                settings,
            })
            : '';
        return { settings, state, message, recentProse, formRules, evaluation, prompt };
    }

    function plan(request = {}) {
        const prepared = prepare(request);
        const base = {
            enabled: prepared.settings?.badEnds?.enabled === true,
            candidates: prepared.evaluation.candidates.slice(),
            ambiguous: prepared.evaluation.ambiguous.slice(),
            skipped: prepared.evaluation.skipped.slice(),
            prompt: prepared.prompt,
            calls: 0,
            source: prepared.evaluation.ambiguous.length > 0 ? 'agent' : 'deterministic',
        };
        if (prepared.evaluation.ambiguous.length === 0
            || typeof request.propose !== 'function') {
            return { ...base, records: prepared.evaluation.candidates.slice() };
        }
        let response;
        try {
            response = request.propose({
                prompt: prepared.prompt,
                schema: BAD_END_SCHEMA,
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Bad-end confirmation failed; deterministic records only', error);
            return {
                ...base,
                records: prepared.evaluation.candidates.slice(),
                error: error?.message ?? String(error),
            };
        }
        const confirmed = normalizeConfirmation(response, {
            ambiguous: prepared.evaluation.ambiguous,
            settings: prepared.settings,
        });
        return {
            ...base,
            calls: 1,
            records: confirmed
                ? [...prepared.evaluation.candidates, confirmed]
                : prepared.evaluation.candidates.slice(),
        };
    }

    async function run(request = {}) {
        const prepared = prepare(request);
        if (prepared.settings?.badEnds?.enabled !== true) {
            return {
                enabled: false,
                calls: 0,
                records: [],
                ambiguous: [],
                prompt: '',
            };
        }

        const base = {
            enabled: true,
            candidates: prepared.evaluation.candidates.slice(),
            ambiguous: prepared.evaluation.ambiguous.slice(),
            skipped: prepared.evaluation.skipped.slice(),
            prompt: prepared.prompt,
            records: prepared.evaluation.candidates.slice(),
        };

        if (prepared.evaluation.ambiguous.length === 0
            || typeof runner?.runAgent !== 'function') {
            return { ...base, calls: 0, source: 'deterministic' };
        }

        try {
            const response = await runner.runAgent({
                agentId: 'badEnd',
                prompt: prepared.prompt,
                schema: BAD_END_SCHEMA,
                signal: request.signal,
            });
            const confirmed = normalizeConfirmation(response, {
                ambiguous: prepared.evaluation.ambiguous,
                settings: prepared.settings,
            });
            return {
                ...base,
                calls: 1,
                source: 'agent',
                records: confirmed
                    ? [...prepared.evaluation.candidates, confirmed]
                    : prepared.evaluation.candidates.slice(),
            };
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            logWarning(log, 'Bad-end detection failed; deterministic records only', error);
            return {
                ...base,
                calls: 1,
                source: 'deterministic',
                error: error?.message ?? String(error),
            };
        }
    }

    return { plan, run, prompt: buildBadEndPrompt };
}
