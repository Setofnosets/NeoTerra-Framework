# World clock, story turns, and the time brake

Neo Terra keeps fiction time in `WorldState.meta` and exposes it through a
one-click chip in SillyTavern's top bar. Time is the only thing the off-screen
world tick, the newspaper cadence, and beat deadlines all agree on.

## Pace

- One assistant turn advances one slot: `dawn → morning → afternoon → evening →
  night → dawn`.
- A full day therefore takes **five turns**.
- The date rolls to the next calendar day when the cycle wraps from `night` to
  `dawn`. Dates are ISO `YYYY-MM-DD` and use real UTC arithmetic, so month,
  year, and leap-day boundaries are correct.
- Sandbox seasons with `anchorDate: null` still cycle the slot and keep
  `inGameDate: null`. The clock never invents a date.
- Travel advances one slot per path turn (`TICK_TIME {turns: path.turns}`), so a
  three-turn trip moves the clock three slots in the same atomic batch.

## Two turn counters

| Counter | Advances | Used by |
| --- | --- | --- |
| `meta.turn` | every assistant message, always | pipeline cadence, agent stats, HUD |
| `meta.storyTurn` | only while fiction time flows | beat `turnRange`, `deadlineTurns`, `finalDeadline.turns` |

Old worlds are migrated with `storyTurn = turn`, so nothing changes until the
brake is used. `meta.turn` remains the mechanical counter that the UI calls
"turn N".

## The time brake

`flags.clock.hold` freezes fiction time:

```json
{
  "active": true,
  "reason": "manual",
  "sinceTurn": 42,
  "sinceDate": "2037-03-06"
}
```

While held:

- the date, slot, and `storyTurn` stop advancing (`TICK_TIME` still increments
  `meta.turn`);
- the off-screen world tick is a no-op;
- the newspaper publishes nothing;
- deadline escalation and the final-deadline check are suspended;
- the cadence-driven storyline pass is skipped.

Explicit time still passes: travel, a pacing cut, or any `TICK_TIME {turns>0}`.

### What sets a hold

- **Combat** auto-holds on `COMBAT_START` and auto-releases on `COMBAT_END`
  unless a manual hold was set for another reason.
- **Encounters** can auto-hold with `clock.autoHold.encounter` (off by default).
- **Major/intimate scenes** are held explicitly with the top-bar time chip or
  `SET_CLOCK_HOLD {active:true}`. There is no prose-based intimacy detection.
- **Travel** releases the hold because it leaves the scene.

`SET_CLOCK_HOLD` is idempotent and records `sinceTurn`/`sinceDate` on entry. A
manual hold survives combat end.

## The time chip

The chip is always visible while a chat has a world. It shows the in-game date
and slot (or `frozen`), and one click toggles the brake. The shell's Director
card mirrors the state and offers **Release time** while held.

## Settings

`settings.clock`:

```json
{
  "enabled": true,
  "slotsPerDay": 5,
  "timeOfDayStart": "evening",
  "autoHold": { "combat": true, "encounter": false, "beat": false },
  "maxHoldTurns": 20
}
```

- `enabled: false` restores pre-clock behavior: `meta.storyTurn` follows
  `meta.turn` (so beat deadlines keep working), while the date and slot stay
  fixed. It is the exact V1 escape hatch.
- `slotsPerDay` is locked to **5** in V1.1 because the slot table is fixed. The
  off-screen tick reads it for day math, so the settings control is read-only
  until a calendar feature can change the table without desynchronizing the
  tick.
- `maxHoldTurns` is reserved for a future "still frozen" reminder. It is
  persisted and exposed in settings but currently has no runtime effect, and it
  never force-releases time.

## Files

- `src/core/world-clock.js` — pure slot/date helpers.
- `src/state/reducer.js` — `TICK_TIME.storyTurns`, `SET_CLOCK_HOLD`, combat.
- `src/agents/state-tracker.js` — builds the clock tick before the pipeline.
- `src/ui/clock-chip.js` — the chip.
- `src/context/renderer.js` — appends `(time frozen)` to `[NEOTERRA_SCENE]`.
