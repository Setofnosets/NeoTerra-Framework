import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    WINDOW_MARGIN,
    WINDOW_MIN_HEIGHT,
    WINDOW_MIN_WIDTH,
    clampWindowGeometry,
    isSheetViewport,
    nextStack,
    restoreWindowGeometry,
    windowMarkup,
    windowZIndex,
} from '../src/ui/window-manager.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');

test('clampWindowGeometry keeps a window inside the viewport', () => {
    const viewport = { width: 1280, height: 800 };
    const geometry = clampWindowGeometry({ x: 1200, y: 900, width: 900, height: 900 }, viewport);
    assert.equal(geometry.width <= viewport.width - WINDOW_MARGIN * 2, true);
    assert.equal(geometry.height <= viewport.height - WINDOW_MARGIN * 2, true);
    assert.equal(geometry.x >= WINDOW_MARGIN, true);
    assert.equal(geometry.y >= WINDOW_MARGIN, true);
    assert.equal(geometry.x + geometry.width <= viewport.width, true);
    assert.equal(geometry.y + geometry.height <= viewport.height, true);
});

test('clampWindowGeometry enforces a usable minimum and tolerates tiny screens', () => {
    const desktop = clampWindowGeometry({ width: 10, height: 10 }, { width: 1280, height: 800 });
    assert.equal(desktop.width, WINDOW_MIN_WIDTH);
    assert.equal(desktop.height, WINDOW_MIN_HEIGHT);

    const tiny = clampWindowGeometry({ width: 900, height: 900 }, { width: 300, height: 200 });
    assert.equal(tiny.x >= WINDOW_MARGIN, true);
    assert.equal(tiny.width <= 300, true);
    assert.equal(tiny.height <= 200, true);
});

test('restoreWindowGeometry merges saved geometry over defaults and clamps it', () => {
    const restored = restoreWindowGeometry(
        { x: 5000, y: -200, width: 1000 },
        { width: 1280, height: 800 },
        { x: 100, y: 100, width: 720, height: 480 },
    );
    assert.equal(restored.width, 1000);
    assert.equal(restored.height, 480);
    assert.equal(restored.y >= WINDOW_MARGIN, true);
    assert.equal(restored.x + restored.width <= 1280, true);

    const fresh = restoreWindowGeometry(null, { width: 1280, height: 800 }, { x: 40, y: 50, width: 640, height: 400 });
    assert.deepEqual(fresh, { x: 40, y: 50, width: 640, height: 400 });
});

test('nextStack moves a window to the top without duplicating it', () => {
    let stack = nextStack([], 'map');
    assert.deepEqual(stack, ['map']);
    stack = nextStack(stack, 'characters');
    assert.deepEqual(stack, ['map', 'characters']);
    stack = nextStack(stack, 'map');
    assert.deepEqual(stack, ['characters', 'map']);
    assert.equal(new Set(stack).size, stack.length);
});

test('window z-index grows with stack order and sheets are mobile-only', () => {
    assert.equal(windowZIndex(0) < windowZIndex(1), true);
    assert.equal(isSheetViewport({ width: 390 }), true);
    assert.equal(isSheetViewport({ width: 1440 }), false);
});

test('windowMarkup carries a title bar, close/minimize, and a resize grip', () => {
    const markup = windowMarkup({
        id: 'map',
        title: 'City Map',
        geometry: { x: 10, y: 20, width: 800, height: 500 },
        zIndex: 3601,
    });
    assert.match(markup, /data-neoterra-window="map"/);
    assert.match(markup, /data-neoterra-window-drag/);
    assert.match(markup, /data-neoterra-window-close/);
    assert.match(markup, /data-neoterra-window-minimize/);
    assert.match(markup, /data-neoterra-window-resize/);
    assert.match(markup, /left:10px/);
    assert.match(markup, /z-index:3601/);
});

test('the window layer CSS supports windows, sheets, and hosted maps', () => {
    assert.match(css, /\.neoterra-window-layer\s*\{[^}]*pointer-events:\s*none/);
    assert.match(css, /\.neoterra-window\s*\{[^}]*pointer-events:\s*auto/);
    assert.match(css, /\.neoterra-window\[data-layout='sheet'\]\s*\{[^}]*inset:\s*0/);
    assert.match(css, /\.neoterra-map-hosted \.neoterra-map\s*\{[^}]*position:\s*relative\s*!important/);
    assert.match(css, /\.neoterra-map-hosted \.neoterra-map-resize\s*\{[^}]*display:\s*none/);
});
