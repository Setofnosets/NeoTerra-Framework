# Canon beats and deadlines

The Canon Beat Ledger keeps a season recognizable without railroading it. A
beat states the **function** that must happen "in some form"; the Storyline
Tracker decides whether observed events satisfy it, whether it must be adapted,
or whether it has become impossible.

## Beat shape

```json
{
  "id": "s4.opening.claire-returns",
  "order": 10,
  "title": "Claire Returns",
  "description": "Claire reappears in public and makes the first move.",
  "act": "opening",
  "conditions": {
    "turnRange": [0, 12],
    "dateRange": { "from": "2043-06-01", "to": "2043-06-30" },
    "locationIds": ["clarity-hq", "central-plaza"],
    "actorIds": ["s4.claire.atropos.recorrupted"],
    "threatStage": 1,
    "requiresBeats": [],
    "forbidsBeats": []
  },
  "completion": {
    "type": "event",
    "predicates": [{ "kind": "event-tag", "tag": "public-return" }]
  },
  "flexibility": "adaptable",
  "deadlineTurns": 12,
  "deadlineDate": "2043-06-15",
  "deadlineConsequence": "Clarity moves in silence; a hero is converted offscreen.",
  "rewriteHints": "A broadcast, a public execution, or a corporate coup all count."
}
```

- `act` is one of `opening`, `escalation`, `climax`, `resolution`.
- `flexibility`:
  - `strict` — the function must land close to the written event.
  - `adaptable` — a substitute actor, location, or equivalent event is allowed.
  - `optional` — may be skipped without escalation.
- `conditions` decide when the beat is **eligible**, not when it happens.
- `completion.type` groups predicates: `event`, `state`, `relationship`,
  `threat`, `transformation`.
- Supported predicate kinds: `event-tag`, `character-status`,
  `location-control`, `threat-stage`, `relationship-affinity`, `form-active`,
  `beat-resolved`, `flag`.
- `deadlineTurns` / `deadlineDate` are **soft**. At least one should be set on
  every beat; `deadlineConsequence` is mandatory and must describe a concrete
  escalation (threat progress, lost ally, lost location, targeted loss).
- **Optional side beats** (`flexibility: "optional"`, id segment `.side.`) may
  set both deadlines to `null`. They never escalate the threat clock and never
  gate act progression. Use them for civilian-life and downtime content.
- `rewriteHints` tells the tracker how to preserve the function if the cast or
  map has diverged.

## What the tracker may do

Every Storyline pass receives the current act's open beats and either:

1. **Resolves** a beat whose predicates are satisfied by observed events.
2. Emits a **nudge** that sets up the next eligible beat.
3. Marks the beat **deferred** with a reason.
4. Marks the beat **adapted**, recording `adaptedFrom` / `adaptedTo` (actor,
   location, or event substitution).
5. Marks the beat **short-circuited** when its premise is impossible (for
   example, the main villain was defeated in Act 1), then re-plans the next
   act around the new state.

Beat status is monotonic: `open → resolved | adapted | short-circuited`. A beat
does not silently reopen. The event log plus `WorldState.beats` is the audit
trail; the Continuity Auditor flags beats that were narrated but never
recorded, or recorded without support.

## Deadlines and pressure

`beatDeadlinePressure` (default `standard`) scales how harshly missed deadlines
resolve:

| Setting | Behavior |
| --- | --- |
| `off` | Deadlines are recorded but no consequence fires |
| `generous` | Escalation is delayed/softened |
| `standard` | The declared consequence fires at the deadline |
| `harsh` | Consequences compound sooner |

Missing a deadline never blocks the story. It makes the world worse and
re-plans the next act. The map overlay previews the next 1-2 beat titles as
rumors/headlines and shows a divergence indicator.

## Side beats and downtime

S1 and S1Dark each carry two optional side beats (`s1.side.*`,
`s1dark.side.*`). They are civilian-life prompts: a favor at the docks, a
shelter shift, a knight's proving, a city census. They have no deadline, no
threat escalation, and no act-gating effect.

The deterministic downtime flow exposes **Rest, Train, Patrol, Investigate,
Socialize, and Work**. Each action advances one clock slot, applies a small
bounded change to stamina/willpower, and writes one `downtime` Journal event.
No agent call is made, so downtime works with every agent disabled. The
civilian-life event table lives in `data/agendas.json` under `downtime`.

## Ending pilot

S1 and S1Dark ship season-specific deterministic epilogues in
`season.epilogue.paragraphs`. They are rendered with `{{victor}}`,
`{{faction}}`, `{{location}}`, `{{fates}}`, and `{{player}}` placeholders and
respect `ending.paragraphs`.

Dynamic Epilogue-agent prose is behind `ending.dynamic` (default **false**,
review required). When enabled, the generated epilogue is stored once and is
never regenerated on reload.

## Final deadline and villain victory

A playable season declares:

```json
"finalDeadline": { "turns": 120, "date": "2043-12-31" },
"failureState": "villain-victory"
```

When the final deadline passes (or the main threat reaches its terminal stage),
the season ends once with a recorded **villain victory**. The epilogue and
continuation choices are described in `endings.md`. Early villain defeat is a
legal win: the tracker records the divergence, promotes a successor threat if
needed, and schedules resolution beats for the consequences.

## Authoring checklist

- One or more beats per act for every non-sandbox playable season.
- Every beat has a declared consequence and rewrite hints.
- Predicates reference real IDs and statuses.
- `requiresBeats` / `forbidsBeats` form a resolvable DAG with no cycles.
- The final deadline is reachable but not trivially short.
- Test with `node --test tests/beats.test.js tests/storyline.test.js`.
