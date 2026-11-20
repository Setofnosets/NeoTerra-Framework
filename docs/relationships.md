# Relationship graph

The **Relations** tab renders the live cast as a deterministic SVG graph. It is a
view over `WorldState.relationships` plus the player mirror; it never writes
state and never posts to chat.

## Model

`buildRelationshipGraph({ state, registry, settings, filters })` returns
`{ nodes, edges, bounds, legend, empty, hasRelationships }`.

- **Nodes** — every character referenced by a relationship, the player, and the
  present cast. Fields: `id`, `name`, `side`, `status`, `formKind`, `isPlayer`,
  `isPresent`, `corruptionStage`, `badEnd`, `badEndType`, `x`, `y`, `r`,
  `labelVisible`.
- **Edges** — `state.relationships` plus the `player.relationships` mirror,
  deduped by unordered pair. Fields: `a`, `b`, `type`, `affinity`, `tension`,
  `directed`, `label`, `color`, `width`, `dashed`.
- **Type normalization** — agent vocabulary maps onto the six legend types:
  `likes → ally`, `dislikes/rivalry → rival`, `attraction → lover`; `family`,
  `owner/servant`, `ally`, `rival`, `lover`, `neutral` pass through. Unknown
  values become `neutral`.
- **Direction** — `owner/servant` is the only directed edge and the only one that
  renders an arrowhead.

## Layout

Layout is dependency-free and deterministic:

- the player is at the centre;
- present characters ring the player;
- everyone else is on an outer ring;
- each ring is sorted by side, then name, then id;
- radii scale with node count and the declared canvas, and every node stays
  inside `bounds`.

No force simulation means snapshots are stable and tests can assert coordinates.
With more than 30 nodes, labels are thinned to the player, present cast, and
strong-affinity nodes.

## Filters

- present only;
- side (`villain`, `hero`, `vigilante`, `civilian`, `neutral`, `unknown`);
- relationship type;
- minimum affinity.

They change node and edge counts together, so a filter never leaves an orphan
edge.

## UI

- A dedicated live tab between Characters and Player.
- Hover highlights incident edges; click or keyboard (`Enter`/`Space`) selects a
  node and shows its relationship list.
- Nodes are focusable `<g role="button">` elements; filter changes keep focus.
- Bad-end and corruption badges sit on the node.
- Empty state when the world has no relationships.
- Repaints on `MAP_UPDATED` and `TAB_CHANGED`; disposed on chat change without
  duplicate SVGs.

No settings are required: the tab is always available. The graph never mutates
`WorldState`.

## Player POV

Presence arrays (`locations[].present`, `scene.present`) are an **NPC list**.
The player is never written into them: `syncPresence`, the season seed, and the
presence migration all skip `controlledBy === 'player'` (or
`player.characterId`). Consumers that need the player read `state.player`:

- `buildMapViewModel` exposes `playerLocationId` and renders the played
  character as a distinct **You are here** marker, not an avatar in `Present:`.
- Session Home keeps `presentNpcs` and a separate `playerHere` flag.
- The Codex and Player tabs still list the played character with every
  per-character action (form swap, re-derive, reset goals, import, generated
  form review, return to custom).

**Play-as relocation.** `SET_PLAYER_IDENTITY` sets `scene.locationId` to the new
player's location (taking over a character takes over where they are) and
re-runs `syncPresence`; the previous player re-enters the NPC pool at their old
location. `state.player.locationId` mirrors `scene.locationId`.

**Goals.** On identity change, `src/data/goals.js` derives goals from explicit
card labels first, then from explicit motive sentences. If the result is empty
and `agents.goalInference.enabled` is on, one bounded
`onIdentityChange` inference call runs (20 s budget); failures leave goals empty
and never block the change. `goalsSource` is `card` or `live`; the Codex shows
the source and an **Infer goals** retry. The deterministic parse always works
with the agent off.

**Player card.** `identity.cardInstruction` (default `true`) enables the Codex
instruction and downloadable `<Name>.json` card; the `[NEOTERRA_PLAYER]` prompt
block gains one `Player card: <Name>` line so the narrator keeps the POV name.

## Lore agent

When `agents.lore.enabled` is on, `initiative.runLore` runs every
`agents.lore.everyNTurns` turns (default 10) or at an act change. Besides the
Journal recap, it applies relationship deltas atomically through
`PLAYER_RELATIONSHIP_DELTA` / `RELATIONSHIP_DELTA` events. Disabling the agent
stops both the recap and every relationship write.
