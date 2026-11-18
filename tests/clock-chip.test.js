import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClockChipModel, mountClockChip } from '../src/ui/clock-chip.js';

function makeButton() {
    const listeners = new Set();
    return {
        type: '',
        className: '',
        textContent: '',
        title: '',
        hidden: false,
        dataset: {},
        attributes: {},
        addEventListener(type, handler) {
            if (type === 'click') listeners.add(handler);
        },
        removeEventListener(type, handler) {
            if (type === 'click') listeners.delete(handler);
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        click() {
            for (const handler of [...listeners]) handler();
        },
        remove() {
            this.removed = true;
        },
        listenerCount() {
            return listeners.size;
        },
    };
}

function makeHost(button = null) {
    return {
        button,
        querySelector() {
            return this.button;
        },
        append(node) {
            this.button = node;
        },
    };
}

test('the chip model reflects date, slot, hold state, and the clock toggle', () => {
    const state = {
        meta: { inGameDate: '2037-03-06', timeOfDay: 'evening' },
        flags: {},
    };
    const normal = buildClockChipModel(state, { clock: { enabled: true } });
    assert.equal(normal.visible, true);
    assert.equal(normal.held, false);
    assert.equal(normal.label, '2037-03-06 · evening');
    assert.equal(normal.tone, 'normal');

    const held = buildClockChipModel(
        { ...state, flags: { clock: { hold: { active: true, reason: 'chip' } } } },
        { clock: { enabled: true } },
    );
    assert.equal(held.held, true);
    assert.equal(held.reason, 'chip');
    assert.match(held.label, /time frozen/);
    assert.equal(held.tone, 'frozen');
    assert.match(held.title, /Click to release/);

    const undated = buildClockChipModel(
        { meta: { inGameDate: null, timeOfDay: null }, flags: {} },
        { clock: { enabled: false } },
    );
    assert.equal(undated.label, 'Day · evening');
    assert.equal(undated.enabled, false);

    assert.equal(buildClockChipModel(null, {}).visible, false);
});

test('mounting refreshes from state and toggling calls back with the live hold state', () => {
    const button = makeButton();
    const host = makeHost();
    let state = {
        meta: { inGameDate: '2037-03-06', timeOfDay: 'evening' },
        flags: {},
    };
    const toggles = [];
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => button };

    try {
        const chip = mountClockChip({
            host,
            getState: () => state,
            getSettings: () => ({ clock: { enabled: true } }),
            onToggle: ({ held }) => toggles.push(held),
        });
        assert.equal(host.button, button);
        assert.equal(button.hidden, false);
        assert.equal(button.textContent, '2037-03-06 · evening');
        assert.equal(button.attributes['aria-pressed'], 'false');

        button.click();
        assert.deepEqual(toggles, [false]);

        state = {
            ...state,
            flags: { clock: { hold: { active: true, reason: 'chip' } } },
        };
        chip.refresh();
        assert.equal(button.attributes['aria-pressed'], 'true');
        assert.equal(button.dataset.clockHeld, 'true');
        assert.match(button.textContent, /time frozen/);

        button.click();
        assert.deepEqual(toggles, [false, true]);

        chip.dispose();
        assert.equal(button.removed, true);
        assert.equal(button.listenerCount(), 0);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});
