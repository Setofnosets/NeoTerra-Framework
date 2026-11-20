# CYOA choices

Choice buttons are optional and **off by default**. There are two independent
settings: exploration choices and tactical combat choices.

## Exploration choices

`cyoa.enabled` turns on a chip row above the input after an assistant message.
The Choices Agent reads the last few messages and `WorldState` and returns 2–6
choices (default **4**).

Each choice carries `{ label, intent, tone, risk }`.

- **Label length**: up to **100 characters** by default (`cyoa.maxLabelLength`).
  Longer labels are truncated/validated.
- **Themes**: `auto` (default), `heroic`, `villainous`, `romantic`, `noir`,
  `comedic`, `tactical`, `lewd`.
  `auto` derives tone from the season, scene, and player role, so S1Dark gets
  villain-flavoured choices without configuration.
- **Content mix weights**: action, dialogue, romance, investigation, travel,
  lewd.
- **Prompt override**: optional per-theme text that replaces the built-in
  instructions.

Clicking a chip sends exactly that text through SillyTavern's normal send path
as the player's message, then hides the row. "Write my own" is always
available and never removed. A regenerate button requests a fresh set.

### Timing: frames, turns, and the tracker

Choices are requested for a Neo Terra scene frame as well as for a normal
assistant message. The request does not depend on a `MESSAGE_RECEIVED` event:
`shouldGenerateChoices` accepts a non-user last message, and `cyoa.enabled`
remains the gate.

On a normal assistant turn the order is:

1. tick the world clock (`meta.turn += 1`) once for a genuinely new message;
2. run the player State Tracker and apply its events;
3. run the Storyline Tracker on its `everyNTurns`/location-change cadence;
4. refresh the present cast and the map UI;
5. request CYOA with the updated state.

A swipe or re-render of the same assistant message does not tick or
double-apply, and does not request a second set for that index. A tracker
failure is logged; the previous state stands and choices are still requested.

Frame-specific behaviour:

- **Season opening** — choices are requested for the opening message when
  `cyoa.enabled` is on. If `kickoff.auto` will immediately send a player
  prompt, the frame's request is skipped so the narrator's reply owns the
  chips.
- **Travel arrival** — choices are requested for the arrival message, even
  though no receive event fired. A rejected travel requests nothing.
- **Encounter bar** — **Talk** keeps the prose/CYOA path. **Engage** starts
  combat and requests choices in `combat` mode; tactical chips still require
  `cyoa.combatChoices.enabled`.
- **Combat** — while a conflict is active the exploration row is replaced by
  the tactical row (when enabled) or hidden.

## Combat choices

`cyoa.combatChoices` is a second, independent setting. It applies only while a
conflict is active and **both** switches are on.

- Own enable toggle, count, theme (default `tactical`), label cap, content mix,
  and prompt override.
- Constrained to actions the resolver understands: **strike, defend, grapple,
  feint, skill, retreat, surrender, talk down**.
- Each chip shows the resolver's risk tier.
- If the resolver cannot parse a generated action, it is dropped rather than
  sent as an invalid command.
- When combat ends, the tactical row is replaced by the exploration row or
  hidden; no stale combat action is sent.

## Guards

- Generate only when the last message is the assistant's (including a Neo Terra
  scene frame; scene frames are `is_user: false`, `is_system: false`).
- Generate only while generation is idle.
- Never generate on the ending screen.
- Never auto-generate immediately after a clicked choice (prevents a loop).
- Cache per message **and per swipe**.
- Filter through the content gate and per-player/per-character limits.
- A malformed or failed agent response hides the row without an error toast.
- If all choices are filtered out, the row hides instead of rendering empty
  buttons.

## Routable chips

A choice may carry an optional routable payload: `kind` (`prose | travel |
combat`) and `target` (a connected location id or `engage`).

- The exploration prompt lists only the current location's **connected**
  locations as `id — name` (capped at 8) and the current encounter's hostile
  ids/names, so a chip cannot be created for an unreachable district.
- `normalizeChoice` validates the target against those allow-lists; an unknown
  location is downgraded to `prose`, never a broken chip. A valid travel chip
  round-trips `kind` + `target` and renders
  `data-neoterra-choice-kind`/`data-neoterra-choice-target`.
- **Travel** chips run the same handler as the map: validated travel, one
  arrival frame, the map's close rule (`map.closeOnTravel`), then notice/ambush
  handling and the next chip set. A rejected travel posts nothing and shows a
  status line.
- **Combat** chips (`kind: 'combat'`) require an active encounter; they start
  the same combat flow as the encounter bar's Engage action. With no encounter
  they post a short `notice` frame instead ("No one here to fight") and start
  nothing.
- A routed chip consumes the same exactly-once guard as a prose chip, so a
  double click (or a click while travel/combat is in flight) is a no-op.

Free text still goes through SillyTavern's normal send path.

Choices are suggestions only. They never write state; the chosen text becomes
ordinary player input and the normal trackers process it. A routed travel or
combat chip is the only exception: it invokes the deterministic engine action
the chip names, with a visible frame.

## Data

The settings panel exposes both panels, including the separate combat count,
theme, weights, and prompt override. Defaults live in
`src/core/defaults.js`; the agent prompt lives in `src/agents/prompts.js` and
can be overridden per install.

Tests: `tests/choices.test.js`.
