# Travel feedback and map-close research (Spike B)

- Date: 2026-11-19
- Scope: after the Milestone 3 HUD, floating map window, and scene cards landed.
- Live host: SillyTavern 1.19.0 at `http://127.0.0.1:8000/`, Neo Terra v1.1.0.
- Chat used: the existing `Neo Terra — Director` timeline (S1 "Omnilia (Clarity Arc)"), turn 12–16. No chat or character was deleted.
- **No production default was changed.** `map.closeOnTravel` was toggled only for the scripted runs and restored after each run.

## Question

The current close-on-travel default exists to compensate for weak arrival feedback: the map changes, but the only confirmation is the sidebar and the chat frame behind the modal/window. With the HUD, a floating map window, and scene-card arrival frames in place, is closing the map still justified?

## Method

Each run scripted from the live page via the public context:

1. Open the floating Map window from the HUD (one click).
2. Select a travel node (`path.neoterra-map-key`); pick the first connected node that is not the current location.
3. Set `extensionSettings.neoterra.map.closeOnTravel` to the mode under test.
4. Record the click time, then poll every 100 ms for: the arrival message appended to `ctx.chat`, the map window disappearing, any arrival toast, and the visible sidebar text.
5. Restore `map.closeOnTravel` to its original value.

The destination frames were posted by the real travel flow. The host had no working completion backend, so the Storyline tracker/choices stages timed out (HTTP 400); the arrival time therefore includes a backend timeout that is unrelated to the UI. The UI feedback delta is what matters: how long after the arrival frame the user can orient.

## Scripted runs

| Run | Mode | Arrival frame | Map closed | Arrival toast | Return pulse | Clicks to reopen | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | close-on-travel (default) | 28.06 s | 28.27 s (0.21 s after the frame) | none | n/a | 1 (HUD → Map) | Scene card header/portrait decorated; shell already closed. Chat frame is the only arrival evidence. |
| 2 | keep-open | 11.18 s | never | none | none | 0 | Map stayed over the chat. Arrival frame was behind the window; the sidebar showed the threat/pacing card, not an arrival summary. The Return button existed but gave no recognition cue. |
| 3 | keep-open + toast + Return pulse (prototype, injected in-page only) | 37.55 s | never | 37.55 s (same frame) | yes (inline prototype) | 0 | The combined cue made the arrival unmistakable in the screenshot; the map stayed open and the chat was one click away. This variant is **not shipped**. |

Screenshots (captured from the live page):

- `plans/spikes/travel-feedback/hud-and-scene-card.png` — HUD, arrival scene card with header/portraits, and the prototype arrival toast.
- `plans/spikes/travel-feedback/map-window.png` — hosted floating Map window over the still-usable chat.

## What the runs showed

- **Close-on-travel still solves a real problem.** Without an arrival toast, keep-open leaves the user looking at the map while the only confirmation sits behind it. The sidebar does not currently surface the arrival summary, so keep-open is strictly worse for orientation.
- **The scene card is a strong arrival cue**, but only once the map is out of the way (or the user closes it).
- **The floating map is usable and does not block the chat**: the chat scrolls behind it and the send form is untouched. Closing the map from its title bar works.
- **The prototype toast + Return pulse is the right keep-open variant.** It mirrored the scene-card information at the point of attention and gave a clear next action. It needs production implementation (no injected DOM) before it can be judged as a default.
- **Backend latency dominates the absolute numbers.** With a responsive model the arrival frame would land much sooner; the relative ordering (frame → map close; keep-open with no cue) is unaffected.

## Follow-up (1.3): the cues are shipped

Steps 1–4 of `plans/travel-feedback-followup.md` implemented the three cues for
real, driven by the travel flow:

- `buildArrivalSummary` derives destination, district, time slot, turns, and the
  encounter guard from `WorldState` (and persists the prose under
  `chatMetadata.neoterra.ui.map`), so the card survives close–reopen.
- The travel handler pushes a destination toast (`travel:<from>:<to>:<lastAt>`)
  with a Return-to-chat action only while the map stays open.
- The Return button pulses once per arrival (a static **New arrival** badge under
  `prefers-reduced-motion`).
- The sidebar renders a structured arrival card after a remount and hides it
  only for the arrival the player dismissed.
- `map.arrivalFeedback` (default `true`) switches all three cues off together.

Re-run evidence: `plans/spikes/travel-feedback/notes.md` §"Follow-up (1.3)".
On the same `Neo Terra — Director` chat the keep-open run showed the toast
(43.39 s), the Return cue (43.39 s), and the sidebar card immediately, with the
map still in front; close-on-travel showed the toast after the window closed
and one HUD → Map click to reopen. The absolute numbers still include the
backend timeout, as before.

## Recommendation

**Keep `map.closeOnTravel: true` as the default.** The cues remove the
orientation gap that made keep-open strictly worse, but the default does not
need to move: the scene card behind the map is still one click away, and users
who prefer keep-open already have the setting. The cues ship for those users;
the default stays `true` (approved 2026-11-19).

**Revisit after a season.** The decision is a default, not a verdict on the
cues: if keep-open users report that the map window still hides the scene card
they want to read, re-run the three scripted modes at the next content
milestone and compare against the 1.3 table. Reverting the default is a
one-line settings change, not a revert of the cues.


## Reproduction sketch

```js
const ctx = window.SillyTavern.getContext();
ctx.extensionSettings.neoterra.map.closeOnTravel = false; // or true
ctx.saveSettingsDebounced?.();
// open HUD Map, click a .neoterra-map-key path, click [data-neoterra-map-travel]
// poll ctx.chat.length and the presence of [data-neoterra-window="map"]
// restore the original value when done
```
