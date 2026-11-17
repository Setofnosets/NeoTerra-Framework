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

- Generate only when the last message is the assistant's.
- Generate only while generation is idle.
- Never generate on the ending screen.
- Never auto-generate immediately after a clicked choice (prevents a loop).
- Cache per message **and per swipe**.
- Filter through the content gate and per-player/per-character limits.
- A malformed or failed agent response hides the row without an error toast.
- If all choices are filtered out, the row hides instead of rendering empty
  buttons.

Choices are suggestions only. They never write state; the chosen text becomes
ordinary player input and the normal trackers process it.

## Data

The settings panel exposes both panels, including the separate combat count,
theme, weights, and prompt override. Defaults live in
`src/core/defaults.js`; the agent prompt lives in `src/agents/prompts.js` and
can be overridden per install.

Tests: `tests/choices.test.js`.
