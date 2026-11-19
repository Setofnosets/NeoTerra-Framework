# Player POV presence, goals, choice routing, travel scenes, and agent presets

## Meta
- Slug: player-pov-goals-travel-choices-agent-presets
- Status: in progress — M1 step 1 landed (presence is NPC-only; the map and session home mark the player's location). Next: step 2 (Play-as relocation).
- Date: 2026-11-19
- Upstream: `plans/fix-identity-settings-map-travel-chat.md`, `plans/travel-feedback-followup.md`, `plans/character-card-fidelity.md`
- Requested by: user report (7 items) — see Summary

## Progress

**M1 — Player POV (steps 1â€“5)**
- [x] 1. Presence is NPC-only; player gets a "You are here" marker
- [ ] 2. Play-as moves the scene, presence, and the previous player
- [ ] 3. Season 2 Leila defaults to her villain form
- [ ] 4. Parse player goals; infer when the card yields nothing
- [ ] 5. Player card instruction + downloadable card

**M2 — Actor feedback (steps 6â€“9)**
- [ ] 6. Choices carry a routable kind/target
- [ ] 7. Route travel/combat chips to real actions with frames
- [ ] 8. Notice-first + deterministic ambush
- [ ] 9. Generated scene description on travel

**M3 — Agent control (steps 10â€“13)**
- [ ] 10. Saved agent presets
- [ ] 11. Profile/model/cadence pickers
- [ ] 12. Per-agent "Test connection"
- [ ] 13. Docs, changelog, QA script, version 1.3.0

## Summary

- **Goal:** close seven reported gaps in one coherent pass:
  1. Playing as a character must remove that character from the NPC presence shown on the map and in presence lists.
  2. Season 2 Leila must default to her villain form.
  3. Playing as a character must parse that character's goals, with an AI fallback when parsing yields nothing.
  4. Choosing a character must produce an instruction to create a character card with that exact name.
  5. Selecting a choice such as "engage in combat" must produce a visible response (combat starts), and travelling must too — including "a character notices you first".
  6. Travel must also generate a scene description, not only the deterministic arrival summary.
  7. The settings panel needs saved agent presets, dropdowns for agent configuration, and a "Test connection" button.
- **Context:** the framework already has deterministic presence (`syncPresence`), a Codex "Play as" path, card-derived goals, an in-chat scene-message writer, encounter detection, an encounter bar that can start combat, and a travel arrival frame. Each reported symptom is a *wiring or verification gap* in one of those paths, not a missing subsystem:
  - The player character keeps `locationId` and is written into `locations[].present` / `scene.present` by `syncPresence` (`src/state/reducer.js:145-161`) and by the season seed (`src/state/world-state.js:454-462,478-480`). Most consumers filter `controlledBy === 'player'`; the map view model and map submenu do not.
  - S2's roster points Leila at the post-defeat base card (`data/seasons/s2.json:42-46`), and `SET_PLAYER_IDENTITY` never applies a form, so the identity step's `formId` is dropped (`src/flows/season-start.js:301-313` vs `:529-538`).
  - Goals are seeded from explicit card labels only, and most cards (including Leila) have none or a truncated one; the Play-as path never re-derives or infers them.
  - Choices carry `intent`/`action`/`risk` but the chip click only sends the label as text (`src/ui/choices.js:221-249` â†’ `src/ui/shell.js:2185-2194`); nothing can start combat or travel from a chip.
  - Travel posts a deterministic frame; `SCENE_KINDS.ENCOUNTER` exists but is never posted, and there is no perception/notice step.
  - Agent configuration is 12 hand-written rows of raw text inputs (`src/ui/settings.js:426-492`) with no presets, no profile/model pickers, and no connectivity check.

## Current State (from exploration)

**Presence and identity.** `syncPresence` rebuilds every `location.present` and `scene.present` from `characters[].locationId`, including the player-controlled character (`src/state/reducer.js:145-161`). The seed does the same (`src/state/world-state.js:454-462`). Downstream, `renderCast` drops player-controlled entries (`src/context/renderer.js:163-166`), `getSceneCastNames` drops `player.characterId` (`src/flows/scene.js:57-63`), `detectEncounter` skips `player.characterId` and `controlledBy === 'player'` (`src/flows/encounter.js:86-92`), `worldbook` skips `controlledBy === 'player'` (`src/context/worldbook.js:450,472`), and HUD filters the player (`src/ui/hud.js:116-117`). But `buildMapViewModel` copies `live.present` verbatim into named locations (`src/data/map.js:1295,1326`), `buildMapSubmenu` reads it for the submenu (`src/data/map.js:1504-1510`), and `map-panel` renders it as "Present:" with an avatar strip (`src/ui/map-panel.js:259-282`). `session-home` also lists the player as present (`src/ui/session-home.js:109-112`, pinned by `tests/session-home.test.js:90-92`).

`SET_PLAYER_IDENTITY` (`src/state/reducer.js:600-670`) flips `controlledBy` and clones the character into `state.player`, but never touches `scene.locationId` or re-syncs presence. Codex `performPlayAs` (`src/ui/codex.js:1162-1197`) dispatches that event; `applyIdentity` (`:2197-2227`) then invalidates runtimes and emits `MAP_UPDATED`. The Codex mounts its own `createWorldStateStore` (`src/ui/shell.js:1741-1747`) while map/interaction use `getSharedWorldStateStore` (`src/state/store.js:78`), so the post-change visibility depends on the invalidation path, not on a shared store.

**Identity form defaults.** `buildIdentityChoices` emits `formId` per canon option (`src/flows/season-start.js:301-313`) but `resolveIdentitySelection` returns no `formId` (`:529-538`) and `startSeason` seeds `player: { identity, characterId, personaNotes, displayName }` only (`:717-722`). The active form therefore comes from the roster (`resolveSeasonRoster`, `src/data/seasons.js:635-662`). S2 lists `s2.leila.renya` (registry side `vigilante` — the post-defeat card, `data/characters/index.json:1189`) while the villain form `s2.leila.renya.femme.feral` (side `villain`, `:1233`) sits in `altFormsAllowed` (`data/seasons/s2.json:340-347`). Form rules allow both directions (`data/form-rules.json:185-197`).

**Goals.** `seedCharacter` sets `goals` from the card's explicit labels and `goalsSource: 'card'` (`src/state/world-state.js:261-262`); `card-profile.js` recognises only goal labels (`:58,84`) and `character-card-fidelity` decided label-only extraction. Leila's stored goal is a truncated sentence fragment (`data/characters/profiles.json:2271-2273`). The state tracker can rewrite goals (`src/agents/state-tracker.js:217,257-259`), the Storyline pass can rewrite NPC goals (`src/agents/storyline.js:317-322`), the worldbook renders them (`src/context/worldbook.js:137-142`), and the kickoff falls back to `agenda` (`src/ui/chat-output.js:234-239`). Nothing derives or infers goals at identity change.

**Choices.** The choices agent returns `{ label, intent, tone, action?, risk? }` (`src/agents/choices.js:50-75`); exploration keeps `intent` only, combat enforces `COMBAT_ACTIONS`/`COMBAT_RISK_TIERS` (`:446-471`). `renderChoicesMarkup` already writes `data-neoterra-choice-action`/`-risk` (`src/ui/choices.js:293-321`), but `choose()` forwards `(label, choice)` (`:221-249`) to `onSend`, and the shell wires `onSend: (text) => sendChoiceText(text)` (`src/ui/shell.js:2280-2286`), which sets `#send_textarea` and clicks send (`:2185-2194`). The prompt never names map location ids, so a travel chip cannot carry a destination (`src/agents/choices.js:243-359`).

**Travel and encounters.** `travel()` validates, commits an atomic batch, refreshes the cast, and returns `intro` (`src/flows/travel.js:422-575`); `buildLocationIntro` is deterministic prose naming location, control, cast, and hostiles (`src/flows/scene.js:172-259`); `postTravelOutcome` posts one `travel` frame + `extra.neoterra.travel`, decorates it, announces, then requests choices (`src/ui/shell.js:1364-1435`). `SCENE_KINDS.ENCOUNTER` is unused (`src/ui/chat-output.js:23-30`). Combat starts only from the encounter bar (`src/ui/shell.js:2401-2427`), which posts one deterministic `combat` frame (`src/ui/encounter-bar.js:374-387`) and then requests combat choices. There is no perception/notice/ambush step anywhere; `rollD20` is deterministic and seeded (`src/combat/resolver.js:99-118`).

**Agent configuration.** `buildAgentConfigMarkup` renders 12 agent rows of text inputs (`src/ui/settings.js:426-492`); values paint from `data-neoterra-path` (`:1084-1100`) and write through `onChange` (`:1116-1149`). Defaults live per agent (`src/core/defaults.js:153-263`) and are normalised by `normalizeAgent` (`src/core/migrations.js:145-190`). Presets exist only as the three whole-settings `UI_PRESETS` (`src/core/defaults.js:362-432`). The agent client routes through `ConnectionManagerRequestService` â†’ `ChatCompletionService` â†’ `generateRaw` (`src/agents/client.js:551-642`); configuration is resolved in `resolveAgentConfig` (`src/agents/prompts.js:62-109`).

**Key files:** `src/state/reducer.js`, `src/state/world-state.js`, `src/state/selectors.js`, `src/state/store.js`, `src/ui/codex.js`, `src/ui/season-menu.js`, `src/flows/season-start.js`, `src/data/seasons.js`, `data/seasons/s2.json`, `src/data/map.js`, `src/ui/map-panel.js`, `src/ui/session-home.js`, `src/ui/hud.js`, `src/data/card-profile.js`, `src/data/goals.js` (new), `src/agents/goal-inference.js` (new), `src/agents/choices.js`, `src/ui/choices.js`, `src/ui/shell.js`, `src/ui/chat-output.js`, `src/flows/scene.js`, `src/flows/encounter.js`, `src/agents/scene-describer.js` (new), `src/ui/settings.js`, `src/ui/settings.html`, `src/core/defaults.js`, `src/core/migrations.js`, `src/agents/client.js`, `src/agents/prompts.js`, `src/ui/toasts.js`, `tests/*`.

**Landmines:**
- The Codex is mounted with its own `createWorldStateStore` (`src/ui/shell.js:1741`), not the shared per-chat store. Any "player left on the map" diagnosis must check whether the map re-read the same document rather than a stale cached `current`.
- `syncPresence` is called from every location/character mutation; changing it to exclude the player changes `scene.present` for the seed too, and at least `tests/world-state.test.js:191-197`, `tests/session-home.test.js:90-92`, and `tests/character-creator-agent.test.js:140` pin the old shape.
- `SET_PLAYER_IDENTITY` mirrors the character into `state.player` without touching `scene.locationId`, so `player.locationId` can diverge from the scene; the play-as confirmation promises the old player "returns to the NPC pool" but presence never re-runs on identity change.
- `buildIdentityChoices`'s `formId` is dead data — the roster form wins. Fixing Leila via the identity step alone will not work.
- Identity change invalidates chat runtimes with `keepCodex: true` (`src/ui/shell.js:1773`), so anything cached on the discarded map/interaction runtime (including a goals inference result) must be re-read from metadata.
- `choose()`'s exactly-once guard is keyed by message/swipe/mode; routing a chip to travel/combat must consume the same guard or a double click starts two fights.
- Combat start currently posts no model turn; adding one would reorder the ST generation pipeline and must not be improvised.
- Travel frame dedupe is keyed `travel:<chatId>:<from>:<to>:<turn>` (`src/ui/shell.js:1376-1382`); a generated description must not change the key or reload duplicates it.
- The choices prompt is already long; adding every map location id will blow up small contexts. Restrict to the current location's connections.
- `map.closeOnTravel` defaults `true`, so a chip-driven travel must run the same close/announce path as the map, not a shortcut.
- `data/characters/profiles.json` is generated; any parser change requires `npm run build:data` and a `--check`-clean rebuild.
- SillyTavern exposes `ConnectionManagerRequestService`, `ChatCompletionService`, `getChatCompletionModel`, and `chatCompletionSettings` (`ST/public/scripts/st-context.js:227,289,292,294`) but no stable cross-provider model-list API; `/api/backends/chat-completions/status` is provider-specific.

## Constraints & Requirements

- **Tech stack:** vanilla ES modules, no bundler, no runtime dependencies. Pure logic in `src/data`, `src/state`, `src/flows`, `src/agents`; DOM only in `src/ui`. Tests are `node:test` plus source-level CSS/markup assertions (`npm test`, `npm run check`).
- **State authority:** `WorldState` in `chatMetadata.neoterra.worldState` stays the only world authority. Prompt blocks are injected by the generate interceptor, never written into `ctx.chat`; scene frames stay ordinary assistant messages (`is_system:false`, `is_user:false`).
- **Determinism first:** every new behaviour has a deterministic path that works with no model and no map open. AI passes (goal inference, travel description) are bounded, time-boxed, cancellable, content-gated, and never required for correctness.
- **Persistence:** presets live in settings (`extensionSettings.neoterra`) and must survive export/import and `normalizeSettings`; anything per-chat lives under `chatMetadata.neoterra` or `WorldState.flags`.
- **Out of scope:** rewriting season content, changing card text, character-card hot-swapping, a new chat per location, an in-chat HUD, map styling redesign, a per-provider model registry, and auto-narration after combat starts.

## Assumptions

1. **Decided:** "remove from the map" means the played character is never listed as an NPC in `Present:`/avatar strips and gets a distinct "you are here" marker. They stay listed in the **Player tab** and in the **Characters tab (Codex)** so form swaps, card re-derivation, goal reset, and card import keep working.
2. Presence arrays (`locations[].present`, `scene.present`) are an **NPC list**. The player's location is the scene location, mirrored in `state.player.locationId`. Any consumer that wants the player reads `state.player`.
3. Leila's S2 villain form is the *canon* state for the season's date (2042-05-04, post-usurpation, pre-defeat), so the roster should point at `s2.leila.renya.femme.feral`.
4. "Instruction to create a character card" means an explicit, copyable instruction plus a downloadable card whose `data.name` equals the chosen character's display name.
5. Goals: deterministic parse first (labels + explicit motive sentences), then at most one inference call, applied only to the player.
6. Choice routing applies to travel and combat chips only; free text still goes through SillyTavern's normal send.
7. "Notices you first" is prose + an encounter frame, not a rules change (no free attack, no hidden combat start) — **unless it is an ambush**, which is its own rule (Decision 6).
8. The travel scene description is a second short frame so travel stays instant.
9. Presets snapshot the `agents` block only (not the whole settings document), and the three `UI_PRESETS` stay as separate recommended presets.
10. The connection-profile dropdown reads `ConnectionManagerRequestService.getSupportedProfiles()`; the model field is a combobox because no reliable cross-provider list exists.

## Decisions (approved 2026-11-19)

1. **Play-as relocation** â†’ the scene moves to the new player's location; the previous player re-enters the NPC pool where they stood. (Step 2)
2. **Played character visibility** â†’ absent from every NPC presence surface (map submenu avatars, Story card cast strip, HUD present list, prompt cast block, encounter detection); **present** in the Player tab and the Characters/Codex tab with all per-character actions intact (form swap, re-derive from card, reset goals, import profile, generated-form review, return to custom). (Step 1 keeps the Codex row and adds an explicit `isPlayer` player section.)
3. **Goals** â†’ deterministic parse always; one AI inference pass automatically when the derived list is empty and `agents.goalInference.enabled`; manual "Infer goals" retry in the Codex. (Step 4)
4. **Travel chip reach** â†’ only directly connected locations, capped at 8. (Step 6)
5. **Travel description** â†’ deterministic arrival frame first, then one generated `kind:'scene'` frame; never merged, never blocks the map close. (Step 9)
6. **Notice vs ambush** â†’ default: a hostile notices you, you get the first move (prose + `encounter` frame, no state change). **Ambush exception:** when the deterministic check is a strong success for the hostile side *and* the location is `hostile`/`contested` *and* the player arrived without stealth, the arrival becomes an ambush: the frame names the attacker, the encounter bar starts in a "Surprised" state, and the first chip set is restricted to defensive/escape actions (`defend`, `retreat`, `talk-down`, `surrender`) for one round. Ambush never resolves a hostile action on its own, so the engine stays free of NPC turns. Gated by `travel.ambush` (default `true`; set `false` to demote every ambush to the plain notice). (Step 8) — **confirmed 2026-11-19: the restricted-first-round reading, not a resolved hostile attack.**
7. **Player card** â†’ instruction + downloadable `<Name>.json` with `data.name` exactly equal to the display name, plus one prompt line; never writes to `Chars/`. (Step 5)
8. **S2 Leila** â†’ roster `formId: s2.leila.renya.femme.feral`; fallen base card reachable by form swap. (Step 3)
9. **Presets** â†’ snapshot `agents` only, stored in settings, exported with them; `UI_PRESETS` stay a "Recommended" group. (Step 10)
10. **Test connection** â†’ one tiny real request per agent through its configured route, 20 s cap; "Test all" up to one request per agent. (Step 12)
11. **Version** â†’ `1.3.0` in `package.json` and `manifest.json`. (Step 13)


## Milestones

The 13 steps ship as **three milestones**. Each milestone is independently reviewable, leaves `npm run check` green, and ends with a user-visible improvement — so a milestone can be released and playtested before the next one starts. Steps keep their own commits (one PR-sized unit each); the milestone is the review/release boundary.

| Milestone | Steps | Theme | Release signal |
|---|---|---|---|
| **M1 — Player POV** | 1â€“5 | Who the player *is*: presence, takeover, S2 Leila's form, goals, the player card | Play as anyone from the Codex and the world agrees: the map shows only NPCs, the scene follows you, Leila is her villain self in S2, your goals are real, and you have a card named after you |
| **M2 — Actor feedback** | 6â€“9 | What the player *does and sees*: routable chips, travel/combat frames, notice/ambush, generated scene | Clicking a choice produces a visible consequence; travel narrates the arrival and the danger |
| **M3 — Agent control** | 10â€“13 | How the player *tunes the machine*: presets, pickers, connection test, docs | Configure and verify all 12 agents from the settings drawer without typing raw ids |

**Ordering rationale.**
- **M1 first** because it changes state semantics: presence becomes NPC-only and identity moves the scene. Every later milestone reads that contract. Steps 1â€“3 are the plumbing; steps 4â€“5 are the identity payload (goals + card) that makes the takeover feel real.
- Step 5 sits with the identity work rather than with the choices work: it is the *instruction* half of "you are playing as this character", and it reuses the same Codex/identity surfaces as steps 2 and 4.
- **M2 depends on M1 only through presence and the player's location**, not through goals or the card, so steps 6â€“7 can start as soon as step 1 lands if you want to parallelise. Step 8 needs 7 (same frame path); step 9 needs 8 (it describes the notice/ambush facts).
- **M3 is fully independent** of M1/M2. No file in steps 10â€“12 is touched by the gameplay work except `src/core/defaults.js` and `src/ui/settings.html`, so it can run with a different implementer or ship first if agent configuration is the more urgent pain. The one shared file is `defaults.js` (steps 4 and 9 add agent entries; step 10 adds `agentPresets`) — land the `agentPresets` key first or accept one trivial merge.
- Step 13 documents all three milestones but is written last, against the final shipped surface.

**Milestone exit criteria (applies to every milestone).**
- `npm test` and `npm run check` green, no hand-edited generated artifacts.
- The milestone's manual checks from Â§Verification & Testing pass on a fresh chat.
- No regressions in the preceding milestone's manual checks.
- Kill switches for any new behaviour exist and are documented before the milestone ships.

## Step-by-Step Implementation Plan

### Milestone M1 — Player POV (steps 1â€“5)

#### 1. Make presence NPC-only and give the player a dedicated marker
- **Files:** `src/state/selectors.js`, `src/state/reducer.js`, `src/state/world-state.js`, `src/data/map.js`, `src/ui/map-panel.js`, `src/ui/session-home.js`, `src/ui/codex.js`, `src/ui/player-panel.js`, `style.css`, `tests/world-state.test.js`, `tests/reducer.test.js`, `tests/map-model.test.js`, `tests/exploration.test.js`, `tests/session-home.test.js`, `tests/codex.test.js`
- **Depends on:** none
- **Parallelizable:** yes (step 2 touches the same reducer, so land first)
- **Expected behavior:**
  - Add `isPlayerCharacter(state, id)` (canon `player.characterId` or `controlledBy === 'player'`) and `selectPresenceIds(state, ids)` to `src/state/selectors.js`; export the rule once.
  - `syncPresence` and the season seed write presence as **NPC-only** (`controlledBy !== 'player'`), so every existing consumer that already filters becomes correct by construction and the map no longer lists the player.
  - `buildMapViewModel` gains `playerLocationId` (from `state.player.locationId ?? state.scene.locationId`) and never puts the player in `namedLocations[].present`; `buildMapSubmenu` keeps the NPC list and adds `isPlayerHere`.
  - `map-panel` renders the arrival/selection submenu "Present:" from NPCs only and shows a distinct `data-neoterra-map-player-here` marker ("You are here") on the player's location; CSS gives it a distinct ring.
  - `session-home` keeps a `presentNpcs` list and a separate `playerHere` boolean; the renderer shows "You are here" instead of the player's name in the cast list.
  - **Keep the Codex and Player tab as-is:** `buildCodexView` must keep returning the played character as an item (it already flags `isPlayer`), and the detail view must keep every action (form swap, re-derive from card, reset goals, import profile, generated-form approve/regenerate/export, return to custom). Add one `data-neoterra-codex-player-section` marker so a test can assert the row survives and a filter never hides it (`matchesFilters` gets a bypass for the player).
  - Backfill for existing chats: a world-state migration that is fill-only in the safe direction (remove the player from presence arrays) and idempotent.
- **Acceptance criteria:**
  - New unit tests: a canon player is absent from every `location.present` and from `scene.present` after seed, travel, identity change, and a tracker cast refresh; a custom-persona player adds nobody.
  - `buildMapViewModel` tests: the played character is absent from `namedLocations[].present` and `playerLocationId` equals the scene location; the submenu never lists the player.
  - `session-home` tests: `presentNpcs` excludes the player, `playerHere` is true at the scene location.
  - Codex tests: the played character still appears in the item list and detail pane, `matchesFilters` cannot filter them out, and the form-swap/re-derive/reset-goals hooks are still rendered.
  - Migration test: an old world that lists the player is cleaned exactly once and a second run is a no-op.
  - `npm run check` green.
- **Risk:** medium-high (state shape semantics; several pinned tests change)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `fix(state): keep the player out of NPC presence and mark their location on the map`

#### 2. Make Play-as hand off location, presence, and the previous player cleanly
- **Files:** `src/state/reducer.js`, `src/ui/codex.js`, `src/ui/shell.js`, `tests/codex.test.js`, `tests/reducer.test.js`, `tests/guest-identity.test.js`
- **Depends on:** 1
- **Parallelizable:** no
- **Expected behavior:**
  - On `SET_PLAYER_IDENTITY` (canon), set `scene.locationId` to the new player's `locationId` when it differs (taking over a character takes over where they are), then call `syncPresence` so the previous player re-enters the NPC pool at their old location and the new player leaves every presence list.
  - Keep `state.player.locationId` and `scene.locationId` in sync as an invariant; document it in the reducer comment.
  - `performPlayAs` seeds a missing roster/sandbox character as today, and now also reports `{ ok, changed: 'identity' | 'seeded', locationId }` so the Codex can announce the move.
  - Codex `applyIdentity` posts/updates a short status line naming the new POV and location, and the confirmation copy (`buildPlayAsConfirmation`) states which location the POV moves to.
  - Verify that the map reads the post-change document (either the Codex uses the shared store, or the invalidation + `MAP_UPDATED` path is proven by a test); fix it here if the Codex's private store is the stale one.
- **Acceptance criteria:**
  - Reducer test: playing as a character at another location moves `scene.locationId`, drops the new player from `scene.present`/`location.present`, and restores the previous player as an NPC at their location.
  - Codex test with a fake store: one dispatch, status text, no second store left caching the old state.
  - Manual: in S2, Play as Leila â†’ the scene is at her location, the map shows "You are here" there, and no avatar strip lists her as an NPC.
- **Risk:** high (identity semantics reach every downstream view)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `fix(identity): move the scene and presence with the new player POV`

#### 3. Default Season 2 Leila to her villain form
- **Files:** `data/seasons/s2.json`, `src/data/seasons.js` (validation only if needed), `src/flows/season-start.js`, `tests/seasons.test.js`, `tests/season-start.test.js`, `tests/world-state.test.js`
- **Depends on:** 2 (roster-form semantics are exercised by the Play-as tests)
- **Parallelizable:** yes
- **Expected behavior:**
  - Change the S2 roster entry for Leila to `characterId: "s2.leila.renya"`, `formId: "s2.leila.renya.femme.feral"` so the seeded form, side, portrait, and traits are the villain-era ones; keep `altFormsAllowed` as-is so the fallen form remains reachable through `TRANSFORM`.
  - Preserve the identity step's chosen form: `resolveIdentitySelection` returns the roster `formId` for canon roster picks (and `entry.id` for sandbox/guest picks), `startSeason` passes it to the seed, and `seedCharacter` uses `member.formId` (already does) — add the missing link so a future alt selection is not silently dropped.
  - If a canon player is seeded without an explicit form and the roster declares one, that form wins (one test).
- **Acceptance criteria:**
  - `tests/seasons.test.js` / `season-start.test.js`: S2 resolves with Leila's form = `s2.leila.renya.femme.feral` and side `villain`.
  - `tests/world-state.test.js`: a S2 seed gives Leila `formId`/`side` from the villain form and a villain portrait id.
  - Manual: start S2 â†’ Codex shows Leila as Femme Feral (villain); the identity step highlights the same form; `TRANSFORM` back to the base card still works.
  - `npm run check` regenerates nothing (season docs are authored, not built).
- **Risk:** low-medium (data change; validates against existing season schema)
- **Model / Effort:** standard implementer, low effort
- **Commit message sketch:** `fix(s2): seed Leila in her villain form by default`

#### 4. Parse player goals and infer them when the card yields nothing
- **Files:** `src/data/goals.js` (new), `src/agents/goal-inference.js` (new), `src/agents/prompts.js`, `src/core/constants.js`, `src/core/defaults.js`, `src/core/migrations.js`, `src/ui/codex.js`, `src/flows/season-start.js`, `src/ui/shell.js`, `src/ui/chat-output.js`, `tests/goals.test.js` (new), `tests/goal-inference.test.js` (new), `tests/codex.test.js`, `tests/season-start.test.js`
- **Depends on:** 2
- **Parallelizable:** no (identity hook)
- **Expected behavior:**
  - `src/data/goals.js` (pure): `deriveGoalsFromProfile(profile, { max = 5, maxLength = 160 })` — first use explicit labels (`Goals/Motives`, `Motive`, `Ultimate Goal`, `Motivation`, `Ambition`, `Objective`, `Drive`), then mine *only* explicit motive sentences from `background`/`identity` that contain a goal verb (`wants`, `seeks`, `intends`, `plans`, `must`, `obsessed with`, `sworn to`); drop fragments, quoted dialogue, and text over the cap. `normalizeInferredGoals(value, caps)` clamps AI output.
  - `src/agents/goal-inference.js`: one schema-validated call — `{ goals: string[], rationale: string }` (3â€“5 goals, â‰¤160 chars) — prompt built from the character's card profile, agenda, season premise, and current scene; grounded, never inventing new canon. Registered in `AGENT_IDS` with defaults (`enabled: true`, temperature 0.3, maxTokens 500, cadence `onIdentityChange`), wired in the settings UI by the existing `AGENT_IDS` loop.
  - `ensurePlayerGoals({ store, registry, profiles, runner, settings, characterId })`: derive â†’ if non-empty, dispatch `SET_CHARACTER_FIELDS.goals` with `goalsSource: 'card'`; if empty and the agent is enabled, run once with a 20 s budget, dispatch with `goalsSource: 'live'` and record `flags.goalInference = { characterId, at, source: 'ai', model }`; if the call fails, leave goals empty and log — never block the identity change.
  - Wire into Codex `applyIdentity`, into `startSeason` for a canon player, and into `CONTINUE_BAD_END` self-continuation (same rule).
  - Surface it: Codex "Goals" block gains a small "Infer goals" button and a "Source: card | live | inferred" hint; the kickoff `Goals:` line already reads the live list, so it reflects the result without extra work.
- **Acceptance criteria:**
  - `tests/goals.test.js`: a labelled card yields its goals; a card with only motive prose yields 1â€“5 sentence goals â‰¤160 chars; quoted dialogue and truncated fragments are dropped; Leila's stored fragment is rejected and not surfaced as a goal.
  - `tests/goal-inference.test.js`: a fake runner returning valid/invalid JSON applies/preserves goals; a transport failure leaves state untouched; the call is skipped when goals already exist or the agent is disabled; one call per identity change.
  - Codex test: Play as a character with no goals â†’ goals populated exactly once, `goalsSource` set, no unhandled rejection; a second mount does not re-infer.
  - Manual: Play as a character with no goal label â†’ kickoff shows goals immediately (deterministic) or after inference; the tracker can still rewrite them next turn.
- **Risk:** medium-high (new agent call on a hot path; prompt/canon drift)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(identity): derive or infer the player's goals when they take over a character`

#### 5. Emit a "create a character card with this name" instruction and a matching card
- **Files:** `src/data/player-card.js` (new), `src/ui/codex.js`, `src/ui/season-menu.js`, `src/ui/toasts.js`, `src/ui/download.js` (reuse), `src/context/renderer.js`, `src/ui/chat-output.js`, `tests/player-card.test.js` (new), `tests/codex.test.js`, `tests/context.test.js`
- **Depends on:** 2 (identity-change surfaces); consumes 4's goals when present
- **Parallelizable:** yes with 4 (after 2 lands)
- **Expected behavior:**
  - `buildPlayerCardDocument({ character, profile, registryEntry, season })` returns a SillyTavern V2/V3 card envelope (`spec`, `spec_version`, `data.*`) whose `data.name` is **exactly** the character's display name, with description assembled from the profile sections already used by the creator (identity, appearance, attire, abilities, personality, speech, likes/dislikes, goals, background, weakness, combat style, gear) plus one `first_mes` = the current location intro; `buildPlayerCardInstruction({ displayName, seasonTitle, locationName })` returns one short instruction string: "Create a character card named <Name> in SillyTavern (Characters â†’ Import character), then select it in this chat so the narrator addresses you by name."
  - Codex identity section gains: a `Create card named <Name>` button (downloads `<Name>.json` via `downloadJson`), the instruction text with a Copy button, and the same in the season setup strip after a canon identity is chosen.
  - After a Play-as identity change, push one toast (`id: player-card:<characterId>`) with the instruction and a "Download card" action; suppressed by a setting (`identity.cardInstruction`, default true) and deduped per character.
  - Prompt: add one line to `[NEOTERRA_PLAYER]` — `Player card: <Name> (address the player as <Name>)` — so the narrator never renames the POV. No new block, no state dump.
  - Do not write to `Chars/`; the download is a user action. Generated/sandbox characters follow the same path with their stored profile.
- **Acceptance criteria:**
  - `tests/player-card.test.js`: the card name equals the display name byte-for-byte (including "Leila Renya"), the envelope validates shape, the description contains no `[NEOTERRA_` block, the filename is sanitized.
  - Codex markup test: both the download and copy hooks exist for a canon identity; the instruction text names the character.
  - Context test: `[NEOTERRA_PLAYER]` contains the card line and stays within budget.
  - Manual: Play as Leila â†’ toast + instruction; download â†’ import into SillyTavern â†’ the card appears with the exact name; the narrator uses the name.
- **Risk:** low-medium (pure builder + UI)
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(identity): instruct and export a player card named after the chosen character`

### Milestone M2 — Actor feedback (steps 6â€“9)

> M2 depends on M1 only through presence (step 1) and the player's location, not through goals or the card. Steps 6â€“7 can start as soon as step 1 lands. Step 8 needs 7 (same frame path); step 9 needs 8 (it describes the notice/ambush facts).

#### 6. Give choices a routable payload for travel and combat
- **Files:** `src/agents/choices.js`, `src/ui/choices.js`, `src/core/defaults.js`, `src/ui/settings.html`, `tests/choices.test.js`
- **Depends on:** none (pure payload; routing lands in 7)
- **Parallelizable:** yes
- **Expected behavior:**
  - Schema gains optional `kind` (`prose | travel | combat`) and `target` (a location id or `engage`); exploration prompt lists the current location's **connected** locations as `id — name` (capped at 8) plus the current encounter's hostile ids/names, and instructs: travel chips must carry a valid connected `target`; an engage chip must use `kind: 'combat'`.
  - `normalizeChoice` validates `kind`/`target` against the supplied allow-lists; an unknown location downgrades to `prose` (never a broken chip). Combat mode keeps `action`/`risk` and additionally emits `kind: 'combat'` when the label is an engage/strike action against a known hostile.
  - `renderChoicesMarkup` writes `data-neoterra-choice-kind` and `data-neoterra-choice-target`; the chip title shows the destination/opponent for clarity.
  - Defaults: no new knob; the feature is part of CYOA when enabled.
- **Acceptance criteria:**
  - Unit tests: prompt includes only connected ids; a travel choice with an unknown target is downgraded; a combat choice keeps action/risk and gains kind; a valid travel chip round-trips kind+target.
  - Existing choices tests (once-only send, combat vocabulary, cache keys) stay green.
- **Risk:** low
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(choices): tag chips with a routable kind and target`

#### 7. Route travel and combat choices to real engine actions with visible responses
- **Files:** `src/ui/shell.js`, `src/ui/choices.js`, `src/flows/travel.js` (read-only contract), `src/ui/chat-output.js`, `src/ui/encounter-bar.js` (reuse frame text), `tests/choices.test.js`, `tests/encounter.test.js`, `tests/travel.test.js`
- **Depends on:** 6
- **Parallelizable:** no (shell orchestration)
- **Expected behavior:**
  - Shell `onSend(text, choice)` becomes a router: `prose` â†’ today's `sendChoiceText`; `travel` with a valid target â†’ the same handler the map uses (travel â†’ arrival frame â†’ announce/close â†’ choices), with one in-flight guard and a short status line if the route is rejected; `combat` â†’ if an encounter exists, call the existing `engageEncounter` path (combat frame + combat choices); if no encounter/hostiles, do not start combat — post a short `kind:'notice'` frame ("No one here to fight — <reason>") and keep the prose path available.
  - Exactly-once: reuse the controller's `messageKey` guard; a second click on the same row is a no-op even while travel/combat is in flight.
  - After a routed action, hide the chip row immediately and refresh the encounter bar + CYOA for the newly posted frame index.
  - `kind:'combat'` requires the combat flow to be idle; a failed start shows the reason in a status line and posts nothing (existing contract).
  - No new chat, no character-card switch, `map.closeOnTravel` still governs the close.
- **Acceptance criteria:**
  - Fake-runtime tests: a travel chip calls travel exactly once with the target, posts one travel frame, requests choices once; a rejected travel posts nothing and shows a status; a combat chip with an encounter starts combat once, posts exactly one combat frame, requests combat choices; a combat chip without an encounter posts a notice and starts nothing.
  - Double-click test: one action, one frame.
  - Manual: with CYOA on, click "Travel to the Docks" â†’ map closes (default), arrival frame and chips appear; click "Engage <name>" â†’ combat frame, tactical chips, travel blocked.
- **Risk:** high (chat writes + async races + combat/travel state transitions)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(choices): execute travel and combat choices with visible scene frames`

#### 8. Let a hostile notice the player first — and let a real ambush open the fight
- **Files:** `src/flows/encounter.js`, `src/flows/scene.js`, `src/ui/chat-output.js`, `src/ui/shell.js`, `src/ui/encounter-bar.js`, `src/core/defaults.js`, `src/core/migrations.js`, `src/ui/settings.html`, `style.css`, `tests/encounter.test.js`, `tests/travel.test.js`, `tests/combat.test.js`, `tests/ui-css.test.js`
- **Depends on:** 7 (same frame/posting path)
- **Parallelizable:** no
- **Expected behavior:**
  - Pure `detectNotice({ state, encounter, seed, stealth })` in `src/flows/encounter.js`: `null` when there is no encounter or combat is active; otherwise a deterministic d20-style check (`rollD20`) comparing the most threatening hostile (`threatLevel`, then side) against the player's stealth-ish abilities/traits/travel mode. Returns `{ noticedFirst, ambush, actorId, margin, tier }`. Seed derives from `chatId + turn + encounterKey` so a reload reproduces the identical result. Settings `travel.noticeFirst` (default `true`).
  - **Notice (default outcome):** post one `kind:'encounter'` frame (finally using `SCENE_KINDS.ENCOUNTER`): "<Name> spots you before you can act. <one deterministic line about position/cover>." No state change, no auto-combat; the encounter bar says the initiative is theirs, and the player still picks Engage/Talk/Avoid.
  - **Ambush (Decision 6):** when `travel.ambush` is on (default `true`), the check is a strong success for the hostile side (`margin >= 5`), and the location `status` is `hostile` or `contested`, the arrival escalates instead of merely noticing:
    1. post the `encounter` frame naming the attacker and the ambush ("<Name> springs the ambush before you can move."),
    2. start combat through the existing `createCombatFlow.start` with the player side `a` and the hostiles `b` (same participant resolution as the encounter bar Engage path),
    3. mark the combat `flags.lastCombat.ambush = true` and record `scene.combat.opening = 'hostile'`,
    4. render the encounter bar in a **Surprised** state for the first round: only `defend`, `retreat`, `talk-down`, and `surrender` chips are offered, and the bar shows "Surprised — fight back or break away".
    - The engine resolves **no** hostile action on its own: the restricted first round is the entire mechanical penalty, so it stays deterministic, replayable, and free of NPC turns. Document that choice explicitly.
  - `buildLocationIntro` appends one neutral notice/ambush line when the scene carries `scene.noticed` / `scene.ambush`, and `[NEOTERRA_SCENE]` renders `Noticed:` (and `Ambushed by:` when set) so the next prompt knows.
  - Suppress notice/ambush for same-side arrivals, for threat-only encounters with no character ids (prose line only), and when the player arrived by a stealth-coded ability.
- **Acceptance criteria:**
  - Unit tests: same seed + same encounter â†’ identical result; no encounter/active combat â†’ `null`; `noticeFirst:false` â†’ `null`; `ambush:false` demotes a strong hostile success to a plain notice; a `hostile` location with the same roll yields `ambush:true` while a `stable` location yields `noticedFirst` only; `threatLevel: 'high'` outranks `'low'` in the deterministic mapping; the tie-break is documented and asserted.
  - Frame tests: notice/ambush text names the actor, contains no numbers or `[NEOTERRA_` blocks, and is content-gated.
  - Shell tests: noticed arrival posts travel frame then exactly one encounter frame, deduped on re-render; ambush arrival posts one encounter frame, starts combat exactly once with the right sides, and paints the Surprised bar; a peaceful arrival posts nothing extra.
  - Manual: travel into a hostile district â†’ either a "spots you" frame (player acts first) or an ambush frame followed immediately by a combat bar restricted to defensive/escape chips; the next round offers full combat choices; `travel.ambush:false` removes the second behaviour entirely.
- **Risk:** medium-high (touches combat start on the travel path)
- **Model / Effort:** `implement-hard`, high effort
- **Commit message sketch:** `feat(travel): let hostiles notice the player and spring a deterministic ambush`

#### 9. Generate a scene description on travel
- **Files:** `src/agents/scene-describer.js` (new), `src/agents/prompts.js`, `src/core/constants.js`, `src/core/defaults.js`, `src/core/migrations.js`, `src/ui/shell.js`, `src/ui/chat-output.js`, `src/flows/scene.js`, `src/state/world-state.js`, `tests/scene-describer.test.js` (new), `tests/agent-wiring.test.js`, `tests/chat-output.test.js`
- **Depends on:** 7, 8
- **Parallelizable:** yes after 8
- **Expected behavior:**
  - New agent `sceneDescriber` (`enabled: true`, temperature 0.85, maxTokens 320, timeout 12 s, cadence `onTravel`) with a prompt grounded in: location name/district/status/faction, time slot/date, present NPC names + short profiles, encounter/notice/ambush facts, season tone, content gate level. Output schema `{ description: string (<= 480 chars), sensory: string[] (<= 4) }`, 2â€“3 sentences, present tense, second person addressed to the player, no new characters, no outcomes, no numbers, no state.
  - After a successful travel, `postTravelOutcome` posts the deterministic frame first (unchanged key), then runs the describer with a short budget and posts **one** follow-up `kind:'scene'` frame keyed `scene-desc:<chatId>:<travelKey>`; deduped so reloads/remounts never duplicate it. On failure/timeout/chat switch, post nothing extra and log at debug.
  - `flags.travelDescriptions` keeps the last 10 entries shaped `{ key: travelKey, text, at }` so the map sidebar/arrival card can show it without another call; `WorldState` validation accepts the new optional flag.
  - The description is content-gated at post time (never stored raw in `ctx.chat` beyond the gated text) and stripped of any context block.
- **Acceptance criteria:**
  - Pure tests: prompt contains location/cast/encounter facts and no card text beyond caps; a schema-valid response yields â‰¤480 chars with no `[NEOTERRA_`; truncation/failure yields `null`.
  - Shell test: travel posts deterministic frame, then one scene-description frame; a deduped re-render posts nothing; the describer is skipped when `agents.sceneDescriber.enabled` is false or when the chat switched.
  - Manual: travel with the agent on â†’ arrival frame, then a short atmospheric description within ~12 s; off â†’ only the deterministic frame; a slow model never blocks the map close.
- **Risk:** medium (extra agent call on travel; latency)
- **Model / Effort:** standard implementer, high effort
- **Commit message sketch:** `feat(travel): add a generated scene description frame after arrival`

### Milestone M3 — Agent control (steps 10â€“13)

> M3 is independent of M1 and M2. It can run concurrently with a different implementer. One shared file: `src/core/defaults.js` (step 10 adds `agentPresets`; steps 4 and 9 add agent entries). Land the `agentPresets` key first, or accept one trivial merge.

#### 10. Add saved agent presets to settings
- **Files:** `src/core/defaults.js`, `src/core/migrations.js`, `src/core/settings.js` (reuse), `src/ui/settings.html`, `src/ui/settings.js`, `tests/settings.test.js`, `tests/onboarding.test.js`
- **Depends on:** none
- **Parallelizable:** yes with 11 and 12 (all settings; sequence to avoid one stylesheet/template collision — 10 first)
- **Expected behavior:**
  - Settings gain `agentPresets: { activeId: string, items: Record<id, { name, createdAt, agents }> }` (default empty) and `agents.*` remains the live document.
  - Pure helpers in `src/core/defaults.js` (or a new `src/core/agent-presets.js`): `listAgentPresets(settings)`, `saveAgentPreset(settings, name)`, `applyAgentPreset(settings, id)`, `deleteAgentPreset(settings, id)`, `renameAgentPreset(...)` — all return new documents, validate names, cap at 20 presets, and clone `agents` deeply.
  - Settings template: a row at the top of the Agents section — `Preset` `<select>` (None + saved), `Save as…`, `Update`, `Delete`, `Apply`; selecting a preset applies it immediately (with a status line "Applied preset X to 12 agents"); the three `UI_PRESETS` appear in the same dropdown under a "Recommended" optgroup and stay separate actions.
  - Persist through the existing `saveSettings` + `SETTINGS_CHANGED` bus; presets travel with settings export/import and survive `normalizeSettings` (unknown preset ids are dropped, items normalised against `DEFAULT_SETTINGS.agents`).
- **Acceptance criteria:**
  - Unit tests: save â†’ snapshot equals live agents; edit an agent â†’ `Update` changes only that preset; apply restores every agent field including `prompt` and `cadence`; delete/rename; 21st preset rejected; export/import round-trip keeps presets; migration on a settings document with no `agentPresets` adds the empty shape.
  - Markup test: the select, Save, Update, Delete, Apply hooks exist and the Recommended optgroup lists `cinematic|classic|sandbox`.
  - Manual: save a preset, change three agents, apply the preset â†’ all three revert; reload â†’ the preset list persists.
- **Risk:** low-medium (settings migration + template)
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(settings): save, apply, and delete agent presets`

#### 11. Turn agent configuration fields into real pickers
- **Files:** `src/ui/settings.js`, `src/ui/settings.html`, `src/core/defaults.js` (cadence vocabulary), `src/agents/prompts.js` (export cadence list), `tests/settings.test.js`
- **Depends on:** 10
- **Parallelizable:** no (same builder function)
- **Expected behavior:**
  - `connectionProfileId` becomes a `<select>`: "Main connection" (`''`) + every profile from `ctx.ConnectionManagerRequestService.getSupportedProfiles()` (`id` as value, `name` as label, model appended as a hint), with a "Custom id…" option that reveals the existing text input. Missing service/extension â†’ text input + an inline hint, never an exception.
  - `model` becomes a combobox (`<input list="...">`) seeded with: the selected profile's `model`, the current `ctx.getChatCompletionModel()`, and any values already stored in other agents' presets; plus a "Fetch models" button that tries the provider-specific list and falls back to a manual value with a visible status. No hard dependency on a private endpoint.
  - `cadence` becomes a `<select>` from an exported `AGENT_CADENCES` vocabulary (`once`, `everyTurn`, `everyNTurns`, `sceneChange`, `actChange`, `afterAssistantTurn`, `afterTracker`, `onTransform`, `onRequest`, `onTravel`, `newspaper`, `onIdentityChange`), filtered to the values each agent actually honours (`DEFAULT_SETTINGS.agents[id].cadence` plus documented extras), so invalid cadences cannot be typed.
  - Numeric fields gain `min`/`step`/`title` hints from defaults; the "Connection profile ID" placeholder text is removed in favour of the picker.
- **Acceptance criteria:**
  - Markup tests: each agent row has a `select[data-neoterra-profile-select]`, a combobox for model, and a cadence `select` whose options include the agent's default; unknown profiles are preserved as a selected "Custom" option.
  - Pure-helper tests: profile list normalisation drops unsupported/disabled profiles and dedupes by id; model suggestion merging is stable and capped; an absent service yields the fallback shape.
  - Manual: the picker lists the real connection profiles; changing one saves and the next agent call routes through it; the model box accepts free text and keeps it after a repaint.
- **Risk:** medium (ST context coupling)
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(settings): pick connection profiles, models, and cadences from dropdowns`

#### 12. Add a per-agent "Test connection" action
- **Files:** `src/agents/client.js`, `src/agents/runner.js` (read-only reuse), `src/ui/settings.js`, `src/ui/settings.html`, `src/core/defaults.js` (optional `agents.*.lastTest*`), `tests/agent-runner.test.js`, `tests/settings.test.js`
- **Depends on:** 11 (pickers define the config under test)
- **Parallelizable:** no
- **Expected behavior:**
  - Export `testAgentConnection({ ctx, settings, agentId, overrides, timeoutMs = 20000, now, transport })` from the client module: resolves the same config as a real call, sends one minimal request (`"Reply with {\"ok\":true}"`, schema `{ ok: boolean }`), returns `{ ok, route, model, profileName, latencyMs, error }`. It reuses the existing route chain and abort/timeout semantics, writes nothing to `WorldState`, and logs under a `agent-test` marker so the agent log shows it.
  - Settings UI: each agent row gets a `Test` button + inline `role="status"` result ("OK · profile · model · 1.4 s" / "Failed · 401 · invalid key"); a section-level `Test all` runs them sequentially with a progress count and an overall summary. Buttons disable while running and abort when the panel closes or the chat changes.
  - The result is not persisted as configuration, only as transient UI state (optional `dead code` avoidance: no new settings key).
  - A failed test never disables the agent or changes a setting.
- **Acceptance criteria:**
  - Tests with an injected transport: success reports the route and latency; a 401 produces a readable error and `ok:false`; an abort/timeout reports `timed out`; a disabled agent still tests (testing is diagnostic, not a runtime guard); config resolution honours profile/model overrides.
  - Markup test: every agent row has `data-neoterra-test-agent="<id>"`.
  - Manual: Test on a working connection returns OK with the profile/model name; Test on a bogus profile id fails fast with a clear message; Test all reports N/N.
- **Risk:** medium (real network call from settings; abuse/billing)
- **Model / Effort:** standard implementer, medium effort
- **Commit message sketch:** `feat(settings): add a per-agent connection test`

#### 13. Document, changelog, and QA script
- **Files:** `README.md`, `CHANGELOG.md`, `docs/relationships.md` (identity/goals), `docs/map-authoring.md` (player marker, travel frames), `docs/scene-output.md` (encounter/notice/scene-description frames), `docs/cyoa.md` (routable chips), `docs/qa.md`, `docs/adding-a-season.md` (roster `formId` rule, S2 Leila example)
- **Depends on:** 1â€“12
- **Parallelizable:** no
- **Expected behavior:**
  - Document: presence is NPC-only and the player is a distinct map marker; identity changes relocate the scene and re-derive/infer goals; the player-card instruction and download; the roster `formId` is authoritative for canon forms (with the S2 Leila change cited); chip routing with the visible travel/combat/notice frames; the notice-first rule and its determinism; the travel scene-description agent and its fallback; agent presets, pickers, and the connection test.
  - Add a QA checklist block for the 7 reported symptoms, one line each, with the exact click path and expected result.
  - Changelog entry grouped by user-visible symptom; version bump to `1.3.0` in `package.json` + `manifest.json` (confirm version policy).
- **Acceptance criteria:**
  - Docs match implemented behaviour and name exact settings keys (`travel.noticeFirst`, `identity.cardInstruction`, `agents.goalInference`, `agents.sceneDescriber`, `agentPresets`).
  - `npm run check` green; no hand-edited generated artifacts.
- **Risk:** low
- **Model / Effort:** standard implementer, low effort
- **Commit message sketch:** `docs: describe player POV, routable choices, travel scenes, and agent presets`

## Verification & Testing

Run the checks for a milestone before calling it done. `npm run check` is the gate for every milestone; the per-file `node --test` lines are the fast inner loop while implementing a step.

### M1 — Player POV (steps 1â€“5)
```bash
node --test tests/world-state.test.js tests/reducer.test.js tests/map-model.test.js
node --test tests/session-home.test.js tests/exploration.test.js
node --test tests/codex.test.js tests/guest-identity.test.js
node --test tests/seasons.test.js tests/season-start.test.js
node --test tests/goals.test.js tests/goal-inference.test.js
node --test tests/player-card.test.js tests/context.test.js
npm run check
```
Manual (ST at `http://127.0.0.1:8000`, chat `Neo Terra — Director`): manual checks 1â€“5 below.

### M2 — Actor feedback (steps 6â€“9)
```bash
node --test tests/choices.test.js tests/encounter.test.js tests/travel.test.js tests/combat.test.js
node --test tests/scene-describer.test.js tests/chat-output.test.js tests/agent-wiring.test.js
npm run check
```
Manual: checks 6â€“10 below, plus re-run checks 1â€“5 to prove M1 still holds.

### M3 — Agent control (steps 10â€“13)
```bash
node --test tests/settings.test.js tests/onboarding.test.js tests/agent-runner.test.js
npm test
npm run check
```
Manual: checks 11â€“13 below, plus re-run checks 1â€“10 and the regression sweep (check 14) before the release commit.

### Full suite (before the release commit of each milestone)
```bash
npm test
npm run check
```
`npm run check` covers the generated-data/map/avatar drift checks, `node --check` on entry points, the full `tests/*.test.js` suite, and the smoke test. If a card-profile change is taken in step 4, run `npm run build:data && npm run build:data -- --check` and never hand-edit `data/characters/*.json`.

### Manual checks (SillyTavern at `http://127.0.0.1:8000`, chat `Neo Terra — Director`)
1. **Player presence:** start S2 as Leila â†’ map shows "You are here" at her location and no "Present: Leila" strip; Story tab cast list does not list her; `scene.present` inspection shows no player id; **Characters tab still lists her** and the form swap + "Re-derive from card" + "Reset goals to card" + "Import card profile" actions all still work.
2. **Play-as relocation:** mid-story, Codex â†’ Play as a character at another location â†’ scene moves, previous character reappears as an NPC where they were, map refreshes without a reload, and the Codex still shows the new player with every per-character action.
3. **Leila form:** fresh S2 â†’ Leila is seeded as Femme Feral (villain, villain portrait); Codex form swap to the fallen card and back still works.
4. **Goals:** Play as a character with a goal label â†’ goals appear in the kickoff and Codex; Play as a character with none â†’ deterministic parse or one inference call fills 3â€“5 grounded goals; disable `agents.goalInference` â†’ fallback is the agenda line, no error.
5. **Player card:** Play as Leila â†’ toast + instruction; download `Leila Renya.json`, import it in SillyTavern, select it; the narrator addresses the player by name and the player block shows the card line.
6. **Travel chip:** CYOA on â†’ click a travel chip â†’ map closes (default), `Location changed:` frame, arrival cues, chips appear; a chip for a non-connected location cannot exist (prompt only lists connections).
7. **Combat chip:** with an encounter, click an engage chip â†’ `Combat begins…` frame, tactical chips, travel blocked; no encounter â†’ notice frame, nothing starts.
8. **Notice-first:** travel into a hostile location repeatedly with the same chat/turn (reload) â†’ the same "spots you" outcome; `travel.noticeFirst:false` â†’ no notice frame.
9. **Ambush:** travel into a `hostile`/`contested` location until the deterministic roll is a strong hostile success â†’ "springs the ambush" frame, combat starts, the bar shows Surprised and only defensive/escape chips; after one round, full combat choices return. `travel.ambush:false` demotes the same roll to a plain notice.
10. **Travel description:** with `agents.sceneDescriber` on â†’ a short second frame appears within ~12 s; off â†’ only the deterministic frame; a bad model config â†’ no second frame, no error toast.
11. **Presets:** save a preset, change agents, apply â†’ all revert; export/import settings â†’ presets survive; the dropdown lists Recommended presets.
12. **Pickers:** profile dropdown lists real profiles; selecting one changes routing (verify with the agent log); cadence select only offers valid values; custom profile id path still works.
13. **Test connection:** Test on a good profile â†’ OK + latency; Test on a bad profile â†’ readable failure; Test all â†’ N/N with a summary; closing the drawer aborts the run.
14. **Regressions:** custom persona start still works; S1/S1Dark starts; travel from the map still posts exactly one frame; combat via the encounter bar still works; Codex mount, character creator, and settings export/import intact.

### Edge cases
- Custom persona (no canon id): no presence removal, no goals inference, no card instruction unless a name is set.
- Group chats / chat switch mid-Play-as, mid-goals inference, mid-travel-description: nothing lands in the wrong chat (runner affinity + `postSceneMessage` guards).
- Dead/missing/bad-ended character: Play-as stays blocked; offer Dead continuation where already allowed.
- Sandbox/guest character with no registry profile: player card built from stored fields only; goals fall back to agenda.
- Two form-group members present: exclusive cast still picks one; the player's form never duplicates an NPC.
- Old chats: presence migration is idempotent; no goals inference on a chat that already has goals; no duplicate card toast.
- `ConnectionManagerRequestService` missing or no profiles: pickers degrade to text inputs, Test reports "no route available".
- Model/endpoint errors during inference/description: non-fatal, logged at debug/warn, deterministic fallback only.
- Combat active: travel chips disabled by the engine (existing rule) and routed travel shows the existing rejection; notice detection returns null.
- Travel to the same location: `alreadyThere` posts nothing and consumes no description call.
- CYOA disabled: chips never render; routing code is inert.
- Content gate: generated goals/descriptions pass `applyContentGate` at render/post time.

### Rollback
- Every step is one commit; revert the commit to roll back.
- Kill switches: `travel.noticeFirst:false`, `travel.ambush:false`, `identity.cardInstruction:false`, `agents.goalInference.enabled:false`, `agents.sceneDescriber.enabled:false`, `cyoa.enabled:false`. Presence and the S2 roster fix are data/state semantics and need a revert.
- Posted frames are ordinary messages the user can delete; `WorldState` is unaffected by deleting them.
- Settings presets are additive; deleting them leaves the live `agents` document intact. World/presence migrations are one-way but only remove the player from presence lists (re-derivable by `syncPresence`).

## Open Questions (approval status)

- **Approved 2026-11-19:** all 11 decisions — see Â§Decisions above.
- **Confirmed 2026-11-19 (step 8 detail):** ambush uses the **restricted defensive first round** — combat starts immediately on arrival, the player is flagged Surprised, and the first chip set is limited to `defend` / `retreat` / `talk-down` / `surrender`. No hostile action is resolved automatically, so there is no NPC-turn step in `combat-state.js`.
- **Nothing is blocking.** Steps 1â€“13 are cleared to build in the milestone order defined above (M1 â†’ M2 â†’ M3; M3 may run concurrently).


