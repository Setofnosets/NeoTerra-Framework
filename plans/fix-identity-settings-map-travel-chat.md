# Fix: canon identity, settings handoff, map window, and in-chat scene output

## Meta
- Slug: fix-identity-settings-map-travel-chat
- Status: in progress — steps 1–6 complete
- Date: 2026-11-17

## Progress
- [x] 1. Fix canon identity selection in the season menu — done (733bbac)
- [x] 2. Make "Open settings panel" actually open the settings drawer — done (733bbac)
- [x] 3. Make the map tab and map window fit vertically — done (733bbac)
- [x] 4. Add a reusable in-chat scene message writer — done (49ca616)
- [x] 5. Add an explicit season kickoff in the main chat — done (49ca616)
- [x] 6. Detect and persist a location encounter — done (d484b29)
- [ ] 7. Hand a location change back to the chat (arrival + encounter)
- [ ] 8. Run the per-turn trackers, advance the clock, refresh map state, then offer CYOA
- [ ] 9. Give encounters explicit Engage/Talk/Avoid actions
- [ ] 10. Close the map on a successful location change
- [ ] 11. Document the new flow and update the changelog

## Summary
- **Goal:** make the reported flows work end to end: canon identity selection, the Open settings button, a map window that fits vertically, an explicit season kickoff, and location changes that produce visible, persistent chat output (including encounters and CYOA options) instead of only mutating state and the map sidebar.
- **Gameplay contract (confirmed in review):** the chat is the primary surface. Season start posts an opening frame plus a clear "your move" kickoff (goals, current situation); an optional auto-kickoff (default off) can send a player prompt through ST's normal send path. Travel keeps the same chat and posts a "location changed" frame with the travel output, whether or not an encounter occurs; encounters expose Engage/Talk/Avoid actions, and Engage starts the deterministic combat flow. Every assistant turn advances the clock, runs the player tracker, refreshes the map/world state, runs the Storyline tracker on its cadence, and then offers CYOA when enabled. **World state stays out of the chat**: it is rendered into the prompt copy by the existing generation interceptor, exactly like Combat-Multihog's state memo, so it informs the model without duplicating chat history. Closing the map returns the user to the chat. Character-card hot-swapping is **not** safe in this ST version and stays out of scope.
- **Context:** the framework currently stops at state + a map panel. After `enterSeason` the shell simply returns to the season list: no chat frame, no input focus, no start signal. Travel posts nothing. The fully implemented state tracker is never wired to the turn pipeline. The identity step and settings handoff have concrete wiring bugs. The map panel is pinned to a 1080×700 landscape box inside a shell whose height never grows, so it is clipped to ~396px on a 1440×900-class viewport.

## Current State (from exploration)

**Identity.** The identity step renders canon radios with `data-character-id` (`src/ui/season-menu.js:99`) but `beginSeason` reads `radio.dataset.neoterraCharacterId` (`:405`). That key never exists, so every canon selection reaches `resolveIdentitySelection` with no `characterId` and throws `INVALID_IDENTITY` (`src/flows/season-start.js:440-446`). Only `s1dark` works via `season.defaultPlayerCharacterId`; custom persona bypasses the guard, hence the "custom first, then Play as" workaround. Live-verified: `dataset.characterId` is populated; no `neoterraCharacterId` key exists.

**Settings.** The Settings tab's `Open settings panel` button (`src/ui/shell.js:121,745-755`) scrolls the ST drawer host and expands the Neo Terra inline drawer, but never opens the ST extensions drawer and never dismisses the full-screen shell. Live-verified: the drawer stays `drawer-content closedDrawer` and the panel rect is 0×0; clicking `#extensions-settings-button .drawer-toggle` directly opens it.

**Map window.** The map tab shell is content-sized (~599px at 1296×894), so `.neoterra-map-host` collapses to its 420px `min-height` and `clampPanelGeometry` clamps the 1080×700 panel to 1080×396. Live-verified: host 1182×420, panel 1080×396. The map X sends `CLOSE` but nothing hides the panel.

**Season start.** `enterSeason` returns `opening` (`src/flows/season-start.js:640,667-674`) but the shell never posts it or closes; `mountSeasonMenu` has no `onEntered` callback (`src/ui/shell.js:226`). The user lands back on the season list with no start signal.

**Travel and chat.** `travel()` mutates state and returns `intro` (`src/flows/travel.js:333-463`), but the only chat write is `recordTravelOnMessage`, which attaches `extra.neoterra.travel` to the previous assistant message (`src/ui/shell.js:338-389`). No message is posted, no choices are requested, and there is no encounter system (`cast.threatsHere` is unused). The chat contains no Neo Terra elements.

**Turn pipeline.** `src/agents/state-tracker.js` is a complete per-turn player tracker with an atomic applier and an `agents.stateTracker` setting, but `createStateTracker` is never called outside tests. `handleAssistantMessage` (`shell.js:676-699`) runs only `initiative.afterTurn` and then CYOA: no player tracker, no `TICK_TIME` (`meta.turn` is frozen on chat turns), no map refresh, no updated-state choices. The map and interaction runtimes also hold separate `WorldState` stores for the same chat (`shell.js:302-307` vs `:601-606`), each caching `current`, so one write is invisible to the other. Beat deadlines and the `everyNTurns` cadence cannot advance on normal turns.

**World-state injection (already correct).** `neoTerraGenerateInterceptor` (`src/context/interceptor.js`) renders the `WorldState` blocks into the **prompt copy** at `context.depth`, strips any previous `extra.neoterra.context` message first, and never pushes to `ctx.chat` or calls `saveChat`. That is the same separation Combat-Multihog uses for its state memo: state is part of the prompt, not the transcript. This must be preserved; the new chat frames are scene narration, not world-state dumps.

**Cast mode / hot-swap.** `castMode` is a label plus a narrator-card lookup: `solo` only changes `selectNarratorCard` and the setup-strip label (`season-start.js:609,694-718`). No code switches cards; a real switch clears/reloads the chat and discards `chat_metadata` (`season-start.js:687-693`), so per-location hot-swapping is unsafe.

**Key files:** `src/ui/season-menu.js`, `src/flows/season-start.js`, `src/ui/shell.js`, `src/ui/settings.js`, `src/ui/map-panel.js`, `style.css`, `src/flows/travel.js`, `src/flows/scene.js`, `src/context/renderer.js`, `src/ui/choices.js`.

**Landmines:** the confirm view rebuilds identity from missing inputs; `recordTravelOnMessage` writes to a stale captured ctx; `MESSAGE_RECEIVED` is the only choice trigger; ST `Generate('normal')` deletes the last message when the textarea is empty, so auto-generation after a posted frame must not be improvised; the settings template is huge and lives in a collapsed ST drawer; map geometry is persisted in localStorage and old values will defeat a new default.

## Constraints & Requirements
- **Tech stack / permissions:** vanilla ES modules, no new dependencies, no DOM test harness. Tests are Node `node:test` and source-level CSS assertions. SillyTavern public context is the only integration surface; no server endpoints.
- **Prompt-only world state:** `WorldState` must never be written into `ctx.chat` as a message. The existing generate interceptor owns prompt injection and dedupes it; scene frames are the only Neo Terra chat messages. Any status/HUD work must be UI-only and is out of scope for this change.
- **ST APIs available (verified):** `ctx.chat`, `ctx.addOneMessage`, `ctx.saveChat`, `ctx.getCurrentChatId`, `ctx.eventSource`, `ctx.executeSlashCommandsWithOptions`, `ctx.messageFormatting`. `Generate()` is exposed but is unsafe for a posted system/narrator frame (see landmines).
- **Out of scope:** character-card hot-swapping on travel (unsafe; see Current State), creating a new chat per location, combat auto-start, redesigning the shell, rewriting season content, and the `EXTENSION_VERSION` drift unless the docs step chooses to align it.
- **In scope by confirmation:** chat-first scene output; season kickoff; same-chat travel frames; per-turn player/world tracker updates; CYOA after every assistant turn; map/shell close after travel.

## Assumptions & Open Questions
1. **Assumed:** the "Open settings" complaint is the Settings-tab button, not the tab switch itself. The tab switches; the handoff is dead.
2. **Assumed:** "map window more vertical" means the floating map panel should use the available height of the map tab (and the map tab shell should fill the viewport), not that the city map should become portrait.
3. **Confirmed (1):** auto-kickoff is included and **off by default**. The opening/kickoff card and input focus are the default start signal. If enabled, it sends one editable `kickoff.prompt` as the player through ST's normal send path on a fresh season start, triggering a narrator turn; it is suppressed in a chat with existing story history.
4. **Confirmed (2):** keep the Storyline tracker on its `everyNTurns: 6` / location-change cadence; the clock, player tracker, and map UI still refresh every assistant turn.
5. **Confirmed (3):** no in-chat status strip. The travel/opening frames are the visible chat elements; world state stays prompt-only through the interceptor.
6. **Confirmed (4):** an encounter's aggressive action starts the deterministic combat flow. This plan adds explicit Engage/Talk/Avoid actions in a small chat-side bar (not model-tagged CYOA); Engage calls `createCombatFlow.start` with the player and hostile cast. If only a threat (no individual opponent) is present, Engage is disabled and the encounter stays prose + choices.
7. **Confirmed (5):** discarding a stored map geometry that exactly equals the old 1080×700 default is acceptable; custom sizes are preserved.
8. **Confirmed:** closing the map on a successful location change means closing the Neo Terra shell so the chat (where the result was just posted) is visible. `map.closeOnTravel` defaults true.
9. **Confirmed:** posting the season opening frame on `enterSeason` is desired, together with a "your move" kickoff showing goals/current situation.
10. **Confirmed:** same chat for travel; no new chat and no character-card hot-swap. "Solo hot-swap" remains a narrator-card lookup, not a runtime card switch.
11. **Confirmed:** every assistant turn advances the clock, runs the player tracker, refreshes the map/world state, then requests CYOA when enabled.
12. **Confirmed:** world state is not written into the chat; it remains in the prompt via `neoTerraGenerateInterceptor`, deduped on every generation.

## Step-by-Step Implementation Plan

### 1. Fix canon identity selection in the season menu
- **Files:** `src/ui/season-menu.js`, `tests/season-start.test.js`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:**
  - `beginSeason` reads the selected canon radio's registry id from `dataset.characterId` (the attribute that is actually rendered), not a non-existent `neoterraCharacterId`.
  - Extract and export a tiny pure reader (e.g. `readIdentityRadio(radio)`) that returns `{ identity, characterId }`, so the mapping is testable without a DOM.
  - Export the identity-step renderer (or a markup helper) and assert the canon radios still carry `data-character-id` and the season default stays selected.
  - The replace-confirmation path preserves the captured `characterId` (`mergePendingIdentity` already does this when the first attempt captured it).
  - No change to `resolveIdentitySelection`; it is correct and remains the guard.
- **Acceptance criteria:**
  - New unit test: a checked canon radio with `dataset.characterId = 's1.vaiva.colorgarde'` produces a `characterId`, and `resolveIdentitySelection(s1, selection)` succeeds.
  - New markup test: every canon option in `renderIdentityStep` has a non-empty `data-character-id`.
  - Existing tests for custom persona and `mergePendingIdentity` pass.
  - Manual: Season → S1 → select any canon option → Begin season succeeds; S1Dark and custom still work.
- **Risk:** low
- **Model / Effort:** standard implementer, low effort
- **Commit message sketch:** `fix(season): read the selected canon characterId from the identity radios`

### 2. Make "Open settings panel" actually open the settings drawer
- **Files:** `src/ui/shell.js`, `src/ui/settings.js`, `tests/settings.test.js` (or a new `tests/settings-reveal.test.js`)
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:**
  - Add a pure `planSettingsReveal({ drawerPresent, drawerOpen, panelPresent, panelExpanded })` helper in `settings.js` that returns the ordered actions (`open-drawer`, `expand-panel`, `scroll-panel`, `warn-missing`). This keeps the ST DOM coupling testable.
  - `openSettingsPanel()` closes the shell first (so the modal stops occluding the page), then, when `#rm_extensions_block` does not have `openDrawer`, clicks `#extensions-settings-button .drawer-toggle`; expands the `#neoterra-settings` inline drawer if its content is collapsed; scrolls the panel into view on the next frame.
  - If the ST extensions host or the NeoTerra panel is absent, the Settings tab shows a visible `role="status"` message instead of silently doing nothing, and the failure is logged.
  - Resolve the live context before repainting so a chat switch does not make the handoff stale.
  - Replace the tab's placeholder copy with a short explanation of where the panel opens.
- **Acceptance criteria:**
  - Unit tests cover the reveal-plan states: drawer closed/open, panel present/missing, panel collapsed/expanded.
  - Live (ST at `127.0.0.1:8000`): Settings tab → Open settings panel → shell closes, `#rm_extensions_block` gains `openDrawer`, `#neoterra-settings` has non-zero size and is scrolled into view. Re-clicking with the drawer already open must not close it.
  - Missing-host path produces a visible status message and no exception.
- **Risk:** low–medium (DOM contracts with ST)
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `fix(settings): hand off to SillyTavern's extensions drawer instead of scrolling a hidden panel`

### 3. Make the map tab and map window fit vertically
- **Files:** `style.css`, `src/ui/map-panel.js`, `tests/map-model.test.js`, `tests/ui-css.test.js`
- **Depends on:** none
- **Parallelizable:** yes, except with Step 4 (same stylesheet)
- **Expected behavior:**
  - The map tab gets a definite height instead of content height: `.neoterra-root[data-active-tab='map'] .neoterra-shell { height: min(92vh, calc(100vh - 4rem)); min-height: min(560px, calc(100vh - 4rem)); }`, keeping the existing width cap and `max-height`. The flex chain (`.neoterra-tabpanels` → `.neoterra-panel.is-live` → `.neoterra-map-host`) then gives `.neoterra-map-host` the remaining space instead of the 420px minimum.
  - Raise the panel default to a taller box (e.g. `width: 1080`, `height: 820`) and keep it clamped to the host. On a 1296×894 viewport this should move the panel from 1080×396 to roughly 1080×600+; on 1920×1080 it should be ~700–800px tall.
  - Make drag and resize use the same host-aware viewport as initial placement. Today `applyGeometry` clamps to the host while pointer drag/resize clamp to `window`, so the panel can be dragged/resized outside the shell and clipped.
  - Add a one-time geometry migration: a stored value exactly equal to the old default (`1080×700`, no version marker) is treated as unset; other stored sizes are preserved and re-clamped. Prefer a versioned storage object or a `GEOMETRY_VERSION` field.
  - Keep the corner resize handle; no new handle types are required for this fix.
- **Acceptance criteria:**
  - `clampPanelGeometry` tests cover host-sized viewports and assert the panel height cannot exceed `viewHeight - 24`.
  - New test: legacy `1080×700` storage resets to the new default; custom `900×640` storage survives.
  - Source-level CSS tests assert the map shell height rule and the flex chain.
  - Manual at 1440×900 and 1920×1080: map panel is visibly taller, does not clip at the shell edge, Leaflet tiles resize after tab switches, drag/resize stay inside the host, and reload restores the stored geometry.
  - Narrow viewport (900×700): panel remains inside the host and the resize handle is reachable.
- **Risk:** medium (layout regressions across tabs/viewports)
- **Model / Effort:** standard implementer, medium effort; visual review required
- **Commit message sketch:** `fix(map): fill the map tab height and clamp the panel to its host`

### 4. Add a reusable in-chat scene message writer
- **Files:** `src/ui/chat-output.js` (new), `tests/chat-output.test.js` (new), `style.css`
- **Depends on:** none
- **Parallelizable:** yes with 1, 2, and 6; **not** with 3 (same stylesheet)
- **Expected behavior:**
  - Pure `buildSceneChatMessage({ kind, text, extra, now })` returns a SillyTavern message object: `name: 'Neo Terra'`, `is_user: false`, `is_system: false`, `send_date` as an ISO string, `mes: text`, and `extra.neoterra.scene = { kind, key, ...extra }`.
  - **Prompt-history contract:** `is_system` must be `false`. ST filters system messages out of the generation history (`script.js:4496`), so a system frame would not influence the next prompt. Use a custom `extra.neoterra` marker for identification. `extra.type = 'narrator'` is optional (ST keeps it in history but formats it without a name prefix); leave it unset for simplicity. Set `force_avatar` to a bundled NeoTerra asset so the message shows the Neo Terra name instead of the host character's avatar/name.
  - `postSceneMessage(ctx, message, { dedupeKey })` checks the last chat message's `extra.neoterra.scene.key`; if equal, it returns the existing index and does nothing. Otherwise it pushes to `ctx.chat`, calls `ctx.addOneMessage(message)`, awaits `ctx.saveChat()` when it returns a promise, and returns the new index.
  - Never throws when the chat array, `addOneMessage`, or `saveChat` is unavailable; return `{ posted: false, reason }` instead.
  - **World state stays out of the message.** A scene frame contains only scene narration/action text; it never copies `WorldState` or `[NEOTERRA_*]` blocks. Prompt injection remains exclusively the generation interceptor's job.
  - Add minimal CSS so Neo Terra scene messages are visually distinct (a left accent / muted label) without restyling ST's chat.
- **Acceptance criteria:**
  - Unit tests with a fake ctx: message shape, ISO date, dedupe, save called once, graceful failure when `addOneMessage` is missing.
  - Unit test proves `is_system` and `is_user` are both false (required for the frame to enter generation history).
  - Scene text/extra contains no `[NEOTERRA_` block. A generation interceptor test confirms the context is injected into the prompt copy only, with one copy after repeated runs, and `ctx.chat` is unchanged.
  - `npm run check` still passes; no chat writes in tests.
- **Risk:** medium (chat array + ST rendering contract)
- **Model / Effort:** standard implementer, high effort
- **Commit message sketch:** `feat(chat): add a deduped in-chat scene message writer`

### 5. Add an explicit season kickoff in the main chat
- **Files:** `src/ui/shell.js`, `src/ui/season-menu.js`, `src/ui/chat-output.js`, `src/core/defaults.js`, `src/ui/settings.html`, `src/ui/settings.js`, `tests/season-start.test.js`, `tests/chat-output.test.js`
- **Depends on:** 4
- **Parallelizable:** no (season mount wiring)
- **Expected behavior:**
  - `mountSeasonPanel` passes an `onEntered` callback to `mountSeasonMenu`. After a successful `enterSeason`, the callback posts one `kind: 'opening'` scene message with a key derived from `chatId`, `seasonId`, and the opening turn.
  - The message contains: the existing `result.opening.text`, then a short kickoff block:
    - `Season started — <title>`
    - `You are <player>, <role>, at <location>.`
    - `Goals: ...` from `selectPlayerView` (player/canon goals) or the season roster member, with a neutral fallback.
    - `Current situation: ...` from `state.scene.framing` or the main threat/agenda.
    - `Current action: none yet — the opening is yours.`
    - `Your move: describe your first action, or pick a suggestion below.`
  - The posted frame is a normal assistant message (`is_system: false`) so the next generation sees it. It is **not** posted if there is no chat array or no `chatId`.
  - Close the shell after posting so the user lands in the chat, and focus `#send_textarea`. This is the missing "the story has started" signal.
  - Then refresh the interaction UI and request CYOA choices for the new message index (only when `cyoa.enabled` is on; the existing guard hides the row otherwise). When auto-kickoff is enabled and will send immediately, skip the opening-frame CYOA request to avoid a chip flash; the narrator reply will trigger CYOA normally.
  - **Auto-kickoff (default off):** add `kickoff.auto` (default `false`) and `kickoff.prompt` (editable string, neutral default) to defaults + the Settings panel. When enabled and the chat was fresh before the season started (no user/assistant story messages beyond an optional greeting), send `kickoff.prompt` as the player through ST's normal send path (same mechanism as a CYOA chip), which triggers one narrator turn. Suppress auto-kickoff when the chat already has story history. The kickoff text + input focus remain the default start signal when it is off.
  - If the chat changes between season start and posting, skip the post and log instead of writing into the wrong chat.
- **Acceptance criteria:**
  - New test: `onEntered` receives the opening text and the poster is called once; a second callback for the same chat/season/turn dedupes.
  - Kickoff text includes goals and the current situation for both a canon player and a custom persona (fallback when no goals exist).
  - `kickoff.auto` defaults to false (frame + focus only). When enabled on a fresh chat (no story messages beyond an optional greeting) it sends exactly one player message through the existing send path (no direct `Generate()` call); in a chat with existing history it is suppressed.
  - Existing season-start tests still pass; no flow module imports DOM.
  - Manual: start a season on a fresh test chat → shell closes, opening + kickoff appear, input is focused, no typing required to see the story start; reload → the frame persists; CYOA on → chips appear. With auto-kickoff on → one player prompt is sent and the narrator replies.
- **Risk:** medium
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(season): post an opening frame and explicit kickoff when a season starts`

### 6. Detect and persist a location encounter
- **Files:** `src/flows/encounter.js` (new), `src/flows/scene.js`, `src/context/renderer.js`, `tests/encounter.test.js` (new), `tests/context.test.js`, `tests/travel.test.js`
- **Depends on:** none (can run parallel with 4–5; touches travel/scene)
- **Parallelizable:** yes, except with Step 7
- **Expected behavior:**
  - Pure `detectEncounter({ state, present, threatNames, locationId, playerRole })` returns `null` or `{ locationId, characterIds, threatNames, source: 'travel'|'scene' }`.
  - Rule (pseudocode):
    ```
    if scene.combat is active                         -> null
    playerSide = playerRole === 'villain' ? 'villain' : 'hero'
    opposing = present characters with side === opposite(playerSide) and alive
    hostileThreats = threatNames at this location
    if opposing is empty and hostileThreats is empty  -> null
    return { locationId, characterIds: opposing, threatNames: hostileThreats }
    ```
    Same-side villains are allies (important for S1Dark); neutral characters never trigger an encounter. An encounter is by definition hostile; no separate severity field is needed in this change.
  - `scene.finalize` writes `scene.encounter` (or clears it to `null`) after the cast refresh, through the same validated state patch used for cast flags. The encounter is derived, not authored.
  - `buildLocationIntro` appends one short, deterministic encounter paragraph when `state.scene.encounter` is set (names and threat names only; no invented abilities, numbers, or outcomes).
  - `renderScene` adds `Encounter: ...` and `Threats here: ...` lines so the next prompt knows the situation. Keep it inside `[NEOTERRA_SCENE]`; do not add a new block.
  - An encounter does not start combat and does not block travel.
- **Acceptance criteria:**
  - Unit tests: villain present for a hero player → encounter; hero present for a villain player → encounter; same-side villain → none; neutral only → none; active threat at location → encounter; active combat → none; encounter clears on a peaceful arrival.
  - `buildLocationIntro` includes the encounter names; `renderContext` includes the `Encounter:` line and respects the content gate/token budget.
  - Existing travel tests pass; `scene.encounter` survives JSON round-trip and `validateWorldState`.
- **Risk:** medium (new scene state; false-positive encounters are UX-visible)
- **Model / Effort:** standard implementer, high effort
- **Commit message sketch:** `feat(scene): detect hostile arrivals and persist the encounter in scene state`

### 7. Hand a location change back to the chat (arrival + encounter)
- **Files:** `src/ui/shell.js`, `src/ui/chat-output.js`, `src/flows/travel.js`, `tests/travel.test.js`, `tests/chat-output.test.js`, `tests/choices.test.js`
- **Depends on:** 4, 6
- **Parallelizable:** no
- **Expected behavior:**
  - Keep the **same chat**; never create a new chat and never switch character cards. Replace `recordTravelOnMessage` with a travel outcome poster. On a successful `travel()`:
    1. Post one `kind: 'travel'` scene message with a short `Location changed: <from> → <to>` header followed by `result.intro.text` (which now includes the encounter, if any).
    2. Attach the travel record to that new message (`attachTravelToMessage`), so swipe/reload still shows where the player came from.
    3. Refresh the interaction UI and request choices for the new message index. The request must be allowed even though no `MESSAGE_RECEIVED` fired; `shouldGenerateChoices` already accepts a non-user last message and `cyoa.enabled` remains the gate.
    4. Emit `MAP_UPDATED` as today.
  - **Always post the arrival frame, with or without an encounter.** If no encounter was detected, the frame still narrates the new location and present cast; the player can stay or open the map again and choose a new destination.
  - On a rejected travel (`!ok`), do not post and do not refresh choices; keep the map open and show the existing rejection message.
  - If the user switched chats mid-travel, abort the post (the existing chat-affinity guard already aborts the move; keep the post behind the same check).
  - Do not run `initiative.afterTurn` here; travel already ran the location storyline pass.
  - Fix the bridge-name gap while wiring the intro: `buildLocationIntro` looks for `travel.bridgeNames`, but `buildTravelInitiativeContext` does not carry it, so the new arrival frame would show bridge ids. Pass `plan.bridgeNames` through the travel context/intro.
  - This is the "actions influence context" fix: the arrival frame is now real chat history, and the `[NEOTERRA_SCENE]` block carries the encounter.
- **Acceptance criteria:**
  - Unit/integration test with a fake ctx: successful travel posts exactly one message, attaches `extra.neoterra.travel`, calls `saveChat`, and requests choices with the new index.
  - Rejected travel posts nothing.
  - Duplicate `MAP_UPDATED`/refresh does not duplicate the message (dedupe key).
  - Arrival text uses bridge display names (not bridge ids) when a route crosses bridges.
  - Manual with CYOA on: travel → arrival + encounter in chat → chips appear without typing. With CYOA off: arrival appears, no chips, no errors.
  - Manual: next user message's prompt contains the new location, present cast, and encounter line (inspect the prompt or the context preview).
- **Risk:** high (chat writes + async travel + chat switch races)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(travel): post the arrival and encounter to chat and refresh CYOA`

### 8. Run the per-turn trackers, advance the clock, refresh map state, then offer CYOA
- **Files:** `src/ui/shell.js`, `src/state/store.js` (shared/reload), `src/flows/scene.js` (cast refresh wiring), `src/agents/state-tracker.js` (wiring only), `src/ui/player-panel.js` (only if the Player tab is wired), `tests/state-tracker.test.js`, `tests/choices.test.js`, `tests/world-state.test.js`
- **Depends on:** 4; sequence after 7 (same shell turn handler)
- **Parallelizable:** no
- **Expected behavior:**
  - Wire the existing `createStateTracker` into `buildInteractionRuntime` (runner + settings + logger), storing it on the runtime next to `initiative`.
  - Make the map and interaction runtimes share **one** per-chat `WorldState` store (or add a `reload()`/invalidate path that re-reads `chatMetadata`). Today each caches its own `current`, so a tracker write is invisible to the map until remount. Prefer a small per-chat runtime registry or pass the map runtime's store into the interaction runtime.
  - Give the interaction runtime a scene flow bound to that shared store (reuse the map runtime's when it exists) so the per-turn cast refresh does not need the map tab to be open.
  - In `handleAssistantMessage`, for a genuinely new assistant message (dedupe by message index; a swipe of the same index is a re-render, not a new turn), run this order:
    1. Advance the turn once: apply `TICK_TIME` with `turns: 1` (or the agreed per-turn amount) through the shared store. Swipe re-renders of the same message must not tick again. This makes the `everyNTurns` storyline cadence and beat deadlines work.
    2. Player state tracker: `run({ state, message: message.mes, recentMessages })`, then `applyStateTrackerResult(store, result)` (atomic; already implemented). Respect `agents.stateTracker.enabled` and the existing `everyTurn` cadence.
    3. Storyline tracker: `initiative.afterTurn({ recentProse: message.mes })` as today (cadence-gated).
    4. Refresh the present cast: call the scene flow's `refreshCast({ runDirector: false })` so NPC moves applied by the storyline are reflected in `scene.present`, `scene.encounter`, and `[NEOTERRA_SCENE]`. Respect manual pins/removals.
    5. Refresh the map/world UI: emit `MAP_UPDATED` with `reason: 'turn'` and refresh the mounted map panel/overlay so the map state matches the newly applied events.
    6. Refresh the interaction UI, then request CYOA with the updated state. Choices must be requested **after** the trackers so the options reflect the new state.
  - A tracker failure is non-fatal: log it, keep the previous state, and still refresh choices.
  - Keep the Storyline tracker on its existing `everyNTurns`/location cadence. This step makes the clock advance and refreshes the map every turn, but does not turn the storyline agent into a per-turn call. Confirm that distinction: "trackers for the map state" is read as refresh + player tracker every turn, with storyline progression on its configured cadence.
  - Handle the async path: `handleAssistantMessage` is currently fire-and-forget (`void` at `shell.js:718`); add a rejection trap so a tracker/choice failure never becomes an unhandled rejection. Serialize per-message handling if two events can arrive for the same index.
- **Acceptance criteria:**
  - Integration-style test with a fake runner/store: an assistant message ticks the turn once, runs the state tracker once, applies its events, then requests choices; a rejecting tracker leaves state unchanged and still requests choices.
  - Swiping/re-rendering the same message does not tick or double-apply.
  - `agents.stateTracker.enabled = false` skips the tracker and makes no agent call.
  - Two-store test: a write through the interaction store is visible to the map store (shared or reloaded), and a `MAP_UPDATED` turn event is emitted.
  - NPC-move test: a storyline `MOVE_CHARACTER` into the player's location is reflected in `scene.present`/`scene.encounter` after the turn, and manual pins/removals still win.
  - Existing `tests/state-tracker.test.js`, `tests/choices.test.js`, and `tests/world-state.test.js` pass.
  - Manual: let a scene damage the player or change a relationship, send a message, and confirm the world state and map overlay update before the chips appear; confirm `meta.turn` increments once per exchange and beat deadlines can fire.
- **Risk:** medium–high (per-turn agent call, time advancement, state writes, choice ordering)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(turn): tick time, run trackers, and refresh map state before CYOA`

### 9. Give encounters explicit Engage/Talk/Avoid actions
- **Files:** `src/ui/encounter-bar.js` (new), `src/ui/shell.js`, `src/combat/combat-state.js` (wiring only), `style.css`, `tests/encounter.test.js`, `tests/combat.test.js`
- **Depends on:** 6, 7
- **Parallelizable:** yes after 7 (different files from 8/10, except `shell.js`)
- **Expected behavior:**
  - When a travel frame reports an encounter, mount a small `encounter-bar` above the input (next to the CYOA host) with:
    - **Engage** — enabled only when the encounter has at least one hostile character id.
    - **Talk** — focuses the input and requests/keeps CYOA options; no state change.
    - **Avoid** — dismisses the bar; the encounter stays in state and the frame remains in chat, but no combat starts. Record an `avoided` marker in `flags` (not `scene.encounter`, which is recomputed) for that encounter/location so a refresh does not immediately re-prompt; a new encounter or a new location resets it.
  - **Engage** calls the existing `createCombatFlow.start` with the player actor (`'player'` for a custom persona, the canon `characterId` for a canon player) and the encounter's hostile `characterIds`; sides: player `a`, hostiles `b`; `locationId` from the encounter. On success:
    1. post one `kind: 'combat'` scene frame naming the participants and stakes,
    2. hide the encounter bar,
    3. request CYOA in `combat` mode (tactical chips appear only when `cyoa.combatChoices.enabled` is on).
  - On failure (unknown/duplicate participant, combat already active), show the reason in the bar and do not post a combat frame.
  - If the encounter is threat-only (no character ids), **Engage** is disabled with a short reason; the prose + CYOA path remains.
  - While combat is active, the bar shows **Surrender** (calls the combat flow's `surrender`) and **End combat** (calls `end({reason:'scene-end'})`) so a combat that blocks travel always has an exit. Post a short resolution frame on success.
  - The bar is UI-only; it never writes the world state to chat. Hide it when there is no encounter/combat or on chat change.
- **Acceptance criteria:**
  - Pure model test: hostile encounter with ids → Engage/Talk/Avoid; threat-only → Engage disabled; active combat → Surrender/End; no encounter → hidden; an avoided encounter stays hidden on refresh until the encounter key changes.
  - Shell test with a fake combat flow: Engage calls `start` once with the expected participants/sides, posts one combat frame, and requests combat choices; a failed start posts nothing.
  - Surrender/End call the flow and hide the bar on success.
  - Manual: travel into a villain → click Engage → combat starts, travel is blocked, tactical chips appear if enabled; Surrender/End ends combat and travel works again. Threat-only encounter shows prose and no Engage.
- **Risk:** medium–high (new combat UI + state changes)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(encounter): add Engage/Talk/Avoid actions and start combat deterministically`

### 10. Close the map on a successful location change
- **Files:** `src/ui/shell.js`, `src/ui/map-panel.js`, `src/core/defaults.js`, `src/ui/settings.html`, `src/ui/settings.js`, `tests/settings.test.js`, `tests/map-model.test.js`
- **Depends on:** 7
- **Parallelizable:** no
- **Expected behavior:**
  - Add `map.closeOnTravel` (default `true`) to defaults and the Settings → Map section.
  - After a successful travel post, if the setting is true, close the shell (`closeShell()`) so the chat shows the new scene and the player continues interaction/encounters there. If travel failed, keep the map open.
  - If the destination has no encounter, the shell still closes after the arrival frame; the player can stay in chat or reopen the map and choose another location.
  - The map toolbar X (`data-neoterra-map-close`) must actually close something. Pass an `onClose` callback from the shell; the panel sends `CLOSE` and invokes it, which closes the shell. This fixes the currently dead X live-verified in exploration.
  - Do not close the shell on a mere map refresh or tab switch.
- **Acceptance criteria:**
  - Defaults/settings round-trip test for `map.closeOnTravel`; settings UI checkbox uses the existing `data-neoterra-path` machinery.
  - Manual: travel with the setting on → shell closes and chat is visible; setting off → shell stays on the map tab. Travel failure → shell stays open.
  - Manual: map X now closes the shell; Escape/backdrop still work.
- **Risk:** low
- **Model / Effort:** standard implementer, low effort
- **Commit message sketch:** `feat(map): close the map after travel and make the close button real`

### 11. Document the new flow and update the changelog
- **Files:** `README.md`, `CHANGELOG.md`, `docs/scene-output.md` (new), `docs/cyoa.md`, `docs/map-authoring.md`
- **Depends on:** 1–10
- **Parallelizable:** no
- **Expected behavior:**
  - Document the corrected season identity path (canon selection no longer requires custom-then-Play-as).
  - Document that season start and travel post a Neo Terra narrator frame into chat, that the frame is part of prompt history, that encounters are deterministic, and that CYOA regenerates for the frame only when enabled.
  - Document the prompt-only world state explicitly: `WorldState` lives in `chatMetadata`, is rendered by `neoTerraGenerateInterceptor` into the prompt copy at depth, is deduped per generation, and is never written to `ctx.chat`. Compare it to Combat-Multihog's state memo so the separation is clear.
  - Document `map.closeOnTravel` and the settings handoff.
  - Add a CHANGELOG entry grouping the fixes by user-visible symptom.
  - Note the current version drift (`EXTENSION_VERSION` `0.1.0` vs package `1.0.0`) and either align it in this step or record it as a known issue. Do not silently change the manifest without checking ST's compatibility expectations.
- **Acceptance criteria:**
  - Docs match the implemented behavior and name the exact settings/defaults.
  - `npm run check` passes; no generated data is hand-edited.
- **Risk:** low
- **Model / Effort:** standard implementer, low effort
- **Commit message sketch:** `docs: describe chat scene output, encounters, and the settings/map handoffs`

## Verification & Testing

### Automated checks (run from the repository root)
```bash
node --test tests/season-start.test.js
node --test tests/settings.test.js
node --test tests/map-model.test.js
node --test tests/ui-css.test.js
node --test tests/chat-output.test.js
node --test tests/encounter.test.js
node --test tests/travel.test.js
node --test tests/choices.test.js
node --test tests/context.test.js
node --test tests/state-tracker.test.js
npm test
npm run check
```
`npm run check` covers generated-data/map drift, syntax checks, the full test suite, and the smoke test. Do not hand-edit generated files to make it pass.

### Manual checks (live at `http://127.0.0.1:8000`)
1. **Canon identity:** open a test chat, Neo Terra → Season → S1 → select a canon character → Begin. No `INVALID_IDENTITY`; inspect `chatMetadata.neoterra.worldState.player.characterId` and confirm it equals the selected registry id. Repeat for S1Dark (default), Sandbox (any registry character), and custom persona.
2. **Codex regression:** after starting, open Characters → a canon NPC → Play as. It still works (the identity fix must not change Play as).
3. **Settings:** Settings tab → Open settings panel. The shell closes, the ST Extensions drawer opens, the NeoTerra panel is visible and scrolled into view. Repeat with the drawer already open; it must stay open.
4. **Map sizing:** on 1440×900 and 1920×1080, record the map host and panel rects. The panel should be substantially taller than 396px and must not be clipped by the shell. Drag/resize, switch tabs, reload, and confirm geometry is restored and clamped.
5. **Narrow viewport:** ~900×700. The panel stays inside the host, no page overflow, resize handle reachable.
6. **Season kickoff:** start a season on a fresh chat → the shell closes, an opening frame plus "Season started / You are / Goals / Current situation / Your move" appears, and the input is focused; no player message is sent by default. Reload → the frame persists. With CYOA on → chips appear for the opening message. With `kickoff.auto` enabled → exactly one player prompt is sent and the narrator replies. In a chat with existing history → the frame appears but auto-kickoff is suppressed.
7. **Travel:** open the map, travel to a location with no hostiles → a `Location changed: X → Y` frame with the travel output is posted; no encounter; chips (if CYOA on). Travel to a location with a villain/threat → arrival + encounter frame; chips; no combat started; travel to another location works without leaving the chat.
8. **Turn pipeline:** send a message that changes player state (damage, outfit, relationship) → the player/world state and map overlay update before the chips appear; `meta.turn` increments exactly once per exchange (not on a swipe); beat deadlines/cadence can fire.
9. **Villain POV:** S1Dark (player is a villain). Arrive where villains are present → no false "enemy" encounter; arrive where heroes are present → encounter.
10. **Map close:** with `map.closeOnTravel` on, a successful travel closes the shell and reveals the chat; with it off, the shell stays. A rejected travel (combat/blocked route) keeps the map open. The map X closes the shell.
11. **Context influence:** after travel, send one message and inspect the prompt/context preview. It must include the new location, present cast, and encounter line, and the arrival frame must be in history.
12. **Chat switch race:** start travel, switch chats before it resolves (or simulate via the debug API), and confirm no message lands in the wrong chat.
13. **Missing integration pieces:** no `#extensions_settings2`/`#neoterra-settings` → the settings button shows a status message; no `addOneMessage`/`saveChat` → travel still moves and logs, chat post is skipped without an exception.
14. **Prompt-only world state:** after a generation, `ctx.chat` contains no `[NEOTERRA_*]` context message; the injected context exists only in the prompt copy, and a second generation replaces rather than duplicates it.

### Edge cases
- No chat open (season start already errors before posting).
- Group chats (chat id resolution, chat-affinity guard).
- Existing chat with history (opening + kickoff are posted in the same chat by design).
- CYOA disabled; combat choices enabled but no active combat (must stay exploration).
- `agents.stateTracker.enabled = false`; missing agent runner/connection; tracker rejects a batch.
- Swipe/re-render of the same assistant message must not tick time or double-apply tracker events.
- No encounter at the destination: the travel frame still narrates and the player can stay or travel again.
- Character-card hot-swap is **not** offered; `castMode: 'solo'` remains a narrator-card lookup. Do not add a switch that clears the chat.
- Content gate filters the encounter text; token budget drops the scene block.
- Old localStorage geometry (exact old default vs custom), multiple tabs/windows.
- Two `WorldState` store instances for the same chat: after a turn, the map must see the same state (shared store or reload).
- Repeated travel to the same location: dedupe only identical frames; a legitimate second visit still posts.
- `addOneMessage` absent or chat DOM not ready.
- Browser zoom / DPR: Leaflet and host measurements.

### Rollback
- Each step lands as its own commit; revert the commit to roll back.
- `map.closeOnTravel: false` disables the auto-close and `kickoff.auto` stays off by default; neither requires a code revert.
- Posted chat frames are ordinary messages and can be deleted by the user; the world state is unaffected.
- Steps 4–9 are additive to chat output/turn processing/combat actions; reverting removes the posts/tracker pass/action bar but leaves existing messages and state intact.

## Assumptions & Open Questions (for human approval)
1. **Canon identity fix:** read the rendered `data-character-id` rather than renaming the attribute. Confirm the tests should pin that contract.
2. **Settings handoff:** close the shell and open ST's Extensions drawer via `#extensions-settings-button .drawer-toggle`. Confirm you do not prefer embedding the settings UI inside the shell's Settings tab (which would duplicate the ST drawer's IDs).
3. **Map interpretation:** make the map tab shell fill the viewport and let the panel use that height (taller, still landscape). Confirm "more vertical" does not mean a portrait/near-square window.
4. **Season kickoff:** opening frame + goals/current-situation "your move" card, shell closes, input focused. `kickoff.auto` is **off by default**; when enabled on a fresh chat it sends one editable player prompt through ST's normal send path (suppressed when history exists); no direct `Generate()` call.
5. **Travel frame:** same chat, `Location changed: X → Y` + the travel intro, always posted, with CYOA regenerated when enabled. Confirm no new chat and no card hot-swap.
6. **Hot-swap:** not offered. `castMode: 'solo'` remains a narrator-card lookup; a real switch would clear the chat and discard the seeded world. If you want card switching, it needs a separate design (and a safe metadata migration).
7. **Turn pipeline:** tick `meta.turn` once per assistant message, run the player state tracker, refresh the map, then CYOA. The Storyline tracker keeps its `everyNTurns`/location cadence. Confirm, or say if the storyline should run every turn.
8. **Encounters:** deterministic, prose + CYOA, with explicit Engage/Talk/Avoid actions. Engage starts the deterministic combat flow; threat-only encounters keep Engage disabled. Confirm the exact action set.
9. **World state:** prompt-only via the interceptor, never in chat. Confirm that the travel/opening frames are the only visible chat elements and no HUD is wanted.
10. **Map close:** close the whole shell after travel (default on), not merely hide the map panel inside the tab. Confirm.
11. **Scope of posts:** season opening + travel now; storyline beats, combat results, and bad ends can follow later. Confirm.
12. **Geometry migration:** discard a stored geometry that exactly equals the old 1080×700 default; preserve custom sizes. Confirm.
