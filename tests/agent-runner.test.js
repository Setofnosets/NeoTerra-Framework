import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cloneDefaults } from '../src/core/defaults.js';
import { AGENT_IDS } from '../src/core/constants.js';
import { createChatAffinity, ChatChangedError } from '../src/core/chat-affinity.js';
import {
    AgentAbortedError,
    AgentResponseError,
    AgentTransportError,
    collectCompletionText,
    createAgentClient,
    extractJson,
    validateJsonSchema,
} from '../src/agents/client.js';
import {
    AGENT_JSON_CONTRACT,
    DEFAULT_AGENT_PROMPTS,
    DEFAULT_REPAIR_PROMPT,
    buildMessages,
    buildRepairSystemPrompt,
    buildRepairUserPrompt,
    buildSystemPrompt,
    renderPromptTemplate,
    resolveAgentConfig,
} from '../src/agents/prompts.js';
import { createAgentRunner } from '../src/agents/runner.js';
import {
    agentLog,
    createAgentLog,
    mountAgentLog,
    renderAgentLog,
} from '../src/ui/agent-log.js';

const silentLogger = Object.freeze({
    debug() {},
    info() {},
    warn() {},
    error() {},
});

function delay(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSettings(patch = {}) {
    const settings = cloneDefaults();
    for (const [agentId, values] of Object.entries(patch)) {
        Object.assign(settings.agents[agentId], values);
    }
    return settings;
}

function makeClient({
    ctx = {},
    settings = makeSettings(),
    log,
    transport,
    generateRaw,
    defaultTimeoutMs,
} = {}) {
    return createAgentClient({
        ctx,
        getSettings: () => settings,
        log,
        logger: silentLogger,
        transport,
        generateRaw,
        defaultTimeoutMs,
    });
}

function makeCtx({ profile, main, raw } = {}) {
    const calls = { profile: [], main: [], generateRaw: [] };
    const ctx = {};

    if (profile) {
        ctx.ConnectionManagerRequestService = {
            async sendRequest(...args) {
                calls.profile.push(args);
                if (typeof profile === 'function') {
                    return profile(...args);
                }
                return profile;
            },
        };
    }

    if (main) {
        ctx.ChatCompletionService = {
            async processRequest(...args) {
                calls.main.push(args);
                if (typeof main === 'function') {
                    return main(...args);
                }
                return main;
            },
        };
    }

    if (raw) {
        ctx.generateRaw = async (...args) => {
            calls.generateRaw.push(args);
            if (typeof raw === 'function') {
                return raw(...args);
            }
            return raw;
        };
    }

    return { ctx, calls };
}

function abortLike(message = 'aborted') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function hangingTransport({ signal }) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortLike());
            return;
        }
        signal.addEventListener(
            'abort',
            () => reject(abortLike('request aborted')),
            { once: true },
        );
    });
}

/* ------------------------------------------------------------------ */
/* 1. JSON extraction                                                  */
/* ------------------------------------------------------------------ */

test('extractJson handles plain, fenced, prose-wrapped, and escaped values', () => {
    assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
    assert.deepEqual(extractJson('[1,2,3]').value, [1, 2, 3]);

    const fencedJson = '```json\n{"a":"b"}\n```';
    assert.deepEqual(extractJson(fencedJson).value, { a: 'b' });

    const fencedPlain = '```\n[true,false]\n```';
    assert.deepEqual(extractJson(fencedPlain).value, [true, false]);

    const leadingProse = 'Here is the result you asked for:\n{"a":2}';
    assert.deepEqual(extractJson(leadingProse).value, { a: 2 });

    const trailingProse = '{"a":3} — hope that helps!';
    assert.deepEqual(extractJson(trailingProse).value, { a: 3 });

    const bracesInStrings = '{"text":"a { brace } and [ bracket ]","n":4}';
    assert.deepEqual(extractJson(bracesInStrings).value, {
        text: 'a { brace } and [ bracket ]',
        n: 4,
    });

    const escapedQuotes = String.raw`{"text":"she said \"hi\"","ok":true}`;
    assert.deepEqual(extractJson(escapedQuotes).value, {
        text: 'she said "hi"',
        ok: true,
    });

    assert.deepEqual(extractJson('{"first":1} {"second":2}').value, { first: 1 });
    assert.deepEqual(
        extractJson('noise {not valid} then the answer {"later":true}').value,
        { later: true },
    );

    assert.equal(extractJson('no json here').ok, false);
    assert.equal(extractJson('{"unclosed": true').ok, false);
    assert.equal(extractJson('').ok, false);
    assert.equal(extractJson(null).ok, false);
    assert.equal(extractJson(42).ok, false);
    assert.match(extractJson('garbage').error, /No balanced JSON/i);
});

test('collectCompletionText digs common response shapes', () => {
    assert.equal(collectCompletionText('plain'), 'plain');
    assert.equal(collectCompletionText({ content: 'top' }), 'top');
    assert.equal(collectCompletionText({ message: { content: 'message' } }), 'message');
    assert.equal(
        collectCompletionText({ choices: [{ message: { content: 'choice-message' } }] }),
        'choice-message',
    );
    assert.equal(collectCompletionText({ choices: [{ text: 'choice-text' }] }), 'choice-text');
    assert.equal(collectCompletionText({}), '');
    assert.equal(collectCompletionText(null), '');
    assert.equal(collectCompletionText({ content: { nested: true } }), '{"nested":true}');
});

/* ------------------------------------------------------------------ */
/* 2. Schema validation                                               */
/* ------------------------------------------------------------------ */

const testSchema = {
    $defs: {
        tag: { type: 'string', enum: ['alpha', 'beta'] },
    },
    type: 'object',
    required: ['name', 'age', 'tags'],
    properties: {
        name: { type: 'string', minLength: 2, maxLength: 5 },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        score: { type: 'number' },
        tags: {
            type: 'array',
            items: { $ref: '#/$defs/tag' },
            minItems: 1,
            maxItems: 3,
        },
        mode: { const: 'x' },
        note: { type: ['string', 'null'] },
        nested: {
            type: 'object',
            required: ['flag'],
            properties: { flag: { type: 'boolean' } },
            additionalProperties: false,
        },
        patternish: { type: 'string', pattern: '^[A-Z]+$' },
        choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        combined: { allOf: [{ type: 'string' }, { minLength: 3 }] },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    additionalProperties: false,
};

function validSchemaValue(extra = {}) {
    return {
        name: 'Ann',
        age: 30,
        score: 1.5,
        tags: ['alpha'],
        mode: 'x',
        note: null,
        nested: { flag: true },
        patternish: 'ABC',
        choice: 1,
        combined: 'abc',
        maybe: null,
        ...extra,
    };
}

test('validateJsonSchema accepts valid nested values and resolves $ref', () => {
    const result = validateJsonSchema(validSchemaValue(), testSchema);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
});

test('validateJsonSchema reports required, extra, type, and nested path errors', () => {
    const missing = validateJsonSchema({ age: 1, tags: ['alpha'] }, testSchema);
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((error) => error.path === '$.name' && /required/.test(error.message)));

    const extra = validateJsonSchema(validSchemaValue({ extra: true }), testSchema);
    assert.ok(extra.errors.some((error) => error.path === '$.extra' && /not allowed/.test(error.message)));

    const fractionalAge = validateJsonSchema(validSchemaValue({ age: 1.5 }), testSchema);
    assert.ok(fractionalAge.errors.some((error) => error.path === '$.age' && /integer/.test(error.message)));

    const badTag = validateJsonSchema(validSchemaValue({ tags: ['gamma'] }), testSchema);
    assert.ok(badTag.errors.some((error) => error.path === '$.tags[0]'));

    const shortName = validateJsonSchema(validSchemaValue({ name: 'A' }), testSchema);
    assert.ok(shortName.errors.some((error) => error.path === '$.name' && /at least 2/.test(error.message)));

    const nestedMissing = validateJsonSchema(
        validSchemaValue({ nested: {} }),
        testSchema,
    );
    assert.ok(nestedMissing.errors.some((error) => error.path === '$.nested.flag'));

    const nestedExtra = validateJsonSchema(
        validSchemaValue({ nested: { flag: true, extra: 1 } }),
        testSchema,
    );
    assert.ok(nestedExtra.errors.some((error) => error.path === '$.nested.extra'));

    const badPattern = validateJsonSchema(validSchemaValue({ patternish: 'abc' }), testSchema);
    assert.ok(badPattern.errors.some((error) => error.path === '$.patternish'));

    const badChoice = validateJsonSchema(validSchemaValue({ choice: true }), testSchema);
    assert.ok(badChoice.errors.some((error) => error.path === '$.choice'));

    const badCombined = validateJsonSchema(validSchemaValue({ combined: 'ab' }), testSchema);
    assert.ok(badCombined.errors.some((error) => error.path === '$.combined'));

    const badMaybe = validateJsonSchema(validSchemaValue({ maybe: 3 }), testSchema);
    assert.ok(badMaybe.errors.some((error) => error.path === '$.maybe'));
});

test('validateJsonSchema distinguishes integer/number and rejects non-finite numbers', () => {
    assert.equal(validateJsonSchema(3, { type: 'integer' }).ok, true);
    assert.equal(validateJsonSchema(3.2, { type: 'integer' }).ok, false);
    assert.equal(validateJsonSchema(3.2, { type: 'number' }).ok, true);
    assert.equal(validateJsonSchema(Number.NaN, { type: 'number' }).ok, false);
    assert.equal(validateJsonSchema(Number.POSITIVE_INFINITY, { type: 'number' }).ok, false);
    assert.equal(validateJsonSchema(null, { type: ['string', 'null'] }).ok, true);
    assert.equal(validateJsonSchema(null, { type: ['string', 'number'] }).ok, false);
});

test('validateJsonSchema turns malformed schemas into $schema errors instead of throwing', () => {
    const badType = validateJsonSchema({}, { type: 42 });
    assert.equal(badType.ok, false);
    assert.equal(badType.errors[0].path, '$schema');

    const badRequired = validateJsonSchema({}, { type: 'object', required: 'name' });
    assert.ok(badRequired.errors.some((error) => error.path === '$schema'));

    const badRef = validateJsonSchema({}, { $ref: '#/$defs/missing' });
    assert.ok(badRef.errors.some((error) => error.path === '$schema'));

    const badPattern = validateJsonSchema('x', { type: 'string', pattern: '[' });
    assert.ok(badPattern.errors.some((error) => error.path === '$schema'));
});

/* ------------------------------------------------------------------ */
/* 3. Routing                                                          */
/* ------------------------------------------------------------------ */

test('profile routing succeeds without touching generateRaw', async () => {
    const settings = makeSettings({
        architect: { connectionProfileId: 'profile-1', maxTokens: 777 },
    });
    const { ctx, calls } = makeCtx({
        profile: '{"via":"profile"}',
        raw: '{"via":"raw"}',
    });
    const client = makeClient({ ctx, settings });

    const result = await client.sendAgentRequest({
        agentId: 'architect',
        prompt: 'bootstrap the season',
    });

    assert.equal(result.route, 'profile');
    assert.deepEqual(result.value, { via: 'profile' });
    assert.equal(calls.profile.length, 1);
    assert.equal(calls.profile[0][0], 'profile-1');
    assert.equal(calls.profile[0][2], 777);
    assert.equal(calls.generateRaw.length, 0);
    client.dispose();
});

test('profile transport failure falls back to main, then generateRaw', async () => {
    const settings = makeSettings({
        architect: { connectionProfileId: 'profile-1', maxTokens: 300 },
    });

    const { ctx: mainCtx, calls: mainCalls } = makeCtx({
        profile: () => {
            throw new Error('profile down');
        },
        main: '{"via":"main"}',
        raw: '{"via":"raw"}',
    });
    const mainClient = makeClient({ ctx: mainCtx, settings });
    const mainResult = await mainClient.sendAgentRequest({
        agentId: 'architect',
        prompt: 'go',
    });
    assert.equal(mainResult.route, 'main');
    assert.deepEqual(mainResult.value, { via: 'main' });
    assert.equal(mainCalls.profile.length, 1);
    assert.equal(mainCalls.main.length, 1);
    assert.equal(mainCalls.generateRaw.length, 0);
    mainClient.dispose();

    const { ctx: rawCtx, calls: rawCalls } = makeCtx({
        profile: () => {
            throw new Error('profile down');
        },
        raw: '{"via":"raw"}',
    });
    const rawClient = makeClient({ ctx: rawCtx, settings });
    const rawResult = await rawClient.sendAgentRequest({
        agentId: 'architect',
        prompt: 'go',
    });
    assert.equal(rawResult.route, 'generateRaw');
    assert.deepEqual(rawResult.value, { via: 'raw' });
    assert.equal(rawCalls.profile.length, 1);
    assert.equal(rawCalls.generateRaw.length, 1);
    assert.equal(rawCalls.generateRaw[0][0].trimNames, false);
    assert.equal(rawCalls.generateRaw[0][0].bypassAll, true);
    rawClient.dispose();
});

test('no available route and disabled agents throw AgentTransportError', async () => {
    const noRouteClient = makeClient({ ctx: {}, settings: makeSettings() });
    await assert.rejects(
        noRouteClient.sendAgentRequest({ agentId: 'architect', prompt: 'x' }),
        (error) => error instanceof AgentTransportError && /No agent transport/.test(error.message),
    );
    noRouteClient.dispose();

    let transportCalls = 0;
    const disabledClient = makeClient({
        settings: makeSettings({ architect: { enabled: false } }),
        transport: async () => {
            transportCalls += 1;
            return '{"never":true}';
        },
    });
    await assert.rejects(
        disabledClient.sendAgentRequest({ agentId: 'architect', prompt: 'x' }),
        (error) => error instanceof AgentTransportError && /disabled/.test(error.message),
    );
    assert.equal(transportCalls, 0);
    disabledClient.dispose();
});

/* ------------------------------------------------------------------ */
/* 4. Repair                                                           */
/* ------------------------------------------------------------------ */

test('invalid JSON triggers exactly one repair and reports repaired', async () => {
    let calls = 0;
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: async () => {
            calls += 1;
            return calls === 1 ? 'not json at all' : '{"ok":true}';
        },
    });

    const result = await client.sendAgentRequest({
        agentId: 'architect',
        prompt: 'respond',
    });

    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(log.entries().at(-1).status, 'repaired');
    client.dispose();
});

test('two invalid responses fail cleanly after exactly two calls', async () => {
    let calls = 0;
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: async () => {
            calls += 1;
            return 'still not json';
        },
    });

    await assert.rejects(
        client.sendAgentRequest({ agentId: 'architect', prompt: 'respond' }),
        (error) => {
            assert.ok(error instanceof AgentResponseError);
            assert.equal(error.attempts, 2);
            assert.equal(error.rawResponses.length, 2);
            assert.equal(error.attemptErrors.length, 2);
            return true;
        },
    );

    assert.equal(calls, 2);
    assert.equal(log.entries().at(-1).status, 'failed');
    client.dispose();
});

test('empty responses count as invalid and receive one repair attempt', async () => {
    let calls = 0;
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: async () => {
            calls += 1;
            return calls === 1 ? '' : '{"ok":true}';
        },
    });

    const result = await client.sendAgentRequest({
        agentId: 'architect',
        prompt: 'respond',
    });

    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(log.entries().at(-1).status, 'repaired');
    client.dispose();
});

test('schema validation failures repair on the same route instead of falling through', async () => {
    const settings = makeSettings({
        architect: { connectionProfileId: 'profile-1' },
    });
    const { ctx, calls } = makeCtx({
        profile: '{"count":"not-an-integer"}',
        main: '{"count":3}',
    });
    const log = createAgentLog();
    const client = makeClient({ ctx, settings, log });

    const schema = {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
    };

    await assert.rejects(
        client.sendAgentRequest({ agentId: 'architect', prompt: 'go', schema }),
        (error) => error instanceof AgentResponseError && error.attempts === 2,
    );

    assert.equal(calls.profile.length, 2);
    assert.equal(calls.main.length, 0);
    assert.equal(log.entries().at(-1).status, 'failed');
    client.dispose();
});

test('schema-invalid JSON also triggers a repair with validation errors', async () => {
    const messagesSeen = [];
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: async ({ messages }) => {
            messagesSeen.push(messages);
            return messagesSeen.length === 1 ? '{"count":"nope"}' : '{"count":3}';
        },
    });

    const schema = {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
        additionalProperties: false,
    };

    const result = await client.sendAgentRequest({
        agentId: 'storyline',
        prompt: 'produce an update',
        schema,
    });

    assert.equal(result.attempts, 2);
    assert.deepEqual(result.value, { count: 3 });
    assert.equal(messagesSeen.length, 2);
    assert.match(messagesSeen[1][0].content, /JSON/i);
    assert.match(messagesSeen[1][1].content, /\$\.count/);
    assert.equal(log.entries().at(-1).status, 'repaired');
    client.dispose();
});

/* ------------------------------------------------------------------ */
/* 5. Abort and chat affinity                                          */
/* ------------------------------------------------------------------ */

test('chat change mid-request aborts the transport and logs aborted', async () => {
    let chatId = 'chat-a';
    const affinity = createChatAffinity({ getChatId: () => chatId });
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: hangingTransport,
        defaultTimeoutMs: 5000,
    });
    const runner = createAgentRunner({
        client,
        affinity,
        log,
        logger: silentLogger,
    });

    const pending = runner.runAgent({
        agentId: 'architect',
        prompt: 'long request',
    });

    await delay(5);
    chatId = 'chat-b';
    affinity.setChatId('chat-b');

    await assert.rejects(pending, (error) => error instanceof AgentAbortedError);

    const entries = log.entries();
    assert.ok(entries.some((entry) => entry.status === 'aborted'));
    assert.equal(entries.at(-1).status, 'aborted');
    runner.dispose();
    client.dispose();
});

test('chat affinity emits only real changes and detects stale tokens', () => {
    let chatId = 'one';
    const events = [];
    const affinity = createChatAffinity({ getChatId: () => chatId });
    const unsubscribe = affinity.onChange((event) => events.push(event));

    assert.equal(affinity.current(), 'one');
    assert.deepEqual(affinity.setChatId('one'), { changed: false });
    assert.equal(events.length, 0);

    chatId = 'two';
    assert.deepEqual(affinity.setChatId('two'), { changed: true });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { previousChatId: 'one', chatId: 'two' });

    const token = affinity.begin();
    assert.equal(token.chatId, 'two');
    assert.equal(affinity.isCurrent(token), true);

    chatId = 'three';
    affinity.setChatId('three');
    assert.equal(affinity.isCurrent(token), false);
    assert.throws(
        () => affinity.assertCurrent(token),
        (error) => error instanceof ChatChangedError && /two/.test(error.message) && /three/.test(error.message),
    );

    unsubscribe();
    affinity.setChatId('four');
    assert.equal(events.length, 2, 'unsubscribed listeners must not fire');

    assert.equal(affinity.setChatId(null).changed, true);
    assert.equal(affinity.current(), null);
    assert.equal(affinity.setChatId(undefined).changed, false);
    affinity.dispose();
});

/* ------------------------------------------------------------------ */
/* 6. Timeout                                                          */
/* ------------------------------------------------------------------ */

test('client defaultTimeoutMs is honored when no agent timeout is configured', async () => {
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: hangingTransport,
        defaultTimeoutMs: 10,
    });

    await assert.rejects(
        client.sendAgentRequest({
            agentId: 'architect',
            prompt: 'slow default',
        }),
        (error) => error instanceof AgentAbortedError && /timed out/i.test(error.message),
    );
    client.dispose();
});

test('timeout aborts a pending request with a timed-out AgentAbortedError', async () => {
    const log = createAgentLog();
    const client = makeClient({
        log,
        transport: hangingTransport,
        defaultTimeoutMs: 5000,
    });

    await assert.rejects(
        client.sendAgentRequest({
            agentId: 'architect',
            prompt: 'slow',
            timeoutMs: 10,
        }),
        (error) => {
            assert.ok(error instanceof AgentAbortedError);
            assert.equal(error.timedOut, true);
            assert.match(error.message, /timed out/i);
            return true;
        },
    );

    assert.equal(log.entries().at(-1).status, 'aborted');
    client.dispose();
});

/* ------------------------------------------------------------------ */
/* 7. Prompt/config helpers                                            */
/* ------------------------------------------------------------------ */

test('resolveAgentConfig applies overrides > settings > defaults', () => {
    const settings = {
        agents: {
            architect: {
                enabled: false,
                prompt: 'custom architect prompt',
                model: 'model-from-settings',
                temperature: 0.9,
                maxTokens: 321,
                timeoutMs: 4321,
                connectionProfileId: 'profile-from-settings',
            },
        },
    };

    const resolved = resolveAgentConfig(settings, 'architect', {
        temperature: 0.1,
        maxTokens: 42,
    });
    assert.equal(resolved.temperature, 0.1);
    assert.equal(resolved.maxTokens, 42);
    assert.equal(resolved.timeoutMs, 4321);
    assert.equal(resolved.model, 'model-from-settings');
    assert.equal(resolved.connectionProfileId, 'profile-from-settings');
    assert.equal(resolved.systemPrompt, 'custom architect prompt');
    assert.equal(resolved.enabled, false);

    const defaults = resolveAgentConfig({}, 'choices', {});
    assert.equal(defaults.temperature, 0.4);
    assert.equal(defaults.maxTokens, 1200);
    assert.equal(defaults.timeoutMs, 60000);
    assert.equal(defaults.systemPrompt, DEFAULT_AGENT_PROMPTS.choices);

    assert.throws(
        () => resolveAgentConfig({}, 'not-an-agent', {}),
        /Unknown agent id/,
    );

    assert.deepEqual(
        Object.keys(DEFAULT_AGENT_PROMPTS).sort(),
        [...AGENT_IDS].sort(),
    );
    for (const agentId of AGENT_IDS) {
        assert.match(DEFAULT_AGENT_PROMPTS[agentId], /read-only/i, `${agentId} must state read-only`);
    }
    assert.match(AGENT_JSON_CONTRACT, /exactly one JSON value/i);
    assert.match(DEFAULT_REPAIR_PROMPT, /corrected JSON/i);
});

test('prompt templates preserve unknown placeholders and build valid messages', () => {
    assert.equal(
        renderPromptTemplate('Hello {{name}} and {{missing}}', { name: 'A' }),
        'Hello A and {{missing}}',
    );
    assert.throws(() => renderPromptTemplate(42, {}), TypeError);

    const systemPrompt = buildSystemPrompt({
        agentId: 'architect',
        settings: {},
        schema: { type: 'object', required: ['placements'] },
    });
    assert.match(systemPrompt, /Neo Terra Architect/);
    assert.match(systemPrompt, /exactly one JSON value/i);
    assert.match(systemPrompt, /"placements"/);

    const repairSystem = buildRepairSystemPrompt({
        agentId: 'architect',
        settings: {},
        schema: { type: 'object' },
    });
    assert.match(repairSystem, /Repair it now/);

    const repairUser = buildRepairUserPrompt({
        originalPrompt: 'do the task',
        rawResponse: 'bad output',
        errors: [{ path: '$.x', message: 'is required' }],
        schema: { type: 'object' },
    });
    assert.match(repairUser, /do the task/);
    assert.match(repairUser, /bad output/);
    assert.match(repairUser, /\$\.x: is required/);

    assert.deepEqual(
        buildMessages({ systemPrompt: 'sys', userPrompt: 'usr' }),
        [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'usr' },
        ],
    );
});

/* ------------------------------------------------------------------ */
/* 8. Agent log                                                        */
/* ------------------------------------------------------------------ */

test('agent log supports begin/update/finish, truncation, and entry caps', () => {
    const log = createAgentLog({ maxEntries: 3 });
    const entry = log.begin({ agentId: 'architect', request: 'hello', route: null });
    assert.equal(entry.status, 'running');
    assert.ok(entry.id);

    log.update(entry.id, { route: 'profile', attempts: 1 });
    const finished = log.finish(entry.id, {
        status: 'ok',
        response: 'done',
        attempts: 1,
        route: 'profile',
        durationMs: 12,
    });
    assert.equal(finished.status, 'ok');
    assert.equal(finished.response, 'done');
    assert.equal(log.get(entry.id).durationMs, 12);
    assert.throws(
        () => log.finish(entry.id, { status: 'bogus' }),
        /Unknown agent log status/,
    );
    assert.equal(log.get(entry.id).status, 'ok');

    const longRequest = log.begin({
        agentId: 'lore',
        request: 'x'.repeat(25000),
    });
    assert.equal(log.get(longRequest.id).request.length, 20000);
    log.update(longRequest.id, { response: 'y'.repeat(25000) });
    assert.equal(log.get(longRequest.id).response.length, 20000);

    log.begin({ agentId: 'choices' });
    log.begin({ agentId: 'badEnd' });
    log.begin({ agentId: 'epilogue' });
    const entries = log.entries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].agentId, 'choices');
    assert.equal(entries.at(-1).agentId, 'epilogue');

    log.clear();
    assert.deepEqual(log.entries(), []);
    log.dispose();
});

test('agent log subscribers are isolated from listener exceptions', () => {
    const log = createAgentLog();
    let calls = 0;
    const unsubscribe = log.subscribe(() => {
        calls += 1;
    });
    log.subscribe(() => {
        throw new Error('listener boom');
    });

    assert.doesNotThrow(() => log.begin({ agentId: 'architect' }));
    assert.equal(calls, 1);

    unsubscribe();
    log.begin({ agentId: 'lore' });
    assert.equal(calls, 1);
    log.dispose();
});

test('agent log renders safely only with an explicit DOM document', () => {
    assert.ok(agentLog);
    assert.throws(
        () => renderAgentLog({}, { document: undefined }),
        /DOM document/,
    );
    assert.throws(
        () => mountAgentLog({}, { document: undefined }),
        /DOM document/,
    );
});

/* ------------------------------------------------------------------ */
/* 9. Sequential runner                                                */
/* ------------------------------------------------------------------ */

test('runAgents preserves order and stops on the first error', async () => {
    const seen = [];
    let failAt = null;
    const client = {
        async sendAgentRequest({ agentId }) {
            seen.push(agentId);
            await delay(1);
            if (agentId === failAt) {
                throw new Error('runner boom');
            }
            return {
                value: { agentId },
                raw: '{}',
                attempts: 1,
                route: 'transport',
                agentId,
                durationMs: 1,
            };
        },
    };
    const affinity = createChatAffinity({ getChatId: () => 'chat-sequence' });
    const runner = createAgentRunner({
        client,
        affinity,
        log: createAgentLog(),
        logger: silentLogger,
    });

    const results = await runner.runAgents([
        { agentId: 'architect', prompt: 'a' },
        { agentId: 'lore', prompt: 'b' },
    ]);
    assert.deepEqual(seen, ['architect', 'lore']);
    assert.deepEqual(results.map((result) => result.value.agentId), ['architect', 'lore']);
    assert.equal(runner.activeChatId(), 'chat-sequence');

    seen.length = 0;
    failAt = 'lore';
    await assert.rejects(
        runner.runAgents([
            { agentId: 'architect', prompt: 'a' },
            { agentId: 'lore', prompt: 'b' },
            { agentId: 'choices', prompt: 'c' },
        ]),
        /runner boom/,
    );
    assert.deepEqual(seen, ['architect', 'lore']);
    runner.dispose();
    affinity.dispose();
});

/* ------------------------------------------------------------------ */
/* 10. Safety and plain values                                         */
/* ------------------------------------------------------------------ */

test('agent modules do not import state and return plain parsed values', async () => {
    const files = [
        '../src/agents/client.js',
        '../src/agents/runner.js',
        '../src/agents/prompts.js',
        '../src/core/chat-affinity.js',
        '../src/ui/agent-log.js',
    ];

    for (const file of files) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /from\s+['"][^'"]*\/state\//);
        assert.doesNotMatch(source, /world-state|applyWorldEvent|appendWorldEvents/);
    }

    const client = makeClient({
        transport: async () => '{"plain":true,"list":[1,2]}',
    });
    const result = await client.sendAgentRequest({
        agentId: 'architect',
        prompt: 'plain value',
    });

    assert.deepEqual(result.value, { plain: true, list: [1, 2] });
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
    assert.equal(result.attempts, 1);
    client.dispose();
});

test('agent client requests are asynchronous and do not block the caller', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const client = makeClient({
        transport: async () => {
            await gate;
            return '{"ok":true}';
        },
    });

    const pending = client.sendAgentRequest({ agentId: 'architect', prompt: 'x' });
    const first = await Promise.race([
        pending.then(() => 'request'),
        Promise.resolve().then(() => 'caller'),
    ]);
    assert.equal(first, 'caller');

    release();
    const result = await pending;
    assert.deepEqual(result.value, { ok: true });
    client.dispose();
});
