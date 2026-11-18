# Neo Terra Experience Audit & Overhaul

## Meta
- Slug: `neoterra-experience-audit`
- Status: draft — decisions incorporated; pending spike sign-offs
- Date: 2026-11-18
- Audit basis: full static read of `src/`, `data/`, `docs/`, and `tools/`; live inspection of SillyTavern at `http://127.0.0.1:8000/` against the installed extension (664 installed character cards, one existing S1 Director chat); DOM/computed-style inspection of the shell, Season tab, identity step, Map, and Codex.
- Not verified in this session: `npm run check` and the full Node test suite were not executed. Treat test health as unverified until the first implementation step runs them.

## Decisions (approved 2026-11-18)
1. **Scope:** build the full plan, all milestones.
2. **UI:** persistent HUD + floating windows. The HUD is a **collapsible overlay rail** (final). Settings, export/import, agent configuration, and other non-gameplay surfaces stay in menus, not the HUD.
3. **Avatars:** both a committed generated manifest and runtime resolution from installed ST cards. Add a **Sync portraits** action for installed-card changes.
4. **Guests:** allow cross-season characters in every season; adapt canon beats; require an explicit, displayed warning and acknowledgment before starting.
5. **Dynamic forms:** auto-generate on transform using season threats/factions, other character cards, the same form group, and recent scene. Store per chat with an **Export generated forms** button.
6. **Character creator:** investigate reliability before committing to production (Spike A). Portraits are **user-supplied**; no AI image generation. **If Spike A is red, stop at missing-form generation — do not build the Card Architect.** Only a green spike proceeds to the human-approved Card Architect; an amber result requires an explicit override before any production work.
7. **New timeline:** create a new chat automatically, using the Director card when available, otherwise the current card or an empty chat; fall back to explicit replace only if chat creation fails.
8. **Travel close behavior:** investigate with Spike B because the current close-on-travel exists to compensate for weak map-change feedback. UI changes may change the right default.
9. **Endings/content pilot:** add an S1/S1Dark post-victory pilot now; **the user reviews and approves the pilot beats/epilogues before merge**. Keep dynamic ending generation behind a review flag, or defer it to a separate reviewed step.
10. **Platform:** desktop-first, but mobile is required and must be verified. Mobile order: HUD, picker, and map sheets first; Journal after.
11. **QA window:** implementation may create and delete temporary chats/characters in the running ST for live testing; clean up afterward.

## Summary
- **Goal:** establish how far the current implementation is from the intended Neo Terra experience, then turn the gaps into a prioritized, reviewable implementation roadmap.
- **Context:** the extension has strong foundations — deterministic `WorldState`, a working seeded season, a functioning map/travel graph, rich card-derived profiles, a full agent suite, and a deep Codex. The experience around those foundations is the problem: the shell is a single modal with no session awareness, the first screens are unstyled, the Player tab is dead, characters have no faces, transforms do not change profiles, and several advertised agents never run.
- **Deliverable:** this audit + proposal set, now with the approved decisions folded in. The full roadmap is approved: steps 1–6 fix the flow and visible state; steps 7–13 cover the character experience; spikes A–B de-risk the character creator and travel feedback; steps 14–19 replace the modal with an invasive HUD/window system; steps 20–22 wire the living-world agents and expand content.

## Audit Method
- Read the entry point, all UI modules, all flows, the reducer/state layer, the agent runner/prompts, the build tools, the season/card/form data, and the docs.
- Live checks: opened the shell from the top-bar globe, inspected the Season list, entered the identity step, triggered the replace confirmation, opened the Map with and without a world, opened the Codex, switched to the Director chat with an existing S1 world, and measured computed styles and panel geometry.
- Registry-to-installed-card matching: fetched `data/characters/index.json` in the live page and compared `dataName`/aliases to `ctx.characters`.
- **Limits:** no screenshots (desktop review pane was not visible), no `npm run check`, and no destructive live test (no season was replaced, no chat was deleted).

## Intended Experience vs Actual

| Dimension | Intended (start.md / README) | Actual today | Grade |
| --- | --- | --- | --- |
| Entry | Season menu; pick a season or character; world is built around it | Season grid works, but it always opens first, has no resume state, and the first screen has no styling | 2/5 |
| Continuity | One chat = one timeline; reopen and continue | World state persists, but there is no Continue card; the current season still says "Enter season" and leads to a destructive replace prompt | 2/5 |
| Map | Top-right button; zoom/pan; nodes; travel; status overlay | Map is a tab inside a modal; works with a world, but is 862×442 inside a 920×602 shell, and offers no CTA when no world exists | 4/5 function, 2/5 presentation |
| Characters | Relevant cast, current info, manual additions, alternate forms | Codex is deep and functional, but has no portraits, cross-season guests are rejected outside Sandbox, and the picker is a radio list | 2/5 |
| Forms | Alternate forms swap naturally, profiles/abilities change | Forms are separate registry entries; transform changes id/name/side only, so appearance/abilities stay the base card | 2/5 |
| Trackers | Player and world state visible during play | State Tracker runs every turn, but the Player tab is a placeholder and no tracker is visible in chat | 1/5 |
| Agents | Architect, Storyline, State, Cast, Lore, Auditor, Epilogue, Choices, Bad End | State/Storyline/Choices/Epilogue are wired; Cast Director is forced `runDirector:false`, Lore/Auditor/Bad End/Architect are never instantiated, agent log is never mounted | 2/5 |
| Chat surface | The chat is the primary surface; scenes, arrivals, encounters | Scene frames are plain long messages with a generic avatar; no scene card, no status header, no turn feedback | 2/5 |
| UI | Sleek, futuristic, custom | Dark modal with strong map chrome, but Season/Identity/Agent log have zero CSS; no floating windows; no light theme | 2/5 |
| Content | Six seasons, beats, factions, civilian lives, newspaper | S1–S4 are solid (6 beats each, named threats, rich profiles); post-victory arcs are near-copies; S5 is a stub; NeoHorizon cards are invisible; no downtime/civilian loop | 3/5 |
| Extensibility | Data-driven seasons/cards/forms | Build pipeline is strong; adding PNG cards, avatars, or cross-season forms is not supported | 4/5 process, 2/5 content reach |

### Feature Status
| Feature | Status | Gap |
| --- | --- | --- |
| Season start | Working | Unstyled; no resume; Director status wrong; replace-only path |
| Map + travel | Working | Modal tab; small canvas; no empty-state CTA; text-dense sidebar |
| Codex | Working | No portraits; roster-only Play as; no cross-season picker |
| Alternate forms | Data + reducer exist | Transform does not change profile; data gaps; no generated forms |
| Player tracker | Built, not mounted | Player tab is a placeholder; no in-chat HUD |
| Relations | Working | Read-only; hidden in the modal |
| Domain sensorium | Working (S1Dark only) | Hidden tab; no visibility outside the shell |
| Newspaper | Working, off by default | Reader buried in the map overlay |
| Fog of war | Working, off by default | Two sources of truth (localStorage + setting); travel gate UI |
| World tick | Working | Only visible as a map sidebar feed |
| Pacing | Working | Cut control lives only in the map panel |
| CYOA | Working, off by default | No first-run explanation; chips only in chat |
| Combat resolver | Working | Encounter bar is minimal; no tactical feedback |
| Endings | Working | Panel is separate from the HUD |
| Bad ends | Library + UI exist | Flow/UI never mounted |
| Agent log | Library exists | Never mounted |
| Portraits / avatars | Not implemented | No manifest, no runtime resolver, no PNG ingestion |
| Character creator | Not implemented | Needs a reliability spike before production |
| Settings | Extensive | 18 groups, no presets, no diagnostics, no first-run wizard |
| Export/import | Working | No UI for generated forms/cards yet |

## Current State (from exploration)
The shell is a fixed full-viewport overlay (`style.css:82-135`) with seven tabs (`src/core/constants.js:57-65`). `activeTab` is module state initialized to `'season'` (`src/ui/shell.js:129`), so a page reload always lands on the Season grid even when the chat already has a world. `LIVE_PANELS` excludes `player` (`src/ui/shell.js:121`), while the complete player sheet (`src/ui/player-panel.js:480`) is imported by nobody. The Season setup strip checks `setup.directorInstalled` (`src/ui/season-menu.js:207-217`) but `directorCardStatus` returns `{ installed }` (`src/ui/director-card.js:28-35`), so the installed Director card is reported missing. Season cards and identity radios have no CSS selectors at all (grep of `style.css`), and the identity options render as an inline fieldset. The map runtime works from `chatMetadata.neoterra.worldState`; with no world it paints an empty overlay and disabled travel. The Codex renders rich profile text but no images (`src/ui/codex.js:1082-1140`). Transform (`src/state/reducer.js:235-272`) changes `formId`, name, side, and threat only. The turn pipeline runs clock → world tick → pacing → State Tracker → Storyline → cast refresh with `runDirector:false` (`src/agents/state-tracker.js:917-930`), then requests CYOA; errors are collected but never surfaced (`src/ui/shell.js:1537-1588`).

## Key Files
- `src/ui/shell.js` — mount, tab switching, runtimes, season handoff, turn handler.
- `src/ui/season-menu.js` — season list, identity wizard, replace confirmation.
- `src/ui/codex.js` / `codex-data.js` — cast, profiles, form lineage, Play as.
- `src/ui/player-panel.js` — complete player sheet, currently unmounted.
- `src/ui/map-panel.js` / `overlay.js` / `map.js` — map window, sidebar, travel.
- `src/ui/chat-output.js` — scene frames and dedupe.
- `src/state/reducer.js` / `world-state.js` — typed events, seeding, transforms.
- `src/data/forms.js`, `data/form-groups.json`, `data/form-rules.json` — form model.
- `tools/build-data.mjs` — card ingestion, profiles, groups, registry.
- `src/agents/state-tracker.js` — turn pipeline.
- `src/agents/*` — agent implementations, several not wired.
- `style.css` — all styling; `src/ui/theme.css` only declares tokens.

## Audit Findings

### P0 — Broken or actively misleading

1. **The Director card is reported missing while installed.**
   - Evidence: live setup strip says "Director card — not installed" in the Director chat; `findStCharacter` resolves the card correctly when called directly.
   - Cause: `renderSetupStrip` reads `setup.directorInstalled`; `directorCardStatus` returns `installed`.
   - Files: `src/ui/season-menu.js:207-217,358-365`, `src/ui/director-card.js:28-35`.
   - Impact: users are told to download/import a card they already have; the primary setup CTA is wrong.

2. **The Player tab is a dead placeholder.**
   - Evidence: live Player tab shows "The player sheet, identity, and current form will appear here."; `mountPlayerPanel` is never called.
   - Files: `src/ui/shell.js:110-121`, `src/ui/player-panel.js:480`.
   - Impact: the only complete player-facing tracker is unreachable; stamina/willpower/corruption are invisible during play.

3. **No session-aware home; the shell always opens on Season.**
   - Evidence: after reload, `activeTab` is `'season'`; an existing S1 world still shows "Enter season"; clicking it leads to "Replace this chat's world?"; "Keep current world" returns to the identity step, not the list.
   - Files: `src/ui/shell.js:129,1744-1757`, `src/ui/season-menu.js:152-167,518-526`.
   - Impact: reads as being forced to re-select the season before reaching the map; the only visible action is destructive.

4. **Season and identity screens are unstyled.**
   - Evidence: live computed styles show `fieldset` default groove border and inline radio labels; `style.css` has no `.neoterra-season-*`, `.neoterra-identity-*`, `.neoterra-back`, or `.neoterra-agent-log` rules.
   - Files: `src/ui/season-menu.js:96-150,244-300`, `style.css`, `tests/ui-css.test.js`.
   - Impact: the first screen a new user sees looks unfinished; the "sleek futuristic" goal is not met.

5. **A transform does not change the character's profile.**
   - Evidence: `TRANSFORM` sets `formId/formGroup/displayName/side/threatLevel`; it never updates appearance, outfit, abilities, traits, likes, dislikes, or notes. `seedCharacter` copies the starting form's card fields once.
   - Files: `src/state/reducer.js:235-272`, `src/state/world-state.js:166-212`, `src/ui/codex.js:661`.
   - Impact: a corrupted/cleansed character still looks and acts like the base card in prompt and Codex; alternate-form cards exist but their text is unused.

6. **Cross-season characters are impossible outside Sandbox.**
   - Evidence: `resolveIdentitySelection` rejects a non-roster id unless `allowAnyCharacter`; only Sandbox sets it. Codex Play as also checks the current roster.
   - Files: `src/flows/season-start.js:415-479`, `src/ui/codex.js:984-1018`, `data/seasons/sandbox.json:15-16`.
   - Impact: the requested "use a character from another season with a warning" path does not exist.

7. **No character imagery anywhere.**
   - Evidence: `data/characters/index.json` entries have no avatar field; `codex.js` renders text rows only; `player-panel.js` draws initials; scene frames use one generic `assets/neoterra-avatar.svg`.
   - Live check: 74 of 78 registry display names match an installed ST card name, but repeated short names (five "Claire", five "Carol") make naive matching unsafe.
   - Files: `data/characters/index.json`, `src/ui/codex.js:1082-1098`, `src/ui/player-panel.js:278-280`, `src/ui/chat-output.js:33,96`.
   - Impact: character selection is slow and impersonal; the PNG cards the user already has are unused.

8. **Several advertised agents never run.**
   - Cast Director: `runDirector:false` on every turn (`src/agents/state-tracker.js:917-930`).
   - Lore: `createLoreAgent`/`runLorePass` never instantiated (`src/agents/lore.js:655,864`).
   - Auditor: `createAuditor`/`initiative.runAudit` never called (`src/agents/auditor.js:315`, `src/flows/initiative.js:316`).
   - Bad End UI: `mountBadEndPanel` never called (`src/ui/bad-end.js:188`).
   - Architect: `createArchitect` never called.
   - Agent log: `mountAgentLog` never called; `agent-log.js` is never mounted.
   - Impact: settings toggles for these agents are dead; README claims they run.

9. **The turn pipeline has no user-visible progress or failure surface.**
   - Evidence: `runTurnPipeline` collects `errors[]` but returns `ok:true`; the shell ignores it; every agent stage is awaited before choices.
   - Files: `src/agents/state-tracker.js:717-960`, `src/ui/shell.js:1537-1588`.
   - Impact: a slow/failed agent looks like a frozen UI; the user cannot tell whether the world updated.

10. **Documentation drift.**
    - README claims Cast Director/Lore/Bad End run per turn; docs/scene-output omits the world tick and pacing stages; README still says `EXTENSION_VERSION` is `0.1.0` (it is `1.1.0`).
    - Impact: operators cannot tell what is actually active.

### P1 — UX and presentation

11. **One modal contains everything.**
    - A 960px centered shell holds season, map, codex, relations, domain, and settings; the map is a draggable window inside that modal. The chat is blocked while inspecting state. There is no docked HUD, no floating codex/map, and no mini-map.

12. **The character picker is a radio list.**
    - Identity options show name + side only; no portrait, no search, no season/role filters, no form lineage. The season list's "Character-first" field expects a raw character id (`placeholder="Filter seasons by character id"`).

13. **The map sidebar is text-dense and not status-first.**
    - Threats, factions, rumors, headlines, activity, and selection all stack in one narrow column; no district control overlay, no portrait row for present cast, no threat clock visual.

14. **In-chat frames are plain messages.**
    - Opening/travel/encounter frames are long markdown blocks; no structured header, portrait strip, location/time badges, or collapsible details. The opening frame repeats the premise and the kickoff.

15. **No journal or recap.**
    - The Lore agent's summaries are not surfaced; there is no "previously on" after a break, no event timeline, no discovered-lore view.

16. **Settings are an 18-group wall.**
    - No presets, no first-run wizard, no "what runs when" explanation, no diagnostics for missing cards/agents/worlds.

17. **Responsive/theme gaps.**
    - Fixed pixel shell/map geometry, hardcoded dark tokens, no light-theme adaptation, minimal mobile behavior.

### P2 — Content and long-tail

18. **Form data is incomplete and inconsistent.**
    - 30 groups / 43 rules; missing groups for several base cards; cross-season groups are forbidden; S4 Claire/Anastasia chains disagree on the base; `altFormsAllowed` is validated but never enforced; `Blazing Prism` cannot join `Light Shade`.

19. **Content is strong but thin after the core arc.**
    - S1–S4 each have 6 canon beats and named threats; post-victory arcs reuse the same four beats; no downtime/civilian-life loop; S5 is a stub; `Others/NeoHorizon` cards are silently excluded.

## Proposals

### A. Session flow: make the chat the home, not the modal
1. **Session Home** replaces the Season grid whenever a world exists. It shows season/act/time/location/player/threat/present cast, a one-paragraph "previously on", and four primary actions: Continue, Map, Cast, Journal. A secondary "New timeline" action opens the season grid and explains the replace/create choice.
2. **Last-surface memory.** Store the last tab per chat (`chatMetadata.neoterra.ui.lastTab`) and restore it on open; default to Session Home, not Season.
3. **Direct map.** A HUD Map button and `/neoterra map` open the map without touching the Season flow. With no world, the map shows a single "Start a season" CTA that switches to the Story wizard. The sidebar becomes status-first: threat clock, district-control overlay colored by faction influence, and a portrait row for present cast.
4. **Travel loop.** Add both close-on-travel and keep-open modes, show the arrival in the map sidebar and the chat, and add a prominent "Return to chat" button. Spike B measures which default works after the HUD/scene-card changes; the current close-on-travel default stays until that evidence is reviewed.
5. **New timeline, not replace-by-default.** "New timeline" creates a new chat automatically with the Director card when available, otherwise the current card or an empty chat. "Replace this chat's world" remains an advanced, explicit fallback only when chat creation fails.

### B. Character experience: faces, filters, and guests
6. **Avatar manifest + resolver + sync.** Generate `data/characters/avatars.json` from PNG cards (embedded `chara` data or filename/alias matching). At runtime, prefer the manifest, then the user's installed ST character avatar by exact/alias match, then initials. Add a **Sync portraits** action in Settings that re-scans `ctx.characters`, writes a per-user override map to extension settings/localStorage, and refreshes the UI; it never writes the repository. Offer **Download manifest** for merging into `data/characters/avatars.json`. Use avatars in the season picker, Codex list/detail, Player sheet, map present-cast, scene cards, and relationship nodes.
7. **PNG card ingestion (optional).** Teach `build-data` to read `.png` cards, extract the embedded card JSON, pair a JSON twin with the PNG art, and emit `avatarPath`. This makes the PNGs the single source of character art without requiring a separate manifest.
8. **Portrait-first Character Picker.** A reusable grid with search, season filter, side/form filters, keyboard navigation, and a "Canon roster" / "Other seasons" split. It replaces the identity radio list and the Codex Play-as dialog. The season list's raw-ID "Character-first" filter is replaced by this picker.
9. **Guest Character Contract.** Allow any registry character in any playable season. The warning is mandatory and visible: home season, era mismatch, canon-beat adaptation, and a "non-canon guest" badge; the user must check an explicit acknowledgment before starting. Record the accepted warning in `flags.guestCharacter`; render a prompt block; let the Storyline tracker mark dependent beats `adapted` rather than failing the world. Sandbox behavior is unchanged.
10. **Form lineage in the picker.** Show base and alternate forms as one card with a form selector, so the user chooses "Vaiva" once and then picks the active form, instead of scrolling separate registry rows.
11. **Card Architect (investigate first).** A variant of the Form Architect can generate a complete non-canon character card from a short concept, copying the section style of the existing cards. Because reliability is the hard part, this starts with Spike A (schema, grounding, eval rubric, samples) before production code. Only if the spike is green, implement it as a separate reviewed step with draft → critique → schema validation → Auditor consistency check → human approval; store generated cards in chat metadata, mark them `generated`, use a user-supplied portrait, and offer export to JSON. If the spike is red, stop at missing-form generation; if amber, require an explicit override before production work.

### C. Forms 2.0: profiles that actually change
12. **Form profile overlay.** At season seed, store each cast member's group profiles in `character.formProfiles`. On `TRANSFORM`, apply the target form's appearance/attire/abilities/traits/likes/dislikes/notes, preserve live combat/status/relationship/manual edits, and track `profileFormId`/`profileSource`. Reverting restores the base overlay. Codex card text and avatar follow the active form.
13. **Form Architect agent.** When a transform targets a form with no card (or a guest character reaches a form that does not exist), a new `formArchitect` agent auto-generates a validated form profile from the base card, the form rule, the season's threats/factions, other cast cards, the same form group, and the recent scene. Store it under `flags.generatedForms`, render it with a visible "Generated form" badge, and offer Edit / Regenerate / Approve plus an **Export generated forms** button. On failure, keep the base profile and add a transformation note rather than blocking play.
14. **Form data completion.** Fill missing groups/rules, allow cross-season groups, normalize S4 chains, enforce `altFormsAllowed`, and add a build check that fails on ungrouped alt cards or unreachable rules.

### D. UI system: invasive, but coherent
15. **Persistent HUD (gameplay only).** A collapsible right rail shows season/time/act, location, player meters, current threat, present-cast avatars, and gameplay actions (Map, Cast, Player, Journal, Newspaper). Settings, export/import, agent configuration, and diagnostics stay in the Extensions drawer/menus, not the HUD. It is visible only when a world exists and updates on `MAP_UPDATED`/turn completion.
16. **Floating window manager (gameplay surfaces).** Move Map, Codex, Relations, and Journal out of the modal into draggable/resizable windows over the chat. Persist geometry, stack/focus windows, add minimize/close, and use full-screen sheets on mobile. The shell becomes a small launcher/Session Home; configuration surfaces stay in menus.
17. **Scene cards.** Add structured metadata to scene frames (`location`, `time`, `pov`, `present`) and decorate the rendered message with a header, portrait strip, and badges. Do not rewrite message text; decorate the DOM after render and on chat reload.
18. **Turn progress + toasts.** Emit stage events from the turn pipeline and show a compact "Director is updating" chip with stage labels. Batch state deltas into toasts (stamina, corruption, new rumor, cast arrival, form change, newspaper) and surface agent errors with a "details" link.
19. **Journal/Recap.** A Journal window with "Previously on", a chronological event timeline, beats, travel, encounters, relationship changes, and discovered locations. The Lore agent writes the recap; a deterministic fallback always works.
20. **First-run wizard + command palette.** A three-step wizard (season → character → confirm) with visual cards and recommended presets. `/neoterra` opens a gameplay command palette (Travel, Cast, Player, Journal, Rest, Patrol, Newspaper, New timeline) for keyboard-first play. Settings/export/import remain in menus.

### E. Living world: wire what is already built
21. **Cast Director** on travel/arrival and on a configurable scene cadence, with arrival/departure toasts. **Lore** every 10 turns or on act change, feeding the Journal. **Auditor** at act boundaries, showing a non-blocking continuity badge. **Bad End** flow mounted when enabled. **Agent log** in a debug drawer with latency/tokens/errors. **Architect** optional at season start.
22. **Content depth pilot + ending pilot.** Add 2 side beats per season, 3 downtime events, and 1 civilian-life event per act; differentiate S1/S1Dark post-victory arcs first; add a content validator. Add an S1/S1Dark **ending pilot**: deterministic post-victory beats and a season-specific epilogue template. Keep dynamic Epilogue-agent generation behind an `ending.dynamic` review flag, or defer it to a separately reviewed step. Defer S5/NeoHorizon.

## Constraints & Requirements
- **Tech stack:** vanilla ES modules, no runtime npm dependencies, no build step; Node 20 only for tools/tests. Keep the extension loadable by copying the folder.
- **State contract:** `WorldState` remains the only authority. World state stays in the prompt copy through `neoTerraGenerateInterceptor`; never write state blocks into `ctx.chat`. Scene frames are the only Neo Terra messages.
- **SillyTavern compatibility:** minimum 1.19.0. Use the public `SillyTavern.getContext()` surface (`chat`, `chatMetadata`, `addOneMessage`, `saveChat`, `eventSource`, `characters`, `executeSlashCommandsWithOptions`) and the existing extension hooks. Do not rely on ST internals that are not present in 1.19.0.
- **No card hot-swapping:** switching the selected character clears/reloads the chat and would discard `chat_metadata`. "Play as" changes state, not the selected card. This remains true.
- **Data:** generated form profiles live in chat metadata, not in `data/`. Authored data changes go through `npm run build:data` and `--check`. No hand-edited generated files.
- **Assets:** ship both a generated `data/characters/avatars.json` manifest and runtime resolution from installed ST cards; add a **Sync portraits** action with a per-user override map and a **Download manifest** merge path. The browser never writes the repository. Committing large PNGs is optional; PNG card ingestion is opt-in.
- **UI boundary:** the HUD and floating windows are gameplay surfaces. Settings, export/import, agent prompts/configuration, diagnostics, and other non-gameplay controls stay in the Extensions drawer/menus.
- **Platform:** desktop-first, but mobile is required. Mobile order: HUD, picker, and map sheets first; Journal after. HUD, picker, map, and scene cards must work at 390×844 with full-screen sheets and usable touch targets.
- **Content gate:** every generated/rendered profile and form overlay passes `contentGate`/`contentLimits` at render time; hard limits always win.
- **Out of scope for this plan:** a full S5 season, a full NeoHorizon season, AI image generation, multi-user sync, a tactical grid/HP combat rewrite, and changing ST's own character card storage.

## Assumptions & Open Questions

### Assumptions
1. The existing S1 Director chat may be inspected; no season was replaced and no chat was deleted.
2. The "season re-selection" complaint is the shell landing on Season with no Continue path, not a literal second season selection inside the Map. The Map itself already reads the active world correctly.
3. The PNG folder at `KI\chars\neo` is reference material. The implementation ships a generated manifest, copies selected PNGs into `assets/avatars/` (committing them is optional if runtime-only is preferred), resolves installed ST cards at runtime, and adds a **Sync portraits** action.
4. A cross-season guest keeps the season's world and beats, but dependent beats adapt rather than disable the season. Sandbox remains fully free.
5. Generated form text is stored per chat, with an export button, and is never written into `data/` by the browser.
6. HUD and floating windows are for gameplay surfaces only; the HUD is a collapsible overlay rail. Settings, export/import, agent configuration, diagnostics, and prompts stay in menus.
7. A new timeline creates a new chat automatically, with the Director card when available; replace-in-place is a fallback.
8. The existing deterministic combat resolver and bad-end predicates are out of scope except for surfacing them.
9. Desktop is the primary target; mobile is required before release. Mobile order: HUD, picker, map sheets first; Journal after.
10. Dynamic ending generation is kept behind a review flag; the deterministic S1/S1Dark pilot lands first, and the user reviews the pilot beats/epilogues before merge.
11. Implementation may create/delete temporary chats and characters in the running ST for QA, then clean them up.
12. Character creator portraits are user-supplied. If Spike A is red, the Card Architect is not built; missing-form generation remains the fallback. Only a green spike proceeds to the human-approved Card Architect; an amber result needs an explicit override.
13. Character creation and generated-form text never write the repository.

### Implementation checks (no design approval needed)
1. **Spike A acceptance bar:** The spike proposes the explicit bar (0 schema failures, 0 canon contradictions, ≥4/5 human quality on held-out concepts). A red result stops at missing-form generation; only a green result proceeds to the human-approved Card Architect. An amber result requires an explicit override.
2. **Spike B measurement:** After the HUD/scene-card changes, measure close-on-travel vs keep-open vs keep-open-with-toast. The default changes only after the user reviews the report.
3. **Ending dynamic path:** The deterministic S1/S1Dark pilot is reviewed by the user. The dynamic Epilogue path is a separate reviewed toggle and ships off by default.
4. **New-chat API:** Verify the exact ST 1.19.0 path for creating a new chat with the Director card selected, and the fallback when the card is missing.
5. **Avatar sync semantics:** Per-user override map + explicit **Download manifest** merge; never write the repo from the browser.
6. **User-supplied art:** Generated cards accept a user-uploaded image (type/size validation, no server write). Without one, use a neutral placeholder, never a randomly borrowed portrait.
7. **QA cleanup:** Temporary chats/characters are allowed; use a dedicated `NT-Audit` name and delete them after each run.

## Step-by-Step Implementation Plan

### Milestone 1 — Coherent flow

#### 1. Publish the audit and correct the docs
- **Files:** `docs/experience-audit.md` (new), `README.md`, `docs/scene-output.md`, `docs/adding-a-season.md`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** The audit report records the findings, the intended-vs-actual matrix, the proposal set, and the priority order. README links to it and stops claiming unwired agents run. `docs/scene-output.md` gains the world-tick/pacing stages and the current `runDirector:false` cast behavior. `docs/adding-a-season.md` notes that PNG cards are not ingested yet.
- **Acceptance criteria:**
  - The report contains every P0/P1 finding with a file:line anchor and live evidence where applicable.
  - README's feature list distinguishes "wired" from "library only" agents.
  - `npm run check` passes; no source behavior changes.
- **Risk:** low
- **Model / Effort:** fast implementer #low
- **Commit:** `docs(audit): record the Neo Terra experience audit and proposal set`

#### 2. Fix the Director card status and setup strip
- **Files:** `src/ui/season-menu.js`, `src/ui/director-card.js`, `tests/season-start.test.js` or `tests/director-card.test.js`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** `directorCardStatus` keeps returning `{ installed }`; the setup strip maps it to `directorInstalled` (or reads `setup.installed`). `paint()` re-reads the live context so a chat switch updates the host and narrator status. The download button/instructions appear only when the card is genuinely absent. The Settings drawer status uses the same helper.
- **Acceptance criteria:**
  - Unit test: `renderSetupStrip({ directorInstalled:true })` hides the download CTA; `{ directorInstalled:false }` shows it.
  - Unit test: `directorCardStatus` resolves an exact installed name and returns `installed:false` for a missing name.
  - Manual: with the Director card installed, the setup strip says "Director card — installed" and no download button appears; after switching to a chat whose card list has no Director, it says missing.
- **Risk:** low
- **Model / Effort:** fast implementer #low
- **Commit:** `fix(season): report the installed Director card correctly`

#### 3. Mount the Player tab
- **Files:** `src/ui/shell.js`, `src/ui/player-panel.js`, `style.css`, `tests/player-panel.test.js`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** Add `player` to `LIVE_PANELS` and a `[data-neoterra-player-host]` container. On tab activation, mount `mountPlayerPanel` with the shared per-chat `WorldState` store, the current season, and the registry. Refresh on `MAP_UPDATED` and on turn completion; dispose on `CHAT_CHANGED`. The sheet shows identity, form, stamina/willpower, corruption, status, skills, traits, goals, relationships, and manual edits.
- **Acceptance criteria:**
  - The Player tab is no longer a placeholder and shows live values for the inspected S1 chat.
  - A manual edit persists across a reload and the next tracker pass does not overwrite it.
  - Switching chats disposes the old panel and mounts the new world's sheet.
  - Unit tests cover `buildPlayerSheet` for a custom persona and a canon identity.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(player): mount the live player sheet in the Player tab`

#### 4. Add Session Home and per-chat last-tab memory
- **Files:** `src/ui/session-home.js` (new), `src/flows/new-chat.js` (new), `src/ui/shell.js`, `src/ui/season-menu.js`, `src/core/constants.js` (tab metadata if needed), `tests/session-home.test.js`
- **Depends on:** 3 (the home links to the Player tab)
- **Parallelizable:** no
- **Expected behavior:** Keep the tab id `season` for compatibility but relabel it **Story** in `SHELL_TABS`. When `chatMetadata.neoterra.worldState` exists, the Story tab renders Session Home instead of the season grid. It shows the season title, act, in-game date/time, player identity/form, current location, current threat/stage, present cast, and a "Previously on" paragraph (deterministic fallback). Primary actions: Continue (close shell + focus input), Map, Cast, Player, Journal (placeholder until step 18). Secondary: **New timeline** creates a new chat automatically using the Director card when available, otherwise the current card or an empty chat; a small `src/flows/new-chat.js` wraps ST's chat-creation API so the fallback is testable. If ST chat creation fails, fall back to the explicit replace confirmation. `openShell()` defaults to Session Home when a world exists, otherwise Season. Persist the last tab per chat in `chatMetadata.neoterra.ui.lastTab`; restore it on open. "Keep current world" returns to Session Home, not the identity step.
- **Acceptance criteria:**
  - Reopening the shell on the S1 Director chat lands on Session Home, not the season grid.
  - Map is one click from Session Home; no season is re-selected.
  - "New timeline" creates a new chat and leaves the existing chat intact; if creation fails, the replace confirmation is explicit.
  - A chat with no world still opens the season grid.
  - Unit tests cover the pure home view model and last-tab fallback.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(shell): add a session home and remember the last tab per chat`

#### 5. Make the Map self-sufficient and travel-friendly
- **Files:** `src/ui/shell.js`, `src/ui/map-panel.js`, `src/ui/overlay.js`, `src/core/defaults.js`, `src/ui/settings.html`, `docs/map-authoring.md`, `tests/travel.test.js`
- **Depends on:** 4 (Session Home links)
- **Parallelizable:** yes
- **Expected behavior:** The Map opens with no world and shows a single "No world in this chat — start a season" CTA that switches to the Story tab. `/neoterra map` and the Session Home Map button open it directly. Add both travel modes (`map.closeOnTravel:true|false`), a visible "Return to chat" button, and the arrival summary in the sidebar. Do not change the default yet: Spike B measures which mode works after the HUD/scene-card changes. Add a compact threat-stage badge and a district-control overlay toggle colored by faction influence, with a legend. No dead-end empty map.
- **Acceptance criteria:**
  - No-world Map shows the CTA and no disabled dead end.
  - With a world, travel posts the arrival frame and both close/keep-open modes work.
  - The travel outcome is visible in both the sidebar and the chat.
  - Tests cover `shouldCloseAfterTravel` for both values.
  - The default remains `true` until Spike B signs off a change.
- **Risk:** low–medium
- **Model / Effort:** fast implementer #low
- **Commit:** `feat(map): open without a season and keep the travel loop coherent`

#### 6. Style the Season and Identity screens
- **Files:** `style.css`, `src/ui/season-menu.js` (markup hooks only), `tests/ui-css.test.js`
- **Depends on:** none
- **Parallelizable:** yes
- **Expected behavior:** Add complete styles for `.neoterra-season-menu`, `.neoterra-season-grid`, `.neoterra-season-card`, `.neoterra-season-card-header`, `.neoterra-season-title`, `.neoterra-season-era`, `.neoterra-season-premise`, `.neoterra-season-facts`, `.neoterra-season-content-note`, `.neoterra-season-actions`, `.neoterra-season-toolbar`, `.neoterra-character-first`, `.neoterra-identity-options`, `.neoterra-identity-option`, `.neoterra-identity-label`, `.neoterra-identity-detail`, `.neoterra-back`, `.neoterra-cancel`, and `.neoterra-agent-log`. Use a 1/2/3-column responsive grid, clear focus rings, badges, and a portrait slot (initials fallback until step 7). Remove the default `fieldset` look.
- **Acceptance criteria:**
  - Live Season and Identity screens have card layout, spacing, and focus states; no default groove fieldset.
  - CSS test asserts the key selectors exist.
  - Layout works at 1440×900, 1024×768, and 390×844.
- **Risk:** low–medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `style(season): style the season cards and identity picker`

### Milestone 2 — Character experience

#### 7. Add an avatar manifest and resolver
- **Files:** `tools/build-avatars.mjs` (new), `data/characters/avatars.json` (generated), `data/characters/avatar-overrides.json` (authored, new), `assets/avatars/` (optional copied PNGs, new), `src/data/avatars.js` (new), `src/ui/avatar.js` (new), `src/ui/season-menu.js`, `src/ui/codex.js`, `src/ui/player-panel.js`, `src/ui/map-panel.js`, `src/ui/chat-output.js`, `src/ui/settings.html`, `src/ui/settings.js`, `style.css`, `package.json`, `tests/avatars.test.js`
- **Depends on:** 6 (portrait slots), 3 (player sheet), 2 (no)
- **Parallelizable:** yes
- **Expected behavior:** `npm run build:avatars` scans a source directory (default `Chars/`, override `--source`) for PNGs, reads the embedded `chara` card JSON when present, and matches each PNG to a registry entry by id/name/alias/filename. The user's reference set lives at `C:\Users\locua\OneDrive\Escritorio\KI\chars\neo`; the command is run as `npm run build:avatars -- --source "C:\Users\locua\OneDrive\Escritorio\KI\chars\neo"`. That folder is reference material, not the runtime storage folder. Ambiguous matches require an entry in `data/characters/avatar-overrides.json`; the generated `avatars.json` is never hand-edited. `--check` reports missing/ambiguous. The generated manifest maps `registryId -> { file, source, hash }`; by default the tool copies matched PNGs into `assets/avatars/`, with `--no-copy` for runtime-only installs. At runtime `resolveAvatarForEntry(entry, ctx)` prefers the manifest, then a per-user sync override, then the installed ST character with an exact `dataName`/alias match, then initials. Add a **Sync portraits** action in Settings that re-scans `ctx.characters`, writes a per-user override map to extension settings/localStorage, and refreshes every avatar surface; add **Download manifest** for merging into `data/characters/avatars.json`. The browser never writes the repository. Add avatars to the season identity picker, Codex list/detail, Player sheet, map present-cast, and scene frame; lazy-load with `onerror` fallback.
- **Acceptance criteria:**
  - `npm run build:avatars` writes the manifest; `--check` passes and lists any unmatched registry entries.
  - Live: all 74 registry entries that match an installed card display a portrait; unmatched entries show initials, never a broken image.
  - Ambiguous short names (Claire/Carol/Aurelia) resolve deterministically via manifest/override or fallback; no cross-character portrait swap.
  - **Sync portraits** updates the UI after a new installed card appears; **Download manifest** produces a mergeable file.
  - Tests cover exact match, alias match, ambiguous match, missing fallback, and sync override precedence.
- **PR boundary:** land the tool + generated manifest + resolver tests first; wire the UI surfaces in a follow-up PR. Do not combine binary asset generation with the UI diff.
- **Risk:** medium–high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(avatars): add a generated portrait manifest and runtime resolver`

#### 8. Ingest PNG character cards (optional, opt-in)
- **Files:** `tools/build-data.mjs`, `docs/adding-a-season.md`, `tests/build-data.test.js` (or the existing data tests)
- **Depends on:** 7 (shares PNG chunk parsing)
- **Parallelizable:** yes
- **Expected behavior:** `build-data` accepts `.png` cards in `Chars/<Season>/`, extracts the embedded `chara` JSON from a `tEXt`/`zTXt`/`iTXt` chunk, and registers the card. If a JSON twin with the same slug exists, prefer the JSON text and pair the PNG as `avatarPath`; otherwise use the PNG's embedded data. `--check` validates malformed PNGs, duplicate slugs, and missing `chara` data. No new dependencies (use `zlib` + manual chunk parsing).
- **Acceptance criteria:**
  - A new PNG-only card appears in the registry with the expected id/name and an `avatarPath`.
  - A JSON + PNG pair produces one entry, not two.
  - A malformed PNG fails with an actionable error and does not write partial output.
  - Existing JSON-only builds are unchanged.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(data): accept PNG character cards and extract embedded card JSON`

#### 9. Allow warned cross-season guest characters
- **Files:** `src/flows/season-start.js`, `src/ui/season-menu.js`, `src/core/defaults.js`, `src/context/renderer.js`, `src/state/world-state.js`, `src/agents/storyline.js`, `docs/canon-beats.md`, `tests/guest-identity.test.js`
- **Depends on:** 4 (Session Home shows the guest badge)
- **Parallelizable:** no
- **Expected behavior:** Add `identity.allowGuests` (default `true`) and `identity.guestCanonBeats` (`adapt` default, `off` optional). `resolveIdentitySelection` accepts any registry character in any playable season when guests are allowed, but records `guest:true`, `guestSeasonId`, and `warningAccepted`. The warning must be displayed and require an explicit acknowledgment checkbox; the Begin button stays disabled until it is checked. Guests can be turned off in Settings, but when on, every cross-season selection shows the warning. **Do not reuse `flags.nonCanon` for guests:** keep `flags.nonCanon` for Sandbox/non-canon free play (where canon beats are disabled), and add `flags.guestCharacter = { characterId, homeSeasonId, warningAcceptedAt }` plus `flags.canonMode = 'adapted'`. Update `buildOpeningScene` (`src/flows/scene.js:84-91`) so a guest shows "guest character: home season X — canon beats adapt" instead of "canon beats disabled". The renderer adds a "Non-canon guest" prompt block explaining the era/home-season mismatch and instructing the Director not to grant future knowledge. The Storyline tracker may mark a beat `adapted` when a guest makes it impossible; it never hard-fails the world solely because of the guest. Sandbox remains unchanged.
- **Acceptance criteria:**
  - Starting S4 Vaiva in S1 requires the visible warning + acknowledgment; without it, Begin is disabled.
  - The world shows the guest badge; the prompt contains the guest block; dependent beats adapt rather than fail.
  - Guests disabled returns the current rejection path.
  - Tests cover allow/deny, warning acceptance, flag writes, and beat adaptation.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(identity): allow warned cross-season guest characters`

#### 10. Build the portrait-first Character Picker
- **Files:** `src/ui/character-picker.js` (new), `src/ui/season-menu.js`, `src/ui/codex.js`, `style.css`, `tests/character-picker.test.js`
- **Depends on:** 7 (avatars), 9 (guest warning)
- **Parallelizable:** no
- **Expected behavior:** A pure view model + DOM mount for a character grid. Inputs: registry, current season, selected id, filters, `allowGuests`. Renders portrait, display name, side, home season, form kind, and status. Sections: "Canon roster", "Other seasons" (guests), and "Custom persona". Search matches name/aliases; filters: season, side, form group, role. Selecting a guest shows the mandatory warning and requires the acknowledgment checkbox; the confirm action stays disabled until checked. Keyboard: arrows move, Enter selects, Escape closes. Use it in the season identity step and the Codex Play as dialog. Replace the raw-ID "Character-first" field with this picker.
- **Acceptance criteria:**
  - A user can find "Vaiva" by typing, see all forms, and choose a guest from another season only after the mandatory warning + acknowledgment.
  - The picker works with all 78 registry entries and their forms without layout jank.
  - Tests cover search, filters, guest section, and selection round-trip.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(codex): add a portrait-first character picker`

#### 11. Apply the target form's profile on transform
- **Files:** `src/state/reducer.js`, `src/state/world-state.js`, `src/state/selectors.js`, `src/ui/codex.js`, `src/context/renderer.js`, `src/context/worldbook.js`, `tests/form-profile.test.js`
- **Depends on:** 7 (form avatars), 9 (guest forms) for the full experience; the core can land independently
- **Parallelizable:** no
- **Expected behavior:** At seed time, store `character.formProfiles[formId]` for every form in the character's group (appearance, attire, abilities, traits, likes, dislikes, goals, notes, source). For characters introduced mid-game by the Cast Director or a manual add, run the same profile seed helper at introduction time. On `TRANSFORM`, apply the target overlay to the live fields, preserve status/stamina/willpower/corruption/relationships and any `manualFields`, and set `profileFormId`/`profileSource`. On a reverse transform, re-apply the base overlay. Codex card sections and the active avatar use the active form profile; `Import card profile` imports into the active form id.
- **Acceptance criteria:**
  - Transforming Vaiva to Light Shade changes the prompt's appearance/abilities and the Codex card text.
  - Reverting restores the base profile; manual edits are preserved.
  - A form without a card profile leaves the base fields and adds a visible "no card profile" note.
  - Tests cover forward, reverse, manual-edit preservation, and missing profile.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `fix(forms): apply the target form profile on transform`

#### 12. Add the Form Architect agent for missing forms
- **Files:** `src/core/constants.js` (AGENT_IDS), `src/core/defaults.js`, `src/agents/prompts.js`, `src/agents/form-architect.js` (new), `src/state/reducer.js`, `src/context/renderer.js`, `src/ui/codex.js`, `src/ui/settings.html`, `src/ui/settings.js`, `style.css`, `tests/form-architect.test.js`
- **Depends on:** 11 (profile overlay)
- **Parallelizable:** no
- **Expected behavior:** Add `formArchitect` to the agent registry and settings. The transform **flow** (Codex form swap and Storyline-emitted transform) gains a dynamic-form branch: when the target form is unknown to the registry, or a guest character reaches a form with no card, the flow auto-generates a profile using the base/current profile, form metadata, trigger, **season threats/factions, other cast cards, the same form group, and recent scene** instead of rejecting outright. There is no approval gate before play: the generated form applies immediately with a visible badge. The pure reducer accepts only a pre-validated `dynamicForm` payload; it never calls an LLM. Validate the response: displayName, side, formKind, appearance, attire, personality, speech, abilities[], likes[], dislikes[], goals[], notes, transformationSummary, contentFlags[]. Enforce length caps and the content gate. Store under `flags.generatedForms[characterId][formId]` with `generated:true`, model, and timestamp; apply the overlay immediately. The Codex shows a "Generated form" badge with Edit / Regenerate / Approve (a quality marker, not a play gate) and an **Export generated forms** button (JSON, per chat). On failure, keep the base profile and add a "transformed" note; never block the turn.
- **Acceptance criteria:**
  - A transform to a missing form produces a generated profile that appears in the prompt and Codex without an approval step.
  - The prompt inputs include season threats/factions, other cast cards, and the same form group.
  - The generated form can be edited, regenerated, approved, and exported; the badge is clear.
  - A transport/validation failure falls back without breaking play.
  - Tests use a fake runner for success, invalid JSON, timeout, and export shape.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(forms): generate missing form profiles with a Form Architect agent`

#### 13. Complete form data and cross-season packs
- **Files:** `data/form-groups.json`, `data/form-rules.json`, `data/seasons/*.json` (`altFormsAllowed`), `tools/build-data.mjs`, `src/data/forms.js`, `tests/forms.test.js`
- **Depends on:** 11, 12
- **Parallelizable:** yes
- **Expected behavior:** Add missing groups for the ungrouped base cards, allow cross-season groups (e.g., `Blazing Prism` with `Light Shade`), normalize the S4 Claire/Anastasia chains, and make `altFormsAllowed` a runtime gate or remove it. Add a build check: every alt card belongs to a group; every group has a reachable rule path from its base; every rule references existing ids; every season's `altFormsAllowed` is valid. Include guest/season form packs in the runtime form index.
- **Acceptance criteria:**
  - `npm run build:data -- --check` reports zero ungrouped alt cards and zero unreachable rules.
  - Cross-season Blazing Prism transform works when the pack is allowed.
  - S4 Claire/Anastasia transformations follow the declared base.
  - Tests cover group resolution, cross-season packs, and `altFormsAllowed`.
- **Risk:** medium–high
- **Model / Effort:** standard implementer #medium
- **Commit:** `data(forms): complete form groups, rules, and cross-season packs`

### Character Creator investigation spike (before production Card Architect)

**Preliminary findings.** Reliability will not come from one prompt. It needs a constrained pipeline: (1) a short human-approved concept brief (era, role, side, powers, limits, relationships, tone, content limits); (2) retrieval of 3–5 same-season exemplar cards plus the season bible/threats/factions; (3) a strict `chara_card_v3` profile schema with per-field length caps; (4) a draft → self-critique → repair loop; (5) deterministic validation (schema, id/name uniqueness, content gate, no future knowledge, no player-agency override); (6) an Auditor pass against the season facts; (7) human approval before the card is usable in a chat; (8) export to JSON/PNG-compatible card, but no repository writes. The hardest failure modes are canon hallucination, overpowered abilities, tone drift, and confident but empty sections. The spike must measure those, not just JSON validity.

#### A. Character Creator reliability spike
- **Files:** `docs/character-creator-research.md` (new), `plans/spikes/character-creator/` (samples, prompt drafts, rubric; no runtime code)
- **Depends on:** 12 (reuse the Form Architect prompt/validation patterns); can start in parallel with 11–13
- **Parallelizable:** yes
- **Expected behavior:** Define what "reliable" means before building. Produce: (a) a 10-criteria rubric (schema validity, section completeness, tone match, canon consistency, no future knowledge, no player-agency override, ability balance, name/id uniqueness, content-gate compliance, human approval); (b) a draft chara_card_v3 profile schema and section style guide; (c) a prompt that uses 3–5 same-season exemplar cards, the season bible/threats/factions, and form rules; (d) a draft → self-critique → schema validation → Auditor consistency check → human review pipeline; (e) 3–5 sample generated cards with scores and failure notes, compared against hand-authored cards; (f) a held-out test set of 20 concepts and a repeatability check; (g) a user-supplied portrait flow (file picker, type/size validation, no server write); (h) a go/no-go recommendation and estimated cost. No production data writes; no `data/` changes.
- **Acceptance criteria:**
  - The research doc contains the rubric, schema, prompt, pipeline, samples, and a clear go/no-go recommendation.
  - Samples are scored against the rubric by at least two reviewers; known failures are listed, not hidden.
  - The proposed bar is explicit (e.g., 0 schema failures, 0 canon contradictions, ≥4/5 human quality on held-out concepts), or the recommendation explains why a different bar is safer.
  - The recommendation states whether a production Card Architect should use one pass, critique+repair, or human-in-the-loop approval, and explicitly says **stop at missing-form generation** if the result is red.
  - No runtime code or generated card is merged into `data/`.
- **Risk:** medium
- **Model / Effort:** frontier implementer #high
- **Commit:** `docs(spike): research a reliable Neo Terra character creator`

### Milestone 3 — Invasive UI

#### 14. Add the persistent session HUD
- **Files:** `src/ui/hud.js` (new), `src/ui/shell.js`, `style.css`, `tests/hud.test.js`
- **Depends on:** 4 (Session Home data), 3 (Player sheet), 7 (avatars)
- **Parallelizable:** no
- **Expected behavior:** A collapsible right rail (`#neoterra-hud`) appears only when a world exists. It is **gameplay-only**: season/act/time, location, player identity/form, stamina/willpower/corruption bars, current threat and stage, current beat/deadline, present-cast avatars, and actions (Map, Cast, Player, Journal, Newspaper). Settings, export/import, agent configuration, prompts, and diagnostics stay in the Extensions drawer/menus. Updates on `MAP_UPDATED`/`CHAT_CHANGED`; step 17 adds the turn-completion signal. It is a **fixed, collapsible overlay rail**; no dock mode in this pass. On small screens it becomes a bottom sheet or is hidden behind a handle. A setting controls visible/collapsed.
- **Acceptance criteria:**
  - HUD is visible during chat on the S1 world and hidden on a no-world chat.
  - Meters, location, threat, and current beat/deadline update after a turn/travel without reload.
  - Buttons open the corresponding windows/tabs; no overlap with the send form.
  - No Settings/export/agent-config controls appear in the HUD.
  - Unit tests cover the pure HUD view model and placement/clamp logic.
- **Risk:** medium–high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(ui): add a persistent Neo Terra session HUD`

#### 15. Add the floating window manager
- **Files:** `src/ui/window-manager.js` (new), `src/ui/shell.js`, `src/ui/map-panel.js`, `src/ui/codex.js`, `src/ui/relationships.js`, `style.css`, `tests/window-manager.test.js`
- **Depends on:** 14 (HUD actions)
- **Parallelizable:** no
- **Expected behavior:** A `#neoterra-window-layer` hosts draggable/resizable windows with a title bar, minimize/close, focus stack, Escape-to-close, focus trap, and per-window geometry persistence. Map, Codex, and Relations move out of the modal into windows; the shell becomes a launcher/Session Home. The map panel's internal drag/resize is disabled when hosted, or the host chrome is hidden to avoid nested dragging. Mobile: windows become full-screen sheets.
- **Acceptance criteria:**
  - Map, Codex, and Relations open over the chat; the chat remains scrollable and the input usable.
  - Windows drag/resize within the viewport, persist geometry, and restore on reopen.
  - Only one modal focus trap is active; Escape closes the topmost window.
  - Settings, export/import, and agent configuration are not windows; they remain in menus.
  - Tests cover clamp, stack order, and restore geometry.
- **PR boundary:** land the window-manager core + CSS + tests and migrate the Map first; migrate Codex and Relations in a follow-up PR.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(ui): move map, codex, and relations into floating windows`

#### 16. Render scene cards and present-cast headers
- **Files:** `src/ui/chat-output.js`, `src/ui/scene-decorator.js` (new), `src/ui/shell.js`, `style.css`, `tests/scene-decorator.test.js`
- **Depends on:** 7 (avatars), 15 (windows) for the full experience
- **Parallelizable:** yes
- **Expected behavior:** Scene builders add structured `meta` to `extra.neoterra.scene`: location name, time slot, POV, and present character ids. The DOM decorator runs after `addOneMessage` and on `CHARACTER_MESSAGE_RENDERED`/chat reload, adding a header row, portrait strip, and badges to `.neoterra-scene-message`. Message text is never modified. A **Cinematic chat** mode toggles the decoration, groups consecutive Neo Terra scene frames under a scene divider, and hides ST timestamps/avatars for those frames; standard chat remains available. The mode must not hide user messages or non-Neo-Terra messages.
- **Acceptance criteria:**
  - Opening/travel/encounter frames show a header and portraits after reload.
  - Cinematic mode groups scene frames and hides their ST chrome; user and non-Neo-Terra messages are unaffected.
  - No duplicate decoration; no effect on non-Neo-Terra messages.
  - The chat history remains unchanged (compare `mes` before/after).
  - Tests cover metadata extraction and decorator idempotence.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(chat): render scene cards with location and present-cast headers`

#### B. Travel feedback and map-close spike
**Preliminary finding.** The current close-on-travel is a sensible workaround: the map changes, but the player gets little confirmation beyond the sidebar. With the HUD, arrival toast, and scene card in place, the map may no longer need to close to prove that something happened. The spike must measure this rather than assume it.

- **Files:** `docs/travel-feedback-research.md` (new), `plans/spikes/travel-feedback/` (test script, notes)
- **Depends on:** 5 (both travel modes), 14 and 16 (HUD/scene cards must exist before judging the new feel)
- **Parallelizable:** yes
- **Expected behavior:** Measure the current close-on-travel behavior and the new keep-open behavior after the HUD/scene-card changes. Run scripted travel tests (district → bridge → key location; encounter and no-encounter; combat-locked) and record time-to-orientation, clicks to reopen the map, whether the arrival is noticed, and confusion notes. Compare three modes: close-on-travel, keep-open with sidebar arrival, and keep-open with a toast + "Return to chat" pulse. Recommend a default; do not change it in production until approved.
- **Acceptance criteria:**
  - The research doc records the method, the scripted runs, the measurements, and the recommendation.
  - Both existing modes are exercised live; no default is changed by the spike itself.
  - The recommendation explicitly says whether the current close-on-travel is still justified after the UI changes.
- **Risk:** low
- **Model / Effort:** standard implementer #medium
- **Commit:** `docs(spike): measure travel feedback and map-close behavior`

#### 17. Add turn progress and state toasts
- **Files:** `src/agents/state-tracker.js`, `src/ui/turn-status.js` (new), `src/ui/toasts.js` (new), `src/ui/shell.js`, `style.css`, `tests/turn-status.test.js`
- **Depends on:** 15 (window layer) for placement; 16 for scene deltas
- **Parallelizable:** yes
- **Expected behavior:** `runTurnPipeline` accepts an `onStage` callback and emits `start`/`done`/`failed` for clock, world tick, pacing, tracker, storyline, cast, and choices. The shell renders a compact "Director is updating" chip with stage labels and a timeout/skip state. A pure `diffWorldState(before, after)` produces batched toasts: stamina/willpower/corruption changes, new rumors, cast arrivals/departures, form changes, and newspaper editions. Agent errors show a toast with a details link to the agent log.
- **Acceptance criteria:**
  - A slow/failed tracker shows progress and a non-blocking error toast; the turn still completes.
  - State deltas appear at most once per turn and do not spam.
  - `diffWorldState` is unit-tested for the main delta types.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(chat): show turn progress and state-delta toasts`

#### 18. Add the Journal and recap
- **Files:** `src/ui/journal.js` (new), `src/ui/shell.js`, `src/ui/hud.js`, `src/agents/lore.js`, `src/flows/scene.js`, `style.css`, `tests/journal.test.js`
- **Depends on:** 16 (scene metadata). Generated recaps need step 20 (Lore wiring); the deterministic fallback lands in this step.
- **Parallelizable:** yes
- **Expected behavior:** A Journal window/tab with "Previously on", a chronological timeline (beats, travel, encounters, form changes, relationship changes, newspaper headlines), filters (act/character/location), search, and "Export recap". Deterministic entries come from `WorldState`; the Lore agent writes a recap paragraph and summaries when enabled.
- **Acceptance criteria:**
  - A new world shows the opening entry; travel/turn events append without duplicates.
  - The recap updates when Lore is enabled and falls back deterministically when disabled.
  - Export produces a readable Markdown file.
  - Tests cover entry extraction and dedupe.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(journal): add a recap and world-event journal`

#### 19. Add the first-run wizard and command palette
- **Files:** `src/ui/season-menu.js`, `src/ui/command-palette.js` (new), `src/ui/shell.js`, `src/core/defaults.js`, `src/ui/settings.html`, `src/ui/settings.js`, `style.css`, `tests/onboarding.test.js`
- **Depends on:** 6 (styled season cards), 10 (picker), 4 (Session Home)
- **Parallelizable:** no
- **Expected behavior:** A three-step wizard: season (visual cards with era/tone/threat/cast), character (portrait picker or custom persona), confirm (content notice, mandatory guest warning, start). Recommended presets: Cinematic (clock/tick/pacing/choices/HUD/scene cards/dynamic forms), Classic (V1.1), Sandbox (no beats). Auto-open once on first install (setting). `/neoterra` opens a gameplay command palette with Travel, Cast, Player, Journal, Rest, Patrol, Newspaper, and "New timeline"; Settings/export/import stay in menus (a palette entry may open the drawer, but it is not a gameplay action). "New timeline" creates a new chat automatically, using the Director card when available, otherwise the current card or an empty chat; if creation fails, offer the explicit replace path.
- **Acceptance criteria:**
  - A fresh install reaches a playable S1 start in three steps.
  - An existing world reaches Session Home, not the wizard.
  - "New timeline" creates a new chat and leaves the existing chat intact; failure falls back to replace.
  - The palette actions work by keyboard and mouse; settings are reachable only through the menu/drawer.
  - Tests cover the wizard state machine and palette filtering.
- **PR boundary:** land the wizard first; ship the command palette in a follow-up. Keep new-timeline chat creation behind a setting until the ST API path is verified.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `feat(onboarding): add a first-run wizard and command palette`

### Milestone 4 — Living world

#### 20. Wire Cast Director, Lore, Auditor, Bad End, and the agent log
- **Files:** `src/ui/shell.js`, `src/agents/state-tracker.js`, `src/flows/initiative.js`, `src/flows/scene.js`, `src/ui/bad-end.js`, `src/ui/agent-log.js`, `src/ui/settings.js`, `src/core/defaults.js`, `docs/scene-output.md`, `docs/relationships.md`, `docs/bad-ends.md`, `tests/agent-wiring.test.js`
- **Depends on:** 17 (progress/errors), 18 (journal), 15 (window for the log)
- **Parallelizable:** no
- **Expected behavior:** Cast Director runs on travel/arrival and on a configurable scene cadence; arrivals/departures surface as toasts and map changes. Lore runs every 10 turns or on act change and feeds the Journal. Auditor runs at act boundaries and shows a non-blocking continuity badge. Bad End flow mounts when `badEnds.enabled` and uses the existing predicates; the agent log mounts in a debug drawer with latency/tokens/errors. Architect is an optional season-start pass (default off). Every agent honors its enable flag; disabling stops all calls.
- **Acceptance criteria:**
  - With agents enabled, a travel produces a Cast Director update; 10 turns produce a Lore recap; an act boundary produces an Auditor finding.
  - Disabling an agent results in zero calls (fake runner counts).
  - Bad End UI appears when enabled; nothing runs when disabled.
  - Errors are visible and non-blocking.
- **PR boundary:** land Cast Director + Lore first; land Auditor + Bad End + agent log in a follow-up. Each agent must be independently disableable.
- **Risk:** high
- **Model / Effort:** frontier implementer #high
- **Commit:** `feat(agents): wire cast, lore, auditor, bad end, and the agent log`

#### 21. Content depth pilot and downtime loop
- **Files:** `data/seasons/s1.json`, `data/seasons/s1dark.json`, `data/agendas.json`, `src/flows/downtime.js` (new), `src/ui/hud.js`, `src/ui/command-palette.js`, `docs/canon-beats.md`, `tests/seasons.test.js`, `tests/downtime.test.js`
- **Depends on:** 20 (Lore/Storyline behavior), 14/19 (HUD/palette actions)
- **Parallelizable:** yes
- **Expected behavior:** Add two side beats per season (optional, no deadline) and a small downtime/civilian-life event table. Add a deterministic downtime flow with **Rest, Train, Patrol, Investigate, Socialize, Work**: each advances the clock one slot, applies small bounded state changes, and optionally posts a short scene prompt; no LLM is required. Expose these actions in the HUD and command palette. Differentiate S1 and S1Dark post-victory beats first and add a season-specific deterministic epilogue template for the ending pilot. Add an optional `ending.dynamic` path that calls the Epilogue agent on ending reached, but keep it off by default and mark it "review required" until a separate sign-off. Add a content validator for beat ids, act coverage, and deadline sanity. Keep the same schema; no new required fields.
- **Acceptance criteria:**
  - The user reviews and approves the S1/S1Dark pilot beats and epilogue drafts before merge.
  - S1/S1Dark have 8 beats (6 canon + 2 side) and a distinct post-victory set.
  - The S1/S1Dark deterministic epilogue reads season-specific, not the generic four-beat template.
  - Clicking Rest/Train/Patrol advances the clock, applies the expected change, and adds a Journal entry.
  - Downtime works with all agents disabled; content gate applies.
  - `ending.dynamic` is off by default; when enabled, the generated epilogue is stored once and never regenerated on reload.
  - `npm run build:data -- --check` and season/downtime tests pass.
  - No canon beat is unreachable or duplicated.
- **Risk:** medium
- **Model / Effort:** standard implementer #medium
- **Commit:** `content(seasons): add side beats, downtime, and civilian-life events`

#### 22. Regression suite, live QA, and release docs
- **Files:** `tests/*.test.js`, `docs/qa.md` (new), `README.md`, `CHANGELOG.md`, `package.json`, `manifest.json`, `src/core/constants.js`
- **Depends on:** all approved steps
- **Parallelizable:** no
- **Expected behavior:** Add regression tests for the P0 fixes (Director status, Player mount, Session Home, no-world Map CTA, guest identity, form profile, avatar fallback/sync, generated-form export, new-chat creation). Add a manual QA checklist covering fresh install, resume, travel, guest warning acknowledgment, dynamic form, floating windows, **mobile at 390×844 and touch targets**, light/dark, content gate, export/import, and agent failure. Use temporary `NT-Audit` chats/characters for destructive tests and delete them afterward. Update README/CHANGELOG and align version numbers.
- **Acceptance criteria:**
  - `npm run check` passes.
  - The manual checklist is complete and signed off, including mobile.
  - Temporary `NT-Audit` chats/characters are deleted after QA; no test artifacts remain in the user's library.
  - HUD, picker, map, and scene-card layouts work at 390×844 without horizontal overflow or unusable touch targets.
  - Version is consistent across `package.json`, `manifest.json`, and `EXTENSION_VERSION`.
  - No doc claims an unwired feature.
- **Risk:** low
- **Model / Effort:** standard implementer #medium
- **Commit:** `test(qa): add experience regression checks and release docs`

## Verification & Testing

### Automated checks (run after every step)
```bash
npm run check
# equivalent to:
node tools/build-data.mjs --check
node tools/build-map.mjs --check
node tools/map-coords.mjs --check
node --check index.js
node --check tools/build-data.mjs
node --check tools/build-map.mjs
node --check tools/map-coords.mjs
node --check tools/smoke-test.mjs
node --test tests/*.test.js
node tools/smoke-test.mjs
```

Targeted checks:
```bash
node --test tests/season-start.test.js tests/director-card.test.js
node --test tests/player-panel.test.js
node --test tests/session-home.test.js
node --test tests/avatars.test.js
node --test tests/character-picker.test.js
node --test tests/guest-identity.test.js
node --test tests/form-profile.test.js
node --test tests/form-architect.test.js
node --test tests/window-manager.test.js
node --test tests/scene-decorator.test.js
node --test tests/turn-status.test.js
node --test tests/journal.test.js
node --test tests/agent-wiring.test.js
node --test tests/downtime.test.js
node --test tests/ending-pilot.test.js
```

Build checks:
```bash
npm run build:data
npm run build:map
npm run build:avatars
npm run build:avatars -- --check
```

### Manual checks (live ST at 127.0.0.1:8000)
1. **Fresh install:** no world → shell opens the wizard; choose a preset; S1 → custom persona → Begin; opening frame posts; choices appear; input focuses; no console errors.
2. **Resume:** reload; open shell; Session Home appears, not the season grid; Continue returns to chat; Map opens in one click; no season prompt.
3. **Existing world:** S1 Director chat → Session Home shows act/time/location/player/threat/present cast; **New timeline creates a new chat** and leaves the existing chat untouched; failure falls back to the explicit replace path.
4. **Player:** Player tab shows live stamina/willpower/corruption/skills/form; manual edit persists; tracker pass does not overwrite.
5. **Map/travel:** open Map; select a district/bridge/location; Travel enabled only out of combat; arrival frame posts; test both close-on-travel and keep-open modes; encounter bar appears when hostiles are present. Record the default for Spike B.
6. **Codex:** portraits load; **Sync portraits** picks up a newly installed card; **Download manifest** produces a mergeable file; search/filters work; form lineage swaps; Play as shows the picker; the guest warning appears for a non-roster character.
7. **Guest:** start S4 Vaiva in S1; the warning is visible, Begin is disabled until the acknowledgment is checked; guest badge in Session Home/Codex; prompt includes the guest block; a dependent beat adapts instead of failing.
8. **Forms:** transform Vaiva to Light Shade; prompt/Codex appearance and abilities change; avatar changes; revert restores; manual edits survive.
9. **Dynamic form:** transform a guest to a form with no card; generated form appears automatically with a badge; edit/regenerate works; **Export generated forms** produces a valid JSON bundle; a forced agent failure leaves the base profile and a note.
10. **UI:** HUD visible only with a world and contains no Settings/export/agent-config controls; floating Map/Codex/Relations drag/resize/persist; chat stays usable; Escape closes the top window; mobile width uses full-screen sheets; light theme is readable.
11. **Chat:** scene frames show header/portraits after reload; no message text change; toasts batch; progress chip shows stages; agent error toast has details.
12. **Agents:** enable Cast/Lore/Auditor/Bad End; verify they run at the documented cadence; disable them; verify zero calls.
13. **Content gate:** set strict; profiles/forms/prompt text are filtered; generated form text respects hard limits.
14. **Export/import:** export a world; import into a new chat; state, cast, forms, guest flags, and bad-end records survive.
15. **Ending pilot:** review and approve the S1/S1Dark beats and epilogue drafts; reach a villain victory in-game; the deterministic epilogue is season-specific and stored once; `ending.dynamic` is off by default and, when enabled, is marked review-required.
16. **Character creator spike:** review `docs/character-creator-research.md`; confirm the rubric, samples, failure notes, user-supplied portrait flow, and go/no-go recommendation are sufficient before production work.
17. **Fallbacks:** Director card missing; profiles missing; avatar missing; form group missing; no world; malformed PNG; new-chat creation failure. Each shows a clear message and never blocks play.
18. **Cleanup:** delete temporary `NT-Audit` chats/characters; confirm no test artifacts remain.

### Edge cases
- Chat switch during an in-flight turn, map mount, or season start.
- Two chats with the same season are independent; no store bleed.
- Swipes and message edits do not re-tick the clock or duplicate frames.
- Old `WorldState` documents without `formProfiles`, `guestCharacter`, or `ui.lastTab` migrate on read.
- Duplicate character names/aliases (Claire, Carol, Aurelia) do not swap portraits or profiles; a sync override resolves the ambiguity.
- A guest character whose home season is not installed still works from the registry.
- A generated form id collides with a later authored form; the authored form wins and the generated overlay is marked stale.
- Content gate `strict` with generated forms; token budget exhausted; agent timeout.
- Map geometry persisted from older viewport sizes is clamped, not lost.
- Floating window layer + ST's own right nav panel do not trap focus or overlap the send form.
- New-chat creation fails or the Director card is missing; the fallback does not destroy the existing chat.
- The guest acknowledgment is unchecked; no world is created.
- Generated-form export/import round-trips without losing the `generated` flag.
- Mobile safe areas, browser chrome, and touch targets at 390×844; no horizontal scroll.

### Rollback
- Each step is independently revertible; no step requires a data migration that cannot be read by the previous version.
- Risky features are behind settings. Defaults: guest characters on with mandatory warning, dynamic forms auto-generate with visible badge + export, HUD collapsible overlay on, floating windows on, Cast/Lore/Auditor on, Bad End off (unchanged), `ending.dynamic` off (review required), avatar sync available but repo writes never automatic.
- Generated form data lives in `chatMetadata.neoterra`; deleting the flag removes the overlay without touching the chat.
- Avatar manifest is generated and optional; deleting `avatars.json` falls back to initials/installed cards.
