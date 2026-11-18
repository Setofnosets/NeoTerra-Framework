import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CHOICES_SCHEMA,
    COMBAT_ACTIONS,
    COMBAT_RISK_TIERS,
    buildChoicesPrompt,
    choicesCacheKey,
    createChoicesAgent,
    normalizeChoicesResult,
    resolveChoiceTheme,
    shouldGenerateChoices,
} from '../src/agents/choices.js';
import { validateJsonSchema } from '../src/agents/client.js';
import {
    createChoicesController,
    renderChoicesMarkup,
} from '../src/ui/choices.js';
import { cloneDefaults } from '../src/core/defaults.js';

function settingsFor(overrides = {}) {
    const settings = cloneDefaults();
    settings.cyoa.enabled = true;
    return Object.assign(settings, overrides);
}

function resultWith(labels, extra = {}) {
    return {
        choices: labels.map((label) => ({ label })),
        rationale: '',
        ...extra,
    };
}

function assistantMessage(text = 'The scene waits.') {
    return { is_user: false, mes: text };
}

test('disabled CYOA makes no agent calls and renders no chips', async () => {
    const settings = cloneDefaults();
    let calls = 0;
    const agent = createChoicesAgent({
        runner: {
            runAgent: async () => {
                calls += 1;
                return { value: resultWith(['A', 'B', 'C', 'D']) };
            },
        },
    });
    const result = await agent.run({
        state: { ending: { status: 'none' } },
        settings,
        lastMessage: assistantMessage(),
    });
    assert.equal(result.enabled, false);
    assert.equal(result.choices.length, 0);
    assert.equal(calls, 0);
    assert.equal(renderChoicesMarkup({ visible: false, choices: [] }), '');
});

test('normalization returns the default four choices and truncates labels to 100 characters', () => {
    const settings = settingsFor();
    const longLabel = 'x'.repeat(150);
    const normalized = normalizeChoicesResult({
        result: resultWith([longLabel, 'Talk to the guard', 'Search the office', 'Leave']),
        settings,
        state: { playerRole: 'hero' },
    });
    assert.equal(normalized.count, 4);
    assert.equal(normalized.visible, true);
    assert.equal(normalized.choices[0].label.length, 100);
    assert.equal(normalized.truncated, true);
    assert.equal(normalized.choices[0].label, 'x'.repeat(100));
});

test('malformed output hides the row instead of throwing', () => {
    const settings = settingsFor();
    for (const result of [null, {}, { choices: 'nope' }, { choices: [{ label: '' }] }]) {
        const normalized = normalizeChoicesResult({ result, settings });
        assert.equal(normalized.visible, false);
        assert.equal(normalized.choices.length, 0);
    }
});

test('the choices schema accepts the normalized shape and rejects malformed labels', () => {
    const valid = resultWith(['Strike', 'Defend', 'Retreat', 'Talk']);
    assert.equal(validateJsonSchema(valid, CHOICES_SCHEMA).ok, true);
    assert.equal(validateJsonSchema({ choices: [{ label: '' }], rationale: '' }, CHOICES_SCHEMA).ok, false);
});

test('auto theme derives villainous tone from the player role and S1Dark', () => {
    const settings = settingsFor();
    assert.equal(resolveChoiceTheme({
        settings,
        state: { playerRole: 'villain', player: {} },
        season: { toneNotes: 'Cyberpunk melodrama' },
    }), 'villainous');
    assert.equal(resolveChoiceTheme({
        settings,
        state: { playerRole: 'hero', player: {} },
        season: { toneNotes: 'Cyberpunk melodrama' },
    }), 'heroic');
    assert.equal(resolveChoiceTheme({
        settings,
        state: { meta: { inCombat: true }, scene: { combat: {} } },
        season: null,
        mode: 'combat',
    }), 'tactical');
});

test('strict content gate removes explicit choices', () => {
    const settings = settingsFor();
    settings.contentGate = 'strict';
    const normalized = normalizeChoicesResult({
        result: resultWith([
            'Have explicit sex with her',
            'Attack the guard',
            'Search the office',
            'Ask about the beast program',
        ]),
        settings,
    });
    // The strict gate strips the explicit sentence; the option is dropped.
    assert.equal(normalized.choices.length, 3);
    assert.equal(normalized.visible, true);
    assert.ok(normalized.rejected.some((entry) => entry.reason === 'content-gate'));
});

test('guards require an assistant message, idle generation, and no ending screen', () => {
    const settings = settingsFor();
    assert.equal(shouldGenerateChoices({
        settings,
        state: { ending: { status: 'none' } },
        lastMessage: { is_user: true },
    }).reason, 'no-assistant-message');
    assert.equal(shouldGenerateChoices({
        settings,
        state: { ending: { status: 'none' } },
        lastMessage: assistantMessage(),
        generationActive: true,
    }).reason, 'generation-active');
    assert.equal(shouldGenerateChoices({
        settings,
        state: { ending: { status: 'epilogue' } },
        lastMessage: assistantMessage(),
    }).reason, 'ending');
    assert.equal(shouldGenerateChoices({
        settings,
        state: { ending: { status: 'none' } },
        lastMessage: assistantMessage(),
        afterChoice: true,
    }).reason, 'after-choice');
});

test('the controller sends exactly once and never requests again after a click', async () => {
    let calls = 0;
    let sent = null;
    const agent = {
        run: async () => {
            calls += 1;
            return normalizeChoicesResult({
                result: resultWith(['Strike', 'Defend', 'Retreat', 'Talk']),
                settings: settingsFor(),
                state: { ending: { status: 'none' } },
                count: 4,
            });
        },
    };
    let now = 0;
    const controller = createChoicesController({
        agent,
        getState: () => ({ chatId: 'chat-1', ending: { status: 'none' } }),
        getSettings: () => settingsFor(),
        onSend: (label) => { sent = label; },
        now: () => now,
    });
    const messages = [assistantMessage()];
    const view = await controller.request({ messages, messageIndex: 2, swipeId: 0 });
    assert.equal(view.visible, true);
    assert.equal(calls, 1);
    assert.equal(controller.getView().choices.length, 4);

    assert.equal(controller.choose(1), true);
    assert.equal(sent, 'Defend');
    assert.equal(controller.choose(2), false);
    assert.equal(sent, 'Defend');

    now = 1000;
    const second = await controller.request({ messages, messageIndex: 2, swipeId: 0 });
    assert.equal(second.visible, false);
    assert.equal(second.reason, 'after-choice');
    assert.equal(calls, 1);
});

test('choices are cached per message and per swipe, and regenerate asks again', async () => {
    let calls = 0;
    const agent = {
        run: async () => {
            calls += 1;
            return normalizeChoicesResult({
                result: resultWith([`Choice ${calls}A`, `Choice ${calls}B`, `Choice ${calls}C`, `Choice ${calls}D`]),
                settings: settingsFor(),
                state: { ending: { status: 'none' } },
                count: 4,
            });
        },
    };
    const controller = createChoicesController({
        agent,
        getState: () => ({ chatId: 'chat-cache', ending: { status: 'none' } }),
        getSettings: () => settingsFor(),
    });
    const messages = [assistantMessage()];
    await controller.request({ messages, messageIndex: 1, swipeId: 0 });
    await controller.request({ messages, messageIndex: 1, swipeId: 0 });
    assert.equal(calls, 1);
    await controller.request({ messages, messageIndex: 1, swipeId: 1 });
    assert.equal(calls, 2);
    await controller.regenerate();
    assert.equal(calls, 3);
    assert.notEqual(controller.getView().choices[0].label, 'Choice 2A');
});

test('ending suppression survives a cached swipe', async () => {
    let calls = 0;
    let ending = false;
    const agent = {
        run: async () => {
            calls += 1;
            return normalizeChoicesResult({
                result: resultWith(['A', 'B', 'C', 'D']),
                settings: settingsFor(),
                state: { ending: { status: 'none' } },
            });
        },
    };
    const controller = createChoicesController({
        agent,
        getState: () => ({ chatId: 'chat-ending', ending: { status: ending ? 'epilogue' : 'none' } }),
        getSettings: () => settingsFor(),
    });
    const messages = [assistantMessage()];
    await controller.request({ messages, messageIndex: 1, swipeId: 0 });
    ending = true;
    const view = await controller.request({ messages, messageIndex: 1, swipeId: 0 });
    assert.equal(view.visible, false);
    assert.equal(view.reason, 'ending');
    assert.equal(calls, 1);
});

test('combat choices are an independent setting with tactical vocabulary and risk tiers', async () => {
    const settings = settingsFor();
    settings.cyoa.enabled = false;
    settings.cyoa.combatChoices.enabled = true;
    let calls = 0;
    const agent = {
        run: async () => {
            calls += 1;
            return normalizeChoicesResult({
                result: {
                    choices: [
                        { label: 'Strike the guard', action: 'strike', risk: 'high' },
                        { label: 'Guard up', action: 'defend', risk: 'low' },
                        { label: 'Run for the door', action: 'retreat', risk: 'moderate' },
                        { label: 'Talk them down', action: 'talk-down', risk: 'low' },
                    ],
                    rationale: '',
                },
                settings,
                mode: 'combat',
                state: { meta: { inCombat: true }, scene: { combat: {} } },
            });
        },
    };
    const controller = createChoicesController({
        agent,
        getState: () => ({
            chatId: 'chat-combat',
            ending: { status: 'none' },
            meta: { inCombat: true },
            scene: { combat: { participants: [] } },
        }),
        getSettings: () => settings,
    });
    const view = await controller.request({
        messages: [assistantMessage()],
        messageIndex: 1,
        swipeId: 0,
    });
    assert.equal(view.mode, 'combat');
    assert.equal(view.visible, true);
    assert.equal(calls, 1);
    assert.ok(view.choices.every((choice) => COMBAT_ACTIONS.includes(choice.action)));
    assert.ok(view.choices.every((choice) => COMBAT_RISK_TIERS.includes(choice.risk)));
    const markup = renderChoicesMarkup(view);
    assert.match(markup, /data-neoterra-choice-index/);
    assert.match(markup, /high/);
});

test('tactical choices outside combat are suppressed when exploration CYOA is off', async () => {
    const settings = settingsFor();
    settings.cyoa.enabled = false;
    settings.cyoa.combatChoices.enabled = true;
    let calls = 0;
    const agent = {
        run: async () => {
            calls += 1;
            return normalizeChoicesResult({ result: resultWith(['A', 'B', 'C', 'D']), settings });
        },
    };
    const controller = createChoicesController({
        agent,
        getState: () => ({ chatId: 'chat-combat-off', ending: { status: 'none' }, scene: {} }),
        getSettings: () => settings,
    });
    const view = await controller.request({ messages: [assistantMessage()], messageIndex: 1 });
    assert.equal(view.visible, false);
    assert.equal(view.reason, 'disabled');
    assert.equal(calls, 0);
});

test('invalid combat actions and unknown risk tiers are dropped, never sent', () => {
    const settings = settingsFor();
    const normalized = normalizeChoicesResult({
        result: {
            choices: [
                { label: 'Cast a spell', action: 'cast-magic', risk: 'low' },
                { label: 'Strike', action: 'strike', risk: 'nonsense' },
                { label: 'Defend', action: 'defend', risk: 'low' },
                { label: 'Retreat', action: 'retreat', risk: 'moderate' },
            ],
            rationale: '',
        },
        settings,
        mode: 'combat',
        state: { meta: { inCombat: true }, scene: { combat: {} } },
    });
    assert.equal(normalized.choices.length, 2);
    assert.ok(normalized.choices.every((choice) => ['defend', 'retreat'].includes(choice.action)));
    assert.ok(normalized.rejected.some((entry) => entry.reason.startsWith('unknown-combat-action')));
    assert.ok(normalized.rejected.some((entry) => entry.reason.startsWith('unknown-risk-tier')));
});

test('the prompt carries the label limit, combat actions, and risk tiers', () => {
    const state = {
        meta: { turn: 7, inCombat: true },
        scene: { combat: { participants: [] }, present: [] },
        playerRole: 'hero',
    };
    const prompt = buildChoicesPrompt({
        state,
        settings: settingsFor(),
        mode: 'combat',
        count: 4,
        maxLabelLength: 80,
    });
    assert.match(prompt, /at most 80 characters/);
    for (const action of COMBAT_ACTIONS) {
        assert.match(prompt, new RegExp(action.replace('-', '\\-')));
    }
    for (const tier of COMBAT_RISK_TIERS) {
        assert.match(prompt, new RegExp(tier));
    }
    assert.match(prompt, /Return exactly 4 choices/);
});

test('cache keys separate messages, swipes, modes, and regenerate runs', () => {
    assert.notEqual(
        choicesCacheKey({ messageIndex: 1, swipeId: 0 }),
        choicesCacheKey({ messageIndex: 1, swipeId: 1 }),
    );
    assert.notEqual(
        choicesCacheKey({ messageIndex: 1, swipeId: 0, mode: 'combat' }),
        choicesCacheKey({ messageIndex: 1, swipeId: 0, mode: 'exploration' }),
    );
    assert.notEqual(
        choicesCacheKey({ messageIndex: 1, swipeId: 0, regenerate: 1 }),
        choicesCacheKey({ messageIndex: 1, swipeId: 0, regenerate: 2 }),
    );
});

test('a scene frame posted after travel can trigger choices without MESSAGE_RECEIVED', async () => {
    const settings = settingsFor();
    let calls = 0;
    const agent = {
        run: async ({ state }) => {
            calls += 1;
            return normalizeChoicesResult({
                result: resultWith(['Head inside', 'Ask around', 'Keep walking', 'Check the map']),
                settings,
                state,
                count: 4,
            });
        },
    };
    const controller = createChoicesController({
        agent,
        getState: () => ({
            chatId: 'chat-travel',
            ending: { status: 'none' },
            meta: { turn: 3 },
            scene: { present: [] },
        }),
        getSettings: () => settings,
    });
    // The arrival frame is an ordinary assistant message (neither user nor
    // system), so the guard must allow CYOA for its new index.
    const sceneFrame = {
        name: 'Neo Terra',
        is_user: false,
        is_system: false,
        mes: 'Location changed: Central Plaza → Maple Heights\n\nYou arrive.',
        extra: { neoterra: { scene: { kind: 'travel', key: 'travel:chat-travel:central-plaza:maple-heights:3' } } },
    };
    const messages = [assistantMessage('You set out.'), sceneFrame];
    const view = await controller.request({ messages, messageIndex: 1, swipeId: 0 });
    assert.equal(view.visible, true);
    assert.equal(view.choices.length, 4);
    assert.equal(calls, 1);
});

test('the agent hides the row when the model fails', async () => {
    const agent = createChoicesAgent({
        runner: {
            runAgent: async () => {
                throw new Error('model down');
            },
        },
    });
    const result = await agent.run({
        state: { ending: { status: 'none' }, meta: {}, scene: {} },
        settings: settingsFor(),
        lastMessage: assistantMessage(),
    });
    assert.equal(result.visible, false);
    assert.equal(result.choices.length, 0);
    assert.equal(result.reason, 'agent-failed');
});
