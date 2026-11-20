# Manual QA checklist

Run against a live SillyTavern (`http://127.0.0.1:8000/`) with this extension
installed. Use a temporary `NT-Audit` chat or character for destructive checks
and delete it afterwards.

## Fresh install

- [ ] With no Neo Terra world in the chat, open the shell: it shows the season
      grid (not Session Home).
- [ ] Pick a recommended preset, start S1 with a custom persona, and confirm the
      opening frame posts exactly once.
- [ ] Choices appear after the opening; the input focuses; the console has no
      Neo Terra errors.
- [ ] The HUD is hidden until the world exists, then appears as a collapsible
      rail with no Settings/export/agent-config controls.

## Resume and Session Home

- [ ] Reload the page and reopen the shell: Session Home appears, not the season
      grid.
- [ ] Session Home shows season, act, in-game date/time, player, form, location,
      threat, present cast, and a "Previously on" paragraph.
- [ ] Continue closes the shell and focuses the chat input.
- [ ] Map opens in one click; no season is re-selected.
- [ ] Close and reopen the shell: the last surface for that chat is restored.
- [ ] "New timeline" creates a new chat and leaves the existing chat untouched.
      If creation fails, the explicit replace confirmation appears.

## Player and state

- [ ] The Player tab shows live stamina, willpower, corruption, status, skills,
      traits, goals, and relationships.
- [ ] A manual edit survives a reload and one tracker pass does not overwrite it.
- [ ] Switching chats disposes the old sheet and mounts the new world's sheet.

## Map and travel

- [ ] With no world, the Map shows one "Start a season" CTA and no dead end.
- [ ] With a world, selecting a district/bridge/location enables Travel only out
      of combat.
- [ ] Travel posts the arrival frame once and shows the arrival in the sidebar
      and the chat.
- [ ] Test both `map.closeOnTravel: true` and `false`; record which feels better.
- [ ] An encounter bar appears when hostiles are present; Engage starts combat.
- [ ] Fog of war, the threat-stage badge, and district-control overlay toggle.

## Characters, portraits, and guests

- [ ] Portraits load in the season picker, Codex, Player sheet, map cast, and
      scene frames.
- [ ] **Sync portraits** picks up a newly installed ST card.
- [ ] **Download manifest** produces a mergeable file.
- [ ] Ambiguous short names (Claire/Carol/Aurelia) never swap portraits.
- [ ] Play as opens the portrait-first picker; search and filters work.
- [ ] A non-roster guest shows the visible warning; Begin stays disabled until
      the acknowledgment is checked.
- [ ] A guest world shows the guest badge and the prompt contains the guest
      block; dependent beats adapt rather than fail.
- [ ] Guests disabled returns the old rejection path.

## Forms and generations

- [ ] Transform Vaiva to Light Shade: prompt and Codex appearance/abilities
      change; the avatar follows the active form.
- [ ] Reverting restores the base profile; manual edits survive.
- [ ] A form without a card profile keeps the base fields and shows a note.
- [ ] A guest transform with no card generates a profile with a visible
      **Generated form** badge; edit/regenerate/approve work.
- [ ] **Export generated forms** produces a valid JSON bundle with `generated`
      flags intact.
- [ ] A forced agent failure leaves the base profile and a note; play continues.

## UI, windows, and mobile

- [ ] Map, Codex, Relations, Journal, and the agent log open as floating windows
      over the chat; dragging/resizing works and geometry persists.
- [ ] Escape closes the topmost window; the chat remains scrollable and the
      input usable.
- [ ] Settings, export/import, and agent configuration remain in the Extensions
      drawer, not in windows or the HUD.
- [ ] Desktop: verify 1440×900 and 1024×768.
- [ ] Mobile 390×844: HUD, picker, map, and scene cards have no horizontal
      overflow and usable touch targets (≥ 40 px).
- [ ] Mobile: floating windows become full-screen sheets; safe areas are not
      clipped.
- [ ] Light and dark themes are both readable.

## Chat, scenes, progress, and errors

- [ ] Opening/travel/encounter frames show a header and portrait strip after
      reload.
- [ ] Cinematic mode groups scene frames; user and non-Neo-Terra messages are
      unaffected; message text is unchanged (`mes` before/after).
- [ ] The "Director is updating" chip shows clock/tick/pacing/tracker/storyline/
      lore/auditor/cast/choices stages.
- [ ] State deltas (meters, corruption, rumors, cast, form, newspaper) toast once
      per turn.
- [ ] An agent failure shows a non-blocking toast; **details** opens the agent
      log window.

## Agents

- [ ] Cast Director runs on travel/arrival and on its scene cadence; arrivals/
      departures toast.
- [ ] Lore runs every 10 turns or on an act change and writes the Journal recap.
- [ ] Auditor runs at act boundaries and shows a non-blocking continuity toast.
- [ ] Bad End UI appears only when `badEnds.enabled`; disabling stops calls.
- [ ] Architect's season-start pass runs only with `agents.architect.seasonStart`.
- [ ] Disable each agent in turn and confirm zero calls (agent log empty for it).

## Player POV, choices, travel, and agents (1.3.0)

One line per reported symptom; use the exact click path.

- [ ] **Played character off the map:** start S2 as Leila → Map shows
      "You are here" at her location and no `Present: Leila` strip; Story tab
      cast omits her; Characters tab still lists her with every form/goal/card
      action.
- [ ] **Play-as relocation:** mid-story, Codex → Play as a character elsewhere →
      scene moves, previous player reappears as an NPC where they stood, map
      refreshes without a reload.
- [ ] **S2 Leila form:** fresh S2 → Codex shows Leila as Femme Feral (villain,
      villain portrait); form swap to the fallen card and back still works.
- [ ] **Goals:** Play as a character with a goal label → goals appear in the
      kickoff and Codex; with none → deterministic parse or one inference call
      fills 3–5 grounded goals; `agents.goalInference.enabled:false` falls back
      to the agenda line with no error.
- [ ] **Player card:** Play as Leila → toast + instruction; download
      `Leila Renya.json`, import it, select it; the narrator addresses the player
      by name and `[NEOTERRA_PLAYER]` shows the card line.
- [ ] **Travel chip:** CYOA on → click a travel chip → map closes (default),
      `Location changed:` frame, arrival cues, chips return; no chip exists for
      a non-connected location.
- [ ] **Combat chip:** with an encounter, click an engage chip → combat frame +
      tactical chips + travel blocked; no encounter → short notice frame, nothing
      starts.
- [ ] **Notice-first:** travel into a hostile location and reload the same
      chat/turn → the same "spots you" outcome; `travel.noticeFirst:false` → no
      notice frame.
- [ ] **Ambush:** travel into a `hostile`/`contested` location until the
      deterministic roll is a strong hostile success → "springs the ambush"
      frame, combat starts, bar shows **Surprised** and only defensive/escape
      chips; next round restores full combat chips; `travel.ambush:false` demotes
      the same roll to a plain notice.
- [ ] **Travel description:** `agents.sceneDescriber` on → a short second frame
      within ~12 s; off → deterministic frame only; a bad model config → no
      second frame and no error toast.

## Agent control (1.3.0)

- [ ] **Presets:** save a preset, change three agents, apply the preset → all
      three revert; reload → the preset list persists; export/import settings →
      presets survive; the dropdown lists the Recommended group.
- [ ] **Pickers:** profile dropdown lists real profiles; selecting one changes
      routing (check the agent log); cadence select only offers valid values; a
      stored custom profile id stays selected under **Custom id…**.
- [ ] **Test connection:** Test on a good profile → OK + route/model/latency;
      a bogus profile id → readable failure; **Test all agents** → N/N summary;
      closing the drawer or switching chat aborts the run.

## Content pilot

- [ ] Review and approve the S1/S1Dark side beats, post-victory arcs, and
      deterministic epilogue text (done before merge).
- [ ] Reach a villain victory: the campaign epilogue is season-specific and
      stored once.
- [ ] `ending.dynamic` is off by default; enabling it produces one agent-written
      epilogue and marks `reviewRequired`.
- [ ] Rest/Train/Patrol/Investigate/Socialize/Work advance one clock slot, apply
      the expected bounded change, and add one Journal entry.
- [ ] Downtime works with every agent disabled.

## Content gate, export/import, and fallbacks

- [ ] With `strict`, profiles, forms, and prompt text are filtered; hard limits
      always win.
- [ ] Export a world and import it into a new chat: state, cast, forms, guest
      flags, bad ends, and generated forms survive.
- [ ] Fallbacks: Director card missing, profile missing, avatar missing, form
      group missing, no world, malformed PNG, new-chat creation failure. Each
      shows a clear message and never blocks play.

## Cleanup

- [ ] Delete temporary `NT-Audit` chats/characters.
- [ ] Confirm no test artifacts remain in the user's library.

## Sign-off

- **2026-11-19 — automated:** `npm run check` passes (tests, build-data/map/coords checks, smoke test).
- **2026-11-19 — desktop live (`127.0.0.1:8000`):** extension reports `1.2.0`; season grid renders with "Director card — installed"; the no-world map shows the single Start a season CTA; `/neoterra log` opens the agent-log window; no Neo Terra console errors.
- **2026-11-19 — mobile 390×844:** a live 390×844 iframe harness against the running app measured zero horizontal overflow for the shell, season grid, toolbar, cards, and map sheet; the command palette items render at 40 px minimum height with no undersized visible controls.
- **2026-11-19 — mobile CSS:** the 720 px HUD sheet, window sheet, scene-card, and palette touch-target rules are asserted in `tests/ui-css.test.js`.
- **Signed off for 1.2.0.**
- **2026-11-19 — automated (1.3.0):** `npm run check` passes (1153+ tests,
  build-data/map/coords/avatars checks, smoke test). Manual checks 1–14 above
  remain the release gate for 1.3.0.

