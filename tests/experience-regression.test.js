/**
 * Experience regression suite.
 *
 * One test per P0/P1 fix from `docs/experience-audit.md`, kept deliberately
 * small and end-to-end so a refactor cannot quietly un-ship a shipped fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { directorCardStatus } from '../src/ui/director-card.js';
import { renderSetupStrip } from '../src/ui/season-menu.js';
import { buildPlayerSheet } from '../src/ui/player-panel.js';
import { buildSessionHomeView, buildPreviouslyOn } from '../src/ui/session-home.js';
import { buildHudView } from '../src/ui/hud.js';
import { renderJournalMarkup, buildJournalEntries } from '../src/ui/journal.js';
import { windowMarkup, clampWindowGeometry } from '../src/ui/window-manager.js';
import { readLastTab, rememberLastTab, hasWorldInChat } from '../src/ui/shell.js';
import { SHELL_TABS } from '../src/core/constants.js';
import { buildDowntimePlan, createDowntimeFlow, DOWNTIME_ACTIONS } from '../src/flows/downtime.js';
import { resolveIdentitySelection } from '../src/flows/season-start.js';
import { buildGeneratedFormsExport } from '../src/ui/codex-data.js';
import { resolveAvatarForEntry } from '../src/data/avatars.js';
import { buildSceneMeta } from '../src/ui/scene-decorator.js';
import { buildErrorToasts } from '../src/ui/toasts.js';
import { TURN_STAGE_ORDER } from '../src/ui/turn-status.js';
import { createWorldStateStore } from '../src/state/store.js';
import { createWorldState } from '../src/state/world-state.js';
import { applyWorldEvent } from '../src/state/reducer.js';
import { DEFAULT_SETTINGS } from '../src/core/defaults.js';
import { EXTENSION_VERSION } from '../src/core/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

const registry = readJson('data/characters/index.json');
const factions = readJson('data/factions.json');
const locations = readJson('data/locations.json');
const formGroups = readJson('data/form-groups.json');
const formRules = readJson('data/form-rules.json');
const profiles = readJson('data/characters/profiles.json').profiles;
const season = readJson('data/seasons/s1.json');
const otherSeason = readJson('data/seasons/s4.json');
const CONTEXT = { registry, factions, locations, formGroups, formRules };

function makeStore(seasonDoc = season) {
    const store = createWorldStateStore({
        metadata: {},
        chatId: 'experience-regression-chat',
        storage: null,
        schedule: () => 1,
        cancel: () => {},
        context: CONTEXT,
    });
    store.seed({
        season: seasonDoc,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'experience-regression-chat',
        player: { identity: 'custom', displayName: 'Alex' },
    });
    return store;
}

/* ------------------------------------------------------------------ */
/* P0 fixes                                                            */
/* ------------------------------------------------------------------ */

test('P0-1: the setup strip reports an installed Director card and hides the download CTA', () => {
    const installed = renderSetupStrip({ directorInstalled: true, mode: 'director' });
    assert.match(installed, /Director card — installed/);
    assert.doesNotMatch(installed, /data-neoterra-download-director/);

    const missing = renderSetupStrip({ directorInstalled: false, mode: 'director' });
    assert.match(missing, /Director card — not installed/);
    assert.match(missing, /data-neoterra-download-director/);

    const status = directorCardStatus({
        characters: [{ name: 'Neo Terra — Director', avatar: 'neoterra-director.png' }],
    });
    assert.equal(status.installed, true);
    assert.equal(
        directorCardStatus({ characters: [{ name: 'Someone Else' }] }).installed,
        false,
    );
});

test('P0-2: the Player sheet is live for both a custom persona and a canon identity', () => {
    const custom = makeStore().get();
    const customSheet = buildPlayerSheet({ state: custom, season, registry });
    assert.ok(customSheet);
    assert.equal(customSheet.displayName, 'Alex');
    assert.ok(Array.isArray(customSheet.resources) && customSheet.resources.length >= 2);

    const canon = structuredClone(custom);
    canon.player = {
        ...canon.player,
        identity: 'canon',
        characterId: 's1.vaiva.colorgarde',
        formId: 's1.vaiva.colorgarde',
    };
    const canonSheet = buildPlayerSheet({ state: canon, season, registry });
    assert.ok(canonSheet);
    assert.match(canonSheet.displayName, /Vaiva/i);

    // The shell must mount the live panel, not the old placeholder.
    const shellSource = readFileSync(join(ROOT, 'src/ui/shell.js'), 'utf8');
    assert.match(shellSource, /LIVE_PANELS = new Set\(\[[^\]]*'player'/);
    assert.match(shellSource, /data-neoterra-player-host/);
    assert.match(shellSource, /mountPlayerPanel\(/);
});

test('P0-3: Session Home replaces the season grid whenever a world exists', () => {
    const state = makeStore().get();
    const home = buildSessionHomeView({ state, season, registry, locations });
    assert.ok(home);
    assert.match(home.title, /Season 1/);
    assert.ok(home.actions.some((action) => action.id === 'continue'));
    assert.ok(home.actions.some((action) => action.id === 'map'));
    assert.ok(home.previouslyOn.length > 0);
    assert.equal(buildSessionHomeView({ state: null, season, registry, locations }), null);
    assert.match(buildPreviouslyOn(state, season), /\S/);
});

test('P0-3: the last tab is remembered per chat and unknown values are ignored', () => {
    const stored = { chatMetadata: { neoterra: { ui: { lastTab: 'player' } } } };
    const unknown = { chatMetadata: { neoterra: { ui: { lastTab: 'nope' } } } };
    assert.equal(readLastTab(stored), 'player');
    assert.equal(readLastTab(unknown), null);
    assert.equal(readLastTab({}), null);
    assert.ok(SHELL_TABS.some((tab) => tab.id === 'player'));

    const metadata = { neoterra: { schemaVersion: 1 } };
    let saved = 0;
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = {
        getContext: () => ({
            chatMetadata: metadata,
            saveMetadataDebounced: () => { saved += 1; },
        }),
    };
    try {
        assert.equal(rememberLastTab('player'), true);
        assert.deepEqual(metadata.neoterra.ui, { lastTab: 'player' });
        assert.equal(saved, 1);
        // Only the neoterra.ui slot is written.
        assert.deepEqual(Object.keys(metadata.neoterra).sort(), ['schemaVersion', 'ui']);
    } finally {
        if (previous === undefined) {
            delete globalThis.SillyTavern;
        } else {
            globalThis.SillyTavern = previous;
        }
    }
});

test('P1-3: the no-world Map shows a single Start a season CTA', () => {
    assert.equal(hasWorldInChat({ chatMetadata: { neoterra: { worldState: {} } } }), true);
    assert.equal(hasWorldInChat({ chatMetadata: { neoterra: {} } }), false);
    assert.equal(hasWorldInChat({}), false);
    const source = readFileSync(join(ROOT, 'src/ui/shell.js'), 'utf8');
    assert.match(source, /if \(!hasWorldInChat\(context\)\)/);
    assert.match(source, /data-neoterra-map-empty/);
    assert.match(source, /data-neoterra-start-season/);
    // The CTA is delegated from the window layer, not only from the modal.
    assert.match(source, /windowManager\?\.layer\?\.addEventListener\('click'/);
    assert.match(source, /windowManager\?\.close\('map'\)/);
});

test('P0-5: a real TRANSFORM applies the target form profile and reverting restores the base', () => {
    const state = createWorldState({
        season,
        registry,
        factions,
        locations,
        formGroups,
        formRules,
        profiles,
        chatId: 'transform-regression-chat',
        player: { identity: 'custom' },
        now: 1,
    });
    const vaiva = 's1.vaiva.colorgarde';
    const lightShade = 's1.light.shade.corrupted.colorgarde';
    const base = state.characters[vaiva];
    assert.ok(base.formProfiles[lightShade]);

    const transformed = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: vaiva, formId: lightShade },
        CONTEXT,
    ).characters[vaiva];
    assert.equal(transformed.formId, lightShade);
    assert.equal(transformed.profileFormId, lightShade);
    assert.match(transformed.appearance, /Light Shade/);
    assert.deepEqual(transformed.abilities, transformed.formProfiles[lightShade].abilities);
    assert.deepEqual(transformed.stamina, base.stamina);

    const revertedBase = 's1.claire.atropos';
    const revertedAlt = 's1.claire.lachesis.cleansed.claire.atropos';
    const claireBase = state.characters[revertedBase];
    const claireTransformed = applyWorldEvent(
        state,
        { type: 'TRANSFORM', characterId: revertedBase, formId: revertedAlt },
        CONTEXT,
    );
    const reverted = applyWorldEvent(
        claireTransformed,
        { type: 'TRANSFORM', characterId: revertedBase, formId: revertedBase },
        CONTEXT,
    ).characters[revertedBase];
    assert.equal(reverted.formId, revertedBase);
    assert.equal(reverted.appearance, claireBase.appearance);
    assert.deepEqual(reverted.abilities, claireBase.abilities);
});

test('P0-6: a warned guest still resolves across seasons and a disabled guest is rejected', () => {
    const guest = otherSeason.roster[0].characterId;
    const result = resolveIdentitySelection(
        season,
        { identity: 'canon', characterId: guest, warningAccepted: true },
        { registry, allowGuests: true, requireGuestAcknowledgement: true },
    );
    assert.equal(result.characterId, guest);
    assert.equal(result.guest, true);

    assert.throws(() => resolveIdentitySelection(
        season,
        { identity: 'canon', characterId: guest, warningAccepted: true },
        { registry, allowGuests: false },
    ));
});

test('P0-7: avatar resolution never swaps portraits on an ambiguous short name', () => {
    const ambiguous = {
        entries: [
            { id: 'a', displayName: 'Claire', aliases: ['Claire'] },
            { id: 'b', displayName: 'Claire', aliases: ['Claire'] },
        ],
    };
    const resolved = resolveAvatarForEntry(ambiguous.entries[0], {
        registry: ambiguous,
        characters: [
            { name: 'Claire', avatar: 'one.png' },
            { name: 'Claire', avatar: 'two.png' },
        ],
        manifest: null,
        overrides: {},
    });
    assert.equal(resolved?.url ?? null, null);
});

test('P0-8/P0-9: the agent log, stage chip, and error toasts exist and are reachable', () => {
    assert.ok(TURN_STAGE_ORDER.includes('lore'));
    assert.ok(TURN_STAGE_ORDER.includes('auditor'));
    const errors = buildErrorToasts([{ stage: 'tracker', error: 'timeout' }], {
        detailsHref: '#neoterra-agent-log',
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].href, '#neoterra-agent-log');
    const shellSource = readFileSync(join(ROOT, 'src/ui/shell.js'), 'utf8');
    assert.match(shellSource, /mountAgentLog/);
    assert.match(shellSource, /openWindowTab\('log'\)/);
});

/* ------------------------------------------------------------------ */
/* Milestones 2-4 surfaces                                             */
/* ------------------------------------------------------------------ */

test('the Journal renders a recap and a deduped timeline', () => {
    const state = makeStore().get();
    const withEvents = structuredClone(state);
    withEvents.recentEvents = [
        { turn: 1, summary: 'A quiet event.', tags: ['event'] },
        { turn: 1, summary: 'A quiet event.', tags: ['event'] },
    ];
    const entries = buildJournalEntries(withEvents, season);
    assert.equal(entries.length, 1);
    const markup = renderJournalMarkup({
        recap: 'Previously on…',
        entries,
    });
    assert.match(markup, /Previously on/);
    assert.match(markup, /A quiet event/);
});

test('the HUD is hidden without a world and gameplay-only with one', () => {
    assert.equal(buildHudView({ state: null, season }), null);
    const view = buildHudView({ state: makeStore().get(), season, registry, locations });
    assert.ok(view?.visible);
    const ids = view.actions.map((action) => action.id);
    for (const forbidden of ['settings', 'export', 'import', 'agents']) {
        assert.equal(ids.includes(forbidden), false);
    }
});

test('floating window geometry is clamped into the viewport', () => {
    const clamped = clampWindowGeometry(
        { x: 5000, y: -300, width: 4000, height: 3000 },
        { width: 1280, height: 800 },
    );
    assert.ok(clamped.x >= 0 && clamped.x + clamped.width <= 1280);
    assert.ok(clamped.y >= 0 && clamped.y + clamped.height <= 800);
    const markup = windowMarkup({ id: 'map', title: 'City Map', geometry: clamped });
    assert.match(markup, /data-neoterra-window="map"/);
});

test('scene metadata carries location, time, and present cast for the decorator', () => {
    const state = makeStore().get();
    const meta = buildSceneMeta({
        locationId: state.scene.locationId,
        locationName: state.locations?.[state.scene.locationId]?.name ?? null,
        timeSlot: state.meta.timeOfDay,
        present: state.scene.present,
    });
    assert.ok(meta);
    assert.equal(meta.location.id, state.scene.locationId);
    assert.ok(Array.isArray(meta.present));
});

test('downtime actions are deterministic, bounded, and agent-free', async () => {
    const store = makeStore();
    const flow = createDowntimeFlow({
        store,
        season,
        getSettings: () => ({ agents: { stateTracker: { enabled: false }, storyline: { enabled: false } } }),
    });
    const before = store.get().meta.turn;
    const result = await flow.perform('rest');
    assert.equal(result.ok, true);
    assert.equal(store.get().meta.turn, before + 1);
    for (const action of DOWNTIME_ACTIONS) {
        const plan = buildDowntimePlan({ actionId: action.id, state: store.get(), season });
        assert.equal(plan.ok, true, action.id);
    }
});

test('a generated-forms export keeps the generated flag and schema version', () => {
    const state = {
        chatId: 'chat-1',
        flags: {
            generatedForms: {
                's1.vaiva.colorgarde': {
                    's1.vaiva.light-shade': { generated: true, formId: 's1.vaiva.light-shade' },
                },
            },
        },
    };
    const payload = buildGeneratedFormsExport(state);
    assert.equal(payload.kind, 'neoterra-generated-forms');
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.chatId, 'chat-1');
    const roundTrip = JSON.parse(JSON.stringify(payload));
    assert.equal(
        roundTrip.generatedForms['s1.vaiva.colorgarde']['s1.vaiva.light-shade'].generated,
        true,
    );
});

test('the content gate is honoured by generated downtime text and shipped defaults', () => {
    assert.equal(DEFAULT_SETTINGS.contentGate, 'full');
    assert.equal(DEFAULT_SETTINGS.ending.dynamic, false);
    assert.equal(DEFAULT_SETTINGS.agents.architect.seasonStart, false);
    assert.equal(DEFAULT_SETTINGS.badEnds.enabled, false);

    const state = makeStore().get();
    const plan = buildDowntimePlan({
        actionId: 'socialize',
        state,
        season,
        settings: { contentGate: 'strict', contentLimits: {} },
        events: ['An explicit sex scene and graphic violence unfold in {location}.'],
    });
    assert.equal(plan.ok, true);
    assert.doesNotMatch(plan.summary, /explicit sex|graphic violence/i);
});

test('version strings agree across package.json, manifest.json, and EXTENSION_VERSION', () => {
    const pkg = readJson('package.json');
    const manifest = readJson('manifest.json');
    assert.equal(String(pkg.version), String(manifest.version));
    assert.equal(String(EXTENSION_VERSION), String(pkg.version));
});
