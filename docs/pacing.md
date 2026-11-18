# Pacing and the Scene Director

Pacing is split into two halves: a deterministic **analyzer** that runs every
turn, and an explicit **cut** the player can trigger. Nothing moves the player
automatically.

## Signals

The analyzer reads only persisted state:

- turns since the last non-pacing `recentEvents` entry;
- turns since the last location change (`flags.travel.lastAt`);
- turns since the scene started (`flags.pacing.sceneStartedTurn`, recorded on a
  location change or a cut — not `castDirector.turn`, which is a cast refresh);
- turns since the last beat action (a `beat`-tagged event or
  `flags.storyline.lastRunTurn`, whichever is later);
- active combat, the ending screen, snooze, and the time hold.

## Levels

`ok | nudge | cut | stalled`, computed from a small score:

| Setting | Default | Meaning |
| --- | --- | --- |
| `stallTurns` | 3 | idle turns before a nudge |
| `sceneMaxTurns` | 12 | scene length that warrants a cut |
| `threatNudgeTurns` | 10 | turns since a threat development |
| `nudgeScore` | 2 | score at which the level becomes nudge |
| `cutScore` | 4 | score at which the level becomes cut |

Every threshold is a setting. While `flags.clock.hold.active` the analyzer
downgrades to **nudge at most** and suggests **Release time** instead of a cut;
a held scene is intentionally not cut.

## Output

`flags.pacing = { level, reasons, codes, score, suggestion, canCut,
lastAnalyzedTurn, lastCutTurn, snoozedUntilTurn, suggestedSlots, sceneTurns,
held }`. The analyzer never mutates story state.

## Cut action

`cutScene({ reason })` is always explicit:

1. refuse during combat, on the ending screen, or while time is held (offer
   **Release time** instead);
2. release the hold, advance the clock by `cutSlots` (default 2) with
   `storyTurns: cutSlots`;
3. set a director cut framing;
4. append a `pacing`-tagged "meanwhile" event;
5. refresh the cast at the **same** location;
6. optionally force one storyline pass with `trigger: 'beat'`.

It never moves the player, never changes the location, and never posts prose
automatically. `src/ui/chat-output.js` exposes a `CUT` frame kind if a caller
wants a visible frame.

## Narration nudge

When the level is at least `nudge`, `[NEOTERRA_PACING]` tells the narrator to cut
forward, raise a threat development, or break a stalled exchange. It is a
directive, not state, and it is content-gated. While time is held it instead
tells the narrator to stay in the moment.

## Snooze

**Not now** writes `snoozedUntilTurn = turn + snoozeTurns` (default 3) and the
card disappears until it expires.

## UI

- The world overlay Director card shows the reasons and buttons: **Cut
  forward**, **Not now**, and **Release time** while held.
- The cut button is disabled during combat and on the ending screen with a
  reason.
- The time chip is the manual brake for major/intimate scenes.

## Settings

```json
{
  "pacing": {
    "enabled": true,
    "stallTurns": 3,
    "sceneMaxTurns": 12,
    "threatNudgeTurns": 10,
    "cutScore": 4,
    "nudgeScore": 2,
    "cutSlots": 2,
    "snoozeTurns": 3
  }
}
```

`context.blocks.pacing` and `tokenBudget.pacing` control the block; it is the
first block dropped when the total budget is tight.
