# Domain sensorium (villain POV)

The Domain tab is a generic dashboard for any villain-POV season. S1Dark is the
first consumer; a future villain season needs **data only**.

## Authored `domain` block

Any season with `playerRole: "villain"` may author an optional `domain` object:

```json
{
  "domain": {
    "name": "Wonderland",
    "factionId": "clarity",
    "description": "The city as Bleeding Heart has remade it.",
    "loreText": "They call it Wonderland now.",
    "knightFormKind": "knighted",
    "watchDistricts": ["downtown", "fashion-row", "harbor"],
    "resistanceFactionIds": ["petrabyte", "crisis-coalition"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `name`, `factionId` | Required. The domain and its ruling faction |
| `description`, `loreText` | Presentation and narrator flavour |
| `knightFormKind` | Registry `formKind` that identifies the domain's knights |
| `watchDistricts` | District ids highlighted in the territory section |
| `resistanceFactionIds` | Factions whose threats are the domain's danger |

Hero seasons and Sandbox omit the block. The validator and
`data/schemas/season.schema.json` accept the optional object; unknown keys are
rejected by the published schema, so add fields there first if you extend it.

## Activation

`active` requires a season `domain` block **and** `playerRole: "villain"`. The
domain follows the **season, not the played identity**: switching an S1Dark chat
to a hero identity keeps the tab and the block, because the world is still the
domain. Hero seasons get neither.

`resolveVisibleTabs(state, season)` is the pure tab-visibility rule. If the
active Domain tab becomes hidden (chat switch, season change), the shell falls
back to Characters.

## View model

`buildDomainView({ state, season, registry, locations, districts, settings })`
returns:

- `active`, `reason`;
- `wonderland` — name, description, flavour text;
- `knights` — registry entries with the authored `formKind`, scoped to the
  season, with live status, location, form, corruption, and player affinity;
- `court` — non-knight characters with corruption, domain allegiance, or an
  `owner/servant` tie to the player;
- `corruptionSpread` — counts by stage and the top five progress values;
- `territory` — per-district control aggregated from `locations[].factionId`,
  with controlled/contested/hostile/unclaimed counts and the faction HQ (falls
  back to live location district labels when the authored document is absent);
- `resistance` — threats from the resistance factions, relabelled as danger to
  the domain;
- `feed` — recent `offscreen`, `knight`, `corruption`, and `beat` events.

## UI and prompt

The Domain tab shows Wonderland, Knights, Court/corruption, Territory,
Resistance, and the Feed. `[NEOTERRA_DOMAIN]` renders only for an active domain
and names the domain, knights, corruption, territory, and resistance.

## Settings

- `context.blocks.domain` (default `true`) — send `[NEOTERRA_DOMAIN]`.
- `tokenBudget.domain` (default `350`, priority `3.5`).

The tab itself has no separate toggle: it appears when the season authors a
domain and plays as the villain.
