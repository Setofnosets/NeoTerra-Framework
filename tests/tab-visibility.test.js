import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isDomainTabVisible,
    resolveActiveTab,
    resolveVisibleTabs,
} from '../src/ui/tab-visibility.js';
import { SHELL_TABS } from '../src/core/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const s1dark = readJson('data/seasons/s1dark.json');
const s1 = readJson('data/seasons/s1.json');
const sandbox = readJson('data/seasons/sandbox.json');

test('the Domain tab is present in the shell tab list, before Player', () => {
    const ids = SHELL_TABS.map((tab) => tab.id);
    assert.ok(ids.includes('domain'));
    assert.ok(ids.indexOf('domain') < ids.indexOf('player'));
});

test('S1Dark shows the Domain tab', () => {
    const tabs = resolveVisibleTabs({ playerRole: 'villain' }, s1dark);
    assert.ok(tabs.some((tab) => tab.id === 'domain'));
    assert.equal(isDomainTabVisible({}, s1dark), true);
});

test('hero seasons and Sandbox hide the Domain tab', () => {
    for (const season of [s1, sandbox]) {
        const tabs = resolveVisibleTabs({}, season);
        assert.equal(tabs.some((tab) => tab.id === 'domain'), false);
    }
    assert.equal(isDomainTabVisible({}, null), false);
});

test('a villain season without a domain block hides the tab', () => {
    const tabs = resolveVisibleTabs({}, { playerRole: 'villain' });
    assert.equal(tabs.some((tab) => tab.id === 'domain'), false);
});

test('a hidden active tab falls back to Characters', () => {
    assert.equal(resolveActiveTab('domain', {}, s1), 'characters');
    assert.equal(resolveActiveTab('domain', {}, s1dark), 'domain');
    assert.equal(resolveActiveTab('map', {}, s1dark), 'map');
    assert.equal(resolveActiveTab('nonsense', {}, sandbox), 'characters');
});

test('the visible list keeps every non-domain tab', () => {
    const ids = resolveVisibleTabs({}, s1).map((tab) => tab.id);
    assert.deepEqual(ids, SHELL_TABS.map((tab) => tab.id).filter((id) => id !== 'domain'));
});
