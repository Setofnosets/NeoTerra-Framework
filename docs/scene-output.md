# In-chat scene output

The chat is the primary surface. Neo Terra writes short **scene frames** into
the same SillyTavern chat as ordinary narrator messages, and keeps the world
state out of the transcript (see [Prompt-only world state](#prompt-only-world-state)).

A frame is built by `buildSceneChatMessage` in `src/ui/chat-output.js`:

- `name: "Neo Terra"` and a bundled avatar (`force_avatar`);
- `is_user: false` and **`is_system: false`** — SillyTavern filters system
  messages out of the generation history, so a frame must not be a system
  message;
- `send_date` as an ISO string;
- `extra.neoterra.scene = { kind, key, ...extra }`, where `key` is the dedupe
  key.

`postSceneMessage(ctx, message, { dedupeKey })` appends the frame to `ctx.chat`,
renders it with `ctx.addOneMessage`, and awaits `ctx.saveChat()` when it returns
a promise. It returns `{ posted, index, reason?, deduped? }`, where `index` is
the new (or deduped) message index. A repeated dedupe key (a double
`MAP_UPDATED`, a remount, or a swipe) posts nothing and returns
`deduped: true`. A missing chat, `addOneMessage`, or `saveChat` never throws:
the result is `{ posted: false, reason }` or a partial success such as
`{ posted: true, index, reason: 'not-rendered' }`.

Scene text is defensively stripped of `[NEOTERRA_*]` blocks. A frame is scene
narration, never a world-state dump.

## Season start

`enterSeason` seeds the world, then `onEntered` posts one `kind: 'opening'`
frame:

- the deterministic opening text;
- a short **"your move"** block:
  - `Season started — <title>`
  - `You are <player>, <role>, at <location>.`
  - `Goals: ...` (canon/player goals, or a neutral fallback)
  - `Current situation: ...` (`scene.framing`, the active threat/agenda, or
    the season premise)
  - `Current action: none yet — the opening is yours.`
  - `Your move: describe your first action, or pick a suggestion below.`

The shell then closes and `#send_textarea` is focused. The opening is posted
only when a chat and chat id exist; a chat switch during the awaited save skips
the post.

When `cyoa.enabled` is on, choices are requested for the opening frame. If
`kickoff.auto` is on **and** the chat was fresh before the season started, the
frame's chip request is skipped and one player prompt is sent through
SillyTavern's normal send path instead, so the narrator's reply owns the
choices.

| Setting | Default | Meaning |
| --- | --- | --- |
| `kickoff.auto` | `false` | Send `kickoff.prompt` as one player message on a fresh chat. |
| `kickoff.prompt` | editable string | The player prompt used by auto-kickoff. |
| `cyoa.enabled` | `false` | Request exploration choices after frames and turns. |

Auto-kickoff is suppressed when the chat already has story history. The
opening frame, kickoff card, and input focus are always the default start
signal.

## Travel

Travel keeps the **same chat** and the same character card. A successful
`travel()` posts one `kind: 'travel'` frame:

```
Location changed: <from> → <to>

<travel intro, including the encounter paragraph when one was detected>
```

The travel record is attached to the new message as `extra.neoterra.travel`
(swipe/reload still shows where the player came from). The map is refreshed and
`MAP_UPDATED` is emitted; CYOA is requested for the new message index when
`cyoa.enabled` is on. The arrival frame is posted whether or not an encounter
was detected.

A rejected travel (`!ok`, blocked route, active combat) posts nothing and keeps
the map open. A chat switch during travel aborts the post through the existing
chat-affinity guard. Travel does not run `initiative.afterTurn`; it already ran
its own location storyline pass.

### Closing the map

`map.closeOnTravel` (default **`true`**) closes the Neo Terra shell as soon as
the arrival frame is posted and saved, revealing the chat. The choices request
runs afterwards and does not delay the handoff. It never closes on a rejected
travel, a map refresh, or a tab switch.

The map toolbar's **×** (`data-neoterra-map-close`) closes the shell through
the panel's `onClose` callback (previously it only moved the panel's internal
state machine to `closed` and hid nothing).

## Encounters

An encounter is derived from `WorldState`, never authored. `detectEncounter`
in `src/flows/encounter.js` returns `null` or
`{ locationId, characterIds, threatNames, source }`:

- active combat ⇒ no encounter;
- a living character on the **opposite side** of the player ⇒ encounter;
- an active threat at the location ⇒ encounter;
- same-side villains are allies (important for S1Dark), neutrals never
  trigger, and neutral/custom players are treated as heroes;
- nothing on either list ⇒ no encounter.

`scene.finalize` persists the result as `scene.encounter` (or `null`), so the
next prompt's `[NEOTERRA_SCENE]` block includes `Encounter:` and
`Threats here:`. The arrival intro appends one deterministic sentence naming
the hostiles. An encounter does **not** start combat and does not block travel.

A small **encounter bar** above the input exposes:

- **Engage** — enabled only when the encounter has at least one hostile
  character id. Calls the deterministic combat flow with the player actor
  (the canon character id, or `'player'` for a custom persona) and the hostile
  ids, posts one `kind: 'combat'` frame, hides the bar, and requests choices in
  `combat` mode when `cyoa.combatChoices.enabled` is on.
- **Talk** — focuses the input and keeps the prose/CYOA path; no state change.
- **Avoid** — hides the bar and records `flags.encounter.avoidedKey` (not
  `scene.encounter`, which is recomputed). A new encounter key or location
  resets it.

Threat-only encounters (no character ids) disable Engage with a short reason;
they stay prose + CYOA. While combat is active the bar offers **Surrender** and
**End combat**, so a conflict that blocks travel always has an exit; both post
a short resolution frame.

## Turn pipeline

`handleAssistantMessage` runs once per **genuinely new** assistant message.
`createTurnGate` dedupes by chat id, message index, and message identity, so a
swipe or a re-render does not tick twice. For a new turn,
`runTurnPipeline` runs:

0. resolve automatic clock holds for an active encounter or beat (best-effort;
   `clock.autoHold` only enables combat holds by default, so encounter and beat
   holds are off unless the setting is turned on);
1. `TICK_TIME` with `turns: 1` (advances `meta.turn`, so beat deadlines and the
   `everyNTurns` cadence can fire);
2. the off-screen **world tick** when `worldTick.enabled` is on and the clock
   stage succeeded — faction influence (`state.factions`), threat progress
   (`state.threats`), NPC movement (`state.characters`), rumors, and headlines
   (world events), with tick bookkeeping under `flags.worldTick` (see
   `docs/world-tick.md`);
3. the deterministic **pacing** analysis when `pacing.enabled` is on; it writes
   only `flags.pacing` and never changes story state (see `docs/pacing.md`);
4. the player **State Tracker**, when `agents.stateTracker.enabled` is on; its
   events are applied atomically, and a failure keeps the previous state;
5. the **Storyline Tracker** via `initiative.afterTurn`, on its existing
   `everyNTurns` (default 6) / location-change cadence — not every turn;
6. the **Lore** pass (`initiative.runLore`) every `agents.lore.everyNTurns`
   turns (default 10) or when the act boundary changes. It writes
   `flags.lore.recap` (the Journal's "Previously on" paragraph) and keeps the
   agent's entries alongside it;
7. the **Auditor** (`initiative.runAudit`) at act boundaries (with an optional
   turn cadence). Findings are stored under `flags.auditor` and surfaced as
   non-blocking toasts; they never block the turn;
8. a present-cast refresh (`scene.refreshCast({ runDirector })`), which updates
   `scene.present`, `scene.encounter`, and `[NEOTERRA_SCENE]`; manual
   pins/removals still win. The **Cast Director** runs when
   `agents.castDirector.enabled` is on and the `sceneChange` / `everyNTurns`
   cadence is due. Travel always requests an arrival pass;
9. `MAP_UPDATED` with `reason: 'turn'` and a mounted map refresh;
10. the interaction UI refresh, then CYOA **after** the trackers so the options
    reflect the new state.

Each stage is isolated: a tracker failure is logged and does not block choices.
`runTurnPipeline` returns per-stage reports and an `errors[]` array; the shell
turns those into non-blocking error toasts with a **details** link that opens
the agent log window (`/neoterra log`). The `MAP_UPDATED` refresh and the
interaction runtime share one per-chat `WorldState` store, so a write is visible
to the map without a remount.

The optional **Architect** pass runs once when a season starts and only when
`agents.architect.seasonStart` is explicitly turned on (default off); the agent
itself remains enabled for explicit runs. It never delays the opening frame or
the choices request.

## Prompt-only world state

`WorldState` lives in `chatMetadata.neoterra` and is persisted per chat. It is
**never written into `ctx.chat`** as a message. `neoTerraGenerateInterceptor`
(`src/context/interceptor.js`) renders the enabled blocks (`SCENE`, `CAST`,
`PLAYER`, `COMBAT`, `WORLD`, `CONTINUITY`, `LORE`) into the **prompt copy** at
`context.depth`, strips any previous `extra.neoterra.context` message first, and
never pushes to `ctx.chat` or calls `saveChat`.

This is the same separation Combat-Multihog uses for its state memo: the
structured state is part of the prompt, not the transcript. Re-running a
generation replaces the injected copy instead of duplicating it. Scene frames
are the only visible Neo Terra chat elements; there is no in-chat status strip
or HUD.

## Encounter, notice, and scene-description frames

Three optional frames can follow the deterministic arrival frame. Each is an
ordinary assistant message (`is_system: false`, `is_user: false`) and none
writes to `ctx.chat` outside its own visible text.

| Frame | `kind` | When | Dedupe key |
| --- | --- | --- | --- |
| Notice | `encounter` | `travel.noticeFirst` and a hostile spots the player | `encounter:<chatId>:<from>:<to>:<turn>:notice` |
| Ambush | `encounter` | `travel.ambush`, strong hostile success, hostile/contested district, no stealth arrival | `encounter:<chatId>:<from>:<to>:<turn>:ambush` |
| Travel description | `scene` | `agents.sceneDescriber.enabled` after arrival | `scene-desc:<chatId>:<travelKey>` |

**Notice vs ambush.** `detectNotice` is a deterministic seeded check
(`chatId + turn + encounterKey`). The default notice is prose plus an
`encounter` frame: the hostile spots the player, the player still moves first,
and no state changes. An **ambush** is the exception: when the check is a strong
success (`margin >= 5`) in a `hostile`/`contested` location and the player
arrived without stealth, the shell posts one ambush frame, starts combat through
the existing `createCombatFlow.start` (player side `a`, hostiles `b`), records
`flags.lastCombat.ambush = true` and `scene.combat.opening = 'hostile'`, and
shows the encounter bar in a **Surprised** state for one round. The first chip
set is restricted to `defend`, `retreat`, `talk-down`, and `surrender`. No
hostile action is resolved automatically, so the engine still has no NPC turns.
Kill switches: `travel.noticeFirst` and `travel.ambush` (both default `true`).

`buildLocationIntro` appends one neutral notice/ambush line when the scene
carries `scene.noticed` / `scene.ambush`, and `[NEOTERRA_SCENE]` renders
`Noticed:` / `Ambushed by:` so the next prompt knows.

**Travel description.** `src/agents/scene-describer.js` runs one short pass
(`agents.sceneDescriber`, temperature 0.85, 320 tokens, 12 s timeout, cadence
`onTravel`) grounded in the location, time, present NPCs, encounter facts, and
season tone. It posts at most one `scene` frame, content-gated and stripped of
context blocks. Failure, timeout, or a chat switch posts nothing and logs at
debug; the map close is never blocked. The last 10 descriptions are mirrored in
`WorldState.flags.travelDescriptions` (shaped `{ key, text, at }`) for the map
sidebar.

## Settings used here

| Setting | Default | Effect |
| --- | --- | --- |
| `kickoff.auto` | `false` | Auto-send one player kickoff on a fresh chat. |
| `kickoff.prompt` | editable | The auto-kickoff text. |
| `cyoa.enabled` | `false` | Exploration choices after a frame/turn. |
| `cyoa.combatChoices.enabled` | `false` | Tactical chips while combat is active. |
| `map.closeOnTravel` | `true` | Close the shell after a successful travel post. |
| `travel.noticeFirst` | `true` | Post one `encounter` frame when a hostile spots the player. |
| `travel.ambush` | `true` | Allow a deterministic ambush in hostile/contested districts. |
| `agents.sceneDescriber.enabled` | `true` | Post one generated `scene` frame after arrival. |
| `agents.stateTracker.enabled` | `true` | Run the player tracker every assistant turn. |
| `agents.storyline.everyNTurns` | `6` | Storyline cadence, in turns. |
| `agents.storyline.onLocationChange` | `true` | Also run the storyline on travel. |

Tests: `tests/chat-output.test.js`, `tests/encounter.test.js`,
`tests/travel.test.js`, `tests/choices.test.js`, `tests/state-tracker.test.js`,
`tests/context.test.js`.
