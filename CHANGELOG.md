# Changelog

All notable changes to the Neo Terra Framework are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Fixes grouped by the symptom they address. The underlying flow and state
contracts are described in [docs/scene-output.md](docs/scene-output.md).

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

### Notes

- Known issue: `EXTENSION_VERSION` is `0.1.0` while `package.json` and
  `manifest.json` are `1.0.0`. The shell footer/debug API show the constant.
  The manifest was left unchanged pending a compatibility check.
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
