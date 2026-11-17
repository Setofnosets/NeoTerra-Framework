# Brief — neoterra-framework-v1 / Step 6

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 6.
- **Title:** Context renderer, token budget, and interceptor.
- **Depends on:** Steps 1 and 4 (committed). Step 5 is independent.
- **Route:** standard implementer, medium effort.
- **Status:** implementing.
- **Runtime rule:** dependency-free ESM; no npm packages; browser-safe modules must not touch DOM at import time.
- **Run tests:** `"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js`
- **Gate:** full suite green.

## Objective
Render the six Neo Terra prompt blocks from `WorldState`, enforce per-block and total token caps, trim character profiles, apply the optional content gate to every block and agent prompt, and inject the result exactly once through SillyTavern's manifest `generate_interceptor`. No `setExtensionPrompt` path (double-injection landmine).

## Files (scope)
Create:
- `src/context/renderer.js`
- `src/context/budget.js`
- `src/context/interceptor.js`
- `src/context/worldbook.js`
- `src/core/content-gate.js`
- `tests/context.test.js`
- `tests/content-gate.test.js`

Small integration edits:
- `src/core/defaults.js` — add `context` block toggles/depth.
- `src/core/migrations.js` — normalize `context`.
- `manifest.json` — `generate_interceptor: "neoTerraGenerateInterceptor"`.
- `index.js` — expose the interceptor globally and remove it on dispose.

Do not add dependencies. Do not touch `plans/` commits, state reducers, agent client, or UI beyond this integration.

## Blocks
Stable headings/tags, rendered in this order:
`[NEOTERRA_SCENE]`, `[NEOTERRA_CAST]`, `[NEOTERRA_PLAYER]`, `[NEOTERRA_WORLD]`,
`[NEOTERRA_CONTINUITY]`, `[NEOTERRA_LORE]`.

- Scene: current location/district/control/status, in-game time, present names,
  combat/framing. Omit if there is no location, framing, or cast.
- Cast: present NPCs only (`controlledBy !== 'player'`), compact live profile.
  Full card profiles never enter context.
- Player: identity, name/form, role, status, resources, corruption, agenda,
  goals, outfit, persona notes.
- World: active factions, threats (stage label + progress), latest headlines.
- Continuity: ending status/path and bad-end records. Omit when empty.
- Lore: open canon beats (when a season is supplied), present-character
  relationships, optional caller lore entries. Omit when empty.

Empty state must render no headings. Toggles come from
`settings.context.blocks`; caps come from `settings.tokenBudget`.

## Budget
- `estimateTokens` is deterministic (`ceil(chars / 4)`).
- Per-block caps: `tokenBudget.scene|cast|player|world|continuity|lore`.
- Total cap: `tokenBudget.total`. Lowest-priority block (lore → continuity →
  world → player → cast → scene) is reduced/dropped first.
- Never exceed the ceiling, including headings and separators.
- Character profiles are trimmed to `tokenBudget.characterProfile` (and the
  per-character share of the cast cap).

## Content gate
- `applyContentGate(text, level, limits, context)`: `full` is byte-identical.
- Levels: `full`, `mature-only` (explicit sex minimized), `reduced` (fade to
  black + softened violence), `strict` (explicit/violent sentences removed).
- Per-character and per-player hard limits always win over the global level.
- `applyContentGateToPrompt` also appends "do not record new explicit acts"
  instructions in `reduced`/`strict`.
- Deterministic, no state mutation, non-string input throws.

## Interceptor
- `injectContextPrompt(chat, text, { depth })` removes any prior Neo Terra
  tagged message, then splices exactly one narrator/system message at depth
  (default 4).
- The interceptor renders from `ctx.chatMetadata.neoterra.worldState` (+
  optional season) and is a safe no-op when the state is missing/empty.
- Running twice against the same chat copy leaves exactly one tagged message.
- Errors never abort generation.

## Acceptance criteria
- Exact snapshot assertions for each block on a controlled fixture.
- No duplicate injection with repeated runs.
- Budget ceiling and per-block caps hold on oversized fixtures.
- Coverage for empty state, toggles, each gate level, hard-limit precedence,
  prompt instructions, profile trimming, and absence of `setExtensionPrompt`.
- Full test suite green.
