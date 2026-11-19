# Character Creator — Spike A follow-up (best-effort card drafting)

## Meta
- Slug: `character-creator-spike`
- Status: **implemented (2026-11-18)** — amber override granted for the best-effort, preview-gated scope; all three steps done: `f38dac8`, `c1927ed`, `15af622`
- Date: 2026-11-18
- Evidence: `plans/character-creator-spike-report.md` (6 live generations, scores, failure taxonomy)
- Upstream: `plans/neoterra-experience-audit.md` (proposal B.11, spike A, decision 6)

## Summary
- **Goal:** add a small, best-effort character creator: a short concept produces a non-canon Neo Terra card in the house voice, previewed with **Keep / Regenerate / Cancel**. Nothing is written to `data/`; nothing is auto-approved.
- **Context:** the audit gates the Card Architect on a green spike. The spike is **amber**: one-pass generation with 3 exemplars and a hard-limit block produced keep-worthy cards 4/5 times (avg 4.2/5), but 1 run truncated and 2 runs drifted structurally/canonically. The plan's strict bar (0 schema failures, 0 canon contradictions, no review) is not reachable with one call. Human preview is the safety gate, so the production feature is scoped to that.

## Current State (from exploration)
- **One LLM path:** `src/agents/client.js:256` sends, extracts, validates and repairs once (`:310-425`). `src/agents/runner.js:40` adds chat affinity and abort.
- **Precedent to copy:** Form Architect (`src/agents/form-architect.js`) = schema → validate → store under `flags.generatedForms` → Codex badge + Approve/Regenerate/Export (`src/ui/codex.js:1353,1748,1776`).
- **Profile/card shapes:** `parseCardProfile` (`src/data/card-profile.js:374`) and `data/characters/profiles.json`; card envelope in `Chars/S1/*.json`; `downloadJson` at `src/ui/download.js:6`.
- **Prompt rendering:** `buildProfileLines` (`src/context/worldbook.js:93`) renders live `CharacterState`; `selectPresentCast` (`src/state/selectors.js:8-26`) falls back to location residents.
- **Key files:** `src/state/reducer.js` (HANDLERS `:216`), `src/state/world-state.js` (`seedCharacter` `:209`), `src/data/seasons.js` (`:607` roster), `src/agents/cast-director.js` (`:68-86` manual pool), `src/core/content-gate.js` (`:189`).
- **Landmines:** no `ADD_CHARACTER` event; `CharacterState` has no `personality`/`speech`; `flags.manualCharacters` gates the Cast Director; world-book materialization skips non-roster ids; `validateWorldState` requires `charId === key` and a real `locationId`; the live connection defaults to a `:thinking` model that can return empty `content` when `max_tokens` is small.

## Constraints & Requirements
- **Tech stack:** vanilla ES modules, no runtime dependencies, Node 20 for tests only. DOM-safe; no repository writes from the browser.
- **State contract:** `WorldState` stays the only authority; the reducer never calls an LLM and accepts only a pre-validated payload. Generated cards live in `flags.generatedCards` and export with the world.
- **Safety:** non-canon only. No roster membership, no `data/` mutation, no world-book materialization, visible “Generated · non-canon” badge, warning list in the preview.
- **Simplicity:** one generation call per attempt, one regenerate-on-failure, no critique/auditor chain, no automatic approval gate.
- **Out of scope:** guest/cross-season generation, canon replacement, AI image generation, PNG packing of generated cards, multi-card batch generation, editing the generated card field-by-field (Regenerate is the edit).

## Assumptions & Decisions

### Assumptions
1. The creator is available only when a world exists (it needs the season bible and a location).
2. The card is stored per chat and survives reload, including the optional portrait.
3. Portraits are optional and user-supplied; no image generation.
4. Agent model overrides are available per agent, so the creator can use a non-thinking model or a larger budget (`maxTokens: 9000`, `timeoutMs: 180000`). Live QA on the current reasoning-model connections showed smaller budgets are consumed by hidden reasoning; when no model is pinned, the creator strips a trailing `:thinking` and uses the base model of the same deployment.
5. A generated character does not need to reach SillyTavern's world book to be useful; the prompt cast block is enough.
6. The user is the second reviewer and has final say on any generated card; there is no separate review step before Keep.

### Decisions (approved 2026-11-18)
1. **Amber override granted:** proceed with the best-effort creator + mandatory preview; do not build the critique/auditor chain.
2. **Portrait persistence:** the portrait survives reload — store a downscaled data URL (target ≤ 128 KB) in `flags.generatedCards[charId].portrait`; initials when absent.
3. **Entry point:** Codex → Characters → **“Create character”**. No Session Home or Settings entry.
4. **Voice in state:** add `personality` and `speech` to generated `CharacterState`, rendered in the cast block at **≤ 180 chars each** so the prompt budget is unaffected.
5. **Starting location:** the current scene location. The character appears in the present cast immediately after Keep.
6. **Review:** the user is the second reviewer and final authority; the rubric is advisory, not a gate.

## Step-by-Step Implementation Plan

### 1. Card assembly, validation, and prompt builder (pure)
- **Files:** `src/agents/character-creator.js` (new), `tests/character-creator.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** A pure module with: `CHARACTER_CREATOR_SCHEMA` (fields, types, caps); `buildCharacterCreatorPrompt({ season, factions, districts, locations, exemplars, concept, settings })`; `assembleCardDescription(card)` producing the labelled block in house order with the `[{{char}} is …` preamble; `validateGeneratedCard(value, { registry, season, districts })` returning `{ ok, value, warnings, blockedReason }`; `normalizeGeneratedCard` applying the validation matrix (clamp at 1.25× on a sentence boundary, `{{char}}:` rewrite, canon-link drop, forbidden strings, year check, weakness check); `buildGeneratedCharacter(card, { seasonId, season, locationId, turn })` returning the `CharacterState`-shaped object plus `profile` and `card`. No DOM, no IO, no store access.
- **Acceptance criteria:**
  - Unit tests cover: valid card passes; missing `background` blocks; a `firstMes` containing `Setting/World:` blocks; a name colliding with the registry blocks; a `canonLinks` id outside the bible is dropped with a warning; `mesExample` label rewrite; cap clamping; forbidden string blocks; year-after-era blocks; powered card with empty weakness blocks.
  - `assembleCardDescription` output round-trips through `parseCardProfile` to the same field values (property test over the sample cards).
  - Deterministic: same input → identical output.
- **Risk:** low–medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(creator): validate and assemble generated character cards`
- **Status:** done — `f38dac8` (2026-11-18)

### 2. Agent, settings entry, and the add-character reducer event
- **Files:** `src/core/constants.js`, `src/core/defaults.js`, `src/agents/prompts.js`, `src/agents/character-creator.js`, `src/state/reducer.js`, `src/state/world-state.js`, `src/agents/cast-director.js` (read-only check), `tests/character-creator-agent.test.js`, `tests/world-state.test.js`
- **Depends on:** 1
- **Parallelizable:** no
- **Expected behavior:** Add `characterCreator` to `AGENT_IDS` (`constants.js:37`) and a default config beside `formArchitect` (`defaults.js:235`) with `maxTokens: 9000`, `timeoutMs: 180000`, `enabled: true`, and a short default prompt. `createCharacterCreator({ runner, getSettings })` builds the prompt from the live season + registry + profiles, runs one request (no client schema; the prompt carries it, and the agent retries once at 1.5× on a structural failure), validates, and returns `{ ok, value, character, profile, card, warnings, blockedReason, prompt }`. When no model is pinned in settings it maps a `:thinking` connection model to its base variant. It never mutates state. Add reducer event `ADD_GENERATED_CHARACTER`: requires a pre-validated `character` with a `gen.` id, a resolvable non-null `locationId` (the current scene location), unique id, and a `profile`; inserts into `state.characters`, appends the id to `flags.manualCharacters`, writes `flags.generatedCards[charId] = { card, profile, portrait: null | dataUrl, model, generatedAt, approved: false, warnings }`, calls `syncPresence`, and never overwrites an existing id. Generated characters also carry `personality` and `speech` (each rendered at ≤ 180 chars including the label), which `buildProfileLines` renders as two short lines so the voice reaches the prompt without budget growth.
- **Acceptance criteria:**
  - A fake runner returning a valid card produces an `ADD_GENERATED_CHARACTER` event that `applyWorldEvent` accepts; the character appears in `selectPresentCast` when placed at the scene location.
  - Duplicate ids, unknown locations, and malformed payloads are rejected without partial writes.
  - `flags.manualCharacters` includes the id; the Cast Director's pool admits it.
  - The generated character's `personality`/`speech` render as two short lines (≤ 180 chars each) in the cast block without exceeding the profile token cap.
  - Disabling the agent in settings results in zero runner calls.
  - `npm run check` passes; existing world snapshots still validate.
- **Risk:** high (state contract + validation)
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(creator): add the character creator agent and a generated-character event`
- **Status:** done — `c1927ed` (2026-11-18)

### 3. Codex preview with Keep / Regenerate / Cancel, and export
- **Files:** `src/ui/codex.js`, `style.css`, `src/ui/download.js` (reuse), `docs/data-schema.md`, `tests/creator-ui.test.js`
- **Depends on:** 2
- **Parallelizable:** no
- **Expected behavior:** A **“Create character”** button in the Characters tab opens a concept form (name optional, role select, concept textarea required, powers/limits optional, ties optional, content note optional, optional portrait file). Submitting runs the agent once and shows a **preview** built from the same section renderer as the Codex detail, with the “Generated · non-canon” badge, the warning list, and Keep / Regenerate / Cancel. The optional portrait is downscaled to 256×256 and stored as a data URL (target ≤ 128 KB) on Keep; initials when absent. Keep dispatches `ADD_GENERATED_CHARACTER` at the current scene location and closes; Regenerate discards and re-runs with the same concept (button disabled while running); Cancel discards. A retained card shows in the Codex roster with the same badge and an “Export card JSON” action using `downloadJson`. Errors show a single message plus Regenerate; a `finish_reason: length` or structural failure triggers one automatic retry with `maxTokens × 1.5`. Generated profiles are read from `flags.generatedCards` when the registry has no entry.
- **Acceptance criteria:**
  - A keep-worthy draft can be previewed, kept, regenerated and cancelled on the live S1 chat.
  - Keep makes the character visible in the Codex, in the current location's present cast, and in the prompt cast block (verify with a turn).
  - A kept card with a portrait still shows the portrait after a page reload; a kept card without one shows initials.
  - Regenerate never leaves two characters behind; Cancel writes nothing.
  - Export produces a `chara_card_v3` JSON that imports into SillyTavern.
  - The badge and warning list are visible; no Settings/agent controls leak into the creator.
  - Works at 390×844 (single-column preview, usable buttons).
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(codex): preview, keep, and export generated character cards`
- **Status:** done — `15af622` (2026-11-18)

## Verification & Testing
- **Automated (after every step):**
  - `npm run check`
  - `node --test tests/character-creator.test.js`
  - `node --test tests/character-creator-agent.test.js`
  - `node --test tests/creator-ui.test.js`
  - `node --test tests/world-state.test.js`
- **Manual (live, S1 Director chat):**
  1. Create “Mara Voss / Neon Wraith” from the report's concept; confirm the preview matches the Codex layout and the badge is visible.
  2. Keep; run a turn; confirm the character appears in the prompt cast block and the Codex.
  3. Regenerate twice; confirm no duplicates, no orphaned ids, and `flags.generatedCards` has one record.
  4. Cancel; confirm `state.characters` and `flags` are unchanged.
  5. Force a failure (disconnect the model mid-generation) and confirm the error state offers Regenerate and leaves state untouched.
  6. Export; import the JSON into SillyTavern as a card and confirm the description sections survive.
  7. Reload the chat; confirm the generated character persists, the portrait persists, and the badge remains.
  8. User sign-off: the user reviews each kept/discarded card and has final say; no separate reviewer pass is required.
- **Edge cases:**
  - `finish_reason: length` → one larger retry, then a clear failure.
  - Reasoning model with small `max_tokens` → empty content → error, not a silent empty card.
  - Name collision with Clara/Claire/Carol style duplicates.
  - A concept for another season's era (must stay in the current season).
  - Chat switch mid-generation (runner aborts; no character is added to the new chat).
- **Rollback:** steps 1–2 are additive (new module, new event, new flag); deleting the module and the setting entry removes the feature. Step 3 can be reverted independently; kept characters remain playable because they are plain `CharacterState` entries.

## Notes for the implementer
- Do **not** reuse the Form Architect's prompt verbatim; the card needs `firstMes`, `mesExample`, tags, and canon links, and it must state a weakness.
- Do **not** call a second LLM for critique or canon checking. The deterministic matrix is the contract; the preview is the quality gate.
- Do **not** write generated cards into `data/`, `Chars/`, or the world book.
- If the user later wants a stronger guarantee, the cheapest upgrade is a seeded, fixed "best of two" generation (same concept, two samples, keep the higher-scoring draft by the rubric), not an auditor chain.
