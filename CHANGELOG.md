# Changelog

All notable changes to the Neo Terra Framework are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-11-19

**The Living World.** The experience audit's plan is implemented: a session
HUD, floating windows, scene cards, progress/toasts, a Journal, onboarding, and
the living-world agents. World mutations remain additive under `flags.*`; UI
state is split between `chatMetadata.neoterra.ui` (last tab), localStorage
(window geometry, avatar overrides), and settings.

### Added

- **Session HUD and windows** — a collapsible gameplay rail (hidden without a
  world) plus draggable/resizable Map, Codex, Relations, Journal, and agent-log
  windows with persisted geometry and full-screen mobile sheets.
- **Session Home and last-surface memory** — an existing world opens Session
  Home (season/act/time/location/player/threat/present cast, "Previously on")
  and the last tab per chat is restored. "New timeline" creates a new chat
  instead of replacing by default.
- **Scene cards and turn feedback** — structured location/time/POV/present
  headers with portraits, cinematic chat grouping, a staged "Director is
  updating" chip, and batched state-delta toasts.
- **Journal and recap** — deterministic world timeline plus the Lore recap, with
  filters, search, and Markdown export.
- **First-run wizard and command palette** — staged season/character/confirm
  onboarding with presets, and a keyboard-first gameplay palette.
- **Living-world agents** — Cast Director on travel/arrival and scene cadence,
  Lore on a 10-turn/act cadence feeding the Journal, the Auditor at act
  boundaries, the Bad End panel, an agent-log drawer, and an opt-in
  season-start Architect pass.
- **Content depth pilot** — two optional side beats each for S1/S1Dark, a
  deterministic downtime flow (Rest, Train, Patrol, Investigate, Socialize,
  Work) with a civilian-life event table, differentiated post-victory arcs, and
  season-specific deterministic epilogues. Dynamic ending prose stays behind
  `ending.dynamic` (off; review required).
- **QA** — `tests/experience-regression.test.js` and `docs/qa.md` covering the
  P0 fixes and the release checklist, including 390×844 mobile.

<!-- legacy V1.2 feature notes retained below -->

- **Portraits** - a generated `data/characters/avatars.json` manifest, a PNG
  card scanner (`npm run build:avatars`), per-user **Sync portraits**, a
  **Download manifest** merge path, and a resolver that prefers the manifest,
  then a sync override, then installed cards, then initials. Ambiguous short
  names never swap portraits.
- **PNG card ingestion** - `build-data` reads a PNG's embedded `chara`/`ccv3`
  chunk, pairs a JSON twin as `avatarPath`, and validates malformed PNGs.
- **Guest characters** - any registry character can guest in any playable
  season after a visible warning and mandatory acknowledgment. Guests record
  `flags.guestCharacter` and `canonMode: 'adapted'`; dependent beats adapt and
  the prompt gains a non-canon guest block. Sandbox is unchanged.
- **Portrait-first character picker** - a searchable, filterable picker with
  roster/guest sections, form lineage, and keyboard navigation.
- **Form profiles** - seeding stores every form's card profile; transforms swap
  appearance, attire, abilities, traits, likes, dislikes, goals, and notes while
  preserving resources, status, relationships, and manual edits.
- **Form Architect** - generates missing form profiles from the base card, form
  rule, season threats/factions, other cast, and the recent scene. Generated
  forms are stored in `flags.generatedForms`, badged in the Codex, editable,
  regeneratable, approvable, and exportable.
- **Cross-season form packs** - `Blazing Prism` can join the S1 Vaiva pack; the
  build reports ungrouped alternates and unreachable rules.

## [1.1.0] - 2026-11-18

**The Living City.** Six features over the existing `WorldState`; all state is
additive under `flags.*` and old chats migrate automatically.

### Added

- **World clock and time brake** — one slot per turn (five turns per day), real
  UTC date arithmetic, `meta.storyTurn` for beat deadlines, and a one-click
  top-bar brake that freezes date, story turns, the tick, the newspaper, and
  deadline escalation. Combat auto-holds; travel releases. `clock.enabled:false`
  restores V1.
- **Off-screen world tick** — deterministic faction/threat pacing from
  `data/agendas.json`, capped NPC movement along authored connections, and
  templated off-screen rumors. No LLM call. A held scene is a no-op.
- **Off-screen feed** — the world overlay shows recent city activity.
- **Pacing / Scene Director** — a pure analyzer (`ok`, `nudge`, `cut`,
  `stalled`) with an explicit, player-triggered cut that never moves the player;
  a Director card and `[NEOTERRA_PACING]`.
- **Newspaper** — opt-in editions with a deterministic builder, an optional
  `newspaper` agent, a reader modal with archive, `[NEOTERRA_NEWS]`, and
  `tabloid`/`broadsheet`/`underground` styles.
- **Fog of war** — per-chat exploration, `rumors`/`hard` modes, fog-gated
  travel with path discovery, masked detail panels, themed rendering, and
  editor reveal/reset.
- **Relations tab** — a deterministic SVG relationship graph with filters,
  legend, directed `owner/servant` edges, badges, and keyboard selection.
- **Domain sensorium** — a generic optional `domain` season block; S1Dark ships
  Wonderland with knights, court/corruption, territory, resistance, and a feed.
  A hidden-by-default Domain tab and `[NEOTERRA_DOMAIN]` for villain POV only.
- **Card profiles in the Codex** — appearance, attire, personality, speech,
  background, likes/dislikes/goals, abilities, occupation/faction/gear/weakness,
  per-form notes, and bundle actor profiles are read from
  `data/characters/profiles.json`. Sensitive sections are rendered only through
  `contentGate`/`contentLimits` at render time.
- **Profile backfill and seeding** — new seasons seed card text into empty
  character fields; existing chats get **Import card profile** and **Sync card
  profiles** actions. Both are idempotent and never overwrite a non-empty live
  value.

### Changed

- Beat `turnRange`/`deadlineTurns`/`finalDeadline.turns` now compare against
  `meta.storyTurn`. Existing chats migrate `storyTurn = turn`, so behavior is
  unchanged until a hold is used.
- The settings panel exposes every new toggle and token budget, including
  `map.showFogOfWar`.

### Fixed

- Date-based beat deadlines are now reachable because the clock advances the
  in-game date.

### Fixed

- **Canon identity selection** — picking a canon character in the season menu
  now reads the rendered `data-character-id`; every canon option (not only the
  season default) starts a season, and S1Dark/Sandbox/custom personas keep
  working. "Play as" from the Codex is unchanged.
- **"Open settings panel" did nothing visible** — the Settings tab now closes
  the shell, opens SillyTavern's Extensions drawer, expands and scrolls the
  Neo Terra panel, and never closes an already-open drawer. Missing hosts show
  a visible status message.
- **Map window was clipped** — the map tab fills the viewport, the floating
  panel uses the host height (no more 1080×396 clamp), drag/resize stay inside
  the host, and stale geometry from the old 1080×700 default is migrated.
- **The story never started in chat** — a successful season entry now posts an
  opening narrator frame plus a "your move" kickoff (goals, current situation),
  closes the shell, and focuses the input. Optional `kickoff.auto` (off by
  default) sends one editable player prompt through ST's normal send path on a
  fresh chat; it is suppressed when the chat already has story history.
- **Travel only changed the map** — a successful travel posts a
  `Location changed: X → Y` frame in the same chat (bridge display names
  included) with the deterministic intro and any encounter, attaches the
  travel record, refreshes the map, and requests CYOA for the new message.
  A rejected travel posts nothing and keeps the map open.
- **Encounters were invisible** — hostile arrivals are now detected
  deterministically (same-side villains are allies; neutrals never trigger;
  active combat suppresses detection), persisted as `scene.encounter`, narrated
  in the arrival frame, and rendered in `[NEOTERRA_SCENE]`. A small bar offers
  **Engage / Talk / Avoid**; Engage starts the deterministic combat flow with
  the player and hostile cast, while threat-only encounters keep Engage
  disabled. Active combat offers **Surrender / End**.
- **Trackers never ran on normal turns** — every genuinely new assistant
  message now ticks `meta.turn` once (swipes do not), runs the player State
  Tracker, advances the Storyline Tracker on its existing cadence, refreshes
  the present cast and map, and only then requests CYOA. Tracker failures are
  logged and never block the choices. The map and interaction runtimes share
  one per-chat `WorldState` store.
- **Dead map close button** — the map toolbar **×** now closes the shell
  through an `onClose` callback. `map.closeOnTravel` (default on) closes the
  shell after a successful travel.
- **Characters tab never mounted** — the Codex validated the global
  `form-rules.json` against the chat-scoped roster slice, so every season chat
  reported unresolved ids and painted "The character codex could not be
  mounted." Form rules now get the structural check only; registry-id
  resolution is opt-in for callers holding the complete registry. The failure
  reason is also exposed as `data-neoterra-codex-error`.
- **Every character profile was empty** — the Codex read only
  `WorldState.characters[id]`, which season start seeded empty. Card sections
  are now parsed at build time into `data/characters/profiles.json`; live
  non-empty values still win.

### Notes

- World state remains prompt-only: the generate interceptor renders it at
  `context.depth` and replaces its own copy on every generation; it is never
  written into `ctx.chat`.

## [1.0.0] — 2026-11-17

First public V1 release. Requires SillyTavern **1.19.0** or newer and has no
runtime dependency on any other extension.

### Added

- Season entry for S1, S1Dark, S2, S3, S4, and Sandbox, plus a disabled
  "coming later" card for the Season 5 auxiliary data.
- Deterministic `WorldState` construction, reducer, per-chat persistence,
  per-swipe snapshots, and a localStorage write-ahead log.
- Shared agent client/runner with strict JSON contracts, one repair attempt,
  chat-affinity aborts, and an agent terminal.
- Budgeted context blocks (`SCENE`, `CAST`, `PLAYER`, `WORLD`, `CONTINUITY`,
  `LORE`) rendered by one generate interceptor.
- Director/Narrator cast mode, chat-scoped world book materialization, form
  exclusivity, and optional group/solo modes.
- Storyline Tracker with the Canon Beat Ledger: adaptation, short-circuiting,
  soft deadlines, escalating consequences, and a recorded villain victory.
- Player state tracker and modular player sheet, including player-as-canon.
- Opt-in bad ends with deterministic predicates, stored epilogues, and
  continuation as the character, as someone else, or ending there.
- Lore agent, relationship tracking, and generated world-book entries.
- SVG map pipeline (`build-map`) extracting 36 districts, 12 bridges, and 22
  key locations into GeoJSON, with vendored Leaflet and a map/overlay editor.
- Travel over the bridge graph, location intros, faction/threat overlay, and
  per-chat map overrides.
- Villain-victory epilogue and post-victory arcs (resistance and join-villain,
  including conquest).
- Optional CYOA choices, with an independent tactical combat-choices setting.
- Character Codex with "Play as", form swapping, bad-end badges, and search.
- Dice-based conflict resolver with seeded RNG, bounded outcome tiers,
  `[NEOTERRA_COMBAT]`, `/neoterra-roll`, and a function tool.
- Data extensibility: dynamic season discovery through
  `data/seasons/index.json`, `build-data --check` season validation, and
  `build-map --check` generated-file drift detection.
- World export/import and drag-drop character-card override generation in the
  settings panel.
- Documentation for data schemas, adding a season, canon beats, endings, bad
  ends, CYOA, and map authoring.
- `npm run check` aggregate validation and the `tools/smoke-test.mjs` release
  smoke test.

### Notes

- The content gate defaults to `full` (off); per-character and per-player hard
  limits still apply.
- Bad ends and CYOA are opt-in and disabled by default.
- The `Others` / NeoHorizon setting and Season 5 gameplay are out of scope for
  V1.
