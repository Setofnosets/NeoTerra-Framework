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
