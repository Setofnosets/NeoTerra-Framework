# Brief — neoterra-framework-v1 / Step 13

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 13.
- **Title:** SVG map pipeline and city map component.
- **Depends on (committed):** Steps 1, 3, 4 (Step 3 amendment already authored
  `districts.json`, `map/overrides.json`, and canonical 2048×1536 coordinates).
- **Route:** implement-hard (plan), executed by the build agent directly with a
  verification loop; no re-planning.
- **Node:** only `/mnt/c/Program Files/nodejs/node.exe` (v24.16.0); `node` is
  not on PATH.
- **Runtime rule:** dependency-free ESM, browser-safe. Leaflet is vendored, not
  an npm dependency. No data regeneration beyond `data/map/*` and the derived
  `regionId` column.

## Implemented behavior

### 1. `tools/build-map.mjs`
- Reads `NeoTerra.svg` plus the three single-layer exports, selecting layers by
  `inkscape:label` (**never** `sodipodi:docname` / `inkscape:export-filename`,
  which are cross-wired). Missing layer = hard error.
- Parses `ellipse`, `rect`, and `path` (absolute/relative `m l h v c s q t a z`,
  curves flattened, arcs approximated). Stars take `sodipodi:cx/cy`. Geometry is
  clamped to the 2048×1536 canvas (the Airport/MajorDockB art overhangs by a
  fraction of a pixel).
- Computes `bbox`, centroid (signed-area shoelace; winding-safe), `area`,
  `sourceColor`, and a coarse `kind` from the label prefix.
- Derives key-location → region by point-in-polygon, with a thresholded
  nearest-polygon fallback (threshold 130 canvas units); water polygons are
  never bridge endpoints. Bridge endpoints come from the farthest point pair of
  the sliver; `connects`, `centerline`, `length`, and a per-endpoint
  `connectorRegions` strategy (`contains` / `nearest`) are stored.
- Fills derived `regionId`s on `data/locations.json`, verifies every `mapRef`
  resolves, keeps every existing location id, and leaves unmappable sites
  `virtual: true`.
- Emits `data/map/{map.json,regions.geojson,bridges.geojson,key-locations.json,report.json}`.
  `report.json` records duplicate labels, unassigned bridges/key locations,
  nearest-assignment reviews, area outliers, missing overrides, warnings, errors.
- `--check` validates without writing; count drift (36/12/22) is a hard failure.
  The build is idempotent (byte-stable output).

### 2. `src/data/map.js` (extended)
- New generated-data validators: `validateMapManifest`, `validateRegionCollection`,
  `validateBridgeCollection`, `validateKeyLocationDocument`.
- New loaders: `loadMapManifest`, `loadRegions`, `loadBridges`, `loadKeyLocations`,
  `loadGeneratedMapData` (resolves `null` when the build is missing/invalid so the
  UI can fall back), `clearGeneratedMapCaches`.
- Coordinate contract: `toLatLng({x,y}) => {lat:-y, lng:x}`, `toMapPoint`,
  `mapBounds()` = `[[-1536,0],[0,2048]]`. Data stays in SVG coordinates only.
- `buildMapFeatureIndex` (lookup by id/label, region-for-location, region-at-point,
  bridges/keys per region) and `buildMapViewModel` (generated geometry + authored
  overrides + lore registry + live `WorldState` faction/status/present/visited).
- `buildMapSubmenu` returns name/type/parent district/description/faction/status/
  present cast/connections and a `travel` gate that is disabled without a named
  location or while `scene.combat` is active.

### 3. `src/data/locations.js` (extended)
- `buildLocationsByRegion`, `findLocationByMapRef`, `findLocationsInRegion`, and
  `validateLocationMapBindings` (mapRef resolves against generated features and
  `regionId` agrees with the key-location marker's region).

### 4. `src/core/machine.js` (new)
- Tiny queue-safe explicit state machine (`on`/`guard`/`action`, `exit`/`enter`,
  `*` catch-all, `internal` self-transitions, `onIgnored`), ported from the proven
  `silly-teyvat-dist` pattern with no dependency.

### 5. `vendor/leaflet/` (new)
- Leaflet **1.9.4** `leaflet.js`, `leaflet.css`, `images/*`, `LICENSE`, `VERSION`.
  Loaded locally by `src/ui/leaflet-adapter.js` (injects CSS + `<script>`, reads
  `window.L`). No CDN, no npm, no other extension's global.

### 6. `src/ui/leaflet-adapter.js` (new)
- `loadLeaflet`, `toLatLng`, `toMapPoint`, `createCityMap` (Simple CRS, image
  overlay stretched into the canonical bounds, region polygons, bridge polylines
  styled by status, key/named markers, label layer, fog group, highlighting,
  `fitBounds`).

### 7. `src/ui/map.js` (new)
- Component seam: `mountCityMap`, `mountFallbackMap` (single image + named
  markers only), layer labels/toggles markup, `bridgeStatusClass`.

### 8. `src/ui/map-panel.js` (new)
- Loads generated data + overlays + lore; builds the view model; mounts Leaflet
  lazily; layer toggles persisted per user in localStorage; feature submenu with
  Travel; draggable/resizable geometry persisted and clamped for 1080p/1440p;
  state machine `closed → open → location → travel`; falls back to the
  single-image map and shows a warning when generated data is missing; re-reads
  live `WorldState` on refresh.

### 9. `src/ui/shell.js` (extended)
- Map tab is now a live panel host, mounted lazily on first activation so
  Leaflet measures a visible container; map is disposed on unmount; `openShell`
  unhides before switching tabs.

### 10. `style.css`
- Functional (not polished) map styles: panel, toolbar, toggles, canvas,
  side submenu, labels, Leaflet theme overrides, resize handle, 1080p/1440p and
  narrow-viewport media queries.

### 11. Data/schema
- `data/map/*` regenerated and committed.
- `data/locations.json`: `regionId` filled for all 18 named locations (ids,
  coordinates, `mapRef`, `virtual` unchanged).
- `data/schemas/map.schema.json`: documented `name`, `area`, `connectorRegions`,
  `nearestReview`, `regionAssignment`, generated `regionId`, manifest
  `source`/`bounds`/`expectedCounts`, and a new `reportDocument`.

### 12. `package.json`
- Adds `build:map`; `check` now includes `build-data --check`,
  `build-map --check`, `node --check index.js`, and the test suite.

## Verification
```bash
"/mnt/c/Program Files/nodejs/node.exe" tools/build-map.mjs --check   # 36/12/22, OK
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check  # registry clean
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js        # 288 pass / 0 fail
```
New tests: `tests/map-extract.test.js` (18) and `tests/map-model.test.js` (30):
parser coverage, count/unique-id/uniqueness, bridge endpoints in distinct real
regions (never water), key locations inside regions, named-location id
preservation + `regionId` derivation, hard failures on duplicates/zero area/
missing layer/count drift, CLI `--check`/`--report`, idempotent build, `toLatLng`
round-trip, view-model + submenu from live state, combat blocking travel, layer
toggles, vendored Leaflet packaging, no runtime SVG parsing, machine transitions,
panel geometry at 1080p/1440p, and layer-visibility persistence.

## Notes / decisions
- **Nearest-endpoint assignment:** bridge slivers sit in the river/bay gaps, so
  pure point-in-polygon leaves most endpoints outside land. The build assigns by
  nearest land polygon edge (point-to-segment distance) within 130 canvas units
  and records every such assignment in `report.json`; nothing is silently
  connected.
- **Civic Center** has no polygon by design (Step 3 lore grouping). Its
  facilities come from key-location overrides (`Stadium`), which take precedence
  over the derived region, matching the plan's override-precedence rule.
- `data/map/overrides.json` was not modified; all 36 region labels already had
  authored overrides from the Step 3 amendment.
- **Fallback deviation:** the plan names a single `NeoTerra.svg` overlay as the
  fallback, but the implementation keeps the stretched PNG overlay plus named
  markers. The PNG is the plan's own canonical base art and the runtime rule is
  "never parse SVG", so this is stricter than the plan, not looser.

## Review fixes (applied before commit)
1. Re-selecting a feature now repaints the side submenu (the internal
   `location.SELECT` self-transition does not fire `onChange`).
2. The Leaflet loader no longer stays poisoned after a failed load, and an
   already-loaded script resolves immediately instead of hanging.
3. Tooltip text is HTML-escaped like labels/popups.
4. Initial fog visibility accepts both the panel's visibility map (`fog`) and
   settings (`showFogOfWar`).
5. Bridge nearest-region distance now measures point-to-edge distance, and the
   dead same-region retry was removed.
6. `openTravel` rebuilds the submenu from live state first, so combat started
   while the map is open disables travel immediately.
7. `mountFallbackMap` accepts layer visibility; `machine.can()` documents its
   structural-only semantics; unused `mapBounds` destructuring removed.

## Out of scope
- Actual travel execution/graph pathfinding (Step 14; the panel only validates
  and reports a travel request, and reverts the state machine when no handler is
  installed).
- Faction/threat overlay and the node editor (Step 15).
- Visual polish beyond functional styling (Step 18).
