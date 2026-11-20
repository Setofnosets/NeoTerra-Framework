/**
 * The single LLM request path used by every Neo Terra agent.
 *
 * Responsibilities:
 *  - route through a Connection Manager profile, the main connection, or
 *    `generateRaw` (with `trimNames: false`);
 *  - extract one strict JSON value from messy completion text;
 *  - validate it against an optional per-agent schema;
 *  - make exactly one repair attempt;
 *  - respect timeout/abort signals;
 *  - log request/response/validation data to an in-memory agent log.
 *
 * The client never imports `src/state/**` and never persists anything.
 */

import { createLogger } from '../core/logger.js';
import { getSettings as readSettings } from '../core/settings.js';
import { agentLog } from '../ui/agent-log.js';
import {
    buildMessages,
    buildRepairSystemPrompt,
    buildRepairUserPrompt,
    buildSystemPrompt,
    resolveAgentConfig,
} from './prompts.js';

const MAX_LOG_CHARS = 20000;

export class AgentTransportError extends Error {
    constructor(message, { cause } = {}) {
        super(message);
        this.name = 'AgentTransportError';
        this.code = 'AGENT_TRANSPORT_ERROR';
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export class AgentAbortedError extends Error {
    constructor(message, { cause, timedOut = false } = {}) {
        super(message);
        this.name = 'AgentAbortedError';
        this.code = 'AGENT_ABORTED';
        this.timedOut = Boolean(timedOut);

        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export class AgentResponseError extends Error {
    constructor(message, options = {}) {
        super(message);
        const {
            agentId = null,
            attempts = 0,
            rawResponse = '',
            rawResponses = [],
            errors = [],
            attemptErrors = [],
            cause,
        } = options;
        this.name = 'AgentResponseError';
        this.code = 'AGENT_RESPONSE_ERROR';
        this.agentId = agentId;
        this.attempts = attempts;
        this.rawResponse = rawResponse;
        this.rawResponses = rawResponses;
        this.errors = Array.isArray(errors) ? errors : [];
        this.attemptErrors = Array.isArray(attemptErrors) ? attemptErrors : [];
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

/**
 * Extract the first balanced JSON object/array from arbitrary completion text.
 * The scanner tracks string state and escapes; it is not a greedy regex.
 *
 * @returns {{ok: boolean, value: unknown, raw: string, error: string|null}}
 */
export function extractJson(text) {
    if (typeof text !== 'string') {
        return {
            ok: false,
            value: undefined,
            raw: '',
            error: 'Expected a string response',
        };
    }

    const input = text.trim();
    if (!input) {
        return {
            ok: false,
            value: undefined,
            raw: '',
            error: 'Empty response',
        };
    }

    let firstError = null;
    let searchFrom = 0;

    while (searchFrom < input.length) {
        const start = findCandidateStart(input, searchFrom);
        if (start === -1) {
            break;
        }

        const end = scanBalanced(input, start);
        if (end !== -1) {
            const raw = input.slice(start, end + 1);
            try {
                return { ok: true, value: JSON.parse(raw), raw, error: null };
            } catch (error) {
                if (firstError === null) {
                    firstError = {
                        raw,
                        error: `Invalid JSON: ${error?.message ?? 'parse error'}`,
                    };
                }
            }
        }

        searchFrom = start + 1;
    }

    if (firstError) {
        return {
            ok: false,
            value: undefined,
            raw: firstError.raw,
            error: firstError.error,
        };
    }

    return {
        ok: false,
        value: undefined,
        raw: input,
        error: 'No balanced JSON value found',
    };
}

/**
 * Validate a value against the dependency-free JSON-schema subset used by
 * agent schemas. Unknown keywords are ignored; malformed schema shapes produce
 * `$schema` errors instead of throwing.
 *
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateJsonSchema(value, schema) {
    const errors = [];
    validateNode(value, schema, '$', { root: schema, refs: [] }, errors, 0);
    return { ok: errors.length === 0, errors };
}

/**
 * Pull the assistant's text from common SillyTavern/OpenAI response shapes.
 */
export function collectCompletionText(response) {
    if (typeof response === 'string') {
        return response;
    }
    if (!response || typeof response !== 'object') {
        return '';
    }

    const candidates = [
        () => response.content,
        () => response.message?.content,
        () => response.choices?.[0]?.message?.content,
        () => response.choices?.[0]?.text,
    ];

    for (const getCandidate of candidates) {
        let candidate;
        try {
            candidate = getCandidate();
        } catch {
            continue;
        }
        if (candidate === undefined || candidate === null || candidate === '') {
            continue;
        }
        if (typeof candidate === 'string') {
            return candidate;
        }
        try {
            return JSON.stringify(candidate);
        } catch {
            return String(candidate);
        }
    }

    return '';
}

/**
 * Create an agent client. All dependencies are injectable for tests.
 */
export function createAgentClient(options = {}) {
    const {
        ctx,
        getSettings: getSettingsOption,
        log: logOption,
        logger = createLogger('agents'),
        now = Date.now,
        schedule = setTimeout,
        cancel = clearTimeout,
        generateRaw,
        transport,
    } = options;

    const log = logOption === undefined ? agentLog : logOption;
    const defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs) ?? 60000;
    const getSettings = typeof getSettingsOption === 'function'
        ? getSettingsOption
        : () => readSettings(ctx);
    const inFlight = new Set();

    function tryExtract(text, schema) {
        const parsed = extractJson(text);
        if (!parsed.ok) {
            return {
                ok: false,
                value: undefined,
                raw: parsed.raw,
                errors: [{ path: '$', message: parsed.error }],
                error: parsed.error,
            };
        }
        if (schema === undefined || schema === null) {
            return {
                ok: true,
                value: parsed.value,
                raw: parsed.raw,
                errors: [],
                error: null,
            };
        }
        const validation = validateJsonSchema(parsed.value, schema);
        return {
            ok: validation.ok,
            value: parsed.value,
            raw: parsed.raw,
            errors: validation.errors,
            error: validation.ok ? null : validation.errors[0]?.message ?? 'Invalid JSON value',
        };
    }

    async function sendAgentRequest(request = {}) {
        const {
            agentId,
            prompt = '',
            schema = null,
            overrides = {},
            context: _context,
            signal: externalSignal,
            timeoutMs,
        } = request;

        const startedAt = now();
        const settings = getSettings();
        const config = resolveAgentConfig(settings, agentId, overrides, {
            timeoutMs: defaultTimeoutMs,
        });
        if (config.enabled === false) {
            throw new AgentTransportError(`Agent "${agentId}" is disabled`);
        }

        // Single source of truth: resolveAgentConfig already applied
        // overrides > settings > default for timeoutMs.
        const effectiveTimeoutMs =
            positiveInteger(timeoutMs) ?? config.timeoutMs ?? defaultTimeoutMs;
        const userPrompt = String(prompt ?? '');
        let systemPrompt = buildSystemPrompt({ agentId, settings, overrides, schema });

        const entryId = safeBegin(log, {
            agentId,
            request: userPrompt,
            route: null,
        });

        const controller = new AbortController();
        inFlight.add(controller);
        let timer = null;
        let cleanupSignal = () => {};
        let timedOut = false;
        let attemptsMade = 0;

        try {
            const linked = linkSignals(controller, externalSignal);
            const requestSignal = linked.signal;
            cleanupSignal = linked.cleanup;

            if (effectiveTimeoutMs > 0) {
                timer = schedule(() => {
                    if (!controller.signal.aborted) {
                        timedOut = true;
                        controller.abort();
                    }
                }, effectiveTimeoutMs);
            }

            const first = await performAttempt({
                agentId,
                config,
                systemPrompt,
                userPrompt,
                signal: requestSignal,
                timedOut: () => timedOut,
                timeoutMs: effectiveTimeoutMs,
            });
            attemptsMade = 1;

            const firstRaw = first.raw;
            const firstCheck = tryExtract(collectCompletionText(firstRaw), schema);

            if (firstCheck.ok) {
                const durationMs = Math.max(0, now() - startedAt);
                safeFinish(log, entryId, {
                    status: 'ok',
                    response: asLogText(firstRaw),
                    errors: [],
                    attempts: 1,
                    route: first.route,
                    durationMs,
                });
                return {
                    value: firstCheck.value,
                    raw: firstRaw,
                    attempts: 1,
                    route: first.route,
                    agentId,
                    durationMs,
                };
            }

            safeUpdate(log, entryId, {
                // 'running' is the only valid non-terminal status; the repair
                // outcome becomes 'repaired' or 'failed' when it settles.
                status: 'running',
                route: first.route,
                response: asLogText(firstRaw),
                errors: firstCheck.errors,
                attempts: 1,
            });

            const repairSystemPrompt = buildRepairSystemPrompt({
                agentId,
                settings,
                overrides,
                schema,
            });
            const repairUserPrompt = buildRepairUserPrompt({
                originalPrompt: userPrompt,
                rawResponse: firstRaw,
                errors: firstCheck.errors,
                schema,
            });
            systemPrompt = repairSystemPrompt;

            const second = await performAttempt({
                agentId,
                config,
                systemPrompt: repairSystemPrompt,
                userPrompt: repairUserPrompt,
                signal: requestSignal,
                timedOut: () => timedOut,
                timeoutMs: effectiveTimeoutMs,
            });
            attemptsMade = 2;

            const secondRaw = second.raw;
            const secondCheck = tryExtract(collectCompletionText(secondRaw), schema);
            const durationMs = Math.max(0, now() - startedAt);

            if (secondCheck.ok) {
                safeFinish(log, entryId, {
                    status: 'repaired',
                    response: asLogText(secondRaw),
                    errors: [],
                    attempts: 2,
                    route: second.route,
                    durationMs,
                });
                return {
                    value: secondCheck.value,
                    raw: secondRaw,
                    attempts: 2,
                    route: second.route,
                    agentId,
                    durationMs,
                };
            }

            const attemptErrors = [firstCheck.errors, secondCheck.errors];
            const responseError = new AgentResponseError(
                `Agent "${agentId}" returned invalid JSON after one repair attempt`,
                {
                    agentId,
                    attempts: 2,
                    rawResponse: secondRaw,
                    rawResponses: [firstRaw, secondRaw],
                    errors: secondCheck.errors,
                    attemptErrors,
                    cause: secondCheck.errors[0],
                },
            );

            safeFinish(log, entryId, {
                status: 'failed',
                response: asLogText(secondRaw),
                errors: secondCheck.errors,
                attempts: 2,
                route: second.route,
                durationMs,
            });

            throw responseError;
        } catch (error) {
            const durationMs = Math.max(0, now() - startedAt);
            if (error instanceof AgentResponseError) {
                throw error;
            }
            if (isAbortFailure(error, controller, externalSignal)) {
                const abortError = error instanceof AgentAbortedError
                    ? error
                    : new AgentAbortedError(
                        timedOut
                            ? `Agent "${agentId}" timed out after ${effectiveTimeoutMs}ms`
                            : `Agent "${agentId}" request was aborted`,
                        { cause: error, timedOut },
                    );
                safeFinish(log, entryId, {
                    status: 'aborted',
                    response: '',
                    errors: [{ path: '$', message: abortError.message }],
                    attempts: attemptsMade,
                    route: null,
                    durationMs,
                });
                throw abortError;
            }

            if (error instanceof AgentTransportError) {
                safeFinish(log, entryId, {
                    status: 'failed',
                    response: '',
                    errors: [{ path: '$', message: error.message }],
                    attempts: 0,
                    route: null,
                    durationMs,
                });
                throw error;
            }

            safeFinish(log, entryId, {
                status: 'failed',
                response: '',
                errors: [{ path: '$', message: error?.message ?? String(error) }],
                attempts: 0,
                route: null,
                durationMs,
            });
            throw error;
        } finally {
            if (timer !== null) {
                try {
                    cancel(timer);
                } catch {
                    // Timer cleanup must never mask the agent result.
                }
            }
            cleanupSignal();
            inFlight.delete(controller);
        }

        async function performAttempt({
            agentId: attemptAgentId,
            config: attemptConfig,
            systemPrompt: attemptSystemPrompt,
            userPrompt: attemptUserPrompt,
            signal,
            timedOut: isTimedOut,
            timeoutMs: attemptTimeoutMs,
        }) {
            const messages = buildMessages({
                systemPrompt: attemptSystemPrompt,
                userPrompt: attemptUserPrompt,
            });
            const routes = buildRoutes(attemptConfig);
            if (routes.length === 0) {
                throw new AgentTransportError(
                    `No agent transport is available for "${attemptAgentId}"`,
                );
            }

            let lastError = null;
            for (const route of routes) {
                if (signal.aborted) {
                    throw abortErrorFor(
                        attemptAgentId,
                        attemptTimeoutMs,
                        isTimedOut(),
                        lastError,
                    );
                }
                try {
                    const raw = await invokeRoute(route, {
                        messages,
                        systemPrompt: attemptSystemPrompt,
                        userPrompt: attemptUserPrompt,
                        config: attemptConfig,
                        signal,
                    });
                    safeUpdate(log, entryId, { route: route.kind });
                    return { raw, route: route.kind };
                } catch (error) {
                    if (isAbortFailure(error, controller, signal)) {
                        throw abortErrorFor(
                            attemptAgentId,
                            attemptTimeoutMs,
                            isTimedOut(),
                            error,
                        );
                    }
                    lastError = error;
                    try {
                        logger.warn?.(
                            `Agent "${attemptAgentId}" transport "${route.kind}" failed; trying next`,
                            error,
                        );
                    } catch {
                        // Logging must not break routing.
                    }
                }
            }

            throw new AgentTransportError(
                `Every agent transport failed for "${attemptAgentId}"`,
                { cause: lastError },
            );
        }

        function buildRoutes(attemptConfig) {
            if (typeof transport === 'function') {
                return [{ kind: 'transport' }];
            }

            const routes = [];
            if (
                attemptConfig.connectionProfileId &&
                typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function'
            ) {
                routes.push({ kind: 'profile' });
            }
            if (typeof ctx?.ChatCompletionService?.processRequest === 'function') {
                routes.push({ kind: 'main' });
            }
            if (resolveGenerateRaw() !== null) {
                routes.push({ kind: 'generateRaw' });
            }
            return routes;
        }

        function resolveGenerateRaw() {
            if (typeof generateRaw === 'function') {
                return generateRaw;
            }
            if (typeof ctx?.generateRaw === 'function') {
                return (payload) => ctx.generateRaw(payload);
            }
            return null;
        }

        async function invokeRoute(route, requestContext) {
            const {
                messages,
                systemPrompt: routeSystemPrompt,
                userPrompt: routeUserPrompt,
                config: routeConfig,
                signal,
            } = requestContext;

            if (route.kind === 'transport') {
                return transport({
                    messages,
                    config: routeConfig,
                    signal,
                    route: 'transport',
                });
            }

            if (route.kind === 'profile') {
                return ctx.ConnectionManagerRequestService.sendRequest(
                    routeConfig.connectionProfileId,
                    messages,
                    routeConfig.maxTokens,
                    {
                        stream: false,
                        extractData: true,
                        includeInstruct: true,
                        signal,
                    },
                    {
                        model: routeConfig.model || undefined,
                        temperature: routeConfig.temperature,
                        max_tokens: routeConfig.maxTokens,
                    },
                );
            }

            if (route.kind === 'main') {
                return ctx.ChatCompletionService.processRequest(
                    {
                        stream: false,
                        messages,
                        max_tokens: routeConfig.maxTokens,
                        model: routeConfig.model || undefined,
                    },
                    { signal, presetName: undefined },
                );
            }

            const raw = resolveGenerateRaw();
            return raw({
                systemPrompt: routeSystemPrompt,
                prompt: routeUserPrompt,
                trimNames: false,
                bypassAll: true,
                temperature: routeConfig.temperature,
                responseLength: routeConfig.maxTokens,
                signal,
                model: routeConfig.model || undefined,
            });
        }
    }

    function dispose() {
        for (const controller of [...inFlight]) {
            try {
                controller.abort();
            } catch {
                // Aborting a finished request is a no-op.
            }
        }
        inFlight.clear();
    }

    return {
        sendAgentRequest,
        tryExtract,
        dispose,
    };
}

/**
 * Diagnostic connectivity check for one agent.
 *
 * Resolves the same configuration a real call would use, sends one tiny
 * request through the normal route chain (profile -> main -> generateRaw), and
 * reports the outcome. It never writes state, never enables/disables an agent,
 * and never throws: failures come back as `{ ok: false, error }`.
 */
export async function testAgentConnection({
    ctx = null,
    settings = null,
    agentId,
    overrides = {},
    timeoutMs = 20000,
    now = Date.now,
    transport,
    signal = null,
} = {}) {
    const startedAt = Number(now()) || Date.now();
    const override = isPlainObject(overrides) ? overrides : {};
    let route = null;
    let model = '';
    let profileName = '';
    let client = null;
    let profileOnly = false;

    try {
        const resolvedSettings = settings
            ?? (ctx ? readSettings(ctx) : null)
            ?? {};
        const config = resolveAgentConfig(resolvedSettings, agentId, {
            ...override,
            // Testing is diagnostic: a disabled agent still gets a probe.
            enabled: true,
        });
        model = config.model || '';
        if (config.connectionProfileId) {
            const profile = resolveProfile(ctx, config.connectionProfileId);
            profileName = profile.name;
            if (!model) {
                model = profile.model;
            }
        }
        // Only report the main chat model when the main route is what runs.
        if (!model && !config.connectionProfileId && typeof ctx?.getChatCompletionModel === 'function') {
            try {
                const current = ctx.getChatCompletionModel();
                model = typeof current === 'string' ? current : '';
            } catch {
                // The model getter is optional.
            }
        }

        // A configured profile is tested on its own: silently falling back to
        // the main connection would hide the broken pick the user is checking.
        let effectiveTransport = transport;
        if (
            typeof effectiveTransport !== 'function'
            && config.connectionProfileId
            && typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function'
        ) {
            profileOnly = true;
            const profileId = config.connectionProfileId;
            effectiveTransport = ({ messages, config: routeConfig, signal: routeSignal }) => (
                ctx.ConnectionManagerRequestService.sendRequest(
                    profileId,
                    messages,
                    routeConfig.maxTokens,
                    {
                        stream: false,
                        extractData: true,
                        includeInstruct: true,
                        signal: routeSignal,
                    },
                    {
                        model: routeConfig.model || undefined,
                        temperature: routeConfig.temperature,
                        max_tokens: routeConfig.maxTokens,
                    },
                )
            );
        }

        client = createAgentClient({
            ctx,
            getSettings: () => resolvedSettings,
            now,
            transport: effectiveTransport,
            logger: createLogger('agent-test'),
        });
        const result = await client.sendAgentRequest({
            agentId,
            prompt: 'Reply with {"ok":true}. Return only that JSON object.',
            schema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean' } },
            },
            overrides: { ...override, enabled: true },
            timeoutMs,
            signal,
        });
        route = profileOnly ? 'profile' : (result?.route ?? null);
        return {
            ok: true,
            route,
            model,
            profileName,
            latencyMs: Math.max(0, Number(now()) - startedAt),
            error: null,
        };
    } catch (error) {
        return {
            ok: false,
            route: profileOnly ? 'profile' : route,
            model,
            profileName,
            latencyMs: Math.max(0, Number(now()) - startedAt),
            error: describeTestFailure(error, timeoutMs),
        };
    } finally {
        try {
            client?.dispose?.();
        } catch {
            // Disposal must never mask the result.
        }
    }
}

function resolveProfile(ctx, profileId) {
    try {
        const list = ctx?.ConnectionManagerRequestService?.getSupportedProfiles?.();
        const match = Array.isArray(list) ? list.find((profile) => profile?.id === profileId) : null;
        return {
            name: typeof match?.name === 'string' ? match.name : '',
            model: typeof match?.model === 'string' ? match.model : '',
        };
    } catch {
        return { name: '', model: '' };
    }
}

function describeTestFailure(error, timeoutMs) {
    let current = error;
    let lastMessage = '';
    for (let depth = 0; current && depth < 6; depth += 1) {
        if (current.timedOut) {
            return `timed out after ${timeoutMs}ms`;
        }
        const message = String(current.message ?? '').trim();
        if (message) {
            lastMessage = message;
        }
        const status = Number(current.status ?? current.statusCode);
        if (Number.isFinite(status) && status > 0) {
            const text = message || lastMessage;
            return text.includes(String(status)) ? text : `${status} · ${text || 'request failed'}`;
        }
        current = current.cause;
    }
    return lastMessage || 'Unknown error';
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function abortErrorFor(agentId, timeoutMs, timedOutFlag, cause) {
    return new AgentAbortedError(
        timedOutFlag
            ? `Agent "${agentId}" timed out after ${timeoutMs}ms`
            : `Agent "${agentId}" request was aborted`,
        { cause, timedOut: Boolean(timedOutFlag) },
    );
}

function isAbortFailure(error, controller, externalSignal) {
    if (error instanceof AgentAbortedError) {
        return true;
    }
    // Deliberate precedence: once the pass is aborted, a concurrent route
    // failure is treated as abort, because no result will be accepted anyway.
    if (controller?.signal?.aborted || externalSignal?.aborted) {
        return true;
    }
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return true;
    }
    return /(?:request|operation|signal|transport|connection)\s+(?:was\s+)?aborted/i.test(
        String(error?.message ?? ''),
    );
}

function linkSignals(controller, externalSignal) {
    if (!externalSignal) {
        return { signal: controller.signal, cleanup: () => {} };
    }

    if (
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.any === 'function'
    ) {
        return {
            signal: AbortSignal.any([controller.signal, externalSignal]),
            cleanup: () => {},
        };
    }

    if (externalSignal.aborted) {
        controller.abort();
        return { signal: controller.signal, cleanup: () => {} };
    }

    const onAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onAbort, { once: true });
    return {
        signal: controller.signal,
        cleanup: () => externalSignal.removeEventListener('abort', onAbort),
    };
}

function findCandidateStart(input, from) {
    for (let i = from; i < input.length; i += 1) {
        const char = input[i];
        if (char === '{' || char === '[') {
            return i;
        }
    }
    return -1;
}

function scanBalanced(input, start) {
    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = start; i < input.length; i += 1) {
        const char = input[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{' || char === '[') {
            stack.push(char);
            continue;
        }

        if (char === '}' || char === ']') {
            const open = stack[stack.length - 1];
            if (
                (char === '}' && open !== '{') ||
                (char === ']' && open !== '[')
            ) {
                return -1;
            }
            stack.pop();
            if (stack.length === 0) {
                return i;
            }
        }
    }

    return -1;
}

const JSON_TYPES = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
]);

function validateNode(value, schema, path, context, errors, depth) {
    if (depth > 100) {
        errors.push({
            path: '$schema',
            message: 'Schema recursion limit exceeded',
        });
        return;
    }

    if (!isPlainObject(schema)) {
        errors.push({
            path: '$schema',
            message: 'Schema node must be an object',
        });
        return;
    }

    if (schema.$ref !== undefined) {
        if (
            typeof schema.$ref !== 'string' ||
            (!schema.$ref.startsWith('#/$defs/') &&
                !schema.$ref.startsWith('#/definitions/'))
        ) {
            errors.push({
                path: '$schema',
                message: '$ref must point inside #/$defs/ or #/definitions/',
            });
            return;
        }
        if (context.refs.includes(schema.$ref)) {
            errors.push({
                path: '$schema',
                message: `Circular $ref: ${schema.$ref}`,
            });
            return;
        }
        const target = resolveRef(context.root, schema.$ref);
        if (target === undefined) {
            errors.push({
                path: '$schema',
                message: `Unresolved $ref: ${schema.$ref}`,
            });
            return;
        }
        validateNode(
            value,
            target,
            path,
            { ...context, refs: [...context.refs, schema.$ref] },
            errors,
            depth + 1,
        );
        return;
    }

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (
            types.length === 0 ||
            !types.every((type) => typeof type === 'string' && JSON_TYPES.has(type))
        ) {
            errors.push({
                path: '$schema',
                message: 'type must be a JSON type name or an array of them',
            });
            return;
        }
        if (!types.some((type) => matchesType(value, type))) {
            errors.push({
                path,
                message: `must be of type ${types.join(' or ')}`,
            });
            return;
        }
    }

    if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum)) {
            pushSchemaError(errors, 'enum must be an array');
        } else if (!schema.enum.some((candidate) => jsonEqual(candidate, value))) {
            errors.push({ path, message: 'must be one of the allowed values' });
        }
    }

    if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
        errors.push({ path, message: 'must equal the required constant' });
    }

    if (typeof value === 'string') {
        if (schema.minLength !== undefined) {
            if (!nonNegativeInteger(schema.minLength)) {
                pushSchemaError(errors, 'minLength must be a non-negative integer');
            } else if (value.length < schema.minLength) {
                errors.push({
                    path,
                    message: `must be at least ${schema.minLength} characters`,
                });
            }
        }
        if (schema.maxLength !== undefined) {
            if (!nonNegativeInteger(schema.maxLength)) {
                pushSchemaError(errors, 'maxLength must be a non-negative integer');
            } else if (value.length > schema.maxLength) {
                errors.push({
                    path,
                    message: `must be at most ${schema.maxLength} characters`,
                });
            }
        }
        if (schema.pattern !== undefined) {
            if (typeof schema.pattern !== 'string') {
                pushSchemaError(errors, 'pattern must be a string');
            } else {
                let expression;
                try {
                    expression = new RegExp(schema.pattern);
                } catch {
                    pushSchemaError(errors, 'pattern is not a valid regular expression');
                }
                if (expression && !expression.test(value)) {
                    errors.push({
                        path,
                        message: `must match pattern ${schema.pattern}`,
                    });
                }
            }
        }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (schema.minimum !== undefined) {
            if (typeof schema.minimum !== 'number') {
                pushSchemaError(errors, 'minimum must be a number');
            } else if (value < schema.minimum) {
                errors.push({
                    path,
                    message: `must be >= ${schema.minimum}`,
                });
            }
        }
        if (schema.maximum !== undefined) {
            if (typeof schema.maximum !== 'number') {
                pushSchemaError(errors, 'maximum must be a number');
            } else if (value > schema.maximum) {
                errors.push({
                    path,
                    message: `must be <= ${schema.maximum}`,
                });
            }
        }
    }

    if (Array.isArray(value)) {
        if (schema.minItems !== undefined) {
            if (!nonNegativeInteger(schema.minItems)) {
                pushSchemaError(errors, 'minItems must be a non-negative integer');
            } else if (value.length < schema.minItems) {
                errors.push({
                    path,
                    message: `must contain at least ${schema.minItems} items`,
                });
            }
        }
        if (schema.maxItems !== undefined) {
            if (!nonNegativeInteger(schema.maxItems)) {
                pushSchemaError(errors, 'maxItems must be a non-negative integer');
            } else if (value.length > schema.maxItems) {
                errors.push({
                    path,
                    message: `must contain at most ${schema.maxItems} items`,
                });
            }
        }
        if (schema.items !== undefined) {
            if (Array.isArray(schema.items)) {
                for (let i = 0; i < value.length; i += 1) {
                    if (schema.items[i] !== undefined) {
                        validateNode(
                            value[i],
                            schema.items[i],
                            `${path}[${i}]`,
                            context,
                            errors,
                            depth + 1,
                        );
                    }
                }
            } else if (isPlainObject(schema.items)) {
                for (let i = 0; i < value.length; i += 1) {
                    validateNode(
                        value[i],
                        schema.items,
                        `${path}[${i}]`,
                        context,
                        errors,
                        depth + 1,
                    );
                }
            } else {
                pushSchemaError(errors, 'items must be a schema or array of schemas');
            }
        }
    }

    if (isPlainObject(value)) {
        if (schema.required !== undefined) {
            if (
                !Array.isArray(schema.required) ||
                !schema.required.every((key) => typeof key === 'string')
            ) {
                pushSchemaError(errors, 'required must be an array of strings');
            } else {
                for (const key of schema.required) {
                    if (!Object.hasOwn(value, key)) {
                        errors.push({
                            path: `${path}.${key}`,
                            message: 'is required',
                        });
                    }
                }
            }
        }

        const properties = schema.properties;
        let propertiesValid = true;
        if (properties !== undefined && !isPlainObject(properties)) {
            pushSchemaError(errors, 'properties must be an object');
            propertiesValid = false;
        } else if (isPlainObject(properties)) {
            for (const [key, childSchema] of Object.entries(properties)) {
                if (Object.hasOwn(value, key)) {
                    validateNode(
                        value[key],
                        childSchema,
                        `${path}.${key}`,
                        context,
                        errors,
                        depth + 1,
                    );
                }
            }
        }

        if (schema.additionalProperties !== undefined && propertiesValid) {
            if (typeof schema.additionalProperties !== 'boolean') {
                pushSchemaError(errors, 'additionalProperties must be a boolean');
            } else if (schema.additionalProperties === false) {
                const allowed = isPlainObject(properties) ? properties : {};
                for (const key of Object.keys(value)) {
                    if (!Object.hasOwn(allowed, key)) {
                        errors.push({
                            path: `${path}.${key}`,
                            message: 'is not allowed',
                        });
                    }
                }
            }
        }
    }

    validateCombinators(value, schema, path, context, errors, depth);
}

function validateCombinators(value, schema, path, context, errors, depth) {
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
        const branches = schema[keyword];
        if (branches === undefined) {
            continue;
        }
        if (!Array.isArray(branches) || branches.length === 0) {
            pushSchemaError(errors, `${keyword} must be a non-empty array`);
            continue;
        }

        const branchResults = branches.map((branch) => {
            const branchErrors = [];
            validateNode(value, branch, path, context, branchErrors, depth + 1);
            return branchErrors;
        });

        if (keyword === 'allOf') {
            for (const branchErrors of branchResults) {
                errors.push(...branchErrors);
            }
            continue;
        }

        const matches = branchResults.filter((branchErrors) => branchErrors.length === 0).length;
        if (keyword === 'anyOf' && matches === 0) {
            errors.push({
                path,
                message: 'must match at least one anyOf schema',
            });
        }
        if (keyword === 'oneOf' && matches !== 1) {
            errors.push({
                path,
                message: 'must match exactly one oneOf schema',
            });
        }
    }
}

function resolveRef(root, ref) {
    const parts = ref
        .slice(2)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = root;
    for (const part of parts) {
        if (target === null || typeof target !== 'object' || !Object.hasOwn(target, part)) {
            return undefined;
        }
        target = target[part];
    }
    return target;
}

function matchesType(value, type) {
    switch (type) {
        case 'object':
            return isPlainObject(value);
        case 'array':
            return Array.isArray(value);
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            return false;
    }
}

function pushSchemaError(errors, message) {
    errors.push({ path: '$schema', message });
}

function jsonEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

function asLogText(value) {
    if (typeof value === 'string') {
        return value.length > MAX_LOG_CHARS ? value.slice(0, MAX_LOG_CHARS) : value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function safeBegin(log, payload) {
    if (!log || typeof log.begin !== 'function') {
        return null;
    }
    try {
        const entry = log.begin(payload);
        if (entry && typeof entry === 'object') {
            return entry.id ?? null;
        }
        return entry ?? null;
    } catch {
        return null;
    }
}

function safeUpdate(log, id, patch) {
    if (id === null || id === undefined || !log || typeof log.update !== 'function') {
        return;
    }
    try {
        log.update(id, patch);
    } catch {
        // Logging must never break an agent call.
    }
}

function safeFinish(log, id, patch) {
    if (id === null || id === undefined || !log || typeof log.finish !== 'function') {
        return;
    }
    try {
        log.finish(id, patch);
    } catch {
        // Logging must never break an agent call.
    }
}
