# Neo Terra Framework V1.1 — The Living City

Off-screen world tick, newspaper, pacing/scene director, relationship graph, fog of war, villain-POV sensorium.

## Meta
- **Slug:** `neoterra-living-city-v1-1`
- **Status:** complete — all 12 steps done (V1.1 shipped)
- **Date:** 2026-11-18
- **Base:** `plans/neoterra-framework-v1.md` (V1 complete, Steps 1–20)
- **Target:** SillyTavern third-party extension, plain ESM, no bundler, no runtime deps
- **Repo:** `C:\Users\locua\OneDrive\Escritorio\KI\extensions\NeoTerra-Framework`
- **Live instance:** SillyTavern at `http://127.0.0.1:8000/`, started by
  `C:\Users\locua\OneDrive\Escritorio\KI\ST\SillyTavern\Start.bat`
- **Proposed version:** `1.1.0` (minor; all features opt-in or non-destructive)
- **Source request:** “Off-screen world tick, Newspaper generator, Pacing/Scene
  Director, Relationship graph UI, Fog of war on the map, Villain-POV sensorium”
  (the six remaining items in `plans/neoterra-framework-v1.md` §Proposed Additions)

## Summary

- **Goal:** make the world keep moving when the player is not looking, give the
  world a readable public surface (news + director), and make the map and cast
  relationships legible from the player's point of view — including the villain's.
- **Core bet:** all six features are **adapters over the existing `WorldState`**.
  No new authoritative document, no second source of truth. New per-chat data
  lives under `WorldState.flags.*` (the established pattern: `flags.map`,
  `flags.travel`, `flags.postVictory`), so old chats keep validating and every
  feature exports/imports with the existing world bundle for free.
- **Deterministic first, prose second.** Off-screen deltas, fog visibility, graph
  layout and the readability of the newspaper are pure functions with unit
  tests. Only the newspaper's *prose* uses an LLM, with a deterministic edition
  builder as the always-available fallback.
- **Time has a brake.** Normal play and travel flow at one day per five turns.
  Major scenes, beats, combat and intimate scenes **freeze fiction time**: no
  date/slot advance, no off-screen tick, no newspaper edition, and no
  turn-based deadline escalation until time is explicitly released. Combat
  auto-freezes; every other major scene freezes with one click.
- **Agency guard.** Nothing silently teleports the player. Scene cuts advance
  time and change framing/cast; moving the player stays an explicit action.
- **Cost guard.** Defaults: clock + tick on, pacing nudge on, fog off,
  newspaper off, relationship graph available, sensorium automatic for
  seasons that declare a villain domain. The only routine new LLM agent is the
  newspaper, and only when the feature is enabled.

## Current State (verified)

### Turn pipeline and time
- The only SillyTavern events subscribed are `MESSAGE_RECEIVED` and
  `CHAT_CHANGED` (`src/ui/shell.js:1257`, `:1677`). `manifest.json` wires the
  generate interceptor and four lifecycle hooks; there is no `MESSAGE_SENT`,
  `MESSAGE_SWIPED` or `GENERATE_AFTER_DATA` subscription.
- One assistant message runs `runTurnPipeline` exactly once, behind
  `createTurnGate`/`messageTurnIdentity` (`src/agents/state-tracker.js:709-875`):
  1. `TICK_TIME {turns:1}`, 2. player state tracker, 3. `initiative.afterTurn`,
  4. `scene.refreshCast({runDirector:false})`.
- **`TICK_TIME` never advances the in-game date or time of day.** It increments
  `meta.turn`; `meta.inGameDate` and `meta.timeOfDay` change only when the event
  carries explicit values (`src/state/reducer.js:265-283`). The seed sets
  `inGameDate = season.anchorDate` and `timeOfDay = 'evening'`
  (`src/state/world-state.js:427-431`), so today a 90-turn season still reads
  the anchor date at ‘evening’.
- Beat and season deadlines *do* compare dates, **lexicographically**
  (`src/data/beats.js:524-548`). Date deadlines are currently dead code.
- `meta.turn` is the only clock the ledger understands: beat `deadlineTurns`,
  `conditions.turnRange` and `finalDeadline.turns` all compare against it
  (`src/data/beats.js:156-200, 518-548`). There is no notion of “fiction time
  paused”, so a long scene counts exactly like a fast one.
- Travel dispatches `TICK_TIME {turns: plan.turns}` with no date
  (`src/flows/travel.js:277-301`).
- Cadence lives in `src/flows/initiative.js:37-100`; only the storyline cadence
  is actually enforced. Agents apply events atomically through
  `applyEventBatch` (`:106-140`).

### Authors’ world data
- `data/seasons/*.json`: each season has `factions[]` (`id, influence, status,
  goals?`), `threats[]` (`id, name, rank, sourceFactionId, agenda, stages[],
  progress, locationId`), `canonBeats[]` with `deadlineTurns`/`deadlineDate` and
  `deadlineConsequence`, `finalDeadline`, `failureState`. **No agenda schedule,
  no per-day rate, no world-tick fields exist.**
- `data/factions.json` has 8 factions with `side` (`hero|villain|neutral`) and
  goals. `data/districts.json` has 10 districts, no ownership/status fields.
  `data/locations.json` has 18 named locations with `districtId`, `regionId`,
  `connections`, `travel`, `virtual`; `WorldState.locations` keeps live
  `factionId`, `status`, `present`, `visited`.
- `s1dark` is the villain-POV season: `playerRole:'villain'`,
  `defaultPlayerCharacterId:'s1dark.carol.bleeding-heart'`, clarity at
  influence 85 / `dominant`, and the resistance/heroes modelled as threats.
- S1Dark cards carry the identical “Wonderland” lorebook entry (5 of 10 cards).
  Knights are machine-identifiable today: registry `formKind:'knighted'` and
  `data/form-rules.json` `trigger:'knighted'` rules produce **Heart Attack**,
  **Bittersweet** and **White Rabbit**; Carol's variants are
  `cleansed|infected|poisoned`. There is **no** `domain` block in any season.
- Season schema (`data/schemas/season.schema.json`) uses
  `additionalProperties:false`, but runtime validation is plain JS and ignores
  unknown keys (`src/data/seasons.js`). New optional authored keys need to be
  added to the schema doc anyway to avoid silent drift.
- `WorldState` validation is additive (`additionalProperties:true`; unknown
  keys tolerated) and `flags` is an arbitrary object
  (`src/state/world-state.js:919-1167`). `locations[].visited` is set only by
  `SET_LOCATION` (`src/state/reducer.js:172-182`); `MOVE_CHARACTER` does not.

### Map, overlay, UI
- Leaflet layer groups are `{districts, bridges, keyLocations, namedLocations,
  labels, fog}` (`src/ui/leaflet-adapter.js:196-203`). **The `fog` group is
  created empty and never populated**; the toggle is a no-op.
  `DEFAULT_LAYER_VISIBILITY.fog = false` (`src/ui/map.js:136`). The layer name
  list is hard-coded again at `leaflet-adapter.js:301` and in
  `MAP_LAYER_ORDER` (`src/ui/map.js:120-127`).
- `settings.map.showFogOfWar` already exists and defaults `false`
  (`src/core/defaults.js:221`), but is **not exposed** in `settings.html`.
- Per-chat map overrides live in `flags.map`, read/written by
  `getChatMapOverrides`/`withChatMap` (`src/data/map.js:1524-1558`); unknown
  keys in `flags.map` survive those writers.
- `buildMapViewModel` merges generated geometry + overrides + live state and
  emits `name`, `description`, `factionId`, `visited` per feature
  (`src/data/map.js:1136-1330`). The submenu is built from it. This is the one
  place fog must act so hidden data cannot leak.
- Travel plans against a freshly built graph (`src/flows/travel.js:242-275`,
  `src/data/map.js:2214+`). `createTravelFlow` already accepts `getSettings`,
  but `buildMapRuntime` does not pass it (`src/ui/shell.js:492-502`).
- `overlay.js` already renders factions, threats, beats/rumors, divergence and
  **headlines** (`:165`; model `buildWorldOverlay` in `src/data/map.js:1889-2015`).
  Step 15’s “newspaper-style headlines” is a one-line fallback to
  `event.headline ?? event.summary` — there is no edition, archive or prose.
- Shell tabs are `season, map, characters, player, settings`
  (`src/core/constants.js:55-61`). `LIVE_PANELS` excludes `player`; the Player
  tab is a placeholder. `setActiveTab` lazily mounts only map/characters
  (`src/ui/shell.js:1345-1375`). Panels refresh via the 5-event bus
  (`MAP_UPDATED`, `TAB_CHANGED`, …), not a store subscription.
- Codex shows relationships only as a per-character list
  (`src/ui/codex.js:210-229, 1257-1265`); it repaints the whole tab on every
  keystroke. No graph/canvas/SVG helper exists in `src/`.
- `selectRelationships` filters by character/present/type/minAffinity and
  returns `{a,b,type,affinity,tension,notes,sinceTurn}` clones
  (`src/state/selectors.js:117-163`). `PLAYER_RELATIONSHIP_DELTA` mirrors
  player relationships into both the player and the canon character
  (`src/state/reducer.js:956-996`).

### Settings and agent-registration landmines
- `normalizeSettings` only normalizes known groups; unknown groups survive but
  are not clamped (`src/core/migrations.js:198-246`). `mergeSettings` fills new
  defaults, so adding groups needs a normalizer, not necessarily a version bump.
- `normalizeAgents` does `defaults[id]` for every `AGENT_IDS` entry with no
  guard (`src/core/migrations.js:167-173`). **Adding an id to `AGENT_IDS`
  before adding `DEFAULT_SETTINGS.agents[id]` throws inside `getSettings`
  everywhere.** New agent work must land defaults + prompt + id together.
- `settings.html` is declarative (`data-neoterra-path="…"`), so new toggles are
  cheap; `settings.js` owns validation/writes.
- `DEFAULT_TOKEN_BUDGET` exists twice: `src/context/budget.js:33-43` and
  `DEFAULT_SETTINGS.tokenBudget` (`src/core/defaults.js`). New blocks need both.
- **Unwired but implemented agents:** architect, cast director, lore, auditor,
  bad end, and the cast director is never given to the scene flow
  (`shell.js:404-437`, `:900-986`).  This plan must not depend on them, and it
  must not accidentally make their absence visible.

## Recommended Design

### 1. World clock, fiction time and the time brake (`src/core/world-clock.js`)

A pure module used by the turn pipeline, travel, the reducer and the UI.

**Normal flow.** Fixed day slots: `dawn → morning → afternoon → evening →
night → dawn`. One slot per assistant turn (and one per travel turn), so a day
passes every five turns. The date advances by one calendar day when the cycle
wraps from `night` back to `dawn`. Dates are ISO `YYYY-MM-DD`; arithmetic uses a
real UTC date helper, never string concatenation, so month/year/leap-day
boundaries are correct. Sandbox (`anchorDate:null`) keeps `date:null` and still
cycles `timeOfDay`.

**The time brake.** A scene can be *held*. While held:
- `meta.timeOfDay` and `meta.inGameDate` do not advance automatically;
- `meta.storyTurn` does not advance (see below);
- the off-screen tick does not run, so factions, threats and NPCs stay put;
- the cadence-driven storyline pass is skipped (a location/beat/manual pass can
  still run because it is caused by the scene, not by time);
- the newspaper does not publish;
- deadline escalation and the final-deadline check are suspended inside
  `planBeatLifecycleEvents` (the world cannot punish the player during a frozen
  scene);
- explicit time still passes: the pacing cut, travel, a `/neoterra time` style
  command, or any `TICK_TIME {turns>0}` advances the clock and releases nothing
  by itself.

**Two turn counters.** This is the faithful way to make “frozen” mean
something for the beat ledger:
- `meta.turn` remains the mechanical counter: pipeline cadence, agent
  statistics, event timestamps, UI “turn N”. It always increments.
- `meta.storyTurn` is in-game elapsed turns: it increments only when the clock
  flows. Beat `conditions.turnRange`, `deadlineTurns`, `finalDeadline.turns`
  compare against `storyTurn`; `meta.turn` stays for cadence and logs.
  Existing worlds migrate `storyTurn = meta.turn` so nothing changes until a
  hold is used.

**Hold state and triggers.**
`flags.clock = { hold: { active, reason, sinceTurn, sinceDate }, autoHold,
lastEvaluatedTurn }`.

- `SET_CLOCK_HOLD { active, reason }` is the reducer event; it is idempotent and
  records `sinceTurn`/`sinceDate` on entry.
- **Combat auto-holds**: `COMBAT_START` sets the hold, `COMBAT_END` clears it
  (unless a manual hold was set for another reason).
- **Encounter auto-holds** are opt-in (`clock.autoHold.combat:true`,
  `clock.autoHold.encounter:false`, `clock.autoHold.beat:false`). “Encounter”
  means `scene.encounter` is present; it defaults off because a hostile in the
  room is not necessarily a held scene. A canon beat is *not* auto-held by
  default because beats stay open for whole acts.
- **Major / intimate scenes** are held explicitly. The reliable mechanism is a
  one-click **time chip** in the top bar (date/time badge; click to freeze,
  click to release) plus `scene.hold` for any flow that opens a held scene. We
  deliberately do not try to detect intimacy from prose — it is unreliable and
  content-sensitive — but the chip is always one click away, and future flows
  (encounter bar, CYOA “lewd/romantic” choice handling) can set the same flag.
- **Travel releases the hold** because it leaves the scene: the travel batch
  includes `SET_CLOCK_HOLD {active:false, reason:'travel'}` before its
  `TICK_TIME`.
- The pacing director never cuts a held scene; it offers **Release time**
  instead.

**Settings:** `clock: { enabled:true, slotsPerDay:5, timeOfDayStart:'evening',
autoHold:{combat:true, encounter:false, beat:false}, maxHoldTurns:20 }`.
`maxHoldTurns` only drives the one-shot “still frozen” reminder; it never
force-releases time. `slotsPerDay` is fixed to the slot table length for V1.1;
it exists so a future calendar can change it without a migration.

`TICK_TIME` gains an optional `storyTurns` field (defaults to `turns`) so the
reducer can advance `meta.storyTurn` independently of `meta.turn`. Explicit
ticks always pass `storyTurns: turns`; a held automatic turn passes `0`.

Pseudocode for the only genuinely tricky parts:

```
advance(date, timeOfDay, turns):
  idx = indexOfSlot(timeOfDay ?? 'evening')
  days = 0
  repeat turns:
    idx += 1
    if idx == slots.length: idx = 0; days += 1
  return { date: date ? addDays(date, days) : null, timeOfDay: slots[idx], days }

pipelineStep():
  held = flags.clock.hold.active
  if held:
    TICK_TIME { turns: 1, storyTurns: 0 }        // mechanical turn only
  else:
    clock = advance(meta.inGameDate, meta.timeOfDay, 1)
    TICK_TIME { turns: 1, storyTurns: 1, date: clock.date, timeOfDay: clock.timeOfDay }
```

**Behavioral change to call out:** every existing chat starts advancing dates
after this step. Date-based beat and season deadlines become live, and the brake
means a 30-turn intimate scene consumes zero in-game days and zero story turns.
This is desired, but it is the single riskiest change in the plan: it can fire a
soft deadline earlier than before (or, with holds, later than a turn counter
would suggest). Mitigation: `clock.enabled:false` restores V1 exactly; tests
cover a 200-turn dry run, a 10-turn hold, and migration of an old world.

### 2. Off-screen world tick (`src/flows/world-tick.js` + `data/agendas.json`)

A deterministic planner, not an agent. It runs as a new pipeline stage after the
clock and before the player tracker.

- **Elapsed time:** `flags.worldTick = { lastDate, lastTurn, lastStoryTurn,
  totalDays, pendingRumorIds, suppressedDays }`. Elapsed days come from the
  clock’s date diff, or from `storyTurn` deltas when the date is null. No
  elapsed day → no-op. A held scene has no elapsed days by construction, so the
  tick is a no-op until time is released; the explicit hold check is still
  asserted so a malformed clock cannot move the world mid-scene.
- **Authored pacing:** `data/agendas.json`, keyed by season and faction/threat,
  with a global fallback so Sandbox and future seasons never crash:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "factionInfluencePerDay": 0.5,
    "mainThreatProgressPerDay": 1.0,
    "secondaryThreatProgressPerDay": 0.5,
    "maxFactionDeltaPerTick": 5,
    "maxNpcMovesPerTick": 2,
    "maxDaysPerTick": 14,
    "rumorsPerTick": 2
  },
  "seasons": {
    "s1dark": {
      "factionAgendas": {
        "clarity": { "influencePerDay": 1.0, "rumorTags": ["patrol", "conversion"] },
        "petrabyte": { "influencePerDay": -0.4, "rumorTags": ["resistance"] }
      },
      "threatPace": {
        "s1dark.threat.resistance": { "progressPerDay": 1.5 }
      }
    }
  }
}
```

- **What advances:**
  - Faction influence: absolute value, clamped 0–100, cap
    `maxFactionDeltaPerTick` per tick. Disbanded factions do not move.
  - Active threats: `progress` advances at the authored rate, clamped 0–100.
    The reducer derives `stage`, so beat `threatStage` conditions start to
    unlock naturally. Defeated/contained threats do not move.
  - Off-screen NPC movement: at most `maxNpcMovesPerTick` per tick. Only
    `controlledBy:'npc'`, alive, non-terminal characters who are not in
    `scene.present` and not manually pinned. Destination chosen deterministically
    from the current location’s authored `connections` (hash of
    `charId + dayIndex`), never the player and never a character in combat.
  - Rumor events: up to `rumorsPerTick` `ADD_EVENT`s, tagged
    `['offscreen','tick','tick:<n>', …]`, with a `headline` field and no
    protagonist involvement. Text comes from authored templates in
    `data/agendas.json` (`{faction}`, `{location}`, `{threat}` placeholders),
    selected deterministically. The newspaper and overlay consume these.
- **Guards:** skip when `worldTick.enabled:false`, `season.sandbox`, ending
  `epilogue|ended`, or the current chat changed. Combat still advances
  factions/threats but suppresses NPC movement (configurable
  `allowNpcMovesDuringCombat`). A long absence clamps to `maxDaysPerTick` and
  records `suppressedDays`; it never applies a 100-day delta in one pass.
- **Idempotency:** `lastDate`/`lastTurn` are written in the same atomic
  `applyEventBatch` as the events. Re-running a tick with no elapsed day is a
  no-op. A failed pass leaves state byte-identical.
- **No new agent.** The tick is free and testable; the newspaper agent is the
  prose layer. This is a deliberate scope decision (see Decisions).

### 3. Pacing / Scene Director (`src/flows/pacing.js`)

Two halves: a deterministic **analyzer** that runs every turn, and an explicit
**cut** action the player can trigger.

- **Signals** (pure, from state only):
  - turns since the last non-pacing `recentEvents` entry;
  - turns since the last location change (`flags.travel.lastAt`);
  - turns since the scene started (`flags.castDirector.turn`);
  - turns since the last beat action (`flags.storyline.lastRunTurn`);
  - active combat, ending screen, snooze, **time hold**.
- **Levels:** `ok | nudge | cut | stalled`. Example weighting:
  `stallTurns=3`, `sceneMaxTurns=12`, `threatNudgeTurns=10`; `cut` at score ≥ 4,
  `nudge` at ≥ 2. All thresholds are settings. When `flags.clock.hold.active`
  the analyzer downgrades to `nudge` at most and changes its suggestion to
  **release time**, because a held scene is intentionally not cut.
- **Analyzer output** is stored in `flags.pacing = { level, reasons,
  lastAnalyzedTurn, lastCutTurn, snoozedUntilTurn, suggestedSlots,
  held }`. It never mutates story state.
- **Cut action** (`cutScene`), always explicit:
  1. refuse during combat, on the ending screen, or while time is held (offer
     **Release time** instead);
  2. release the hold, then `TICK_TIME` with the clock for `cutSlots`
     (default 2 slots) and `storyTurns: cutSlots`;
  3. `SET_SCENE_FRAMING` with the director’s cut framing;
  4. `ADD_EVENT` tagged `pacing` with a short “meanwhile” summary;
  5. `scene.refreshCast({runDirector:false})` at the **same** location;
  6. optionally force a storyline pass with `trigger:'beat'` (a threat beat),
     still inside the same chat-affinity guard.
  It does **not** move the player, does **not** change location, and does
  **not** auto-post prose. `src/ui/chat-output.js` gains a `CUT` frame kind and
  a pure `buildCutFrameText` if the caller wants a visible frame.
- **Narration nudge:** when level ≥ `nudge`, a `[NEOTERRA_PACING]` block tells
  the narrator to cut forward, raise a threat development, or break a stalled
  back-and-forth on the next reply. It is a directive, not state. It is
  generated from `flags.pacing` and is content-gated like every other block.
- **Snooze:** “Not now” writes `snoozedUntilTurn = turn + snoozeTurns`.
- **Time chip:** the always-visible top-bar chip (Step 1) is also the manual
  brake for major/intimate scenes; the Director card mirrors its state and
  offers the same toggle.
- No new LLM agent in the core step; the optional prose pass is listed in
  Decisions as a future extension.

### 4. Newspaper (`src/flows/newsroom.js` + `src/agents/newspaper.js`)

**State:** `flags.newsroom = { lastEditionDate, lastEditionTurn, editions: [] }`,
at most 20 editions, at most 6 headlines each. Editions survive export/import.

```json
{
  "id": "edition:s1dark:2037-03-06:12",
  "date": "2037-03-06",
  "turn": 12,
  "masthead": "THE WONDERLAND GAZETTE",
  "dateline": "NEO TERRA — EVENING EDITION",
  "style": "tabloid",
  "source": "agent",
  "headlines": [
    { "title": "…", "lede": "…", "section": "crime", "tone": "alarmist",
      "eventTurn": 11, "actors": [], "locationId": "old-subway" }
  ]
}
```

- **Cadence:** publish when `elapsedDays >= newspaper.everyDays` (default 3) or
  when `newEvents >= newspaper.minEvents` (default 6). At most one edition per
  in-game date. Re-running after reload is idempotent by `date`. A held scene
  produces no elapsed day, so no edition is published mid-scene even if the
  event threshold is met; the publisher also checks the hold explicitly.
- **Deterministic fallback** (`src/data/newsroom.js`, pure): rank the events
  since the last edition (headline first, then event importance tags, then
  recency), group into sections by tags (`crime`, `faction`, `hero`,
  `business`, `society`, `offscreen`), and synthesize
  `title = headline ?? firstSentence(summary, 90)`,
  `lede = summary`. This means the feature is fully functional with no LLM and
  is the test surface.
- **Agent** (`newspaper`, added to `AGENT_IDS` + `DEFAULT_SETTINGS.agents` +
  `DEFAULT_AGENT_PROMPTS` in one commit): input is the last 20 events since the
  last edition, the current factions/threats/act, season tone and style. Output
  is `{ masthead, dateline, headlines[] }` with strict caps (title ≤ 90, lede ≤
  220, 1–6 headlines) and one repair retry. On failure it logs and the
  deterministic edition is published instead.
- **Reducer:** new `PUBLISH_EDITION { edition }` handler. Validates shape,
  dedupes by `edition.date` (idempotent no-op), caps the archive, and pushes
  nothing else. Agents never patch state directly.
- **Wiring:** the publisher runs **detached** after the turn pipeline (not
  inside the queue), re-checks the chat id before writing, and is silent on
  failure. This keeps a 10-second newspaper call from delaying CYOA.
- **UI:** an overlay “Neo Terra Tribune” button opens a reader modal with the
  latest edition and an archive list; the overlay also shows the latest 1–2
  headlines when `map.showHeadlines` is on. Pure view model
  `buildNewspaperView(state, settings)` for tests.
- **Context:** `[NEOTERRA_NEWS]` block (date + 2 headlines) with its own
  toggle and 350-token budget; priority 4.5 (above continuity, below world).
  Default **on when the feature is on**; feature default **off**.
- **Style:** `auto` derives `tabloid` for villain POV, `broadsheet` for hero
  seasons, `underground` for a post-victory resistance arc.

### 5. Fog of war

Fog is a **per-chat exploration state** plus a **view-model transform** plus a
**render mode**. It is not authored map data and not a new SVG layer.

- **State:** `flags.map.exploration = { regions: { [regionId]: {state, turn,
  source} }, keyLocations: { … }, updatedAt }`. Named locations reuse the
  existing `locations[].visited`; bridges are derived from their endpoints.
  Storing it inside `flags.map` means `withChatMap` preserves it (it spreads
  the group) and the world bundle exports it.
- **Reducer:** `DISCOVER_MAP_FEATURE { kind:'region'|'keyLocation', id, source }`
  and `REVEAL_REGION { regionId, source }` (idempotent; `source` is
  `start|travel|storyline|editor`).
- **Rules (pure, `src/state/exploration.js`):**
  - Seed: the start location’s region is `discovered`; its bridge-adjacent
    regions are `rumored` in `rumors` mode.
  - `discovered` region → its key locations are visible; its named locations are
    visible if `visited`.
  - `rumored` region → name only (if `showRumoredLabels`), no description, no
    faction control, no present cast, no travel details.
  - `unknown` region → no name, no description, no markers, no travel.
  - Bridge visible when either endpoint is discovered; status shown only then.
  - Virtual locations (`old-subway`, `bcp-facility`, bunkers) are reachable
    through their authored `connections` if the origin is discovered; their
    names stay hidden until visited. They have no polygon, so they cannot be
    fog-masked.
- **View transform:** `applyMapFog(viewModel, exploration, options)` returns a
  new view model with `visibility` per feature and **blanked** `name`,
  `description`, `factionName`, `present`, `travelBlocked` for hidden features.
  It is applied before both the renderer and the submenu, so a hidden name
  cannot leak through the detail panel. Tests assert the absence of the string.
- **Travel:** `planTravel` rejects a destination whose region is `unknown` when
  `map.fog.gateTravel` (default true while fog is on); `rumored` is allowed but
  described as a blind trip. A successful trip discovers every region on the
  path (origin, destination, and both ends of each bridge used). Discovery is
  dispatched in the same validated batch as `SET_LOCATION`.
- **Render:** fog is a style mode in `refreshMapLayers`:
  unknown → near-opaque dark fill, no label; rumored → dim outline, name only;
  discovered → normal. The existing `fog` layer toggle becomes the on/off
  switch and keeps persisting in `localStorage['neoterra:map:layers']`; no new
  Leaflet layer is needed. The map editor gains “Reveal region” and “Reset fog”.
- **Settings:** `map.showFogOfWar` (exists, currently hidden), and
  `map.fog: { mode:'rumors'|'hard', revealOnTravel:true,
  showRumoredLabels:true, gateTravel:true, revealNeighbors:true }`.
  Default `showFogOfWar:false` for compatibility; choosing it turns fog on.

### 6. Relationship graph UI

- **Pure model** (`src/ui/relationship-graph.js`):
  `buildRelationshipGraph({ state, registry, settings, filters })` returns
  `{ nodes, edges, bounds, legend }`.
  - Nodes: every character referenced by a relationship, plus the player
    (custom persona or canon) and present cast. Fields: `id, name, side,
    status, formKind, isPlayer, isPresent, corruptionStage, badEnd, x, y, r`.
  - Edges: `state.relationships` plus the player mirror, deduped by unordered
    pair; `owner/servant` is directed, everything else symmetric. Fields:
    `a, b, type, affinity, tension, directed, label, color, width, dashed`.
  - Layout is deterministic and dependency-free: player at centre, present
    nodes on an inner ring, remaining nodes on an outer ring, sorted by
    `side` then display name; radius scales with node count and the declared
    canvas. No force simulation, so snapshots are stable and tests can assert
    coordinates. The whole graph is SVG.
- **UI:** a new live tab **Relations** (`relations`) between Characters and
  Player. It mounts `src/ui/relationships.js` (DOM + SVG), has filters
  (present only, side, relationship type, minimum affinity), a legend
  (`ally`, `rival`, `lover`, `family`, `owner/servant`, `neutral`), hover
  highlighting, click-to-select with a side detail list, bad-end/form badges,
  and an empty state. Keyboard: nodes are focusable `<g role="button">`.
- **Freshness:** the tab repaints from state on `MAP_UPDATED` and
  `TAB_CHANGED`, like the map. It is deliberately **not** inside the codex,
  whose full-tab repaint on every keystroke would destroy and recreate the SVG.

### 7. Villain-POV sensorium

A **generic domain dashboard** for any villain-POV season, plus a narration
block. S1Dark is the first consumer; future villain seasons use the same block
without code changes.

- **Authored data:** optional `domain` block in a season JSON. S1Dark authors
  `{ name:"Wonderland", factionId:"clarity", description, loreText,
  knightFormKind:"knighted", watchDistricts:[…], resistanceFactionIds:[…] }`.
  Add it to `season.schema.json` and to the season validator as an optional
  object, and document it in `docs/adding-a-season.md` so a future villain
  season only needs data. Hero seasons and Sandbox omit it; no duplication
  across all five files.
- **Pure view model** (`src/data/domain.js`):
  `buildDomainView({ state, season, registry, locations, districts, settings })`
  returns:
  - `active` and `reason` (villain role + domain present). The domain follows
    the **season**, not the played identity: switching to a hero identity in
    S1Dark keeps the tab and the block, because the world is still Wonderland;
  - `wonderland`: name, description, flavor text;
  - `knights`: roster entries with `formKind:'knighted'` (from the chat
    registry slice or the full registry), each with status, location,
    corruption, form, and affinity to the player;
  - `court`: other characters with a non-zero corruption stage, `allegiance`
    to the domain faction, or an `owner/servant` relationship to the player;
  - `corruptionSpread`: counts by stage and the top 5 progress values;
  - `territory`: per-district control aggregated from `locations[].factionId`
    via `locations.json` `districtId`; controlled/contested/hostile counts and
    the faction HQ;
  - `resistance`: threats whose `sourceFactionId` is a hero/neutral faction,
    with stage label and progress, relabelled as danger to the domain;
  - `feed`: recent `offscreen`, `knight`, `corruption` and `beat` events.
- **UI:** a new tab **Domain** (`domain`). It is added to `SHELL_TABS` but its
  nav button and panel are hidden unless `buildDomainView(...).active`. If the
  active tab becomes hidden (identity/season change), `setActiveTab` falls back
  to `characters`. A pure `resolveVisibleTabs(state, season)` helper keeps this
  testable. Sections: Wonderland, Knights, Court/corruption, Territory,
  Resistance, Feed.
- **Context:** `[NEOTERRA_DOMAIN]` block (villain POV only, toggle on by
  default, 350 tokens, priority 3.5): “You rule Wonderland. Knights: … .
  Corruption: … . Territory: … . The resistance is at …”. This is what makes
  the narrator consistently treat the player as the antagonist instead of a
  hero standing in the room.

## Steps

> **Conventions:** every step is one reviewable PR. Routing names the
> implementer tier and effort. `Depends on` lists step numbers.
> `Parallelizable` means it can run concurrently once dependencies are met.
> All paths are relative to the repo root.

### Progress
- [x] Step 1 — World clock, fiction time, and the time brake
- [x] Step 2 — Off-screen world tick engine and agenda data (05b2313)
- [x] Step 3 — Off-screen activity feed in the world overlay (6996e87)
- [x] Step 4 — Pacing analyzer and explicit scene cut (e4c461a)
- [x] Step 5 — Pacing surface: director card and `[NEOTERRA_PACING]` (a3a0ee3)
- [x] Step 6 — Newsroom state, reducer event, deterministic publisher (6ab778a)
- [x] Step 7 — Newspaper agent, reader UI, and `[NEOTERRA_NEWS]` (92f0e39)
- [x] Step 8 — Exploration state, fog rules, travel discovery and gating (f7be1fb)
- [x] Step 9 — Fog rendering, submenu gating, and editor reveal (667f127)
- [x] Step 10 — Relationship graph model and Relations tab (b3261b4)
- [x] Step 11 — Domain sensorium (generic): data, tab, and `[NEOTERRA_DOMAIN]` (b2379d5)
- [x] Step 12 — Docs, settings surface completion, changelog, and smoke QA (b0c720b)

---

### Step 1 — World clock, fiction time, and the time brake
- **Files:** `src/core/world-clock.js` (new), `src/core/constants.js` (slot table), `src/core/defaults.js` (`clock` group), `src/core/migrations.js` (clock normalizer), `src/state/world-state.js` (seed `meta.storyTurn` + `flags.clock`, validation, migration v1→v2), `src/state/migrations.js` (migrate `storyTurn`/hold), `data/schemas/world-state.schema.json` (document `meta.storyTurn` and `flags.clock`), `src/state/reducer.js` (`TICK_TIME.storyTurns`, `SET_CLOCK_HOLD`, combat auto-hold), `src/data/beats.js` (deadlines use `storyTurn`; lifecycle takes `held`), `src/flows/initiative.js` (cadence skipped while held), `src/agents/state-tracker.js` (compute clock/hold before stage 1), `src/flows/travel.js` (release hold + dated tick), `src/context/renderer.js` (show `(time frozen)`), `src/ui/clock-chip.js` (new top-bar chip), `src/ui/shell.js` (mount chip), `style.css`, `src/ui/settings.html`, `tests/world-clock.test.js` (new), `tests/reducer.test.js`, `tests/beats.test.js`, `tests/world-state.test.js`, `tests/state-tracker.test.js`, `tests/travel.test.js`, `tests/ui-css.test.js`
- **Depends on:** none
- **Parallelizable:** with Steps 8, 10
- **Expected behavior:** A pure `advanceClock` advances `meta.timeOfDay` through `dawn|morning|afternoon|evening|night` and increments `meta.inGameDate` on wrap, using real UTC date arithmetic. Normal play and travel advance one slot per turn, so a day passes every five turns. `meta.storyTurn` tracks in-game turns and advances only when the clock flows; beat `turnRange`/`deadlineTurns`/`finalDeadline.turns` compare against it. `flags.clock.hold` freezes automatic date/slot/story-turn advance, the off-screen tick, newspaper cadence, and deadline escalation; explicit `TICK_TIME {turns>0}` still passes time and always sets `storyTurns: turns`. Combat auto-holds and clears on end; encounters auto-hold per setting; travel releases the hold. A one-click top-bar time chip shows the current date/time and toggles the brake; `SET_CLOCK_HOLD` is idempotent and records `sinceTurn`/`sinceDate`. `clock.enabled:false` produces V1 behavior exactly (turn count only). Null anchor dates stay null but still cycle the slot.
- **Acceptance criteria:** 5 ticks from `evening` reach `evening` on the next day; 1/30/31/leap-day boundaries are correct; `date:null` never throws and never invents a date; travel releases the hold and advances one slot per path turn; a 10-turn hold advances `meta.turn` by 10 but `storyTurn` by 0, leaves date/time frozen, and fires no deadline escalation, no final deadline, and no cadence-driven storyline pass; an explicit `TICK_TIME` during a hold advances both counters and the date; combat start/end toggles the hold and a manual hold survives combat end; the time chip reflects state and toggles without a reload; a migrated V1 world sets `storyTurn = turn` and behaves identically until a hold; disabled mode leaves `meta.inGameDate`/`meta.timeOfDay` byte-identical; `npm run check` passes; a fixture with date deadlines confirms `isBeatOverdue` becomes reachable.
- **Risk:** high (adds a second time counter, changes beat deadline semantics, and introduces a brake that can hide escalation)
- **Model/Effort routing:** implement-hard, high effort
- **Commit message sketch:** `feat(time): add fiction clock, story turns, and the time brake`
- **Commit:** `319e3fb`

---

### Step 2 — Off-screen world tick engine and agenda data
- **Files:** `data/agendas.json` (new), `src/data/agendas.js` (load + validate, new), `src/flows/world-tick.js` (new), `src/agents/state-tracker.js` (new pipeline stage), `src/core/defaults.js` (`worldTick` group), `src/core/migrations.js` (normalizer), `src/ui/settings.html`, `tests/world-tick.test.js` (new), `tests/agendas.test.js` (new), `tests/state-tracker.test.js`
- **Depends on:** Step 1
- **Parallelizable:** with Steps 4, 8, 10
- **Expected behavior:** After the clock, `runTurnPipeline` runs a deterministic tick when at least one in-game day has elapsed since `flags.worldTick.lastDate`/`lastStoryTurn`. Faction influence and threat progress advance at authored per-day rates, clamped and capped; up to `maxNpcMovesPerTick` off-scene NPCs move along authored connections; up to `rumorsPerTick` tagged `ADD_EVENT`s with `headline` are emitted from authored templates. The tick writes `flags.worldTick` in the same atomic batch. Disabled, Sandbox, ending, **time held**, and no-day-elapsed are no-ops. Missing season data falls back to `data/agendas.json` defaults; a malformed document is rejected at load with a clear error and the tick degrades to defaults.
- **Acceptance criteria:** two ticks over the same state are byte-identical; no tick without an elapsed day; a 10-turn time hold produces zero tick events and zero deltas; releasing the hold and advancing one day produces exactly one tick; a 60-day gap clamps to `maxDaysPerTick` and records `suppressedDays`; influence and progress never leave 0–100 and never exceed the per-tick cap; player-controlled characters, dead/captured characters, present cast and manual pins never move; offscreen moves land on a location that is connected to their origin; rumor count respects the cap and every rumor is tagged `offscreen`; Sandbox and ending states produce zero events; a failed/aborted tick leaves state unchanged; rate math and template choice are deterministic; `data/agendas.json` validates for all playable seasons.
- **Risk:** high (silently rebalances every timeline; a wrong rate makes threats win too fast or makes the city feel static)
- **Model/Effort routing:** implement-hard, high effort
- **Commit message sketch:** `feat(world): advance faction and threat agendas off-screen`
- **Commit:** `05b2313`

---

### Step 3 — Off-screen activity feed in the world overlay
- **Files:** `src/data/map.js` (`buildOffscreenFeed`, extend `buildWorldOverlay`), `src/ui/overlay.js`, `src/core/defaults.js` (`map.showOffscreen`), `src/core/migrations.js`, `src/ui/settings.html`, `tests/overlay.test.js`, `tests/map-model.test.js`
- **Depends on:** Step 2
- **Parallelizable:** with Steps 4, 8, 10
- **Expected behavior:** The world overlay gains a “City Desk / Off-screen” section showing the last 2–4 `offscreen` events with faction and location names, sorted newest first, and an empty state when the feature is off or nothing happened. It is independent of the newspaper and works with zero LLM calls. Content gate applies. The existing headlines/rumors section is unchanged.
- **Acceptance criteria:** an empty feed renders no empty heading; a feed with three events shows three rows in newest-first order; unknown faction/location ids degrade to their ids, not `undefined`; the section disappears when `map.showOffscreen` is false; strict content gating removes explicit template text; snapshot tests for the overlay model; no extra fetch per repaint.
- **Risk:** low
- **Model/Effort routing:** standard implementer, low effort
- **Commit message sketch:** `feat(ui): show off-screen city activity in the overlay`
- **Commit:** `6996e87`

---

### Step 4 — Pacing analyzer and explicit scene cut
- **Files:** `src/flows/pacing.js` (new), `src/agents/state-tracker.js` (analysis stage), `src/core/defaults.js` (`pacing` group), `src/core/migrations.js`, `src/ui/settings.html`, `src/ui/chat-output.js` (`CUT` kind + frame text), `tests/pacing.test.js` (new), `tests/chat-output.test.js`
- **Depends on:** Step 1
- **Parallelizable:** with Steps 2, 8, 10
- **Expected behavior:** Every turn writes `flags.pacing = { level, reasons, suggestedSlots, held, lastAnalyzedTurn, snoozedUntilTurn, lastCutTurn }` without touching story state. `cutScene({ reason })` refuses in combat, on the ending screen, and while time is held (it offers **Release time** instead); otherwise it releases the hold, advances the clock by `cutSlots` with `storyTurns: cutSlots`, sets a cut framing, appends a `pacing`-tagged event, refreshes the cast at the same location, and optionally forces one storyline beat pass. It never moves the player. Snooze suppresses levels for `snoozeTurns`. The analyzer is pure and accepts an injected `turn`/date for tests.
- **Acceptance criteria:** a fresh scene is `ok`; 3 turns with no event becomes `nudge`; a 12-turn scene becomes `cut`; a held scene downgrades to `nudge` and suggests releasing time, never a cut; snooze suppresses both until expiry; combat/ending/hold return a refusal with a reason and mutate nothing; releasing time clears the hold, advances exactly `cutSlots`, and never changes `scene.locationId`; a cut during an aborted storyline still commits time/framing/event atomically; the frame text is stripped of `[NEOTERRA_*]` blocks; all thresholds are settings-driven; tests cover every level and all three refusals.
- **Risk:** medium (time jumps interact with deadlines; a bad cut could feel like lost player control)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `feat(pacing): analyze scene drift and add an explicit cut`
- **Commit:** `e4c461a`

---

### Step 5 — Pacing surface: director card and `[NEOTERRA_PACING]`
- **Files:** `src/context/renderer.js`, `src/context/budget.js`, `src/core/defaults.js` (`context.blocks.pacing`, `tokenBudget.pacing`), `src/core/migrations.js`, `src/ui/overlay.js`, `src/ui/map-panel.js`, `src/ui/settings.html`, `tests/context.test.js`, `tests/overlay.test.js`
- **Depends on:** Step 4
- **Parallelizable:** with Steps 6, 8, 9, 10
- **Expected behavior:** The world overlay shows a compact Director card when level ≥ `nudge`: the reason (“12 turns in this scene”, “no development in 4 turns”), a **Cut forward** button wired to `cutScene`, **Not now** (snooze), and — while time is held — **Release time** (clear `SET_CLOCK_HOLD`) instead of a cut. The `[NEOTERRA_PACING]` block renders only when level ≥ `nudge` and the block is enabled; it instructs a time/scene cut, a threat development, or “hold the moment” on the next reply and never invents outcomes. It is content-gated and budget-capped. No block at `ok`.
- **Acceptance criteria:** no block when ok, disabled, combat, or ending; the block appears at nudge/cut and names only state-derived facts; while held it asks the narrator to stay in the moment and offers Release time in the UI; the cut button is disabled during combat with a reason; snooze hides the card immediately and persists across reload; the block is dropped first when the total budget is tight (ordering test); overlay model tests; settings toggle round-trips.
- **Risk:** medium (prompt directives can be over-obeyed by the narrator)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `feat(pacing): surface director nudges and cut controls`
- **Commit:** `a3a0ee3`

---

### Step 6 — Newsroom state, reducer event, deterministic publisher
- **Files:** `src/data/newsroom.js` (new: view model + deterministic edition builder), `src/state/reducer.js` (`PUBLISH_EDITION`), `src/flows/newsroom.js` (new: cadence + publisher), `src/agents/state-tracker.js` or `src/ui/shell.js` (detached call), `src/core/defaults.js` (`newspaper` group), `src/core/migrations.js`, `src/ui/settings.html`, `tests/newsroom.test.js` (new), `tests/reducer.test.js`
- **Depends on:** Step 1
- **Parallelizable:** with Steps 4, 8, 10
- **Expected behavior:** When `newspaper.enabled` is true and the cadence is due, a deterministic edition is published from events since the last edition: masthead/dateline derived from style and season, up to `maxHeadlines` headlines grouped by section, `source:'deterministic'`. `PUBLISH_EDITION` validates the edition, refuses a duplicate date idempotently, and caps the archive at 20. The publisher runs detached after the turn pipeline, re-checks the chat id before writing, and logs/no-ops on failure. With the feature off, or while time is held, no agent call, no state write, no UI change.
- **Acceptance criteria:** no events → no edition; 6 events → one edition with grouped sections; a held scene with 6 new events publishes nothing until the hold releases; a second publish on the same in-game date is a no-op; archive caps at 20 with oldest dropped; reload after publish does not duplicate; a chat switch during the detached pass writes nothing; `newspaper.enabled:false` makes zero calls and writes nothing; the deterministic builder is snapshot-stable for a fixture state; old worlds without `flags.newsroom` work.
- **Risk:** medium (state growth, duplicate editions, detached writes)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `feat(news): publish deterministic in-world newspaper editions`
- **Commit:** `6ab778a`

---

### Step 7 — Newspaper agent, reader UI, and `[NEOTERRA_NEWS]`
- **Files:** `src/agents/newspaper.js` (new), `src/core/constants.js` (`AGENT_IDS`), `src/agents/prompts.js`, `src/core/defaults.js` (agent entry — must land with the id), `src/core/migrations.js`, `src/ui/newspaper.js` (new: reader modal), `src/ui/overlay.js` (button + latest headlines), `src/ui/map-panel.js` (delegated open), `src/context/renderer.js`, `src/context/budget.js`, `src/ui/settings.html`, `style.css`, `tests/newspaper-agent.test.js` (new), `tests/context.test.js`, `tests/overlay.test.js`
- **Depends on:** Steps 6, 5 (shares overlay surface)
- **Parallelizable:** with Steps 8–10
- **Expected behavior:** When the feature and the agent are enabled, the publisher asks the `newspaper` agent for prose and falls back to the deterministic edition on failure, invalid JSON, timeout, or abort. The reader modal shows masthead, dateline, headlines with section/tone chips, and an archive; keyboard focus is trapped and Escape closes. The overlay shows the latest 1–2 headlines and a button. `[NEOTERRA_NEWS]` renders date + up to 2 headlines when enabled, with its own budget and gate.
- **Acceptance criteria:** `AGENT_IDS` + defaults + prompt + UI land together and `getSettings` never throws (the `normalizeAgents` landmine); schema caps enforced; one repair then fallback; a failed agent still yields an edition with `source:'deterministic'`; the modal is keyboard navigable and does not leak hidden fog data; `[NEOTERRA_NEWS]` is absent when the feature is off or the gate empties it; archive order is newest first; no LLM call when `agents.newspaper.enabled:false`.
- **Risk:** high (agent registration ordering, modal DOM, content tone)
- **Model/Effort routing:** implement-hard, high effort
- **Commit message sketch:** `feat(news): add the newspaper agent and in-world reader`
- **Commit:** `92f0e39`

---

### Step 8 — Exploration state, fog rules, travel discovery and gating
- **Files:** `src/state/exploration.js` (new: pure rules), `src/state/reducer.js` (`DISCOVER_MAP_FEATURE`, `REVEAL_REGION`), `src/state/world-state.js` (seed start-region discovery), `src/flows/travel.js` (discover path, gate destination, accept `getSettings`), `src/ui/shell.js` (pass `getSettings` to `createTravelFlow`), `src/data/map.js` (`applyMapFog` + visibility helper), `src/core/defaults.js` (`map.fog`), `src/core/migrations.js`, `src/ui/settings.html`, `tests/exploration.test.js` (new), `tests/travel.test.js`, `tests/map-model.test.js`
- **Depends on:** none (map data already generated)
- **Parallelizable:** with Steps 1–7, 10
- **Expected behavior:** A seeded world marks the start location’s region discovered (and, in `rumors` mode, bridge-adjacent regions rumored). `applyMapFog` returns a copy of the map view model where unknown/rumored features have names, descriptions, factions, present cast and travel stripped. Travel rejects unknown destinations when gating is on, allows rumored ones as blind trips, and discovers every region on the path in the same batch as the move. Editor reveals use `REVEAL_REGION`. `showFogOfWar:false` leaves the view model identical to V1.
- **Acceptance criteria:** default world has exactly the start region discovered and no others; `applyMapFog` never leaves a hidden name/description/faction in the model (string-level assertions); a hidden destination is rejected with a clear reason; a rumored destination is allowed and the arrival discovers the path; `hard` mode reveals no neighbors; bridge visibility follows endpoints; virtual locations stay travelable through discovered connections; disabling fog returns a byte-identical view model; a world imported without `flags.map.exploration` is treated as fog-off rather than crashing; reducer events are idempotent.
- **Risk:** high (can block legitimate travel or leak authored names)
- **Model/Effort routing:** implement-hard, high effort
- **Commit message sketch:** `feat(map): add exploration state and fog-gated travel`
- **Commit:** `f7be1fb`

---

### Step 9 — Fog rendering, submenu gating, and editor reveal
- **Files:** `src/ui/leaflet-adapter.js`, `src/ui/map-panel.js`, `src/ui/map.js`, `src/ui/overlay.js` (editor actions), `src/core/defaults.js` (`map.fog` UI defaults), `src/ui/settings.html`, `style.css`, `tests/map-model.test.js`, `tests/ui-css.test.js`
- **Depends on:** Step 8
- **Parallelizable:** with Steps 5–7, 10
- **Expected behavior:** When fog is on, unknown regions render as near-opaque dark shapes with no label, rumored regions as dim outlines with a name only, and discovered regions normally. Key-location and named-location markers inherit their region’s visibility. The submenu for a hidden feature shows “Uncharted” and no description, faction, cast or travel button. The fog toggle persists and is the on/off switch. Editor actions “Reveal region” and “Reset fog” write through the reducer/store. The map remains usable with the fallback single-image renderer (fog disabled).
- **Acceptance criteria:** visual states differ for the three visibilities; no hidden label is in the DOM; submenu hides all gated fields; toggling fog off restores V1 rendering without reloading; reveal/reset persists per chat and does not touch authored `data/map/overrides.json`; a fallback mount disables fog controls with a reason; the layer toggle survives reload; CSS uses theme tokens only; 1080p and 1440p layouts do not overlap; tests cover the map model and the toggle state.
- **Risk:** medium (Leaflet restyle path, duplicated style constants)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `feat(map): render fog of war and gate hidden details`
- **Commit:** `667f127`

---

### Step 10 — Relationship graph model and Relations tab
- **Files:** `src/ui/relationship-graph.js` (new: pure model), `src/ui/relationships.js` (new: tab UI + SVG), `src/core/constants.js` (`SHELL_TABS`), `src/ui/shell.js` (host, mount, dispose, chat-change teardown, `LIVE_PANELS`), `style.css`, `src/ui/theme.css`, `tests/relationship-graph.test.js` (new), `tests/ui-css.test.js`
- **Depends on:** none
- **Parallelizable:** with Steps 1–9
- **Expected behavior:** A new live **Relations** tab renders an SVG graph from `WorldState.relationships` + the player mirror. Layout is deterministic (player centre, present inner ring, others outer ring). Edges are styled by type and affinity, `owner/servant` is directed, and nodes carry present/side/corruption/bad-end badges. Filters: present only, side, type, minimum affinity. Click selects a node and shows its relationship list; hover highlights; keyboard focus works. Empty state when there are no relationships. Repaints on `MAP_UPDATED`/`TAB_CHANGED`; disposes on chat change.
- **Acceptance criteria:** a 0-node state shows the empty state without throwing; 1 node renders no edges; the player appears exactly once for custom and canon identities; duplicate player/canon mirror edges are deduped; directed edges render an arrowhead only for `owner/servant`; positions are deterministic for the same state and within the declared bounds; 66 nodes remain readable (labels thinned by affinity/present); filters change node/edge counts as expected; clicking sends no chat message and writes no state; tab keyboard navigation and chat-change disposal work; theme-token CSS test passes.
- **Risk:** medium (layout readability, shell tab wiring, full repaint cost)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `feat(ui): add the relationship graph tab`

---

### Step 11 — Domain sensorium (generic): data, tab, and `[NEOTERRA_DOMAIN]`
- **Files:** `data/seasons/s1dark.json` (`domain` block), `data/seasons/sandbox.json` (no domain), `data/schemas/season.schema.json`, `src/data/seasons.js` (optional domain validation), `src/data/domain.js` (new: pure view model), `src/ui/sensorium.js` (new: Domain tab), `src/ui/tab-visibility.js` (new: pure visible-tab resolver), `src/core/constants.js` (`SHELL_TABS` + `domain`), `src/ui/shell.js` (conditional tab + fallback), `src/context/renderer.js`, `src/context/budget.js`, `src/core/defaults.js` (`context.blocks.domain`, `tokenBudget.domain`), `src/core/migrations.js`, `src/ui/settings.html`, `style.css`, `tests/domain.test.js` (new), `tests/tab-visibility.test.js` (new), `tests/context.test.js`
- **Depends on:** Steps 2, 7 (feed + prose patterns), Step 10 (tab pattern)
- **Parallelizable:** with Steps 8–9
- **Expected behavior:** S1Dark declares Wonderland (`factionId:'clarity'`, `knightFormKind:'knighted'`) using the **generic optional `domain` block** any future villain season can author. The Domain tab is visible only when `season.domain` exists and `playerRole === 'villain'`; otherwise the nav button/panel are hidden and an active Domain tab falls back to Characters. The view shows the domain, knights (Heart Attack/Bittersweet/White Rabbit from the registry), court/corruption spread, district control, resistance progress, and the off-screen/beat feed. `[NEOTERRA_DOMAIN]` renders for active villain POV and names the player’s domain, knights, corruption and territory. Hero seasons get no tab and no block. The same model works for a future season with a different domain name and faction.
- **Acceptance criteria:** `s1dark.json` validates with the new optional block and a scratch season with its own domain validates too; hero seasons and Sandbox produce `active:false`, no tab, no block; a villain-POV world with no knighted characters shows an empty knights section, not a crash; knights resolve from the registry slice and show live status/location/corruption; territory counts reconcile with `state.locations[].factionId`; resistance labels invert the threat framing; the block is absent when disabled, when the season has no domain, or when the role is not villain; tab visibility is pure and tested; no authored Wonderland text is duplicated into code (it comes from season data).
- **Risk:** medium–high (villain framing is easy to get wrong, and the tab is conditional)
- **Model/Effort routing:** implement-hard, high effort
- **Commit message sketch:** `feat(domain): add the generic domain sensorium`
- **Commit:** `b2379d5`

---

### Step 12 — Docs, settings surface completion, changelog, and smoke QA
- **Files:** `docs/world-clock.md`, `docs/world-tick.md`, `docs/newspaper.md`, `docs/pacing.md`, `docs/fog-of-war.md`, `docs/relationships.md`, `docs/sensorium.md` (new), `docs/data-schema.md`, `docs/adding-a-season.md`, `README.md`, `CHANGELOG.md`, `package.json` (version 1.1.0), `manifest.json`, `src/core/constants.js`, `src/ui/settings.html`, `src/ui/shell.js`, `tools/smoke-test.mjs`, `tests/integration.test.js`
- **Depends on:** all prior steps
- **Parallelizable:** no (final integration)
- **Expected behavior:** Every new setting, data field, default, and flow is documented with an authoring example. The README covers the six features, their defaults, and how to disable each. `docs/world-clock.md` explains the pace, the time chip, and the `storyTurn`/`turn` split; `docs/adding-a-season.md` documents the generic `domain` block so a future villain season needs data only. `CHANGELOG.md` lists 1.1.0. The settings panel exposes every new toggle and numeric field, including `map.showFogOfWar` (currently hidden). Integration tests exercise the six features together in one fixture world (clock/hold → tick → pacing → newsroom → fog → graph → domain) with no LLM calls.
- **Acceptance criteria:** a new season can omit `domain`/`agendas` and still boot; docs match the code’s defaults exactly; every new block/toggle has a settings control; `npm run check` passes from a clean clone; the integration fixture is deterministic; `git ls-files` contains no absolute paths or generated junk; version and changelog agree; the six features are individually switchable off without errors.
- **Risk:** low
- **Model/Effort routing:** standard implementer, low effort
- **Commit message sketch:** `docs(v1.1): document the living-city features and finalize 1.1.0`
- **Commit:** `b0c720b`

## Verification & Testing

### Automated (exact commands)
```bash
# from the repo root (C:\Users\locua\OneDrive\Escritorio\KI\extensions\NeoTerra-Framework)
npm install                        # only if dev deps are ever added; runtime stays dependency-free
node --test tests/*.test.js        # full unit suite (Node's built-in runner)
node --test tests/world-clock.test.js tests/world-tick.test.js tests/pacing.test.js \
  tests/newsroom.test.js tests/exploration.test.js tests/relationship-graph.test.js \
  tests/domain.test.js            # the new feature suites
node tools/build-data.mjs --check  # registry/data invariants
node tools/build-map.mjs --check   # generated map is unchanged and valid (36/12/22)
node --check index.js
npm run check                      # aggregate gate: builds + syntax + tests + smoke
```
- New pure modules must be importable in Node with no DOM: `world-clock`,
  `world-tick`, `newsroom`, `exploration`, `relationship-graph`, `domain`,
  `tab-visibility`.
- Map tests assert 36/12/22 counts are untouched, every named location keeps its
  binding, and fog never mutates authored geometry.
- The newspaper tests use fixtures only; no network and no LLM.

### Manual checks (live SillyTavern at `http://127.0.0.1:8000/`)
1. **Clock:** open a fresh chat, start a season, play 6 assistant turns. The
   scene block’s date/time changes on schedule, wraps at night, and increments
   the date exactly once per 5 slots. Disable the clock and confirm the date
   freezes.
2. **Time brake:** click the top-bar time chip during a scene. Confirm the date,
   slot and `storyTurn` stop while the mechanical turn counter continues; the
   scene block shows “(time frozen)”; no off-screen feed item and no newspaper
   edition appears even if the event threshold is met. Play 10 turns. Click
   release: time resumes once, not ten times. Start a fight and confirm the chip
   shows held; end it and confirm it releases (a manual hold survives). Travel
   and confirm the hold releases and time advances by the path length.
3. **Off-screen tick:** with the tick enabled, skip several in-game days (via
   travel or the pacing cut). Confirm faction influence and threat progress
   moved within caps, 1–2 NPCs relocated, and the overlay feed shows tagged
   off-screen items. Confirm the player never moved and no pinned present
   character moved. Confirm a Sandbox world stays static and a held scene
   produces no tick.
4. **Pacing:** idle in one scene for `stallTurns`; the Director card appears and
   `[NEOTERRA_PACING]` shows in the prompt (inspect the agent log or the
   injected prompt). Click **Cut forward**: time advances, framing changes, the
   cast refreshes, the player stays put. While held, the card offers **Release
   time** and never a cut, and the block asks the narrator to stay in the
   moment. Snooze hides it for the configured turns. Combat and the ending
   screen disable the cut button.
5. **Newspaper:** enable it. After `everyDays`, the overlay shows a new edition;
   open the reader, check masthead/dateline/headlines, archive order and Escape
   focus return. Disable the agent but keep the feature on: a deterministic
   edition still appears. Disable the feature: no button, no state write, no
   agent call. S1Dark `auto` style reads as tabloid; a post-victory resistance
   arc reads as underground.
6. **Fog:** enable fog. Only the start region is visible; neighbors are rumored
   if in `rumors` mode. Try to travel to an unknown district: rejected with a
   clear reason. Travel to a rumored neighbor: allowed, and the arrival
   discovers the path. Hover/click unknown regions: no name, description,
   faction, cast or Travel button. Toggle fog off: the full V1 map returns.
   Reveal a region from the editor, reload, and confirm it persists; reset fog
   restores the start-only state.
7. **Relationships:** corrupt/ally a few characters, open **Relations**. The
   graph shows the player once, present characters on the inner ring, an
   `owner/servant` arrow, and live affinity widths. Filters and click selection
   work; switching chats disposes and remounts without duplicate SVGs.
8. **Sensorium:** start S1Dark. The **Domain** tab appears with Wonderland,
   Heart Attack/Bittersweet/White Rabbit, corruption stages, district control
   and resistance progress. The prompt contains `[NEOTERRA_DOMAIN]` and the
   narrator treats the player as the antagonist. Start S1 (hero season): no
   Domain tab and no block. Add a minimal `domain` block to a scratch copy of
   another villain-POV season and confirm the same tab/model lights up with no
   code change. Switch the S1Dark player to a hero identity and confirm the
   domain view still reflects the season (documented behavior).
9. **Cross-feature:** advance 20 turns in S1Dark with all features on, holding
   time for one long scene. Confirm one coherent timeline: date advances only
   while released, the tick and newspaper pause during the hold and resume
   after, pacing cuts do not teleport, fog reveals only traveled routes, and the
   domain view’s territory matches the map.
10. **Disable matrix:** turn each feature off in turn and confirm no errors, no
    orphan panels, and no extra agent calls. Uninstall/disable another extension
    and confirm no runtime dependency was introduced.

### Edge cases to exercise
- Clock: month/year rollover, Feb 29, `date:null` Sandbox, 200 consecutive
  ticks, `clock.enabled:false` byte-identical state.
- Time brake: a 30-turn hold (date frozen, `storyTurn` frozen, `turn` moving),
  a held scene saved/reloaded mid-hold, a manual hold surviving combat end,
  an explicit tick during a hold, travel during a hold, a storyline cadence
  that comes due during a hold (skipped), releasing twice (idempotent), a V1
  world migrated with `storyTurn = turn`.
- Tick: no agenda data for a season, all threats defeated, a disbanded faction,
  a 60-day absence (clamp + `suppressedDays`), combat active, time held, ending
  epilogue, chat switched mid-tick, tick replayed after reload.
- Pacing: no events at all, combat, ending, hold, snooze expiry, cut during an
  aborted storyline, cut with the map open, repeated cut on the same turn.
- Newspaper: zero events, 200-event ring trimmed, duplicate publish on the same
  date, agent returns fenced/invalid JSON, agent timeout, strict content gate,
  a post-victory `underground` style, archive overflow.
- Fog: virtual locations with no polygon, `underground` district, a bridge with
  one discovered endpoint, a named location visited in an undiscovered region,
  a world imported without exploration state, fog enabled on a fallback
  single-image map, editor reveal/reset, chat isolation.
- Graph: zero characters, one character, custom persona + canon character,
  duplicate player mirror, 66 nodes, unknown relationship type, a bad-ended
  character, a non-roster manual character.
- Sensorium: hero season, Sandbox, S1Dark with all knights cleansed, a villain
  victory that changes faction control, a corrupted non-knight, a player
  identity switch, the Domain tab hidden while active.
- Settings: unknown settings keys preserved, new groups normalized, a partial
  legacy settings object, a settings doc from a newer build.
- Agent registration: `newspaper` present in `AGENT_IDS`, defaults and prompts
  in the same commit; `getSettings` does not throw on an old settings doc.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The clock makes date-based deadlines fire earlier than players expect | Surprise deadline escalation or an early villain victory | `clock.enabled:false` restores V1; a 200-turn dry-run test; docs state the pace; the overlay already previews deadlines |
| The time brake hides escalation or is forgotten | A held scene runs for 40 turns; the world is frozen and the player is surprised on release | Chip is always visible and shows “frozen”; the Director card offers Release time; a one-shot reminder after `maxHoldTurns`; releasing advances once, not per held turn |
| `storyTurn` and `meta.turn` diverge | Confusing deadlines, cadence or logs | Single helper owns both; `turn` stays mechanical everywhere; a migration sets `storyTurn = turn`; tests assert every ledger comparison uses `storyTurn` |
| Off-screen rates unbalance the world | Threats win too fast or the city feels static | Authored per-season rates + global fallbacks; per-tick delta caps; `maxDaysPerTick`; deterministic tests for 1/7/60 days |
| Off-screen NPC motion contradicts the scene | A character appears somewhere they should not | Never move present cast, manual pins, the player, or terminal characters; cap moves per tick; source locations are authored connections |
| Pacing nudge is over-obeyed | The narrator cuts scenes the player wanted to continue | Nudge is advisory text, not state; snooze; no automatic relocation; cut is an explicit button |
| Newspaper adds latency or duplicate editions | Slow turns, duplicated archive entries | Detached publish after the pipeline; chat-id re-check; `PUBLISH_EDITION` dedupes by date; agent fallback |
| Newspaper agent registration ordering | `getSettings` throws everywhere (the `normalizeAgents` landmine) | Add `AGENT_IDS` + `DEFAULT_SETTINGS.agents[id]` + prompt in one commit; a settings test on an old doc |
| Fog leaks hidden names through the detail panel | Spoils exploration; breaks the fiction | `applyMapFog` blanks the view model before both render and submenu; string-level tests assert absence |
| Fog blocks legitimate travel | Player cannot reach a needed location | `gateTravel` setting; rumored destinations allowed; virtual nodes travelable; a clear rejection message; fog off by default |
| Relationship layout is unreadable at full roster | UI looks broken with 66 nodes | Deterministic rings, label thinning, filters, present-only default off but one click away; pure model tests |
| Villain framing bleeds into hero seasons | Wrong tone and wrong prompt block | `domain` is optional and generic; `active` requires `playerRole:'villain'` and a season domain; hero seasons produce no tab/block; S1Dark is only the first consumer; tests |
| New `flags.*` state is lost on export/import | Fog/news/tick reset unexpectedly | Everything lives in `WorldState` (already exported); `withChatMap` preserves unknown group keys; round-trip test |
| Conditional Domain tab breaks keyboard navigation | Focus lands on a hidden tab | Pure `resolveVisibleTabs` + active-tab fallback to Characters; shell tab test |
| Duplicate render styling (bridge/region constants) | Fog styles overwritten by `highlight()` | Centralize the fog style in one helper used by both mount and restyle; update `highlight` to respect visibility |

## Out of Scope (V1.1)

- An LLM “world tick” agent or per-NPC agenda simulation beyond authored rates.
- Recap-on-load (a separate proposed addition), branch saves, and the
  `Others`/NeoHorizon setting.
- Wiring the currently dead agents (architect, cast director, lore, auditor,
  bad end) or the Player tab. This plan must work with them unwired.
- Changing combat, CYOA, endings or bad-end behavior. Canon-beat *content*
  and authoring are unchanged; only the counter they compare against becomes
  fiction time (`storyTurn`) instead of the mechanical turn counter.
- A full calendar widget/date picker (the one-click time chip is in scope), map
  authoring changes, or new SVG layers.
- Localization and runtime dependencies.

## Decisions (locked 2026-11-18)

| # | Question | Decision |
|---|---|---|
| 1 | Clock pace | **One turn = one slot; a day every 5 turns**, during normal play and travel. Major scenes, beats, combat and intimate scenes freeze fiction time until it is explicitly released. |
| 2 | Off-screen tick prose | **Deterministic**, no LLM tick agent. Authored rates + templated rumors; the newspaper agent is the prose layer. |
| 3 | Off-screen NPC autonomy | **Yes** — up to `maxNpcMovesPerTick` (default 2) off-scene NPCs relocate per tick along authored connections. |
| 4 | Defaults | Clock + tick + pacing nudge **on**; fog **off**; newspaper **off** (opt-in, deterministic fallback when on); Relations tab available; domain view automatic for any villain season that authors one. |
| 5 | Newspaper storage | **`flags.newsroom`**: max 20 editions × 6 headlines, exported/imported with the world, at most one edition per in-game day; detached call acceptable. |
| 6 | Fog | **`rumors` mode**: start region discovered, bridge-adjacent regions rumored, travel gating on, fog off by default; turning fog off restores the V1 map. |
| 7 | Graph placement | **Dedicated Relations tab.** |
| 8 | Pacing agency | **No automatic relocation.** Cut is an explicit click; time + framing + cast at the same location only. |
| 9 | Sensorium scope | **Generic `domain` block** any future villain season can author; S1Dark is the first consumer. Tab/block only for villain POV. |
| 10 | Wiring debt | **Out of scope.** The six features must work with the currently unwired agents. |

### Derived implementation decisions (from the answers)

1. **`meta.storyTurn` is added.** To make “frozen” mean something for deadlines,
   turn-based deadline/`turnRange` checks use `storyTurn` (advances only when
   time flows) while `meta.turn` stays the mechanical pipeline counter. Old
   worlds migrate `storyTurn = turn`, so behavior is unchanged until the brake
   is used. *This is the only new world-state field; it is additive.*
2. **The brake is explicit plus automatic where it is unambiguous.** Combat
   auto-holds; encounters hold per setting; encounter/beat scale is a
   `clock.autoHold` switch. Major/intimate scenes use the always-visible top-bar
   time chip (one click) or `scene.hold` from any flow. **No prose-based
   intimacy detection** — it is unreliable and content-sensitive. Beat scenes
   are not auto-held by default because a beat can stay open for a whole act;
   the chip is one click. Future flows (encounter bar, CYOA lewd/romantic
   choice handler) can set the same flag.
3. **Timers pause, mechanics continue.** A held scene still increments
   `meta.turn` (so cadence, choice caching and the UI keep working), but not
   `storyTurn`, the date, the slot, the off-screen tick, the newspaper cadence,
   or deadline escalation.
4. **The newspaper stays opt-in.** When enabled, it publishes deterministically
   if the agent is unavailable or fails. This keeps the default run free of new
   LLM cost.
5. **The domain view follows the season, not the identity.** S1Dark remains a
   villain-POV season even if the player switches to a hero identity; the
   Domain tab stays and the narration block remains, because the world is still
   Wonderland. This is documented in Step 11.
6. **All feature state lives under `WorldState.flags.*`.** No new top-level
   document, no second source of truth; export/import and old-chat tolerance
   come for free. `meta.storyTurn` is the only structural addition.

No blocking open questions remain. The approved plan is ready for Step 1.
