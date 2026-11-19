# Travel feedback follow-up (Spike B implementation)

## Meta
- Slug: travel-feedback-followup
- Status: complete (steps 1–6 complete — 5cec295, da48b78, b61e3fc, b25c093, 1ce1d89, 21349b6)
- Date: 2026-11-19
- Evidence: `docs/travel-feedback-research.md`, `plans/spikes/travel-feedback/notes.md`
- Upstream: `plans/neoterra-experience-audit.md` (Spike B, step 21), `docs/map-authoring.md` §"No world and returning to chat"

## Summary
- **Goal:** ship the three production cues the spike report asks for: a real arrival toast driven by the travel flow, a Return-to-chat pulse on the map toolbar when an arrival happens with the map open, and a structured arrival summary (destination / time slot / encounter) in the map sidebar that survives close–reopen. Then re-run the three scripted runs and record the evidence. `map.closeOnTravel` stays `true` (decided 2026-11-19); this plan ships the cues and documents the decision, it does not flip the default.
- **Context:** Spike B measured close-on-travel vs keep-open vs keep-open+injected toast. It concluded that keep-open is currently worse only because nothing announces the arrival at the point of attention and the sidebar shows the threat/pacing card instead of the arrival. The prototype toast + Return pulse was measured but never implemented. This plan implements it for real, from the travel flow rather than the turn diff, behind one settings toggle — and keeps close-on-travel as the default.

## Current State (from exploration)
Travel flow today (verified):
- HUD Map button → `openWindowTab('map')` → `mountMapPanelComponent(..., { hosted: true })` (`src/ui/shell.js:1025,1520`).
- Key-location click → `selectFeature` (`src/ui/map-panel.js:765`) → `buildMapSubmenu` (`src/data/map.js:1473`) → `paintSide`.
- `[data-neoterra-map-travel]` (`map-panel.js:526`) → `openTravel` (`map-panel.js:791`) → host handler `buildMapTravelHandler` (`shell.js:1448`) → `travel.travel({to})` (`src/flows/travel.js:422`).
- `travel()` returns `{ ok, from, to, fromName, toName, path, bridges, bridgeNames, distance, turns, modes, ability, tracker, cast, intro, messageExtra, state }` (`travel.js:554-575`). `state.scene.encounter` was written by `refreshCast({ encounterSource: 'travel' })`; `state.meta.timeOfDay` holds the slot (`TIME_SLOTS` in `src/core/constants.js:22`).
- `announce` (`shell.js:1484`) → `panelRef.refresh()`, `bus.emit(MAP_UPDATED, { travel, intro })`, `shouldCloseAfterTravel(posted, settings)` (`shell.js:1441`), `closeMapSurface()` (`shell.js:1117` → `windowManager.close('map')`). Close is driven by the travel flow, **not** the turn diff.
- The only travel toast today is `diffWorldState(beforeTravel, after)` at `shell.js:1478` — cast arrivals/departures, no destination cue.
- `postTravelOutcome` (`shell.js:1363`) posts the arrival scene frame, then calls `onPosted` before the CYOA round-trip.
- Sidebar: `paintSide` (`map-panel.js:1418`) already renders a prose "Arrival" block from `state.lastIntro` (`map-panel.js:1476-1485`), set only by the `MAP_UPDATED` handler (`map-panel.js:612-624`). It is not structured and is lost on window close, because `disposeMapPanel` drops the module singleton.
- Toolbar already has `[data-neoterra-map-return]` ("Return to chat", `map-panel.js:675`) wired to the close handler (`map-panel.js:512`).
- Toasts: `diffWorldState` (`src/ui/toasts.js:62`), `renderToastMarkup` (`:206`), `mountToasts` (`:226`, ttl 6500 ms, max 5). `ensureToasts` (`shell.js:2500`) mounts once into `document.body`, so the stack survives the map window closing.

Key files:
- `src/ui/shell.js` — travel handler, `postTravelOutcome`, `announce`, `closeMapSurface`, toast stack.
- `src/ui/map-panel.js` — panel mount, `paintSide`, toolbar, `MAP_UPDATED` subscription.
- `src/ui/toasts.js` — pure diff + markup + mount.
- `src/flows/travel.js`, `src/flows/scene.js` (`buildLocationIntro` `:172`), `src/flows/encounter.js` (`describeEncounter` `:137`).
- `src/core/defaults.js:324`, `src/core/migrations.js:381`, `src/ui/settings.html:506` — map settings.
- `tests/map-model.test.js:788` (`closeOnTravel` behavior), `tests/travel.test.js`, `tests/experience-regression.test.js`.

Landmines:
- `announce` calls `panelRef.refresh()` **and** emits `MAP_UPDATED`, which refreshes again. Any new hop must be idempotent.
- `disposeMapPanel` clears the panel singleton, so anything that must survive close–reopen has to be derived from `WorldState` (or persisted per chat), not from panel memory.
- `shouldCloseAfterTravel` returns `true` for a `deduped` frame too.
- The existing cast-arrival toast id is `arrival:<charId>`; a travel toast must use a different id namespace.
- `lastIntro` is only set when `result.ok` and is overwritten on every subsequent travel `MAP_UPDATED`.
- There is no test for the current sidebar arrival block.

## Constraints & Requirements
- **Tech stack:** vanilla ES modules, no bundler, no runtime dependencies; DOM code stays in `src/ui`, pure logic in `src/data`/`src/ui` helpers testable with `node --test`.
- **State contract:** `WorldState` remains the only authority. The arrival summary must be derivable from `flags.travel.*`, `meta.timeOfDay`, `scene`, and `locations`, so it survives remounts. UI-only dismissal notes may live under `chatMetadata.neoterra.ui`.
- **No default change, by decision:** `map.closeOnTravel` stays `true`. Approved 2026-11-19 after the spike review; the cues ship for keep-open users, the default does not move.
- **Out of scope:** a district-control overlay, map styling changes, mobile sheet redesign, backend/latency work, changing the scene-frame text, or moving choices.

## Assumptions & Open Questions
Assumptions:
1. `state.scene.encounter` is the arrival encounter when the cast refresh succeeded; when it failed, the stale-encounter guard in `describeEncounter` already blanks it, so the summary must reuse that guard rather than reading `encounter` raw.
2. The arrival summary is also the correct place for "no hostiles detected", instead of omitting the encounter line.
3. Toast ttl can be raised per push (travel toast ~9 s) without changing the global default.
4. `prefers-reduced-motion` is an acceptable way to disable the pulse animation.

Decisions (approved 2026-11-19):
1. **`map.closeOnTravel` stays `true`.** Ship the cues, re-run the spike, and record the evidence; no default flip in this milestone. Users who want keep-open flip the existing setting themselves.
2. **Toast action only when the map stays open.** In close-on-travel the toast is informational; in keep-open it carries a "Return to chat" action.
3. **The arrival summary lives until the next travel.** No turn-based expiry. Dismiss hides it for that arrival only; the next travel replaces it (persisted per chat so it survives close–reopen).

## Step-by-Step Implementation Plan

### 1. Pure arrival summary builder — ✅ complete (5cec295)
- **Files:** `src/ui/arrival-summary.js` (new), `tests/arrival-summary.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** `buildArrivalSummary({ result = null, state, season = null })` returns `null` unless a completed arrival is available (`result.ok` or `state.flags.travel.lastTo`). Shape: `{ key, fromId, toId, destination, district, timeSlot, turns, encounterKey, hostiles: string[], hasEncounter, text }`. `key` is `travel:<from>:<to>:<turn>` from `flags.travel.lastAt`/`meta.turn`. `timeSlot` is the capitalised `meta.timeOfDay`. Hostiles come from `state.scene.encounter` filtered by the `describeEncounter` stale-location guard (`src/flows/encounter.js:137`). No DOM, no store access, no clocks.
- **Acceptance criteria:** unit tests cover: null when nothing travelled; fresh `result`; derived-from-state after a remount; stale encounter at a different location yields `hasEncounter:false`; `alreadyThere`/rejected results yield `null`; the text mentions destination and slot and never invents hostiles.
- **Risk:** low
- **Model / Effort:** deepseek-flash #low
- **Commit:** `feat(map): add a pure arrival summary builder` — done in `5cec295`

### 2. Arrival toast driven by the travel flow — ✅ complete (da48b78)
- **Files:** `src/ui/toasts.js`, `src/ui/shell.js`, `src/core/defaults.js`, `src/core/migrations.js`, `src/ui/settings.html`, `style.css`, `docs/map-authoring.md`, `tests/arrival-summary.test.js`, `tests/settings.test.js`
- **Depends on:** 1
- **Parallelizable:** no
- **Expected behavior:** add `buildArrivalToast(summary, { mapStayedOpen })` in `toasts.js` returning `{ id: summary.key, type: 'travel-arrival', title: 'Arrived at <destination>', message: '<slot> · <district> · hostiles|no hostiles', tone: 'info', action }`, where `action` is `{ id: 'return-to-chat', label: 'Return to chat' }` only when the map stayed open. Add an optional `action` field to `renderToastMarkup` (a `<button data-neoterra-toast-action>`; existing callers unaffected). In `announce` (`shell.js:1484`), after `shouldClose` is computed and **before** `closeMapSurface()`, push `buildArrivalToast(...)` through `ensureToasts()` when `settings.map.arrivalFeedback !== false`. Delegate toast-action clicks to `closeMapSurface()` + focus `#send_textarea`. Add `map.arrivalFeedback` (default `true`) to `defaults.js`, the settings migration, `settings.html`, and the map settings docs.
- **Acceptance criteria:** the toast appears on every accepted travel, including `deduped` frames and when the map was already closed; no toast for `alreadyThere` or rejected travel; no duplicate on the double refresh; `map.arrivalFeedback:false` suppresses it; the toast survives the map window closing; the action closes the map and focuses the composer.
- **Risk:** low
- **Model / Effort:** standard #medium
- **Commit:** `feat(map): announce travel arrivals with a destination toast` — done in `da48b78`

### 3. Return-to-chat pulse on the map toolbar — ✅ complete (b61e3fc)
- **Files:** `src/ui/map-panel.js`, `src/ui/shell.js`, `style.css`, `tests/arrival-summary.test.js`
- **Depends on:** 1
- **Parallelizable:** yes (after 1)
- **Expected behavior:** export a pure `shouldPulseReturn({ settings, posted })` (true only when `arrivalFeedback` is on and `shouldCloseAfterTravel` is false). The map panel gains `pulseArrival()` on its public API; it sets `state.arrivalPulse = { key, at }`, adds an `is-pulsing` class to `[data-neoterra-map-return]`, and removes it on `animationend`/`setTimeout` fallback. `announce` calls `panelRef?.pulseArrival?.()` only when `shouldPulseReturn` is true. CSS adds a short keyframe ring/glow on the Return button plus a `@media (prefers-reduced-motion: reduce)` opt-out that falls back to a static "New arrival" badge on the button.
- **Acceptance criteria:** pulse fires once per arrival and never repeats on a re-render; no pulse when the map is about to close; no pulse on rejected travel; reduced-motion users get a non-animated cue; the button keeps working.
- **Risk:** low
- **Model / Effort:** standard #medium
- **Commit:** `feat(map): pulse the Return-to-chat button on arrival` — done in `b61e3fc`

### 4. Structured sidebar arrival card (survives close–reopen) — ✅ complete (b25c093)
- **Files:** `src/ui/map-panel.js`, `src/ui/arrival-summary.js`, `style.css`, `chatMetadata` UI note in `src/ui/shell.js`, `tests/arrival-summary.test.js`
- **Depends on:** 1
- **Parallelizable:** no
- **Expected behavior:** `paintSide` replaces the bare `lastIntro` block with a card: destination name, district, time slot, travel turns, encounter line, a "Full arrival text" `<details>` for the existing prose, and a dismiss button. The card is built from `buildArrivalSummary({ state })` when no fresh result is in memory, so it renders after a close–reopen and after a tab switch. Dismiss writes `chatMetadata.neoterra.ui.map.arrivalDismissedKey = summary.key` and hides the card only for that arrival; the next travel resets it. Keep `data-neoterra-map-intro` on the details element so the spike script selectors still work, and add `data-neoterra-arrival-summary`.
- **Acceptance criteria:** the sidebar announces the arrival in keep-open mode (the spike's Run 2 failure); the card shows after close→reopen; dismissing hides it until the next travel; no card when the chat has no travel history; the prose block is still reachable; existing `data-neoterra-intro-dismiss` behavior is preserved or migrated with a test.
- **Risk:** medium (two render sources, persistence)
- **Model / Effort:** standard #medium
- **Commit:** `feat(map): show a structured arrival summary in the map sidebar` — done in `b25c093`

### 5. Re-run the spike and record the new evidence — ✅ complete (1ce1d89)
- **Files:** `plans/spikes/travel-feedback/run-travel-feedback.js` (extend selectors), `plans/spikes/travel-feedback/notes.md`, `docs/travel-feedback-research.md`, `docs/map-authoring.md`
- **Depends on:** 2, 3, 4
- **Parallelizable:** no
- **Expected behavior:** extend the script to assert the new cues: `#neoterra-toasts [data-neoterra-toast^="travel:"]`, the `is-pulsing` class on `[data-neoterra-map-return]`, `[data-neoterra-arrival-summary]` contents, and the presence/absence of the toast's Return action per mode. Re-run the three modes on the `Neo Terra — Director` chat with `map.closeOnTravel` toggled per run and restored afterwards, and append a "Follow-up (1.3)" table with frame time, toast time, action present, map state, pulse, sidebar text, and clicks-to-reopen. Update docs to state the shipped cues and record that the decision is **keep `map.closeOnTravel: true`** (approved 2026-11-19), with the new evidence cited.
- **Acceptance criteria:** three recorded runs with timestamps and screenshots; the report explicitly answers "does keep-open now orient the player without reopening the map?"; `docs/map-authoring.md` no longer describes the summary as prose-only; the code still defaults to `true`.
- **Commit:** `docs(map): re-run the travel-feedback spike with the shipped cues` — done in `1ce1d89`

### 6. Record the decision (no behavior change) — ✅ complete (21349b6)
- **Files:** `docs/travel-feedback-research.md`, `docs/map-authoring.md`, `CHANGELOG.md`
- **Depends on:** 5
- **Parallelizable:** no
- **Expected behavior:** close Spike B as **"keep close-on-travel by default"** — the approved decision. Document the shipped cues, the new evidence table, and the reasoning (the cues remove the uncertainty but the scene card behind the map is still one click away; users who prefer keep-open already have the setting). Add a changelog entry under the new version. Optionally note the "revisit after a season" hook so a future audit can re-test.
- **Acceptance criteria:** the research doc's recommendation section matches the shipped code; `docs/map-authoring.md` and the changelog agree; no code default changed in this step.
- **Risk:** low
- **Model / Effort:** deepseek-flash #low
- **Commit:** `docs(map): record the keep-close-on-travel decision` — done in `21349b6`

## Verification & Testing
- **Automated checks (run after every step):**
  - `node --test tests/arrival-summary.test.js`
  - `node --test tests/map-model.test.js`
  - `node --test tests/travel.test.js`
  - `node --test tests/settings.test.js`
  - `npm run check` (build-data `--check`, build-map `--check`, map-coords, build-avatars, `node --check` on entry points, the full `tests/*.test.js` suite, smoke test)
- **Manual checks** (start SillyTavern with `C:\Users\locua\OneDrive\Escritorio\KI\ST\SillyTavern\Start.bat`, open `http://127.0.0.1:8000/`, chat `Neo Terra — Director`):
  1. Close-on-travel: HUD → Map → select a connected location → Travel. Arrival frame posts; map closes; toast appears with destination, slot, district, hostiles and stays ~9 s; one click on HUD → Map reopens.
  2. Keep-open (`map.closeOnTravel:false`): travel with the map open. Toast appears **and** the Return button pulses once; the sidebar shows the structured arrival card with the encounter line; Return closes the map and focuses the composer.
  3. Close and reopen the map window after an arrival: the arrival card is still there; dismiss it; it stays hidden until the next travel.
  4. Set `map.arrivalFeedback:false`: no toast, no pulse, no card; the rest of the map is unchanged.
  5. Reduced motion (OS setting or devtools emulation): no animation, a static cue is visible.
  6. Reject cases: travel during combat, blocked bridge, `alreadyThere` — no toast, no pulse, map stays as before.
- **Edge cases:** frame dedupe (re-enter the same chat and re-render) must not re-toast; a chat switch during the awaited post must not toast into the new chat; missing `state.scene.encounter`; no travel history; `timeOfDay` missing; a bundle location without a district; the map panel disposed before `pulseArrival` runs.
- **Rollback:** `map.arrivalFeedback:false` disables all three cues without a revert. Each step is a separate commit, so reverting 4 alone restores the prose block.
