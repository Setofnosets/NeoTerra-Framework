# Character card fidelity: aliases, goals, skills, traits, and form-stable metadata

## Meta
- Slug: character-card-fidelity
- Status: complete (2026-11-19) - steps 1-6 implemented in one commit landed with this doc update; `npm run check` green. Step 7 closed as "not needed" (counts in `docs/data-schema.md`).
- Date: 2026-11-19
- Related: `plans/fix-codex-mount-and-card-profiles.md` (parser + profiles + backfill), `plans/character-creator-spike.md` (generated-card shapes), `docs/data-schema.md` §"Character profiles"

## Summary
- **Goal:** stop the Codex from showing empty Aliases, Goals, Skills, and Traits while dumping a whole card section into Abilities. Derive those fields from the card text at build time, seed them into `CharacterState`, keep them per form, and make the active form drive aliases/tags (so a swap updates them) — not just appearance and abilities. Then close the loop: goals become the steering signal the trackers rewrite and the narrator reads, so a character's goals drive what they do next.
- **Context:** `data/characters/profiles.json` is generated from `Chars/**/*.json` by `tools/build-data.mjs` → `parseCardProfile` (`src/data/card-profile.js:374`). Today `skills` is hardcoded `[]` (`src/state/world-state.js:241`), `traits` is only `splitListText(personality || speech)` and requires ≥2 short items (`world-state.js:162-165`), `goals` exists only when a card uses one of five goal labels (`card-profile.js:58`), aliases are parsed by a separate weaker regex (`tools/build-data.mjs:202`) and are ignored by the profile parser entirely (`card-profile.js:184-187`), and `abilities` is the raw prose block (`card-profile.js:296`) rendered as one long bullet (`src/ui/codex.js:1462`). `detail.profile.aliases/tags` read the **base** registry entry (`codex.js:864-865`), so a form swap never updates them.

## Current State (from exploration)
Pipeline:
1. **Build:** `readCardsFromDirectory` (`tools/build-data.mjs:665`) → `parseCard` (`:319`, reads only `data.name`, `data.description`, `data.tags`) → entry (`:339-357`) with `parseAliases` (`:202`), `parseSide` (`:251`), `parseThreatLevel` (`:303`). `buildProfiles` (`:580`) runs `parseCardProfile` over `data.description` and writes `profiles.json`. PNGs are decoded by `tools/png-card.mjs:133`.
2. **Runtime:** `loadRegistry` (`src/data/registry.js:21`) + `loadProfiles` (`src/data/profiles.js:25`).
3. **Seed:** `seedCharacter` (`src/state/world-state.js:209`) copies `goals`, `abilities` (`splitListText(card.abilities)`), `traits` (`listLikeTraits`), `skills: []` (`:235-249`); one overlay per form via `buildFormProfilesFor` (`:178`) → `buildFormProfileOverlay` (`src/state/form-profiles.js:41`).
4. **Swap:** `TRANSFORM` (`src/state/reducer.js:321-409`) → `applyFormProfileOverlay` over `FORM_PROFILE_FIELDS` (`form-profiles.js:14-23`).
5. **Render:** `buildDetail` (`src/ui/codex.js:775`) → `renderDetail` (`:1365`) prints Aliases/Tags/Goals/Abilities/Skills/Traits at `:1459-1466`; `renderCardProfile` (`:1297`) prints Personality/Speech/Background/Identity/Occupation/Faction/Combat style/Gear/Weakness — **never Abilities**.

Numbers from the current artifacts:
- `data/characters/index.json`: 78 entries, **21 with `"aliases": []`** (e.g. `s1.aurelia.longshot`, whose card says "a superhero known as Longshot" but has no `Aliases:` line).
- `data/characters/profiles.json`: `goals` is empty for most profiles; `s1.atropos.couple` lists `missing: ["goals","occupation","faction","combatStyle","gear","weakness"]`.
- Alias merging bug: `s3.blood.bound.corrupted.emeral.allure` gets the single alias `"Blood Bound Emerald Allure"` because the card separates names with parentheses (`Aliases: Blood Bound (supervillain name) Emerald Allure (former superhero name). Tessa Ervone (civilian name).`) and `parseAliases` strips parentheticals and only splits on `.`/`;`/newline (`tools/build-data.mjs:218-225`).
- Goal plumbing is half-wired: `goals` is a valid tracker path (`src/agents/state-tracker.js:39,51`) and the Storyline schema/validator both accept it (`src/agents/storyline.js:92,489-502`), but neither prompt shows the current goals (`state-tracker.js:216-217` prints Skills/Traits only; `storyline.js:298-308` lists factions and threats only). The model can technically write goals but cannot see the ones it should revise, which is why goals never move.

Key files: `src/data/card-profile.js`, `tools/build-data.mjs`, `data/characters/{index,profiles,overrides}.json`, `src/state/{world-state,form-profiles,reducer}.js`, `src/ui/codex.js`, `src/context/worldbook.js:100-169`, `src/agents/form-architect.js:161-222`, `tests/{card-profile,build-data,codex,world-state,form-profile}.test.js`.

Landmines:
- Alias parsing exists twice (build tool + none in the profile parser). Any fix must unify or the registry and the profile will disagree.
- `parseCardProfile` merges `[...actorSections, ...preamble]` (`card-profile.js:405`) — preamble fields must not overwrite actor fields.
- `buildFormProfileOverlay` returns `null` for bundle cards (`form-profiles.js:42`), so bundles keep base-only values.
- `manualFields` is read (`reducer.js:375`, `form-profiles.js:75`) but **never written**, so nothing is actually protected on swap.
- `mergeCardProfileIntoCharacter`/`backfillCardProfiles` (`codex.js:699,742`) only fill **empty** fields, so on a chat that was seeded before this change, values must be filled by a migration, not by the import button.
- `form-architect.js:165` joins `overlay.abilities` into a prompt block; `character-creator.js:467-491` uses the same `listLikeTraits` heuristic. Both must accept the new shapes.
- `styles like "New Traits:"` exist on some cards (`S1Dark/Bittersweet (Knighted Poisoness).json`) and are currently `extras` (`card-profile.js:279`).

## Constraints & Requirements
- **Tech stack:** build scripts are Node ESM; the parser is browser-safe and must stay dependency-free. Everything generated stays deterministic (`npm run check` fails on stale artifacts).
- **Determinism first:** the primary extraction must be deterministic regex/heuristics over the card text. An LLM pass is optional, preview-gated, and never part of `build:data`.
- **State contract:** new per-form values live in the existing `formProfiles[id]` overlay. Existing `CharacterState` fields are reused (`skills`, `traits`, `goals`, `abilities`); no new top-level state keys without a schema bump.
- **Content gate:** raw card text stays ungated in storage; gating stays at render/prompt time (`src/core/content-gate.js`).
- **Out of scope:** rewriting the cards themselves, changing `Chars/` content, portrait/avatar work, season roster changes, the character creator's generated-card schema beyond the shared helpers.

## Decisions & Assumptions
Decisions (approved 2026-11-19):
1. **Tags and aliases follow the active form.** A swap updates them; the base entry is only the fallback when the active form has no card metadata.
2. **Goals come from explicit card labels only** (`Goals/Motives`, `Goals/Motive`, `Goal/Motives`, `Motive`, `Ultimate Goal`, and the new `Goals`/`Motivation`/`Ambition`/`Objective` aliases). No prose mining, no invention at seed time.
3. **Goals exist to drive character actions.** The card gives the starting goals; from then on the trackers own them and the narrator reads them. `SET_CHARACTER_FIELDS.goals` replaces the whole list (`src/state/reducer.js:1138-1140`), so every update sends the complete new set.
4. **The state tracker updates the player's goals; the Storyline tracker updates NPC goals.** Confirmed 2026-11-19. The state tracker is player-only by design (`Report only the player character`), so NPC goal revision belongs to the Storyline pass and no extra NPC paths are added to the state tracker.
5. **Abilities render as a list of short descriptions, never a paragraph.** ≤6 visible, remainder behind "Show all"; each item ≤120 chars.
6. **Existing chats:** fill empty fields only, plus a per-character "Re-derive from card" action in the Codex.
7. **One manual escape hatch:** "Reset goals to card" in the Codex, with a confirmation. It restores the card's labelled goals; it never runs automatically and is not part of "Re-derive from card".

Assumptions:
1. `skills` = short, actionable capability items ("gravity manipulation", "pyrokinetic blasts", "short-range teleport"); `traits` = passives/qualities ("superhuman physiology", "regeneration", "agile", "sadistic"); the `abilities` tile becomes the structured summary, not the raw prose.
2. The raw prose stays reachable under "From the character card", so shortening the tile costs no information.
3. Derivation is deterministic and best-effort for skills/traits/abilities; goals are label-only at seed time.
4. A goal written by a tracker is a live value and outranks the card; the Codex shows the live list and the card list as "From card".
5. A goal is only useful if the narrator sees it: both prompt builders must render the current goals next to the agenda, within a fixed budget.

## Step-by-Step Implementation Plan

### 1. Unify and fix alias extraction
- **Files:** `src/data/card-profile.js`, `tools/build-data.mjs`, `data/characters/index.json` (regenerated), `tests/card-profile.test.js`, `tests/build-data.test.js`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** export `parseAliases(description)` from `card-profile.js` and make `build-data.mjs` use it (delete the duplicate). Stop ignoring alias labels in `classifyLabel`; emit `aliases` on the profile. Split names on `.`, `;`, newlines, `/`, `,`, and parenthetical role markers (`X (supervillain name)` → `X`), keep at most ~6 per card, drop fragments >60 chars or containing `:`; also derive aliases from the preamble pattern `known as '?X'?` and `is X, a …` when no alias label exists. Deduplicate case-insensitively against `displayName`.
- **Acceptance criteria:** `s3.blood.bound…` yields `["Blood Bound","Emerald Allure","Tessa Ervone"]`; `s1.aurelia.longshot` yields `["Longshot","Aurelia Selwind"]`; `s1dark.carol.bleeding-heart` keeps its override list; cards with no alias information still return `[]`; the build is byte-stable across runs and `--check` passes.
- **Risk:** medium (artifact regeneration + override precedence)
- **Model / Effort:** standard #medium
- **Commit:** `fix(data): parse card aliases once and split compound lists`

### 2. Pure facet derivation for skills, traits, and ability summaries
- **Files:** `src/data/card-facets.js` (new), `tests/card-facets.test.js` (new)
- **Depends on:** 1
- **Parallelizable:** yes
- **Expected behavior:** `deriveCardFacets(profile)` returns `{ skills, traits, abilitySummary }` (no goals — see step 3):
  - `abilitySummary`: an array of `{ lead, detail }` items, not strings. `lead` is the capability name (first clause or noun phrase, ≤40 chars, e.g. "Gravity manipulation"); `detail` is the one-line gloss (≤120 chars) that stays after the lead is removed, or `''`. Sentence-split the `abilities` prose on `.`/`;`, drop quoted dialogue, cap each item on a word boundary, dedupe, cap at 8 items. Items that cannot be split into a meaningful lead (e.g. a run-on with no comma/colon) are kept whole in `lead` with `detail: ''` rather than truncated mid-thought.
  - `skills`: items whose sentence matches an active-capability pattern (`can <verb>`, `creates`, `shoots`, `summons`, `teleports`, `controls`, `manipulates`, `wields`, `casts`) — max 6, ≤60 chars each.
  - `traits`: passive patterns (`superhuman physiology`, `regenerat*`, `agile`, `durab*`, `immortal`, `flight`, `senses`, `hypnosis`) plus explicit trait labels (see step 3); the card's `weakness` stays separate and is never folded into traits.
  - Deterministic, no IO, no clocks; returns empty arrays rather than guesses.
- **Acceptance criteria:** unit tests over at least 6 real cards assert: `s1.vaiva.colorgarde` gains ≥3 abilities and ≥1 trait; `s3.blood.bound…` yields the stolen-power skills; `S4/Brie Anderson-Hula Hawk` yields energy-ring skill + flight trait; every `abilitySummary` item has a non-empty `lead` of ≤40 chars and a `detail` of ≤120 chars; no `lead` is a whole paragraph; identical output on repeat; nothing is emitted for a card with an empty abilities block.
- **Risk:** medium (heuristic quality)
- **Model / Effort:** glm-5.3 #high (this is the quality-critical piece)
- **Commit:** `feat(data): derive structured skills, traits, and ability summaries from card prose`

### 3. Label vocabulary, explicit goals, and the profile artifacts
- **Files:** `src/data/card-profile.js`, `tools/build-data.mjs`, `data/characters/profiles.json` (regenerated), `docs/data-schema.md`, `tests/card-profile.test.js`, `tests/build-data.test.js`
- **Depends on:** 1, 2
- **Parallelizable:** no
- **Expected behavior:** add labels: `Skills`/`Skill`, `Traits`/`Passives`, `Goals`, `Motivation`/`Motivations`, `Drive`, `Main drive`, `Ambition`, `Objective`, `New Traits`, `Corrupted Traits`, `Former Traits`. `New Traits`, `Corrupted Traits`, `Former Traits` become form-scoped trait text attached to the nearest form (or the active form), not `extras`. Profile gains `aliases`, `skills`, `traits`, `abilitySummary`, and `goals`; `abilities` keeps the raw prose because the card block renders it. **Goals are label-only:** `goals` is populated exclusively from the goal labels above, split by `splitListText`, capped at 5 items of ≤160 chars. No background/personality mining. Fill `skills`/`traits`/`abilitySummary` from `deriveCardFacets` after labelled parsing so a label wins and prose only fills the gap. `missing` reports `skills`/`traits` when both label and derivation come up empty, and keeps reporting `goals` for the many cards that have no goal label.
- **Acceptance criteria:** `s1.vaiva.colorgarde` goals stay whatever the card explicitly labels (empty is acceptable and honest); cards that do label goals yield them; `s1dark/bittersweet` `New Traits` lands in traits, not `extras`; record the before/after counts (profiles with goals/skills/traits, and how many cards still have no label) in `docs/data-schema.md`; `npm run build:data && npm run build:data -- --check` is green; profile schema docs match the artifact; bundle cards keep per-actor facets.
- **Risk:** medium
- **Model / Effort:** standard #medium
- **Commit:** `feat(data): expose goals, skills, traits, and ability summaries in profiles`

### 4. Seed and swap the new facets per form
- **Files:** `src/state/world-state.js`, `src/state/form-profiles.js`, `src/state/reducer.js`, `src/state/migrations.js`, `src/agents/form-architect.js`, `tests/world-state.test.js`, `tests/form-profile.test.js`, `tests/reducer.test.js`
- **Depends on:** 3
- **Parallelizable:** no
- **Expected behavior:** `seedCharacter` seeds `skills`, `traits`, `goals`, and `abilities` from the profile (fallback to today's behaviour when absent). `FORM_PROFILE_FIELDS` gains `skills`; `buildFormProfileOverlay` copies `skills`, `goals`, `traits`, `abilities` (summary items, not raw prose), plus `aliases`/`tags` from the form's registry entry. `TRANSFORM` therefore swaps all of them. **Goal protection:** goals are plot-owned once the trackers write them, so `TRANSFORM` keeps live goals unless the player explicitly resets to the card (tracked via `manualFields`/a `goalsSource: 'card' | 'live'` marker rather than an implicit overwrite). `manualFields` becomes writable (Codex edits record the field name) so a player tweak survives a swap. Add a world-state migration (fill-empty only) that backfills existing chats from `profiles.json`. `form-architect` accepts/produces overlay `skills` and `traits` (its prompt block at `:161` includes them) with the same caps.
- **Acceptance criteria:** a fresh season seeds non-empty skills/traits for cards with derivable facets and goals only from explicit labels; `TRANSFORM` changes abilities+skills+traits and aliases+tags together, changes goals only when they are still card-sourced, and preserves stamina/willpower/relationships; a tracker-written goal survives a swap and a reload; an old world without the fields migrates once and is idempotent; Architect output validates against the reducer; an Architect-generated form with skills round-trips.
- **Risk:** high (state shape + migration + swap semantics)
- **Model / Effort:** glm-5.3 #high
- **Commit:** `feat(state): seed and swap card-derived skills, traits, and goals per form`

### 5. Codex: active-form metadata and a compact ability list
- **Files:** `src/ui/codex.js`, `style.css`, `tests/codex.test.js`
- **Depends on:** 4
- **Parallelizable:** no
- **Expected behavior:**
  - Resolve `activeEntry = byId[character?.formId] ?? byId[selectedId] ?? entry`; `detail.profile.aliases/tags/side/threatLevel/formKind` come from `activeEntry`, with `baseAliases`/`baseTags` exposed as a hint ("Base: …") when the form differs. This is the tags-on-swap fix.
  - **Abilities is a list of short descriptions, not a paragraph.** Each item is one capability with a short gloss when the card has one (`Gravity manipulation — lightens or weights herself and touched objects`). Items render as a `<ul>`: the bold lead on its own line, the gloss beneath it in muted text. Max 6 visible, remainder behind `<details><summary>Show all (n)</summary>`. Never render a raw sentence run as the tile body.
  - Tiles: Aliases, Tags, Goals, Skills, Traits, Likes, Dislikes stay. The lead/detail split is computed in step 2, so the markup never guesses.
  - **Goals show live first, card second:** `profile.goals` is the live value (tracker-editable); when the card has different goals, add a muted "From card" line under the tile rather than replacing it. Empty live goals with a card value show the card value with a "From card" badge; empty in both shows "No goals recorded in the card" (honest, since goals are label-only).
  - Move the raw `abilities` prose into `renderCardProfile` as a labelled paragraph (`cardParagraph('Abilities', card.abilities)`), so the full text is still available and no longer dominates the sheet.
  - Add a per-character "Re-derive from card" button next to "Import card profile" that overwrites the derived skills/traits/abilities for that one character, behind a confirm, and **never touches goals**.
  - Keep all existing `data-neoterra-*` hooks used by tests.
- **Acceptance criteria:** swapping a form updates Aliases/Tags/Skills/Traits/Goals/Abilities in one paint with no page reload; the Abilities tile renders a list of ≤6 short lead+gloss items and the raw text is reachable under "From the character card"; no ability item is a paragraph; live goals survive a repaint and the card value is shown as such; every tile has a non-ambiguous empty state; `tests/codex.test.js` covers form-driven aliases/tags and the lead/detail split; the player panel and prompt renderer keep working with the shorter values.
- **Risk:** medium
- **Model / Effort:** standard #medium
- **Commit:** `feat(codex): show active-form metadata and compact ability lists`

### 6. Goals drive character behavior (tracker-owned, reset available)
- **Files:** `src/agents/state-tracker.js`, `src/agents/storyline.js`, `src/context/worldbook.js`, `src/context/renderer.js`, `src/ui/codex.js`, `src/state/reducer.js`, `tests/state-tracker.test.js`, `tests/storyline.test.js`, `tests/world-state.test.js`, `tests/codex.test.js`
- **Depends on:** 4
- **Parallelizable:** yes (after 4)
- **Expected behavior:** goals are not decoration — they are the steering signal the narrator reads and the trackers rewrite.
  - **Player:** `buildStateTrackerPrompt` (`src/agents/state-tracker.js:216-217`) already prints Skills and Traits but **not** Goals, though `goals` is a valid tracker path (`:39`, `:51`). Add `Goals: …` and `Agenda: …` lines, plus rules: emit goals only when the prose shows the character choosing or abandoning a course; return the **complete** new list because `SET_CHARACTER_FIELDS.goals` replaces the array (`src/state/reducer.js:1138-1140`); keep ≤5 items; never invent a goal the prose does not support. Distinguish `agenda` (what they are doing now) from `goals` (what they are steering toward).
  - **NPCs:** the state tracker is player-only ("Report only the player character", `state-tracker.js:252`), so NPC goals come from the Storyline tracker. `buildStorylinePrompt` (`src/agents/storyline.js:253-354`) never shows the cast's current goals even though its schema already accepts `characters[].goals` (`:92`) and the validator already emits `SET_CHARACTER_FIELDS.goals` (`:489-502`). Add a compact `## Cast` block (`id — side — agenda — goals — mood`) and the same replace-the-whole-list rule.
  - **Behavior:** confirm that the narrator actually receives them — `buildProfileLines` (`src/context/worldbook.js:137-140`) and `renderCharacter` (`src/context/renderer.js:228-229`) already print `Goals:`; extend them to also print `Agenda:` next to goals so a changed course is legible in the prompt, and cap the combined line (≤240 chars) so five long goals cannot bloat the prompt. The scene/agents should be able to act on a goal like "corrupt Vaiva" without the card being re-read.
  - **Reset:** the Codex gets an explicit **"Reset goals to card"** action (confirm dialog) that restores the card's labelled goals and clears the live source. It is a manual escape hatch; the normal path is tracker updates.
  - **Protection:** tracker-written goals are live values; a form swap must not overwrite them (step 4's `goalsSource`), and the fill-empty migration must not touch them.
- **Acceptance criteria:** both prompts contain the current goals and agenda; a fake tracker output that changes goals produces `SET_CHARACTER_FIELDS` and the reducer applies it as a full replacement; an unchanged goal set produces no event; a goal edit is visible in `buildProfileLines`/`renderCharacter` on the next turn; a tracker-written goal survives a form swap, a reload, and a migration; "Reset goals to card" restores the card list and is idempotent; prompt growth stays within the stated caps; existing tracker/storyline tests stay green.
- **Risk:** medium–high (behavioral change in two agents plus prompt budget)
- **Model / Effort:** glm-5.3 #high
- **Commit:** `feat(agents): make goals a tracker-owned steering signal`

### 7. Optional enrichment for skills and traits only (conditional, not planned by default)
- **Decision (2026-11-19): not needed for this pass.** The deterministic pass covers 57/78 profiles with skills, 59/78 with traits, and 61/78 with an ability summary; 52 cards legitimately have no goal label. The remaining gaps are mostly cards whose `Abilities:` block describes an ordinary human. Numbers are recorded in `docs/data-schema.md`. The enricher remains unbuilt and off by default; no `agents.cardEnricher` setting is added.
- **Files:** `src/agents/card-enricher.js` (new), `src/core/constants.js`, `src/core/defaults.js`, `src/ui/codex.js`, `tests/card-enricher.test.js` (new)
- **Depends on:** 3, 5, and an explicit go/no-go after the step-3 numbers
- **Parallelizable:** no
- **Expected behavior:** only if the step-3 counts show that derivation still leaves most cards with empty skills or traits, add a best-effort agent modeled on the Form Architect (`src/agents/form-architect.js`): one call per character, schema `{ skills[], traits[] }` (no goals — goals are plot-owned, not card-owned), strict caps, prompt includes the card profile and season threats, output stored under `flags.cardEnrichment[charId]` with `approved:false`, surfaced in the Codex as "Suggested" with Accept / Discard / Regenerate. Never writes `data/`. Off by default (`agents.cardEnricher.enabled:false`). If the deterministic counts are acceptable, close this step as "not needed" and record the numbers.
- **Acceptance criteria:** deterministic path unchanged when off; a fake runner produces a schema-valid suggestion; nothing applies without Accept; rejecting keeps the deterministic values; goals are never written by this agent; the agent log records the call.
- **Risk:** medium
- **Model / Effort:** standard #medium
- **Commit:** `feat(codex): suggest card skills and traits with an opt-in enricher`

## Verification & Testing
- **Status: complete (2026-11-19).** Steps 1-6 and the automated checks below were run together as one change set; `npm run check` (build-data `--check`, `node --check`, all `tests/*.test.js` - 1052 tests - and the smoke test) passes. Manual checks below are the live-QA script; the code and tests close them.
- **Automated checks (run after every step):**
  - `node --test tests/card-profile.test.js`
  - `node --test tests/card-facets.test.js`
  - `node --test tests/build-data.test.js`
  - `node --test tests/world-state.test.js tests/form-profile.test.js tests/reducer.test.js`
  - `node --test tests/codex.test.js tests/player-panel.test.js`
  - `npm run build:data && npm run build:data -- --check`
  - `npm run check` (full build checks, `node --check`, `tests/*.test.js`, smoke test)
- **Manual checks** (SillyTavern via `C:\Users\locua\OneDrive\Escritorio\KI\ST\SillyTavern\Start.bat`, `http://127.0.0.1:8000/`):
  1. Fresh season chat: open Codex → pick Vaiva, Carol (S1Dark), Blood Bound, Brie. Aliases/Goals/Skills/Traits are populated; Abilities shows ≤6 short items; the raw prose is under "From the character card".
  2. In an S1Dark chat, swap Carol Fate (`s1dark.carol.bleeding-heart`) to Cleansed / Infected / Phantom Heart (`data/form-groups.json:55-64`): aliases show the form's names, tags change, abilities/skills/traits/goals change, and stamina/willpower/relationships survive. Swap back: base values return. Note: the S1 group `s1.carol` contains only the corrupted card, so Twisting Fate cannot be swapped to yet — that data gap is out of scope here.
  3. Existing `Neo Terra — Director` chat (pre-change world): reopen; the migration fills empty facets once; re-opening does not duplicate or overwrite live values edited by the tracker.
  4. "Re-derive from card" on one character fills the missing pieces only after confirmation.
  5. Prompt check: inspect the rendered world-book block (`buildProfileLines`) and the tracker prompt — abilities/traits are short lines, not paragraphs; goals appear in both prompts; token count does not grow.
  6. A bundle card (Atropos Couple, Sensational Sirens) shows per-actor facets and does not silently drop actor text.
  7. Goals drive behavior: run a turn where the prose clearly changes a character's course. Confirm (a) the player tracker rewrites the player's goals, (b) the Storyline pass rewrites an NPC's goals, (c) the very next turn's world-book block shows the new goals next to the agenda, and (d) the change survives a reload and a form swap. Then press "Reset goals to card" and confirm the card list returns.
  8. Abilities layout: every item is a short lead line with an optional one-line gloss, never a wrapped paragraph; "Show all" reveals the rest.
- **Edge cases:** cards with no `Abilities:` label; cards with quoted dialogue inside Abilities; extremely long single-sentence abilities; `New Traits` on a base card; cards with no goal label (the common case — goals stay empty until the plot writes them); generated characters (`gen.*`) that never had a card; a form whose profile is missing (`profileMissing`); repeated swaps; a tracker-written goal then a swap; import/backfill run twice; old chats with a `formId` no longer in the registry.
- **Rollback:** `profiles.json` and `index.json` are generated — reverting the tool step and re-running `build:data` restores the old artifacts. State migration is fill-empty only, so reverting leaves valid (just less populated) worlds. The enricher is off by default and its output is per chat.
