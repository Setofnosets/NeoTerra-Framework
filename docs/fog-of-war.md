# Fog of war

Fog is a per-chat exploration state plus a view-model transform plus a render
mode. It is not authored map data and not a second SVG layer.

## State

`flags.map.exploration`:

```json
{
  "regions": {
    "region:center": { "state": "discovered", "turn": 0, "source": "start" },
    "region:park-c": { "state": "rumored", "turn": 3, "source": "travel" }
  },
  "keyLocations": {},
  "updatedAt": 3
}
```

Named locations reuse `locations[].visited`. Bridges derive their visibility
from their endpoints. Storing the block inside `flags.map` means the existing
`withChatMap` writer preserves it and the world bundle exports it.

## Reducer events

- `DISCOVER_MAP_FEATURE { kind: 'region' | 'keyLocation', id, source }`
- `REVEAL_REGION { regionId, source }`

Both are idempotent. `source` is `start | travel | storyline | editor`.

## Rules

- The start location's region is `discovered`. In `rumors` mode its
  bridge-adjacent regions are `rumored`.
- A `discovered` region reveals its key locations; its named locations are
  visible only once `visited`.
- A `rumored` region shows a name only (if `showRumoredLabels`); description,
  faction control, present cast, and travel details stay hidden.
- An `unknown` region shows no name, description, markers, or travel.
- A bridge is visible when either endpoint is discovered; its status is shown
  only then.
- Virtual locations (`old-subway`, `bcp-facility`, bunkers) are reachable
  through authored `connections` when the origin is discovered; their names stay
  hidden until visited.

## View transform

`applyMapFog(viewModel, exploration, options)` returns a copy whose features
carry a `visibility` and whose hidden fields are **blanked** (`name`,
`description`, `factionName`, `present`, `travelBlocked`). It is applied before
both the renderer and the map submenu, so a hidden name cannot leak through the
detail panel.

## Travel

`planTravel` rejects a destination in an `unknown` region when
`map.fog.gateTravel` is on (default true while fog is on). A `rumored`
destination is allowed as a blind trip. A successful trip discovers every
region on the path (origin, destination, and both bridge ends) in the same
validated batch as `SET_LOCATION`.

## Render

The existing `fog` layer toggle is the on/off switch and persists in
`localStorage['neoterra:map:layers']`.

- unknown → near-opaque dark fill, no label;
- rumored → dim outline, name only;
- discovered → normal styles.

The map editor adds **Reveal region** and **Reset fog**. A fallback
single-image mount disables fog controls with a reason.

## Settings

```json
{
  "map": {
    "showFogOfWar": false,
    "fog": {
      "mode": "rumors",
      "revealOnTravel": true,
      "showRumoredLabels": true,
      "gateTravel": true,
      "revealNeighbors": true
    }
  }
}
```

`showFogOfWar` defaults to `false` so existing chats keep the V1 map; turning it
on enables the layer. `hard` mode reveals no neighbors.
