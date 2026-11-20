import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SCHEMA_VERSION, SETTINGS_KEY } from '../src/core/constants.js';
import { DEFAULT_SETTINGS, cloneDefaults } from '../src/core/defaults.js';
import { migrateSettings, needsMigration } from '../src/core/migrations.js';
import { resolveWorldContext } from '../src/ui/settings.js';
import {
    getByPath,
    getSettings,
    isFreshInstall,
    resetSettings,
    saveSettings,
    setByPath,
    setSetting,
} from '../src/core/settings.js';

function mockContext(initial = undefined) {
    const calls = { saves: 0 };
    const ctx = {
        extensionSettings: {},
        saveSettingsDebounced: () => {
            calls.saves += 1;
        },
    };
    if (initial !== undefined) {
        ctx.extensionSettings[SETTINGS_KEY] = initial;
    }
    return { ctx, calls };
}

test('world actions resolve the live context instead of a mount snapshot', () => {
    const previous = globalThis.SillyTavern;
    const live = { chatId: 'live-chat', chatMetadata: { neoterra: {} } };
    const stale = { chatId: 'stale-chat', chatMetadata: { neoterra: {} } };
    try {
        globalThis.SillyTavern = { getContext: () => live };
        assert.equal(resolveWorldContext(stale), live);

        delete globalThis.SillyTavern;
        assert.equal(resolveWorldContext(stale), stale);
        assert.equal(resolveWorldContext(undefined), null);
    } finally {
        if (previous === undefined) {
            delete globalThis.SillyTavern;
        } else {
            globalThis.SillyTavern = previous;
        }
    }
});

test('defaults match the plan and are frozen', () => {
    assert.equal(DEFAULT_SETTINGS.schemaVersion, SCHEMA_VERSION);
    assert.equal(DEFAULT_SETTINGS.contentGate, 'full');
    assert.equal(DEFAULT_SETTINGS.castMode, 'director');
    assert.equal(DEFAULT_SETTINGS.beatDeadlinePressure, 'standard');

    assert.equal(DEFAULT_SETTINGS.cyoa.enabled, false);
    assert.equal(DEFAULT_SETTINGS.cyoa.count, 4);
    assert.equal(DEFAULT_SETTINGS.cyoa.theme, 'auto');
    assert.equal(DEFAULT_SETTINGS.cyoa.maxLabelLength, 100);
    assert.equal(DEFAULT_SETTINGS.cyoa.combatChoices.enabled, false);
    assert.equal(DEFAULT_SETTINGS.cyoa.combatChoices.theme, 'tactical');

    assert.equal(DEFAULT_SETTINGS.badEnds.enabled, false);
    assert.equal(DEFAULT_SETTINGS.badEnds.allowDeadContinuation, false);
    assert.match(DEFAULT_SETTINGS.badEnds.prompt, /never infer a bad end from prose alone/i);

    assert.equal(DEFAULT_SETTINGS.agents.storyline.everyNTurns, 6);
    assert.equal(DEFAULT_SETTINGS.agents.lore.everyNTurns, 10);
    assert.ok(DEFAULT_SETTINGS.tokenBudget.total > 0);

    // A successful travel closes the map shell and reveals the chat.
    assert.equal(DEFAULT_SETTINGS.map.closeOnTravel, true);
    // Arrival cues ship on; disabling them is the rollback switch.
    assert.equal(DEFAULT_SETTINGS.map.arrivalFeedback, true);

    assert.equal(DEFAULT_SETTINGS.clock.enabled, true);
    assert.equal(DEFAULT_SETTINGS.clock.slotsPerDay, 5);
    assert.equal(DEFAULT_SETTINGS.clock.timeOfDayStart, 'evening');
    assert.deepEqual(
        { ...DEFAULT_SETTINGS.clock.autoHold },
        { combat: true, encounter: false, beat: false },
    );

    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS.cyoa));
    assert.equal(DEFAULT_SETTINGS.worldTick.enabled, true);
    assert.equal(DEFAULT_SETTINGS.worldTick.allowNpcMovesDuringCombat, false);

    const copy = cloneDefaults();
    copy.cyoa.count = 2;
    assert.equal(DEFAULT_SETTINGS.cyoa.count, 4, 'cloneDefaults must not expose the shared default');
});

test('map.closeOnTravel round-trips through save and read', () => {
    const { ctx, calls } = mockContext();
    assert.equal(getSettings(ctx).map.closeOnTravel, true, 'defaults to on');

    saveSettings(ctx, {
        ...getSettings(ctx),
        map: { ...getSettings(ctx).map, closeOnTravel: false },
    });
    assert.equal(getSettings(ctx).map.closeOnTravel, false);
    assert.equal(calls.saves >= 2, true);

    // Legacy settings without the key are filled from the default.
    const legacy = { schemaVersion: SCHEMA_VERSION, map: { showFogOfWar: true } };
    const migrated = migrateSettings(legacy);
    assert.equal(migrated.map.closeOnTravel, true);
    assert.equal(migrated.map.showFogOfWar, true);

    // A persisted non-boolean must not reach the shell: it reads with
    // `!== false`, so a string "false" would keep the auto-close on.
    const malformed = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        map: { closeOnTravel: 'false', showFogOfWar: true },
    });
    assert.equal(malformed.map.closeOnTravel, true);
    assert.equal(malformed.map.showFogOfWar, true);

    const explicit = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        map: { closeOnTravel: false },
    });
    assert.equal(explicit.map.closeOnTravel, false);

    // The Play-as card instruction defaults on, is a boolean, and the
    // normalizer preserves unknown identity keys for forward compatibility.
    assert.equal(migrateSettings({ schemaVersion: SCHEMA_VERSION }).identity.cardInstruction, true);
    const identityOff = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        identity: { cardInstruction: false, futureKey: 'kept' },
    });
    assert.equal(identityOff.identity.cardInstruction, false);
    assert.equal(identityOff.identity.futureKey, 'kept');
    const strung = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        identity: { cardInstruction: 'false' },
    });
    assert.equal(strung.identity.cardInstruction, true);
});

test('the Settings map section exposes map.closeOnTravel', () => {
    const html = readFileSync(new URL('../src/ui/settings.html', import.meta.url), 'utf8');
    assert.match(html, /data-neoterra-path="map\.closeOnTravel"/);
});

test('map.arrivalFeedback normalizes with the default and round-trips', () => {
    const defaults = migrateSettings({ schemaVersion: SCHEMA_VERSION });
    assert.equal(defaults.map.arrivalFeedback, true);

    const off = migrateSettings({ schemaVersion: SCHEMA_VERSION, map: { arrivalFeedback: false } });
    assert.equal(off.map.arrivalFeedback, false);

    // A persisted non-boolean must not reach the shell: it reads with
    // `!== false`, so a string "false" would keep the cues on.
    const malformed = migrateSettings({ schemaVersion: SCHEMA_VERSION, map: { arrivalFeedback: 'false' } });
    assert.equal(malformed.map.arrivalFeedback, true);

    const html = readFileSync(new URL('../src/ui/settings.html', import.meta.url), 'utf8');
    assert.match(html, /data-neoterra-path="map\.arrivalFeedback"/);
});

test('fresh install writes defaults exactly once', () => {
    const { ctx, calls } = mockContext();
    assert.equal(isFreshInstall(ctx), true);

    const first = getSettings(ctx);
    assert.equal(first.contentGate, 'full');
    assert.equal(calls.saves, 1);
    assert.equal(isFreshInstall(ctx), false);

    const second = getSettings(ctx);
    assert.equal(second.contentGate, 'full');
    assert.equal(calls.saves, 1, 'a second read must not re-save untouched defaults');
});

test('existing user values and unknown keys are preserved', () => {
    const stored = {
        ...cloneDefaults(),
        contentGate: 'strict',
        cyoa: { ...cloneDefaults().cyoa, enabled: true, count: 5 },
        customFeature: { keep: 'me' },
    };
    const { ctx, calls } = mockContext(stored);

    const settings = getSettings(ctx);
    assert.equal(settings.contentGate, 'strict');
    assert.equal(settings.cyoa.enabled, true);
    assert.equal(settings.cyoa.count, 5);
    assert.deepEqual(settings.customFeature, { keep: 'me' });
    assert.equal(calls.saves, 0, 'a fully-populated current document must not be rewritten');
});

test('pre-versioned settings are migrated on read once', () => {
    const legacy = {
        schemaVersion: 0,
        contentGate: 'reduced',
        castMode: 'solo',
        cyoa: { enabled: true, count: 99, theme: 'not-a-theme' },
        badEnds: { enabled: true },
        keepThis: 42,
    };
    const { ctx, calls } = mockContext(legacy);

    const settings = getSettings(ctx);
    assert.equal(settings.schemaVersion, SCHEMA_VERSION);
    assert.equal(settings.contentGate, 'reduced');
    assert.equal(settings.castMode, 'solo');
    assert.equal(settings.cyoa.enabled, true);
    assert.equal(settings.cyoa.count, 6, 'count is clamped to the supported range');
    assert.equal(settings.cyoa.theme, 'auto', 'unknown themes fall back to auto');
    assert.equal(settings.cyoa.combatChoices.enabled, false, 'new nested defaults are filled');
    assert.equal(settings.badEnds.allowDeadContinuation, false);
    assert.equal(settings.keepThis, 42, 'unknown keys survive migration');
    assert.equal(calls.saves, 1);

    getSettings(ctx);
    assert.equal(calls.saves, 1, 'migration is persisted only once');
});

test('future settings versions are not downgraded', () => {
    const future = {
        schemaVersion: SCHEMA_VERSION + 5,
        futureOnly: { nested: true },
        contentGate: 'reduced',
    };
    const { ctx } = mockContext(future);
    const settings = getSettings(ctx);
    assert.deepEqual(settings.futureOnly, { nested: true });
    assert.equal(settings.contentGate, 'reduced');
});

test('settings with no registered migration still land on the current schema', () => {
    assert.equal(needsMigration({ schemaVersion: 0 }), true);
    assert.equal(needsMigration({ schemaVersion: SCHEMA_VERSION }), false);

    const migrated = migrateSettings({ schemaVersion: -1, keepMe: { a: 1 } });
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(migrated.keepMe, { a: 1 });
    assert.equal(migrated.contentGate, 'full');
});

test('saveSettings persists a normalized document and preserves unknown keys', () => {
    const { ctx, calls } = mockContext();
    const result = saveSettings(ctx, {
        contentGate: 'mature-only',
        cyoa: { count: 2 },
        extra: 'kept',
    });

    assert.equal(result.contentGate, 'mature-only');
    assert.equal(result.cyoa.count, 2);
    assert.equal(result.extra, 'kept');
    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(calls.saves, 1);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].extra, 'kept');
});

test('setSetting updates one dotted path and saves', () => {
    const { ctx, calls } = mockContext();
    getSettings(ctx);
    assert.equal(calls.saves, 1);

    setSetting(ctx, 'cyoa.enabled', true);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].cyoa.enabled, true);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].cyoa.count, 4);
    assert.equal(calls.saves, 2);

    setSetting(ctx, 'agents.lore.everyNTurns', 12);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].agents.lore.everyNTurns, 12);
});

test('resetSettings restores factory defaults', () => {
    const { ctx } = mockContext();
    setSetting(ctx, 'contentGate', 'strict');
    const reset = resetSettings(ctx);
    assert.equal(reset.contentGate, 'full');
    assert.equal(reset.cyoa.count, 4);
});

test('getByPath and setByPath create missing objects', () => {
    const target = {};
    setByPath(target, 'a.b.c', 7);
    assert.equal(getByPath(target, 'a.b.c'), 7);
    assert.deepEqual(target, { a: { b: { c: 7 } } });
});

test('invalid values are normalized without throwing', () => {
    const migrated = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        contentGate: 'nonsense',
        castMode: 'nope',
        beatDeadlinePressure: 'extreme',
        cyoa: { count: 'x', maxLabelLength: 500, theme: 'invalid' },
        agents: { storyline: { everyNTurns: -3 } },
        tokenBudget: { total: -100 },
    });

    assert.equal(migrated.contentGate, 'full');
    assert.equal(migrated.castMode, 'director');
    assert.equal(migrated.beatDeadlinePressure, 'standard');
    assert.equal(migrated.cyoa.count, 4);
    assert.equal(migrated.cyoa.maxLabelLength, 100);
    assert.equal(migrated.cyoa.theme, 'auto');
    assert.equal(migrated.agents.storyline.everyNTurns, 1);
    assert.equal(migrated.tokenBudget.total, 0);
});

test('a stored characterCreator token budget below the safe floor is raised', () => {
    const migrated = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        agents: { characterCreator: { enabled: true, maxTokens: 4000 } },
    });
    assert.equal(migrated.agents.characterCreator.maxTokens, 6000);
    assert.equal(migrated.agents.characterCreator.timeoutMs, 180000);

    const higher = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        agents: { characterCreator: { maxTokens: 12000 } },
    });
    assert.equal(higher.agents.characterCreator.maxTokens, 12000);

    const other = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        agents: { stateTracker: { maxTokens: 900 } },
    });
    assert.equal(other.agents.stateTracker.maxTokens, 900);
});

test('the clock settings normalizer fills defaults, clamps, and keeps unknown keys', () => {
    const defaults = migrateSettings({ schemaVersion: SCHEMA_VERSION });
    assert.equal(defaults.clock.enabled, true);
    assert.equal(defaults.clock.slotsPerDay, 5);
    assert.equal(defaults.clock.timeOfDayStart, 'evening');
    assert.deepEqual(
        { ...defaults.clock.autoHold },
        { combat: true, encounter: false, beat: false },
    );
    assert.equal(defaults.clock.maxHoldTurns, 20);

    const clamped = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        clock: {
            enabled: false,
            slotsPerDay: 99,
            timeOfDayStart: 'midnight',
            autoHold: { combat: false },
            maxHoldTurns: 0,
            custom: 'keep',
        },
    });
    assert.equal(clamped.clock.enabled, false);
    assert.equal(clamped.clock.slotsPerDay, 12);
    assert.equal(clamped.clock.timeOfDayStart, 'evening');
    assert.equal(clamped.clock.autoHold.combat, false);
    assert.equal(clamped.clock.autoHold.encounter, false);
    assert.equal(clamped.clock.maxHoldTurns, 1);
    assert.equal(clamped.clock.custom, 'keep');

    const low = migrateSettings({ schemaVersion: SCHEMA_VERSION, clock: { slotsPerDay: 0 } });
    assert.equal(low.clock.slotsPerDay, 1);
});

test('the pacing settings normalizer fills defaults and clamps', () => {
    const defaults = migrateSettings({ schemaVersion: SCHEMA_VERSION });
    assert.equal(defaults.pacing.enabled, true);
    assert.equal(defaults.pacing.stallTurns, 3);
    assert.equal(defaults.pacing.sceneMaxTurns, 12);
    assert.equal(defaults.pacing.threatNudgeTurns, 10);
    assert.equal(defaults.pacing.nudgeScore, 2);
    assert.equal(defaults.pacing.cutScore, 4);
    assert.equal(defaults.pacing.cutSlots, 2);
    assert.equal(defaults.pacing.snoozeTurns, 3);

    const clamped = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        pacing: {
            sceneMaxTurns: 1,
            cutSlots: 99,
            snoozeTurns: 0,
            cutScore: 0,
            nudgeScore: 99,
            threatNudgeTurns: 0,
            custom: 'keep',
        },
    });
    assert.equal(clamped.pacing.sceneMaxTurns, 2);
    assert.equal(clamped.pacing.cutSlots, 12);
    assert.equal(clamped.pacing.snoozeTurns, 1);
    assert.equal(clamped.pacing.cutScore, 1);
    assert.equal(clamped.pacing.nudgeScore, 20);
    assert.equal(clamped.pacing.threatNudgeTurns, 1);
    assert.equal(clamped.pacing.custom, 'keep');
});

test('the world-tick settings normalizer fills defaults and keeps unknown keys', () => {
    const defaults = migrateSettings({ schemaVersion: SCHEMA_VERSION });
    assert.equal(defaults.worldTick.enabled, true);
    assert.equal(defaults.worldTick.allowNpcMovesDuringCombat, false);

    assert.equal(defaults.newspaper.enabled, false);
    assert.equal(defaults.newspaper.style, 'auto');
    assert.equal(defaults.newspaper.everyDays, 3);
    assert.equal(defaults.newspaper.minEvents, 6);

    const overridden = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        worldTick: { enabled: false, allowNpcMovesDuringCombat: true, custom: 'keep' },
    });
    assert.equal(overridden.worldTick.enabled, false);
    assert.equal(overridden.worldTick.allowNpcMovesDuringCombat, true);
    assert.equal(overridden.worldTick.custom, 'keep');

    const legacy = migrateSettings({ schemaVersion: SCHEMA_VERSION, worldTick: null });
    assert.equal(legacy.worldTick.enabled, true);
    assert.equal(legacy.worldTick.allowNpcMovesDuringCombat, false);

    const newspaper = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        newspaper: { enabled: true, style: 'nope', everyDays: 0, minEvents: 999, custom: 'keep' },
    });
    assert.equal(newspaper.newspaper.enabled, true);
    assert.equal(newspaper.newspaper.style, 'auto');
    assert.equal(newspaper.newspaper.everyDays, 1);
    assert.equal(newspaper.newspaper.minEvents, 50);
    assert.equal(newspaper.newspaper.custom, 'keep');
});

test('the map off-screen settings normalize with defaults', () => {
    const defaults = migrateSettings({ schemaVersion: SCHEMA_VERSION });
    assert.equal(defaults.map.showOffscreen, true);

    const custom = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        map: { showOffscreen: false },
    });
    assert.equal(custom.map.showOffscreen, false);
});
