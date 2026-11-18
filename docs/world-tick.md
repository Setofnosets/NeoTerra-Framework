# Off-screen world tick

The world keeps moving while the player is not looking. The tick is a
**deterministic planner**, not an agent: no LLM call, no network.

## When it runs

After the world clock, before the player State Tracker, `runTurnPipeline` calls
the tick. It does something only when at least one in-game day has elapsed since
`flags.worldTick.lastDate` (or `lastStoryTurn` when the date is null).

No elapsed day → no-op. The tick also skips when:

- `worldTick.enabled` is false;
- the season is Sandbox;
- the arc is ended/epilogue (`ending.status` is `epilogue` or `ended`);
- fiction time is held;
- the chat changed mid-pass.

A first run records the baseline (`lastDate`, `lastTurn`, `lastStoryTurn`) and
emits nothing.

## What advances

- **Faction influence** — absolute value, clamped 0–100, capped by
  `maxFactionDeltaPerTick` per tick. `status: disbanded` factions do not move.
- **Active threats** — `progress` advances at the authored rate, clamped 0–100.
  The reducer derives `stage`, so `threatStage` beat conditions unlock naturally.
  Defeated/contained threats do not move.
- **Off-screen NPC movement** — at most `maxNpcMovesPerTick` characters per tick.
  Only `controlledBy: 'npc'`, alive, non-terminal characters who are not present
  and not manually pinned. Destinations are authored `connections`; the choice
  is a deterministic hash of `characterId + dayIndex`. The player never moves.
  During combat, movement is suppressed unless
  `worldTick.allowNpcMovesDuringCombat` is on (factions and threats still move).
- **Rumors** — up to `rumorsPerTick` `ADD_EVENT`s tagged
  `['offscreen', 'tick', 'tick:<n>', …]` with a `headline` and no protagonist
  involvement. Text comes from authored templates in `data/agendas.json`.

## Authored pacing: `data/agendas.json`

```json
{
  "schemaVersion": 1,
  "defaults": {
    "factionInfluencePerDay": 0.5,
    "mainThreatProgressPerDay": 1.0,
    "secondaryThreatProgressPerDay": 0.5,
    "maxFactionDeltaPerTick": 5,
    "maxNpcMovesPerTick": 2,
    "maxDaysPerTick": 14,
    "rumorsPerTick": 2
  },
  "seasons": {
    "s1dark": {
      "factionAgendas": {
        "clarity": { "influencePerDay": 1.0, "rumorTags": ["patrol", "conversion"] }
      },
      "threatPace": {
        "s1dark.threat.resistance": { "progressPerDay": 1.5 }
      }
    }
  }
}
```

Any missing season, faction, or threat uses the global defaults, so Sandbox and
future seasons never crash. A malformed document is rejected at load; the tick
logs it and continues with the defaults. Sub-unit per-day rates accumulate in
`flags.worldTick.carry*` instead of being lost to rounding.

Rumor templates may use `{faction}`, `{threat}`, and `{location}`. Templates are
resolved season-level first, then from `defaults.rumorTemplates`. A faction's
`rumorTags` are **event tags** added to its rumors (used by the feed and
newspaper), not template selectors.

## Caps and long absences

A 60-day gap is clamped to `maxDaysPerTick` and the remainder is recorded in
`flags.worldTick.suppressedDays`; it is never applied as one 100-day delta.

## Idempotency

`flags.worldTick` (baselines, `totalDays`, `suppressedDays`, rumor ids, carry)
is written in the same atomic `applyEventBatch` as the events. Re-running with
no elapsed day is a no-op, and a failed pass leaves state byte-identical.

## Where the output appears

- The overlay "City Desk / Off-screen" feed shows recent off-screen events;
  `map.showOffscreen` (default `true`) turns that section off.
- The newspaper and `[NEOTERRA_NEWS]` consume tagged events when enabled.
- The Domain tab's feed shows off-screen, knight, corruption, and beat items.

## Settings

`settings.worldTick`:

- `enabled` (default `true`)
- `allowNpcMovesDuringCombat` (default `false`)

## Files

- `src/flows/world-tick.js` — planner and flow.
- `src/data/agendas.js` — load and validate `data/agendas.json`.
- `src/agents/state-tracker.js` — pipeline stage.
