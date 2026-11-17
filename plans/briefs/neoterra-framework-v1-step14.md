# Brief — neoterra-framework-v1 / Step 14

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 14 — Travel flow and location intro.
- **Depends on (committed):** Steps 9 (`travel.js` initiative hook), 13 (map data +
  view model).
- **Route:** standard implementer, executed by the build agent directly with a
  verification loop; no re-planning.
- **Node:** only `/mnt/c/Program Files/nodejs/node.exe` (v24.16.0); `node` is not
  on PATH.
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies.

## Implemented behavior

### 1. `src/data/map.js` — travel graph and pathfinding
- `buildTravelGraph({ locations, bridges, regions, overrides, state })` builds
  nodes from the named-location registry plus chat-only virtual nodes, and edges
  from: same-district walks, authored `connections`, bridge spans, and mutual
  `secret` routes.
- **Bridges gate districts.** A cross-district connection resolves to a bridge
  span between the two districts; a blocked/destroyed span removes that edge and
  the pair's bridge edges, so pathfinding must detour or reject. No straight-line
  fallback exists.
- `resolveBridgeStatus()` applies precedence **chat > global override >
  generated**.
- `findTravelPath(graph, from, to, { abilities })` returns
  `{ ok, reason, path, bridges, bridgeNames, distance, turns, sameRegion, modes,
  ability, bypass, blockedBridges }`. It distinguishes `blocked` (a route exists
  with the spans open) from `no-route` (genuinely disconnected). `teleport` /
  `flight` / `swim` bypass a blocked ground route with an explicit cost;
  `detectTravelAbilities()` reads ability/skill/trait text.
- `travelTurnsForDistance()` — 400 canvas units per turn, clamped to 8, a single
  short turn for same-region hops, fixed cost for a bypass.
- `reachableNodes()` for UI/decision support.

### 2. `src/data/map.js` — per-chat map layer (also used by Step 15)
- `getChatMapOverrides`, `setChatMapOverride`, `removeChatMapOverride`,
  `resetChatMapOverrides`, `addChatVirtualNode`, `removeChatVirtualNode`,
  `exportChatMapOverrides`. Bridges and districts have no `LocationState` of
  their own, so their per-chat status lives in `WorldState.flags.map`; named
  location status/control stays in `WorldState.locations`.
- Chat virtual nodes are real `LocationState` entries (travel, presence,
  validation, export) plus a marker record that carries their graph edges.
- `buildMapViewModel` now merges chat overrides over the global document and
  renders chat-only virtual nodes.

### 3. `src/flows/travel.js` — travel flow
- Keeps the Step 9 exports (`buildTravelInitiativeContext`,
  `createTravelInitiativeHook`, `notifyTravel`) and adds:
  - `createTravelFlow({ store, season, scene, sources|loadSources, initiative,
    now, log })` with `travel()`, `planTravel()`, `getGraph()`, `invalidateGraph()`.
  - `travel({ to, ability, signal, runTracker })` validates combat, plans,
    then commits **time + location + journal** in one `applyEventBatch`
    (`store.replace`), so the move is atomic.
  - Refreshes the cast through the scene flow (non-fatal), then notifies the
    Storyline Tracker with `{ type:'travel', from, to, path, bridges, turns,
    modes, ability }`.
  - `buildLocationIntro` result, `messageExtra` (`attachTravelToMessage` writes
    `message.extra.neoterra.travel`), and `flags.travel.history` (last 20).
- Failure handling: a failing tracker, an aborting tracker, or a failing cast
  refresh never rolls back a committed move; the reason is reported
  (`failed` / `aborted`).
- Combat blocks travel (`in-combat`); blocked/disconnected routes reject with a
  human message from `describeTravelFailure`; same-location travel is a no-op.

### 4. `src/flows/scene.js` — `buildLocationIntro`
- Deterministic arrival text: location + parent district, how the player
  arrived (bridge names / ability), turns spent, area status and controlling
  faction, and the present cast (never invented names). Season title footer.

### 5. `src/flows/initiative.js` + `src/agents/storyline.js`
- `afterLocationChange` forwards an optional `travel` context.
- `runStoryline`/`buildStorylinePrompt` accept `travel` and add a `## Travel`
  section with route/bridges/ability/turns plus an instruction to react to the
  arrival.

### 6. `src/ui/map-panel.js` + `src/ui/shell.js` (wiring)
- The panel exposes `getSources()`; the shell builds a per-chat store and a
  travel handler and passes `onTravel`, so the map's Travel button now completes
  the move and refreshes the panel. `EVENTS.MAP_UPDATED` announces it.
- The graph is rebuilt per plan, so a bridge destroyed in this chat gates the
  next trip.

## Verification
```bash
"/mnt/c/Program Files/nodejs/node.exe" tools/build-map.mjs --check   # 36/12/22, OK
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check  # registry clean
"/mnt/c/Program Files/nodejs/node.exe" --check index.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js        # 350 pass / 0 fail
```
New suite `tests/travel.test.js` (34 tests): mode-vocabulary parity, graph
shape/counts, cross-district bridge naming, same-region hop, detour vs blocked
vs disconnected, chat/global/generated bridge precedence, ability bypass with
recorded cost, turns/clamps, no-op and unknown nodes, `reachableNodes`, per-chat
override isolation and round-trip through the store, virtual node add/remove/
reset, full move (time, journal, flags, message extra), canonical-player move,
combat block, blocked rejection, tracker run/failure/abort, storyline travel
context, intro text, and a message-extra helper.

## Notes / decisions
- **Bridges are district-level.** The SVG spans connect regions that share a
  district, so district pairs (not region pairs) are the bridge unit; that is
  what makes "a destroyed bridge forces a detour" a real rule. Sites linked by
  one-sided `secret`/`flight` markers do not silently bypass the graph.
- Same-district or same-region pairs are a plain walk, so local movement is
  never hostage to a river crossing.
- The travel flow commits the move before the tracker runs (the plan's
  "failed tracker still completes the move" rule) and reports tracker failure
  instead of throwing.
- A chat-only virtual node's authored connections are explicit edges (the user
  drew them), so district/bridge rules do not apply to them.

## Out of scope
- World overlay, faction/threat tinting, and the node editor (Step 15).
- Ending/epilogue (Step 16) and CYOA (Step 17).
