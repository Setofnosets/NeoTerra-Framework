# Changelog

All notable changes to the Neo Terra Framework are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

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
