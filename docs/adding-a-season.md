# Adding a season

A season is data. Adding one does not require code changes as long as the new
season uses existing factions/form rules and follows the shape below.

## 1. Add the character folder

Create `Chars/<Season>/` and drop the season's `chara_card_v3` JSON cards there.
The folder name is the display name; the season id is its lowercase form:

| Folder | Season id |
| --- | --- |
| `Chars/S1/` | `s1` |
| `Chars/S1Dark/` | `s1dark` |
| `Chars/S5/` | `s5` |
| `Chars/NewSeason/` | `newseason` |

Cards are read from `data.*`; the legacy duplicated top-level block is ignored.
Card filenames decide `formKind` and the registry id, so keep them stable.

> **PNG cards are not ingested yet.** `build-data` reads `.json` cards only.
> If the art ships as a `chara_card_v3` PNG, export or author the JSON twin
> beside it (same slug) and commit the JSON; the PNG is not registered, not
> paired, and no `avatarPath` is emitted today. PNG ingestion is a planned,
> opt-in build feature.

## 2. Add `data/seasons/<id>.json`

The filename id must match the document `id` (auxiliary files may use
`<id>.aux.json`). A minimal playable season:

```json
{
  "schemaVersion": 1,
  "id": "s5",
  "title": "Season 5 — Envy Arc",
  "era": "2044",
  "anchorDate": "2044-01-10",
  "premise": "One or two sentences the narrator can open with.",
  "toneNotes": "Tone, content, and pacing guidance.",
  "playerRole": "hero",
  "defaultPlayerCharacterId": null,
  "playable": true,
  "alt": false,
  "altOf": null,
  "sandbox": false,
  "allowAnyCharacter": false,
  "roster": [
    {
      "characterId": "s5.example.hero",
      "formId": "s5.example.hero",
      "locationId": "central-plaza"
    }
  ],
  "factions": [
    { "id": "crisis-coalition", "influence": 30, "status": "active" }
  ],
  "threats": [
    {
      "id": "s5.main.example-threat",
      "rank": "main",
      "name": "The Example Threat",
      "agenda": "What the threat wants.",
      "stages": ["stirring", "ascendant", "terminal"],
      "progress": 0
    }
  ],
  "startLocationId": "central-plaza",
  "openingBeats": [],
  "canonBeats": [
    {
      "id": "s5.opening.first-move",
      "order": 10,
      "title": "First Move",
      "description": "The season's opening function.",
      "act": "opening",
      "conditions": { "turnRange": [0, 12] },
      "completion": {
        "type": "event",
        "predicates": [{ "kind": "event-tag", "value": "first-move" }]
      },
      "flexibility": "adaptable",
      "deadlineTurns": 12,
      "deadlineDate": null,
      "deadlineConsequence": "The threat advances one stage.",
      "rewriteHints": "Any public move that announces the threat counts."
    }
  ],
  "finalDeadline": { "turns": 120, "date": null },
  "failureState": "villain-victory",
  "manualOnly": [],
  "altFormsAllowed": []
}
```

Requirements enforced by `build-data --check` and the runtime loader:

- `id` matches the filename and the `Chars/<Folder>` lowercase name.
- Every roster `characterId` and `formId` resolves in the registry and belongs
  to this season.
- Every faction, location, threat, district, and beat reference resolves.
- Every beat has an act, a completion predicate, and a deadline consequence.
- Every non-sandbox playable season has at least one beat per act and a
  `finalDeadline`.
- Only `s1dark` uses `playerRole: "villain"` by default; other seasons may set
  it deliberately.

Use `s5.aux.json` for auxiliary data that is not playable yet: set
`"playable": false` and `notPlayableReason`. The entry menu shows it disabled
and `startSeason` refuses it with a clear message.

## 3. Register new forms (optional)

If the season introduces transformations, add:

- `data/form-groups.json`: one group with exactly one `base` member and its
  alternatives.
- `data/form-rules.json`: legal `from`/`to` transformations, triggers,
  reversibility, and permanence.

Both are validated against the registry. A character may only move along a
declared rule; unknown transformations are rejected in the agent log.

## 4. Register new locations/factions (optional)

Locations and factions are global:

- Add a named location to `data/locations.json`, bind it to a map marker or set
  `virtual: true` with manual coordinates, and keep connections symmetric.
- Add factions to `data/factions.json`, then reference them from the season.
- For map geometry, see `map-authoring.md`; adding a district/bridge requires
  drawing it in the SVG and re-running `build-map`.

## 4b. Villain domain (optional)

A season with `"playerRole": "villain"` can author a domain dashboard. Hero
seasons and Sandbox omit it; nothing in the code names a specific domain.

```json
{
  "domain": {
    "name": "The Garden",
    "factionId": "clarity",
    "description": "One sentence the Domain tab and prompt use.",
    "loreText": "Flavour the narrator can quote.",
    "knightFormKind": "knighted",
    "watchDistricts": ["downtown", "harbor"],
    "resistanceFactionIds": ["petrabyte"]
  }
}
```

- `name` and `factionId` are required; the faction must resolve.
- `knightFormKind` matches registry `formKind` values (for example `knighted`).
  Knights are scoped to this season's registry entries.
- `watchDistricts` must resolve to `data/districts.json` ids.
- `resistanceFactionIds` must resolve to `data/factions.json` ids.

The **Domain** tab and `[NEOTERRA_DOMAIN]` appear automatically. See
`sensorium.md` for the view model.

## 4c. Off-screen pacing (optional)

Add a season block to `data/agendas.json` when the default rates are wrong for
the season:

```json
{
  "seasons": {
    "newseason": {
      "factionAgendas": {
        "clarity": { "influencePerDay": 1.0, "rumorTags": ["patrol"] }
      },
      "threatPace": {
        "newseason.main.threat": { "progressPerDay": 1.5 }
      }
    }
  }
}
```

Missing entries fall back to `defaults`, so authoring this file is optional.
`rumorTags` are extra event tags, not template selectors. See `world-tick.md`.

## 5. Generate the registry and season manifest

```bash
npm run build:data
```

This writes:

- `data/characters/index.json` (all cards, discovered from `Chars/*`)
- `data/seasons/index.json` (the manifest the runtime loader reads)

The new season appears in the entry menu automatically. If it does not appear,
run `node tools/build-data.mjs --check` and fix the reported error.

## 6. Test it

```bash
node tools/build-data.mjs --check
node --test tests/seasons.test.js
node --test tests/season-start.test.js
```

Add a season-specific test if the season introduces new threats, forms, or
multi-threat behavior. For a living example, read `data/seasons/s4.json`
(two main threats, post-victory arcs) and `data/seasons/s1dark.json`
(villain POV, default canon player).

## Narrator card

Director mode uses `assets/neoterra-director.json`, a bundled V2 character card
named `Neo Terra — Director`. It is intentionally **not** under `Chars/`, so it is
never added to the season registry or offered as a playable identity. Users
download it from the Season tab setup strip (or the Settings panel) and import it
through SillyTavern's **Characters → Import character** flow, then select it and
start a new chat before entering a season.

Solo mode does not need this card: it uses the played canon character's card as the
host. Season start never requires the Director card; if it is missing, the current
chat's character narrates and the setup strip shows a download hint.
