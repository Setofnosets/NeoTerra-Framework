# Endings: villain victory and post-victory play

A season can end in the main threat's complete victory. That is a legitimate,
recorded ending, not a dead end.

## Trigger

The ending fires when either condition is met:

- the season's `finalDeadline` passes (turns or in-game date), or
- the main threat reaches its terminal stage.

It fires **once** per season timeline. `WorldState.ending.status` makes the
trigger idempotent across reloads and swipes; a second trigger is a no-op. If a
conflict is active, it is ended cleanly before the epilogue so the ending does
not inherit a stale `[NEOTERRA_COMBAT]` block.

## Epilogue

The Epilogue Agent writes a **~5-paragraph** epilogue (configurable 3–8 via
`ending.paragraphs`) grounded in `WorldState`:

- which threat won and how;
- the fates of major cast members;
- faction and location control;
- the player's status (free, captured, corrupted, brainwashed);
- the state of the city.

The epilogue is prose only. It does not decide the player's next move. It is
stored once and reused; a rewrite only happens on explicit user request.

## Choice screen

After the epilogue the player chooses:

1. **Resistance** — continue as an underground movement against the victor:
   reduced resources, hidden bases, sabotage and recruitment goals, and new
   resistance beats.
2. **Join the villain** — serve the victor: defeat the resistance, govern
   captured districts, conquer neighbouring districts/cities, or act as a
   brainwashed enforcer/consort. Availability is state-aware: always offered to
   villain-POV or corrupted/brainwashed players; offered to heroes when
   coercion, a relationship, or a deal makes it plausible.
3. **End here** — stop at the epilogue. The world remains viewable in the
   journal and codex but is inert.

A dead or mind-wiped player cannot choose Resistance without a declared
reversal; the existing bad-end record is respected.

## Post-victory state

Both continuations:

- set `arc: 'post-victory'`;
- rewrite factions and threats so the victor becomes the establishment and the
  resistance (or the next conquest target) becomes the new threat;
- reassign cast locations and statuses;
- generate a fresh set of `postVictoryBeats` with their own soft deadlines and
  consequences;
- append the epilogue and chosen path to `recentEvents` and the journal;
- freeze the original season's beats as closed.

The same Canon Beat Ledger machinery is reused, so post-victory beats adapt,
short-circuit, and escalate exactly like season beats.

### Conquest

"Conquer other places" is a `conquest` track:

- target districts/cities are added to the location registry (a location that
  is not on the original map resolves through the location/override system, not
  a crash);
- each target has an occupation state;
- the arc goal is world domination;
- brainwashed/corrupted players receive villain-side labels and goals
  automatically.

## Season authoring

A season may provide explicit `postVictory` data:

```json
"postVictory": {
  "resistance": {
    "title": "The Resistance",
    "victorFactionId": "clarity",
    "threat": { "id": "s4.post.victor", "...": "..." },
    "beats": [ "...": "..." ]
  },
  "join-villain": {
    "title": "The New Order",
    "beats": [ "...": "..." ],
    "conquest": [ "...": "..." ]
  }
}
```

If a season omits it, the flow writes sensible defaults from the default
threat and the roster. Tests: `tests/ending.test.js`.
