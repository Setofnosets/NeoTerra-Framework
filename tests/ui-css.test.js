import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');

function ruleBody(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
    return match?.[1] ?? null;
}

test('inactive tab panels are actually hidden', () => {
    const body = ruleBody('.neoterra-panel[hidden]');
    assert.ok(body, 'expected a .neoterra-panel[hidden] rule');
    assert.match(body, /display:\s*none\s*!important/);
});

test('live tab panels fill the shell instead of stacking at content height', () => {
    const panel = ruleBody('.neoterra-panel.is-live');
    assert.ok(panel, 'expected a .neoterra-panel.is-live rule');
    assert.match(panel, /display:\s*flex/);
    assert.match(panel, /flex:\s*1 1 auto/);

    const panels = ruleBody('.neoterra-tabpanels');
    assert.ok(panels, 'expected a .neoterra-tabpanels rule');
    assert.match(panels, /display:\s*flex/);
    assert.match(panels, /flex-direction:\s*column/);
    assert.match(panels, /min-height:\s*0/);
});

test('the map tab opts into a larger shell', () => {
    const body = ruleBody(".neoterra-root[data-active-tab='map'] .neoterra-shell");
    assert.ok(body, 'expected a map-specific shell size rule');
    assert.match(body, /width:\s*min\(1360px,\s*96vw\)/);
    assert.match(body, /max-height:\s*calc\(100vh - 2rem\)/);
});

test('the map tab shell has a definite height and keeps a floor', () => {
    const body = ruleBody(".neoterra-root[data-active-tab='map'] .neoterra-shell");
    assert.ok(body, 'expected a map-specific shell size rule');
    // Content height is what collapsed the host to its 420px minimum.
    assert.match(body, /(^|[^-])height:\s*min\(92vh,\s*calc\(100vh - 2rem\)\)/);
    assert.match(body, /min-height:\s*min\(560px,\s*calc\(100vh - 2rem\)\)/);
});

test('the shell overlay keeps a viewport height (SillyTavern transforms <html>)', () => {
    const body = ruleBody('.neoterra-root');
    assert.ok(body, 'expected a .neoterra-root rule');
    assert.match(body, /position:\s*fixed/);
    assert.match(body, /inset:\s*0/);
    // ST sets `transform` on <html> (a zero-height containing block), so an
    // `inset: 0`-only overlay collapses and centers its shell off-screen.
    assert.match(body, /height:\s*100vh/);
    assert.match(body, /height:\s*100dvh/);
    // The overlay's own padding must not push it past the viewport.
    assert.match(body, /box-sizing:\s*border-box/);
});

test('the map flex chain passes the host a definite height', () => {
    const panels = ruleBody('.neoterra-tabpanels');
    assert.ok(panels, 'expected a .neoterra-tabpanels rule');
    assert.match(panels, /flex:\s*1/);
    assert.match(panels, /flex-direction:\s*column/);

    const live = ruleBody('.neoterra-panel.is-live');
    assert.match(live, /flex:\s*1 1 auto/);
    assert.match(live, /min-height:\s*0/);

    const host = ruleBody('.neoterra-map-host');
    assert.ok(host, 'expected a .neoterra-map-host rule');
    assert.match(host, /flex:\s*1 1 auto/);
    // A 420px floor kept the panel at 396px after the 24px clamp margin.
    assert.doesNotMatch(host, /min-height:\s*420px/);
    assert.match(host, /min-height:\s*0/);
});

test('the world-clock chip is themed and shows a frozen state', () => {
    const chip = ruleBody('.neoterra-clock-chip');
    assert.ok(chip, 'expected a .neoterra-clock-chip rule');
    assert.doesNotMatch(chip, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(chip, /var\(--nt-/);

    const held = ruleBody(".neoterra-clock-chip[data-clock-held='true']");
    assert.ok(held, 'expected a held-state chip rule');
    assert.doesNotMatch(held, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(held, /var\(--nt-/);
});

test('the director card is styled with theme tokens', () => {
    const card = ruleBody('.neoterra-director-card');
    assert.ok(card, 'expected a .neoterra-director-card rule');
    assert.doesNotMatch(card, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(card, /var\(--nt-/);
    const actions = ruleBody('.neoterra-director-actions');
    assert.ok(actions, 'expected a .neoterra-director-actions rule');
    assert.match(actions, /display:\s*flex/);
});

test('the newspaper reader modal is themed and scrolls internally', () => {
    const modal = ruleBody('.neoterra-modal');
    assert.ok(modal, 'expected a .neoterra-modal rule');
    assert.match(modal, /position:\s*fixed/);
    const reader = ruleBody('.neoterra-newsreader');
    assert.ok(reader, 'expected a .neoterra-newsreader rule');
    assert.doesNotMatch(reader, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(reader, /var\(--nt-/);
    const body = ruleBody('.neoterra-newsreader-body');
    assert.ok(body, 'expected a .neoterra-newsreader-body rule');
    assert.match(body, /overflow:\s*hidden/);
});

test('the relations tab is a live flex panel with themed graph styles', () => {
    const host = ruleBody('.neoterra-relations-host');
    assert.ok(host, 'expected a .neoterra-relations-host rule');
    assert.match(host, /display:\s*flex/);
    assert.match(host, /flex:\s*1 1 auto/);
    assert.match(host, /min-height:\s*0/);

    const body = ruleBody('.neoterra-relations-body');
    assert.ok(body, 'expected a .neoterra-relations-body rule');
    assert.match(body, /grid-template-columns/);

    for (const selector of ['.neoterra-relations-side', '.neoterra-graph-edge', '.neoterra-graph-label']) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
        assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/);
        assert.match(rule, /var\(--nt-/);
    }
});

test('the domain sensorium is a themed live panel', () => {
    const host = ruleBody('.neoterra-domain-host');
    assert.ok(host, 'expected a .neoterra-domain-host rule');
    assert.match(host, /display:\s*flex/);
    assert.match(host, /flex:\s*1 1 auto/);

    for (const selector of ['.neoterra-domain-section', '.neoterra-domain-row', '.neoterra-domain-meter-track']) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
        assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/);
        assert.match(rule, /var\(--nt-/);
    }

    const hidden = ruleBody('.neoterra-tabs [hidden]');
    assert.ok(hidden, 'expected a hidden-tab rule');
    assert.match(hidden, /display:\s*none\s*!important/);
});

test('fog editor controls are themed', () => {
    const controls = ruleBody('.neoterra-fog-controls');
    assert.ok(controls, 'expected a .neoterra-fog-controls rule');
    assert.doesNotMatch(controls, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(controls, /var\(--nt-/);
});

test('character portraits have a themed shell and initials fallback', () => {
    for (const selector of ['.neoterra-avatar', '.neoterra-avatar-fallback', '.neoterra-avatar-strip']) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
    }
    const avatar = ruleBody('.neoterra-avatar');
    assert.match(avatar, /border-radius:\s*50%/);
    const fallback = ruleBody('.neoterra-avatar-fallback');
    assert.match(fallback, /display:\s*grid/);
});

test('the character picker, guest warning, and generated forms are themed', () => {
    for (const selector of [
        '.neoterra-character-picker',
        '.neoterra-picker-card',
        '.neoterra-picker-grid',
        '.neoterra-guest-warning',
        '.neoterra-identity-group',
        '.neoterra-codex-generated',
    ]) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
        assert.match(rule, /var\(--nt-|grid-template-columns|display:/);
    }
});

test('the season grid and identity picker are fully styled', () => {
    for (const selector of [
        '.neoterra-season-menu',
        '.neoterra-season-grid',
        '.neoterra-season-card',
        '.neoterra-season-card-header',
        '.neoterra-season-title',
        '.neoterra-season-era',
        '.neoterra-season-premise',
        '.neoterra-season-facts',
        '.neoterra-season-content-note',
        '.neoterra-season-actions',
        '.neoterra-season-toolbar',
        '.neoterra-character-first',
        '.neoterra-identity-options',
        '.neoterra-identity-option',
        '.neoterra-identity-label',
        '.neoterra-identity-portrait',
        '.neoterra-identity-detail',
        '.neoterra-back',
        '.neoterra-cancel',
        '.neoterra-agent-log',
        '.neoterra-agent-log-entry',
        '.neoterra-agent-log-entry-heading',
        '.neoterra-agent-log-errors',
        '.neoterra-season-notice',
    ]) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
    }

    for (const selector of [
        '.neoterra-season-card',
        '.neoterra-season-title',
        '.neoterra-season-era',
        '.neoterra-season-premise',
        '.neoterra-season-content-note',
        '.neoterra-season-notice',
        '.neoterra-identity-option',
        '.neoterra-identity-label',
        '.neoterra-identity-detail',
        '.neoterra-identity-portrait',
        '.neoterra-back',
        '.neoterra-cancel',
        '.neoterra-agent-log',
        '.neoterra-agent-log-errors',
    ]) {
        const rule = ruleBody(selector);
        assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/, `${selector} should use theme tokens`);
        assert.match(rule, /var\(--nt-/, `${selector} should use theme tokens`);
    }

    const grid = ruleBody('.neoterra-season-grid');
    assert.match(grid, /grid-template-columns/);
    assert.match(grid, /repeat\(3,/);
    const fieldset = ruleBody('.neoterra-identity-options');
    assert.match(fieldset, /border:\s*0/);

    const focus = css.match(/\.neoterra-back:focus-visible[\s\S]*?\{([\s\S]*?)\}/);
    assert.ok(focus, 'expected a focus-visible rule for the story controls');
    assert.match(focus[1], /--nt-focus-ring/);

    for (const selector of ['.neoterra-map-empty', '.neoterra-map-threat']) {
        const rule = ruleBody(selector);
        assert.ok(rule, `expected a ${selector} rule`);
        assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgba\(/, `${selector} should use theme tokens`);
        assert.match(rule, /var\(--nt-/, `${selector} should use theme tokens`);
    }
});
