# Fix: Characters tab cannot mount; character card data is never parsed

## Meta
- Slug: fix-codex-mount-and-card-profiles
- Status: complete (2026-11-18) — steps 0-6 implemented; `npm run check` green
- Date: 2026-11-17 (approved 2026-11-18)
- Repo: `NeoTerra-Framework` (SillyTavern extension, plain ESM, no bundler)
- Upstream: https://github.com/Setofnosets/NeoTerra-Framework
- Live instance used for reproduction: SillyTavern at `http://127.0.0.1:8000/`
  (install path `public/scripts/extensions/third-party/NeoTerra-Framework`, now a
  directory junction to this working tree — see Step 0)

## Progress
- [x] 0. Point the dev install at this working tree (junction + README note)
- [x] 1. Load codex data explicitly; stop cross-validating form rules against a chat slice
- [x] 2. Add the pure character-card section parser
- [x] 3. Generate `data/characters/profiles.json` and enforce it in `--check`
- [x] 4. Render card profiles in the codex with live state taking precedence
- [x] 5. Seed card profiles into new worlds and offer an explicit backfill
- [x] 6. Document and changelog

Implementation note: `counts.missingAppearance` is `0`, not the sample `4`,
because the four cards called out in Current State have variant labels
(`Civilian`/`Superhero`/`Supervillain`/`Metahuman`/`Original`/`New Appearance`)
that the canonical mapping resolves. They are not empty in the artifact.

## Summary
- **Goal:** (1) the Characters tab mounts and renders the codex in every chat that has a
  season, and (2) the codex shows the character information that already exists in the
  bundled cards instead of permanently empty fields.
- **Context:** the Characters tab currently paints
  `The character codex could not be mounted.` for any chat that has a season. The cause is
  not a missing module or bad import; it is a validation mismatch between a chat-scoped
  registry slice and the global form-rules document. Separately, the codex reads every
  profile field from `WorldState.characters[id]`, which is seeded empty and is only ever
  updated for the *player* by a tracker that cannot write `appearance`, `abilities`,
  `likes`, or `dislikes` at all. The cards under `Chars/**` contain all of that text in a
  consistent `Label: value` format, and nothing in the pipeline reads it.

---

## Current State (from exploration)

### A. The mount failure (reproduced live, exact mechanism confirmed)

Flow: tab click → `setActiveTab('characters')` (`src/ui/shell.js:1376-1378`) →
`mountCodexPanelForActiveChat()` → `mountCodexPanelComponent(refreshContext())`
(`src/ui/shell.js:718-791`).

Inside the `try` (`shell.js:737-781`):

1. `season = metadata.neoterra.seasonDefinition` (`738`).
2. `metadataRegistry = metadata.neoterra.registry` — the **chat-scoped slice** written by
   `buildChatRegistrySlice` at season start (`src/flows/season-start.js:487-518`).
3. `registry` becomes that slice whenever it has entries and the season is not
   `allowAnyCharacter` (`shell.js:744-746`).
4. `await Promise.all([loadFormGroups(), loadFormRules({ registry })])` (`747-750`).
5. `loadFormRules` validates the **global** rules document against the supplied registry
   (`src/data/forms.js:98-121` → `validateFormRules`, `src/data/schema.js:386-490`).
   `validateFormRules` treats every rule id it cannot resolve as a fatal error
   (`schema.js:466-478`) and also requires every `formRole === 'alt'` entry in the
   registry to have an inbound rule (`schema.js:481-487`).
6. The slice only contains the roster plus their form groups: 10 of 78 entries for S1.
   The global `data/form-rules.json` references every season, so validation reports ~40
   `unresolved registry id "..."` errors and `loadFormRules` throws.
7. The shell catch (`shell.js:782-785`) logs a warning and replaces the panel with
   `The character codex could not be mounted.`

**Verified against the user's real chat** (`Neo Terra — Director - 2026-11-17@23h40m35s419ms`,
read through `/api/chats/get`):

| Check | Result |
| --- | --- |
| `neoterra.registry.entries.length` | 10 (slice) |
| `neoterra.worldState.characters` | 6 (`s1.vaiva.colorgarde`, …) |
| Codex mount body with `loadFormRules({ registry: slice })` | throws `loadFormRules: invalid form rules (rules[5].from: unresolved registry id "s1dark.carol.bleeding-heart"; …)` ⇒ mount error |
| Same body with `loadFormRules({ registry: fullRegistry })` | succeeds; codex renders 6 characters |

This is deterministic, not a race. `src/data/forms.js` and
`src/flows/season-start.js` keep **separate** module-level caches (`forms.js:14-17` vs
`season-start.js:99,102-104`), and `enterSeason`'s `loadFormData({ fetchImpl })`
(`season-start.js:767-773`) calls `validateFormRules(formRules, null)` — it never warms the
codex's rules cache and never validates ids. `loadFormRules` is only called from
`shell.js:749`. So every chat with a season slice fails on every mount, and only the
"full registry" branch (sandbox / no slice) can succeed. The codex cache only means each
mount retries the failing fetch.

Consequence: every season chat is affected, on every page load. Nothing else is broken —
items, filters and detail all render once the rules load.

### B. Why every profile field is empty

- `buildDetail` reads `profile.*` **only** from `state.characters[id]` (`src/ui/codex.js:563-581`)
  and only `aliases`/`tags`/`formKind`/`formRole`/`cardPath` from the registry entry.
- Character state is seeded with `appearance: ''`, `outfit: ''`, `abilities: []`,
  `skills: []`, `traits: []`, `likes: []`, `dislikes: []`, `notes: ''`
  (`src/state/world-state.js:154-189`; same defaults for the player, `:100-128`).
  Only `agenda`/`allegiance`/`mood`/`locationId`/`threatLevel` are derived.
- The only runtime writer is the **player-only** state tracker
  (`src/agents/state-tracker.js:15-32`), whose writable paths are
  `status, outfit, mood, notes, corruption.*, skills, traits, injuries, allegiance,
  agenda, goals, resources`. It never edits NPCs, and `appearance`, `abilities`,
  `likes`, `dislikes` are not writable **at all**.
- Result for the observed chat: Vaiva's detail shows `appearance EMPTY`, `outfit EMPTY`,
  `notes EMPTY`, `abilities/goals/likes/dislikes/skills/traits` as empty arrays, and seven
  `None` placeholders. This is not a rendering bug; the data is genuinely absent.

### C. The card data that exists but is unread

- Registry entries carry only derived metadata: `id, file, cardPath, seasonId, dataName,
  displayName, aliases, side, threatLevel, formKind, formRole, altOf, formGroup, tags,
  bundle, actors, npcEligible`.
- `tools/build-data.mjs` already parses the card description, but only for `Aliases`,
  `Side` and `Threat Level` (`parseAliases:199`, `parseSide:248`, `parseThreatLevel:300`);
  `parseCard:316-359` never stores the body text.
- Survey of all 78 cards (fetched through the running server): `Setting/World` 78,
  `Gender` 79, `Species` 79, `Personality` 80, `Background` 81, `Appearance` 77,
  `Abilities` 60, `Likes` 58, `Dislikes` 55, `Speech/Mannerisms` 52, `Identity Status` 40,
  `Attire` variants 49+, `Goals/Motives` variants 23, `Loves` 10, plus condition-specific
  blocks (`Original/New/Former/Corrupted/Cursed/Knight/Suit Abilities`, `Civilian/
  Superhero/Supervillain Attire`, `Combat Style`, `Gear`, `Weakness`, `Occupation`,
  `Faction`) and 23 cards with `Transformation into <form>` sections.
- Four cards have no `Appearance` label at all:
  `s1dark.carol.cleansed.bleeding.heart`, `s1dark.carol.bleeding-heart`,
  `s1dark.phantom.heart.poisoned.bleeding.heart`, `s4.cyber.dragon.infected.crimson.crush`.
- Cards are valid V2 JSON with `data.description`, `data.personality`, `data.scenario`,
  `data.first_mes`; descriptions run ~5–8 KB and use `Label:` sections separated by blank
  lines. `Chars/**` is served statically by ST (all 78 were fetched successfully).

### D. Prompt path that would benefit automatically

`buildProfileLines` (`src/context/worldbook.js:100-159`) already renders
`Agenda/Goals/Mood/Outfit/Appearance/Abilities/Traits/Resources/Corruption` from
character state, gated and token-budgeted (`buildCharacterProfile:174-198`,
`buildCastProfiles:204+`, budget `tokenBudget.characterProfile = 1200`). Seeding parsed
card text into state would therefore improve narration with **no renderer change**.

### Key files
- `src/ui/shell.js` — codex mount (`:718-791`) is the only place the error string exists.
- `src/data/forms.js` — `loadFormRules` (`:98-121`) and module-level caches (`:14-17`).
- `src/data/schema.js` — `validateFormRules` (`:386-490`), `validateRegistry`.
- `src/data/registry.js` — registry loader/cache (`:10-57`), `buildRegistryIndex`.
- `src/flows/season-start.js` — `buildChatRegistrySlice` (`:487-518`),
  `applySeasonChatMetadata` (`:524-542`), `loadFormData` (`:101-140`), `enterSeason`.
- `src/state/world-state.js` — `createWorldState` (`:266-351`), `seedCharacter` (`:154-189`).
- `src/ui/codex.js` — `buildDetail` (`:491-604`), `renderCodexMarkup` (`:1046-1123`),
  `mountCodex` (`:1133-1393`), `buildCodexView` (`:609-710`).
- `src/agents/state-tracker.js` — `PLAYER_TRACKER_PATHS` (`:15-32`).
- `src/context/worldbook.js` / `src/context/renderer.js` — prompt-side profile rendering.
- `tools/build-data.mjs` — generators, `--check` (`:780-826`), `parseCard` (`:316-359`).
- `data/characters/index.json`, `data/form-rules.json`, `data/form-groups.json`, `Chars/**`.

### Landmines
- `loadFormRules` caches on success only, so one bad call keeps failing until reload and
  a good call hides the bug for the rest of the session.
- The same slice is used for **display**, where it is correct; the bug is only the
  *validation* use.
- `tests/registry.test.js` deep-compares `parseCard` output (`:87`, `:102`); do not add
  fields to registry entries — existing chats' slices would not have them anyway.
- `validateFormRules` currently also enforces "every alt form has an inbound rule"
  (`schema.js:481-487`) — iteration order/`counts` heuristics cannot distinguish a slice
  from a full registry, so do not try to auto-detect.
- 4 cards lack `Appearance`; label vocabulary has a long tail (`Goals/Motive`,
  `Speech/Mannerism`, condition-prefixed abilities/attire).
- Cards contain NSFW sections (`Sexual Information`, `Sexual Preference`, `Kink`). They are
  not hard-excluded: the content setting decides. The codex (a UI surface that does not
  currently call the gate) must apply `applyContentGate` at render time, and prompt seeding
  must go through the existing gate in `buildCastProfiles`.
- `settings.contentGate` is the global level (`defaults.js:40`, default `full`) and
  `settings.contentLimits` carries `player` + `characters[id]` hard limits; both are
  reachable from the codex's `getSettings()` callback. `applyContentGate` is a strict no-op
  at `full` (`content-gate.js:189-212`), so the same code path covers both cases.
- `Chars/` and `data/` are generated/derived; any new generated file needs to be wired
  into `npm run build:data --check` (`package.json:16`) or it will silently drift.
- The running ST install is a copy, not a junction (verified: a new plan file is absent
  there) — Step 0 fixes that before any manual verification.

---

## Constraints & Requirements
- **Tech stack / permissions:** vanilla ES modules, no new dependencies, no server
  endpoints, no DOM test harness. Tests are `node:test` + source-level assertions.
- **Browser-safe parsing:** the parser must live under `src/` with no `node:fs`, so
  `tools/build-data.mjs` can import it and the browser can reuse it if needed.
- **Generated data stays generated:** `data/characters/index.json` shape is frozen for
  this change; new derived data goes into a new file and through `--check`.
- **Prompt-only world state:** never write world state into `ctx.chat`; scene frames stay
  the only Neo Terra messages.
- **Size discipline:** codex text is escaped and scrollable; prompt text stays inside the
  existing token budget and content gate.
- **Out of scope:** NPC-per-turn trackers, per-character LLM extraction, rewriting card
  content, character-card hot-swapping, removing the chat registry slice, the
  `EXTENSION_VERSION` drift.

---

## Decisions & Assumptions (approved 2026-11-18)

1. **Installation path — link the install to the repo.** The current install at
   `ST/.../extensions/third-party/NeoTerra-Framework` is a **copy**, not a link: the plan
   file added to this working tree does not appear there, while older `plans/*.md` do.
   Decision: replace it with a directory junction to the local working tree (which tracks
   https://github.com/Setofnosets/NeoTerra-Framework), so served code is always the code
   under review. See Step 0.
2. **Mount fix — approved.** Stop *cross-validating* the global rules against a chat slice:
   `loadFormRules` validates structure always and resolves ids only when explicitly asked
   (`validateRegistryIds` / `strict`), which the codex does not request.
   `validateFormRules(rules, fullRegistry)` keeps the id pass for `--check` and any caller
   that genuinely holds the complete registry. Rejected: "always pass the full registry"
   (same footgun, redundant 200 KB fetch) and season-filtering the id checks (sliced alts
   and rules do not line up reliably).
3. **Profiles live in build-time data — approved.** `data/characters/profiles.json` keyed
   by registry id, generated by `tools/build-data.mjs`, enforced by `--check`. Runtime
   per-card fetching and embedding bodies in registry entries are rejected (async repaint
   plumbing / deep-equal test breakage and stale slices).
4. **Precedence — approved.** Live `WorldState` value wins when non-empty; otherwise the
   card value is shown.
5. **Prompt seeding — in scope.** Step 5 lands: card text is seeded into new worlds and
   reaches prompts through the existing cast-profile renderer (which already applies
   `tokenBudget.characterProfile = 1200` and `applyContentGate`). Expect roughly 10–25 KB
   more chat metadata per world.
6. **Existing chats — explicit backfill only.** No automatic write on mount. The codex gets
   per-character `Import card profile` and an all-characters `Sync card profiles` action;
   both are idempotent and never overwrite a non-empty live value.
7. **Presentation — approved.** `Likes/Dislikes/Goals` become list items only when a
   tolerant splitter yields 2–20 short items (≤ 80 chars each); otherwise the body renders
   as a paragraph, as do `Abilities/Background/Personality/Speech`.
8. **Form-specific sections — approved.** `Transformation into <form>` renders only on the
   entry whose form matches. **Future work (out of scope):** transformations that do not
   exist as a card entry (dynamic forms).
9. **NSFW sections — gated, not hard-excluded.** `Sexual Information`, `Sexual Preference`,
   `Kink`, etc. are parsed and shown/seeded like any other text, and the existing content
   setting decides whether they are minimized or removed (`settings.contentGate` +
   `settings.contentLimits`, via `applyContentGate`). At `full` the text appears verbatim;
   at `mature-only`/`reduced`/`strict` the gate rewrites or omits it. The parser therefore
   must not drop these sections.
10. **Sandbox / any-character seasons:** the codex keeps using the full registry (existing
    behaviour); profiles are keyed by the final registry id (post-override ids from
    `data/characters/overrides.json`).
11. **Chat slice drift — deferred.** Display roster/form index still comes from the chat
    slice while profiles come from the current build; dropping the slice for display is a
    follow-up.

---

## Step-by-Step Implementation Plan

### 0. Point the dev install at this working tree (setup, not code)
- **Files:** none in `src/`; optional short note in `README.md` (or `start.md`) describing
  the dev install. No runtime code changes.
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:**
  - The current `ST/SillyTavern/public/scripts/extensions/third-party/NeoTerra-Framework`
    directory is a **copy** (a plan file added to this working tree is absent there while
    older plans are present). Every later step would otherwise need a manual re-copy.
  - Keep the existing copy as a backup, then replace it with a directory junction to
    `C:\Users\locua\OneDrive\Escritorio\KI\extensions\NeoTerra-Framework`:
    ```bat
    rmdir /S /Q "C:\Users\locua\OneDrive\Escritorio\KI\ST\SillyTavern\public\scripts\extensions\third-party\NeoTerra-Framework"
    mklink /J "C:\Users\locua\OneDrive\Escritorio\KI\ST\SillyTavern\public\scripts\extensions\third-party\NeoTerra-Framework" "C:\Users\locua\OneDrive\Escritorio\KI\extensions\NeoTerra-Framework"
    ```
  - The working tree tracks https://github.com/Setofnosets/NeoTerra-Framework; the junction
    makes the served extension identical to the code under review. `plans/`, `tests/` and
    `tools/` become visible to the static server but are never loaded by ST.
- **Acceptance criteria:**
  - A file created in the repo (e.g. `plans/fix-codex-mount-and-card-profiles.md`) is
    visible at the ST path without copying.
  - Refresh `http://127.0.0.1:8000/` with the extension enabled: Neo Terra still loads,
    the shell button works, and no extension-load error appears in the console.
  - Each later step's manual checks require only a page refresh.
- **Risk:** low (backup first; the junction is reversible with `rmdir` + restore)
- **Model / Effort:** manual / human #low
- **Commit:** `docs: document the local dev install as a repo junction` (only if the README
  note is added; the junction itself is not a repo change)

### 1. Make codex data loading explicit, and stop cross-validating form rules against a chat slice
- **Files:** `src/ui/codex-data.js` (new), `src/ui/shell.js`, `src/data/forms.js`,
  `tests/codex-data.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes (independent of Steps 2–5)
- **Expected behavior:**
  - Extract the data-loading half of `mountCodexPanelComponent` into one pure-ish,
    injectable helper, e.g.
    `loadCodexData({ metadata, loadFullRegistry, loadFormGroups, loadFormRules, loadProfiles })`
    returning `{ season, registry, formGroups, formRules, profiles }`.
    - `registry` = chat slice when it has entries and the season is not
      `allowAnyCharacter`, else the full registry (current behaviour, unchanged).
    - `loadFormRules()` is called **without** a registry. Registry-scoped id resolution
      becomes opt-in (`loadFormRules({ registry, validateRegistryIds: true })`), documented
      as "only valid for the complete registry".
    - Optional profile loading is wrapped so a missing/failed `profiles.json` degrades to
      `{}` (Step 4 consumes it; until then the parameter may be omitted).
  - `validateFormRules` keeps its current signature/semantics for
    `loadFormData`/`--check`; only `loadFormRules`'s default changes.
  - `mountCodexPanelComponent` keeps the user-facing message but records the failure
    reason for support: `host.dataset.neoterraCodexError = message` (and keep
    `logger.warn`).
- **Acceptance criteria:**
  - Unit test: a chat slice (10 S1 entries) plus the shipped `data/form-rules.json`
    resolves; no throw; `registry` is the slice.
  - Unit test: `loadFormRules({ registry, validateRegistryIds: true })` with the same slice
    still rejects with the unresolved-id message (documents the constraint).
  - Unit test: malformed rules JSON still rejects with the structural error; HTTP 404 still
    rejects.
  - Unit test: no slice + non-sandbox season falls back to the full registry; profiles
    loader rejection yields `profiles: {}` and no throw.
  - No test requires a DOM.
  - Existing `tests/cast-director.test.js:812-833` and `tests/registry.test.js:265` still
    pass unchanged.
- **Risk:** low (one call site, one default flag)
- **Model / Effort:** standard implementer #low
- **Commit:** `fix(codex): load form rules without validating against a chat-scoped registry slice`

### 2. Add a pure character-card section parser
- **Files:** `src/data/card-profile.js` (new), `tests/card-profile.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:**
  - `parseCardProfile(card)` accepts a raw V2 card and returns a stable, serialisable
    object; no IO, no globals, no throws on odd input (returns `null` for non-objects).
  - Algorithm (pseudocode, because the label vocabulary is the tricky part):

    ```
    text = normalize(card.data.description)      # CRLF -> LF, NBSP -> space
    # 1. split into labelled sections at line starts only
    matches = findall(/^[ \t]*([A-Z][^\n:]{1,40}?)[ \t]*:[ \t]*/m, text)
    sections[i] = { rawLabel, body }             # body = text until next match, trimmed
    # 2. canonicalise labels (case/punctuation-insensitive), keep raw label + body
    for each section:
        key = canonicalKey(rawLabel)             # table below
        if key is a form section ("transformation into X", "transform into X"):
            forms[normaliseFormName(X)] = body
        else if key in CANONICAL:
            fields[key].push({ label: rawLabel, text: body })
    # 3. project to display fields
    pick(key)      = first section with exact canonical label, else first variant
    list(key)      = splitListText(body)  # 2..20 items, each <= 80 chars, else [body]
    ```

  - Canonical mapping (order matters; exact label preferred, variants appended):
    - `appearance`: `Appearance`, `Civilian/Superhero/Supervillain/Metahuman Appearance`,
      `New Appearance`, `Original Appearance`
    - `attire`: `Attire`, `Other/Current/Casual/Non-themed Attire`,
      `Civilian/Hero/Superhero/Supervillain/Villain/Vigilante Attire`
    - `abilities`: `Abilities`, `Original/New/Former/Natural/Corrupted/Cursed/Knight/Suit
      Abilities`, `Old (still useable) Abilities`, `Phoenix Soul`
    - `personality`: `Personality`, `<Name>'s Personality`, `Behavior`, `Worldview/Morals`
    - `speech`: `Speech`, `Speech/Mannerisms` (singular `Mannerism` too), `Communication`
    - `likes`: `Likes`, `Like`, `Loves`
    - `dislikes`: `Dislikes`, `Dislike`, `Most Hated`
    - `goals`: `Goals/Motives` (all spellings), `Motive`, `Ultimate Goal`
    - `background`: `Background`, `Old Life`
    - `identity`: `Identity Status`, `Name`
    - `gender` / `species` / `occupation` / `faction` / `gear` / `weakness` / `combatStyle`
    - `sensitive`: `Sexual Information`, `Sexual Preference`, `Sexual Personality`, `Kink`
      (parsed like everything else — the content setting decides whether they are shown;
      do not drop them at parse time)
    - Ignored on purpose: `Setting/World` (season-level), `Aliases*` (already in the
      registry), `Threat Level`, `Side`, `OOC reminder`, `IMPORTANT`.
  - Output shape: `{ name, gender, species, occupation, faction, appearance, attire,
    abilities, personality, speech, likes, dislikes, goals, background, identity,
    combatStyle, gear, weakness, sensitive: [{ label, text }],
    extras: [{ label, text }], forms: { [formName]: body },
    missing: [canonical keys with no section], source: { file, cardPath, dataName } }`.
    Long bodies are stored verbatim; truncation and gating belong to the display/prompt
    layers (`applyContentGate` is the single policy point, at `full` it is a no-op).
- **Acceptance criteria:**
  - Tests read real cards from disk (`Chars/S1/Vaiva-Colorgarde.json`,
    `Chars/S1/Atrepos couple.json`, `Chars/S4/Bird Cage (Corrupted Hula Hawk).json`) and
    assert: `appearance`, `abilities`, `personality`, `likes`, `dislikes` non-empty;
    `gender`/`species` present; `forms` populated for the corrupted card.
  - A synthetic card with only `Personality` and `Background` parses with `missing`
    listing the rest and never throws.
  - CRLF input and a description with blank lines inside a section body parse identically
    to LF.
  - `splitListText('A, B, and C.')` → 3 items; a 400-character prose body stays one item.
  - A card with a `Sexual Information` / `Kink` section keeps it under `sensitive` (not
    dropped); a card without one has an empty `sensitive` array.
  - Parser output is JSON-serialisable and deterministic (same input → deep-equal output).
- **Risk:** low
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(data): parse labelled character-card sections into a profile shape`

### 3. Generate `data/characters/profiles.json` and enforce it in `--check`
- **Files:** `tools/build-data.mjs`, `data/characters/profiles.json` (new, generated),
  `data/schemas/profile.schema.json` (new, optional), `docs/data-schema.md`,
  `tests/registry.test.js`, `tests/integration.test.js`
- **Depends on:** Step 2
- **Parallelizable:** no (shares the generator with nothing else, but must land before Step 4)
- **Expected behavior:**
  - After overrides and form-group resolution (so keys are the final registry ids), emit:
    ```json
    {
      "schemaVersion": 1,
      "generatedBy": "tools/build-data.mjs",
      "source": "Chars",
      "counts": { "profiles": 78, "missingAppearance": 4 },
      "profiles": { "s1.vaiva.colorgarde": { "name": "…", "appearance": "…", … } }
    }
    ```
  - `--check` compares the serialised file exactly like the registry/season index
    (`compareGeneratedFile`, `build-data.mjs:780-791`); a stale file fails with
    `run node tools/build-data.mjs`.
  - Validation: every registry entry id has a profile; each profile has `source.cardPath`
    equal to the entry's `cardPath`; `missing` is reported per entry; a card with an
    unreadable `data.description` becomes a build **error** (not a silent empty profile).
  - Do **not** modify `data/characters/index.json` shape.
- **Acceptance criteria:**
  - `npm run build:data` writes the file; running it twice is byte-identical.
  - `node tools/build-data.mjs --check` passes on a fresh build and fails after a manual
    edit to the generated file (verified by the integration test's existing pattern,
    `tests/integration.test.js:31`).
  - `tests/registry.test.js:87/102` deep-equal assertions on `parseCard` still pass.
  - `docs/data-schema.md` documents the new artifact, its keying, and that it is generated.
- **Risk:** low–medium (new generated artifact; count of profiles must match entries)
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(data): generate character-card profiles and check them in build-data`

### 4. Show card profiles in the codex with live state taking precedence
- **Files:** `src/data/profiles.js` (new loader), `src/ui/codex.js`, `src/ui/shell.js`,
  `style.css`, `tests/codex.test.js`
- **Depends on:** Steps 1 and 3
- **Parallelizable:** no (Step 1 already touched `shell.js`; sequence after it)
- **Expected behavior:**
  - `src/data/profiles.js`: `loadProfiles({ fetchImpl })` fetches
    `data/characters/profiles.json` once, caches it, validates the envelope
    (`schemaVersion`, `profiles` object) and exposes `clearProfilesCache()` — mirroring
    `registry.js`. URL resolution uses `new URL('../../data/characters/profiles.json',
    import.meta.url)`.
  - Step 1's `loadCodexData` loads it in parallel and passes `profiles` through
    `mountCodex` → `buildCodexView` → `buildDetail`.
  - Precedence helper (single place, unit-testable):
    ```
    liveText(v, card)  = v.trim() ? v : (card ?? '')
    liveList(v, card)  = v.length ? v : splitListText(card)   # [] when no card
    ```
  - **Content gate at render, not at parse:** the codex is a UI surface that does not call
    the gate today. Every card field goes through
    `applyContentGate(text, settings.contentGate, settings.contentLimits,
    { characterId, isPlayer })` inside `buildDetail` (re-evaluated whenever settings change,
    so the per-character limit and the player limit both apply). At `full` the gate is a
    no-op; at `mature-only` sexual terms become markers; `reduced` adds violence markers;
    `strict` drops sentences containing explicit sexual or graphic-violence terms. A field
    that gates to an empty string is omitted rather than shown as empty.
  - `buildDetail` gains `profile.card` (the parsed profile with gated text) and fills the
    existing fields with fallbacks so no block stays `None` when the card has data:
    `appearance`, `outfit` (from `attire`), `abilities`, `likes`, `dislikes`, `goals`, plus
    new `gender`, `species`, `identity`, `speech`, `personality`, `combatStyle`, `gear`,
    `weakness`, `sensitive`, `extras`, `forms`. `notes` stays live-only; the card's
    `background` is shown in the card block instead of being folded into `notes`.
  - Markup (`renderCodexMarkup`, `codex.js:949-1022`):
    - header hint gains `gender · species` when known;
    - a `From the character card` section renders appearance/attire/personality/speech/
      background as paragraphs, likes/dislikes/goals via `listMarkup`, and `extras`
      (Occupation, Faction, Combat style, Gear, Weakness) as label/value rows;
    - a `Sensitive` subsection renders `sensitive` rows last (subject to the gate);
    - a `Form notes` subsection renders the `forms` entry matching the selected form label
      when present;
    - `listMarkup` renders a single item longer than ~200 characters as a `<p>` instead of
      a one-line bullet.
  - All card text is escaped with `escapeCodexHtml`; long text is not truncated in the
    panel (it scrolls); the panel never throws when `profiles` is missing or the id is
    absent.
- **Acceptance criteria:**
  - Unit tests (`buildCodexView` with a fixture profile): live non-empty value wins;
    live empty value falls back to card; missing card leaves `None`/`No appearance
    recorded.`; unknown id is safe.
  - Gate tests (pure, no DOM): `contentGate: 'full'` shows the raw sensitive text;
    `'mature-only'` replaces sexual terms with `[sexual content omitted]`; `'reduced'` adds
    `[violence elided]`; `'strict'` drops sentences containing sexual or violence terms; a
    per-character hard limit in `contentLimits.characters[id]` and the player limit can only
    make it stricter; changing the setting changes the view without touching the stored
    profile.
  - With the real S1 chat metadata, the Vaiva detail shows non-empty appearance,
    attire/outfit, abilities, personality, speech, likes, dislikes, goals, background and
    `Female · Human`; `None` placeholders drop below three.
  - Setting `profiles: {}` reproduces today's output exactly (no regression).
  - Source-level CSS test still passes; new classes are namespaced `neoterra-codex-*`.
- **Risk:** low–medium (view-model change; keep `profile` field names stable for tests)
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(codex): render parsed card profiles with live state taking precedence`

### 5. Seed card profiles into new worlds; offer an explicit backfill for existing chats
- **Files:** `src/state/world-state.js`, `src/flows/season-start.js`,
  `src/ui/codex.js`, `src/ui/shell.js`, `src/context/worldbook.js` (no change expected),
  `tests/world-state.test.js`, `tests/season-start.test.js`, `tests/codex.test.js`
- **Depends on:** Steps 2–4
- **Parallelizable:** no
- **Expected behavior:**
  - `createWorldState({ …, profiles })` passes the map into `seedCharacter`, which fills
    `appearance`, `outfit` (attire), `abilities`, `likes`, `dislikes`, `goals`, `traits`
    (from personality/speech traits if list-like), `notes` (background) only when the
    derived value is absent, and only for keys present in the card profile.
  - `enterSeason` loads profiles with the same `fetchImpl` injection it already uses for
    registry/form data; a missing profile file must not block season start.
  - **Seed raw text; never bake the gate.** Stored state keeps the ungated card text so a
    later `contentGate` change still affects both the codex (render-time gate, Step 4) and
    the prompt (existing gate in `buildCastProfiles`,
    `renderer.js:153-180`, `worldbook.js:174-198`). Prompt size stays bounded by
    `tokenBudget.characterProfile = 1200` and truncation flags; no renderer change.
  - Existing chats: a user-initiated action (codex detail: `Import card profile`; codex
    header or Settings: `Sync card profiles`) merges missing fields for the current chat's
    roster through the store's `dispatch`/`replace` path so `saveMetadataDebounced` and the
    WAL behave normally. No automatic write on mount. Bundles (`actors`) and characters
    without a profile are skipped.
- **Acceptance criteria:**
  - Test: `createWorldState` with a profile map seeds `appearance`/`likes`/`goals`; without
    profiles, output is byte-identical to today.
  - Test: seeded text is byte-identical to the parsed card text (no gate applied at seed
    time); `buildCharacterProfile` then gates and truncates it, and changing the gate level
    changes the rendered prompt with the stored text unchanged.
  - Test: backfill is idempotent — running it twice produces no second write and no
    duplicate list items; live non-empty values are never overwritten.
  - Manual: start a new season, the prompt inspection (ST console / prompt log) shows
    `Appearance:` for present NPCs; the codex and the prompt agree; switching
    `contentGate` to `strict` and reopening the codex removes the explicit text in both
    places.
- **Risk:** medium (writes character state; prompt growth)
- **Model / Effort:** standard implementer #high; escalate if `world-state` schema tests fail
- **Commit:** `feat(state): seed character-card profiles at season start and add a codex backfill`

### 6. Document and changelog
- **Files:** `CHANGELOG.md`, `docs/data-schema.md` (finish), `README.md` (troubleshooting
  note for the codex error), optionally `start.md`
- **Depends on:** Steps 1–5
- **Parallelizable:** no
- **Expected behavior:**
  - Changelog entry: codex mount fix, card-profile parsing, live-over-card precedence,
    content-gated sensitive sections, prompt seeding, backfill.
  - Troubleshooting: if the codex ever shows the mount error, the panel carries
    `data-neoterra-codex-error` and the console has `Could not mount the character codex`;
    report both.
  - Data docs: `profiles.json` is generated; never hand-edit; `npm run build:data`.
  - Card-profile docs: what is parsed, the canonical field mapping, which sections are
    sensitive and how `contentGate`/`contentLimits` decide their visibility, and the
    precedence rule (live state > card).
  - Dev docs: the ST third-party install is a junction to this repo (Step 0).
- **Acceptance criteria:**
  - `npm run check` passes; docs contain no stale claims about empty profiles.
- **Risk:** low
- **Model / Effort:** standard implementer #low
- **Commit:** `docs: document card profiles and codex troubleshooting`

---

## Verification & Testing

### Automated checks (run after every step, from the repo root)
```bash
node --test tests/codex-data.test.js
node --test tests/card-profile.test.js
node --test tests/codex.test.js
node --test tests/registry.test.js
node --test tests/world-state.test.js
node --test tests/season-start.test.js
npm test
npm run check
```
`npm run check` already covers: `build-data --check`, `build-map --check`,
`map-coords --check`, `node --check` on entry points, the full `node --test tests/*.test.js`
suite, and `tools/smoke-test.mjs`. `data/characters/profiles.json` must be regenerated with
`npm run build:data` (never hand-edited) or `--check` fails by design.

### Manual checks (SillyTavern running from `ST/SillyTavern/Start.bat` at http://127.0.0.1:8000/)
0. **Install is live (Step 0):** edit a served file in the repo, refresh the page, and
   confirm the change is active without copying; then confirm a repo-only file is visible at
   the ST path.
1. **Regression, the reported bug:** open `Neo Terra — Director - 2026-11-17@23h40m35s419ms`
   (or any S1 chat), reload the page, open Neo Terra → Characters. The panel renders the
   six S1 characters; the console has no `Could not mount the character codex`.
2. **Other chats:** repeat in `Tindur - 2026-11-17@20h54m38s565ms` and
   `Tindur - 2026-11-17@20h27m08s678ms` (S1 with travel/combat history); also open a chat
   with no season
   (e.g. `Amy`) and confirm the intended
   `Open a chat to see its character codex.` / `No character world is active in this chat.`
   messages, not the error.
3. **Profile content:** select Vaiva Colorgarde, Aurelia Longshot, Claire Atropos and
   Twisting Fate; confirm appearance, attire, abilities, personality, speech, likes,
   dislikes, goals and background are populated from the card, that `Female · Human`
   appears, and that `Twisting Fate` shows its `Transformation into …` form notes when that
   form is selected.
4. **Cards without Appearance:** open the S1Dark cleansed/infected Carol entries and
   `Cyber Dragon`; they must degrade to the existing empty-state text without errors.
5. **Sandbox / any-character season:** start or open a sandbox world; the characters list
   comes from the full registry and profiles still resolve.
6. **Fresh season:** start a new S1 season on a fresh chat with the Director card; after the
   opening frame, inspect the prompt copy (ST console prompt log) and confirm `Appearance:`
   / `Abilities:` lines appear for the present NPC.
7. **Backfill:** in the existing Director chat, run `Import card profile` on one NPC, then
   `Sync card profiles`; confirm fields appear, metadata saves once, a second run is a
   no-op, and a reload keeps them.
8. **Content gate:** with a card that has `Sexual Information`/`Kink` sections, set
   `contentGate` to `full` → text shows as written; `mature-only` → sexual terms become
   `[sexual content omitted]`; `strict` → explicit sentences disappear from the codex and
   from the prompt copy. Set a per-character hard limit in Settings and confirm it can only
   tighten, never loosen.
9. **Map/Season/Player/Settings tabs:** click through all tabs; nothing regressed, map still
   mounts, no new console errors.
10. **No profiles.json (simulate a stale install):** temporarily rename the file in the repo
    (the junction makes it the served copy); the codex must still mount with live data and
    the old empty-state text, and season start must still succeed.

### Edge cases
- Chat slice ids absent from the current registry (renamed/removed character) → card block
  omitted, no throw.
- Season registry slice present but `seasonDefinition` missing (partial metadata) → full
  registry path, no throw.
- Rules document genuinely broken (bad JSON/structural) → still fails loudly at build and
  at season start; the codex no longer depends on it.
- A card whose description has no labels at all → `missing` lists everything; codex shows
  the fallback text.
- Duplicate/hard-coded ids in the roster; bundle entries with `actors` (Atropos Couple,
  Sensational Sirens) → no card-profile confusion, bundles keep their own profile.
- Very long `Background` bodies (8 KB cards) → codex scrolls; prompt seeding respects the
  1200-token per-character budget and truncation flag.
- NSFW/sensitive sections: `full` shows them verbatim; stricter levels rewrite/remove them
  at render time in both the codex and the prompt. Because the gate is applied at render,
  changing the setting must change existing chats without rewriting stored data.
- Unlabelled free-intro text (the leading `[{{char}} is …]` paragraph) is not a section; it
  is ignored by the parser (or captured as `extras.intro` if review wants it).
- Mount must behave identically on a fresh page load and after a season was started in the
  same session (the old code had no session-dependent success path; do not introduce one).

### Rollback
- Step 0: remove the junction and restore the backed-up copy directory.
- Step 1: revert the shell call site + `loadFormRules` default; the error returns but no
  state is affected.
- Steps 2–4: delete `profiles.json`, the parser/loader, and the codex merge; the registry
  and all chat metadata are untouched.
- Step 5: revert seeding; existing worlds are unaffected because seeding only fills empty
  fields, and backfill is user-initiated. `chatMetadata.neoterra.worldState` keeps whatever
  was already written (no destructive migration exists in this plan).
