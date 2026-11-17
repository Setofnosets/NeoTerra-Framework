# Brief — neoterra-framework-v1 / Step 2

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 2.
- **Title:** Data ingestion pipeline and character/form registry.
- **Depends on:** Step 1 (committed at `b6a45b0`; settings/test harness exists).
- **Route:** implement-hard, high effort.
- **Status:** ready to implement.
- **Worktree:** `/mnt/c/Users/locua/OneDrive/Escritorio/KI/extensions/NeoTerra-Framework` (clean `master`).
- **Node:** only available as `/mnt/c/Program Files/nodejs/node.exe` (Node v24.16.0). `node`/`npm` are not on PATH.
- **Runtime rule:** run-time code must stay dependency-free. `tools/build-data.mjs` and all modules use Node built-ins only. No Ajv, no npm packages.

## Objective
Build a deterministic, season-scoped character/form registry from the raw `Chars/` cards, plus the form-group and transformation-rule data that later steps (season seeding, cast director, codex) consume. The tool must read only `data.*` (the legacy top-level block is disposable), emit `data/characters/index.json`, and fail loudly (`--check`) on unparseable cards, dangling `altOf`, invalid form groups, duplicate IDs, or registry drift.

## Actual input inventory (authoritative over the plan prose)
The plan says "66 season cards", S3 = 18, S4 = 22. The folder is the source of truth:

| Folder | `seasonId` | Card count |
|---|---|---|
| `Chars/S1` | `s1` | 11 |
| `Chars/S1Dark` | `s1dark` | 10 |
| `Chars/S2` | `s2` | 13 |
| `Chars/S3` | `s3` | 19 |
| `Chars/S4` | `s4` | 21 |
| `Chars/Others` | `others` | 4 |
| **Total in scope** | | **78** |

Do **not** ingest `Chars/Others/NeoHorizon/` (8 v2 cards + lore) or `Chars/lorebooks/` in this step. They are Step 3 / out of V1.

Card facts confirmed:
- S1–S4 cards are `chara_card_v3`; all 4 `Chars/Others/*.json` cards are `chara_card_v2` (plan text says v3 — folder wins).
- Every card has a usable `data` object. V3 files also duplicate a legacy top-level block; **never read `name`, `description`, `tags`, etc. from the top level**.
- `data.name` is only a short name ("Carol", "Claire", "Aurelia"), not the full identity. The filename carries the identity/codename and the parenthetical form label.
- Cards may lack `character_book`, `personality`, `mes_example`; do not require them.

## Files (scope)
Only touch:
- `tools/build-data.mjs`
- `data/characters/index.json` (generated)
- `data/characters/overrides.json` (authored)
- `data/form-groups.json` (authored)
- `data/form-rules.json` (authored)
- `src/data/registry.js`
- `src/data/forms.js`
- `src/data/schema.js`
- `tests/registry.test.js`
- `tests/fixtures/*` (new files allowed)

Do not modify `manifest.json`, `index.js`, `src/ui/**`, `src/core/**`, `package.json` (scripts already run `node --test tests/*.test.js`), or any Step 3+ module. Do not add dependencies. Do not commit `Chars/`, `NeoTerra.png`, or `plans/` (the commit agent handles the plan).

## Registry entry shape
`data/characters/index.json`:

```json
{
  "schemaVersion": 1,
  "generatedBy": "tools/build-data.mjs",
  "source": "Chars",
  "counts": { "s1": 11, "s1dark": 10, "s2": 13, "s3": 19, "s4": 21, "others": 4, "total": 78 },
  "entries": [
    {
      "id": "s1dark.carol.bleeding-heart",
      "file": "Chars/S1Dark/Carol-Bleeding Heart.json",
      "cardPath": "Chars/S1Dark/Carol-Bleeding Heart.json",
      "seasonId": "s1dark",
      "dataName": "Carol",
      "displayName": "Carol Fate",
      "aliases": ["Bleeding Heart", "Carol Fate", "Her Majesty"],
      "side": "villain",
      "threatLevel": null,
      "formRole": "base",
      "altOf": null,
      "formKind": "base",
      "formGroup": "s1dark.carol",
      "tags": ["Action", "Fantasy"],
      "bundle": false,
      "actors": null,
      "npcEligible": true
    }
  ]
}
```

Required fields on every entry: `id`, `file`, `cardPath`, `seasonId`, `dataName`, `displayName`, `aliases`, `side`, `threatLevel`, `formRole`, `altOf`, `formKind`, `formGroup`, `tags`, `bundle`, `actors`, `npcEligible`.
- `file`/`cardPath`: repo-relative POSIX path (`Chars/S1/...json`), never absolute, never Windows separators.
- `aliases`: array of strings, may be empty. Always include the codename/civilian names you can parse; overrides may correct.
- `side`: `'hero' | 'villain' | 'vigilante' | 'civilian' | 'neutral'`.
- `threatLevel`: string or `null`. Store the normalized first token (`S`, `EX+`, `OMEGA`, ...) and keep the full source line in `threatLevelRaw` if present.
- `formRole`: `'base' | 'alt'`; `altOf`: base entry ID or `null`.
- `formKind`: `'base' | 'corrupted' | 'cleansed' | 'treated' | 'infected' | 'coldhearted' | 'knighted' | 'poisoned' | 'alt-version'`.
- `formGroup`: group ID or `null`.
- `bundle`: true for multi-actor cards; `actors`: `[{ "name": ..., "aliases": [...] }]` or `null`.
- `npcEligible`: false for bundles, true otherwise.

## ID rules
- Stable and season-scoped: `id = '<seasonId>.<slug>'`; the same name in another season is another entry. Required exact IDs:
  - `s1dark.carol.bleeding-heart`
  - `s2.leila.renya`
- Default slugify (implement once, export for tests):
  1. Unicode NFKD, strip combining marks (`Petrauskaitė` → `Petrauskaite`).
  2. lowercase; replace `&` with ` and `; remove apostrophes (`'`, `’`).
  3. replace any run of characters outside `[a-z0-9]` with `.`; collapse repeated `.`; trim leading/trailing `.`.
  - `Leila Renya.json` → `s2.leila.renya`.
  - `Claire Lachesis (Cleansed Claire Atropos).json` → `s1.claire.lachesis.cleansed.claire.atropos`.
- Overrides may set an explicit `id`; use that for the required IDs and known defects. IDs must never be derived from `data.name` alone.
- Hard-code the required IDs in `overrides.json`, not in the tool.

## Filename → form metadata
- Parse the final parenthetical in the filename. First word decides `formKind`:
  `Corrupted`, `Cleansed`, `Treated`, `Infected`, `Coldhearted`, `Knighted`, `Poisoned`.
- `(Season N ver.)`, `(Season Dark Version)`, `(Vampire)` → `alt-version`.
- `(Recorrupted)` → `corrupted` (Claire S4).
- No parenthetical → `base`.
- `formRole`/`altOf` are **derived from `form-groups.json` membership**, not from the parenthetical alone. An entry that is the declared base of its group is `formRole: 'base'` even if its filename says `Corrupted` (S1 Twisting Fate, S3 Blood Bound, S4 Claire Recorrupted).

## Overrides
`data/characters/overrides.json` shape:

```json
{
  "schemaVersion": 1,
  "entries": {
    "S1Dark/Carol-Bleeding Heart.json": {
      "id": "s1dark.carol.bleeding-heart",
      "displayName": "Carol Fate",
      "aliases": ["Bleeding Heart", "Carol Fate", "Her Majesty"],
      "side": "villain",
      "threatLevel": null,
      "formKind": "base",
      "notes": "Canonical base form; required by the S1Dark season default."
    }
  }
}
```

Keys are paths relative to `Chars/` with forward slashes. Values override parsed fields. `entries` must be used for:
- multi-actor bundles:
  - `S1/Atropos couple.json` → `bundle: true`, `displayName: "Atropos Couple"`, actors Claire Atropos and Noah Atropos.
  - `S3/The Sensational Sirens.json` → `bundle: true`, `displayName: "The Sensational Sirens"`, actors Amy Matic and Tessa Ervone.
- known filename defects:
  - `S3/Selina Cross-Umbra.json` — the plan mentions a stray `)`, but the actual checkout filename has no parenthesis. Keep the explicit id `s3.selina.cross.umbra` and display "Selina Cross (Umbra)" so the historical defect cannot recur.
  - `S4/Pink Icicle (Coldhearted Ping Power).json` — "Ping"; override id `s4.pink.icicle.coldhearted-pink-power`, display "Pink Icicle", alias "Pink Power", note the typo.
  - `S3/Crazy Cupid (Treat Zara Embarr).json` — "Treat"; override formKind `treated`, id `s3.crazy.cupid.treated.zara.embarr`, display "Crazy Cupid".
  - `S4/Vaiva Petrauskaite-Colorgarde (Season 4 ver.).json` — surname spelling differs from S2 (`Petrauskait`); override display "Vaiva Petrauskaite", alias "Vaiva Petrauskaitė".
  - `S1Dark/Aurelia(Season Dark Version).json` — missing space; override id `s1dark.aurelia.season-dark-version`, display "Aurelia (Dark)".
- side corrections where tags/description are ambiguous. Overrides win over parsing.

Override values must be validated, not trusted blindly: unknown fields may be preserved in the registry entry? No — only the documented fields are emitted; unknown override keys should be ignored (or kept in a `notes`-style field only if declared).

## Parsing heuristics
Implement pure, exported functions so tests can exercise them without the filesystem:
- `parseCard(raw, { file, seasonId })` → entry before overrides/group resolution.
- `slugify(text)`.
- `classifyFilename(filename)` → `{ formKind, baseLabel, formLabel }`.
- `parseAliases(description)`.
- `parseSide(description, formKind, tags)`.
- `parseThreatLevel(description)`.
- `buildRegistry({ cards, overrides, formGroups })`.
- `validateRegistry`, `validateFormGroups`, `validateFormRules` (from `src/data/schema.js`).
- `main()` guarded by `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.

Side precedence:
1. override `side`
2. explicit `Side:` line in `data.description`
3. `formKind` map: corrupted/treated/infected/coldhearted/knighted/poisoned → `villain`; cleansed → `hero`
4. tags: `villain`/`villainess`/`evil`/`supervillain` → villain; `hero`/`heroine`/`superhero` → hero; `vigilante` → vigilante
5. `neutral`

Aliases precedence: override, else parse the `Aliases:` / `Aliases/Codenames:` line; split on `;`, `.`, and line breaks, strip parenthetical explanations and quotes, trim, dedupe, drop empty and overly long fragments. Do not dump whole prose paragraphs into aliases.

Threat precedence: override, else first token of `Threat Level:` (`S (A+ without ...)` → `S`, raw retained), else `null`.

## Form groups (author all 30)
`data/form-groups.json` is authoritative and season-scoped:

```json
{
  "schemaVersion": 1,
  "groups": [
    {
      "id": "s1dark.carol",
      "seasonId": "s1dark",
      "label": "Carol Fate / Bleeding Heart",
      "base": "S1Dark/Carol-Bleeding Heart.json",
      "members": [
        "S1Dark/Carol-Bleeding Heart.json",
        "S1Dark/Carol (Cleansed Bleeding Heart).json",
        "S1Dark/Carol (Infected Bleeding Heart).json",
        "S1Dark/Phantom Heart (Poisoned Bleeding Heart).json"
      ]
    }
  ]
}
```

Use `base`/`members` as **paths relative to `Chars/`** (the tool resolves them to IDs); this avoids circular ID authoring. Exactly one member is `base`. Membership determines `formGroup`, `formRole`, `altOf`.

Author these groups (base file first, then alternatives):

| Group | Base | Members |
|---|---|---|
| `s1.aurelia` | `S1/Aurelia-Longshot.json` | + `S1/Redraw (Corrupted Longshot).json` |
| `s1.tindur` | `S1/Tindur-Sharkbite.json` | + `S1/Blood Frenzy (Corrupted Sharkbite).json` |
| `s1.claire` | `S1/Claire Atropos.json` | + `S1/Claire Lachesis (Cleansed Claire Atropos).json` |
| `s1.carol` | `S1/Twisting Fate (Corrupted Carol Fate).json` | single (no in-season base) |
| `s1.vaiva` | `S1/Vaiva-Colorgarde.json` | + `S1/Light Shade (Corrupted Colorgarde).json` |
| `s1dark.carol` | `S1Dark/Carol-Bleeding Heart.json` | + Cleansed, Infected, Phantom Heart (Poisoned) |
| `s1dark.akui` | `S1Dark/Akui Koden-Cyber Sakura.json` | + `Heart Attack (Knighted Cyber Sakura)` |
| `s1dark.jacqueline` | `S1Dark/Jacqueline Webb-Poisoness.json` | + `Bittersweet (Knighted Poisoness)` |
| `s1dark.aurelia` | `S1Dark/Aurelia(Season Dark Version).json` | + `White Rabbit (Knighted Longshot)` |
| `s2.amy` | `S2/Amy Matic-Seasonal Siren.json` | + `Tribal Temptress (Corrupted Seasonal Siren)` |
| `s2.annabelle` | `S2/Annabelle Verd-Iron Maiden.json` | + `Wild Maiden (Corrupted Iron Maiden)` |
| `s2.monika` | `S2/Monika Matic-Monochromatic.json` | + `Blooming Crow (Corrupted Monochromatic)` |
| `s2.laura` | `S2/Laura Brimael-Demon Laura.json` | + `Savage Succubus (Corrupted Demon Laura)` |
| `s2.leila` | `S2/Leila Renya.json` | + `Leila Renya-Femme Feral.json` |
| `s2.vaiva` | `S2/Vaiva Petrauskait-Colorgarde (Season 2 ver.).json` | + `S2/Stygian Stalker (Corrupted Colorgarde).json` |
| `s3.umbra` | `S3/Selina Cross-Umbra.json` | + `Blood Bride (Corrupted Umbra)` |
| `s3.zara` | `S3/Zara Embarr.json` | + `Crazy Cupid (Treat Zara Embarr)` |
| `s3.lucia` | `S3/Lucia-Lulu-Illusi-Chamisulli.json` | + `Darkit (Treated Lucia Lulu Illusi)` |
| `s3.ellie` | `S3/Elizabeth-Ellie-Addison.json` | + `Executaur (Treated Elizabeth-Ellie-Addison)` |
| `s3.keira` | `S3/Keira Cooper.json` | + `Little Princess (Treated Keira Cooper)` |
| `s3.vireze` | `S3/Vireze Tylow-Midnight Treat.json` | + `Midnight Gift (Cleansed Midnight Treat)` |
| `s3.melissa` | `S3/Melissa-Liz-Ashton.json` | + `Oversight (Treated Melissa-Liz-Ashton)` |
| `s3.miracle` | `S3/Miracle-Mira-Nillava-VanillaMirror.json` | + `Pink Mirage (Treated Miracle-Mira-Nillava)` |
| `s3.emerald-allure` | `S3/Blood Bound (Corrupted Emeral Allure).json` | single (Tessa has no standalone S3 card; Sirens is a bundle) |
| `s4.anastasia` | `S4/Anastasia Carnaz-Gravitasha.json` | + Event Horizon (Corrupted), O.V.E.N.Snowfall (Coldhearted) |
| `s4.brie` | `S4/Brie Anderson-Hula Hawk.json` | + Bird Cage (Corrupted), Frost Flight (Coldhearted) |
| `s4.christina` | `S4/Christina-Chris-Goldclaw-Crimson Crush.json` | + Dark Dragon (Corrupted), Cyber Dragon (Infected) |
| `s4.claire` | `S4/Claire Atropos (Recorrupted).json` | + Ice Queen (Coldhearted Claire Atropos) |
| `s4.rosy` | `S4/Roseline-Rosy-Bellington-Pink Power.json` | + Shattered Shard (Corrupted), Pink Icicle (Coldhearted) |
| `others.evelyn` | `Others/Evelyn Yukon (Silent Whisp).json` | + `Peppermint Phantom (Corrupted Silent Whisp)` |

Bundles (`Atropos couple`, `The Sensational Sirens`) are **not** form groups. They stay one bundle entry with `actors`, are `npcEligible: false`, and must never be treated as a single character.

Standalone forms with no in-season alternative (`Others/Blazing Prism`, `S4/Selina Cross-Umbra (Vampire)`, `S4/Vaiva ... (Season 4 ver.)`) may keep `formGroup: null`. `formKind` still records the filename label; there is no exclusivity pair to track. Do not invent a group or a rule for them.

## Form rules
`data/form-rules.json`:

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "rule.s1dark.carol.cleansed",
      "from": "s1dark.carol.bleeding-heart",
      "to": "s1dark.carol.cleansed.bleeding.heart",
      "trigger": "cleansed",
      "sourceFaction": null,
      "reversibleBy": "recorruption",
      "permanent": false
    }
  ]
}
```

- One forward rule per alternative: `from = group base id`, `to = alt id`, `trigger = formKind`.
- Add reverse rules for reversible kinds (`cleansed`, `infected`, `poisoned`, `alt-version`, `coldhearted`), with `reversibleBy` naming the mechanism (`recorruption`, `cure`, `antidote`, `emotional`, `identity`). `corrupted`, `treated`, `knighted` are permanent unless the card says otherwise.
- Every non-base group member must be reachable by at least one rule. Every rule's `from`/`to` must resolve to registry IDs. No rule may cross seasons.

## Tool CLI
`node tools/build-data.mjs`:
- Reads `Chars/S1`, `Chars/S1Dark`, `Chars/S2`, `Chars/S3`, `Chars/S4`, `Chars/Others` (only top-level `*.json`).
- Reads `data/characters/overrides.json`, `data/form-groups.json`, `data/form-rules.json`.
- Parses, applies overrides, resolves groups, sorts entries by season order (`s1`, `s1dark`, `s2`, `s3`, `s4`, `others`) then `id`.
- Writes `data/characters/index.json` with `JSON.stringify(index, null, 2) + '\n'`.
- Prints a compact summary (per-season counts, bundles, groups).
- Exits non-zero on any parse/validation error with a specific file + reason.

`node tools/build-data.mjs --check`:
- Does **not** write.
- Validates parse, unique IDs, `altOf` resolution, exactly one base per group, every group member exists, every alt has an inbound rule, every rule ID resolves, all required fields/enums.
- Compares the generated bytes with the existing `index.json`; if they differ, fail with `registry out of date; run node tools/build-data.mjs`.
- Must be clean after a fresh generation.

## Runtime modules
`src/data/registry.js`
- `loadRegistry({ fetchImpl = fetch } = {})`: fetch `../../data/characters/index.json`, cache, validate, return it. Must work in SillyTavern's browser context and be skippable in Node tests.
- `buildRegistryIndex(registry)` → `{ byId, bySeason, byGroup }`.
- `getCharacter(registry, id)`, `getSeasonCharacters(registry, seasonId)`, `isBundle(entry)`, `getNpcPool(registry, seasonId)` (excludes `npcEligible === false`), `getAliases(entry)`.
- Never import UI or SillyTavern globals.

`src/data/forms.js`
- `buildFormIndex(registry, formGroups)` → group lookup with resolved entries.
- `getFormGroup(formIndex, id)`, `getBaseForm(formIndex, id)`, `getAlternateForms(formIndex, id)`, `getActiveForm(formIndex, state, groupId)` (state is `{ [id]: 'active' | ... }`; return exactly one active member or `null`).
- `findFormRule(rules, fromId, toId)`, `isLegalTransform(rules, fromId, toId)`, `getReversibleRules(rules, fromId)`.
- `assertFormExclusivity(formIndex, activeIds)` → returns/throws on two active members of one group. This is the contract Step 8 will reuse.

`src/data/schema.js`
- Tiny in-repo validators (no Ajv): `validateRegistry(registry)`, `validateFormGroups(formGroups)`, `validateFormRules(rules, registry)`, `validateCardSource(raw)`.
- Return `{ ok: boolean, errors: [{ path, message }] }`; the tool aggregates and prints. Do not throw for ordinary validation failures.

Use `src/core/logger.js` only if useful; tools should print plain errors to stderr.

## Tests (`tests/registry.test.js` + fixtures)
Must cover:
1. **Counts:** 78 entries; per-season 11/10/13/19/21/4; counts block matches.
2. **Source of truth:** a fixture card with a legacy top-level `name` that differs from `data.name` parses to the `data.name`; v2 card parses; malformed/missing `data` is rejected.
3. **IDs:** unique, season-prefixed, required exact IDs exist (`s1dark.carol.bleeding-heart`, `s2.leila.renya`); Leila S2 vs any S3 Leila (none) are distinct by season; known defect IDs corrected.
4. **Form groups:** 30 groups; exactly one base per group; every member resolves; every `altOf` equals its group base; S1 Twisting Fate, S3 Blood Bound, S4 Claire Recorrupted are group bases with non-base `formKind`; `Atropos couple` and `The Sensational Sirens` are bundles with 2 actors and `npcEligible: false`.
5. **Form rules:** every alt has an inbound rule; every rule resolves; reversed rules exist for reversible kinds; no cross-season rule.
6. **Helpers:** `getBaseForm`, `getAlternateForms`, `getActiveForm`, `findFormRule`, `assertFormExclusivity` behave (mini fixture).
7. **Gate:** spawn `process.execPath tools/build-data.mjs --check` with `cwd` = repo root and assert exit 0; assert `--check` does not modify `index.json`.

Fixtures live under `tests/fixtures/` and may be synthetic. Do not copy the full `Chars/` tree into fixtures.

## Gate commands
From repo root:

```bash
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js
"/mnt/c/Program Files/nodejs/node.exe" --check tools/build-data.mjs
"/mnt/c/Program Files/nodejs/node.exe" --check src/data/registry.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/data/forms.js
"/mnt/c/Program Files/nodejs/node.exe" --check src/data/schema.js
```

All must pass. `tests/settings.test.js` from Step 1 must keep passing.

## Acceptance criteria (from plan, adjusted to real counts)
- Registry covers all 78 cards (74 season + 4 Others).
- Every `altOf` resolves.
- Every form group has exactly one base.
- The five known filename defects are corrected via overrides.
- `node tools/build-data.mjs --check` is clean.
- Tests assert counts per season and form-group exclusivity.
- No runtime dependency added; no later-step files touched.

## Non-goals
- No season/faction/location authoring (Step 3).
- No WorldState or reducer (Step 4).
- No lorebook ingestion in this step (lorebooks are Step 3+).
- No NeoHorizon ingestion.
- No UI.
- No description/profile text stored in the registry; codex will read cards on demand later.

## Attempts
- Attempt 1 (implement-hard): complete; gate green (78 cards, 30 groups, 23 tests).
- Follow-up correction: S2 `Stygian Stalker (Corrupted Colorgarde)` was missing from the `s2.vaiva` group in the first draft of this brief; the group and a matching forward rule were added, and the registry/test were regenerated. Gate re-run green (45 rules).
- Review follow-up: Selina filename note corrected; intentional standalone bases documented above.

