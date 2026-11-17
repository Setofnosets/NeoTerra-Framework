# Fix: season start fails, shell tabs do nothing, map too small

**Status:** implemented and committed
**Date:** 2026-11-17
**Commit:** 7ff94ad — `feat(ui): resolve live chat context, fix tab panels, enlarge map, ship Director card`
**Scope:** diagnosis + remediation plan for three reported UI/flow defects in the
SillyTavern extension.

---

## Intake summary (reported symptoms)

1. Starting any season fails with **“enterSeason requires an active chat”**, every
   time, even when a chat is loaded.
2. The **tabs on the season screen do nothing**: clicking Map / Characters / Player /
   Settings does not replace the Season view.
3. The **map works to a degree** but is much smaller than it should be.

All three are reproducible from the code paths below. They are independent bugs
with a shared ingredient: the UI captured a SillyTavern context snapshot at page
load and never refreshes it, and CSS overrides the `hidden` attribute.

---

## Diagnosis

### A. `enterSeason requires an active chat`

**Error site:** `src/flows/season-start.js:760-764`

```js
const requestedChatId = typeof options.chatId === 'string' ? options.chatId : null;
const initialChatId = requestedChatId ?? ctx?.chatId ?? null;
if (typeof initialChatId !== 'string' || initialChatId.length === 0) {
    throw new SeasonStartError('INVALID_CHAT', 'enterSeason requires an active chat');
}
```

**Root cause: a stale SillyTavern context snapshot.**

- `shell.initialize()` caches the context once: `ctx = options.ctx ?? getContext()`
  (`src/ui/shell.js:1012`). `getContext()` returns the cached `ctx` forever
  (`shell.js:85-90`); only `refreshContext()` (`shell.js:93-100`) re-reads
  `SillyTavern.getContext()`.
- `initialize()` then calls `void mountSeasonPanel(ctx)` (`shell.js:1023`), and
  `mountSeasonPanel` passes that exact snapshot into
  `mountSeasonMenu({ root, ctx: context })` (`shell.js:216-231`).
- `mountSeasonMenu` stores it as `state.ctx` once (`src/ui/season-menu.js:216`), and
  `beginSeason` uses that frozen object when it calls `enterSeason`
  (`season-menu.js:310-317`).
- Nothing remounts or refreshes the season menu on `chat_changed`
  (`shell.js:1072-1104`), so the snapshot survives the whole page session.

Two facts make the snapshot wrong in normal use:

1. **`ctx.chatId` is a computed value, not a live getter.** In SillyTavern,
   `getContext()` builds a fresh object and sets
   `chatId: characters[this_chid]?.chat` (verified against the upstream
   `public/scripts/st-context.js`). At extension-enable time the chat has not
   loaded yet, so `characters[this_chid].chat` is empty/undefined. The cached `ctx`
   keeps that empty value even after the user opens a chat.
2. **`ctx.chatMetadata` is also a snapshot reference.** Upstream reassigns
   `chat_metadata = chatHeader?.chat_metadata ?? {}` when a chat loads
   (`public/script.js:7657`). A cached `ctx.chatMetadata` therefore points at the
   previous (empty) metadata object, not the live one. Even if the chat id were
   fixed, the seeded world could be written into a detached object and silently
   lost on the next save.

The canonical upstream chat-id accessor is `ctx.getCurrentChatId()` (exported by
ST and included on the context object), which handles group chats
(`groups[...].chat_id`) and character chats. The codebase currently never calls it
(`grep` shows zero usages).

**Why the error is the visible symptom:** the first guard fails before any data
load, so the user never reaches the metadata write. If only `chatId` were patched,
the stale-`chatMetadata` half of the bug would surface as “season starts, then the
world is gone after reload”.

### B. Shell tabs do nothing

**Root cause: an author CSS rule defeats the `hidden` attribute.**

- Tab switching is implemented by setting `panel.hidden = ...`
  (`src/ui/shell.js:786-788`).
- `style.css:54-56` correctly special-cases the root, but the live-panel rule at
  `style.css:261-266` is:

```css
.neoterra-panel.is-live { display: flex; ... }
```

Author styles beat the UA `[hidden] { display: none }` rule, and the rule has no
`[hidden]` guard. The three live panels (`season`, `map`, `characters` —
`shell.js:69`) therefore render simultaneously, stacked inside
`.neoterra-tabpanels`. `setActiveTab` flips `hidden`, but nothing visible changes
for those panels. Player/Settings are non-live and do toggle — they just appear
below the always-visible stack, often off-screen.

This also explains “map works to a degree”: selecting Map mounts Leaflet
(`shell.js:789-792`) but the map is appended underneath the season panel content,
so the user must scroll and the map is constrained by the map host.

### C. Map could be bigger

**Root cause: the map is double-boxed inside a small modal, and its host has no
definite height.**

- The shell is capped at `width: min(960px, 92vw)` / `max-height: 86vh`
  (`style.css:65-77`).
- The map's default geometry is `1080 × 700`
  (`src/ui/map-panel.js:61-63`), but `clampPanelGeometry` clamps it to the host
  (`map-panel.js:92-113,552-565`). The host is the tab panel minus 1.5rem padding,
  so the map is forced to roughly ~888px wide.
- `.neoterra-tabpanels` is not a flex column (`style.css:153-157`) and the live
  panel does not stretch to the shell height. `.neoterra-map-host` has
  `flex: 1 1 auto; min-height: 420px` (`style.css:268-272`), but inside an
  auto-height panel that flex basis collapses to the 420px minimum. The map is
  therefore also clamped to roughly 420px tall (or overflows the panel and
  scrolls).

Leaflet already gets an `invalidateSize()` nudge on the `TAB_CHANGED` event
(`map-panel.js:1246-1248`), so the sizing fix is layout-only.

**Related observation (not a root cause):** the Player tab is still a placeholder.
`LIVE_PANELS` excludes `player` (`shell.js:69`) and `mountPlayerPanel` is never
imported by the shell, even though `src/ui/player-panel.js` exports it. If the
user expects a player sheet, that tab will look “dead” even after the CSS fix.

### D. What starting a season does to the open chat (and what “host card” means)

Raised in review; verified against the flow.

**The open chat becomes the season's host chat. Messages are not touched.**

- `startSeason` only writes through the `WorldState` store
  (`src/flows/season-start.js:565-674`), which persists under
  `chatMetadata.neoterra`. It never edits `chat`, never removes messages, and
  never clears metadata keys it does not own (`applySeasonChatMetadata` merges,
  `season-start.js:523-542`).
- If that chat already has a Neo Terra world, the flow throws `EXISTING_WORLD`
  and the menu shows the replace confirmation (`season-start.js:599-605`,
  `season-menu.js:327-330`). Replacing overwrites the world state only. The old
  generated world book is **not** removed on replace — only `resetChatWorld`
  removes it (`shell.js:896-966`) — so replaces can orphan books.
- `buildOpeningScene` is computed and returned (`season-start.js:639,668`) but
  **nothing inserts it into the transcript**. Starting a season sends no greeting
  and does not move the current scene to the season opening. A mid-story chat
  keeps its history while the world state starts at the season's opening
  location, which is an intentional “retrofit” only if the user accepts the
  mismatch. A fresh chat is the clean path.
- The generated world book is not materialized by the UI path: `enterSeason`
  only calls `worldBookAdapter.ensure` when an adapter is supplied
  (`season-start.js:831-865`), and `mountSeasonMenu` never supplies one. So the
  metadata records `worldBook.status = 'pending'` until something else links it.
  Out of scope for these three bugs, but worth knowing before promising
  “world book created”.
- **Narrator selection is currently a silent no-op.** `selectNarratorCard`
  (`season-start.js:689-727`) passes `character.avatar` (a filename such as
  `director.png`) to `ctx.selectCharacterById`. SillyTavern's
  `selectCharacterById(id)` indexes `characters[id]` (array index / character id),
  so a filename resolves to `undefined` and the function returns immediately.
  The result is still reported as `status: 'selected'`. No character switch
  happens today.
- **This no-op is load-bearing.** If it were “fixed” naively to pass the real
  character index, upstream `selectCharacterById` would call
  `clearChat({ clearData: true })`, reassign `chat_metadata = {}`, and load that
  character's last chat (`script.js:875-909`). That would discard the just-seeded
  world metadata and move the user to a different chat. Narrator/host card
  selection must therefore happen **before** seeding, or be dropped entirely —
  never after the flow writes state.

**Does the host have to be a particular character? No.**

- Season start validates the *player identity* against the season roster
  (`resolveIdentitySelection`, `season-start.js:413-477`), not the host card.
- The host can be any character chat or a group chat; the world is keyed by
  `chatId` and stored in that chat's metadata.
- However, generation uses the selected character's card. Director mode is
  designed around `DIRECTOR_CARD_NAME` (`season-start.js:42`); solo mode is
  designed around the canon player's card (`season-start.js:689-696`). If the
  Director card is absent the flow reports `status: 'missing'` and never
  fabricates a card (`season-start.js:698-705`).
- **Net effect: an unrelated host “works”, but the injected Neo Terra context fights
  that card's persona instead of the Director's neutral framing.**
- **There is no Director card in the repository or in a default install.**
  `DIRECTOR_CARD_NAME` is only a convention; the `Chars/` tree has no such card and
  `data/characters/index.json` has no such entry. The user would currently have to
  author and import one by hand to get the intended neutral narrator voice. This
  must not block season start: the flow already works with the open chat's
  character. The plan therefore (a) makes the card explicitly optional and (b)
  ships a bundled Director card with a clear download/import entry point (Step 6).
  Installation is download-only by decision: the extension does not call
  `/api/characters/import` or any other write endpoint.

**Starting from the character-select screen (no chat open).**

SillyTavern has no `chat_metadata` and no `getCurrentChatId()` result until a
character/group has a chat, so the flow cannot seed a world there. Three viable
designs:

- **A. Keep requiring a chat (recommended for this fix).** The user picks a
  character, creates/opens a chat, then starts a season. Only the error message
  and context resolution change.
- **B. Auto-host flow (follow-up).** From character select, ask the user to
  choose a host (Director card if installed, else the currently selected
  character), then programmatically create a chat and only afterwards resolve
  `chatId`/`chatMetadata` and seed. The public context exposes
  `executeSlashCommandsWithOptions` (can run `/newchat`) but not `doNewChat`;
  the extension would have to wait for `chat_changed`/`CHAT_LOADED` and tolerate
  version differences. Fragile, needs its own design.
- **C. Placeholder card.** A placeholder does not remove the need for a chat: ST
  chats belong to a character or group. It only makes the host deterministic. The
  framework already assumes a real “Neo Terra — Director” card; shipping or
  generating one is a content/packaging task, not a shortcut around B.

---

## Approach

- Fix context freshness once, with a small reusable resolver, and use it at the
  moment of action (not at mount time). Do not change the shell's long-lived
  `ctx` because it backs event subscriptions.
- Make the tab-panel visibility rule explicit and test it via source inspection
  (the test suite has no DOM).
- Make the shell/tabpanels flex chain fill the modal and grant the Map tab a
  larger shell; keep the map's own drag/resize behavior and persisted geometry.
- Keep the Director card optional for the bug fix (season start must work with any
  host), and ship a bundled card with a download-based setup entry point so users
  can install it through ST's normal import UI. No server endpoint is used.

Non-goals: redesigning the shell, adding a player sheet, changing season content,
or reconciling the version drift (`EXTENSION_VERSION` `0.1.0` vs package `1.0.0`).

---

## Steps

### Step 1 — Add a live SillyTavern context resolver

- **Status:** ✅ complete (7ff94ad)

- **Files:** `src/core/live-context.js` (new), `tests/live-context.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes (independent of Steps 3–5)
- **Expected behavior:**
  - `readLiveContext(fallback = null)` calls `globalThis.SillyTavern?.getContext?.()`
    inside a try/catch and returns the fresh object (or `fallback`).
  - `resolveActiveChatId(ctx)` returns a trimmed non-empty chat id using this
    precedence:
    1. `ctx.getCurrentChatId?.()` (canonical upstream accessor; handles groups)
    2. `ctx.chatId`
    3. `ctx.chatMetadata?.chat_id`
    4. `null`
    A present `getCurrentChatId()` is authoritative: if it reports no chat, do
    **not** fall back to a stale snapshot. The fallbacks apply only when the
    accessor is unavailable or throws.
  - Never throws when the context or individual accessors are missing/throwing;
    normalize non-strings to `null`.
  - Keep the module dependency-free apart from the logger, so neither
    `season-menu.js` nor `settings.js` create an import cycle through `shell.js`.
- **Acceptance criteria:**
  - Unit tests cover: no ST global; `getCurrentChatId` wins over a stale
    `chatId`; `chatId` fallback; `chatMetadata.chat_id` fallback; `getCurrentChatId`
    throwing; whitespace/empty string handling; group-chat style id passthrough.
  - `node --test tests/live-context.test.js` passes with no DOM.
- **Risk:** low
- **Model/Effort routing:** standard implementer, low effort
- **Commit message sketch:** `feat(ui): add a live SillyTavern context resolver`

### Step 2 — Resolve the live context when a season actually starts

- **Status:** ✅ complete (7ff94ad)

- **Files:** `src/ui/season-menu.js`, `src/flows/season-start.js`,
  `src/ui/shell.js`, `tests/season-start.test.js`
- **Depends on:** Step 1
- **Parallelizable:** no (touches the season flow)
- **Expected behavior:**
  - `mountSeasonMenu` accepts a `getContext` callback (default: resolve
    `globalThis.SillyTavern.getContext()` on demand). Stop treating the ctx passed
    at mount as authoritative; use it only as a fallback snapshot.
  - `beginSeason` re-reads the live context immediately before calling `start`,
    passes that fresh object to `enterSeason`, and passes an explicit
    `chatId: resolveActiveChatId(liveCtx)` so the flow does not have to guess.
  - `shell.mountSeasonPanel` passes `getContext: refreshContext` (or stops passing
    a snapshot) instead of `ctx: context`.
  - `enterSeason` resolves the chat id through `resolveActiveChatId(ctx)` in both
    the initial guard and the post-load race check; keeps the existing
    `CHAT_CHANGED` guard semantics.
  - The `INVALID_CHAT` message becomes actionable: e.g. “Open a character or group
    chat before starting a season.” Error code stays `INVALID_CHAT` so callers and
    tests remain stable.
  - Metadata is read from the same fresh context as the chat id (no mixing a live
    id with a stale metadata object).
  - Do **not** change the host character as part of this step. Leave
    `selectNarratorCard` reporting status only (its currently-passed id is a
    filename and is a silent no-op upstream); switch cards, if ever wanted, must
    happen before seeding or not at all (see Diagnosis D).
  - Make the Director card explicitly **optional**: season start succeeds with
    any host, and director mode shows a non-blocking hint (“Director card not
    installed — the current character will narrate; install it in Settings”) when
    the card is absent. Do not turn a missing card into an error.
- **Acceptance criteria:**
  - New test: `enterSeason({ ctx: { getCurrentChatId: () => 'chat-a', chatMetadata:
    meta } , ... })` with **no** `ctx.chatId` seeds `worldState.chatId === 'chat-a'`
    and writes into `meta`.
  - New test: stale-looking `ctx.chatId === ''` but working `getCurrentChatId()`
    still succeeds.
  - Existing test `enterSeason refuses to seed when the chat changed during
    loading` still passes (chat-change guard intact).
  - New test: no chat id at all throws `SeasonStartError` with `code ===
    'INVALID_CHAT'` and a message mentioning opening a chat.
  - Manual: enable the extension on a fresh page, open a chat, then start a season
    — it succeeds; start with no chat open — the error is clear and does not
    mention `enterSeason`.
  - Manual: start a season, reload the page, verify
    `chatMetadata.neoterra.worldState.chatId` is still present and the map/codex
    load it.
- **Risk:** medium (wrong fallback order can bind a world to the previous chat).
  The explicit `chatId` passed from the menu plus the `CHAT_CHANGED` guard are the
  safety rails.
- **Model/Effort routing:** standard implementer, high effort; if chat-affinity
  tests fail, escalate to `implement-hard`
- **Commit message sketch:** `fix(season): resolve the live chat before entering a season`

### Step 3 — Apply the same freshness fix to the Settings world panel (related)

- **Status:** ✅ complete (7ff94ad)

- **Files:** `src/ui/settings.js`, `tests/settings.test.js`
- **Depends on:** Step 1
- **Parallelizable:** yes (different files from Step 2, after Step 1)
- **Expected behavior:**
  - World export, world import, and `ensureCharacterLimits` resolve a fresh
    context at action time instead of using the `mountedCtx` snapshot.
  - `mountedCtx` may remain for static settings reads, but any path that touches
    `chatMetadata`/`chatId` must use the live context (or the resolver).
  - Export filename and imported `chatId` use `resolveActiveChatId`.
- **Acceptance criteria:**
  - Tests prove export/import helpers use the supplied live context, not a stale
    one (pure helpers can stay testable).
  - Manual: export a world after a chat switch, confirm the bundle comes from the
    current chat; import a bundle and confirm it lands in the current chat metadata.
- **Risk:** low–medium (import writes state; keep the existing confirm dialog and
  validation)
- **Model/Effort routing:** standard implementer, medium effort
- **Commit message sketch:** `fix(settings): use the live chat context for world import/export`
- **Note:** this step may be deferred; it is the same class of bug and will bite
  users next.

### Step 4 — Make inactive tab panels actually hidden

- **Status:** ✅ complete (7ff94ad)

- **Files:** `style.css`, `tests/ui-css.test.js` (new)
- **Depends on:** none
- **Parallelizable:** yes with Steps 1–3; **not** with Step 5 (both edit
  `style.css`)
- **Expected behavior:**
  - Add an author rule that wins over `.neoterra-panel.is-live`, e.g.
    `.neoterra-panel[hidden] { display: none !important; }`, or guard the live rule
    with `:not([hidden])` and add a base hidden rule. Prefer the minimal,
    explicit rule.
  - Leave `.neoterra-panel.is-live` layout (`flex`, gap, `min-height: 0`) intact
    for the visible state.
  - No JS change: `setActiveTab` already toggles `hidden`.
- **Acceptance criteria:**
  - Source-level regression test asserts the stylesheet hides `.neoterra-panel`
    when `[hidden]` is set and that the live-panel `display: flex` does not apply
    to hidden panels (parse the rule text, not a browser).
  - Manual: opening the shell shows only the Season panel; each of the five tab
    buttons shows exactly one panel; arrow keys move between tabs; Map mounts only
    when selected (or stays mounted but hidden — either is fine as long as only one
    panel is visible).
- **Risk:** low
- **Model/Effort routing:** standard implementer, low effort
- **Commit message sketch:** `fix(ui): actually hide inactive shell tab panels`

### Step 5 — Give the Map tab a larger, full-height canvas

- **Status:** ✅ complete (7ff94ad)

- **Files:** `style.css`, `src/ui/shell.js`, `tests/map-model.test.js`
- **Depends on:** Step 4 (same stylesheet)
- **Parallelizable:** no (style.css conflict with Step 4)
- **Expected behavior:**
  - Expose the active tab to CSS: `setActiveTab` sets
    `root.dataset.activeTab = tabId` (and the markup can initialize it), so the
    shell can be sized per tab without JS measuring.
  - Make the flex chain real: `.neoterra-tabpanels` becomes a flex column with
    `min-height: 0`; `.neoterra-panel` fills the remaining space; the active map
    panel gets `min-height: 0` so `.neoterra-map-host` receives a definite height
    instead of collapsing to `min-height: 420px`.
  - Enlarge the shell when the map is active (e.g.
    `.neoterra-root[data-active-tab="map"] .neoterra-shell { width: min(1360px, 96vw);
    max-height: 92vh; }`). Keep the existing 960px shell for the other tabs unless
    the reviewer wants it wider globally.
  - Reduce or remove the tab-panel padding for the map tab if needed so the map
    host can use the full width.
  - Keep `DEFAULT_GEOMETRY = 1080 × 700` and the drag/resize handlers; after the
    shell grows, `clampPanelGeometry` will stop shrinking the stored/default map.
  - Do not break small-viewport clamping: `clampPanelGeometry` must still respect
    `viewportSize()` and the existing 1080p/1440p tests.
- **Acceptance criteria:**
  - Manual on 1920×1080: Map tab alone is visibly larger than the current
    ~888×420; the default map is at/near 1080×700; the map canvas fills its host;
    Leaflet tiles are correctly sized after switching tabs; drag and resize still
    work; reopening the panel restores the stored geometry.
  - Manual on a narrow window (e.g. 900×700): map stays inside the shell, no
    horizontal page overflow, resize handle reachable.
  - Existing `panel geometry is clamped, persisted, and restored` and `panel
    geometry fits 1080p and 1440p viewports` tests still pass.
  - Source-level CSS test covers the new flex/`data-active-tab` selectors.
- **Risk:** medium (layout regressions across tabs/viewports)
- **Model/Effort routing:** standard implementer, medium effort; visual review
  required
- **Commit message sketch:** `feat(map): let the map tab use a larger, full-height shell`

### Step 6 — Ship the Director/narrator character card with a clear, download-only setup entry point

- **Status:** ✅ complete (7ff94ad)

- **Files:** `assets/neoterra-director.json` (new), `src/ui/settings.js`,
  `settings.html`, `src/ui/season-menu.js`, `src/flows/season-start.js` (status
  helper only), `tests/director-card.test.js` (new), `docs/adding-a-season.md`
- **Depends on:** Step 2 (optional-card semantics). Can be built in parallel with
  Steps 3–5 but should land before release so users see the entry point.
- **Parallelizable:** yes (different files), except shared edits to
  `season-menu.js`/`settings.js` with Steps 2–3 — sequence after Step 2.
- **Expected behavior:**
  - Bundle a V2 character card (`spec: 'chara_card_v2'`, `spec_version: '2.0'`,
    `data` object) named exactly `Neo Terra — Director` at
    `assets/neoterra-director.json`. This file is the single source of truth for
    the card (no duplicated builder in JS; tests read the asset directly). Do
    **not** put it in `Chars/`, or `build-data` adds it to the playable registry
    and Sandbox identity list. The content is specified below.
  - **No server endpoint.** Install is a download + normal ST import:
    1. Extension fetches the bundled JSON and calls the existing `downloadJson`
       helper (`settings.js:550-563`) with the filename
       `Neo Terra — Director.json`.
    2. A short instruction block tells the user: ST → **Characters → Import
       character → select the downloaded file**.
    3. Re-clicking download is always safe (no duplicate characters are created by
       the extension because it never writes to ST's library).
  - **Clear entry point** on the Season tab (above the season grid): a compact
    setup strip that shows:
    - **Host chat:** the current chat/character name, or “No chat open — open a
      chat first”.
    - **Narrator source:** `Director card — installed` / `Director card — not
      installed` + [Download card] + short import steps; in solo mode:
      `Canon card — <name>`.
    - **Mode:** the active `castMode` (director/group/solo) with a link/button to
      the Settings panel. Do not duplicate the mode control here unless the
      reviewer wants it.
    - The same download action and status appear in a “Narrator” section of the
      Settings panel so it is discoverable outside the Season tab.
  - Detection is read-only: use `findStCharacter(ctx, DIRECTOR_CARD_NAME)`
    (rename/export a small status helper) and never attempt a silent card switch.
  - Keep both modes:
    - `director`/`group`: if the card is installed, the user selects it and starts
      a chat before entering the season; if not, the current host narrates and the
      strip says so.
    - `solo`: uses the canon player's card as host; the Director card is not
      required and the strip reflects that.
  - Document the manual steps (select Director → New Chat → start season). Auto-
    creating the chat (design B) stays out of scope.

**Director card content** (author this into `assets/neoterra-director.json`; review
the prose before release):

```json
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "Neo Terra — Director",
    "description": "A neutral narrator for the Neo Terra framework. This card is not a character inside the fiction: it is the voice that describes the city, its factions, and every non-player character. It presents the world's reactions and consequences, voices NPCs in their own words, and leaves every decision to the player. It never decides the player character's actions, dialogue, thoughts, or feelings.",
    "personality": "Observant, cinematic, impartial. No personal goals, no body in-world, no fourth-wall breaks, no meta-commentary about being an AI or a card.",
    "scenario": "Neo Terra: a neon-drenched cyberpunk superhero city of metahumans, corrupt institutions, and faction warfare. Seasons vary in era and tone; the active season's premise, POV, and content notice are supplied in the injected Neo Terra context.",
    "first_mes": "",
    "mes_example": "",
    "system_prompt": "You are the Neo Terra Director. Narrate the world, its factions, and all non-player characters. You are not a person in the story: you have no body, no in-world name, and no agenda beyond presenting the consequences of {{user}}'s choices. Address {{user}} in second person when the scene follows the player character, or in third person when it follows other characters; keep the season's POV consistent. Never decide {{user}}'s actions, dialogue, thoughts, feelings, or defeats. Voice NPCs according to their supplied profiles and current form; do not give a character an ability, form, faction, location, or item that is not in the supplied Neo Terra context. Treat any injected [NEOTERRA_*] block or world-state summary as canon and prefer it over your own assumptions. Do not print stat blocks, JSON, dice math, or rules text; translate outcomes into prose. Match the active season's tone and content notice. End each turn on a situation {{user}} can respond to.",
    "post_history_instructions": "Reminder: you are the Narrator/Director, not the player and not any single NPC. Describe the world and the NPCs; let {{user}} choose their own words and actions. Keep canon facts from the injected Neo Terra blocks. Do not resolve {{user}}'s next move for them.",
    "creator_notes": "Bundled narrator card for the Neo Terra framework. Import via Characters → Import character, then start a new chat. Solo mode uses the played canon character's card instead.",
    "alternate_greetings": [],
    "tags": ["neo terra", "narrator", "framework"],
    "creator": "Neo Terra Framework",
    "character_version": "1.0.0",
    "extensions": {
      "neoterra": { "role": "director" }
    }
  }
}
```

Content guardrails to preserve when editing:
- `data.name` must remain exactly `Neo Terra — Director` (em dash) to match
  `DIRECTOR_CARD_NAME`.
- `first_mes` is intentionally empty so the card does not compete with the season
  opening frame. If a target ST version rejects an empty greeting, use one neutral
  line and document the deviation.
- Do **not** include the agent JSON contracts from `src/agents/prompts.js` here;
  this card writes prose, not JSON.
- Do not set `world` or add alternate greetings; the chat-scoped world book is
  linked by the extension.
- `extensions.neoterra.role` is a marker only. Detection still matches by name,
  because ST's character list does not reliably expose full card data.
- **Acceptance criteria:**
  - `tests/director-card.test.js` reads `assets/neoterra-director.json` from disk
    and asserts: valid JSON, `data.name === DIRECTOR_CARD_NAME`, non-empty
    `description`/`system_prompt`, empty `first_mes`/`mes_example`, and no
    `world`/alternate greetings.
  - Download produces a valid `.json` file; importing it through ST's UI makes the
    Season strip show `installed` after the character list refreshes/reload.
  - Season start still works with no Director card installed (no regression).
  - The card does not appear in season identity lists, the codex, or Sandbox
    playable options (it lives outside `Chars/` and the generated registry).
  - Manual: download → import → select card → New Chat → start a season; narrator
    status is `available` and the world persists. Then switch `castMode` to `solo`,
    start another season on the canon card, and confirm the strip and flow both
    work.
- **Risk:** low–medium (content authoring + a download path; no server writes)
- **Model/Effort routing:** standard implementer, medium effort; content review for
  the card persona
- **Commit message sketch:** `feat(season): ship the Director card and a download-based setup entry point`

---

## Verification & Testing

### Automated

Run from the repository root:

```bash
node --test tests/live-context.test.js
node --test tests/season-start.test.js
node --test tests/settings.test.js
node --test tests/director-card.test.js
node --test tests/map-model.test.js
node --test tests/ui-css.test.js
npm test
npm run check
```

`npm run check` covers the generated-data/map drift checks, syntax checks, the
full `node --test tests/*.test.js` suite, and the smoke test. Do not hand-edit
generated files to make it pass.

### Manual checks

1. **Cold start, no chat:** load SillyTavern with the extension enabled and no
   character chat open → Neo Terra → Season. Attempting to begin shows an
   actionable “open a chat first” message (not an exception trace).
2. **Cold start, then chat:** with the extension already enabled, open a character
   chat (or group chat), then start a season. It succeeds; the world renders in
   the Season/Map/Characters tabs. Reload and confirm persistence.
3. **Group chat:** repeat (2) in a group chat; `chatId` should be the group's
   `chat_id`.
4. **Chat switch mid-flow:** open the identity step, switch chats, then confirm.
   The `CHAT_CHANGED` guard must fire and no state may land in either chat's
   metadata.
5. **Tabs:** click Season / Map / Characters / Player / Settings in turn; exactly
   one panel is visible. Arrow-key navigation matches. The Map mounts on first
   selection and is not duplicated on re-selection.
6. **Map size:** on 1920×1080 the Map tab is substantially larger than before;
   drag, resize, and reopen; reload and confirm geometry is restored and clamped.
7. **Small viewport:** narrow the window and repeat the map checks; nothing
   overflows the modal or becomes unreachable.
8. **Settings:** after a chat switch, export the world and confirm the bundle
   reflects the current chat; import and confirm it writes to the current chat.
9. **Existing chat with history:** start a season in a chat that already has
   messages. Confirm the transcript is unchanged, no greeting is posted, and the
   world state is seeded for that chat. Re-enter a season → replace confirmation,
   and confirm replacing does not edit messages.
10. **No Director card:** with no `Neo Terra — Director` card installed, start a
    season from an ordinary character chat. It must succeed; the UI shows a
    non-blocking hint rather than an error.
11. **Director card install:** use the download action, import the file through
    ST's Characters → Import UI, and confirm the Season setup strip flips to
    `installed` after the character list refreshes/reload. Confirm the card is not
    offered as a season identity or Sandbox option. Then select it, start a new
    chat, and confirm narrator status is `available`. Re-clicking download must not
    create duplicates.
12. **Both modes:** switch `castMode` to `solo` and start a season on the canon
    player's card; then switch back to `director` with the Director card installed.
    The setup strip should name the narrator source in each case and both flows
    should persist the world.

### Edge cases

- No character selected vs. character selected but no chat created.
- Empty/new chat vs. existing chat with history.
- Sandbox season, S5 disabled entry, and replace-world confirmation still behave.
- `SillyTavern.getContext()` missing or throwing (unit-test only).
- Stored map geometry from an older, smaller shell must re-clamp, not overflow.
- Browser zoom / device-pixel-ratio does not break Leaflet sizing.

---

## Assumptions & Open Questions (for human approval)

1. **Assumed:** a season may only start inside an already-open character or group
   chat (any character works; the roster check applies to player identity, not the
   host card). Starting from character select via an auto-created chat is design B
   above and a separate change. Confirm.
2. **Decided in review — Director card:** ship a bundled `Neo Terra — Director`
   card in this change, with a clear entry point on the Season tab and in Settings.
   Installation is **download-only** (no `/api/characters/import` or other write
   endpoint); the user imports it through ST's Characters UI. The card stays
   optional, and both `director` and `solo` modes remain supported.
3. **Host selection remains manual:** the host is whatever chat is open. The
   Director card is not auto-selected (that would require creating/switching a
   chat safely). Users must select the card and start a new chat before entering a
   season; auto-host/new-chat stays design B.
4. **Opening scene:** `buildOpeningScene` is returned but never sent. Should
   starting a season post the opening frame into the chat (new-chat flow) or keep
   the transcript untouched? This plan assumes untouched.
5. **Assumed:** `getCurrentChatId()` is available on the minimum supported
   SillyTavern version (manifest says 1.19.0). If older builds must work, a
   `chatMetadata.chat_id` fallback plus the cached `chatId` covers them.
6. **Assumed:** the season menu does **not** need to remount on `chat_changed`;
   resolving the context at action time is enough. If the identity/world preview
   should update live on chat switch, add a subscription in a follow-up.
7. **Player tab:** it is currently a placeholder even though `mountPlayerPanel`
   exists. Out of scope here — should it be wired in the same PR or a separate
   one?
8. **Map size target:** the plan widens the shell only for the Map tab. Is a
   near-fullscreen map layer (outside the modal) preferable, or is “larger modal”
   enough?
9. **Map default geometry:** keep `1080 × 700`, or raise the default after the
   shell grows?
10. **Settings panel fix (Step 3):** include it now or defer? It is the same bug
    class and likely to be reported next.
11. **Test strategy:** no DOM test dependency exists. Is a source-level CSS
    assertion acceptable for the hidden-rule regression, or should we add a
    headless DOM harness (new dependency) as a separate decision?
12. **Version drift** (`EXTENSION_VERSION` `0.1.0` vs `package.json`/`manifest.json`
    `1.0.0`) is noted but intentionally untouched by this plan.
