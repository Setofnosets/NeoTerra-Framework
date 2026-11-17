# Map authoring

The SVGs are the **geometry source of truth**. The authored overrides supply
names, lore districts, factions, and statuses. The runtime never parses SVG; it
consumes the generated files in `data/map/`.

## Canvas and coordinate space

- Canonical canvas: **2048 × 1536**, y-down, origin top-left.
- The base PNG is **2017 × 1512** and is stretched to the canonical box. The
  mismatch is intentional; every data coordinate uses 2048 × 1536, never raw
  PNG pixels.
- Runtime conversion: `toLatLng({ x, y }) => L.latLng(-y, x)` with
  `L.CRS.Simple` and bounds `[[-1536, 0], [0, 2048]]`.
- Never store Leaflet lat/lng in `WorldState`.

## SVG layer contract

Four files at the repo root:

| File | Contents |
| --- | --- |
| `NeoTerra.svg` | Combined reference (image + all three layers) |
| `NeoTerra_Districts.svg` | Transparent district overlay |
| `NeoTerra_Bridges.svg` | Transparent bridge overlay |
| `NeoTerra_Locs.svg` | Transparent key-location overlay |

Rules:

- Layer membership comes from the **ancestor group label** (`Districts`,
  `Bridges`, `KeyLocations`). Do **not** trust `sodipodi:docname` or
  `inkscape:export-filename`; they are cross-wired in the current exports.
- Every feature needs a non-empty, unique `inkscape:label`.
- Labels are generic placeholders (`Center`, `ResidentialDistrictA`,
  `BridgeA`, `BigOfficeA`). They are stable keys for overrides; do not rename
  them casually.
- Districts are `<ellipse>` or `<path>` polygons; bridges are `<rect>` or thin
  `<path>` slivers; key locations are 5-point `<path>` stars with
  `sodipodi:cx` / `sodipodi:cy`.
- No `<text>` labels are required. Text labels are rendered by Leaflet.
- Expected counts: **36 districts, 12 bridges, 22 key locations**. Counts are
  configurable in `map.json` but `--check` fails on drift from the baseline.
- A missing layer, duplicate/empty label, or zero-area geometry is a hard
  error.

## Build pipeline

```bash
npm run build:map            # writes data/map/* and updates data/locations.json
node tools/build-map.mjs --check   # validates and verifies generated files are current
node tools/build-map.mjs --report  # regenerates, then prints the extraction report
```

The tool:

1. Parses each feature under the three layer groups by `inkscape:label`.
2. Approximates ellipses/rects as polygons and flattens paths.
3. Computes `bbox`, `centroid`, `area`, and `sourceColor`.
4. Infers a coarse `kind` from the label prefix.
5. Derives bridge endpoints and `connects: [regionId, regionId]`.
6. Assigns each key location to a region by point-in-polygon (with a report
   warning if none).
7. Merges `data/map/overrides.json`.
8. Fills derived `regionId`s in `data/locations.json` and preserves every
   existing location id.
9. Writes `data/map/map.json`, `regions.geojson`, `bridges.geojson`,
   `key-locations.json`, and `report.json`.

`--check` fails if any committed generated file is stale, so a geometry change
cannot be merged without regenerating the JSON.

## Overrides

Edit `data/map/overrides.json`, never the SVGs. Keys are the current
`inkscape:label`s.

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 2048, "height": 1536 },
  "regions": {
    "BigOfficeA": {
      "name": "PetraByte Tower",
      "districtId": "downtown",
      "factionId": "petrabyte",
      "status": "patrolled"
    }
  },
  "bridges": {
    "BridgeC": { "name": "West Approach", "status": "open" }
  },
  "keyLocations": {
    "HomeA": { "name": "Unnamed Residence", "locationId": null }
  },
  "namedLocations": {}
}
```

- `districtId` must exist in `data/districts.json`.
- `factionId` must exist in `data/factions.json`.
- A key-location override's `districtId` takes precedence over the
  polygon-derived region for that marker (useful for virtual districts such as
  `civic-center`).
- `underground` is a virtual lore district with no polygon.

### Named location bindings

`data/locations.json` is the canonical named-location registry. Each entry has:

- `x`, `y` in 2048 × 1536;
- `mapRef` (`{ layer: "keyLocation"|"region", id }`) or `virtual: true`;
- `regionId` (derived district polygon) and `districtId` (lore district);
- `travel` modes (`walk`, `bridge`, `flight`, `secret`);
- symmetric `connections`.

A location with no plausible marker becomes `virtual: true` with manual
coordinates and a warning; it is never dropped. A new or unlabeled site can be
placed manually, or with the dev-only `tools/map-coords.mjs` spike.

## Adding a district, bridge, or key location

1. Draw it in Inkscape on the 2048 × 1536 canvas, inside the correct layer
   group.
2. Give it a unique `inkscape:label`.
3. Export/save the three overlay SVGs and the combined reference.
4. Add an override for the label.
5. Run `npm run build:map`.
6. Read `data/map/report.json` for duplicate labels, unassigned bridges, key
   locations with no region, or area outliers.
7. Run `node tools/build-map.mjs --check` and the map tests.

## Per-chat overrides

Global edits belong in `data/map/overrides.json`. A destroyed bridge, captured
district, or virtual node for one timeline belongs in `WorldState.locations`.
Per-chat state never leaks to other chats, and **Reset this chat's world** only
clears that timeline.

## Fallback

If generated map data is missing or invalid, the map falls back to the base
`NeoTerra.png` image plus `locations.json` markers. The UI still opens, but
districts and bridges lose interactivity.

## DeepSeek coordinate spike

`tools/map-coords.mjs` is a **dev-only fallback** for unlabeled or newly drawn
sites. It asks a vision model for pixel coordinates and writes
`data/locations.draft.json`; it never writes `data/locations.json`. Every
proposal must be human-verified. It requires `DEEPSEEK_API_KEY` for `--draft`.
`--check` validates `locations.json` and, when present, the draft.

## Leaflet

Leaflet is vendored under `vendor/leaflet/` (JS, CSS, images, `LICENSE`,
`VERSION`), pinned to the version proven in `silly-teyvat-dist`. No CDN, npm,
or another extension's global. The vendored files are never edited.
