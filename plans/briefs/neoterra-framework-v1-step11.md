# Brief — neoterra-framework-v1 / Step 11

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 11.
- **Title:** Bad-end states and continuation (opt-in).
- **Depends on (already committed):** Steps 4, 5, 9, 10.
- **Route:** implement-hard (high risk: irreversible character state and identity change).
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies. No data regeneration. Preserve every existing public export and test.
- **Verification:** use `"/mnt/c/Program Files/nodejs/node.exe"` for Node (plain `node` is not on PATH). Baseline is 195 passing tests.

## Objective
Add an opt-in bad-end subsystem. When `settings.badEnds.enabled === false` (the default), the subsystem must make **zero LLM calls and zero writes**. When enabled, deterministic predicates run first; only ambiguous cases may ask the model for confirmation. A confirmed state is recorded exactly once per character per continuity key with a stored 1–3 paragraph epilogue. The player may then continue as the bad-ended character (when state and settings allow), continue as someone else, or end here.

## Files
- `src/agents/bad-end.js` (new)
- `src/flows/bad-end.js` (new)
- `src/ui/bad-end.js` (new)
- `src/state/reducer.js` (extend only where noted)
- `src/core/defaults.js` (extend)
- `src/core/migrations.js` (extend normalization for any new setting)
- `src/ui/settings.js` + `src/ui/settings.html` (extend: reset-to-default prompt buttons)
- `data/schemas/bad-end.schema.json` (new)
- `tests/bad-end.test.js` (new)

Do not modify `src/context/**`, `src/agents/client.js`, agent transport, or existing test files.

## Existing code to reuse (read before coding)
- `src/state/world-state.js`: `BAD_END_TYPES`, `BAD_END_STATUS`, `CHARACTER_STATUSES`, `validateWorldState`.
- `src/state/reducer.js`: `RECORD_BAD_END`, `REVERSE_BAD_END`, `SET_PLAYER_IDENTITY`, `applyWorldEvents`. `RECORD_BAD_END` already treats `event.type` as the envelope and the bad-end kind as `badEndType`; it is idempotent on `continuityKey`; it sets status via `BAD_END_STATUS` and preserves prior records.
- `src/flows/initiative.js`: `applyEventBatch(store, events, { context, log, patch })` for atomic apply. Reuse it; do not duplicate atomicity logic.
- `src/agents/state-tracker.js`: `buildStateTrackerPrompt` style, `playerView`, `AgentAbortedError` handling, and the `createX({ runner, getSettings, log })` + `plan`/`run` + `request.propose` test seam.
- `src/core/defaults.js`: `DEFAULT_BAD_END_PROMPT`, `DEFAULT_BAD_END_EPILOGUE_PROMPT`, `badEnds` settings already exist.
- `src/ui/settings.js`: generic `[data-neoterra-path]` controls; extend it for prompt reset without breaking that path.

## Implemented behavior

### 1. Deterministic detection (`src/agents/bad-end.js`)
Export a pure detector that never mutates state.

- **Types:** use `BAD_END_TYPES` from `src/state/world-state.js`; do not duplicate the list.
- **Predicates** (all read live `CharacterState`; evaluate every character):
  - `death`: `status === 'dead'`, or `stamina.current <= 0` **plus** an explicit lethal signal. Lethal signal may be `state.flags.lethalIntent === true`, `state.scene.combat` active with the character as participant, or lethal-intent keywords in the supplied latest message. Prose alone, without stamina 0 / status / flag, is never enough.
  - `identity-loss`: `corruption.stage >= maxCorruptionStage` (option `maxCorruptionStage`, default 3) **and** an explicit overwrite signal (`status === 'lost'`, `flags.brainwashed === true`, `flags.identityLoss === true`, or `flags.possessed === true`).
  - `autonomy-loss`: captured/imprisoned/enslaved state **and** `willpower.current <= 0`, or `flags.brainwashed === true` while captured; no escape signal. `flags.escapePath === false` strengthens it.
  - `corruption`: `corruption.stage >= maxCorruptionStage`, or the character's current `formId` is the target of a non-reversible (`reversibleBy == null`) form rule whose `trigger` is `corrupted`/`infected`/`poisoned`/`coldhearted`/`knighted`, or `badEndType === 'corruption'`.
  - `imprisonment`: `status === 'imprisoned'`, or `status === 'captured'` with `flags.escapePath === false`.
  - `retirement`: `status === 'retired'`.
- **Skip rules:** skip characters that already have a `state.badEnds[charId]` record whose `continuityKey` is the current key (no duplicate detection and no LLM call). Skip `bundle`/non-character ids? Cast characters only; a bad end for any `state.characters` entry is legal.
- **Continuity key:** explicit `continuityKey` when supplied, else `${state.seasonId}:${characterId}`.
- **Record fields:** `{ characterId, badEndType, severity, cause, sourceCharacterId?, sourceFactionId?, turn, date, locationId, playableAs, continuityKey, reversibility, evidence[] }`. `severity`: `major` for death/identity-loss, `major` for permanent corruption/imprisonment, `minor`/`moderate` for reversible cases. `cause` is a short evidence-based sentence, not prose invention.
- **Playability:** `death` ⇒ `playableAs = allowDeadContinuation`; `identity-loss`/`autonomy-loss`/`corruption`/`imprisonment`/`retirement` ⇒ `playableAs = true` when the character still exists in state.
- **Ambiguity:** a candidate is `ambiguous` only when there is partial deterministic evidence but the type cannot be chosen safely (for example captured + low willpower without a zero, or max corruption without an overwrite signal). A purely prose-only suspicion is **not** a candidate and must never reach the model.
- Export `evaluateBadEndCandidates({ state, message, recentProse, formRules, options })` returning `{ candidates, ambiguous, skipped }` and `evaluateBadEndRecord(...)` helper(s) used by tests. Keep it pure.

### 2. Agent wrapper
- Export `BAD_END_SCHEMA` (confirmation) and `BAD_END_EPILOGUE_SCHEMA` (epilogue text). Use the dependency-free schema subset already understood by `validateJsonSchema`.
  - Confirmation: `{ confirmed: boolean, type: enum(BAD_END_TYPES), severity: string|number, confidence: number 0..1, cause: string, sourceCharacterId?: string|null, sourceFactionId?: string|null, playableAs: boolean, reversibility: string, rationale: string }`, `additionalProperties: false`.
  - Epilogue: `{ epilogueText: string, minLength: 60, maxLength: 2400 }` plus optional `notes`.
- `buildBadEndPrompt({ state, message, recentProse, candidates, settings })`: use the user-editable `settings.badEnds.prompt` via `renderPromptTemplate` from `src/agents/prompts.js` (placeholders already documented: `{{character}}`, `{{state}}`, `{{recentEvents}}`, `{{limits}}`; add a `{{candidates}}` placeholder but keep the existing placeholders working). Include only the ambiguous candidates, the current character state, and recent events. Apply `applyContentGate` at `settings.contentGate` with `settings.contentLimits`.
- `buildBadEndEpiloguePrompt({ state, record, settings })`: use `settings.badEnds.epiloguePrompt`; require 1–3 paragraphs, consistency with cause/location/continuity, no resurrection, no wider-season resolution. Apply the content gate.
- `createBadEndDetector({ runner, getSettings, log })`:
  - `plan(request)` supports `request.propose({ prompt, schema })` for tests; deterministic candidates are returned without a propose call.
  - `run(request)`: if disabled, return `{ enabled:false, calls:0, records:[], ambiguous:[], prompt:'' }`. If enabled: evaluate deterministically, emit those candidates immediately, and only when `ambiguous.length > 0` call `runner.runAgent({ agentId:'badEnd', ... })` once with `BAD_END_SCHEMA`. Accept an ambiguous record only when `confirmed === true`, `confidence >= settings.badEnds.minConfidence` (default 0.6), and the type is valid. Abort errors rethrow; any other failure is logged and returns the deterministic records with `error`.
  - Never throw for malformed model output. Never write state.

### 3. Flow (`src/flows/bad-end.js`)
- `createBadEndFlow({ store, detector, runner, getSettings, season, context, log, now })`.
- `detectAndRecord({ message, recentProse, signal })`:
  1. If `settings.badEnds.enabled !== true`, return `{ enabled:false, calls:0, recorded:[], skipped:[], epilogues:[] }` and do not touch the store.
  2. Call the detector. For each confirmed record with no supplied epilogue, call the epilogue agent once (`runner.runAgent`, `BAD_END_EPILOGUE_SCHEMA`) or use a deterministic fallback epilogue from the recorded cause when the runner is unavailable/fails. Never let a failed epilogue block the record.
  3. Build `RECORD_BAD_END` events. Add one `ADD_EVENT` journal entry after a genuinely new record (`tags: ['bad-end', type]`, actor = character) but only when the record was not already present; this avoids duplicate journal entries on retries.
  4. Apply the whole batch atomically with `applyEventBatch` from `src/flows/initiative.js`, so a failure leaves state byte-identical.
  5. Return the stored record and epilogue, plus a `calls` count for tests.
- `listContinuationOptions({ state, characterId })`:
  - `self`: available when a record exists and (`record.playableAs` or `record.type !== 'death'` or `settings.badEnds.allowDeadContinuation`).
  - `other`: available; lists eligible canon characters (alive, not the bad-ended character, not a bundle) plus `custom`.
  - `end`: always available.
- `continueAsBadEnded({ characterId })`: applies `SET_PLAYER_IDENTITY` with `identity:'canon'`, the character id, and `allowDeadContinuation: settings.badEnds.allowDeadContinuation === true`. Reject when the option is unavailable with a clear error. The character keeps its altered status, goals, labels, and bad-end record; do not reset state.
- `continueAsSomeoneElse({ identity, characterId, displayName })`: applies `SET_PLAYER_IDENTITY`. Only alive non-bad-ended targets may be chosen as canon; a custom persona is always allowed. The old record, relationships, and journal stay intact.
- `endHere({ characterId })`: no character mutation; return `{ ended:true, characterId, record }`. Do not invent an ending.
- `reverseBadEnd({ characterId, reason, restoredStatus })`: apply `REVERSE_BAD_END` through the same atomic path. Preserve the historical record (reducer already does); do not delete it.
- Use `applyEventBatch` for every write. Reject unknown character ids.

### 4. Reducer extension (`src/state/reducer.js`)
- Extend `SET_PLAYER_IDENTITY` **only** to permit a canon target that is `status === 'dead'` when the target has a `state.badEnds[characterId]` record and `event.allowDeadContinuation === true`. Today it rejects `dead`/`missing`; preserve the rejection for missing characters and for dead characters without the explicit flag.
- Add a `CONTINUE_BAD_END` handler for the flow (keeps the continuation atomic and testable):
  - `action: 'self'`: equivalent to the extended `SET_PLAYER_IDENTITY` path above; requires an existing record and respects the death/`allowDeadContinuation` gate. Preserve the character's goals/labels/status and set `controlledBy: 'player'`.
  - `action: 'other'`: `identity: 'custom'` or `'canon'` with an alive target; same controlledBy swap semantics; the old bad-end record is untouched.
  - `action: 'end'`: no document change (return a cloned state; `applyWorldEvent` already clones). The flow may use this event or a no-op; do not add a fake ending.
  - Record a `flags.badEndContinuation = { characterId, choice, turn }` marker on `self`/`other` (validated as a plain flags object) so the UI can restore the choice.
- Do not change `RECORD_BAD_END`/`REVERSE_BAD_END` semantics; they are already correct and tested.

### 5. Settings and defaults
- `src/core/defaults.js`: add `badEnds.minConfidence: 0.6` (keep the existing prompt/epilogue defaults frozen). Do not change the default `enabled:false`.
- `src/core/migrations.js`: normalize `badEnds.minConfidence` to a number in `[0,1]` (default 0.6). Preserve unknown keys.
- `src/ui/settings.html`: keep the existing bad-end toggles and textareas. Add two reset buttons next to the prompt fields (for example `data-neoterra-reset-prompt="badEnds.prompt"` and `"badEnds.epiloguePrompt"`), plus a small hint that detection is opt-in.
- `src/ui/settings.js`: handle the reset buttons by writing the matching `DEFAULT_BAD_END_PROMPT` / `DEFAULT_BAD_END_EPILOGUE_PROMPT`, saving through `saveSettings`, repainting, and emitting `SETTINGS_CHANGED`. The existing `[data-neoterra-path]` change flow must remain intact. Preserve user edits across reloads.
- Add or extend the settings test only if necessary; `tests/bad-end.test.js` may assert defaults/migration.

### 6. UI (`src/ui/bad-end.js`)
Follow `src/ui/player-panel.js` patterns (pure view model + escaped markup + optional DOM mount).
- `buildBadEndView({ state, characterId, settings })`: record type, severity, cause, turn/date/location, stored epilogue text, reversal state, journal/journal entries for the character, and `options` from `listContinuationOptions`.
- `renderBadEndMarkup(view)`: escaped HTML showing the epilogue read-only, the recorded cause, a continuity-key hint, and the three continuation choices as buttons. Only render `self` when available. Show the `allowDeadContinuation` note for death. No inline styles, no hardcoded colors.
- `mountBadEndPanel({ root, store, flow })`: click handlers call `continueAsBadEnded` / `continueAsSomeoneElse` / `endHere`; refresh after success; report errors to a status line. Guard DOM access; pure rendering must work in Node.
- Codex/journal integration is deferred to Step 18, but the view model must expose enough data for it (bad-end badge data + epilogue).

### 7. Schema (`data/schemas/bad-end.schema.json`)
Document the persisted `WorldState.badEnds[charId]` record (all fields the reducer writes: `type`, `severity`, `cause`, `sourceCharacterId`, `sourceFactionId`, `turn`, `date`, `locationId`, `epilogueText`, `playableAs`, `continuityKey`, `reversibility`, `notes`, `records`, `reversed`, `reversedTurn`, `reversalReason`, optional `restoredStatus`) and the two agent response shapes. This file is documentation/tooling; validation remains in JavaScript.

## Required tests (`tests/bad-end.test.js`)
Use the real `data/characters/index.json`, `data/factions.json`, `data/locations.json`, `data/form-groups.json`, `data/form-rules.json`, and seasons `s1`, `s1dark` like other tests. Seed a store with `createWorldStateStore`.

Cover at minimum:
1. **Opt-in gate:** disabled settings produce zero detector/runner calls and byte-identical state (deep equal before/after).
2. **Deterministic death:** set player/NPC stamina to 0 + lethal signal; a record is created with no LLM call when a `propose` function is supplied.
3. **Deterministic identity-loss:** max corruption + brainwashed flag records without an LLM call.
4. **Ambiguous case:** partial evidence calls the model once; `confirmed:false` or low confidence records nothing; `confirmed:true` records. Malformed/failed model output leaves state unchanged.
5. **Never prose-only:** a prose message alone produces no candidate and no call.
6. **Idempotency:** running detection twice with the same continuity key writes one record and one journal entry; the second pass is a no-op.
7. **All six types:** deterministic cases for death, identity-loss, autonomy-loss, corruption, imprisonment, retirement.
8. **Continuation self:** identity-loss continuation preserves altered goals/labels and sets `controlledBy:'player'`; death continuation is rejected unless `allowDeadContinuation` is true, then allowed and preserved.
9. **Continuation other:** switch to another alive roster character and to a custom persona; the old record, relationship entries, and journal remain.
10. **End here:** no character mutation and the record stays.
11. **Reversal:** `REVERSE_BAD_END` keeps the historical record/type/epilogue, updates status/reversibility flags, and does not delete.
12. **Prompt editing:** an edited `badEnds.prompt`/`epiloguePrompt` is used in the built prompt and survives `migrateSettings`/reload; reset helpers restore the defaults. `minConfidence` migration/normalization works.
13. **Export/import round-trip:** JSON clone of the state (including `badEnds`) reloads through `createWorldStateStore`/metadata with an identical record. No new export format is needed.
14. **UI view:** view model exposes record + epilogue + available options; markup is escaped and includes only available choices.
15. **Abort:** an `AgentAbortedError` from the runner propagates and writes nothing.

## Acceptance criteria (from the plan)
- Disabled mode makes zero agent calls and writes nothing.
- Deterministic death/identity-loss record without an LLM call; ambiguous cases require confirmation and never record from prose alone.
- Record written exactly once per character per continuity key and never silently deleted.
- Continuing as the character preserves altered state/goals/labels; continuing as someone else leaves the record, relationships, and journal intact.
- Declared reversal updates the record/status while keeping history.
- Edited prompt persists across reloads.
- No regression in the existing 195 tests.

## Out of scope
- Codex/journal panels (Step 18), the ending screen (Step 16), and combat (Step 19).
- Wiring the flow into a live chat hook; Step 11 delivers the tested subsystem and UI view. Do not modify `index.js` or `src/ui/shell.js`.

## Verification commands
```bash
cd "/mnt/c/Users/locua/OneDrive/Escritorio/KI/extensions/NeoTerra-Framework"
"/mnt/c/Program Files/nodejs/node.exe" --check src/agents/bad-end.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/flows/bad-end.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/ui/bad-end.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/state/reducer.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js
```

## Attempts
### Attempt 1 — reviewer changes requested (address all of these)
1. **M1 — bind confirmed type to candidate evidence.** `normalizeConfirmation` must require the model's `type` to equal the ambiguous candidate's `badEndType` (or be one of that candidate's allowed types). Partial evidence must never be upgraded to an unrelated type such as `death`.
2. **M2 — bind confirmation to a character.** Add required `characterId` to `BAD_END_SCHEMA`, and accept a confirmation only when it matches an ambiguous candidate and its type. With multiple ambiguous candidates, do not apply a single answer to `ambiguous[0]`; either send one call per candidate or require per-candidate `characterId` in the response.
3. **m1 — self-continuation availability must match the write gate.** For death records, `self` is available only when the live `settings.badEnds.allowDeadContinuation === true` (and the record is playable); do not show a button that the reducer will reject.
4. **m2 — validate epilogue output** against `BAD_END_EPILOGUE_SCHEMA`; on validation failure use the deterministic fallback epilogue, never store a short/garbage epilogue.
5. **m3 — add a test** where confirmation succeeds but the epilogue call fails: the record must still be stored with the fallback epilogue.
6. **m4 — add tests** for (a) reducer `CONTINUE_BAD_END` with `action:'end'`, and (b) `listContinuationOptions` excluding characters with unreversed bad-end records from `other.characters`.
7. **n1 — align continuity-key fallback** with the reducer (`${state.seasonId}:${id}`).
8. **n2 — move the unreversed-bad-end target check** for `CONTINUE_BAD_END` `action:'other'`/canon into the reducer for parity with the flow.
9. **n3 — make `currentCharacterId` deterministic** when no character id is supplied (sorted or most-recently-updated, not insertion order).

Re-run the full verification commands and the existing 195-test baseline after these changes.
