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
    assert.match(body, /max-height:\s*92vh/);
});
