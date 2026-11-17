# Brief — neoterra-framework-v1 / Step 12

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 12.
- **Title:** Lore Agent, relationships, and lorebook writes.
- **Depends on (already committed):** Steps 4, 5, 8. (Step 11 is being implemented separately; do not depend on its files.)
- **Route:** implement-hard (high risk: mutating shared SillyTavern world info and relationship state).
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies. No data regeneration. Preserve every existing public export and test.
- **Verification:** use `"/mnt/c/Program Files/nodejs/node.exe"` for Node (plain `node` is not on PATH). Baseline is 195 passing tests.

## Objective
Add the Lore Agent: every N turns it summarizes recent events into compact, durable lore entries, chooses which existing entries to inject, and proposes bounded relationship updates. Commits go to the chat-scoped lorebook using the canonical SillyTavern world-info entry shape and stable generated IDs. Relationship state stays in `WorldState`; duplicate/near-duplicate lore entries are merged; injection selection respects the token budget; generated lore entries can be removed when the chat world is reset.

## Files
- `src/agents/lore.js` (new)
- `src/context/worldbook.js` (extend; preserve all existing character-book behavior)
- `src/state/selectors.js` (extend with relationship selectors)
- `tests/lore.test.js` (new)

Do not modify `src/context/renderer.js`, `src/context/budget.js`, `src/state/reducer.js`, `src/state/world-state.js`, or any existing test files. Use the existing reducer events (`RELATIONSHIP_DELTA`, `PLAYER_RELATIONSHIP_DELTA`) and `applyEventBatch` from `src/flows/initiative.js`.

## Existing code to reuse (read before coding)
- `src/context/worldbook.js`: `ST_WORLD_INFO_ENTRY_DEFAULTS`, `buildWorldBookDocument`, `buildWorldBookEntry`, `parseGeneratedEntryId`, `mergeWorldBookDocuments`, `createWorldBookAdapter`, `entryList`, `estimateTokens`. Character entries use `WORLD_BOOK_MARKER = 'neoterra:character:'`. Lore entries must use a **separate** marker so character and lore merges never replace each other.
- `src/context/budget.js`: `estimateTokens`, `truncateToTokens`.
- `src/state/reducer.js`: `RELATIONSHIP_DELTA` accepts `{ type:'RELATIONSHIP_DELTA', a, b, relationshipType, affinityDelta, tensionDelta, notes, sinceTurn }` and clamps affinity/tension to `[-100,100]`, storing one undirected record per pair. `PLAYER_RELATIONSHIP_DELTA` does the same for a custom persona (`withCharacterId`).
- `src/flows/initiative.js`: `applyEventBatch(store, events, { context, log })` applies atomically and validates.
- `src/agents/state-tracker.js`: `createX({ runner, getSettings, log })` + `plan`/`run` + `request.propose` test seam, `AgentAbortedError` handling.
- `src/agents/prompts.js`: `renderPromptTemplate`.
- `src/core/content-gate.js`: `applyContentGate`.
- `src/core/defaults.js`: `agents.lore` cadence settings already exist (`everyNTurns:10`, enabled true).

## Implemented behavior

### 1. Lore entry model + SillyTavern writes (`src/context/worldbook.js`)
Add (do not break existing exports):
- `WORLD_BOOK_LORE_MARKER = 'neoterra:lore:'`.
- A `LoreEntryInput` shape: `{ id, title, keys[], content, tags[], importance?, depth?, order? }`. `id` is a stable, season-scoped key supplied by the agent/normalizer; treat it as opaque but sanitize into a safe marker segment.
- `buildLoreWorldBookEntry({ id, title, keys, content, tags, depth, order, uid, gateLevel, limits, maxTokens })`:
  - returns a **complete** ST entry by spreading `ST_WORLD_INFO_ENTRY_DEFAULTS`;
  - `key` is the deduped title + supplied keys + tag-derived keys (max 12, 100 chars each);
  - `comment` is `Neo Terra — Lore: <title> [${WORLD_BOOK_LORE_MARKER}${id}]`;
  - `content` is gated and trimmed to `maxTokens` (default 240);
  - `constant:false`, `selective:true`, `depth` default 4, `order` default 200;
  - return `null` for empty ids/content.
- `parseGeneratedLoreEntryId(entry)` (mirrors `parseGeneratedEntryId`) and `isGeneratedLoreEntry(entry)`.
- `mergeLoreEntries(existingDocument, entries, { maxEntries = 200 } = {})`:
  - preserve all non-generated entries (user entries);
  - preserve generated **character** entries untouched;
  - replace a generated lore entry when the same lore id is proposed again (stable id ⇒ no duplicate after retries);
  - **merge near-duplicates**: normalize text (lowercase, strip punctuation/whitespace, token set) and treat exact normalized equality or token Jaccard ≥ 0.85 as the same entry. Merge keys (union), take the longer content, keep the lower/stable id, and keep a single entry. Deterministic order (sort by id) and reindex `uid` to 0..n-1.
  - never throw on partial documents; return `{ name, entries }`.
- `removeGeneratedLoreEntries(document)`: remove only `neoterra:lore:` entries, keep character and user entries, reindex `uid`. This is the reset/cleanup primitive (Step 12 does not wire a live reset command).
- `selectLoreEntriesForInjection({ entries, state, maxTokens = 900, gateLevel = 'full', limits = {}, maxEntries = 8 })`:
  - accept a world-book document, an entries array, or the output of `mergeLoreEntries`;
  - consider generated lore entries only (user entries are handled by SillyTavern itself);
  - score by keyword overlap with the current location name, present character names/ids, scene framing, and the last 5 `recentEvents` summaries/headlines; stable tie-break by order/id;
  - apply the content gate, then fill entries until `maxTokens` using `estimateTokens`; skip entries that cannot fit (never exceed the budget);
  - return `{ selected: [{ id, title, content, entry }], text, tokens, dropped }`, with `text` suitable for the `[NEOTERRA_LORE]` block (one entry per line).

### 2. Lore Agent (`src/agents/lore.js`)
- Export `LORE_SCHEMA` (dependency-free subset):
  ```
  {
    entries: [{ id?, title, keys[], content, tags?, importance? }]     // <=5
    selections: [{ id, reason? }]                                      // <=8
    relationships: [{ a, b, type, affinityDelta?, tensionDelta?, notes? }] // <=8
    rationale: string
  }
  ```
  `type` must be one of `likes|dislikes|attraction|rivalry|owner/servant|ally|neutral` (add this as `RELATIONSHIP_TYPES`). `affinityDelta`/`tensionDelta` numbers in `[-100,100]` at schema level; clamp further in normalization.
- Export `LORE_RELATIONSHIP_MAX_DELTA = 20`.
- `buildLorePrompt({ state, season, recentProse, recentMessages, candidates, existingEntries, presentCharacterIds, settings })`:
  - includes turn/date/act/scene, present cast (id + display name + status), recent events (last 8), existing lore entry titles/short contents for selection, and the recent prose/messages;
  - instructs the agent to use only supplied ids, never invent characters, write compact entries (≤120 words), and propose relationship deltas only when the prose supports them;
  - includes the response schema;
  - applies the content gate.
- `normalizeLoreResult({ result, state, season, gateLevel, limits })` (pure; never throws for bad model output):
  - **entries:** require a non-empty title and content; derive a stable id as `${state.seasonId}.lore.${slugify(title)}` when the agent omits `id`; sanitize supplied ids to `[a-z0-9._-]`; cap at 5; dedupe by id (merge keys, keep longer content); apply the content gate; reject empty/duplicate-after-gate entries.
  - **selections:** accept only ids present in `existingEntries` or `entries`/candidate list; dedupe; cap at 8.
  - **relationships:** require two known sides. Canonicalize existing-character pairs lexicographically (`a < b`) so reciprocal proposals merge into one event; dedupe/combine deltas per pair; bound each delta to `±LORE_RELATIONSHIP_MAX_DELTA`; drop zero-delta entries with no type/notes; reject self-targets and unknown ids. If one side is the custom player (`player.identity === 'custom'` and the agent uses the literal `player` or `custom-player` sentinel, or the played canon id) use `PLAYER_RELATIONSHIP_DELTA` for a custom persona and `RELATIONSHIP_DELTA` for a canon player. Never write a relationship record that references an id absent from `state.characters` (custom player excluded because it lives in `state.player`).
  - Return `{ entries, selections, relationshipEvents, rejected, notes, rationale }`.
- `createLoreAgent({ runner, getSettings, log })`:
  - `plan(request)` supports `request.propose({ prompt, schema })`;
  - `run(request)`: if `settings.agents.lore.enabled === false` return `{ enabled:false, calls:0, entries:[], relationshipEvents:[], selections:[] }` with no runner call. Abort errors rethrow; other failures log and return an empty result without throwing.
- `applyLoreRelationships(store, result, { context, log } = {})`: apply `result.relationshipEvents` atomically with `applyEventBatch`; return `{ ok, state, error }`. No events ⇒ no write (byte-identical state).
- `runLorePass({ store, agent, adapter, bookName, season, recentProse, recentMessages, existingDocument, candidates, settings, signal, log })`:
  1. Read the existing document through `adapter.read(bookName)` when not supplied.
  2. Run the agent.
  3. Apply relationship events atomically.
  4. Build lore ST entries with `buildLoreWorldBookEntry`, merge with `mergeLoreEntries`, and save through `adapter.save(bookName, document)` only when the document changed.
  5. Return `{ ran, source, entries, relationships, selections, document, saved, error }`. A failed agent pass makes no state or book write. A failed save must not roll back the relationship state already applied; report the error and return `saved:false`.
- Also export `slugifyLoreId`, `normalizeLoreText`, and `loreEntriesSimilar` for tests (or keep them internal and test through the public merge/selection functions).

### 3. Relationship selectors (`src/state/selectors.js`)
Add pure selectors that never mutate:
- `selectRelationships(state, { characterId = null, presentOnly = false, type = null, minAffinity = null } = {})`: returns cloned relationship records; `presentOnly` uses the same presence rule as `selectPresentCast` and keeps records where either side is present; `characterId` keeps records involving that character; `type` filters exactly; `minAffinity` filters by affinity.
- `selectRelationshipBetween(state, a, b)`: returns the record regardless of stored `a`/`b` order, or `null`.
- `selectPresentRelationships(state)`: convenience wrapper for the prompt block's "relationships involving present characters" rule. Keep the output shallow-cloned so callers cannot mutate state.
- Do not remove or rename `selectBadEnds`/existing selectors.

### 4. Tests (`tests/lore.test.js`)
Use the real registry/season/locations data like other tests. Seed a store with `createWorldStateStore`, and use an in-memory adapter (`createWorldBookAdapter` with fake `loadWorldInfo`/`saveWorldInfo`) for lorebook writes.

Cover at minimum:
1. **Schema:** empty and populated valid lore results pass `validateJsonSchema`; invalid relationship types fail.
2. **Normalization:** custom-player relationship becomes `PLAYER_RELATIONSHIP_DELTA`; canon-player relationship becomes `RELATIONSHIP_DELTA`; reciprocal `a/b` proposals merge into one event; deltas are clamped to ±20; self-target/unknown ids are rejected.
3. **Atomic relationships:** `applyLoreRelationships` applies all events or none; malformed batch leaves state byte-identical.
4. **ST entry shape:** `buildLoreWorldBookEntry` has `key`, `comment` with the lore marker, `content`, `depth`, `order`, `uid`, `constant:false`, `selective:true`, and parses back through `parseGeneratedLoreEntryId`.
5. **Stable retry:** committing the same normalized entries twice (or merging the same document again) yields no duplicate lore entries and the same ids.
6. **Near-duplicate merge:** two entries with the same meaning but different punctuation/casing collapse to one entry with merged keys.
7. **Preserve character/user entries:** `mergeLoreEntries` keeps generated `neoterra:character:` entries and plain user entries.
8. **Removal/reset:** `removeGeneratedLoreEntries` removes lore entries only, leaves character/user entries, reindexes uids.
9. **Budget selection:** with a small `maxTokens`, the returned text never exceeds the budget; relevant entries are preferred over unrelated ones; `dropped` reports the rest.
10. **Disabled agent:** no runner call, no relationship write, no book save.
11. **Agent failure/abort:** failure leaves state and book unchanged; abort propagates.
12. **Full pass:** fake agent result → relationships stored in `WorldState`, lore entry saved with a valid ST shape, selection list respected, and a second pass with the same result does not duplicate entries.
13. **Present-only selector:** a relationship involving only offscreen characters is excluded by `selectPresentRelationships`; `selectRelationshipBetween` is order-independent.
14. **Injection shape:** `selectLoreEntriesForInjection` returns `text` suitable for the lore block and includes only generated lore entries.

## Acceptance criteria (from the plan)
- Writes valid ST entries (`keys`/`name`/`content`/`depth`/`insertion_order` equivalents).
- No duplicate event entries after a retry.
- Relationship deltas are bounded and symmetric where required.
- Injection selection respects the token budget.
- Deleting/resetting the chat world can remove its generated book entries (primitive provided).
- No regression in the existing 195 tests.

## Out of scope
- Wiring the cadence into the live chat hook (Step 9/20 integration) and the Codex UI.
- Changing the character world-book materializer's behavior or marker.
- Ending/bad-end files from Step 11; do not import them.
- `src/context/renderer.js` changes; it already renders relationships involving present characters.

## Verification commands
```bash
cd "/mnt/c/Users/locua/OneDrive/Escritorio/KI/extensions/NeoTerra-Framework"
"/mnt/c/Program Files/nodejs/node.exe" --check src/agents/lore.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/context/worldbook.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/state/selectors.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js
```

## Attempts
### Attempt 1 — reviewer changes requested (address all of these)
1. **Major — read failure must never wipe the book.** `runLorePass` must distinguish "book absent" from "read failed". Add a strict read result to the world-book adapter (for example `readResult(name)` → `{ ok, document, error }`) while preserving `read()` behavior, and in `runLorePass` return `{ saved:false, ran:false, error }` without saving when the read failed. `null`/absent document may proceed as a new book.
2. **Major — relationship idempotency across retries.** A retried `runLorePass` with the same agent result must not double-apply deltas, and a failed save must not cause double application on retry. Add a deterministic per-event idempotency key (include the turn plus pair/type/deltas/notes) in `normalizeLoreResult`; `applyLoreRelationships` must skip events whose key is already recorded in `state.flags.lore.appliedRelationshipKeys`, record newly applied keys bounded to the last 200, and apply the flag patch atomically through `applyEventBatch`. Add tests: a second identical pass in the same turn leaves affinity unchanged; the same result on a later turn applies once.
3. **Minor — prompt gating context.** `applyContentGateToPrompt` for the lore prompt should not use `{ isPlayer: true }` for the whole prompt; use a non-player context (or omit it).
4. **Minor — `minAffinity` selector.** Keep records with missing/non-numeric affinity rather than silently dropping them.
5. **Minor — carry entry metadata.** Pass normalized `depth`/`order` through to `buildLoreWorldBookEntry` (defaults remain 4/200); either use `importance` as a deterministic tie-break or remove it from the documented shape.
6. **Nit — tighten player sentinels** to `player`/`custom-player` only.
7. **Nit — missing runner** should return `ran:false` with a reason instead of `ran:true` with zero writes.

Re-run `node --check` on the three JS files and the full test suite; report the count.
