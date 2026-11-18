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
