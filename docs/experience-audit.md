# Neo Terra experience audit

- **Date:** 2026-11-18
- **Status:** historical audit. The remediation plan in
  `plans/neoterra-experience-audit.md` is implemented as of 1.2.0; findings below
  describe the pre-1.2.0 state and are kept as the audit record.
- **Scope:** the whole shipped extension — `src/`, `data/`, `docs/`, `tools/` —
  plus a live pass against SillyTavern 1.19.x at `http://127.0.0.1:8000/` with
  the extension installed (664 installed character cards, one existing S1
  Director chat).

This report records what the extension promises, what it actually does today,
and the priorities that follow. It is the reference for the remediation
milestones; the step-by-step order lives in the plan.

## Method

- Static read of the entry point (`index.js`), every UI module and flow, the
  reducer/state layer, the agent runner and prompts, the build tools, the
  season/card/form data, and every document under `docs/`.
- Live checks in SillyTavern: opened the shell from the top-bar globe,
  inspected the Season list, entered the identity step, triggered the replace
  confirmation, opened the Map with and without a world, opened the Codex,
  switched to the Director chat with an existing S1 world, and measured
  computed styles and panel geometry.
- Registry-to-installed-card matching: fetched `data/characters/index.json` in
  the live page and compared `dataName`/aliases against `ctx.characters`.
- **Limits:** no screenshots (the desktop review pane was not visible), no
  destructive live test (no season replaced, no chat deleted), and the
  automated suite was not run during the audit itself. Test health was
  unverified until the first implementation step ran `npm run check`.

## Intended vs actual

| Dimension | Intended (`start.md` / README) | Actual today | Grade |
| --- | --- | --- | --- |
| Entry | Season menu; pick a season or character; a world is built around it | Season grid works, but it always opens first, has no resume state, and the first screen has no styling | 2/5 |
| Continuity | One chat = one timeline; reopen and continue | World state persists, but there is no Continue card; the current season still says "Enter season" and leads to a destructive replace prompt | 2/5 |
| Map | Top-right button; zoom/pan; nodes; travel; status overlay | Map is a tab inside a modal; works with a world, but is 862×442 inside a 920×602 shell, and offers no CTA when no world exists | 4/5 function, 2/5 presentation |
| Characters | Relevant cast, current info, manual additions, alternate forms | Codex is deep and functional, but has no portraits, cross-season guests are rejected outside Sandbox, and the picker is a radio list | 2/5 |
| Forms | Alternate forms swap naturally, profiles/abilities change | Forms are separate registry entries; transform changes id/name/side only, so appearance/abilities stay the base card | 2/5 |
| Trackers | Player and world state visible during play | State Tracker runs every turn, but the Player tab is a placeholder and no tracker is visible in chat | 1/5 |
| Agents | Architect, Storyline, State, Cast, Lore, Auditor, Epilogue, Choices, Bad End | State/Storyline/Choices/Epilogue are wired; Cast Director is forced `runDirector:false`, Lore/Auditor/Bad End/Architect are never instantiated, and the agent log is never mounted | 2/5 |
| Chat surface | The chat is the primary surface; scenes, arrivals, encounters | Scene frames are plain long messages with a generic avatar; no scene card, no status header, no turn feedback | 2/5 |
| UI | Sleek, futuristic, custom | Dark modal with strong map chrome, but Season/Identity/Agent log have zero CSS; no floating windows; no light theme | 2/5 |
| Content | Six seasons, beats, factions, civilian lives, newspaper | S1–S4 are solid (6 beats each, named threats, rich profiles); post-victory arcs are near-copies; S5 is a stub; NeoHorizon cards are invisible; no downtime/civilian loop | 3/5 |
| Extensibility | Data-driven seasons/cards/forms | Build pipeline is strong; adding PNG cards, avatars, or cross-season forms is not supported | 4/5 process, 2/5 content reach |

### Feature status

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

## Current state

The shell is a fixed full-viewport overlay (`style.css:82-135`) with seven tabs
(`src/core/constants.js:57-65`). `activeTab` is module state initialized to
`'season'` (`src/ui/shell.js:129`), so a page reload always lands on the Season
grid even when the chat already has a world. `LIVE_PANELS` excludes `player`
(`src/ui/shell.js:121`), while the complete player sheet
(`src/ui/player-panel.js:480`) is imported by nobody. The Season setup strip
checks `setup.directorInstalled` (`src/ui/season-menu.js:207-217`) but
`directorCardStatus` returns `{ installed }` (`src/ui/director-card.js:28-35`),
so an installed Director card is reported missing. Season cards and identity
radios have no CSS selectors at all (grep of `style.css`), and the identity
options render as an inline `fieldset`. The map runtime works from
`chatMetadata.neoterra.worldState`; with no world it paints an empty overlay and
disabled travel. The Codex renders rich profile text but no images
(`src/ui/codex.js:1082-1140`). Transform (`src/state/reducer.js:235-272`)
changes `formId`, name, side, and threat only. The turn pipeline runs clock →
world tick → pacing → State Tracker → Storyline → cast refresh with
`runDirector:false` (`src/agents/state-tracker.js:917-930`), then requests CYOA;
errors are collected but never surfaced (`src/ui/shell.js:1537-1588`).

## P0 — broken or actively misleading

1. **The Director card is reported missing while installed.**
   - Evidence: the live setup strip says "Director card — not installed" in the
     Director chat; `findStCharacter` resolves the card correctly when called
     directly. `renderSetupStrip` reads `setup.directorInstalled` while
     `directorCardStatus` returns `{ installed }`, so the flag is always
     `undefined`.
   - Files: `src/ui/season-menu.js:207-217,358-365`,
     `src/ui/director-card.js:28-35`.
   - Impact: users are told to download/import a card they already have; the
     primary setup CTA is wrong.

2. **The Player tab is a dead placeholder.**
   - Evidence: the live Player tab shows "The player sheet, identity, and
     current form will appear here."; `mountPlayerPanel` is never called
     (`src/ui/player-panel.js:480` defines it; no caller exists).
   - Files: `src/ui/shell.js:110-121`, `src/ui/player-panel.js:480`.
   - Impact: the only complete player-facing tracker is unreachable;
     stamina/willpower/corruption are invisible during play.

3. **No session-aware home; the shell always opens on Season.**
   - Evidence: after reload, `activeTab` is `'season'`; an existing S1 world
     still shows "Enter season"; clicking it leads to "Replace this chat's
     world?"; "Keep current world" returns to the identity step, not the list.
   - Files: `src/ui/shell.js:129,1744-1757`, `src/ui/season-menu.js:152-167,518-526`.
   - Impact: reads as being forced to re-select the season before reaching the
     map; the only visible action is destructive.

4. **Season and identity screens are unstyled.**
   - Evidence: live computed styles show a default groove `fieldset` border and
     inline radio labels; `style.css` has no `.neoterra-season-*`,
     `.neoterra-identity-*`, `.neoterra-back`, or `.neoterra-agent-log` rules.
   - Files: `src/ui/season-menu.js:96-150,244-300`, `style.css`,
     `tests/ui-css.test.js`.
   - Impact: the first screen a new user sees looks unfinished; the "sleek
     futuristic" goal is not met.

5. **A transform does not change the character's profile.**
   - Evidence: `TRANSFORM` sets `formId/formGroup/displayName/side/threatLevel`;
     it never updates appearance, outfit, abilities, traits, likes, dislikes, or
     notes. `seedCharacter` copies the starting form's card fields once.
   - Files: `src/state/reducer.js:235-272`, `src/state/world-state.js:166-212`,
     `src/ui/codex.js:661`.
   - Impact: a corrupted/cleansed character still looks and acts like the base
     card in the prompt and the Codex; alternate-form cards exist but their text
     is unused.

6. **Cross-season characters are impossible outside Sandbox.**
   - Evidence: `resolveIdentitySelection` rejects a non-roster id unless
     `allowAnyCharacter`; only Sandbox sets it. Codex "Play as" also checks the
     current roster.
   - Files: `src/flows/season-start.js:415-479`, `src/ui/codex.js:984-1018`,
     `data/seasons/sandbox.json:15-16`.
   - Impact: the requested "use a character from another season with a warning"
     path does not exist.

7. **No character imagery anywhere.**
   - Evidence: `data/characters/index.json` entries have no avatar field;
     `codex.js` renders text rows only; `player-panel.js` draws initials; scene
     frames use one generic `assets/neoterra-avatar.svg`.
   - Live check: 74 of 78 registry display names match an installed ST card
     name, but repeated short names (five "Claire", five "Carol") make naive
     matching unsafe.
   - Files: `data/characters/index.json`, `src/ui/codex.js:1082-1098`,
     `src/ui/player-panel.js:278-280`, `src/ui/chat-output.js:33,96`.
   - Impact: character selection is slow and impersonal; the PNG cards the user
     already has are unused.

8. **Several advertised agents never run.**
   - Cast Director: `runDirector:false` on every turn
     (`src/agents/state-tracker.js:917-930`).
   - Lore: `createLoreAgent`/`runLorePass` are never instantiated
     (`src/agents/lore.js:655,864`).
   - Auditor: `createAuditor`/`initiative.runAudit` are never called
     (`src/agents/auditor.js:315`, `src/flows/initiative.js:316`).
   - Bad End UI: `mountBadEndPanel` is never called (`src/ui/bad-end.js:188`).
   - Architect: `createArchitect` is never called.
   - Agent log: `mountAgentLog` is never called; `agent-log.js` is never mounted.
   - Impact: settings toggles for these agents are dead; the README claims they
     run.

9. **The turn pipeline has no user-visible progress or failure surface.**
   - Evidence: `runTurnPipeline` collects `errors[]` but returns `ok:true`; the
     shell ignores the result; every agent stage is awaited before choices.
   - Files: `src/agents/state-tracker.js:717-960`, `src/ui/shell.js:1537-1588`.
   - Impact: a slow/failed agent looks like a frozen UI; the user cannot tell
     whether the world updated.

10. **Documentation drift.**
    - The README claimed Cast Director/Lore/Bad End run per turn;
      `docs/scene-output.md` omitted the world-tick and pacing stages; the
      README still said `EXTENSION_VERSION` was `0.1.0` (it is `1.1.0`).
    - Impact: operators cannot tell what is actually active. Corrected in the
      same change as this report.

## P1 — UX and presentation

11. **One modal contains everything.** A 960px centered shell holds season, map,
    codex, relations, domain, and settings; the map is a draggable window inside
    that modal (`style.css:113-135`, `src/ui/shell.js:191-200`). The chat is
    blocked while inspecting state. There is no docked HUD, no floating
    codex/map, and no mini-map.

12. **The character picker is a radio list.** Identity options show name + side
    only (`src/ui/season-menu.js:96-150`); no portrait, search, season/role
    filters, or form lineage. The season list's "Character-first" field expects
    a raw character id (`placeholder="Filter seasons by character id"`,
    `src/ui/season-menu.js:268-272`).

13. **The map sidebar is text-dense and not status-first.** Threats, factions,
    rumors, headlines, activity, and selection all stack in one narrow column
    (`src/ui/map-panel.js:664-666`, `src/ui/overlay.js:307-360`); there is no
    district control overlay, no portrait row for present cast, and no threat
    clock visual.

14. **In-chat frames are plain messages.** Opening/travel/encounter frames are
    long markdown blocks (`src/ui/chat-output.js:73-130`); no structured header,
    portrait strip, location/time badges, or collapsible details. The opening
    frame repeats the premise and the kickoff.

15. **No journal or recap.** The Lore agent's summaries are not surfaced
    (`src/agents/lore.js:655,864` are never called); there is no "previously
    on" after a break, no event timeline, and no discovered-lore view.

16. **Settings are an 18-group wall.** No presets, no first-run wizard, no
    "what runs when" explanation, and no diagnostics for missing
    cards/agents/worlds (`src/ui/settings.html:410-416` is the only agent
    configuration surface).

17. **Responsive and theme gaps.** Fixed pixel shell/map geometry
    (`style.css:113-135`), hardcoded dark tokens (`src/ui/theme.css:6-40`), no
    light-theme adaptation, and minimal mobile behavior.

## P2 — content and long tail

18. **Form data is incomplete and inconsistent.** 30 groups / 43 rules; missing
    groups for several base cards; cross-season groups are forbidden; S4
    Claire/Anastasia chains disagree on the base; `altFormsAllowed` is validated
    but never enforced; `Blazing Prism` cannot join `Light Shade`
    (`data/form-groups.json`, `data/form-rules.json`).

19. **Content is strong but thin after the core arc.** S1–S4 each have 6 canon
    beats and named threats; post-victory arcs reuse the same four beats; there
    is no downtime/civilian-life loop; S5 is a stub; `Others/NeoHorizon` cards
    are silently excluded (`data/seasons/*.json`, `tools/build-data.mjs`).

## Proposals

### A. Session flow: make the chat the home, not the modal

1. **Session Home** replaces the Season grid whenever a world exists. It shows
   season/act/time/location/player/threat/present cast, a one-paragraph
   "previously on", and four primary actions: Continue, Map, Cast, Journal. A
   secondary "New timeline" action opens the season grid and explains the
   replace/create choice.
2. **Last-surface memory.** Store the last tab per chat
   (`chatMetadata.neoterra.ui.lastTab`) and restore it on open; default to
   Session Home, not Season.
3. **Direct map.** A HUD Map button and `/neoterra map` open the map without
   touching the Season flow. With no world, the map shows a single "Start a
   season" CTA that switches to the Story wizard. The sidebar becomes
   status-first: threat clock, district-control overlay colored by faction
   influence, and a portrait row for present cast.
4. **Travel loop.** Add both close-on-travel and keep-open modes, show the
   arrival in the map sidebar and the chat, and add a prominent "Return to
   chat" button. Spike B measures which default works after the HUD/scene-card
   changes; the current close-on-travel default stays until that evidence is
   reviewed.
5. **New timeline, not replace-by-default.** "New timeline" creates a new chat
   automatically with the Director card when available, otherwise the current
   card or an empty chat. "Replace this chat's world" remains an advanced,
   explicit fallback only when chat creation fails.

### B. Character experience: faces, filters, and guests

6. **Avatar manifest + resolver + sync.** Generate
   `data/characters/avatars.json` from PNG cards (embedded `chara` data or
   filename/alias matching). At runtime, prefer the manifest, then the user's
   installed ST character avatar by exact/alias match, then initials. Add a
   **Sync portraits** action in Settings that re-scans `ctx.characters`, writes
   a per-user override map to extension settings/localStorage, and refreshes the
   UI; it never writes the repository. Offer **Download manifest** for merging
   into `data/characters/avatars.json`. Use avatars in the season picker, Codex
   list/detail, Player sheet, map present-cast, scene cards, and relationship
   nodes.
7. **PNG card ingestion (optional).** Teach `build-data` to read `.png` cards,
   extract the embedded card JSON, pair a JSON twin with the PNG art, and emit
   `avatarPath`. This makes the PNGs the single source of character art without
   requiring a separate manifest.
8. **Portrait-first Character Picker.** A reusable grid with search, season
   filter, side/form filters, keyboard navigation, and a "Canon roster" /
   "Other seasons" split. It replaces the identity radio list and the Codex
   Play-as dialog. The season list's raw-ID "Character-first" filter is replaced
   by this picker.
9. **Guest Character Contract.** Allow any registry character in any playable
   season. The warning is mandatory and visible: home season, era mismatch,
   canon-beat adaptation, and a "non-canon guest" badge; the user must check an
   explicit acknowledgment before starting. Record the accepted warning in
   `flags.guestCharacter`; render a prompt block; let the Storyline tracker mark
   dependent beats `adapted` rather than failing the world. Sandbox behavior is
   unchanged.
10. **Form lineage in the picker.** Show base and alternate forms as one card
    with a form selector, so the user chooses "Vaiva" once and then picks the
    active form, instead of scrolling separate registry rows.
11. **Card Architect (investigate first).** A variant of the Form Architect can
    generate a complete non-canon character card from a short concept, copying
    the section style of the existing cards. Because reliability is the hard
    part, this starts with Spike A (schema, grounding, eval rubric, samples)
    before production code. Only if the spike is green, implement it as a
    separate reviewed step with draft → critique → schema validation → Auditor
    consistency check → human approval; store generated cards in chat metadata,
    mark them `generated`, use a user-supplied portrait, and offer export to
    JSON. If the spike is red, stop at missing-form generation; if amber,
    require an explicit override before production work.

### C. Forms 2.0: profiles that actually change

12. **Form profile overlay.** At season seed, store each cast member's group
    profiles in `character.formProfiles`. On `TRANSFORM`, apply the target
    form's appearance/attire/abilities/traits/likes/dislikes/notes, preserve
    live combat/status/relationship/manual edits, and track
    `profileFormId`/`profileSource`. Reverting restores the base overlay. Codex
    card text and avatar follow the active form.
13. **Form Architect agent.** When a transform targets a form with no card (or
    a guest character reaches a form that does not exist), a new
    `formArchitect` agent auto-generates a validated form profile from the base
    card, the form rule, the season's threats/factions, other cast cards, the
    same form group, and the recent scene. Store it under
    `flags.generatedForms`, render it with a visible "Generated form" badge, and
    offer Edit / Regenerate / Approve plus an **Export generated forms** button.
    On failure, keep the base profile and add a transformation note rather than
    blocking play.
14. **Form data completion.** Fill missing groups/rules, allow cross-season
    groups, normalize S4 chains, enforce `altFormsAllowed`, and add a build
    check that fails on ungrouped alt cards or unreachable rules.

### D. UI system: invasive, but coherent

15. **Persistent HUD (gameplay only).** A collapsible right rail shows
    season/time/act, location, player meters, current threat, present-cast
    avatars, and gameplay actions (Map, Cast, Player, Journal, Newspaper).
    Settings, export/import, agent configuration, and diagnostics stay in the
    Extensions drawer/menus, not the HUD. It is visible only when a world exists
    and updates on `MAP_UPDATED`/turn completion.
16. **Floating window manager (gameplay surfaces).** Move Map, Codex,
    Relations, and Journal out of the modal into draggable/resizable windows
    over the chat. Persist geometry, stack/focus windows, add minimize/close,
    and use full-screen sheets on mobile. The shell becomes a small
    launcher/Session Home; configuration surfaces stay in menus.
17. **Scene cards.** Add structured metadata to scene frames (`location`,
    `time`, `pov`, `present`) and decorate the rendered message with a header,
    portrait strip, and badges. Do not rewrite message text; decorate the DOM
    after render and on chat reload.
18. **Turn progress + toasts.** Emit stage events from the turn pipeline and
    show a compact "Director is updating" chip with stage labels. Batch state
    deltas into toasts (stamina, corruption, new rumor, cast arrival, form
    change, newspaper) and surface agent errors with a "details" link.
19. **Journal/Recap.** A Journal window with "Previously on", a chronological
    event timeline, beats, travel, encounters, relationship changes, and
    discovered locations. The Lore agent writes the recap; a deterministic
    fallback always works.
20. **First-run wizard + command palette.** A three-step wizard (season →
    character → confirm) with visual cards and recommended presets.
    `/neoterra` opens a gameplay command palette (Travel, Cast, Player, Journal,
    Rest, Patrol, Newspaper, New timeline) for keyboard-first play.
    Settings/export/import remain in menus.

### E. Living world: wire what is already built

21. **Cast Director** on travel/arrival and on a configurable scene cadence,
    with arrival/departure toasts. **Lore** every 10 turns or on act change,
    feeding the Journal. **Auditor** at act boundaries, showing a non-blocking
    continuity badge. **Bad End** flow mounted when enabled. **Agent log** in a
    debug drawer with latency/tokens/errors. **Architect** optional at season
    start.
22. **Content depth pilot + ending pilot.** Add 2 side beats per season, 3
    downtime events, and 1 civilian-life event per act; differentiate
    S1/S1Dark post-victory arcs first; add a content validator. Add an
    S1/S1Dark **ending pilot**: deterministic post-victory beats and a
    season-specific epilogue template. Keep dynamic Epilogue-agent generation
    behind an `ending.dynamic` review flag, or defer it to a separately reviewed
    step. Defer S5/NeoHorizon.

## Approved decisions

Approved 2026-11-18; see the plan's *Decisions* section for the full list.
In summary: build all milestones; gameplay uses a persistent HUD plus floating
windows while configuration stays in menus; avatars use both a generated
manifest and runtime resolution with **Sync portraits**; cross-season guests
are warned and acknowledged; dynamic forms auto-generate with an export path;
the character creator is gated behind Spike A; a new timeline creates a new
chat; travel close behavior is measured by Spike B; the S1/S1Dark ending pilot
is reviewed by the user before merge; desktop-first with mobile verified;
temporary `NT-Audit` chats/characters are allowed for QA and cleaned up.

## Priority order

1. **P0 flow and truth-telling:** Director status, Player mount, Session Home,
   Map empty state, styled Season/Identity.
2. **Character experience:** avatars, guest characters, portrait picker, form
   profiles, Form Architect.
3. **Invasive UI:** HUD, floating windows, scene cards, progress/toasts,
   journal, wizard/palette.
4. **Living world:** cast/lore/auditor/bad-end wiring, content depth, ending
   pilot, regression and release QA.

## Verification

Reproduce findings with `npm run check` and the manual checklist in the plan.
Unit tests for the fixes land with the fixes; the docs in this change are
behavior-neutral. Falsifiable claims in this report should be re-checked
against the live instance before the corresponding fix is called done.
