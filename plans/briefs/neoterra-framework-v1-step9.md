# Brief — neoterra-framework-v1 / Step 9

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 9.
- **Title:** Storyline Tracker agent and Canon Beat Ledger.
- **Depends on:** Steps 4, 5, 8 (all committed).
- **Route:** implement-hard (high risk).
- **Status:** implemented and verified locally.
- **Runtime rule:** dependency-free ESM, browser-safe modules. No new dependencies, no data-file changes, no manifest/package/index changes.

## Objective
Add the Architect, Storyline Tracker, Continuity Auditor, and initiative/cadence hook for the Canon Beat Ledger. Agents are pure planners returning reducer-shaped events; one flow applies a pass atomically so a failed or aborted pass leaves state byte-identical.

## Files
- `src/agents/architect.js` (new)
- `src/agents/storyline.js` (new)
- `src/agents/auditor.js` (new)
- `src/data/beats.js` (extended with lifecycle helpers)
- `src/flows/initiative.js` (new)
- `src/flows/travel.js` (new; initiative hook only)
- `src/state/reducer.js` (minimal additive events required by the step's acceptance criteria)
- `tests/beats.test.js` (new)
- `tests/storyline.test.js` (new)

### Reducer extension note
Step 9's acceptance criteria require `short-circuited` beats, faction influence, location status, character goals/allegiances, scene framing, and threat status changes. Step 4's reducer had no events for those fields. Step 9 therefore adds **additive** events only: `SET_FACTION_INFLUENCE`, `SET_LOCATION_STATUS`, `SET_CHARACTER_FIELDS`, `SET_SCENE_FRAMING`, `SET_THREAT_STATUS`, `SHORT_CIRCUIT_BEAT`, plus `SET_PLAYER_FIELDS` / `PLAYER_RELATIONSHIP_DELTA` shared with Step 10. Existing events are unchanged.

## Implemented behavior
- **Architect:** schema-validated one-shot bootstrap. Emits `MOVE_CHARACTER`, `SET_CHARACTER_FIELDS`, `ADD_EVENT`, `SET_SCENE_FRAMING`; rejects player edits and unknown ids; deterministic fallback makes no state changes; abort rethrows; disabled setting makes no call.
- **Storyline Tracker:** deterministic pass resolves satisfied predicates, short-circuits impossible strict climax/resolution beats, promotes a successor when every main threat is defeated (once), escalates/deferrs overdue soft deadlines, and fires the final deadline once as a recorded `villain-victory` ending. The agent pass may update factions, threats (monotonic progress/stage), characters, locations, transformations (declared rules only), events, beats, and framing. Player-controlled characters are rejected. Failed/aborted passes return unchanged state.
- **Cadence/initiative:** `shouldRunStoryline` honors `everyNTurns`, location changes, force, disabling, and the ending screen; `createInitiative` applies architect/storyline events atomically with `applyEventBatch`, persists `flags.storyline` (last turn/location/source), and runs the auditor read-only.
- **Travel hook:** `createTravelInitiativeHook` / `notifyTravel` notify the Storyline Tracker after a completed move and never throw on tracker failure.
- **Auditor:** deterministic checks for narrated-but-unrecorded beats, recorded-without-support beats, ending/threat/bad-end mismatches; optional read-only agent pass merges findings; never returns events.
- **Beats helpers:** current act, upcoming beats, eligibility/deadline checks, impossible/satisfied beat lists, primary/successor threat selection, lifecycle event planning, ledger summary.

## Verification
- `node --check` on every touched file.
- `node --test tests/*.test.js`: **195 pass / 0 fail** (Step 9 added 24 tests).
- Required cases covered: on-schedule resolution, adaptation after dead/captured actors, early main-villain defeat (short-circuit + successor), missed soft deadline escalation, final deadline villain victory, narrated-but-not-recorded auditor finding, multi-threat S4, threat clamping, form-rule transformations, failed/aborted pass byte-identical state, replay determinism, cadence, atomic initiative apply, travel hook.

## Out of scope (later steps)
- Epilogue prose/choice screen (Step 16).
- Map overlay rendering of beats/factions/threats (Step 15).
- Full travel graph (Step 14).

## Review resolution
- Fixed `PLAYER_RELATIONSHIP_DELTA` to copy the borrowed relationship array/objects before mutating (reducer immutability contract).
- Replaced local faction/location status lists in `storyline.js` with the canonical `FACTION_STATUSES` / `LOCATION_STATUSES` imports so a schema-valid value cannot be rejected atomically later by `validateWorldState`.
- Tightened the auditor's prose heuristic to require the beat title (removed the generic first-word fallback).
