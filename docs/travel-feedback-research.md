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

## Recommendation

**Keep `map.closeOnTravel: true` as the default for now.** The current close-on-travel behavior is still justified after the HUD/scene-card changes because keep-open has no arrival toast and the sidebar does not announce the arrival.

Before changing the default:

1. Ship a real **arrival toast** (destination + "Return to chat") driven by the travel flow, not the turn diff.
2. Add a **Return-to-chat pulse** on the map toolbar when an arrival happens while the map is open.
3. Add the arrival summary to the map sidebar (destination, time slot, encounter/no-encounter) so keep-open has in-window evidence.
4. Re-run these three scripted runs and review the report with the user.

This is a recommendation only; the production default was not modified by the spike.

## Reproduction sketch

```js
const ctx = window.SillyTavern.getContext();
ctx.extensionSettings.neoterra.map.closeOnTravel = false; // or true
ctx.saveSettingsDebounced?.();
// open HUD Map, click a .neoterra-map-key path, click [data-neoterra-map-travel]
// poll ctx.chat.length and the presence of [data-neoterra-window="map"]
// restore the original value when done
```
