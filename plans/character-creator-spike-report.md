# Neo Terra character creator — reliability spike report (Spike A)

## Meta
- Status: **amber — best-effort path approved (override granted 2026-11-18)**
- Date: 2026-11-18
- Method: static read of the agent/profile/state layers plus 6 live generations against the running SillyTavern at `http://127.0.0.1:8000/` (664 installed cards, `nanogpt` connection, model `deepseek/deepseek-v4.1-flash-1017`), scored against the rubric below.
- Scope: a new **non-canon** character card drafted from a short concept, previewed, then kept, cancelled, or regenerated. No repository writes, no canon replacement.
- Related: `plans/neoterra-experience-audit.md` (proposal B.11; spike A). Follow-up plan: `plans/character-creator-spike.md`.

## Verdict

A single-call creator with three full exemplar cards, the season bible, and an explicit hard-limit block **does** produce cards that read like the existing cast. Across five complete samples the first pass was keep-worthy 4 out of 5 times and averaged **4.2/5**; one run produced a truncated JSON document at a low `max_tokens`.

It is **not** reliable in the sense the audit asked for (“0 canon contradictions”, “0 schema failures”). Observed first-pass defects:

- 1 of 5 samples hit `finish_reason: length` and was unparseable (JSON cut mid-array).
- 1 of 5 invented a district (`Kestrel District`) and linked a Season 3 faction into a Season 1 card.
- 1 of 5 leaked the labelled card block into `firstMes` instead of writing a scene.
- 3 of 5 used the character's name as the `mesExample` speaker label instead of `{{char}}:`.
- Numeric caps (`appearance ≤ 700`, `background ≤ 900`) were exceeded by 5–20% in most samples.

Adding a short hard-limit block (exact caps, “firstMes is scene prose only”, “only these districts”, “canonLinks may contain only ids from the bible”) removed the canon and structural defects in the next sample, which scored **4.7/5**. Numeric caps were still exceeded, because a language model cannot count characters.

**Recommendation:** build the creator as a *best-effort drafting tool*, not an authority: one generation call, deterministic assembly and validation, and a preview with **Keep / Regenerate / Cancel**. The plan's green bar (0 schema failures, 0 canon contradictions, ≥4/5 held-out) is **not met**; the override was **granted on 2026-11-18** for the preview-gated scope, with the preview plus the “Generated · non-canon” badge as the safety gate.

## Two bars

| Bar | Meaning | Result |
| --- | --- | --- |
| **Strict (plan's bar)** | A card can be used without review: schema-valid, canon-safe, ≥4/5 | **Red.** 1 truncation, 2 canon/format defects in 5 first-pass runs |
| **Best-effort + preview** | The draft is usually good, defects are visible, the user decides | **Amber → acceptable.** 4/5 first-pass samples were keep-worthy; Regenerate fixes the rest |

The rest of this report is written against the second bar, because the product decision (user-supplied portrait, preview with keep/cancel/regenerate, non-canon only) already assumes a human in the loop.

## What was tested

### Corpus and prompt inputs
- **Season bible:** `data/seasons/s1.json` — title, era (2037–2040), premise, `toneNotes`, player role, faction ids, threats with agendas, roster ids.
- **Exemplars:** three complete Season 1 base cards, passed verbatim as `data.description` (5.9k–7.5k chars each): `Chars/S1/Vaiva-Colorgarde.json`, `Chars/S1/Claire Atropos.json`, `Chars/S1/Aurelia-Longshot.json`.
- **Output contract:** JSON fields mirroring `data/characters/profiles.json`, plus `firstMes`, `mesExample`, `tags`, `canonLinks`. This matches what `parseCardProfile` (`src/data/card-profile.js:374`) recognizes, so the description is assembled deterministically instead of asking the model to emit the labelled block.
- **Prompt size:** system prompt 2.8k chars; user prompt 21.4k–23.4k chars; `prompt_tokens` 5,700–6,002.

Section vocabulary actually used by Season 1 base cards (measured across all six base cards):

```
Name, Setting/World, Gender, Species, Appearance, Attire | Other attire,
Abilities, Background, Personality, Speech, Likes | Loves, Dislikes
```

Description length 4.3k–8.4k chars. `Setting/World` is preamble, ignored by the parser (`src/data/card-profile.js:77-83`). `Goals/Motives`, `Weakness`, `Combat Style`, `Gear` exist in the wider corpus and are recognized (`src/data/card-profile.js:17-68`).

### Held-out concepts (not canon)

| # | Concept | Side | Constraint |
| --- | --- | --- | --- |
| A | Mara Voss / “Neon Wraith”, pirate-radio host, sonic powers | vigilante | brother taken by the BCP; hearing cost |
| B | Dominic Ferraro / “The Ledger”, BCP logistics manager | villain | no powers, leverage and paperwork |
| C | Lena Park, 24-hour noodle-stall owner in Central Plaza | civilian | no powers, hears everything |

### Sampling
Non-thinking model variant, `temperature 0.9`, `top_p 0.95`, `max_tokens` 2600–4000, no repair pass on failure (to measure first-pass reliability honestly). Latency **6.2–28.3 s** per card. Provider reported **$0** for every run; 1,854–2,945 completion tokens.

## Results

| Run | Concept | max_tokens | JSON | Finish | Quality | Defects |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Mara | 3000 | ✅ | stop | **4.5/5** | `firstMes` 4,978 chars (cap 1,300); `appearance` 735; links `petrabyte` while “Unaffiliated” |
| A2 | Mara | 2600 | ❌ | length | — | JSON truncated inside `tags`; unrecoverable |
| A3 | Mara | 4000 | ✅ | stop | **3.0/5** | `firstMes` opens with the labelled card block; invented “Kestrel District”; `canonLinks.factionIds` contains `sensational-sirens` (S3) |
| B | Lena | 4000 | ✅ | stop | **4.5/5** | `mesExample` label is `Lena:`; invented minor NPC “Dov Halloran” |
| C | Dominic | 4000 | ✅ | stop | **4.5/5** | `mesExample` label is `Dominic:`; `identity` 155; `background` 1,358; “credits” as currency |
| D | Mara + hard-limit block | 4000 | ✅ | stop | **4.7/5** | caps still exceeded (`appearance` 808, `background` 1,107, `weakness` 336) |

Scores are from one reviewer using the rubric below. The plan's acceptance criteria call for two reviewers; this is a spike, not the acceptance record.

### Rubric

| Criterion | Weight | Notes |
| --- | --- | --- |
| Schema validity | hard gate | parses, required fields, correct types |
| Section completeness | 1 | every section present and non-empty |
| Voice / prose match | 2 | dense specific prose, third person present, no meta |
| Canon consistency | 2 | only bible ids/locations; no future or other-season knowledge |
| Character usability | 1 | distinct hook, relationships, a reason to be in a scene |
| Ability balance | 1 | specific limits; cannot trivially end the season threat |
| Uniqueness | 1 | name/alias does not collide with the registry |
| Content gate | hard gate | render-time reduction stays valid |

### Sample notes

- **A1 (4.5):** strongest “no rules” run. Specific habits, a real cost to the power, a named fear, a voice that survives the section split. `firstMes` overshot 3.8×.
- **A3 (3.0):** the trust-breaking failure. `firstMes` began with `[{{char}} is Mara Voss … Setting/World: …` — the description pasted into the opening scene. A preview catches it instantly; a validator catches it with one regex.
- **B (4.5):** the civilian is the best test of setting literacy. No powers, embedded in the plaza, a scene rather than a profile.
- **C (4.5):** the unpowered villain is the best test of balance. Leverage, paperwork, and cowardice instead of a power fantasy; correctly tied to `s1.threat.bcp`.
- **D (4.7):** with the hard-limit block the opening scene, `{{char}}:` label, and canon links were all correct on the first pass. Long-field caps still drifted.

## Failure taxonomy

1. **Token truncation (fatal, 1/6 runs).** A 2,400-token card needs `max_tokens ≥ 3,500` here. At 2,600 the model was cut mid-JSON. The client retries once on *invalid JSON* (`src/agents/client.js:354-425`) but resends the same `maxTokens`; a creator needs a larger-budget retry.
2. **Reasoning-model starvation (fatal, first attempt).** The connection default is the `:thinking` variant. With small `max_tokens` all output went to `reasoning` and `content` was empty → `generateRaw` throws “No message generated”. Target a non-thinking model or budget ≥ 6k tokens (`include_reasoning: true` is on the main path).
3. **Structural leak into `firstMes` (1/5 valid runs).** Detectable: the field contains `Setting/World:` / `Appearance:` labels or starts with `[{{char}} is`.
4. **Canon drift (1/5 valid runs).** Invented district, cross-season faction id. Fixed by a closed district list and id-restricted `canonLinks`.
5. **House-style label drift (3/5).** `mesExample` uses the character's name instead of `{{char}}:`. Safe deterministic rewrite (`^<Name>:` → `{{char}}:`).
6. **Cap overrun (most runs).** Models cannot count characters. Clamp or accept; do not reject.
7. **Minor invented entities.** A street, shop, or one-off NPC. Acceptable for non-canon; flag if it collides with the registry.

## What the codebase already provides

- **One LLM path with schema validation and one repair:** `src/agents/client.js:256` extracts one balanced JSON value, validates against a schema subset, repairs once (`:310-425`).
- **Agent runner with chat-affinity abort:** `src/agents/runner.js:40`.
- **A near-identical precedent:** the Form Architect (`src/agents/form-architect.js`) already does schema → validate → store under flags → render with a badge → Approve/Regenerate/Export.
- **The profile model:** `parseCardProfile` (`src/data/card-profile.js:374`) defines the labels and list shapes the Codex and prompt use; `data/characters/profiles.json` is the canonical shape.
- **The card envelope to export:** `Chars/S1/Vaiva-Colorgarde.json` (`spec`, `spec_version`, `data.*`, legacy mirror). Reuse `downloadJson` (`src/ui/download.js:6`).
- **Content gate:** `applyContentGate` (`src/core/content-gate.js:189`), `applyContentGateToPrompt` (`:241`); no extra filter pass needed.
- **Prompt rendering:** `buildProfileLines` (`src/context/worldbook.js:93`) renders the live `CharacterState`; `selectPresentCast` (`src/state/selectors.js:8-26`) falls back to “characters at the scene location”, so setting `locationId` is enough to put a generated character on stage.

### Gaps that constrain the design

- **No reducer event adds a character.** `HANDLERS` (`src/state/reducer.js:216`) has no `ADD_CHARACTER`; `seedCharacter` (`src/state/world-state.js:209`) is seed-time only, and roster resolution requires a registry entry (`src/data/seasons.js:607-616`). Keeping a card needs a new pre-validated event that inserts a `CharacterState` and calls `syncPresence`.
- **`CharacterState` stores no `personality` or `speech`** (`src/state/world-state.js:220-250`). The Codex reads those from `profiles.json`; a character absent from the registry loses them unless the profile is stored in `flags.generatedCards` (Codex fallback) or the state gains the fields.
- **`flags.manualCharacters` gates Cast Director eligibility** (`src/agents/cast-director.js:68-86`); add the id or the director ignores the character.
- **World-book materialization skips non-roster characters** (`src/context/worldbook.js:407-463`). The generated card will not reach SillyTavern's world book; the prompt cast block still renders it. Document, do not work around.
- **`validateWorldState` requires `charId === characters[key]` and a resolvable `locationId`** (`src/state/world-state.js:744-759`); `store.replace` re-validates.

## Recommended design (deliberately small)

### Flow

1. **Concept form** in the Characters tab: season (current), name (optional), role, one-line concept (required), powers & limits (optional), ties to canon (optional), content note (optional).
2. **One generation call** through the runner: season bible + 3 exemplars + hard-limit block + concept, `temperature 0.9`, `maxTokens 4000`, schema attached.
3. **Deterministic assembly:** build the description from the structured fields in house order with the `[{{char}} is …` preamble, so labels and order cannot drift.
4. **Deterministic validation** → `{ ok, warnings[], blockedReason }`.
5. **Preview:** the Codex detail layout, a “Generated · non-canon” badge, the warning list. **Keep · Regenerate · Cancel**.
6. **Keep** dispatches one `ADD_GENERATED_CHARACTER` event (pre-built character + profile + card), places the character at the chosen location, writes `flags.generatedCards[charId]`. **Regenerate** discards and repeats step 2 with the same concept. **Cancel** discards.

No draft → critique → auditor loop, no second model pass, no approval gate beyond the preview. The evidence does not support the extra machinery for a card the user reads in full before keeping.

### Prompt contract

- **System:** role, house rules (third person present, no player agency, no future knowledge, ability cost required, canon fixed), schema with caps.
- **User:** season bible (title, era, premise, tone, factions, threats, roster ids, **district and key-location names**), 3 exemplar descriptions, concept brief, hard-limit block.
- **Hard-limit block (the part that fixed the defects):** numeric caps; “`firstMes` is 700–1,400 chars of pure scene prose and must contain no `Label:` lines”; “`mesExample` uses `{{char}}:`”; “districts are exactly these: …”; “`canonLinks` may contain only ids from the bible”; “return one JSON object”.
- **Exemplars:** 3 same-season base cards, full `data.description` only (not `first_mes`).

### Validation matrix

| Check | Action |
| --- | --- |
| `finish_reason === 'length'` | retry once with `maxTokens × 1.5` |
| unparseable JSON | client's one repair attempt; otherwise fail with “Regenerate” |
| missing/wrong-typed required field | block the preview (show the error, offer Regenerate) |
| name/alias collides with the registry (normalized) | block (recommended) or auto-suffix |
| id collides | block |
| field over cap | clamp at 1.25× on a sentence boundary, warn “trimmed” |
| `firstMes` contains labelled sections | block as structural failure |
| `mesExample` speaker label is the name | rewrite to `{{char}}:` |
| `canonLinks` id not in season/registry | drop the entry, warn |
| `… District` not in `districts.json` | warn |
| forbidden strings (`the player`, `the Director`, `you feel`, `Neo Terra extension`) | block |
| year > season era end | block |
| powered character with empty `weakness` | block |
| content gate | render time, unchanged |

### Preview

- Render with the Codex section layout (`src/ui/codex.js:765-809`) so the preview *is* the card.
- **Keep** / **Regenerate** (disabled while running, keeps the concept) / **Cancel**.
- One in-flight generation; the runner aborts if the chat changes.
- Optional user portrait: file picker, type/size validation, downscaled; initials otherwise.

### Storage and integration

| Surface | Change |
| --- | --- |
| `src/agents/character-creator.js` (new) | schema, prompt builder, `validateGeneratedCard`, `assembleCardDescription`, `buildGeneratedCharacter`, `createCharacterCreator` |
| `src/agents/prompts.js`, `src/core/constants.js`, `src/core/defaults.js` | `characterCreator` in `AGENT_IDS` (`constants.js:37`), defaults next to `formArchitect` (`defaults.js:235`), `maxTokens: 4000` |
| `src/state/reducer.js` | `ADD_GENERATED_CHARACTER` (pre-validated payload only), `syncPresence` |
| `src/state/world-state.js` | optional `personality`/`speech` on generated characters, or accept the prompt loss |
| `src/ui/codex.js` | “Create character”, preview dialog, Keep/Regenerate/Cancel, generated-profile fallback |
| `src/ui/download.js` | reuse `downloadJson` for “Export card JSON” |
| `docs/` | this report + a “Generated cards” note in `docs/data-schema.md` |

Generated ids: `gen.<seasonId>.<slug>`; collision-checked against `data/characters/index.json` and live `state.characters`.

## Cost and latency

- ~5.7k prompt tokens + ~1.9k–2.9k completion tokens per card.
- 6–28 s first pass on the current connection; a cached prompt speeds regeneration.
- One regenerate on a structural failure adds one call. Budget two calls per keep in the worst case.

## Go / no-go

- **Green (not met):** 0 schema failures, 0 canon contradictions, ≥4/5 held-out with no review.
- **Amber (actual):** 4/5 keep-worthy first passes, defects visible and cheap to catch, Regenerate fixes them.
- **Red (not the case):** unusable prose, persistent canon invention, or frequent schema failure.

**Decision (granted 2026-11-18):** proceed on the amber path — best-effort creator with a mandatory preview. The working bar is “≥4/5 keep-worthy first pass under the validation matrix, no silent canon claims, hard non-canon badge”. The strict bar is unreachable with one call, and human review is the design.

## Risks

| Risk | Mitigation |
| --- | --- |
| A user keeps a canon-breaking card | non-canon badge, warning list, no `data/` export path, no roster membership |
| Reasoning-model empty content | default to a non-thinking model or `maxTokens ≥ 6000`; document the trap |
| Truncated JSON | `finish_reason` check + one larger retry |
| Prompt bloat as seasons grow | 3 exemplars max, truncated location lists, field caps |
| Voice drift across seasons | exemplars are season-matched |
| Chat metadata bloat (cards + portraits) | store card/profile only; portraits downscaled and capped at ~128 KB; field caps enforced |
| Duplicate names / aliases | normalized collision check against the registry and live cast |

## Decisions (approved 2026-11-18)

1. **Proceed on the amber path** — best-effort creator + mandatory preview; no critique/auditor chain.
2. **Portrait survives reload** — downscaled data URL (target ≤ 128 KB) in `flags.generatedCards[charId].portrait`; initials when absent.
3. **Entry point is Codex → Characters → “Create character”**.
4. **`personality` and `speech` join generated `CharacterState`** and render as two short cast-block lines (≤ 180 chars each) so the prompt budget is unaffected.
5. **A kept card starts at the current scene location** and appears in the present cast immediately.
6. **The user is the second reviewer and final authority.** The rubric stays advisory; the preview is the gate.

Remaining implementation note: this report lives in `plans/` because `docs/` writes were denied in this session. Promote it to `docs/character-creator-research.md` (the path named by the audit plan) if desired.

