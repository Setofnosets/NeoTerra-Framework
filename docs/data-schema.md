# Data schema

This page describes the authored and generated data consumed by the Neo Terra
Framework. Published JSON Schemas live in `data/schemas/`; the runtime
validators are plain ESM and add stricter cross-file checks (resolved IDs,
season scope, map bindings).

## File map

| Path | Kind | Purpose |
| --- | --- | --- |
| `data/characters/index.json` | generated | Season-scoped character/form registry |
| `data/characters/overrides.json` | authored | ID fixes, aliases, multi-actor cards |
| `data/seasons/index.json` | generated | Season manifest used by the loader |
| `data/seasons/<id>.json` | authored | Season definition |
| `data/seasons/s5.aux.json` | authored | Non-playable auxiliary season metadata |
| `data/locations.json` | authored | Named-location lore and map bindings |
| `data/districts.json` | authored | Canonical lore districts |
| `data/factions.json` | authored | Faction registry |
| `data/form-groups.json` | authored | Mutually exclusive form groups |
| `data/form-rules.json` | authored | Legal transformations and reversals |
| `data/map/*.json` / `*.geojson` | generated | SVG geometry, graph, report |
| `data/map/overrides.json` | authored | Labels, names, factions, parent districts |
| `data/schemas/*.schema.json` | authored | Published schemas |

Run `npm run build:data` and `npm run build:map` after editing authored data.
Both `--check` modes fail if generated files are stale.

## Character registry entry

```json
{
  "id": "s1dark.carol.bleeding-heart",
  "file": "Chars/S1Dark/Carol-Bleeding Heart.json",
  "cardPath": "Chars/S1Dark/Carol-Bleeding Heart.json",
  "seasonId": "s1dark",
  "dataName": "Carol Fate",
  "displayName": "Carol",
  "aliases": ["Bleeding Heart"],
  "side": "villain",
  "threatLevel": "OMEGA",
  "formRole": "base",
  "altOf": null,
  "formKind": "base",
  "formGroup": "s1dark.carol",
  "tags": ["villain", "corruption"],
  "bundle": false,
  "actors": null,
  "npcEligible": true
}
```

- `id` is `"<seasonId>.<slug>"`, derived from the card filename stem. IDs are
  stable and season-scoped; the same name in another season is another entry.
- Only `data.*` in a character card is authoritative. The legacy duplicated
  top-level block is ignored.
- Filename parentheses decide `formKind`: `corrupted`, `cleansed`, `treated`,
  `infected`, `coldhearted`, `knighted`, `poisoned`, `alt-version`, or `base`.
- `bundle: true` marks a multi-actor card (e.g. `Atropos couple`,
  `The Sensational Sirens`). Bundles are never auto-added as one NPC;
  `actors` lists the separate people.
- `npcEligible` is false for bundles and is filtered again by the Cast Director
  for `controlledBy: 'player'` characters.

### Overrides

`data/characters/overrides.json` is keyed by the card path relative to `Chars/`:

```json
{
  "schemaVersion": 1,
  "entries": {
    "S3/Selina Cross-Umbra).json": {
      "id": "s3.selina.cross.umbra",
      "displayName": "Selina Cross-Umbra"
    }
  }
}
```

Supported fields: `id`, `displayName`, `aliases`, `side`, `threatLevel`,
`formKind`, `tags`, `bundle`, `actors`, `npcEligible`. Unknown keys are
ignored, so notes may be kept in the file.

## Season definition

A season declares:

| Field | Meaning |
| --- | --- |
| `id` | Lowercase id; must match the filename and `Chars/<Folder>` |
| `title`, `era`, `anchorDate`, `premise`, `toneNotes` | Presentation and opening frame |
| `playerRole` | `hero`, `villain`, or `neutral` |
| `defaultPlayerCharacterId` | Optional canon player (S1Dark = Carol) |
| `playable`, `notPlayableReason` | The S5 auxiliary card uses `false` |
| `alt`, `altOf` | Alternate season marker (S1Dark) |
| `sandbox`, `allowAnyCharacter` | Sandbox has no threats or canon beats |
| `roster[]` | `{ characterId, formId, locationId }` |
| `factions[]` | `{ id, influence, status }` |
| `threats[]` | `{ id, rank, name, agenda, stages, progress, ... }` |
| `startLocationId` | Must resolve to a named location |
| `openingBeats[]` | Immediate scene hooks |
| `canonBeats[]` | Canon Beat Ledger entries (see `canon-beats.md`) |
| `finalDeadline` | `{ turns, date }`; one may be null |
| `failureState` | `villain-victory`, `neutral-bad-ending`, or `none` |
| `manualOnly`, `altFormsAllowed` | Roster/form policy |
| `postVictory` | Optional post-victory arcs and beats |

A new season is added by dropping `Chars/<Season>/` and
`data/seasons/<id>.json`; `data/seasons/index.json` is generated. See
`adding-a-season.md`.

## WorldState

`WorldState` is a plain versioned JSON document. The top-level shape is:

```text
WorldState {
  schemaVersion, chatId, seasonId, mode,
  meta { turn, inGameDate, timeOfDay, sceneId, inCombat, startedAt },
  arc: 'season' | 'post-victory',
  ending { status, path?, epilogueText?, firedTurn? },
  playerRole: 'hero' | 'villain' | 'neutral',
  player { identity, characterId?, ...CharacterState, personaNotes },
  characters { [charId]: CharacterState },
  locations  { [locId]: LocationState },
  factions   { [factionId]: FactionState },
  threats: ThreatState[],
  beats { [beatId]: { status, resolvedTurn?, adaptedFrom?, adaptedTo?, reason? } },
  badEnds { [charId]: BadEndRecord },
  relationships: Relationship[],
  recentEvents: Event[],
  scene { locationId, present[], combat?, framing },
  flags, log
}
```

`CharacterState` carries identity, side, control, status, location, threat
level, stamina/willpower, agenda, appearance, abilities, corruption, and the
last updated turn. Player-controlled characters are mirrored in `player` and
remain in `characters` with `controlledBy: 'player'`.

Writes go through `applyWorldEvent(state, event)`. Agents emit events, never
state diffs, so merges are deterministic and replayable. Unknown events are
rejected. Beat status transitions are monotonic; ending triggers are
idempotent; bad-end records are keyed by character and `continuityKey`.

Storage:

- durable: `chatMetadata.neoterra.worldState`
- per-swipe snapshots: `message.extra.neoterra.snapshots[swipeId]`
- crash WAL: `localStorage['neoterra:wal:<chatId>']`

## Map data

Generated files use the canonical **2048 × 1536**, y-down coordinate space.

| File | Shape |
| --- | --- |
| `data/map/map.json` | canvas, source hashes, layers, expected/actual counts, bounds |
| `data/map/regions.geojson` | 36 district Polygon Features |
| `data/map/bridges.geojson` | 12 bridge Features with `connects`, `endpoints`, `length` |
| `data/map/key-locations.json` | 22 point markers with `regionId` and `locationId?` |
| `data/map/report.json` | duplicate labels, unassigned bridges/locations, warnings |
| `data/locations.json` | named lore registry with `mapRef`, `regionId`, `districtId`, `travel` |

The runtime never parses SVG. The map falls back to the base image plus
`locations.json` markers if generated data is missing. See
`map-authoring.md`.

## Content limits

```json
{
  "contentGate": "full",
  "contentLimits": {
    "player": "",
    "characters": {
      "s4.claire.atropos.recorrupted": "strict"
    }
  }
}
```

`full` is a no-op. Hard limits are combined with the global gate by taking the
strictest level, so turning the global gate off can never bypass a character or
player limit.

## Validation commands

```bash
node tools/build-data.mjs --check
node tools/build-map.mjs --check
node tools/map-coords.mjs --check
node --test tests/*.test.js
```
