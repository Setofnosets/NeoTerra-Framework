# Brief — neoterra-framework-v1 / Step 10

## Contract
- **Plan:** `plans/neoterra-framework-v1.md`, Step 10.
- **Title:** Player State Tracker and player panel.
- **Depends on:** Steps 4, 5 (committed); Step 9 shares the additive player reducer events.
- **Route:** standard implementer (medium risk).
- **Status:** implemented and verified locally.
- **Runtime rule:** dependency-free ESM, browser-safe modules. No new dependencies, no data changes.

## Objective
Add a cheap player-only per-turn tracker and the modular player sheet. The tracker follows the custom persona or the played canon character, never touches NPCs, and respects manual sheet edits for one pass. The panel renders live state, the "Playing as" badge, and villain-POV labels.

## Files
- `src/agents/state-tracker.js` (new)
- `src/ui/player-panel.js` (new)
- `tests/state-tracker.test.js` (new)

Shared reducer additions (also documented in Step 9): `SET_PLAYER_FIELDS` for status/skills/traits/injuries/allegiance/agenda/goals and `PLAYER_RELATIONSHIP_DELTA` for a custom persona's relationships. Existing `SET_PLAYER_STAT` and `RELATIONSHIP_DELTA` are reused.

## Implemented behavior
- **Tracker target:** custom persona or `player.characterId` canon mirror. Identity switching is observed at normalization time, so the next pass targets the new player atomically through `SET_PLAYER_IDENTITY`.
- **Extraction paths:** stamina current/max, willpower current/max, status, outfit, mood, notes, corruption stage/progress, skills, traits, injuries, allegiance, agenda, goals, and player relationships.
- **Clamping:** stamina/willpower at 0..max, corruption progress at 0..100, non-negative corruption stage.
- **NPC safety:** the schema has no character selector; normalization accepts only player paths, rejects unknown/status-invalid values, and never writes an NPC.
- **Manual precedence:** `applyManualPlayerEdit` applies the edit and records `flags.playerTracker.manualEdits[path]`; the next tracker change for that path is suppressed and the marker is cleared after that pass. Empty/malformed tracker responses are true no-ops (no metadata writes).
- **Atomic apply:** `applyStateTrackerResult` applies the whole batch through `applyWorldEvents` + one `store.replace`; any failure leaves the previous state unchanged.
- **Panel:** pure `buildPlayerSheet` + `renderPlayerPanelMarkup`, and `mountPlayerPanel` with submit handling. Shows portrait initials, name, "Playing as" badge, stamina/willpower meters, status chips, form, allegiance, corruption, agenda, skills, traits, injuries, goals, relationships, and a manual edit form. Villain-POV seasons use Dominion/Conviction/Standing/Loyalty/Ascension labels. Manual edits only mark fields that actually changed.
- **No reload needed:** `refreshPlayerPanel` rebuilds from the store; `mountPlayerPanel` repaints after each manual edit.

## Verification
- `node --check` on every touched file.
- `node --test tests/*.test.js`: **195 pass / 0 fail** (Step 10 added 13 tests).
- Required cases covered: custom persona, played canon mirror, manual-edit precedence + one-pass clearing, stamina/willpower clamping, malformed response no-op, NPC non-editing, identity switch, villain-POV labels, panel markup/read-only mode, state-reflecting refresh, disabled/aborted/failed agent passes.

## Out of scope (later steps)
- Codex "Play as" UI and settings surface (Step 18).
- Combat deltas in the tracker (Step 19).
- Bad-end detection (Step 11).

## Review resolution
- Inherited the Step 9 reducer fix: `PLAYER_RELATIONSHIP_DELTA` now copies relationships before mutating.
- Panel manual edits skip unchanged fields, so only real changes are marked manual.
