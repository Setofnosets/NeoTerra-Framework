# Neo Terra Framework V1 — Seasons, World State, Cast, Map, and Agents

## Meta
- **Slug:** neoterra-framework-v1
- **Status:** in progress — Steps 1–5 complete
- **Date:** 2026-11-16
- **Source spec:** `start.md`
- **Target:** SillyTavern third-party extension, single repo `NeoTerra-Framework/`
- **Repo:** `https://github.com/Setofnosets/NeoTerra-Framework.git` (private/empty at planning time; configured as `origin`)
- **License:** MIT
- **Minimum SillyTavern:** `1.19.0`
- **Reference material:** `Chars/` (cards + lorebooks), `NeoTerra.png` (2017×1512), sibling extensions `Combat-Multihog` and `silly-teyvat-dist`

## Summary

- **Goal:** A self-contained SillyTavern framework for the Neo Terra universe that (1) lets the player enter through a season, (2) constructs a season-correct world, (3) keeps a structured world state updated as play proceeds, (4) injects only the relevant characters/lore, and (5) exposes a city map, character codex, faction/threat overlay, and player sheet through a custom UI.
- **Core bet:** Worlds are driven by a **single authoritative `WorldState` document per chat**, written by deterministic reducers plus small, schema-constrained LLM agents. Prose remains the job of the main narrator. Agents never free-write state; they return JSON that is validated, merged, and rendered.
- **Character strategy:** Use a **Director/Narrator card + generated season world book + live per-character state injection** as the primary mode. Support `SillyTavern` group chat for scene-local multi-speaker play and single-card hot-swap for solo scenes as optional modes. This is the hybrid answer to the "giant lorebook vs hotswap cards" question in `start.md:18`.
- **Player identity:** the player is a custom persona by default, and may optionally **play as a canon character** (via a "Play as" action in the Character Codex/registry). Play-as is restricted to the **current season roster**; Sandbox allows any registry character, and any non-roster/manual/imported character carries a persistent **"non-canon"** warning with canon beats disabled. A player-controlled canon character is treated as the player for narration and tracking, is removed from the NPC cast pool, and is excluded from group-chat speaker selection. `S1Dark` ships with this as its intended mode (player = Carol Fate / Bleeding Heart, the season's villain).
- **Canon beats:** each season carries a **Canon Beat Ledger** of major milestones with flexible completion conditions. The Storyline Tracker must land the *function* of each beat ("in some form") while allowing divergence in who, where, when, and how — including early villain defeat or retargeted heroes. Beats have **soft deadlines with escalating consequences**; the final deadline for the season's main threat is **complete villain victory** (a legitimate, recorded ending).
- **Villain victory is playable, not a dead end.** When the final deadline passes, the threat wins: a ~5-paragraph epilogue describes the victory, then the player chooses to continue as a **resistance** or to **join the villain** (defeat the resistance, conquer further districts/cities, or serve as a brainwashed enforcer). Both paths rewrite the world into a post-victory arc.
- **Character bad ends are tracked (opt-in).** Death, identity loss, autonomy loss, permanent corruption, imprisonment, and similar terminal states are recorded with a short epilogue and an editable tracking prompt. The player may continue as the bad-ended character (when narratively possible) or switch to someone else; the record persists for consistency.
- **Optional CYOA mode:** configurable choice buttons after each assistant turn. Default is 4 context-derived choices (labels up to **100 characters**), with customizable count, theme, and content mix. Off by default; clicking a choice sends it as the player's message. A **second, independent setting** controls tactical choices during combat.
- **Content gate:** an optional global violence/explicitness reducer, **disabled by default**, plus per-character and per-player limits.
- **Standalone:** no hard dependency on any other extension. All combat, map, UI, and agent primitives are owned by this repo; sibling extensions are reference material only.
- **Non-goals for V1:** full numeric RPG combat, the `Others` / NeoHorizon setting, Season 5 gameplay content, image generation, and a public plugin marketplace.

## Current State (verified by exploration)

### Repository
- Repo contains only `start.md`, `NeoTerra.png`, `Chars/`, and a bare `.git`. **No extension scaffold, no `manifest.json`, no `package.json`, no code.**
- `Chars/` is raw source data, not runtime data. Card filenames carry the only machine-usable distinction between base and alternate forms.
- No location/node metadata, coordinates, season ordering, faction registry, or transformation mapping exists anywhere. All of that must be **authored**, not extracted.
- `.git` is local-only (`repositoryformatversion = 0`, no remotes).

### Character card data (from `Chars/`)
- 66 season cards + 4 "Others" cards are `spec: "chara_card_v3"` / `3.0`; 8 `Others/NeoHorizon` cards are `chara_card_v2` / `2.0`.
- Every V3 file duplicates a **legacy top-level block** (`name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example`, `tags`, `creatorcomment`, `avatar`, `talkativeness`) alongside the real `data{}` payload. Loaders must read `data.*`; writing top-level only is a no-op.
- Most cards embed a `character_book` with entries using `keys`/`comment`/integer `id`/`insertion_order`. Older cards lack entry `name`; newer cards add book-level metadata. A blanket `constant: true` "Neo Terra" entry is duplicated in most cards — merging all cards naively triples context.
- `Chars/lorebooks/*.json` are flat arrays with a **different schema**: `key`/`name`/uuid `id`/`priority`/`tags`, plus optional SillyTavern fields on newer entries. Character-book and lorebook parsers must be separate.
- Card `description` contains the useful structured prose fields (`Setting/World`, `Gender`, `Species`, `Aliases`, `Appearance`, `Abilities`, `Side`, etc.), but there are no real JSON fields for stats.
- Counts: S1 = 11 files, S1Dark = 10, S2 = 13, S3 = 18, S4 = 22, Others = 4, NeoHorizon = 8.
- Known filename defects: `S3/Selina Cross-Umbra).json` (stray paren), `S4/Pink Icicle (Coldhearted Ping Power).json` ("Ping"), `S3/Crazy Cupid (Treat Zara Embarr).json` ("Treat"), `S4/Vaiva ... (Season 4 ver.)` vs S2 surname spelling. Any registry must key on stable IDs, not filenames.
- One base can have **multiple mutually exclusive alternatives**: S4 Gravitasha → `Event Horizon` | `O.N.E. Snowfall`; S4 Hula Hawk → `Bird Cage` | `Frost Flight`; S4 Crimson Crush → `Dark Dragon` | `Cyber Dragon`; S4 Pink Power → `Shattered Shard` | `Pink Icicle`; S1Dark Carol → 3 forms; S4 Claire → `Ice Queen` | `Claire Atropos (Recorrupted)`.
- Transformation labels live only in parentheses: `Corrupted`, `Cleansed`, `Treated`, `Infected`, `Coldhearted`, `Knighted`, `Poisoned`.
- Recurring characters change per season (Vaiva ages 25→30 and changes identity status; Claire alternates villain→cleansed→recorrupted/ice queen; Selina human→vampire). **Season membership must come from the folder**, not lorebook text.
- The `Atropos couple` card and `The Sensational Sirens` card each contain multiple characters in one file. The registry must model them as multi-actor cards and split them into separate registry entries (or explicitly mark them as a bundle), never as one character.
- Player-as-canon is a first-class case: when the player takes a canon character, that character's card/form drops out of the NPC pool and the codex shows a "Playing as" state.

### Lorebooks
- `NeoTerra.json` (5 entries) is the base world book.
- `NeoTerra-Timeline&ToneAuxiliary.json` (2 entries) has canon timeline + tone/meta.
- `NeoTerra-ThreatLevel.json` (1 entry) defines the D→OMEGA threat scale.
- Season books are very thin: S1 = 15 entries, S2 = 2, S3 = 1, S4 = none. S3's single entry is the season premise plus a keyword list of every S3 name. They cannot be used as the sole source of cast or lore.
- **Season 5 now has an auxiliary lorebook:** `Chars/lorebooks/NeoTerra-Season5(EnvyArc)Auxiliary.json`. It is an auxiliary/support book, not a main season book and has no character folder. V1 must parse and tolerate it, list it as "coming later", and reject season entry with a clear message. The data format must accept a real S5 later without code changes.
- **`S1Dark` is a player-as-villain season.** `Chars/S1Dark/Carol-Bleeding Heart.json` explicitly states "In Neo Terra Dark, YOU are the Season's main antagonist" and is designed as the Carol Fate / Bleeding Heart persona. The season definition therefore carries `playerRole: 'villain'` and a `defaultPlayerCharacterId`. This is not a normal hero-POV season.

### Sibling extensions (reuse targets)
- **Combat-Multihog** is the strongest reference:
  - `llm-client.js` — `sendStateRequest()` dispatcher (Connection Manager profile / Ollama / OpenAI / `generateRaw`) and `sendAgentTurn()` tool loop.
  - `src/state/settings.js` + `defaults.js` + `versions.js` — versioned, migration-on-read settings with a re-entrancy guard.
  - `src/state/chat-persistence.js`, `history-file-storage.js` — per-chat partitions, WAL, and `/api/files/upload` for large histories.
  - `src/state/pass-affinity.js` — aborts an agent pass if the user changed chats mid-flight.
  - `narrative-hooks.js` — `generate_interceptor`, `ctx.registerFunctionTool` dice tool, `/roll` slash command, RNG queue.
  - `src/ui/game-master-card.js` — character card hot-swap via `/api/characters/all` + `selectCharacterById`.
  - `src/ui/panel/*` — draggable/resizable floating panels and a live agent terminal.
  - `dungeon-map-graph.js` / `dungeon-reality.js` — node graph + map document transactions (renderer is dungeon-specific; data model is reusable).
- **silly-teyvat-dist**:
  - `machine.js` — a tiny queue-safe state machine; direct fit for `map → location → travel → scene`.
  - `world-map.js` + `map-engine.js` + `vendor/leaflet` — a proven Leaflet map overlay with custom CRS.
  - `world-data.js` — waypoint model, distance, `teleportTo`, and prompt sync.
  - `location-cast.js` — per-character placement with capacity limits.
  - `trust.js` — derived relationship state (no stored counters) + prompt rendering.
  - `prompt-order.js` — registers prompts into AI Config instead of hidden injection.
- **Lorebook Generator** (live copy under `ST/data/default-user/extensions/`):
  - `buildInternalEntry()` / `buildWorldInfoFile()` — complete ST world-info entry schema; copy the shape.
  - `parseJsonObject()` / `normalizeEntries()` — tolerant JSON extraction.
  - `saveLorebook()` — `ctx.saveWorldInfo(name, data)` with download fallback.
- **Landmines to respect:**
  - Mixing manifest `generate_interceptor` with `setExtensionPrompt` causes duplicate blocks. Pick one per block.
  - `generateRaw` with `trimNames: true` deletes replies that start with `{{char}}:`. Set `trimNames: false` for JSON agents.
  - `ctx.chatId` lags during `CHAT_CHANGED` / `MESSAGE_SWIPED`; track the chat ID yourself.
  - Native tool calling only exists on direct `openai`/`ollama`; profile/`generateRaw` paths need text `Action: tool({...})` parsing.
  - `extensionSettings` is async-persisted; add a localStorage WAL for in-flight state.
  - ST world-info entries are fragile across naming variants (`keys`/`key`/`keywords`, `comment`/`name`). Normalize at the boundary.

## Recommended Design

### 1. Entry and season flow
- A top-right **Neo Terra button** and `/neoterra` slash command open the shell.
- First run / no season: **Season Menu** with one card per season (`S1`, `S1Dark` alt, `S2`, `S3`, `S4`) plus **Sandbox (generic)** and **Character-first**. `S1Dark` is visibly marked **Villain POV — play as Bleeding Heart**; `S5` appears as a disabled "Auxiliary data present — coming later" card.
- Selecting a season runs the **World Construction** pass:
  1. Load `data/seasons/<id>.json` (premise, anchor date, role, cast, factions, threats, start location, opening beats, canon beat ledger).
  2. Choose identity: **custom persona** (default) or **play as a canon character**. The season supplies a `defaultPlayerCharacterId` (S1Dark = Carol / Bleeding Heart). Identity can be changed later from the Codex, with a warning that it rewrites who the world treats as the protagonist.
  3. Seed `WorldState` deterministically, marking the player-controlled character with `controlledBy: 'player'` and removing them from the NPC pool.
  4. Run the **Architect** agent once to enrich off-screen placements/agendas from the season book + cast sheets, returning schema-valid JSON.
  5. Materialize a chat-scoped world book from the season roster (trimmed profiles) and link it to the chat.
  6. Create or select the Director/Narrator character card (or the played canon card when solo-mode is chosen); write the opening scene.
- Season, player identity, cast mode, and world state are stored in `chatMetadata.neoterra` so each chat is an independent timeline. Global defaults live in `extensionSettings.neoterra`.

### 2. Character handling — decision and alternatives

**Recommended: Director + Season World Book + Live Cast Injection (Mode A).**
- One neutral **Director/Narrator** card owns `{{char}}`; it narrates the world and all NPCs.
- Season roster profiles are materialized into a chat-linked world book for keyword/cast-member retrieval.
- A `[NEOTERRA_CAST]` block carries the *live* state of present characters (appearance/outfit/status/agenda/stamina/relationships) at depth 4, regenerated from `WorldState` each turn. This is what makes corruption/outfit/ability changes visible without touching cards.
- Character Codex UI exposes full profiles on demand, outside the token budget.

**Supported alternatives:**
- **Mode B — Group chat (optional).** For scenes where multiple characters should speak as themselves, the extension creates/uses an ST group chat with a whitelist of the current season roster, one card per active form. The cast director enforces `activeForm` and removes inactive forms. Best voice fidelity; higher token and card-management cost.
- **Mode C — Solo hot-swap (optional).** For one-on-one scenes (dates, interrogations, base visits), temporarily select the character's card (`/api/characters/all` → `selectCharacterById`), then restore the Director. Explicit user action only.
- **Rejected — one giant all-character lorebook.** It explodes the token budget, duplicates the blanket "Neo Terra" entry in every card, and cannot represent mutually exclusive forms cleanly.
- **Rejected — naive character-first card selection as the default.** It makes the selected card the narrator and breaks world tracking for the other 20 characters.

**Cast Director agent:** each scene change (location change, plot beat, or every N turns) it receives the allowed pool (season roster + manual adds, with current form) and returns `{present: [...], arrivals: [...], departures: [...], offscreenMoves: [...], rationale}`. Deterministic rules run first: location residents, faction control, active threats, and form exclusivity.

**Form exclusivity:** a `formGroups` map defines base ↔ alternatives. Exactly one member of a group is `active` per season timeline. Transformations are explicit rules (`form-rules.json`) with `from`, `to`, `trigger`, `sourceFaction`, `reversibleBy`, `permanent`. Trackers can only move a character along a declared rule; an unknown transformation is rejected and surfaced in the agent log.

**Player-controlled characters:** a character with `controlledBy: 'player'` is excluded from the Cast Director's NPC pool, from narratorial agency checks, and from automatic state edits other than the player's own tracker. The narrator may describe the world reacting to them but must not decide their actions, dialogue, or defeats. If the played character has alternate forms, the player may transform only through legal form rules, and the Codex shows the current form. Switching identity mid-season requires confirmation and rewrites `player.characterId`, the `controlledBy` flags, and the opening-frame prompt.

**Playing as a canon character** is exposed as a "Play as" button in two places: the season card (identity step) and the Character Codex detail view (for the current season roster only). Playing as a character outside the season roster is allowed only in Sandbox mode, with a warning that canon beats are unavailable.

### 2.5 Canon Beat Ledger (canon beats, flexible completion)

The requirement is a mix: follow the *general* beats, allow free divergence in execution. Model this explicitly instead of hoping the model remembers.

Each season defines `canonBeats[]`:

```
Beat {
  id, order,
  title, description,               // what the beat is, for the tracker
  act,                              // season phase: opening | escalation | climax | resolution
  conditions: {                     // when it is eligible to resolve
    turnRange?, dateRange?, locationIds?, actorIds?, threatStage?,
    requiresBeats?: [beatId], forbidsBeats?: [beatId]
  },
  completion: {                     // what counts as "happened in some form"
    type: 'event'|'state'|'relationship'|'threat'|'transformation',
    predicates: [ ... ]             // e.g. villain defeated, hero captured, faction controls X
  },
  flexibility: 'strict'|'adaptable'|'optional',
  deadlineTurns?, deadlineDate?,           // soft deadline
  deadlineConsequence: string,             // what escalates if missed
  rewriteHints: string                     // how to re-cast the beat if actors/locations changed
}
```

Each season also declares `finalDeadline { turns?, date? }` and `failureState: 'villain-victory'` (configurable to a neutral bad ending). Soft deadlines escalate: missed beats raise threat progress, remove allied resources, hand locations to the threat, or trigger a targeted loss. If the final deadline passes, the season ends in the main threat's complete victory — recorded as a real ending in the beat ledger, not silently ignored.

- The **Storyline Tracker** receives the current act's open beats and either (a) resolves one whose predicates are satisfied by observed events, (b) emits a *nudge* event that sets up the next beat, or (c) marks it `deferred`/`adapted` with a reason.
- **Adaptation:** if the canonical actor is dead, captured, transformed, or elsewhere, the tracker may complete the beat with a substitute actor or an equivalent event, recording `adaptedFrom` / `adaptedTo` in the beat record. If a beat's premise is impossible (e.g. the main villain was defeated in Act 1), the beat is marked `short-circuited` and the next act's beats are re-planned around the new state.
- **Deadline pressure:** each beat has a soft deadline and a declared consequence (threat progress, lost ally, lost location, targeted loss). Missing a deadline never blocks the story; it makes the world worse and re-plans the next act. If the season-level final deadline passes, the main threat achieves **complete villain victory**, which is a valid ending and is written to the ledger and journal. Deadlines are configurable (off / generous / standard / harsh) because a strict clock is not for every playstyle.
- **Early defeat is legal:** the tracker does not resurrect or railroad. It records the divergence, promotes the next threat or a successor, and schedules resolution beats for the consequences. A player who defeats the main villain early may effectively skip the threat's victory path — that is a win, not a bug.
- **Visibility:** the map overlay shows the current act, the next 1–2 beat titles as rumors/headlines, and a divergence indicator; the Codex/journal shows completed, adapted, and short-circuited beats. This doubles as a recap.
- **Auditor:** the Contradiction Auditor compares `canonBeats` status with `recentEvents` and flags beats that were narrated but never recorded, or recorded without support.

### 2.6 Bad-end states (opt-in)

A **bad end** is a character-level terminal state, distinct from the faction-level villain victory:

| Type | Meaning | Typical triggers |
|---|---|---|
| `death` | Character is dead. | Stamina 0 + lethal intent, declared kill, failed last stand |
| `identity-loss` | Original self is overwritten (personality/memory rewrite). | Max corruption, completed brainwashing, possession |
| `autonomy-loss` | Self remains aware but control is gone. | Enslavement, conditioning, curse, mind control |
| `corruption` | Permanent monstrous/alternate form with no clean reversal. | Max-stage transformation, failed cleanse |
| `imprisonment` | Indefinitely contained with no realistic escape. | Capture + no rescue path |
| `retirement` | Removed from play without death (exile, depowering, coma). | Story outcome |

- **Opt-in:** `badEnds.enabled = false` by default. When off, nothing is detected, stored, or shown. When on, the **Bad End Detector** runs after the State/Storyline tracker and evaluates deterministic predicates first (stamina, willpower, corruption stage, captivity, form rules) before asking an LLM to confirm ambiguous cases. It never invents a bad end from prose alone.
- **Record:** `WorldState.badEnds[charId] = { type, severity, cause, sourceCharacterId?, sourceFactionId?, turn, date, locationId, epilogueText, playableAs, continuityKey, reversibility, notes }`. The character also carries `status: 'dead'|'lost'|'imprisoned'` and keeps their last known state. `continuityKey` ties the record to the season timeline so exports/imports and future narrations stay consistent.
- **Epilogue:** a short 1–3 paragraph epilogue describes how the state came about and what it means for the character and the people around them. It is stored once and reused; it is not regenerated every turn.
- **Continuation choice:** after the epilogue, the player chooses:
  1. **Continue as the bad-ended character** — available when the state still permits agency (`autonomy-loss` as a servant, `corruption`, `imprisonment` escape arc) or when `badEnds.allowDeadContinuation` is enabled (`death` as a ghost/legacy/flashback). The player adopts the altered goals/labels.
  2. **Continue as someone else** — switch POV to another eligible character (alive, present, or selectable from the roster) or a new custom persona. The bad-ended character remains in the world with their record intact.
  3. **End here** — stop at the epilogue; the world stays viewable.
- **Consistency:** a bad-ended character is never silently resurrected or duplicated. If the player continues as someone else, the old character's record stays in `badEnds`, in relationships, and in the journal. Cleansing/reversal is legal only through a declared rule (e.g. antidote) and must update the record rather than delete it.
- **Editable prompt:** the detector's prompt and the epilogue instructions are user-editable in settings, with a "reset to default" button. The default prompt lists the predicates and the tone constraints.
- **UI:** the Codex shows a bad-end badge and the stored epilogue; the journal has a "Bad Ends" section; the map/overlay marks locations associated with a bad end when relevant.

### 3. State model

`WorldState` is a plain JSON document, versioned, validated against JSON Schema.

```
WorldState {
  schemaVersion, chatId, seasonId, mode,
  meta { turn, inGameDate, timeOfDay, sceneId, inCombat, startedAt },
  arc: 'season'|'post-victory',
  ending { status: 'none'|'epilogue'|'continued'|'ended', path?, epilogueText?, firedTurn? },
  playerRole: 'hero'|'villain'|'neutral',
  player {
    identity: 'custom'|'canon',
    characterId?: string,        // set when identity = canon
    ...CharacterState,           // mirrored view for the played character
    personaNotes
  },
  characters { [charId]: CharacterState },
  locations  { [locId]: LocationState },
  factions   { [factionId]: FactionState },
  threats    [ThreatState],
  beats { [beatId]: { status, resolvedTurn?, adaptedFrom?, adaptedTo?, reason? } },
  badEnds { [charId]: {
    type: 'death'|'identity-loss'|'autonomy-loss'|'corruption'|'imprisonment'|'retirement',
    severity, cause, sourceCharacterId?, sourceFactionId?, turn, date, locationId,
    epilogueText, playableAs: boolean, continuityKey, reversibility, notes
  } },
  relationships [ { a, b, type, affinity, tension, notes, sinceTurn } ],
  recentEvents [ { turn, date, summary, actors[], locationId, tags[], headline?, beatId? } ],
  scene { locationId, present[], combat?, framing },
  flags {}, log[]
}

CharacterState {
  charId, formId, formGroup, displayName,
  side: 'hero'|'villain'|'vigilante'|'civilian'|'neutral',
  controlledBy: 'npc'|'player',
  status: 'active'|'offscreen'|'captured'|'corrupted'|'dead'|'retired'|'missing'|'lost'|'imprisoned',
  badEndType?: 'death'|'identity-loss'|'autonomy-loss'|'corruption'|'imprisonment'|'retirement',
  locationId, alive,
  threatLevel, stamina { current, max }, willpower { current, max },
  agenda, goals[], mood, allegiance,
  appearance, outfit, abilities[], skills[], traits[],
  likes[], dislikes[], relationships[],
  corruption { stage, source, progress },
  lastUpdatedTurn, notes
}
```

- **Storage:** `chatMetadata.neoterra.worldState` via `saveMetadataDebounced()`; per-swipe snapshots at `message.extra.neoterra.snapshots[swipe_id]`; a compact localStorage WAL for in-flight saves.
- **Writes:** only through `applyWorldEvent(state, event)` reducers. Agents emit **events**, not state diffs, so merges are deterministic and replayable. Event log doubles as the story journal.
- **Reads:** selectors produce compact prompt blocks; UI reads the same document.

### 4. Agents

All agents share one client and one contract:
- `sendAgentRequest({ agentId, prompt, schema, temperature, maxTokens })` routes through a configured Connection Manager profile, falling back to the main connection, then `generateRaw({ trimNames: false })`.
- Response is JSON-only, validated against a per-agent schema, with one repair retry and a hard fail to the agent log. No agent may mutate state directly.
- Chat-affinity guard aborts a pass if the active chat changed.
- Prompt templates are user-editable and stored per agent.

Agents:
1. **Architect** — one-shot season bootstrap enrichment (placements, agendas, threats, opening hooks).
2. **Storyline Tracker** — periodic (location change / N turns / major beat) high-level update: faction influence, threat progress, events, headlines, goal shifts, and Canon Beat Ledger resolution/adaptation/deferral. It may only transform characters along declared form rules.
3. **State Tracker** — every turn, player-only (custom persona or played canon): stamina, status, skills used, relationships touched, gear/outfit. Never edits NPCs and never narrates the player's choices.
4. **Cast Director** — scene cast and injections; excludes `controlledBy: 'player'` characters from NPC selection.
5. **Lore Agent** — summarizes events into lorebook entries, updates relationships, and selects what lore to inject.
6. **Continuity Auditor** — cheap checker that flags contradictions between `WorldState`, recent prose, canon beats, and the timeline before they compound. Read-only; it proposes corrections, never writes.
7. **Epilogue Agent** — one-shot, at season failure/victory: writes the ~5-paragraph ending from `WorldState` (who won, what happened to the cast, faction control, player status/corruption) and proposes the post-victory path options.
8. **Choices Agent** — optional CYOA pass after each assistant turn; returns 2–6 context-appropriate choice labels (up to the configured 100-character cap) tagged by intent/tone, using the configured theme and content mix. Never writes state and never posts to chat itself.
9. **Bad End Detector** — opt-in, runs after the State/Storyline tracker; deterministic predicates first, LLM confirmation only for ambiguous cases. On confirmation it emits a `RECORD_BAD_END` event plus the epilogue text. Never deletes or resurrects a character.

Cadence is configurable; default = State Tracker every assistant turn, Storyline every 6 turns or on location change, Cast Director on scene change, Lore Agent every 10 turns.

### 5. Context injection

- One `generate_interceptor` (manifest) renders, in priority order: `[NEOTERRA_SCENE]` → `[NEOTERRA_CAST]` → `[NEOTERRA_PLAYER]` → `[NEOTERRA_WORLD]` (factions/threats/headlines) → `[NEOTERRA_CONTINUITY]` (bad ends, ending flags, post-victory arc) → `[NEOTERRA_LORE]`.
- A budget manager estimates tokens and truncates from lowest priority; each block has its own cap and an on/off toggle. Nothing is injected twice.
- **Content gate (optional, off by default):** a configurable reducer applied at render time to every block and to tracker prompts. Levels: `full` (default), `reduced` (fade-to-black for explicit sex, softened violence), `mature-only` (violence allowed, explicit sex minimized), `strict` (no explicit content, plot-focused). Per-character hard limits and per-player limits are layered on top and are always enforced, even when the global gate is off. The gate is enforced in `src/core/content-gate.js` and also caps what trackers may write (no new explicit acts in reduced/strict modes).
- Do **not** use `setExtensionPrompt` for these blocks to avoid the double-injection landmine.
- World book entries handle static, keyword-triggered depth (locations, factions, base profiles).

### 6. Map

- **Implementation:** Leaflet with `L.CRS.Simple`, `imageOverlay('NeoTerra.png')`, standard pan/zoom, marker clustering optional. Use only Leaflet's public API.
- **Vendored Leaflet, explained:** Leaflet normally arrives via a CDN, a bundler, or a global `L` from another extension. All three are bad fits here: CDN breaks offline/private installs, a bundler adds a build step to a repo that must load directly as a third-party extension, and borrowing another extension's global `L` creates a hidden dependency. Instead we copy Leaflet's `dist/leaflet.js`, `dist/leaflet.css`, and `dist/images/*` into `vendor/leaflet/`, pin the exact version already proven in `silly-teyvat-dist`, and keep `vendor/leaflet/LICENSE` + `vendor/leaflet/VERSION`. The extension then injects those local assets itself, so the map works with no network, no npm install, and no other extension installed. We never patch the vendored files; upgrades are a deliberate copy-and-diff.
- **Fallback if vendoring is rejected:** a minimal SVG/canvas pan-zoom image viewer is feasible for the base map, but Leaflet is preferred for marker/tooltip ergonomics and touch support. This is a fallback, not the plan.
- **Node model:** `{ id, name, description, x, y, district, kind, factionId, capacity, defaultStatus, tags[] }` in `data/locations.json`, pixel coordinates on the 2017×1512 image.
- **Interaction:** click node → submenu (name, description, present characters, status, faction control, "Travel"). Travel disabled while `scene.combat` exists or `inCombat`.
- **Travel flow:** validate adjacency/allowed travel → advance time → run Storyline Tracker with `{type:'travel'}` → update character/location state → generate a location intro through the narrator → optionally introduce present characters.
- **Top overlay:** active factions + goals, main threat(s) with progress meters, latest actions, optional newspaper headlines.
- **Editability:** node add/edit/delete and "reset to default" persisted per chat (overrides) with a global default export. Optional fog-of-war for undiscovered nodes.

### 7. Combat

- Deterministic **conflict resolution**, not HP attrition: `d20 + attribute + skill + situational` vs a target/defense, yielding tiers (`critical fail / fail / partial / success / critical`). Outcomes apply `stamina`/`willpower`/status/corruption deltas and a narration contract. No damage numbers in prose.
- Standalone: own seedable RNG, own dice function tool via `ctx.registerFunctionTool`, and an owned `/neoterra-roll` slash command. No dependency on Combat-Multihog at runtime; its implementation is reference only. The resolver is pure and unit-testable in Node.
- The model may describe, but may not decide, the outcome. `[NEOTERRA_COMBAT]` block restrains it during conflict.

### 7.5 Villain victory, epilogue, and post-victory play

- **Trigger:** the season's `finalDeadline` passes (or the main threat reaches its terminal stage). The ending fires **once** per season timeline; `ending.status` makes it idempotent across reloads and swipes.
- **Epilogue:** the Epilogue Agent writes a default **~5-paragraph** epilogue (configurable 3–8) grounded in `WorldState`: which threat won and how, the fates of major cast, faction control of locations, the player's status (free/captured/corrupted/brainwashed), and the state of the city. It is prose only; it does not decide the player's next move.
- **Choice screen:** after the epilogue, the player picks a continuation:
  1. **Resistance** — continue as an underground movement against the victor: reduced resources, hidden bases, sabotage/recruitment goals, new resistance beats.
  2. **Join the villain** — serve the victor: defeat the resistance, govern captured districts, conquer neighbouring districts/cities, or act as a brainwashed enforcer/consort. Availability is state-aware: always offered to villain-POV or corrupted/brainwashed players; offered to heroes when coercion, a relationship, or a deal makes it plausible.
  3. **End here** — stop at the epilogue; the world remains viewable in the journal/codex.
- **Post-victory state:** both continuations set `arc: 'post-victory'`, rewrite factions/threats (the victor becomes the establishment; the resistance or the next conquest target becomes the new threat), reassign cast locations/statuses, and generate a fresh set of `postVictoryBeats` with their own deadlines. The same Canon Beat Ledger machinery is reused.
- **Conquest:** "conquer other places" is modeled as a `conquest` track with target districts/cities added to the location registry, an occupation state per location, and a final "world domination" arc goal. Brainwashed/corrupted players get villain-side labels and goals automatically.
- **Continuity:** the epilogue and the chosen path are appended to `recentEvents` and the journal; the original season's beats are frozen (`closed`). No ending text is regenerated unless the user explicitly asks for a rewrite.

### 7.6 Optional CYOA choices mode

- **Off by default.** When enabled, after each assistant message the Choices Agent reads the last few messages + `WorldState` and returns 2–6 choices (default **4**) with `{ label, intent, tone, risk }`.
- **Rendering:** a compact chip row above the input. Clicking a chip sends exactly that choice as the player's message through ST's normal send path, then hides the row. A "write my own" affordance is always available and never removed. A regenerate button requests a fresh set.
- **Customisation:** count, label length (**up to 100 characters**), theme, and content mix. Themes: `auto` (default), `heroic`, `villainous`, `romantic`, `noir`, `comedic`, `tactical`, `lewd`. Content mix weights: action, dialogue, romance, investigation, travel, lewd. The default `auto` theme is derived from season tone + scene + player role, so S1Dark gets villain-flavoured choices without configuration.
- **Combat choices are a second setting:** `cyoa.combatChoices` has its own enable toggle, count, theme (`tactical` by default), content mix, and prompt override. It applies only while `scene.combat` is active and is independent of the exploration choice row. Both must be enabled (global CYOA + combat choices) for tactical chips to appear. Combat choices favour actions the engine can actually resolve (strike, grapple, defend, feint, use a skill, retreat, surrender, talk down) and show their risk tier from the resolver's vocabulary.
- **Guards:** generate only when the last message is from the assistant, generation is idle, and the ending screen is not active; never auto-generate immediately after a choice is sent (prevents a loop); cache per message **and per swipe**; content gate and per-player/per-character limits filter the generated set; a malformed/failed agent response simply hides the row.
- **No state writes:** choices are suggestions only. The chosen text becomes ordinary player input, and the normal trackers process it.
- **Standalone:** own UI, own prompt, no dependency on another extension's choice bar.

### 8. Extensibility

- Everything season-specific is data: `seasons/*.json`, `locations.json`, `factions.json`, `form-groups.json`, `form-rules.json`.
- `tools/build-data.mjs` regenerates `data/characters/index.json` from `Chars/` plus `data/characters/overrides.json`; `--check` fails CI on schema drift.
- Add a season by dropping a folder and one season JSON; add characters by dropping cards and re-running the tool. A drag-drop importer is a V1.1 stretch.
- **Map coordinate authoring:** coordinates are authored manually, but the plan includes an implementation-time spike to accelerate this with a multimodal model: a dev-only script crops `NeoTerra.png` into labeled tiles, asks a vision-capable **DeepSeek** model to locate named landmarks and propose pixel coordinates, and emits a draft `locations.json`. **Every proposed coordinate is human-verified before commit**; the script is a dev tool, never a runtime dependency. Fallback is a click-to-place node editor in the map panel (Steps 13/15).
- **S5 forward compatibility:** `tools/build-data.mjs` and the season loader must accept `NeoTerra-Season5(EnvyArc)Auxiliary.json` as an auxiliary book without treating it as a playable season. A real S5 later needs only a folder + season JSON.

## File Layout (target)

```
NeoTerra-Framework/
  manifest.json
  index.js
  style.css
  package.json
  README.md
  LICENSE
  CHANGELOG.md
  .gitignore
  NeoTerra.png
  data/
    characters/index.json
    characters/overrides.json
    seasons/{s1,s1dark,s2,s3,s4,sandbox}.json
    seasons/s5.aux.json            # metadata only; not playable in V1
    locations.json
    factions.json
    form-groups.json
    form-rules.json
    schemas/*.schema.json
  tools/{build-data.mjs,map-coords.mjs}
  vendor/leaflet/{leaflet.js,leaflet.css,images/*,LICENSE,VERSION}
  src/
    core/{constants,settings,defaults,migrations,logger,events,chat-affinity,wal,content-gate}.js
    data/{registry,forms,seasons,locations,factions,beats,schema}.js
    state/{world-state,reducer,store,selectors,migrations}.js
    agents/{client,runner,prompts,architect,storyline,state-tracker,cast-director,lore,auditor,epilogue,choices,bad-end}.js
    context/{renderer,budget,interceptor,worldbook}.js
    flows/{season-start,travel,scene,initiative,ending,bad-end}.js
    combat/{resolver,combat-state,outcome}.js
    ui/{shell,season-menu,map,map-panel,overlay,codex,player-panel,agent-log,ending,bad-end,choices,settings.html,settings.js,theme.css}
  tests/
    fixtures/...
    *.test.js
  plans/neoterra-framework-v1.md
```

## Steps

> **Conventions:** every step is one reviewable PR. `Route` names the implementer tier and effort. `Depends on` lists step numbers. `Parallelizable` means it can run concurrently with the listed steps once dependencies are met. All paths are relative to the repo root.

### Progress
- [x] Step 1 — Extension scaffold, settings, slash command, shell placeholder — `b6a45b0`
- [x] Step 2 — Data ingestion pipeline and character/form registry — `0a2ed16`
- [x] Step 3 — Season, faction, and location definitions — `4410d5c`
- [x] Step 4 — `WorldState` schema, store, reducer, migrations — `ea24a59`
- [x] Step 5 — Shared agent client, runner, and JSON contracts — `337e668`
- [ ] Step 6 — Context renderer, token budget, and interceptor
- [ ] Step 7 — Season menu and deterministic world construction
- [ ] Step 8 — Cast Director, world-book materialization, and form exclusivity
- [ ] Step 9 — Storyline Tracker agent and Canon Beat Ledger
- [ ] Step 10 — Player State Tracker and player panel
- [ ] Step 11 — Bad-end states and continuation (opt-in)
- [ ] Step 12 — Lore Agent, relationships, and lorebook writes
- [ ] Step 13 — City map component and location submenu
- [ ] Step 14 — Travel flow and location intro
- [ ] Step 15 — World overlay: factions, threats, headlines, node editor
- [ ] Step 16 — Villain-victory epilogue and post-victory play
- [ ] Step 17 — Optional CYOA choices mode (exploration + tactical combat)
- [ ] Step 18 — Character Codex, settings surface, and theme polish
- [ ] Step 19 — Dice-based conflict resolver and combat integration
- [ ] Step 20 — Extensibility tooling, import/export, docs, and release QA

### Step 1 — Extension scaffold, settings, slash command, shell placeholder
- **Files:** `manifest.json`, `index.js`, `package.json`, `style.css`, `src/core/{constants,settings,defaults,migrations,logger,events}.js`, `src/ui/{shell.js,settings.html,settings.js,theme.css}`, `tests/settings.test.js`
- **Depends on:** none
- **Parallelizable:** with Step 2
- **Expected behavior:** ST loads the extension; a top-right button and `/neoterra` open a themed shell with empty tabs (Season, Map, Characters, Player, Settings). Settings persist in `extensionSettings.neoterra` with defaults, a schema version, and migration-on-read. Unknown keys are preserved. Defaults include `contentGate: 'full'` (off), `castMode: 'director'`, `cyoa: { enabled: false, count: 4, theme: 'auto', maxLabelLength: 100, combatChoices: { enabled: false, count: 4, theme: 'tactical' } }`, `badEnds: { enabled: false, allowDeadContinuation: false, prompt: <default> }`, per-agent cadence, and token budgets. `window.NeoTerra` exposes a tiny debug API.
- **Acceptance criteria:** extension appears in ST's extension list; reload preserves settings; toggling enable/disable cleanly mounts/unmounts via `hooks`; no console errors; settings test passes; `manifest.json` validates `display_name`, `version`, `js`, `css`, `loading_order`, `minimum_client_version: "1.19.0"`, `homePage: "https://github.com/Setofnosets/NeoTerra-Framework"`, and `auto_update: false`; a fresh install writes defaults once and does not overwrite user values.
- **Risk:** low
- **Route:** standard implementer, low effort
- **Commit sketch:** `feat(core): scaffold Neo Terra extension, settings, and shell`

### Step 2 — Data ingestion pipeline and character/form registry
- **Files:** `tools/build-data.mjs`, `data/characters/overrides.json`, `data/characters/index.json` (generated), `data/form-groups.json`, `data/form-rules.json`, `src/data/{registry,forms,schema}.js`, `tests/registry.test.js`, `tests/fixtures/*`
- **Depends on:** Step 1 (package.json/test harness)
- **Parallelizable:** with Steps 3, 4
- **Expected behavior:** the tool reads `Chars/S*/*.json` and `Chars/Others/*.json`, reads `data.*` (never the legacy top-level block), and emits a stable registry: `{ id, file, seasonId, dataName, displayName, aliases[], side, threatLevel, formRole, altOf, formKind, formGroup, tags[], cardPath }`. **IDs are stable and season-scoped:** `id = '<seasonId>.<slug>'` (e.g. `s1dark.carol.bleeding-heart`, `s2.leila.renya`), so the same name in different seasons is a different character entry. Filename parentheses are parsed into `formKind` (`base|corrupted|cleansed|treated|infected|coldhearted|knighted|poisoned|alt-version`). `overrides.json` fixes typos, multi-alt groups, multi-actor cards, and ambiguous sides. Form groups encode "exactly one active". `form-rules.json` encodes legal transformations and reversals. `--check` exits non-zero if any card fails to parse or an alt has no base.
- **Acceptance criteria:** registry covers all 66 season cards and 4 Others cards; every `altOf` resolves; every form group has exactly one `base`; the five known filename defects are corrected by overrides; `node tools/build-data.mjs --check` is clean; tests assert counts per season and form-group exclusivity.
- **Risk:** medium (data is inconsistent; misclassification poisons every later step)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(data): build character/form registry from Chars`

### Step 3 — Season, faction, and location definitions
- **Files:** `data/seasons/{s1,s1dark,s2,s3,s4,sandbox}.json`, `data/seasons/s5.aux.json`, `data/factions.json`, `data/locations.json`, `src/data/{seasons,locations,factions,beats}.js`, `data/schemas/season.schema.json`, `data/schemas/beat.schema.json`, `tools/map-coords.mjs` (spike), `tests/seasons.test.js`
- **Depends on:** Step 2 (character IDs)
- **Parallelizable:** with Step 4
- **Expected behavior:** each season JSON declares `id`, `title`, `era`, `anchorDate`, `premise`, `toneNotes`, `playerRole`, `defaultPlayerCharacterId?`, `roster[]` (character IDs + active forms at start), `factions[]` with goals and influence, `threats[]` with agenda/stages/progress, `startLocationId`, `openingBeats[]`, `canonBeats[]` with soft deadlines and consequences, `finalDeadline` + `failureState: 'villain-victory'` (see 2.5), `manualOnly[]`, `altFormsAllowed[]`. Locations declare pixel coordinates on 2017×1512, kind, district, controlling faction, capacity, default description/status. Node positions are authored manually; optionally run the dev-only DeepSeek multimodal spike (`tools/map-coords.mjs`) to draft coordinates, then human-verify every proposal before commit. Sandbox uses the base world with no threats and no canon beats. `s1dark` sets `playerRole: 'villain'` and `defaultPlayerCharacterId: s1dark.carol.bleeding-heart`. `s5.aux` describes the auxiliary book, is marked `playable: false`, and is excluded from the entry menu except as a disabled notice.
- **Acceptance criteria:** all six playable entries validate; S5 aux parses and is rejected with a clear "not yet playable" message; every roster ID exists in the registry; every referenced faction/location/threat/beat ID resolves; location coordinates fall inside the image; tests assert S4 has ≥2 main threats, S1Dark is `alt: true` + villain POV + Carol default, every season has at least one beat per act, every beat has a deadline consequence, and every playable season has a `finalDeadline`/`failureState`.
- **Risk:** medium (authored content; wrong coordinates/threats are cheap to fix but visible)
- **Route:** standard implementer, medium effort (content authoring assisted by the explore findings)
- **Commit sketch:** `feat(data): author season, faction, and map-node definitions`

### Step 4 — `WorldState` schema, store, reducer, migrations
- **Files:** `src/state/{world-state,reducer,store,selectors,migrations}.js`, `data/schemas/world-state.schema.json`, `tests/world-state.test.js`, `tests/reducer.test.js`
- **Depends on:** Steps 1–3
- **Parallelizable:** with Step 5
- **Expected behavior:** create/validate/migrate a `WorldState`; seed from a season definition deterministically (including `playerRole`, `player.identity`, `controlledBy`, and open canon beats); apply typed events (`SET_LOCATION`, `MOVE_CHARACTER`, `TRANSFORM`, `SET_STATUS`, `ADVANCE_THREAT`, `TICK_TIME`, `RELATIONSHIP_DELTA`, `ADD_EVENT`, `RESOLVE_BEAT`, `ADAPT_BEAT`, `DEFER_BEAT`, `SET_PLAYER_IDENTITY`, `TRIGGER_ENDING`, `CHOOSE_ENDING_PATH`, `SET_ARC`, `RECORD_BAD_END`, `REVERSE_BAD_END`, `COMBAT_START/END`, `SET_PLAYER_STAT`); persist per-chat with debounce; snapshot per swipe; restore snapshot on swipe rollback; localStorage WAL for crash safety. Selectors produce present-cast, NPC pool, location, faction, threat, beat, and player views.
- **Acceptance criteria:** round-trip save/load through a mocked metadata object; migration from an empty state produces a valid seed for every season; reducer is pure (same events → same state); unknown events are rejected, not silently applied; swipe rollback restores exact prior state; `SET_PLAYER_IDENTITY` atomically flips `controlledBy` on the old and new character and preserves their state; beat status transitions are monotonic (`open → resolved|adapted|short-circuited`, no reopen without an explicit event); `TRIGGER_ENDING` is idempotent (second call is a no-op) and `CHOOSE_ENDING_PATH` validates the path against state-aware availability; `RECORD_BAD_END` is idempotent per character/continuity key, and `REVERSE_BAD_END` preserves the historical record while updating status; tests cover transform exclusivity, threat clamping, identity switching, ending idempotency, arc transitions, bad-end idempotency, and reversal.
- **Risk:** medium
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(state): add WorldState document, reducer, and per-chat persistence`

### Step 5 — Shared agent client, runner, and JSON contracts
- **Files:** `src/agents/{client,runner,prompts}.js`, `src/core/chat-affinity.js`, `src/ui/agent-log.js`, `tests/agent-runner.test.js`
- **Depends on:** Steps 1, 4
- **Parallelizable:** with Step 6
- **Expected behavior:** one request path (Connection Manager profile → main connection → `generateRaw({trimNames:false})`), per-agent model/prompt/temperature settings, strict JSON extraction (fences, leading prose, trailing text), schema validation, one repair attempt, timeout/abort, and a chat-affinity guard. Every call is logged to an agent terminal with request/response/validation status. Agents cannot write state directly.
- **Acceptance criteria:** fixture responses parse correctly for all edge shapes; schema-invalid response triggers exactly one repair then a clean failure; changing chat mid-pass aborts and logs; no agent call blocks the UI thread; tests cover parser, retry, abort, and routing fallback.
- **Risk:** medium (LLM output is unreliable; the contract must be strict)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(agents): add shared LLM client, JSON contracts, and agent log`

### Step 6 — Context renderer, token budget, and interceptor
- **Files:** `src/context/{renderer,budget,interceptor,worldbook}.js`, `src/core/content-gate.js`, `tests/context.test.js`, `tests/content-gate.test.js`
- **Depends on:** Steps 1, 4
- **Parallelizable:** with Step 5
- **Expected behavior:** `renderContext(state, options)` produces the six blocks with stable headings; the budget manager estimates tokens, enforces per-block caps, and truncates lowest-privilege content first; the manifest `generate_interceptor` appends exactly once. Toggles and caps are configurable. Character profiles are trimmed to a configurable character budget; full profiles stay out of context. `applyContentGate(text, level, limits)` is applied to every rendered block and every agent prompt; `full` is a no-op (default), and per-character/per-player hard limits always apply. In `reduced`/`strict` modes the gate also suppresses explicit-act instructions and instructs agents not to record new explicit acts.
- **Acceptance criteria:** snapshot tests for each block; no duplicate injection when both settings and manifest are active; budget never exceeds the configured ceiling in fixtures; empty state renders no empty headings; interceptor is idempotent within one generation; gate tests assert `full` is byte-identical, each level transforms fixtures deterministically, and hard limits win over the global level.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(context): render budgeted Neo Terra prompt blocks via interceptor`

### Step 7 — Season menu and deterministic world construction
- **Files:** `src/ui/season-menu.js`, `src/flows/season-start.js`, `src/flows/scene.js`, `tests/season-start.test.js`
- **Depends on:** Steps 3, 4, 6
- **Parallelizable:** with Step 8
- **Expected behavior:** season cards show title, era, premise, player role (Hero/Villain POV), main threat(s), cast count, and a content notice; S1Dark shows "Play as Bleeding Heart" and S5 shows a disabled "coming later" state. Selecting one asks for confirmation if a world already exists in this chat, then presents the identity step: **custom persona** or **play as a canon character** (season default preselected where defined). It seeds `WorldState`, links/generates the season world book placeholder, selects or creates the Director card (default), or the played canon card when `castMode: 'solo'` is chosen, and writes the opening scene from the chosen POV. "Character-first" filters the season list by character and uses that character as the opening focus. "Sandbox" seeds the base world with no threats or beats.
- **Acceptance criteria:** each season produces a schema-valid state with correct roster, active forms, faction influence, start location, player role, and open beats; S1Dark seeds with `player.characterId = 's1dark.carol.bleeding-heart'` and no duplicate Carol NPC; playing as a canon character removes them from the NPC pool and from group-chat speaker selection; a non-roster/manual character in Sandbox shows the persistent "non-canon" warning and disables canon beats; re-entry does not duplicate state; a cancel leaves the existing state untouched; opening scene names the correct era, location, and POV; tests cover all six playable entries, identity choice, non-canon warning, S5 rejection, and cancel/resume.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(flow): add season selection and world construction`

### Step 8 — Cast Director, world-book materialization, and form exclusivity
- **Files:** `src/agents/cast-director.js`, `src/context/worldbook.js`, `src/data/forms.js` (extend), `src/flows/scene.js` (extend), `tests/cast-director.test.js`
- **Depends on:** Steps 4, 5, 7
- **Parallelizable:** with Steps 9, 10
- **Expected behavior:** materialize a chat-scoped world book (`Neo Terra — <season> — <chat>`) from the roster with trimmed profiles, deduplicated blanket entries, and correct ST entry shape; link it to the chat (verify the exact ST API against a live instance before coding; fall back to a named world book plus `ctx.loadWorldInfo`/`saveWorldInfo`). The Cast Director runs on scene change: deterministic residents/threats first, then a JSON pass for arrivals/departures/offscreen moves. `controlledBy: 'player'` characters are excluded from NPC selection and from auto-generated entrances. Form exclusivity is enforced both in the state reducer and in the cast selection. Manual add/remove overrides work. Materialized book cleanup on world reset.
- **Acceptance criteria:** world book contains one entry per roster character with no duplicate "Neo Terra" blob; the played canon character has no NPC entry; exactly one active form per form group at all times; director never surfaces a character not in the allowed pool; offscreen characters are moved, not duplicated; manual pinning persists across turns; tests cover exclusivity, dedupe, pool filtering, and player exclusion.
- **Risk:** high (ST world-info API and chat linking are the least verified surface)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(cast): materialize season world book and add cast director`

### Step 9 — Storyline Tracker agent and Canon Beat Ledger
- **Files:** `src/agents/{storyline,architect,auditor}.js`, `src/data/beats.js`, `src/flows/initiative.js`, `src/flows/travel.js` (initiative hook), `tests/storyline.test.js`, `tests/beats.test.js`
- **Depends on:** Steps 4, 5, 8
- **Parallelizable:** with Step 10
- **Expected behavior:** the Architect enriches the seeded world at season start (placements, agendas, initial headlines, act framing). The Storyline Tracker runs every N turns / on location change / on major beat and returns events for: faction influence, threat stage/progress, active characters and goals, locations/status, allegiances, headlines, scene framing, and **canon beats**. For beats it either resolves a satisfied predicate, emits a setup nudge for the next eligible beat, or marks a beat `deferred`/`adapted` with a reason. Adaptations record `adaptedFrom`/`adaptedTo`; impossible beats are `short-circuited` and the next act is re-planned. It can trigger a transformation only along a declared form rule. Progress is clamped and monotonic unless an event reverses it. Failures are logged and never corrupt state.
- **Acceptance criteria:** each run emits only schema-valid events; threat progress advances and clamps; transformations obey `form-rules.json`; a failed/aborted pass leaves state byte-identical; cadence settings are honored; replaying the event log reproduces the same state; tests include a multi-threat S4 case and beat cases for: on-schedule resolution, substitution after the canonical actor is dead/captured, early main-villain defeat (short-circuit + successor), a missed soft deadline that escalates per its consequence, the final deadline producing a recorded `villain-victory` ending, and a beat that is narrated but not recorded (auditor flags it).
- **Risk:** high
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(storyline): add world architect and storyline tracker`

### Step 10 — Player State Tracker and player panel
- **Files:** `src/agents/state-tracker.js`, `src/ui/player-panel.js`, `tests/state-tracker.test.js`
- **Depends on:** Steps 4, 5
- **Parallelizable:** with Steps 9, 12
- **Expected behavior:** every assistant turn, a cheap player-only agent extracts changes to stamina, willpower, status, skills used, outfit, corruption, injuries, and relationship deltas from the latest message. It tracks either the custom persona or the played canon character, and never writes NPC state. Player panel shows a modular sheet (portrait/name, stamina/willpower bars, status chips, skills, traits, allegiance, corruption, relationships, current form) and a "Playing as" badge. Manual edits are allowed and marked `manual` so the tracker does not overwrite them on the next pass. In villain-POV seasons the same sheet is used with villain-side labels.
- **Acceptance criteria:** tracker ignores off-screen text and never edits NPC state; switching identity moves the tracker target atomically; manual edits survive one tracker pass; stamina clamps at 0/max; a malformed response is discarded with no state change; panel reflects state without a reload; tests cover manual-edit precedence, custom persona, played canon, and villain-POV labeling.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(player): add player state tracker and modular sheet`

### Step 11 — Bad-end states and continuation (opt-in)
- **Files:** `src/agents/bad-end.js`, `src/flows/bad-end.js`, `src/ui/bad-end.js`, `src/state/reducer.js` (extend), `src/core/defaults.js` (extend), `src/ui/settings.js` (extend), `data/schemas/bad-end.schema.json`, `tests/bad-end.test.js`
- **Depends on:** Steps 4, 5, 9, 10
- **Parallelizable:** with Steps 12, 13
- **Expected behavior:** `badEnds.enabled` defaults to `false`; when off, no detection, storage, UI, or agent calls. When on, the Bad End Detector evaluates deterministic predicates first (`stamina <= 0` + lethal intent, `willpower <= 0` + capture, max corruption, completed brainwashing, permanent form rule, captivity with no escape) and only asks the LLM to confirm ambiguous cases. A confirmed state emits `RECORD_BAD_END` with `{ type, severity, cause, source, turn, locationId, playableAs, continuityKey, reversibility }` and stores a 1–3 paragraph epilogue once. UI shows the epilogue and a continuation choice: **continue as the bad-ended character** (state-permitting, or death only when `badEnds.allowDeadContinuation`), **continue as someone else** (eligible roster character or new custom persona), or **end here**. The record persists in `WorldState.badEnds`, the Codex badge, and the journal; it survives export/import and chat reloads. The detector prompt and epilogue instructions are editable with reset-to-default.
- **Acceptance criteria:** disabled mode makes zero agent calls and writes nothing; deterministic death and identity-loss cases record without an LLM call; ambiguous cases require confirmation and never record from prose alone; a record is written exactly once per character per continuity key and never silently deleted; continuing as the character preserves the altered state/goals/labels; continuing as someone else leaves the record, relationships, and journal intact; a declared reversal updates `reversibility`/status but keeps the historical record; the edited prompt persists across reloads; tests cover all six types, opt-in gate, idempotency, both continuation paths, death-continuation setting, reversal, and export/import round-trip.
- **Risk:** high (identity change, irreversible state, consistency)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(bad-ends): add opt-in bad-end tracking and continuation`

### Step 12 — Lore Agent, relationships, and lorebook writes
- **Files:** `src/agents/lore.js`, `src/context/worldbook.js` (extend), `src/state/selectors.js` (relationship selectors), `tests/lore.test.js`
- **Depends on:** Steps 4, 5, 8
- **Parallelizable:** with Steps 10, 11
- **Expected behavior:** every N turns the Lore Agent summarizes recent events into compact entries, decides which existing entries to inject, and proposes relationship updates (`likes`, `dislikes`, `attraction`, `rivalry`, `owner/servant`, `ally`). Commits go to a per-chat lorebook with the correct ST entry schema and stable IDs. Relationship state lives in `WorldState`; the prompt block renders only relationships involving present characters. Duplicate or near-duplicate entries are merged.
- **Acceptance criteria:** writes valid ST entries (keys/name/content/depth/insertion order); no duplicate event entries after a retry; relationship deltas are bounded and symmetric where required; injection selection respects the token budget; deleting/resetting the chat world removes its generated book entries; tests cover merge, schema, and budget selection.
- **Risk:** high (mutating shared ST world info)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(lore): add lore agent, relationship tracking, and world-book commits`

### Step 13 — City map component and location submenu
- **Files:** `src/ui/map.js`, `src/ui/map-panel.js`, `src/ui/shell.js` (extend), `src/core/machine.js`, `vendor/leaflet/{leaflet.js,leaflet.css,images/*,LICENSE,VERSION}`, `style.css`, `tests/map-model.test.js`
- **Depends on:** Steps 1, 3, 4
- **Parallelizable:** with Steps 9–12
- **Expected behavior:** top-right map button opens a floating panel with `NeoTerra.png` as a Leaflet `imageOverlay` on `CRS.Simple`; pan/zoom/reset; nodes from `locations.json` (plus per-chat overrides); click opens a submenu with name, description, present characters, status, controlling faction, and "Travel" (disabled during combat). Panel is draggable/resizable and remembers geometry in localStorage. Map state participates in a small state machine (`closed → open → location → travel`). Leaflet is loaded from the vendored local files (pinned to the `silly-teyvat-dist` version, `LICENSE` + `VERSION` retained), not from a CDN, npm, or another extension's global.
- **Acceptance criteria:** image fills correctly and nodes land on intended pixels; zoom limits and reset work; submenu reflects live state; travel is disabled the moment combat starts; no Leaflet internal APIs used; the map loads with DevTools offline mode and with no other extension installed; `vendor/leaflet/LICENSE` and `VERSION` are present and the CSS/images resolve locally; map model tests pass; panel works at 1080p and 1440p.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(map): add city map overlay with location nodes`

### Step 14 — Travel flow and location intro
- **Files:** `src/flows/travel.js`, `src/flows/scene.js` (extend), `src/agents/storyline.js` (travel event), `tests/travel.test.js`
- **Depends on:** Steps 9, 13
- **Parallelizable:** with Steps 15, 17
- **Expected behavior:** travel validates the destination, advances in-game time, moves the player, runs the Storyline Tracker with a travel event, recomputes present cast, updates location status, and generates a location intro through the narrator (optionally introducing present characters). Travel history is recorded on the message and in `recentEvents`. Combat blocks travel.
- **Acceptance criteria:** travel updates player/location/present cast atomically; a failed tracker pass still completes the move with a deterministic fallback; time advances consistently; combat blocks travel; intro names the correct location and cast; tests cover blocked, same-location, and cross-district travel.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(travel): add travel flow and location intro`

### Step 15 — World overlay: factions, threats, headlines, node editor
- **Files:** `src/ui/overlay.js`, `src/ui/map-panel.js` (extend), `src/ui/settings.js` (extend), `tests/overlay.test.js`
- **Depends on:** Steps 9, 13
- **Parallelizable:** with Steps 14, 17
- **Expected behavior:** a top overlay summarizes active factions and goals, main threat(s) with progress bars (supports 2+ in S4), current act, the next 1–2 canon beats as rumors/headlines, a divergence indicator, latest actions, and optional newspaper-style headlines. Node editor adds/edits/deletes nodes, supports click-to-place, and resets to defaults, persisted per chat with a global export. Threat progress uses stage labels, not raw numbers only. This overlay also doubles as the "where am I in the story" view.
- **Acceptance criteria:** S4 renders two independent threats; progress and beat status update within one tracker pass; adapted/short-circuited beats are visibly marked; reset restores `locations.json`; added nodes survive reload and appear in travel; headings fit without overflow; tests cover multi-threat, beat display, divergence, and reset.
- **Risk:** low–medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(map): add faction/threat overlay and node editor`

### Step 16 — Villain-victory epilogue and post-victory play
- **Files:** `src/flows/ending.js`, `src/agents/epilogue.js`, `src/ui/ending.js`, `data/seasons/*.json` (post-victory arcs/beats), `data/schemas/ending.schema.json`, `tests/ending.test.js`
- **Depends on:** Steps 4, 9, 10, 15
- **Parallelizable:** with Steps 14, 18
- **Expected behavior:** when the season's `finalDeadline` fires (or the main threat reaches its terminal stage), mark the season failed once and run the Epilogue Agent. The epilogue defaults to **~5 paragraphs** (configurable 3–8), grounded in `WorldState`: the victor, how they won, cast fates, faction/location control, and the player's status (free/captured/corrupted/brainwashed). Then show a choice screen: **Resistance**, **Join the villain**, or **End here**. Join is state-aware (always for villain/corrupted/brainwashed; plausible for coerced heroes) and opens goals such as defeating the resistance, governing captured districts, or conquering other districts/cities. Both continuations set `arc: 'post-victory'`, rewrite factions/threats/locations/cast, and generate `postVictoryBeats` with their own deadlines through the same beat ledger. The conquest track adds target locations with occupation states. The epilogue and path are appended to the journal and `recentEvents`. If the player already has a bad-end record, the ending respects it (e.g. a dead or mind-wiped player cannot choose Resistance without a declared reversal).
- **Acceptance criteria:** the ending fires exactly once across reloads and swipes; the default epilogue is 5 paragraphs and references at least the victor, the player's status, and two cast fates; the choice screen offers valid options for hero, coerced hero, and brainwashed/villain players; each path produces a schema-valid post-victory state with new beats and no orphaned threats; "End here" leaves the world viewable and inert; conquest targets update occupation state; tests cover trigger, idempotency, all three choices, state-aware availability, and a brainwashed join path.
- **Risk:** high (irreversible world rewrite + long-form prose)
- **Route:** implement-hard, high effort
- **Commit sketch:** `feat(ending): add villain-victory epilogue and post-victory arcs`

### Step 17 — Optional CYOA choices mode (exploration + tactical combat)
- **Files:** `src/agents/choices.js`, `src/ui/choices.js`, `src/ui/settings.js` (extend), `src/core/defaults.js` (extend), `tests/choices.test.js`
- **Depends on:** Steps 1, 4, 5, 6, 16 (ending suppression flag)
- **Parallelizable:** with Steps 18, 19
- **Expected behavior:** disabled by default. When enabled, after an assistant message the Choices Agent returns 2–6 choices (default **4**) from recent context + `WorldState`. A chip row appears above the input; clicking a chip sends exactly that text as the player's message, then hides the row. A regenerate button requests a new set; "write my own" is always available. Settings: count, label length **up to 100 characters** (default 100 max, configurable soft cap), theme (`auto` default, plus heroic/villainous/romantic/noir/comedic/tactical/lewd), content mix (action/dialogue/romance/investigation/travel/lewd), and a per-theme prompt override. `auto` derives tone from season + scene + player role. **Combat choices are a second, independent setting** (`cyoa.combatChoices`): own enable toggle, count, `tactical` theme default, content mix, and prompt override; it activates only while a conflict is running and both switches are on. Combat choices are constrained to actions the dice resolver understands (strike, defend, grapple, feint, skill, retreat, surrender, talk down) and display the resolver's risk tier. Guards: only after an assistant message, only while idle, never on the ending screen, no auto-run immediately after a choice, cache per message/swipe, filter through the content gate and limits, hide on failure.
- **Acceptance criteria:** disabled mode adds no buttons and makes no agent calls; default count is 4 and choices match the scene's context; clicking sends exactly once and does not re-trigger a choices pass; regenerate produces a different valid set; S1Dark `auto` yields villain-flavoured choices; content gate `strict` removes explicit options; per-swipe caches do not bleed; malformed agent output hides the row without an error toast; keyboard navigation works; tests cover parsing, click-send, loop guard, caching, gating, ending suppression, a 100-character label truncation/validation case, and the independent combat-choice setting (off/on, tactical vocabulary, resolver risk tiers, and suppression outside combat).
- **Risk:** medium (event loops, duplicate sends, generation cost)
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(cyoa): add optional context-aware choice buttons`

### Step 18 — Character Codex, settings surface, and theme polish
- **Files:** `src/ui/codex.js`, `src/ui/settings.js`, `src/ui/settings.html`, `src/ui/theme.css`, `style.css`, `tests/codex.test.js`
- **Depends on:** Steps 4, 8, 10, 11
- **Parallelizable:** with Steps 14, 15, 19
- **Expected behavior:** Codex lists season cast, searchable/filterable by side, form, location, and status, and marks the played character. A detail view shows live state, full profile, form lineage, relationships, a bad-end badge with the stored epilogue, and a "swap active form" control that obeys form rules. A **"Play as"** button switches the player identity to that canon character after a confirmation that explains the narration/POV change and the NPC-pool swap. Settings expose agent prompts/routing/cadence, token budgets, cast mode (Director/Group/Solo-swap), **beat deadline pressure** (off / generous / standard / harsh), the **CYOA mode** (off by default: count, theme, label length up to 100 chars, content mix) with a **separate combat-choices panel**, the **bad-end tracking** toggle with its editable prompt,, the **content gate** (off by default) with per-character and per-player limits, map editing, data import/export, and a reset. Visual pass unifies panels into a sleek futuristic theme with reduced-motion support.
- **Acceptance criteria:** codex reflects transformations and bad-end badges immediately; illegal form swaps are rejected with a reason; stored bad-end epilogues are read-only and persist across reloads; "Play as" lists only current-season roster characters (Sandbox: any registry character), shows the non-canon warning for manual/imported characters, swaps identity atomically, and is reversible; settings persist and validate; the content gate defaults to off and each level visibly changes rendered context; hard limits cannot be disabled by the global gate; deadline pressure defaults to `standard` and `off` disables escalation; reset requires confirmation and clears only this chat's world; keyboard navigation and focus trapping work in dialogs; no hardcoded colors outside theme tokens.
- **Risk:** low–medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `feat(ui): add character codex and complete settings/theme`

### Step 19 — Dice-based conflict resolver and combat integration
- **Files:** `src/combat/{resolver,combat-state,outcome}.js`, `src/agents/state-tracker.js` (combat deltas), `src/context/renderer.js` (combat block), `tests/combat.test.js`
- **Depends on:** Steps 4, 6, 10
- **Parallelizable:** with Step 18
- **Expected behavior:** start a conflict with participants, stakes, and intent; resolve actions with seeded `d20 + modifiers` into five outcome tiers; apply stamina/willpower/status/corruption deltas; produce a narration contract and a `[NEOTERRA_COMBAT]` override that forbids the narrator from deciding outcomes. No damage numbers, no HP. Fully standalone: own seedable RNG, own `registerFunctionTool` dice tool, own `/neoterra-roll` command. Player-controlled canon characters are valid combatants on either side. Exports the action/risk vocabulary consumed by the tactical CYOA setting (strike, defend, grapple, feint, skill, retreat, surrender, talk down).
- **Acceptance criteria:** the same seed and inputs always produce the same outcome; tiers map to bounded deltas; a conflict ends on stamina 0, surrender, or a round cap; the narrator block is present only while combat is active; travel is blocked; the extension runs identically with no other extension installed; tests cover seeds, tier boundaries, surrender, end conditions, and player-as-combatant.
- **Risk:** medium
- **Route:** implement-hard, medium effort
- **Commit sketch:** `feat(combat): add dice-based conflict resolution`

### Step 20 — Extensibility tooling, import/export, docs, and release QA
- **Files:** `tools/build-data.mjs` (harden), `tools/map-coords.mjs`, `src/ui/settings.js` (import/export), `README.md`, `LICENSE`, `CHANGELOG.md`, `.gitignore`, `docs/data-schema.md`, `docs/adding-a-season.md`, `docs/canon-beats.md`, `docs/endings.md`, `docs/bad-ends.md`, `docs/cyoa.md`, `tests/integration.test.js`, `package.json` (scripts)
- **Depends on:** all prior steps
- **Parallelizable:** no (final integration)
- **Expected behavior:** documented data schemas, an "add a season/character" guide, a canon-beat/deadline authoring guide, drag-drop card import with override generation, full world export/import as JSON, and a smoke-test script. `npm run check` runs data validation, syntax checks, and unit tests. Version bumped and changelog written. Repo is ready to publish to GitHub: **MIT `LICENSE`**, `homePage`/manifest pointing at `https://github.com/Setofnosets/NeoTerra-Framework`, README with third-party install steps (`ST/data/default-user/extensions/NeoTerra-Framework/`), no secrets or local absolute paths, `.gitignore` excludes build artifacts and local captures. Initial push targets `origin` (already configured).
- **Acceptance criteria:** a new season can be added using only docs + one JSON + cards and appears in the menu; import/export round-trips a world exactly; `npm run check` passes from a clean clone; README covers install, first run, canon beats/deadlines, the villain-victory ending, bad ends, CYOA mode, the content gate, and known limitations; S1–S4 plus Sandbox all boot in a live ST instance; `git ls-files` contains no absolute Windows paths or generated junk; the repo can be cloned into `third-party/` and loaded without edits.
- **Risk:** medium
- **Route:** standard implementer, medium effort
- **Commit sketch:** `chore(release): harden data tooling, add docs, and finalize V1`

## Verification & Testing

### Automated (exact commands)
```bash
# from the repo root
npm install                       # only if dev deps are added; runtime must stay dependency-free
node tools/build-data.mjs         # regenerate data/characters/index.json
node tools/build-data.mjs --check # fail on unparseable cards, dangling altOf, or invalid form groups
node --test tests/                # unit tests (Node's built-in test runner)
node --check index.js             # syntax check of the extension entry point
npm run check                     # aggregate: build-data --check + node --test + syntax checks
```
- Tests are plain ESM (`"type": "module"` in `package.json`); no browser test runner is required. UI logic is factored into pure modules (`map-model`, `renderer`, `reducer`) so it is testable in Node.
- Schema validation uses a tiny in-repo validator (no Ajv runtime dependency) or Ajv as a dev-only dependency.

### Manual checks (live SillyTavern)
1. Fresh install → button and `/neoterra` both open the shell; no duplicate UI after disable/enable.
2. Select each of S1, S1Dark, S2, S3, S4, Sandbox: correct premise, roster, start location, threat count (S4 = 2), and POV. S1Dark starts in villain POV with Carol/Bleeding Heart as the player; S5 shows "coming later" and refuses entry.
3. Identity: start a season as a custom persona, then use "Play as" on a canon character; confirm the character leaves the NPC pool and group-chat speaker selection, the narrator stops acting for them, and switching back restores the prior state. Repeat from the season card. In Sandbox, import/select a non-roster character and confirm the persistent "non-canon" warning and disabled canon beats.
4. Play 20 turns: state tracker never touches NPCs; storyline pass advances a threat; canon beat ledger resolves or adapts a beat and records it; no state corruption after two chat switches mid-pass.
5. Defeat the main villain early (or let a hero die) and verify the tracker short-circuits the affected beats, re-plans the next act, and records the divergence instead of railroading.
5b. Ignore a beat past its soft deadline: verify the declared consequence fires (threat progress/ally/location loss). Ignore every beat to the final deadline: verify the season ends in a recorded `villain-victory` with a journal entry and no crash.
5c. Trigger the villain victory: confirm the epilogue is ~5 paragraphs, names the victor/player status/cast fates, and fires once. Choose **Resistance** and verify a valid post-victory arc. Reset, trigger again, and choose **Join the villain** as a brainwashed/corrupted player: verify villain-side goals, resistance threat, and conquest targets. Confirm "End here" leaves the world inert but viewable.
5d. Enable bad ends. Force a player death and an NPC identity-loss: confirm the deterministic predicates fire, a 1–3 paragraph epilogue is stored, and the record appears in Codex/journal. Continue as the bad-ended character in the identity-loss case, then reload and confirm the altered goals/labels persist. Repeat with "continue as someone else" and confirm the old record remains. Disable bad ends and confirm no detection or records; edit the tracking prompt and confirm it survives reload.
6. Corrupt a hero through a declared rule: base form disappears from cast/codex, alt form appears, world-book injection swaps, and the pair never coexists.
7. Open map, travel to a node, verify time/state/cast/intro; start a conflict and confirm travel is disabled.
8. Toggle the content gate through each level and confirm rendered context and tracker output change; confirm `full` is a no-op and per-character hard limits still apply at `strict`.
8b. Enable CYOA: confirm 4 context-appropriate choices, labels respect the 100-character cap, click sends exactly once, regenerate gives a different set, S1Dark `auto` yields villain-flavoured choices, `strict` removes explicit options, and the ending screen suppresses the row. Enable the second combat-choices setting, start a conflict, and confirm tactical chips appear with resolver risk tiers and no exploration-style choices; end combat and confirm exploration choices return. Disable CYOA and confirm zero agent calls.
9. Reset the world: generated world book is removed and defaults restore.
10. Export → new chat → import: identical state, cast, and beat ledger.
11. Reload the browser mid-pass: no lost state, no duplicate events.
12. Standalone check: disable/remove Combat-Multihog and Silly Teyvat, repeat smoke tests 1–11 with no errors and no missing panels.

### Edge cases to exercise
- Card with an empty `mes_example` / `personality` / `scenario` (S4 modern cards).
- `Atropos couple` multi-character card (two characters in one file) — must not be auto-added as one character.
- One base with multiple mutually exclusive alts (S4 Gravitasha, S4 Claire, S1Dark Carol).
- S3 `Selina Cross-Umbra).json` and S4 `Ping Power` typos resolved through overrides.
- Season with a thin/empty lorebook (S4) — world construction must not depend on it.
- Token pressure with 22 S4 characters: only present cast injected; codex still complete.
- User manually edits player stats, then the tracker runs.
- Agent returns fenced JSON, prose-wrapped JSON, or invalid JSON.
- Chat switch and swipe during an in-flight agent pass.
- S1Dark villain POV: player is Carol; a hero captures *her*; the tracker must update her state without assuming hero-side goals.
- Player-as-canon character has alternate forms (e.g. Carol → Bleeding Heart, Claire → Ice Queen): form swaps are player-driven, legal-rule-only, and never auto-applied by the tracker.
- Canon beat whose canonical actor is already dead/captured/transformed at the time it becomes eligible.
- Season 5 auxiliary book present in the folder but no season selected.
- Content gate at `strict` while the season's premise is inherently explicit.
- Group chat with the played canon card present in the roster: it must be removed from speaker selection, not duplicated.
- Non-roster/manual character selected as the player in Sandbox: non-canon warning shown and canon beats disabled, not silently skipped.
- Every beat missed through the final deadline: `villain-victory` ending is recorded once (idempotent), remains playable/continued, and does not re-fire on reload.
- Villain victory while a conflict is active: combat is ended cleanly and the epilogue does not inherit stale combat blocks.
- Brainwashed/corrupted player chooses "Join the villain": goals and labels flip without contradicting stored relationship/status data.
- Post-victory conquest reaches a location not in the original map: it resolves through the location/override system, not a crash.
- CYOA generated while the model is still streaming, after a swipe, and immediately after a clicked choice: no duplicate rows, no double sends, no generation loop.
- CYOA with all choices filtered out by the content gate: row hides instead of rendering empty buttons.
- CYOA on a message with no assistant turn yet: no call.
- Combat choices enabled while exploration CYOA is off: no exploration chips, but tactical chips appear during combat (independent settings).
- Tactical CYOA offers an action the resolver cannot parse: it is dropped, not sent as an invalid command.
- Combat ends mid-choice-row: the tactical row is replaced by the exploration row or hidden; no stale combat action is sent.
- Bad ends disabled: a lethal scene occurs and no record/epilogue/UI appears.
- Player death with `allowDeadContinuation` off: "continue as the character" is unavailable; "someone else" and "end here" remain.
- Player identity-loss followed by a declared cleanse/reversal: the record persists but the status flips back; the epilogue is not silently deleted.
- Player continues as someone else while the bad-ended character was the prior POV: cast director and state tracker retarget atomically; no duplicate POV.
- Bad-end record exported, imported into a new chat, and reloaded: same record and epilogue, no duplicate.
- Editable bad-end prompt contains malformed template variables: falls back to default with a warning, does not crash the tracker.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ST world-info chat-linking API differs from assumptions | Cast injection breaks | Verify against a live ST instance in Step 8 before coding; fall back to named book + `loadWorldInfo`; keep the renderer able to inject cast blocks without the book |
| Alt-form mapping is wrong or incomplete | Canon-breaking casts; two forms coexist | Author `form-groups.json`/`overrides.json`, validate exclusivity in the reducer, fail loudly on unknown transformations |
| LLM agents return unusable JSON | Broken state updates | Strict schema, one repair retry, reject-and-log rather than mutate, deterministic fallbacks |
| Token bloat from 3–5 KB character descriptions | Context overflow, quality collapse | Trimmed live blocks + per-block budgets + codex for full profiles |
| Agent passes race chat changes / swipes | State written to the wrong chat | Chat-affinity guard, per-chat storage, per-swipe snapshots, WAL |
| Mutating shared world books | Pollutes other chats | Chat-scoped book names, cleanup on reset, never edit the user's imported books |
| Extension co-existence (other interceptors) | Duplicate/hidden blocks | One owned block set, explicit settings, document ordering; never import another extension's modules; verify alongside Combat-Multihog in QA |
| Canon beats feel railroaded, or are ignored | Player agency lost or canon evaporates | Beat ledger with flexible predicates, adaptation and short-circuit states; tracker may only nudge, never force outcomes; divergence is visible and recorded |
| Deadline escalation feels punishing or fires unexpectedly | Player frustration; bad-ending surprise | Soft deadlines only, default `standard`, declared consequence previewed in the overlay before it fires; `off` disables escalation; final `villain-victory` is announced in advance and recorded once, not a hidden fail state |
| Ending prose contradicts stored state or is regenerated repeatedly | Continuity break; token cost | Epilogue is grounded in a compact `WorldState` fact sheet, fires once, is cached per season timeline, and is only rewritten on explicit request |
| Post-victory arc leaves orphaned threats/characters | Broken world after the ending | `ending.js` rewrites the whole world atomically and validates against the schema; tests cover both paths and conquest targets |
| CYOA causes generation loops or duplicate sends | Runaway token use; double player messages | Only after assistant messages, idle guard, suppress-after-click flag, per-message/swipe cache, explicit click-to-send, integration test for exactly-once send |
| Bad-end records drift or are lost on POV switch | Character appears alive/duplicated; continuity break | Records live in `WorldState.badEnds` keyed by `continuityKey`, survive export/import, are never deleted on continuation, and are validated by the reducer |
| Bad-end detection fires from ambiguous prose | Premature death/identity loss | Deterministic predicates first; LLM only confirms ambiguous cases and cannot record without a predicate or explicit confirmation; opt-in prompt is editable |
| Player-as-canon narration bleed | Narrator writes the player's actions or duplicates them as an NPC | `controlledBy` flag enforced in cast selection, tracker, renderer, and combat; tests for exclusion; prompt explicitly forbids narrating player choices |
| Identity switch mid-season | State split or lost character | Atomic `SET_PLAYER_IDENTITY` event, snapshot/rollback, confirmation dialog, tests |
| Content gate bypass | Limits not respected | Gate applied at render *and* agent-prompt layer; hard limits always enforced; tests assert hard limits win |
| Scope creep into UI polish | Delays core loop | UI polish is Step 18; Steps 1–15 use functional, minimally styled panels |

## Out of Scope (V1)

- The `Others` / NeoHorizon setting (second version).
- Season 5 gameplay content. Only the auxiliary lorebook exists; V1 parses it, lists it as "coming later", and the data format accepts a real S5 without code changes.
- Full RPG combat with HP, damage numbers, and tactical grids.
- Automatic internet image fetching, card art generation, or avatar regeneration.
- Multi-user/session sync.
- A season-authoring visual editor (documented JSON + import only).
- Runtime hard dependencies on other extensions (including Combat-Multihog).
- Localization.

## Proposed Additions (optional; not required for V1)

Already folded into the design: **Continuity Auditor**, **content gate + per-character/per-player limits**, **Canon Beat Ledger**, **player-as-canon "Play as"**, **villain-victory ending + post-victory play**, **CYOA mode**, **bad-end states**, and the **multimodal map-coordinate spike**.

Still optional, in rough priority order:

1. **Off-screen world tick** — when in-game days pass, factions advance agendas even if the player ignores them. Makes the city feel alive and gives the map overlay a reason to change.
2. **Newspaper generator** — turns `recentEvents` into in-world headlines; doubles as a recap for returning players. (A lightweight version is already in the Step 15 overlay.)
3. **Pacing/Scene Director** — decides when to cut scenes, advance time, and introduce a threat beat so the model does not stall.
4. **Relationship graph UI** — visualizes alliances, corruption ownership, and attraction; useful for femdom allegiance play.
5. **Branch saves** — snapshot a season timeline and fork a "what-if" (the lorebook already frames the multiverse as canon-divergent).
6. **Fog of war on the map** — unknown locations unlock through play; rewards exploration.
7. **Recap-on-load** — a three-line "previously on Neo Terra" block generated from `recentEvents` when a chat is resumed.
8. **Villain-POV sensorium** — for S1Dark, a "domain" view of Wonderland, knight rosters, and corruption spread, since the player is the antagonist.

## Decisions (locked)

1. **Runtime format.** Pure frontend, ESM, no Node server plugin; use ST's own `/api/*` endpoints and `ctx.*`.
2. **Cast mode.** Director/Narrator + live cast injection is the default; group chat and solo hot-swap are settings.
3. **Player identity.** Custom persona by default; optional canon character via **"Play as"** in the season flow and Character Codex. Play-as is restricted to the **current season roster**; Sandbox permits any registry character, and non-roster/manual/imported characters show a persistent **"non-canon"** warning with canon beats disabled.
4. **Group chat.** The played canon card is **excluded from speaker selection**; it is never duplicated as an NPC.
5. **Canon.** General beats must happen "in some form"; early villain defeat, retargeted heroes, and adaptations are legal. Implemented as the **Canon Beat Ledger** (2.5).
6. **Beat pressure.** Soft deadlines with **escalating consequences** by default (`standard`), configurable to `off`/`generous`/`harsh`. The season-level final deadline produces a recorded **complete villain victory** ending, announced in advance and fired once.
7. **Identity switching.** Allowed at any time with confirmation and atomic state migration.
8. **Season 5.** Out of V1. `NeoTerra-Season5(EnvyArc)Auxiliary.json` is parsed/listed as "coming later"; the format accepts a real S5 without code changes.
9. **Alternate season.** `S1Dark` is the alternate season and is **player-as-villain**: player = Carol Fate / Bleeding Heart by default.
10. **`Others/`.** Out of V1.
11. **Card payload.** `data.*` is authoritative; the duplicated legacy top-level block is disposable.
12. **Map nodes.** Coordinates authored manually. Implementation-time spike drafts them with a vision-capable **DeepSeek** multimodal model, human-verified; click-to-place editor is the fallback. The spike is a dev tool only and never ships in the runtime path.
13. **Combat.** Standalone: own dice resolver, function tool, and `/neoterra-roll`; no runtime dependency on Combat-Multihog.
14. **Content.** Optional global gate reduces violence/explicitness, **disabled by default**, plus per-character and per-player limits.
15. **Distribution.** SillyTavern third-party install + public GitHub repo: **MIT**, `https://github.com/Setofnosets/NeoTerra-Framework.git` (already `origin`, currently private/empty), minimum ST **1.19.0**.
16. **Villain-victory ending.** A **~5-paragraph epilogue** describes the victor's win, then the player chooses **Resistance**, **Join the villain** (defeat the resistance, govern/conquer further places, serve as a brainwashed enforcer), or **End here**. Join/Resistance availability is state-aware; both rewrite the world into a post-victory arc with new beats.
17. **CYOA mode.** Optional and **off by default**. Default **4** context-derived choices; labels up to **100 characters**; customizable count, theme, label length, and content mix. Clicking sends the choice as the player's message. Themes include `auto`, heroic, villainous, romantic, noir, comedic, tactical, and lewd; `auto` derives tone from season/scene/role. **Combat choices are a second, independent setting** (see Decision 19).
18. **Bad ends.** Opt-in (`badEnds.enabled = false`), with an editable tracking prompt. Tracks death, identity loss, autonomy loss, permanent corruption, imprisonment, and retirement. Each bad end stores a short epilogue and a persistent record; the player may continue as the bad-ended character (when possible) or as someone else. Records survive reloads, exports, and reversals. `badEnds.allowDeadContinuation` ships **off** (current plan).
19. **Tactical/combat choices.** A second, independent CYOA setting that only applies while a conflict is active. It has its own enable toggle, count, theme (`tactical` by default), content mix, and prompt override, so normal exploration choices and combat choices can be configured separately. It is off unless both CYOA and the tactical setting are enabled.
20. **Vendored Leaflet.** "Vendored" means copying Leaflet's built and minified `leaflet.js`/`leaflet.css` plus its image assets into `vendor/leaflet/`, pinned to the version already proven in `silly-teyvat-dist`, with the upstream MIT license and a `VERSION` file retained. The extension then loads map assets locally: no CDN, no npm install, no network dependency at runtime, and no version drift when upstream changes. Overlay code uses only Leaflet's public API; the vendored copy is never edited.

## Open Questions & Implementation Details

No open questions. The plan is ready for approval to begin Step 1.

Remaining implementation details are fully specified by the decisions above:
- Map-coordinate spike uses a vision-capable **DeepSeek** model and is human-verified.
- Leaflet is vendored from `silly-teyvat-dist` with `LICENSE` + `VERSION`, no CDN/npm/global dependency.
- Combat choices are an independent CYOA setting (`cyoa.combatChoices`), off by default.
- `badEnds.allowDeadContinuation` ships off.
