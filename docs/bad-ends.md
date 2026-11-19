# Bad ends (opt-in)

A bad end is a **character-level** terminal state. It is distinct from the
season-level villain victory.

`badEnds.enabled` is **false** by default. While it is off, nothing is detected,
stored, or shown, and no bad-end agent call is made.

## Types

| Type | Meaning | Typical triggers |
| --- | --- | --- |
| `death` | Character is dead | Stamina 0 + lethal intent, declared kill |
| `identity-loss` | Original self is overwritten | Max corruption, completed brainwashing, possession |
| `autonomy-loss` | Self aware but control is gone | Enslavement, conditioning, curse, mind control |
| `corruption` | Permanent monstrous/alternate form | Max-stage transformation, failed cleanse |
| `imprisonment` | Indefinitely contained, no escape | Capture + no rescue path |
| `retirement` | Removed from play without death | Exile, depowering, coma |

## Detection

When enabled, the Bad End Detector runs after the turn pipeline's trackers:

1. **Deterministic predicates first**: stamina/willpower at 0 with lethal or
   capture intent, maximum corruption, completed brainwashing/possession, a
   permanent form rule, or captivity with no escape path.
2. Only ambiguous cases go to the LLM for confirmation (`badEnds.minConfidence`,
   default 0.6).
3. A bad end is never inferred from prose alone.

The panel is mounted by the shell only while `badEnds.enabled` is on and the
current player character has a stored bad-end record. Turning the feature off
disposes the panel and stops all detector calls.

## Record

A confirmed state emits `RECORD_BAD_END` and stores:

```json
{
  "type": "identity-loss",
  "severity": "major",
  "cause": "Completed brainwashing",
  "sourceCharacterId": "s1.claire.atropos",
  "sourceFactionId": "clarity",
  "turn": 42,
  "date": "2043-08-11",
  "locationId": "clarity-hq",
  "epilogueText": "One to three paragraphs...",
  "playableAs": true,
  "continuityKey": "<season timeline key>",
  "reversibility": "declared-rule",
  "notes": ""
}
```

The character also carries `status: 'dead' | 'lost' | 'imprisoned'` and keeps
their last known state. Records are written exactly once per character per
`continuityKey`; they are never silently deleted or duplicated.

The epilogue is stored once and reused. It is not regenerated every turn.

## Continuation

After the epilogue the player chooses:

1. **Continue as the bad-ended character** — available when the state still
   permits agency (`autonomy-loss` as a servant, `corruption`, an imprisonment
   escape arc), or for `death` only when `badEnds.allowDeadContinuation` is
   enabled (ghost, legacy, or flashback). Goals and labels follow the altered
   state.
2. **Continue as someone else** — switch POV to an eligible character or a new
   custom persona. The bad-ended character stays in the world with the record,
   relationships, and journal intact; the Cast Director and State Tracker
   retarget atomically.
3. **End here** — stop at the epilogue; the world stays viewable.

## Consistency and reversal

- A bad-ended character is never silently resurrected or duplicated.
- Cleansing/reversal is legal only through a declared rule (for example an
  antidote or a form rule). It updates the record/status while keeping the
  historical entry.
- Records survive chat reloads, world export/import, and identity switches.
- The Codex shows a bad-end badge and the stored epilogue; the journal has a
  Bad Ends section.

## Settings

- `badEnds.enabled` — master switch (off by default).
- `badEnds.allowDeadContinuation` — off by default.
- `badEnds.minConfidence` — LLM confirmation threshold.
- `badEnds.prompt` / `badEnds.epiloguePrompt` — editable, with reset buttons.
  The default detection prompt lists the deterministic predicates and forbids
  inferring a bad end from prose alone.

Tests: `tests/bad-end.test.js`.
