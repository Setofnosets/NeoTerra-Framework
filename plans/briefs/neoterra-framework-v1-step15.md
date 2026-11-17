# Brief — neoterra-framework-v1 / Step 15

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 15 — World overlay: factions,
  threats, headlines, district/bridge editor.
- **Depends on (committed):** Steps 9 (beat helpers), 13 (map data + view model).
  Shares `src/data/map.js` with Step 14 (travel graph); the per-chat map layer
  introduced there is reused here.
- **Route:** standard implementer, executed by the build agent directly with a
  verification loop; no re-planning.
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies.

## Implemented behavior

### 1. `src/ui/overlay.js` (new) — the "where am I in the story" overlay
- Pure model + markup builders:
  - `renderFactionOverlay` — name, side, influence bar, goals, dominant chip.
  - `renderThreatOverlay` — every threat independently (S4's two mains plus a
    secondary), stage-labelled progress (`Stage 2/4 · Collapse · 55%`), agenda,
    source faction, defeated state.
  - `renderBeatOverlay` — next 1–2 canon beats as rumours, current act, and a
    divergence indicator listing adapted / short-circuited / deferred beats.
  - `renderHeadlines` — newspaper-style latest events with datelines.
  - `renderActivityOverlay` — latest activity per named location / key location.
  - `renderWorldOverlayMarkup` — act header + collapsible sections; empty state
    when no world exists.
- `escapeOverlayHtml` guards every interpolated value, including attributes.

### 2. `src/data/map.js` — overlay view model
- `buildThreatViews` (stage labels, clamped progress, deterministic order),
  `buildFactionViews` (goals/influence, hides disbanded by default),
  `buildBeatViews` (act, rumours, ledger, divergence), `buildHeadlineViews`.
- `buildRegionOverlayStyles` (faction tint + status dash) and
  `buildBridgeOverlayStyles` (open/contested/blocked/destroyed).
- `buildWorldOverlay({ state, season, viewModel, settings })` composes the model
  and honours the `map.*` overlay settings (showThreats, showFactions,
  showRumors, showHeadlines, showFactionTint, maxHeadlines).
- Region view model now merges chat > global > generated overrides for
  name/status/faction/district, so a captured district tints immediately.
- Chat-only virtual nodes are rendered as named locations.

### 3. `src/data/map.js` — override editing (authored + per-chat)
- `applyMapOverride`, `resetMapOverride` (keeps structural bindings:
  region `districtId`, key-location `locationId`), `deleteMapOverride`,
  `exportMapOverrides`, `parseMapOverrides` (fences tolerated, validated).
- `namedLocations` is a new optional layer; `validateMapOverrides` checks its
  status vocabulary (`MAP_LOCATION_STATUSES`, mirrored from the registry) and
  coordinate types.
- Per-chat helpers from Step 14 extend: `setChatMapOverride`,
  `removeChatMapOverride`, `resetChatMapOverrides`, `addChatVirtualNode`,
  `updateChatVirtualNode` (validates the canvas), `removeChatVirtualNode`.
- `data/map/overrides.json` gains the empty `namedLocations` layer.

### 4. `src/ui/overlay.js` — editor model
- `overrideTargetFor` maps every feature kind to its layer; regions/bridges/key
  locations also expose a chat layer/key.
- `buildEditorSchema` renders per-kind fields: name/description, parent district
  (regions/key locations), controlling faction, bridge status, named-location
  status/control/marker X/Y, and virtual-node connections.
- `editorValuesToPatch`, `validateEditorPatch` (enum/range/required checks),
  `applyEditorPatch`, `resetEditorOverride`, `deleteEditorOverride`.
- `renderMapEditor` — save/reset/delete, an **Apply to: this chat / every chat**
  scope choice, "per-chat overrides" count (arrays excluded), global
  export/import + "Reset this chat's map".
- `renderVirtualNodeForm` — name, X, Y, connections; rejects blank coordinates.

### 5. `src/ui/map-panel.js` (extend) — wiring
- Side panel renders: arrival intro (from Step 14), world overlay, feature
  submenu, editor, add-node form, counts.
- Selecting a feature builds its editor schema; save/reset/delete honour the
  scope radios:
  - **this chat** writes `WorldState.flags.map` (bridges/regions/key locations)
    and `WorldState.locations` status/control (named locations), and deletes
    chat-only virtual nodes via `removeChatVirtualNode`.
  - **every chat** edits the authored overrides document, stored in localStorage
    (`neoterra:map:overrides`) and exportable as `data/map/overrides.json`.
- Region/bridge layers re-tint/re-dash immediately after an edit;
  `EVENTS.MAP_UPDATED` keeps the panel and shell in sync.
- `getOverlay()`, `getSources()` exposed for the shell/host.

### 6. `src/ui/settings.html` + `src/core/defaults.js` + migrations
- New "Map overlay and editor" settings: showOverlay, showThreats,
  showFactions, showRumors, showHeadlines, showFactionTint, editorEnabled,
  maxHeadlines (1–20). Defaults are overlay/editor **on**; migration normalizes
  and clamps existing installs.

### 7. `style.css`
- Overlay sections, progress bars, chips, goals, rumour/divergence/headline
  lists, editor fields/scope fieldset, arrival intro; narrow-viewport rule.

## Verification
```bash
"/mnt/c/Program Files/nodejs/node.exe" tools/build-map.mjs --check   # 36/12/22, OK
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check  # registry clean
"/mnt/c/Program Files/nodejs/node.exe" --check index.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js        # 353 pass / 0 fail
```
New suite `tests/overlay.test.js` (27 tests): S4 dual threats, stage labels,
clamped progress, faction goals/hiding, act/rumour/divergence, headlines,
region tint + district-status override, bridge statuses, overlay counts and
section toggles, markup escaping/accessibility, every feature kind mapping,
editor schemas/fields, patch validation, global edit/export/import/reset/delete,
chat isolation, editor controls, 36/12/22 editability, named-location override
validation, settings defaults/migration, S1 act resolution.

## Notes / decisions
- **Scope:** presentation/assignment edits are global (authored overrides);
  timeline facts (bridge destroyed, district captured, marker moved, virtual
  node) are per chat. This is what keeps one chat's destroyed bridge out of
  another chat, per the plan.
- **Browser cannot write the repo file**, so global edits persist in
  localStorage and the editor exports the exact `data/map/overrides.json` shape.
- Named-location **status/control** is authored per chat in
  `WorldState.locations` (the storyline already writes it); the override layer
  only carries presentation and is a fallback.
- District status accepts an explicit override first, then falls back to the
  worst live status among its named locations.

## Out of scope
- Villain-victory epilogue and post-victory arcs (Step 16).
- CYOA choices (Step 17), codex/settings polish (Step 18), combat (Step 19).
