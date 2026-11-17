/**
 * Sequential agent runner with chat-affinity protection.
 *
 * The runner never writes state, never posts to chat, and never runs LLM calls
 * in parallel. It resolves per-agent schemas, starts a chat-affinity pass,
 * aborts work when the chat changes, and returns only parsed client values.
 */

import { createChatAffinity } from '../core/chat-affinity.js';
import { createLogger } from '../core/logger.js';
import { agentLog as defaultAgentLog } from '../ui/agent-log.js';
import { AgentAbortedError } from './client.js';

/**
 * Create an agent runner.
 *
 * @param {object} options
 * @param {{sendAgentRequest: Function}} options.client
 * @param {object} [options.affinity]
 * @param {object} [options.log]
 * @param {Record<string, object>} [options.schemas]
 */
export function createAgentRunner({
    client,
    affinity,
    log,
    schemas = {},
    now = Date.now,
    logger = createLogger('agents'),
} = {}) {
    if (!client || typeof client.sendAgentRequest !== 'function') {
        throw new TypeError('createAgentRunner requires a client with sendAgentRequest');
    }

    const logSink = log === undefined ? defaultAgentLog : log;
    const ownsAffinity = !affinity;
    const affinityApi = affinity ?? createChatAffinity();
    const inFlight = new Set();

    async function runAgent(request = {}) {
        const {
            agentId,
            prompt = '',
            schema,
            overrides = {},
            context,
            signal: callerSignal,
        } = request;

        const startedAt = now();
        const resolvedSchema = schema !== undefined
            ? schema
            : schemas && Object.hasOwn(schemas, agentId)
                ? schemas[agentId]
                : null;

        const token = beginPass(affinityApi);
        const tokenChatId = token?.chatId ?? null;
        const controller = new AbortController();
        inFlight.add(controller);

        let removeCallerAbort = () => {};
        let unsubscribe = () => {};

        try {
            if (callerSignal) {
                if (callerSignal.aborted) {
                    controller.abort();
                } else {
                    const onAbort = () => controller.abort();
                    callerSignal.addEventListener('abort', onAbort, { once: true });
                    removeCallerAbort = () => callerSignal.removeEventListener('abort', onAbort);
                }
            }

            if (typeof affinityApi.onChange === 'function') {
                unsubscribe = affinityApi.onChange((event) => {
                    const nextChatId = event?.chatId ?? null;
                    if (nextChatId !== tokenChatId) {
                        controller.abort();
                    }
                });
            }

            if (controller.signal.aborted || !isTokenCurrent(affinityApi, token)) {
                controller.abort();
                const error = new AgentAbortedError(
                    `Chat changed before agent "${agentId}" started`,
                    { timedOut: false },
                );
                logRunnerAbort({ agentId, prompt, startedAt, message: error.message });
                throw error;
            }

            let result;
            try {
                result = await client.sendAgentRequest({
                    agentId,
                    prompt,
                    schema: resolvedSchema,
                    overrides,
                    context,
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted && !(error instanceof AgentAbortedError)) {
                    const abortError = new AgentAbortedError(
                        `Agent "${agentId}" was aborted`,
                        { cause: error },
                    );
                    maybeLogRunnerAbort({ agentId, prompt, startedAt, message: abortError.message });
                    throw abortError;
                }
                if (error instanceof AgentAbortedError) {
                    maybeLogRunnerAbort({ agentId, prompt, startedAt, message: error.message });
                }
                throw error;
            }

            if (controller.signal.aborted || !isTokenCurrent(affinityApi, token)) {
                const error = new AgentAbortedError(
                    `Chat changed while agent "${agentId}" was running`,
                    { timedOut: false },
                );
                maybeLogRunnerAbort({ agentId, prompt, startedAt, message: error.message });
                throw error;
            }

            return result;
        } catch (error) {
            if (error instanceof AgentAbortedError) {
                throw error;
            }
            if (controller.signal.aborted) {
                const abortError = new AgentAbortedError(
                    `Agent "${agentId}" was aborted`,
                    { cause: error },
                );
                maybeLogRunnerAbort({ agentId, prompt, startedAt, message: abortError.message });
                throw abortError;
            }
            throw error;
        } finally {
            removeCallerAbort();
            unsubscribe();
            endPass(affinityApi, token);
            inFlight.delete(controller);
        }
    }

    async function runAgents(requests = []) {
        if (!Array.isArray(requests)) {
            throw new TypeError('runAgents expects an array of request objects');
        }
        const results = [];
        for (const request of requests) {
            results.push(await runAgent(request));
        }
        return results;
    }

    function activeChatId() {
        return typeof affinityApi.current === 'function'
            ? affinityApi.current()
            : null;
    }

    function dispose() {
        for (const controller of [...inFlight]) {
            try {
                controller.abort();
            } catch {
                // Already-finished requests are safe to ignore.
            }
        }
        inFlight.clear();
        if (ownsAffinity) {
            affinityApi.dispose?.();
        }
    }

    function maybeLogRunnerAbort({ agentId, prompt, startedAt, message }) {
        if (hasAbortedEntry(logSink, agentId, startedAt)) {
            return;
        }
        logRunnerAbort({ agentId, prompt, startedAt, message });
    }

    function logRunnerAbort({ agentId, prompt, startedAt, message }) {
        if (!logSink || typeof logSink.begin !== 'function') {
            return;
        }
        try {
            const entry = logSink.begin({
                agentId,
                request: prompt,
                route: 'runner',
            });
            const id = entry && typeof entry === 'object' ? entry.id : entry;
            logSink.finish?.(id, {
                status: 'aborted',
                response: '',
                errors: [{ path: '$', message }],
                attempts: 0,
                route: 'runner',
                durationMs: Math.max(0, now() - startedAt),
            });
        } catch {
            // Logging must never break the runner.
        }
    }

    return {
        runAgent,
        runAgents,
        activeChatId,
        dispose,
    };
}

function beginPass(affinity) {
    if (affinity && typeof affinity.begin === 'function') {
        const token = affinity.begin();
        if (token && typeof token === 'object') {
            return token;
        }
    }
    return {
        chatId: typeof affinity?.current === 'function' ? affinity.current() : null,
        startedAt: Date.now(),
    };
}

function endPass(affinity, token) {
    try {
        affinity?.end?.(token);
    } catch {
        // Ending a stale pass is best-effort.
    }
}

function isTokenCurrent(affinity, token) {
    if (affinity && typeof affinity.isCurrent === 'function') {
        return affinity.isCurrent(token);
    }
    return true;
}

function hasAbortedEntry(log, agentId, startedAt) {
    if (!log || typeof log.entries !== 'function') {
        return false;
    }
    try {
        return log.entries().some((entry) => (
            entry.agentId === agentId &&
            entry.status === 'aborted' &&
            Number(entry.time) >= Number(startedAt)
        ));
    } catch {
        return false;
    }
}
