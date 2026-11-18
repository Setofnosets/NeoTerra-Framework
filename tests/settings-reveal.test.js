import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    describeMissingSettingsHost,
    planSettingsReveal,
    revealSettingsPanel,
} from '../src/ui/settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeClassList(...names) {
    const set = new Set(names);
    return {
        contains: (name) => set.has(name),
        add: (...values) => values.forEach((value) => set.add(value)),
        remove: (...values) => values.forEach((value) => set.delete(value)),
        values: () => [...set],
    };
}

function fakeElement(name, { classList = fakeClassList(), hidden = false, id = null } = {}) {
    const element = {
        name,
        id,
        classList,
        hidden,
        clicks: 0,
        scrolled: [],
        click() {
            element.clicks += 1;
        },
        scrollIntoView(options) {
            element.scrolled.push(options ?? {});
        },
        querySelector: () => null,
    };
    return element;
}

function fakeDocument({ drawerOpen = false, panelExpanded = true, withDrawer = true, withPanel = true } = {}) {
    const drawerToggle = fakeElement('drawer-toggle');
    const panelToggle = fakeElement('panel-toggle');
    const content = fakeElement('content', { classList: fakeClassList(panelExpanded ? 'openDrawer' : 'closedDrawer') });
    const panel = fakeElement('panel', { id: 'neoterra-settings' });
    panel.querySelector = (selector) => {
        if (selector === '.inline-drawer-content') {
            return content;
        }
        if (selector === '.inline-drawer-toggle') {
            return panelToggle;
        }
        return null;
    };
    const drawer = fakeElement('drawer', { classList: fakeClassList(drawerOpen ? 'openDrawer' : 'closedDrawer') });
    drawer.querySelector = (selector) => (selector === '.drawer-toggle' ? drawerToggle : null);
    return {
        drawer,
        drawerToggle,
        panel,
        panelToggle,
        content,
        getElementById(id) {
            if (id === 'rm_extensions_block') {
                return withDrawer ? drawer : null;
            }
            if (id === 'neoterra-settings') {
                return withPanel ? panel : null;
            }
            return null;
        },
        querySelector(selector) {
            if (selector === '#extensions-settings-button .drawer-toggle') {
                return withDrawer ? drawerToggle : null;
            }
            return null;
        },
    };
}

test('reveal plan covers every drawer/panel state', () => {
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: true, drawerOpen: false, panelPresent: true, panelExpanded: false }),
        ['open-drawer', 'expand-panel', 'scroll-panel'],
    );
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: true, drawerOpen: true, panelPresent: true, panelExpanded: true }),
        ['scroll-panel'],
        'an already-open drawer is never toggled closed',
    );
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: true, drawerOpen: true, panelPresent: true, panelExpanded: false }),
        ['expand-panel', 'scroll-panel'],
    );
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: true, drawerOpen: false, panelPresent: true, panelExpanded: true }),
        ['open-drawer', 'scroll-panel'],
    );
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: false, drawerOpen: false, panelPresent: true, panelExpanded: true }),
        ['warn-missing'],
    );
    assert.deepEqual(
        planSettingsReveal({ drawerPresent: true, drawerOpen: true, panelPresent: false, panelExpanded: true }),
        ['warn-missing'],
    );
    assert.deepEqual(planSettingsReveal(), ['warn-missing']);
});

test('missing-host reasons name what was not found', () => {
    assert.match(describeMissingSettingsHost({ drawerPresent: false, panelPresent: false }), /drawer and the Neo Terra settings panel/);
    assert.match(describeMissingSettingsHost({ drawerPresent: false, panelPresent: true }), /rm_extensions_block/);
    assert.match(describeMissingSettingsHost({ drawerPresent: true, panelPresent: false }), /panel is not mounted/);
});

test('reveal opens a closed drawer, expands a collapsed panel, and scrolls once the frame is ready', () => {
    const doc = fakeDocument({ drawerOpen: false, panelExpanded: false });
    const frames = [];
    const result = revealSettingsPanel({ deps: { doc, requestFrame: (callback) => frames.push(callback) } });
    assert.deepEqual(result, { ok: true });
    assert.equal(doc.drawerToggle.clicks, 1);
    assert.equal(doc.panelToggle.clicks, 1);
    assert.equal(doc.panel.scrolled.length, 1);
    assert.equal(frames.length, 1);
    frames[0]();
    assert.equal(doc.panel.scrolled.length, 2);
    assert.deepEqual(doc.panel.scrolled[1], { behavior: 'smooth', block: 'center' });
});

test('an open drawer and expanded panel are left alone (only scroll)', () => {
    const doc = fakeDocument({ drawerOpen: true, panelExpanded: true });
    const result = revealSettingsPanel({ deps: { doc, requestFrame: null } });
    assert.deepEqual(result, { ok: true });
    assert.equal(doc.drawerToggle.clicks, 0, 're-clicking open must not close the drawer');
    assert.equal(doc.panelToggle.clicks, 0);
    assert.equal(doc.panel.scrolled.length, 1);
});

test('a missing host returns a failure instead of throwing', () => {
    const doc = fakeDocument({ withDrawer: false });
    const result = revealSettingsPanel({ deps: { doc, requestFrame: null } });
    assert.deepEqual(result, { ok: false, reason: 'missing-host' });
    assert.equal(doc.panel.scrolled.length, 0);
});

test('a missing panel returns a failure instead of throwing', () => {
    const doc = fakeDocument({ withPanel: false });
    const result = revealSettingsPanel({ deps: { doc, requestFrame: null } });
    assert.deepEqual(result, { ok: false, reason: 'missing-host' });
});

test('a drawer without a toggle is reported missing instead of silently failing', () => {
    const doc = fakeDocument({ drawerOpen: false });
    doc.drawerToggle = null;
    doc.querySelector = () => null;
    doc.drawer.querySelector = () => null;
    const result = revealSettingsPanel({ deps: { doc, requestFrame: null } });
    assert.deepEqual(result, { ok: false, reason: 'missing-host' });
});

test('no document is a graceful failure (no DOM in node tests)', () => {
    const result = revealSettingsPanel({ deps: { doc: null } });
    assert.deepEqual(result, { ok: false, reason: 'no-dom' });
});

test('the shell Settings tab ships the handoff button and a live status region', () => {
    const source = readFileSync(join(ROOT, 'src/ui/shell.js'), 'utf8');
    assert.match(source, /data-neoterra-open-settings/);
    assert.match(source, /data-neoterra-settings-status/);
    assert.match(source, /role="status"/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /revealSettingsPanel\(/);
    // The shell is modal; it must close before the ST drawer can be used,
    // but only after the host check so a failure stays visible.
    const handler = source.slice(source.indexOf('function openSettingsPanel()'), source.indexOf('function failSettingsReveal'));
    const presenceAt = handler.indexOf("getElementById('rm_extensions_block')");
    const closeAt = handler.indexOf('closeShell();');
    const revealAt = handler.indexOf('revealSettingsPanel(');
    assert.ok(presenceAt > -1 && closeAt > presenceAt, 'the shell closes only after the host check');
    assert.ok(revealAt > closeAt, 'closeShell must run before revealSettingsPanel');
    assert.match(handler, /openShell\('settings'\)/, 'a late failure re-opens the shell so the status is visible');
    assert.match(source, /role="status"/);
});

test('the reveal helper never adds listeners or writes settings', () => {
    const source = readFileSync(join(ROOT, 'src/ui/settings.js'), 'utf8');
    const start = source.indexOf('export function revealSettingsPanel');
    const end = source.indexOf('async function ensureCardSeasonOptions');
    const body = source.slice(start, end);
    assert.ok(start > -1 && end > start);
    assert.doesNotMatch(body, /addEventListener/);
    assert.doesNotMatch(body, /saveSettings/);
    assert.doesNotMatch(body, /setByPath/);
});
