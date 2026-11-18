import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAP_LOCATION_STATUSES,
    MAP_OVERRIDE_LAYERS,
    applyMapOverride,
    buildBeatViews,
    buildBridgeOverlayStyles,
    buildFactionViews,
    buildHeadlineViews,
    buildMapViewModel,
    buildOffscreenFeed,
    buildRegionOverlayStyles,
    buildThreatViews,
    deleteMapOverride,
    exportMapOverrides,
    exportChatMapOverrides,
    getChatMapOverrides,
    parseMapOverrides,
    resetMapOverride,
    setChatMapOverride,
    validateMapOverrides,
    buildWorldOverlay,
} from '../src/data/map.js';
import {
    EDITABLE_FEATURE_KINDS,
    applyEditorPatch,
    buildEditorSchema,
    deleteEditorOverride,
    editorValuesToPatch,
    escapeOverlayHtml,
    overrideTargetFor,
    renderActivityOverlay,
    renderBeatOverlay,
    renderEditorField,
    renderFactionOverlay,
    renderHeadlines,
    renderMapEditor,
    renderOffscreenFeed,
    renderThreatOverlay,
    renderVirtualNodeForm,
    renderWorldOverlayMarkup,
    resetEditorOverride,
    supportsChatStatus,
    validateEditorPatch,
} from '../src/ui/overlay.js';
import { LOCATION_STATUSES } from '../src/data/locations.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { migrateSettings } from '../src/core/migrations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const locations = readJson('data/locations.json');
const regions = readJson('data/map/regions.geojson');
const bridges = readJson('data/map/bridges.geojson');
const keyLocations = readJson('data/map/key-locations.json');
const overrides = readJson('data/map/overrides.json');
const districts = readJson('data/districts.json');
const factionsDocument = readJson('data/factions.json');
const seasonS4 = readJson('data/seasons/s4.json');
const seasonS1 = readJson('data/seasons/s1.json');

function baseState(patch = {}) {
    return {
        flags: {},
        locations: {},
        factions: {},
        threats: [],
        beats: {},
        recentEvents: [],
        ...patch,
    };
}

function worldState(patch = {}) {
    return baseState({
        factions: {
            clarity: {
                id: 'clarity',
                name: 'Clarity Incorporated',
                side: 'villain',
                influence: 80,
                status: 'active',
                goals: ['Control Neo Terra from the shadows', 'Convert captured metahumans'],
            },
            petrabyte: {
                id: 'petrabyte',
                name: 'PetraByte',
                side: 'hero',
                influence: 45,
                status: 'active',
                goals: ['Protect the city'],
            },
            'crisis-coalition': {
                id: 'crisis-coalition',
                name: 'Crisis Coalition',
                side: 'neutral',
                influence: 10,
                status: 'disbanded',
                goals: [],
            },
        },
        threats: [
            {
                id: 's4.threat.noah-atopos',
                name: 'Noah Atropos / Phage Clotho',
                rank: 'main',
                sourceFactionId: 'clarity',
                agenda: 'Release the Phage.',
                stages: ['Whisper', 'Outbreak', 'Collapse', 'Zero Hour'],
                progress: 55,
                stage: 2,
                status: 'active',
                locationId: 'clarity-hq',
            },
            {
                id: 's4.threat.ginny-avalanche',
                name: 'Ginny Aylesworth / Avalanche',
                rank: 'main',
                sourceFactionId: null,
                agenda: 'Freeze the harbor.',
                stages: ['Frost', 'Whiteout', 'Deep Freeze', 'Ice Age'],
                progress: 20,
                stage: 0,
                status: 'active',
                locationId: 'neon-docks',
            },
            {
                id: 's4.threat.cold-front',
                name: 'The Cold Front',
                rank: 'secondary',
                sourceFactionId: null,
                agenda: 'Take the docks.',
                stages: ['Rumour', 'Raids', 'Occupation'],
                progress: 100,
                stage: 2,
                status: 'defeated',
                locationId: null,
            },
        ],
        recentEvents: [
            { turn: 1, date: '2037-03-01', summary: 'The plaza is quiet.', actors: [], locationId: 'central-plaza', tags: [] },
            {
                turn: 2,
                date: '2037-03-01',
                summary: 'Clarity ships weapons.',
                headline: 'ARMS FLOW THROUGH THE DOCKS',
                actors: [],
                locationId: 'neon-docks',
                tags: ['crime'],
            },
            {
                turn: 3,
                date: '2037-03-02',
                summary: 'A hero is seen at the tower.',
                headline: 'HERO SPOTTED DOWNTOWN',
                actors: [],
                locationId: 'petrabyte-tower',
                tags: [],
            },
        ],
        beats: {
            's4.opening.arms-deal': { status: 'resolved', resolvedTurn: 2 },
            's4.escalation.outbreak': { status: 'adapted', adaptedFrom: 'Noah', adaptedTo: 'Ginny' },
            's4.climax.ice-age': { status: 'short-circuited', reason: 'villain defeated early' },
            's4.resolution.last-stand': { status: 'deferred', reason: 'waiting for the cast' },
        },
        ...patch,
    });
}

/* ------------------------------------------------------------------ *
 * Threat / faction / beat / headline views
 * ------------------------------------------------------------------ */

test('S4 renders two independent main threats with stage labels', () => {
    const state = worldState();
    const threats = buildThreatViews(state);
    const mains = threats.filter((threat) => threat.rank === 'main');
    assert.equal(mains.length, 2);
    assert.equal(mains[0].stageLabel, 'Collapse');
    assert.equal(mains[0].stageCount, 4);
    assert.equal(mains[0].progress, 55);
    assert.equal(mains[1].stageLabel, 'Frost');
    assert.ok(threats.find((threat) => threat.id === 's4.threat.cold-front').defeated);
});

test('threat progress clamps and never renders a raw number only', () => {
    const threats = buildThreatViews({
        threats: [{ id: 't', name: 'T', stages: ['A'], progress: 512, stage: 9 }],
    });
    assert.equal(threats[0].progress, 100);
    assert.equal(threats[0].stage, 0);
    assert.equal(threats[0].stageLabel, 'A');
});

test('faction views carry goals, influence, and hide disbanded factions by default', () => {
    const factions = buildFactionViews(worldState());
    assert.equal(factions.length, 2);
    assert.equal(factions[0].id, 'clarity');
    assert.ok(factions[0].dominant);
    assert.ok(factions[0].goals.length >= 2);
    assert.equal(factions[0].color, '#f43f5e');
    const withDisbanded = buildFactionViews(worldState(), { includeDisbanded: true });
    assert.equal(withDisbanded.length, 3);
});

test('beat views expose the current act, rumours, and a divergence indicator', () => {
    const views = buildBeatViews(worldState(), seasonS4);
    assert.ok(views.act);
    assert.ok(Array.isArray(views.rumors));
    assert.ok(views.rumors.length <= 2);
    assert.equal(views.divergence.hasDivergence, true);
    assert.ok(views.divergence.adapted.includes('s4.escalation.outbreak'));
    assert.ok(views.divergence.shortCircuited.includes('s4.climax.ice-age'));
    assert.ok(views.divergence.deferred.includes('s4.resolution.last-stand'));
    assert.match(views.divergence.label, /adapted/);

    const clean = buildBeatViews(baseState({ beats: {} }), seasonS4);
    assert.equal(clean.divergence.hasDivergence, false);
    assert.equal(clean.divergence.label, 'On the canon track');
});

test('headlines fall back to the event summary and are newest-first', () => {
    const headlines = buildHeadlineViews(worldState(), { limit: 2 });
    assert.equal(headlines.length, 2);
    assert.equal(headlines[0].headline, 'HERO SPOTTED DOWNTOWN');
    assert.equal(headlines[1].headline, 'ARMS FLOW THROUGH THE DOCKS');
    const fallback = buildHeadlineViews(worldState({ recentEvents: [{ turn: 1, summary: 'Nothing happens.' }] }));
    assert.equal(fallback[0].headline, 'Nothing happens.');
});

/* ------------------------------------------------------------------ *
 * Region / bridge styling
 * ------------------------------------------------------------------ */

function viewModel(state = null) {
    return buildMapViewModel({
        regions,
        bridges,
        keyLocations,
        overrides,
        districts,
        locations,
        state: state ?? baseState(),
    });
}

test('region styles tint by faction and dash by status', () => {
    const state = baseState({
        locations: {
            'central-plaza': { ...locations.locations[0], factionId: 'clarity', status: 'contested' },
        },
        factions: { clarity: { id: 'clarity', name: 'Clarity', side: 'villain', influence: 70, status: 'active' } },
    });
    const styles = buildRegionOverlayStyles(viewModel(state), state, { showFactionTint: true });
    const center = styles.find((style) => style.id === 'region:center');
    assert.equal(center.factionId, 'clarity');
    assert.equal(center.color, '#f43f5e');
    assert.equal(center.fillOpacity, 0.22);

    const noTint = buildRegionOverlayStyles(viewModel(state), state, { showFactionTint: false });
    const plain = noTint.find((style) => style.id === 'region:center');
    assert.equal(plain.fillOpacity, 0.12);
    assert.notEqual(plain.color, '#f43f5e');
});

test('a chat-scoped district status override tints and dashes the region', () => {
    const state = baseState();
    const next = setChatMapOverride(state, {
        layer: 'regions',
        key: 'Center',
        patch: { status: 'hostile', factionId: 'clarity' },
    });
    const vm = viewModel(next);
    const center = vm.regions.find((entry) => entry.id === 'region:center');
    assert.equal(center.status, 'hostile');
    assert.equal(center.factionId, 'clarity');
    const styles = buildRegionOverlayStyles(vm, next, { showFactionTint: true });
    assert.equal(styles.find((style) => style.id === 'region:center').dashArray, '4 4');
});

test('bridge styles expose open/contested/blocked/destroyed from live state', () => {
    const state = baseState();
    let next = setChatMapOverride(state, { layer: 'bridges', key: 'BridgeA', patch: { status: 'destroyed' } });
    next = setChatMapOverride(next, { layer: 'bridges', key: 'BridgeB', patch: { status: 'contested' } });
    const styles = buildBridgeOverlayStyles(viewModel(next));
    assert.equal(styles.find((style) => style.label === 'BridgeA').status, 'destroyed');
    assert.equal(styles.find((style) => style.label === 'BridgeB').status, 'contested');
    assert.equal(styles.find((style) => style.label === 'BridgeC').status, 'open');
});

test('the overlay model counts factions, threats, rumours, and headlines', () => {
    const state = worldState();
    const model = buildWorldOverlay({
        state,
        season: seasonS4,
        viewModel: viewModel(state),
        settings: { maxHeadlines: 5 },
    });
    assert.equal(model.hasWorld, true);
    assert.ok(model.act);
    assert.equal(model.counts.factions, 2);
    assert.equal(model.counts.threats, 3);
    assert.ok(model.counts.rumors <= 2);
    assert.equal(model.counts.headlines, 3);
    assert.ok(model.regionStyles.length > 0);
    assert.ok(model.bridgeStyles.length === 12);
    assert.ok(model.namedActivity.some((entry) => entry.headline));
});

test('overlay settings can hide sections without breaking the model', () => {
    const model = buildWorldOverlay({
        state: worldState(),
        season: seasonS4,
        viewModel: viewModel(),
        settings: { showThreats: false, showFactions: false, showHeadlines: false },
    });
    assert.equal(model.threats.length, 0);
    assert.equal(model.factions.length, 0);
    assert.equal(model.headlines.length, 0);
});

/* ------------------------------------------------------------------ *
 * Off-screen feed
 * ------------------------------------------------------------------ */

function offscreenState(patch = {}) {
    return worldState({
        locations: {
            'clarity-hq': {
                id: 'clarity-hq',
                name: 'Clarity Incorporated HQ',
                factionId: 'clarity',
                status: 'patrolled',
                present: [],
                visited: true,
            },
            'neon-docks': {
                id: 'neon-docks',
                name: 'Neon Docks',
                factionId: 'petrabyte',
                status: 'contested',
                present: [],
                visited: true,
            },
        },
        recentEvents: [
            { turn: 1, date: '2037-03-01', summary: 'Season begins.', actors: [], locationId: 'clarity-hq', tags: ['season-start'] },
            { turn: 2, date: '2037-03-02', summary: 'A quiet morning.', actors: [], locationId: 'neon-docks', tags: ['travel'] },
            {
                turn: 3,
                date: '2037-03-03',
                summary: 'Clarity patrols the docks.',
                headline: 'Patrols tighten at the docks',
                actors: [],
                locationId: 'neon-docks',
                tags: ['offscreen', 'tick', 'tick:15', 'faction:clarity'],
            },
            {
                turn: 4,
                date: '2037-03-04',
                summary: 'Resistance whispers spread near Clarity HQ.',
                headline: 'Whispers near the tower',
                actors: [],
                locationId: 'clarity-hq',
                tags: ['offscreen', 'tick', 'tick:20', 'faction:petrabyte', 'resistance'],
            },
            {
                turn: 5,
                date: '2037-03-05',
                summary: 'Smoke over an unmapped warehouse.',
                actors: [],
                locationId: 'ghost-location',
                tags: ['offscreen', 'tick', 'tick:25'],
            },
        ],
        ...patch,
    });
}

test('the off-screen feed is newest-first, capped, and names the actor and location', () => {
    const feed = buildOffscreenFeed(offscreenState(), { limit: 2 });
    assert.equal(feed.length, 2);
    assert.equal(feed[0].text, 'Smoke over an unmapped warehouse.');
    assert.equal(feed[0].locationId, 'ghost-location');
    // Unknown location degrades to the raw id, never undefined.
    assert.equal(feed[0].locationName, 'ghost-location');
    assert.equal(feed[0].factionId, null);
    assert.equal(feed[1].text, 'Whispers near the tower');
    // The actor comes from the faction tag, not from who controls the location.
    assert.equal(feed[1].factionName, 'PetraByte');
    assert.equal(feed[1].locationName, 'Clarity Incorporated HQ');
    assert.equal(feed[1].controlledByFactionName, 'Clarity Incorporated');

    const three = buildOffscreenFeed(offscreenState(), { limit: 3 });
    assert.equal(three.length, 3);
    assert.equal(three[2].factionName, 'Clarity Incorporated');
    assert.equal(three[2].controlledByFactionName, 'PetraByte');

    // The cap is 4 regardless of how many rows exist or what the caller asks.
    assert.equal(buildOffscreenFeed(offscreenState(), { limit: 99 }).length, 3);
});

test('an unknown faction tag degrades to the id instead of undefined', () => {
    const state = offscreenState();
    state.recentEvents.push({
        turn: 7,
        date: '2037-03-07',
        summary: 'A ghost faction moves.',
        headline: 'Ghost activity',
        actors: [],
        locationId: 'neon-docks',
        tags: ['offscreen', 'tick', 'tick:35', 'faction:ghost-faction'],
    });
    const feed = buildOffscreenFeed(state, { limit: 1 });
    assert.equal(feed[0].factionId, 'ghost-faction');
    assert.equal(feed[0].factionName, 'ghost-faction');
});

test('the off-screen feed passes through the content gate', () => {
    const state = offscreenState();
    state.recentEvents.push({
        turn: 6,
        date: '2037-03-06',
        summary: 'Graphic violence erupts near the docks. Traders flee.',
        headline: 'Graphic violence at the docks',
        actors: [],
        locationId: 'neon-docks',
        tags: ['offscreen', 'tick', 'tick:30'],
    });
    const strict = buildOffscreenFeed(state, { limit: 1, contentGate: 'strict' });
    assert.equal(strict.length, 1);
    assert.doesNotMatch(strict[0].summary, /Graphic violence/i);
    assert.match(strict[0].summary, /Traders flee/);
    assert.doesNotMatch(strict[0].headline, /Graphic violence/i);
    assert.doesNotMatch(strict[0].text, /Graphic violence/i);

    const full = buildOffscreenFeed(state, { limit: 1, contentGate: 'full' });
    assert.match(full[0].summary, /Graphic violence/);
});

test('per-player hard limits gate the feed even with a full global gate', () => {
    const state = offscreenState();
    state.recentEvents.push({
        turn: 6,
        date: '2037-03-06',
        summary: 'Graphic violence erupts near the docks. Traders flee.',
        headline: 'Graphic violence at the docks',
        actors: [],
        locationId: 'neon-docks',
        tags: ['offscreen', 'tick', 'tick:30'],
    });
    const feed = buildOffscreenFeed(state, {
        limit: 1,
        contentGate: 'full',
        contentLimits: { player: 'strict' },
    });
    assert.equal(feed.length, 1);
    assert.doesNotMatch(feed[0].text, /Graphic violence/i);
    assert.match(feed[0].text, /Traders flee/);
});

test('map.showOffscreen hides the model section and the markup section', () => {
    const state = offscreenState();
    const shown = buildWorldOverlay({
        state,
        season: seasonS4,
        viewModel: viewModel(state),
        settings: { showOffscreen: true },
    });
    assert.equal(shown.offscreen.length, 3);
    assert.equal(shown.counts.offscreen, 3);
    const markup = renderWorldOverlayMarkup(shown);
    assert.match(markup, /data-neoterra-overlay-section="offscreen"/);
    assert.match(markup, /City Desk \/ Off-screen/);
    assert.match(markup, /Whispers near the tower/);

    const hidden = buildWorldOverlay({
        state,
        season: seasonS4,
        viewModel: viewModel(state),
        settings: { showOffscreen: false },
    });
    assert.equal(hidden.offscreen.length, 0);
    assert.doesNotMatch(renderWorldOverlayMarkup(hidden), /data-neoterra-overlay-section="offscreen"/);

    // Empty feed renders no empty heading at all.
    const empty = buildWorldOverlay({ state: worldState(), season: seasonS4, viewModel: viewModel() });
    assert.equal(empty.offscreen.length, 0);
    assert.doesNotMatch(renderWorldOverlayMarkup(empty), /City Desk/);
    assert.equal(renderOffscreenFeed([]), '');
});

test('the overlay gate applies to markup headlines and activity, not just the city desk', () => {
    const state = offscreenState();
    state.recentEvents.push({
        turn: 6,
        date: '2037-03-06',
        summary: 'Graphic violence erupts near the docks. Traders flee.',
        headline: 'Graphic violence at the docks',
        actors: [],
        locationId: 'neon-docks',
        tags: ['offscreen', 'tick', 'tick:30', 'faction:clarity'],
    });
    const model = buildWorldOverlay({
        state,
        season: seasonS4,
        viewModel: viewModel(state),
        settings: { contentGate: 'strict' },
    });
    const markup = renderWorldOverlayMarkup(model);
    assert.doesNotMatch(markup, /Graphic violence/i);
    assert.equal(model.headlines.some((entry) => /Graphic violence/i.test(entry.headline)), false);
    assert.equal(
        model.namedActivity.some((entry) => /Graphic violence/i.test(entry.headline ?? '')),
        false,
    );
});

test('the feed tolerates malformed events and clamps invalid limits', () => {
    const state = offscreenState();
    state.recentEvents.push(null, { tags: 'not-an-array' }, { turn: 9, tags: ['offscreen'] });
    const feed = buildOffscreenFeed(state, { limit: 0 });
    assert.ok(feed.length >= 1);
    assert.ok(feed.length <= 4);
    assert.equal(buildOffscreenFeed({ recentEvents: 'nope' }).length, 0);
});

test('building the off-screen feed performs no network access', () => {    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
        calls += 1;
        throw new Error('the overlay must not fetch');
    };
    try {
        const model = buildWorldOverlay({
            state: offscreenState(),
            season: seasonS4,
            viewModel: viewModel(offscreenState()),
        });
        assert.ok(model.offscreen.length > 0);
        assert.equal(calls, 0);
    } finally {
        if (original === undefined) {
            delete globalThis.fetch;
        } else {
            globalThis.fetch = original;
        }
    }
});

/* ------------------------------------------------------------------ *
 * Overlay markup
 * ------------------------------------------------------------------ */

test('overlay markup renders every section and escapes content', () => {
    const state = worldState();
    const model = buildWorldOverlay({ state, season: seasonS4, viewModel: viewModel(state) });
    const markup = renderWorldOverlayMarkup(model);
    assert.match(markup, /data-neoterra-overlay-section="threats"/);
    assert.match(markup, /data-neoterra-overlay-section="factions"/);
    assert.match(markup, /data-neoterra-overlay-section="beats"/);
    assert.match(markup, /data-neoterra-overlay-section="headlines"/);
    assert.match(markup, /Collapse/);
    assert.match(markup, /Clarity Incorporated/);
    assert.match(markup, /HERO SPOTTED DOWNTOWN/);
    assert.equal(escapeOverlayHtml('<script>'), '&lt;script&gt;');
    assert.match(renderThreatOverlay([{ id: 'x', name: '<b>evil</b>', progress: 10, stages: ['a'], stage: 0 }]), /&lt;b&gt;evil/);
    assert.match(renderFactionOverlay([]), /No active factions/);
    assert.match(renderHeadlines([]), /No headlines yet/);
    assert.match(renderBeatOverlay(null), /^$/);
    assert.match(renderWorldOverlayMarkup(null), /Start a season/);
    assert.match(renderActivityOverlay([]), /No activity/);
    assert.match(renderActivityOverlay([
        { id: 'central-plaza', name: 'Central Plaza', headline: 'Gunfire at the plaza', turn: 3 },
    ]), /Gunfire at the plaza/);
});

test('the overlay hides rumours when configured but keeps the divergence fact', () => {
    const model = buildWorldOverlay({
        state: worldState(),
        season: seasonS4,
        viewModel: viewModel(),
        settings: { showRumors: false },
    });
    assert.equal(model.beats.rumors.length, 0);
    assert.equal(model.beats.divergence.hasDivergence, true);
});

test('the editor offers a parent-district select for regions when districts are supplied', () => {
    const region = viewModel().regions.find((entry) => entry.label === 'Center');
    const withDistricts = buildEditorSchema(region, { districts: districts.districts });
    const field = withDistricts.fields.find((entry) => entry.name === 'districtId');
    assert.ok(field);
    assert.equal(field.type, 'select');
    assert.equal(field.value, 'downtown');
    const patch = editorValuesToPatch(withDistricts, { districtId: 'harbor' });
    assert.equal(patch.districtId, 'harbor');
    // Clearing a required district is ignored rather than written as null.
    assert.equal(editorValuesToPatch(withDistricts, { districtId: '' }).districtId, undefined);
});

test('overlay markup is accessible and collapsible', () => {
    const markup = renderWorldOverlayMarkup(
        buildWorldOverlay({ state: worldState(), season: seasonS4, viewModel: viewModel() }),
        { collapsed: true },
    );
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /role="progressbar"/);
    assert.match(markup, /aria-valuenow="55"/);
});

/* ------------------------------------------------------------------ *
 * Global override editing
 * ------------------------------------------------------------------ */

test('every feature kind maps to an override layer', () => {
    for (const kind of EDITABLE_FEATURE_KINDS) {
        assert.ok(overrideTargetFor({ kind, id: 'x', label: 'Label' }));
    }
    assert.equal(overrideTargetFor({ kind: 'unknown' }), null);
    assert.equal(overrideTargetFor(null), null);
    assert.deepEqual(overrideTargetFor({ kind: 'region', label: 'Center' }), {
        layer: 'regions',
        key: 'Center',
        scope: 'global',
        chatLayer: 'regions',
        chatKey: 'Center',
    });
    assert.deepEqual(overrideTargetFor({ kind: 'namedLocation', id: 'central-plaza' }), {
        layer: 'namedLocations',
        key: 'central-plaza',
        scope: 'chat',
    });
    // Bridges/regions expose a per-chat timeline scope too.
    assert.equal(supportsChatStatus(buildEditorSchema({ kind: 'bridge', label: 'BridgeA' })), true);
    assert.equal(supportsChatStatus(buildEditorSchema({ kind: 'namedLocation', id: 'central-plaza' })), true);
    assert.equal(supportsChatStatus(null), false);
});

test('the editor schema exposes the fields each layer accepts', () => {
    const vm = viewModel();
    const region = vm.regions.find((entry) => entry.label === 'Center');
    const schema = buildEditorSchema(region, { factions: factionsDocument.factions });
    assert.equal(schema.layer, 'regions');
    assert.deepEqual(schema.fields.map((field) => field.name), ['name', 'description', 'factionId', 'status']);
    assert.equal(schema.chatLayer, 'regions');
    assert.equal(schema.chatKey, 'Center');

    const bridge = vm.bridges.find((entry) => entry.label === 'BridgeA');
    assert.equal(buildEditorSchema(bridge).fields.some((field) => field.name === 'status'), true);

    const location = vm.namedLocations.find((entry) => entry.id === 'central-plaza');
    const locationSchema = buildEditorSchema(location, { factions: factionsDocument.factions });
    assert.equal(locationSchema.layer, 'namedLocations');
    assert.deepEqual(
        locationSchema.fields.map((field) => field.name),
        ['name', 'description', 'status', 'factionId', 'x', 'y'],
    );

    for (const field of [...schema.fields, ...locationSchema.fields]) {
        assert.match(renderEditorField(field), new RegExp(`data-neoterra-editor-field="${field.name}"`));
    }
});

test('editor values become a validated patch and reject bad input', () => {
    const location = viewModel().namedLocations.find((entry) => entry.id === 'central-plaza');
    const schema = buildEditorSchema(location);
    const patch = editorValuesToPatch(schema, {
        name: 'The Plaza',
        description: 'Heart of the city.',
        status: 'contested',
        factionId: 'clarity',
        x: '1000',
        y: '700',
    });
    assert.deepEqual(patch, {
        name: 'The Plaza',
        description: 'Heart of the city.',
        status: 'contested',
        factionId: 'clarity',
        x: 1000,
        y: 700,
    });

    const bad = validateEditorPatch(schema, { name: 'X', status: 'on-fire', x: '5000', y: '-3' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((error) => error.field === 'status'));
    assert.ok(bad.errors.some((error) => error.field === 'x'));
    assert.ok(bad.errors.some((error) => error.field === 'y'));

    const cleared = validateEditorPatch(schema, { name: 'X', description: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.patch.description, null);
});

test('global edits survive reload, validate, and reset to the generated default', () => {
    const exported = exportMapOverrides(overrides);
    const parsed = parseMapOverrides(exported);
    assert.equal(parsed.ok, true);
    assert.equal(validateMapOverrides(parsed.document).ok, true);

    const region = viewModel().regions.find((entry) => entry.label === 'Center');
    const schema = buildEditorSchema(region, { factions: factionsDocument.factions });
    const applied = applyEditorPatch(parsed.document, schema, {
        name: 'Central Plaza',
        description: 'The heart of Neo Terra.',
        factionId: 'clarity',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.document.regions.Center.name, 'Central Plaza');
    assert.equal(applied.document.regions.Center.factionId, 'clarity');
    assert.equal(validateMapOverrides(applied.document).ok, true);

    // Round-trip through the exported file text.
    const roundTrip = parseMapOverrides(exportMapOverrides(applied.document));
    assert.equal(roundTrip.ok, true);
    assert.equal(roundTrip.document.regions.Center.name, 'Central Plaza');

    const reset = resetEditorOverride(roundTrip.document, schema);
    assert.equal(reset.ok, true);
    assert.equal(reset.document.regions.Center.name, undefined);
    assert.equal(reset.document.regions.Center.districtId, 'downtown');

    const deleted = deleteEditorOverride(reset.document, schema);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.document.regions.Center, undefined);
});

test('reset and delete keep structural bindings and reject unknown layers', () => {
    const reset = resetMapOverride(overrides, { layer: 'bridges', label: 'BridgeA' });
    assert.equal(reset.bridges.BridgeA, undefined);
    const resetKey = resetMapOverride(overrides, { layer: 'keyLocations', label: 'BigOfficeB' });
    assert.deepEqual(resetKey.keyLocations.BigOfficeB, { locationId: 'petrabyte-tower' });
    assert.throws(() => resetMapOverride(overrides, { layer: 'nope', label: 'x' }), /Unknown map override layer/);
    assert.throws(() => applyMapOverride(overrides, { layer: 'regions', label: '', patch: {} }), /non-empty label/);
    assert.throws(() => deleteMapOverride(overrides, { layer: 'regions', label: '' }), /non-empty label/);
});

test('parseMapOverrides tolerates fences and rejects invalid JSON and drift', () => {
    const fenced = parseMapOverrides(`\`\`\`json\n${JSON.stringify(overrides)}\n\`\`\``);
    assert.equal(fenced.ok, true);
    assert.equal(parseMapOverrides('').ok, false);
    assert.equal(parseMapOverrides('{oops').ok, false);
    // Structural drift is rejected (a cross-file district check needs context,
    // so it runs in `loadMapOverrides`, not in the text parser).
    const invalid = JSON.parse(JSON.stringify(overrides));
    invalid.schemaVersion = 7;
    const drift = parseMapOverrides(JSON.stringify(invalid));
    assert.equal(drift.ok, false);
    assert.ok(drift.errors.some((error) => /must be 1/.test(error.message)));
});

/* ------------------------------------------------------------------ *
 * Per-chat isolation and the editor's chat scope
 * ------------------------------------------------------------------ */

test('a chat override changes only that chat and exports as JSON', () => {
    const chatA = setChatMapOverride(baseState(), {
        layer: 'bridges',
        key: 'BridgeC',
        patch: { status: 'blocked' },
    });
    const chatB = baseState();
    const stylesA = buildBridgeOverlayStyles(viewModel(chatA));
    const stylesB = buildBridgeOverlayStyles(viewModel(chatB));
    assert.equal(stylesA.find((style) => style.label === 'BridgeC').status, 'blocked');
    assert.equal(stylesB.find((style) => style.label === 'BridgeC').status, 'open');

    const exported = JSON.parse(exportChatMapOverrides(chatA));
    assert.equal(exported.bridges.BridgeC.status, 'blocked');
    assert.equal(getChatMapOverrides(chatB).bridges.BridgeC, undefined);
    // The authored file is untouched.
    assert.equal(overrides.bridges.BridgeC.status, 'open');
});

test('editor markup includes save, reset, delete, export, and import controls', () => {
    const vm = viewModel();
    const location = vm.namedLocations.find((entry) => entry.id === 'central-plaza');
    const markup = renderMapEditor(buildEditorSchema(location), {
        globalOverrides: overrides,
        chat: getChatMapOverrides(baseState()),
    });
    for (const hook of ['editor-save', 'editor-reset', 'editor-delete', 'editor-export', 'editor-import', 'editor-reset-chat']) {
        assert.match(markup, new RegExp(`data-neoterra-${hook}`));
    }
    assert.match(renderVirtualNodeForm({ defaultPoint: { x: 10, y: 20 } }), /data-neoterra-node-add/);
    assert.match(renderVirtualNodeForm({}), /data-neoterra-node-field="connections"/);
    assert.match(renderVirtualNodeForm({ defaultPoint: { x: 10, y: 20 } }), /value="10"/);
    assert.equal(renderMapEditor(null), '');
});

test('all 36 districts, 12 bridges, and 22 key locations are editable targets', () => {
    const vm = viewModel();
    assert.equal(vm.regions.length, 36);
    assert.equal(vm.bridges.length, 12);
    assert.equal(vm.keyLocations.length, 22);
    for (const feature of [...vm.regions, ...vm.bridges, ...vm.keyLocations, ...vm.namedLocations]) {
        const schema = buildEditorSchema(feature, { factions: factionsDocument.factions });
        assert.ok(schema, `missing editor schema for ${feature.id}`);
        assert.ok(MAP_OVERRIDE_LAYERS.includes(schema.layer));
    }
});

test('the named-location status vocabulary mirrors the location registry', () => {
    assert.deepEqual([...MAP_LOCATION_STATUSES].sort(), [...LOCATION_STATUSES].sort());
});

test('the named-location override layer validates status and coordinates', () => {
    const document = JSON.parse(JSON.stringify(overrides));
    document.namedLocations = {
        'central-plaza': { status: 'contested', x: 1000, y: 700 },
    };
    assert.equal(validateMapOverrides(document).ok, true);
    document.namedLocations['central-plaza'].status = 'on-fire';
    assert.equal(validateMapOverrides(document).ok, false);
    document.namedLocations['central-plaza'] = { status: 'peaceful', x: 'left' };
    assert.equal(validateMapOverrides(document).ok, false);
    document.namedLocations = [];
    assert.equal(validateMapOverrides(document).ok, false);
});

test('map overlay settings ship enabled with sensible defaults and migrate', () => {
    assert.equal(DEFAULT_SETTINGS.map.showOverlay, true);
    assert.equal(DEFAULT_SETTINGS.map.editorEnabled, true);
    assert.equal(DEFAULT_SETTINGS.map.maxHeadlines, 5);
    const migrated = migrateSettings({ schemaVersion: 1, map: { showFogOfWar: true } });
    assert.equal(migrated.map.showFogOfWar, true);
    assert.equal(migrated.map.showOverlay, true);
    assert.equal(migrated.map.maxHeadlines, 5);
    const clamped = migrateSettings({ schemaVersion: 1, map: { maxHeadlines: 99, showThreats: 'yes' } });
    assert.equal(clamped.map.maxHeadlines, 20);
    assert.equal(clamped.map.showThreats, true);
});

test('the S1 ledger view still resolves an act for a fresh world', () => {
    const state = baseState({ beats: {} });
    const views = buildBeatViews(state, seasonS1);
    assert.equal(views.act, 'opening');
    assert.ok(views.rumors.length >= 1);
    assert.equal(views.divergence.hasDivergence, false);
});
