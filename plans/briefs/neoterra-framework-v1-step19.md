# Brief — neoterra-framework-v1 / Step 19

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 19 — Dice-based conflict
  resolver and combat integration.
- **Depends on (committed):** Steps 4, 6, 10 (WorldState/reducer/store,
  context renderer, player tracker).
- **Route:** implement-hard, medium effort. No re-planning.
- **Runtime rule:** dependency-free ESM, browser-safe. No new dependencies.
- **Core invariant:** the resolver is pure and authoritative. The narrator
  describes outcomes; it never decides them. No HP, no damage numbers in prose.

## Files
Primary:
- `src/combat/resolver.js` (new, pure)
- `src/combat/outcome.js` (new, pure)
- `src/combat/combat-state.js` (new, state/flow + ST integration)
- `src/agents/state-tracker.js` (combat authority)
- `src/context/renderer.js` (combat block)
- `tests/combat.test.js` (new)

Required additive integration (do not expand beyond these):
- `src/state/reducer.js` — add `SET_CHARACTER_STAT` and carry combat metadata
  through `COMBAT_START`.
- `src/context/budget.js` and `src/core/defaults.js` — add the `combat` block
  cap/priority/toggle. Existing migration normalization picks up new defaults.
- `src/agents/choices.js` — consume the action/risk vocabulary from the
  resolver instead of duplicating it.
- `src/ui/shell.js` — register/unregister the function tool and
  `/neoterra-roll`; add the combat flow to the interaction runtime.

Do not add UI panels, new CSS, agents, schemas, or dependencies. Do not touch
map/travel/ending/bad-end behavior except where explicitly stated.

## Implemented behavior

### 1. Vocabulary and risk (`src/combat/resolver.js`)
- Export `COMBAT_ACTIONS` = `['strike','defend','grapple','feint','skill','retreat','surrender','talk-down']`
  and `COMBAT_RISK_TIERS` = `['low','moderate','high','extreme']`.
- Export a deterministic action→risk map:
  - low: defend, talk-down, surrender
  - moderate: feint, retreat, skill
  - high: strike, grapple
- Export `normalizeCombatAction(value)` tolerant of case and spaces
  (`"Talk Down"` → `talk-down`); unknown returns `null`.
- Export `createSeededRng(seed)` (mulberry32 or equivalent) and
  `rollD20({ seed, round, actorId, targetId, action, sequence })` using a
  stable FNV-1a-style hash of all inputs so a replay with the same seed and
  inputs returns the same die. A caller-supplied integer `roll` overrides RNG.
- Export `resolveAction({ seed, round, actorId, targetId, action, roll,
  attribute = 0, skill = 0, situational = 0, targetDefense = 10 })`:
  - `total = d20 + attribute + skill + situational`; `margin = total - targetDefense`.
  - Five tiers, exactly:
    - `critical-fail`: die === 1, or margin <= -10
    - `fail`: margin >= -9 and <= -5
    - `partial`: margin >= -4 and <= -1
    - `success`: margin >= 0 and <= 9
    - `critical-success`: die === 20, or margin >= 10
    - `die === 20` wins over a very negative margin; `die === 1` wins over a
      very positive margin.
  - Return `{ action, risk, roll: die, total, margin, tier, modifiers }`.
  - Invalid action, non-finite modifiers, or self-target where a target is
    required throws a clear `Error` (callers translate to `{ok:false}`).

### 2. Outcomes and deltas (`src/combat/outcome.js`)
- Export `OUTCOME_TIERS` in order and `DEFAULT_TIER_DELTAS` with bounded
  resource deltas (never more than 20 magnitude):
  - critical-success: target stamina -15, target willpower -6
  - success: target stamina -9, target willpower -3
  - partial: target stamina -4, target willpower -1, actor stamina -4, actor willpower -2
  - fail: actor stamina -8, actor willpower -3
  - critical-fail: actor stamina -12, actor willpower -8
  - corruption: critical-fail actor +2 progress; fail actor +1 progress; all
    other tiers 0. Clamp progress 0–100. No stage changes.
- Scale magnitude by risk (`low 1.0`, `moderate 1.25`, `high 1.5`,
  `extreme 1.75`) and round to integers; final magnitude must stay ≤ 20.
- Export `buildOutcome(result, options)` returning
  `{ tier, risk, deltas: { actor: {...}, target: {...} }, contract }`.
  `contract` is one deterministic sentence per tier (decisive success, clean
  success, costly partial, failure, backfire) plus the fixed instruction:
  “Describe only this result. Do not decide the next outcome, invent damage
  numbers, or narrate a different tier.”
- Export `outcomeEvents({ outcome, actorId, targetId, state })` producing
  reducer-ready events:
  - `SET_PLAYER_STAT` for a custom persona (`actorId === 'player'`) and for a
    canon player (`state.player.characterId`), so the mirror and character stay
    in sync.
  - `SET_CHARACTER_STAT` for ordinary NPCs.
  - Clamp resources to `[0, max]`; omit zero deltas.
  - No damage numbers in event summaries.

### 3. Combat state flow (`src/combat/combat-state.js`)
- `createCombatFlow({ store, getSettings = null, now = Date.now, log = null })`.
- `start({ participants, sides = null, stakes = '', intent = '', kind = 'skirmish',
  locationId = null, seed = null })`:
  - Participants must be 2+ distinct ids. `'player'` is allowed only when
    `state.player.identity === 'custom'`; otherwise use the canon character id.
    Player-controlled canon characters are ordinary valid participants on
    either side (never excluded).
  - `sides` maps participant id → `'a'|'b'`; if omitted, alternate the list in
    order. If provided, every participant must be present and both sides must
    be non-empty.
  - Dispatch `COMBAT_START` with the existing fields plus `id`, `stakes`,
    `intent`, `seed` (caller value or `now()`), `sides`, `round: 0`,
    `maxRounds` (settings `combat.maxRounds`, default 8, clamp 3–20),
    `status: 'active'`, `actions: []`.
  - Return `{ ok, combat }`; reject when combat is already active.
- `resolve({ actorId, targetId = null, action, attribute, skill, situational,
  targetDefense, roll = null })`:
  - Require an active conflict; actor must be a participant. `defend` may
    self-target; every other action requires a different participant target
    (surrender may omit the target).
  - `surrender` ends immediately without a die roll: record the action,
    optionally mark a canon player `captured`, store `flags.lastCombat`, dispatch
    `COMBAT_END`, and return `{ ok: true, ended: true, endReason: 'surrender' }`.
  - Otherwise resolve, build the outcome, dispatch delta events and an
    `ADD_EVENT` (`tags: ['combat']`, summary without numbers), append a compact
    action record (round, actorId, targetId, action, risk, tier, roll, total,
    margin, contract) to `scene.combat.actions` (cap 50), increment `round`.
  - End conditions, checked in order: surrender, any participant stamina at 0
    (including custom player mirror) → `stamina-zero`; `round >= maxRounds` →
    `round-cap`.
  - On end: record `endedTurn`, `endReason`, `winnerSide`/`loserIds` where
    inferable and `flags.lastCombat` summary; dispatch `COMBAT_END` (clears
    `scene.combat` and `meta.inCombat`). No death/HP semantics. Do not invent
    bad ends.
  - Return `{ ok, outcome, action, ended, endReason, state }`. On invalid input
    return `{ ok: false, reason, message }` and leave state unchanged.
- `surrender({ characterId })` convenience wrapper and `end({ reason })`.
- `activeCombat()` reads `store.get()?.scene?.combat`.
- Keep `scene.combat` JSON-serializable and schema-valid (schema currently only
  validates `locationId`/`participants`; extra fields are allowed).

### 4. Reducer additions (`src/state/reducer.js`)
- `SET_CHARACTER_STAT(characterId, path, value)` with paths
  `stamina.current|stamina.max|willpower.current|willpower.max|corruption.stage|corruption.progress`.
  Clamp current to max/0, clamp corruption progress 0–100, reject negative
  stage, sync the player mirror when the target is the player. Mirror the
  existing `SET_PLAYER_STAT` semantics. Reject unknown paths.
- `COMBAT_START` preserves additive metadata (`id`, `stakes`, `intent`, `seed`,
  `sides`, `round`, `maxRounds`, `status`, `actions`) without breaking the
  existing minimal shape asserted by `tests/reducer.test.js`.
- No changes to existing event behavior or validation beyond `SET_CHARACTER_STAT`
  support.

### 5. Narrator override (`src/context/renderer.js`, `budget.js`, `defaults.js`)
- Add block id `combat` with heading `[NEOTERRA_COMBAT]`, rendered only while
  `state.scene.combat` is an active object or `meta.inCombat === true`.
- Content is deterministic:
  - conflict kind/stakes/intent, round and cap
  - participants with side, name, status, stamina/willpower
  - last action: actor, action, target, risk, tier, margin (`+3`/`-2`, not
    damage)
  - the outcome `contract`
  - fixed rule: describe only the resolved result; do not decide outcomes,
    invent numbers, or add HP/damage.
- Hide the block entirely when combat is inactive. Do not duplicate the
  existing one-line “Combat: active” in `[NEOTERRA_SCENE]`; remove that line
  from scene so combat appears exactly once.
- Add `combat` to `CONTEXT_BLOCK_IDS`, `BLOCK_PRIORITY` (after player, before
  world), `DEFAULT_TOKEN_BUDGET.combat` (500), `DEFAULT_SETTINGS.tokenBudget.combat`
  (500), and `DEFAULT_SETTINGS.context.blocks.combat = true`.

### 6. Tracker authority (`src/agents/state-tracker.js`)
- When combat is active (`meta.inCombat` or `scene.combat`), the engine owns
  stamina, willpower, and corruption. In `normalizeStateTrackerResult`,
  suppress changes to `stamina.current|stamina.max|willpower.current|willpower.max|corruption.stage|corruption.progress`
  with reason `combat-engine-owned`; keep status/outfit/mood/notes/skills/
  traits/injuries/agendas/relationships. This prevents double-applying combat
  deltas.
- In `buildStateTrackerPrompt`, add a Combat section (round, stakes, last
  outcome tier/contract) and the rule that the resolver owns those resources.
- Do not let the tracker edit NPC combat state.

### 7. Standalone SillyTavern integration
- In `combat-state.js` export `registerCombatIntegrations({ ctx, getCombat,
  getSettings, log })` and `unregisterCombatIntegrations({ ctx })`.
- Register one function tool named `neoterra_roll` when
  `ctx.registerFunctionTool` exists:
  - parameters: `{ action, actorId?, targetId?, attribute?, skill?,
    situational?, targetDefense?, seed? }`, action enum from `COMBAT_ACTIONS`.
  - action: call `getCombat()?.resolve(...)`; return a short JSON/string status
    (`{ok, tier, contract, ended, endReason}`) and never throw. Unregister
    before re-registering and on dispose.
- Register `/neoterra-roll` when `SlashCommand.fromProps` and
  `SlashCommandParser.addCommandObject` exist. Accept a raw unnamed argument
  string `action [targetId] [modifier]`; with active combat resolve it, without
  combat return a seeded d20 check line. Remove the parser entry on dispose,
  mirroring the `/neoterra` pattern.
- `src/ui/shell.js`: create `combat = createCombatFlow({store, ...})` inside
  `buildInteractionRuntime` and expose it. Call `registerCombatIntegrations`
  in `initialize` after the slash command, using `interactionRuntime` (building
  it lazily via the existing cached builder if needed). Call
  `unregisterCombatIntegrations` in `dispose`. No other shell behavior changes.
- `src/agents/choices.js`: re-export/import `COMBAT_ACTIONS` and
  `COMBAT_RISK_TIERS` from `../combat/resolver.js` (keep its public exports
  working). No circular dependency: resolver must not import choices.

### 8. Tests (`tests/combat.test.js`)
Use the same fixture/seed pattern as `tests/state-tracker.test.js` /
`tests/reducer.test.js`. Cover:
- seeded determinism: same seed + inputs twice → identical roll/total/tier;
  supplied `roll` hits every tier boundary, including 1 and 20.
- bounded deltas: every tier/risk stays within 0–20 magnitude and resources
  clamp at 0/max after applying to state.
- start validation: duplicate participants, one participant, unknown side,
  already-active conflict rejected without state change.
- resolution applies deltas to NPCs and to a canon player (mirror + character),
  and supports a custom persona as `'player'`.
- player-controlled canon character is a valid combatant on either side.
- conflict ends on surrender, stamina 0, and round cap; `scene.combat` clears,
  `meta.inCombat` false, `flags.lastCombat` records the reason.
- renderer: combat block appears only while active, includes `[NEOTERRA_COMBAT]`,
  the contract, and the “do not decide outcomes” rule; absent when inactive.
- travel is blocked while combat is active (`isTravelBlockedByCombat`) and
  allowed again after `COMBAT_END`.
- state tracker suppresses engine-owned resources during combat and accepts
  normal stamina changes outside combat.
- `COMBAT_ACTIONS`/`COMBAT_RISK_TIERS` exported by `choices.js` are the same
  values as the resolver.

## Verification
```bash
"/mnt/c/Program Files/nodejs/node.exe" --check index.js
"/mnt/c/Program Files/nodejs/node.exe" --test tests/*.test.js
"/mnt/c/Program Files/nodejs/node.exe" tools/build-data.mjs --check
"/mnt/c/Program Files/nodejs/node.exe" tools/build-map.mjs --check
```

## Out of scope
- Numeric HP, damage numbers, tactical grids, combat UI panels.
- New agents or LLM calls for combat.
- Changes to map/travel/ending/bad-end flows beyond the combat guard already
  present.
- Extensibility docs and release QA (Step 20).

## Attempts
(none yet)
