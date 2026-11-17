# Brief — neoterra-framework-v1 / Step 18

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 18 — Character Codex, settings
  surface, and theme polish.
- **Depends on (committed):** Steps 4, 8, 10, 11 (WorldState, cast, player
  panel, bad ends).
- **Route:** standard implementer, executed by the build agent directly with a
  verification loop; no re-planning.
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies.

## Implemented behavior

### 1. `src/ui/codex.js` (new)
- Pure view model `buildCodexView`: season-roster cast (manual additions
  included), sandbox registry characters, filters for search/side/form/location/
  status, played-character marking, non-canon marking.
- Detail view: live CharacterState (resources, status, form, corruption,
  agenda), full registry + live profile (aliases, tags, abilities, traits,
  likes/dislikes, notes, card path), form lineage, relationships, bad-end badge
  with read-only stored epilogue, and "Play as".
- Form swapping derives legal targets from `data/form-rules.json`; illegal swaps
  are rejected with the reducer reason.
- "Play as" confirmation explains the POV/narration change and NPC-pool swap.
  Roster-only outside Sandbox; Sandbox may seed a registry character that is not
  yet in the world. Non-roster/manual/imported characters carry the non-canon
  warning. Switching back to a custom persona is supported (reversible).
- Mounted panel uses delegated events, a focus-trapping modal, and in-place
  repaint. Widgets are wired into the shell's Characters tab.

### 2. WorldState reducer (additive)
- `SET_PLAYER_IDENTITY` accepts an optional `character` payload to add a
  Sandbox registry character atomically, and an optional `nonCanon` flag so the
  persistent warning survives reloads.

### 3. Settings surface
- `src/ui/settings.html` / `settings.js`: per-agent routing (connection profile,
  model, temperature, max tokens, cadence, `everyNTurns`, location-change),
  editable prompts with reset-to-default, content-gate hard limits (player +
  current-season characters), map options, settings JSON export/import, and a
  chat-world reset that deletes only this chat's world (and its generated world
  book).
- Settings remain normalized by the existing migration layer; defaults are
  unchanged (content gate `full`/off, deadline pressure `standard`).

### 4. Theme polish
- `src/ui/theme.css` gains semantic color/motion tokens; `style.css` consumes
  them for codex, player sheet, bad-end, ending, choices, dialogs, and existing
  map/shell surfaces. Reduced-motion rules cover new transitions. No hardcoded
  colors in new UI.

### 5. `tests/codex.test.js`
- Codex filters/played marker, transformation reflection, form-rule rejection,
  bad-end badge/epilogue escaping, Play-as confirmation/options, Sandbox seed +
  reversibility, non-canon warning, and settings markup/routing coverage.

## Verification
```bash
"/mnt/c/Program Files/nodejs/node.exe" --check index.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check
"/mnt/c/Program Files/nodejs/node.exe" tools/build-map.mjs --check
```

## Out of scope
- Full numeric combat (Step 19).
- Release docs, full world import/export, and final QA (Step 20).
