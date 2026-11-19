# Spike B raw notes — 2026-11-19

Host: SillyTavern 1.19.0 (`http://127.0.0.1:8000/`), extension mounted from the
`NeoTerra-Framework` junction. Chat: `Neo Terra — Director` (S1, turn 12).
Screenshots are in this folder. Full report: `docs/travel-feedback-research.md`.

## Run 1 — close-on-travel

```
mode: close-on-travel
originalSettingRestored: true
beforeLen: 1
afterLen: 2
frameIndex: 1
frameAt: 28058.4 ms
mapClosedAt: 28269.3 ms
frameText: "Location changed: Central Plaza → PetraByte Tower ..."
frameClass: "mes last_mes fade last_swipe neoterra-scene-message neoterra-scene-card neoterra-cinematic-frame"
decoratedHeader: true
toastAt: null
clicksToReopen: 1
reopened: true
location: petrabyte-tower
```

## Run 2 — keep-open

```
mode: keep-open
selected: Clarity Incorporated HQ
frameAt: 11182.5 ms
mapEverClosed: false
mapOpen: true
toastAt: null
arrivalPulse: false
returnButtonVisible: true
location: clarity-hq
sideMentions: "Clarity Incorporated ... Threat / pacing card ..."
```

The sidebar text after the arrival contained the threat and pacing card, not an
arrival summary.

## Run 3 — keep-open + toast + Return pulse (prototype only)

```
mode: keep-open + toast + return pulse (prototype)
selected: PetraByte Tower
frameAt: 37553.3 ms
injectedAt: 37553.8 ms
mapOpen: true
```

The toast and pulse were injected into the page for measurement; no runtime code
for them ships in this milestone.

## Utility observations

- HUD visible on the S1 chat: `data-mode="rail"`, five gameplay actions
  (`map`, `characters`, `player`, `journal`, `newspaper`), no Settings controls.
- Map window: `1100×680` at `96,64`, `data-layout="window"`, hosted map fills it;
  shell closed, chat scrollable, send form present.
- Codex + Journal stack: only the Journal window is `data-active="true"` after
  opening it; 13 journal entries rendered.
- `/neoterra` opens the palette with exactly the eight gameplay actions.
- HUD collapse toggle updated the persisted `ui.hudCollapsed` setting; the CSS
  body collapse was verified after the fix in `src/ui/hud.js` (inner marker).

## Follow-up (1.3) — production cues re-run

Re-ran the scripted travel modes on the same `Neo Terra — Director` chat after
steps 1–4 shipped (`5cec295`, `da48b78`, `b61e3fc`, `b25c093`). `map.closeOnTravel`
and `map.arrivalFeedback` were toggled only for the run and restored afterwards.
The host was the same SillyTavern 1.19.0 instance at `http://127.0.0.1:8000/`.
The simulated backend still returns HTTP 400 for the choices/cast/storyline
agents, so the absolute times include that timeout, exactly as in the first
spike. The cues themselves are fired from the travel flow before the CYOA
round-trip, so their delta from the frame is what matters.

Reduced motion was on in the capture browser (`prefers-reduced-motion: reduce`
matched), so the Return cue is the static **New arrival** badge instead of the
animation. Screenshots could not be captured in this session (the browser
desktop window was not visible to the screenshot tool); the DOM evidence below
is the raw output from `run-travel-feedback.js`.

| Run | Mode | Frame | Toast | Return action | Map | Return cue | Sidebar card | Clicks to reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | close-on-travel (default) | 26.45 s | 26.55 s (`travel:petrabyte-tower:clarity-hq:1795098820551`, "Night · Downtown · Hostiles: Clarity Incorporated, The Beast Conversion Program") | **no** (informational) | closed at 26.55 s | n/a | persisted for the reopen path | 1 (HUD → Map) |
| 2 | keep-open (`closeOnTravel:false`) | 43.24 s | 43.39 s (`travel:clarity-hq:petrabyte-tower:1795098779275`, "Evening · Downtown · No hostiles") | **yes** ("Return to chat") | stays open | badge `New arrival` at 43.39 s (reduced motion) | "PetraByte Tower / Evening · Downtown · 1 turn / No hostiles detected / Full arrival text" | 0 |
| 3 | keep-open then close → reopen | 43.24 s | same arrival | yes | stays open | badge persists | same card renders from `WorldState` after remount; `Full arrival text` reachable | 1 (after close) |

Additional checks:

- Keep-open toast action: clicking **Return to chat** closed the map window and
  focused `#send_textarea`. The toast element was removed afterwards.
- Close-on-travel: the toast appeared after the map window had already closed
  and stayed for its 9 s lifetime, proving the stack is outside the window.
- Dismissal: clicking the card's dismiss wrote
  `chatMetadata.neoterra.ui.map.arrivalDismissedKey = travel:petrabyte-tower:clarity-hq:1795098730393`;
  the card was absent after a close → reopen. A later travel has a new key and
  renders again.
- `map.arrivalFeedback:false`: the map remount rendered no card and no legacy
  prose block; no cues are pushed by `announce`.
- The arrival prose + arrival-time facts persist under
  `chatMetadata.neoterra.ui.map.lastArrivalIntro` (`key`, `text`, `timeSlot`,
  `district`, `turns`, `hasEncounter`, `hostiles`), so the card does not borrow
  the live clock or encounter after a remount.

**Does keep-open now orient the player without reopening the map?** Yes. In run
2 the map stayed in front, the toast named the destination, slot, district and
encounter, the Return button carried the arrival cue, and the sidebar card was
visible without a click. The default nevertheless stays
`map.closeOnTravel: true` (approved 2026-11-19); see
`docs/travel-feedback-research.md`.

