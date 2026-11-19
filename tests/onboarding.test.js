import test from 'node:test';
import assert from 'node:assert/strict';

import { applyUiPreset, cloneDefaults, UI_PRESETS } from '../src/core/defaults.js';
import { normalizeSettings } from '../src/core/migrations.js';
import {
    PALETTE_ACTIONS,
    filterPaletteActions,
    renderPaletteMarkup,
} from '../src/ui/command-palette.js';
import { renderSeasonMenuMarkup } from '../src/ui/season-menu.js';

test('recommended presets apply the documented switches', () => {
    assert.deepEqual(UI_PRESETS.map((preset) => preset.id), ['cinematic', 'classic', 'sandbox']);

    const cinematic = applyUiPreset(cloneDefaults(), 'cinematic');
    assert.equal(cinematic.clock.enabled, true);
    assert.equal(cinematic.worldTick.enabled, true);
    assert.equal(cinematic.pacing.enabled, true);
    assert.equal(cinematic.cyoa.enabled, true);
    assert.equal(cinematic.ui.hudEnabled, true);
    assert.equal(cinematic.ui.cinematicChat, true);

    const sandbox = applyUiPreset(cloneDefaults(), 'sandbox');
    assert.equal(sandbox.beatDeadlinePressure, 'off');
    assert.equal(sandbox.pacing.enabled, false);
    assert.equal(sandbox.clock.enabled, false);

    const classic = applyUiPreset(cloneDefaults(), 'classic');
    assert.equal(classic.clock.enabled, cloneDefaults().clock.enabled);
    assert.equal(classic.ui.cinematicChat, false);

    const configured = cloneDefaults();
    configured.agents.stateTracker.connectionProfileId = 'my-profile';
    configured.contentGate = 'strict';
    const preserved = applyUiPreset(configured, 'classic');
    assert.equal(preserved.agents.stateTracker.connectionProfileId, 'my-profile');
    assert.equal(preserved.contentGate, 'strict');
});

test('an unknown preset returns a copy and never mutates the input', () => {
    const base = cloneDefaults();
    const copy = applyUiPreset(base, 'nonsense');
    assert.deepEqual(copy, base);
    copy.clock.enabled = !copy.clock.enabled;
    assert.notEqual(base.clock.enabled, copy.clock.enabled);
});

test('palette filtering ranks label prefixes and includes gameplay actions', () => {
    assert.equal(filterPaletteActions('')[0].id, 'travel');
    assert.equal(filterPaletteActions('jour')[0].id, 'journal');
    assert.equal(filterPaletteActions('newsp')[0].id, 'newspaper');
    assert.equal(filterPaletteActions('new timeline')[0].id, 'new-timeline');
    assert.equal(filterPaletteActions('stamina')[0].id, 'player');
    assert.equal(filterPaletteActions('zzz').length, 0);

    const ids = PALETTE_ACTIONS.map((action) => action.id);
    for (const expected of ['travel', 'cast', 'player', 'journal', 'rest', 'patrol', 'newspaper', 'new-timeline']) {
        assert.equal(ids.includes(expected), true);
    }
    for (const forbidden of ['settings', 'export', 'import', 'agents', 'diagnostics']) {
        assert.equal(ids.includes(forbidden), false);
    }
});

test('palette markup marks the selected row and renders commands', () => {
    const results = filterPaletteActions('map');
    const markup = renderPaletteMarkup(results, { selectedIndex: 0, query: 'map' });
    assert.match(markup, /data-neoterra-command-palette/);
    assert.match(markup, /is-selected/);
    assert.match(markup, /data-neoterra-palette-action="travel"/);
});

test('the season menu offers the recommended presets', () => {
    const markup = renderSeasonMenuMarkup([], { view: 'list' });
    for (const preset of UI_PRESETS) {
        assert.match(markup, new RegExp(`data-neoterra-preset="${preset.id}"`));
    }
});

test('ui settings normalize persisted string booleans', () => {
    const settings = normalizeSettings({
        ...cloneDefaults(),
        ui: { hudEnabled: 'false', hudCollapsed: 'true', cinematicChat: 'false', firstRunWizardSeen: 'true' },
    });
    assert.equal(settings.ui.hudEnabled, false);
    assert.equal(settings.ui.hudCollapsed, true);
    assert.equal(settings.ui.cinematicChat, false);
    assert.equal(settings.ui.firstRunWizardSeen, true);
    assert.equal(Object.hasOwn(settings.ui, 'windows'), false);
});
