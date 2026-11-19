import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSceneChatMessage } from '../src/ui/chat-output.js';
import {
    applySceneDecorations,
    buildSceneMeta,
    buildSceneRuns,
    decorateSceneElement,
    extractSceneMeta,
    renderSceneHeader,
} from '../src/ui/scene-decorator.js';

function sceneMessage(extra = {}, meta = null) {
    return buildSceneChatMessage({
        kind: 'travel',
        text: 'Location changed: A → B',
        key: 'travel:1',
        extra,
        meta,
        avatarUrl: null,
        now: new Date('2031-04-12T18:00:00Z'),
    });
}

function fakeElement() {
    const classes = new Set();
    return {
        dataset: {},
        html: '',
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
        },
        insertAdjacentHTML(_position, html) {
            this.html += html;
        },
    };
}

test('scene messages carry structured meta without changing the prose', () => {
    const meta = buildSceneMeta({
        locationId: 'central-plaza',
        locationName: 'Central Plaza',
        timeSlot: 'evening',
        pov: 'Vaiva',
        present: ['s1.vaiva.vaiva'],
    });
    const message = sceneMessage({ from: 'a', to: 'b' }, meta);
    assert.equal(message.mes.includes('[NEOTERRA_'), false);
    assert.deepEqual(message.extra.neoterra.scene.meta, meta);
    const extracted = extractSceneMeta(message);
    assert.equal(extracted.label, 'Arrival');
    assert.equal(extracted.locationId, 'central-plaza');
    assert.equal(extracted.locationName, 'Central Plaza');
    assert.equal(extracted.time, 'evening');
    assert.equal(extracted.pov, 'Vaiva');
    assert.deepEqual(extracted.present, ['s1.vaiva.vaiva']);
});

test('older encounter frames fall back to flat scene fields', () => {
    const message = sceneMessage({ locationId: 'docks', participants: ['a', 'b'] });
    const extracted = extractSceneMeta(message);
    assert.equal(extracted.locationId, 'docks');
    assert.deepEqual(extracted.present, ['a', 'b']);
});

test('non-scene messages are ignored', () => {
    assert.equal(extractSceneMeta({ mes: 'hello' }), null);
    assert.equal(extractSceneMeta({ extra: {} }), null);
});

test('consecutive scene frames form one run and prose splits it', () => {
    const messages = [
        sceneMessage({}, buildSceneMeta({ locationName: 'A' })),
        sceneMessage({}, buildSceneMeta({ locationName: 'B' })),
        { mes: 'The narrator speaks.', is_user: false },
        sceneMessage({}, buildSceneMeta({ locationName: 'C' })),
    ];
    const runs = buildSceneRuns(messages);
    assert.equal(runs.length, 2);
    assert.deepEqual({ start: runs[0].start, end: runs[0].end }, { start: 0, end: 1 });
    assert.deepEqual({ start: runs[1].start, end: runs[1].end }, { start: 3, end: 3 });
});

test('the header shows kind, location, time, POV, and present portraits', () => {
    const model = extractSceneMeta(sceneMessage({}, buildSceneMeta({
        locationName: 'Central Plaza',
        timeSlot: 'evening',
        pov: 'Vaiva',
        present: ['s1.vaiva.vaiva'],
    })));
    const markup = renderSceneHeader(model);
    assert.match(markup, /data-neoterra-scene-card="travel"/);
    assert.match(markup, /Arrival/);
    assert.match(markup, /Central Plaza/);
    assert.match(markup, /evening/);
    assert.match(markup, /POV Vaiva/);
    assert.match(markup, /data-neoterra-avatar-strip/);
});

test('decorating a rendered element is idempotent', () => {
    const element = fakeElement();
    const model = extractSceneMeta(sceneMessage({}, buildSceneMeta({ locationName: 'A' })));
    assert.equal(decorateSceneElement(element, model, { cinematic: true }), true);
    assert.equal(element.dataset.neoterraSceneCard, 'true');
    assert.equal(element.classList.contains('neoterra-cinematic-frame'), true);
    assert.match(element.html, /neoterra-scene-card-header/);

    const before = element.html;
    assert.equal(decorateSceneElement(element, model, { cinematic: true }), false);
    assert.equal(element.html, before);
});

test('applySceneDecorations keeps runs and returns counts', () => {
    const messages = [
        sceneMessage({}, buildSceneMeta({ locationName: 'A' })),
        sceneMessage({}, buildSceneMeta({ locationName: 'B' })),
    ];
    const elements = [fakeElement(), fakeElement()];
    const dividers = [];
    const root = {
        classList: { toggle() {} },
        querySelector: (selector) => {
            const match = /mesid="(\d+)"/.exec(selector);
            return match ? elements[Number(match[1])] ?? null : null;
        },
        querySelectorAll: () => [],
    };
    for (const element of elements) {
        element.parentNode = { insertBefore: (node) => dividers.push(node) };
    }
    const doc = {
        createElement: () => ({
            dataset: {},
            innerHTML: '',
            remove() {},
            set className(value) { this._className = value; },
            get className() { return this._className; },
        }),
    };
    const result = applySceneDecorations({ root, messages, cinematic: true, doc });
    assert.equal(result.decorated, 2);
    assert.equal(result.runs.length, 1);
    assert.equal(dividers.length, 1);
    assert.match(dividers[0].innerHTML, /Arrival/);
});
