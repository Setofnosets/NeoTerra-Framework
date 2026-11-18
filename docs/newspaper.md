# Newspaper

The in-world newspaper turns events already in `WorldState` into a readable
public surface: an edition with a masthead, dateline, and up to six headlines.
It is **opt-in** and has a deterministic builder, so the feature works with no
LLM call at all.

## State

`flags.newsroom`:

```json
{
  "lastEditionDate": "2037-03-06",
  "lastEditionTurn": 12,
  "editions": [
    {
      "id": "edition:s1dark:2037-03-06:12",
      "date": "2037-03-06",
      "turn": 12,
      "masthead": "THE WONDERLAND GAZETTE",
      "dateline": "NEO TERRA — EVENING EDITION",
      "style": "tabloid",
      "source": "agent",
      "headlines": [
        {
          "title": "…",
          "lede": "…",
          "section": "crime",
          "tone": "alarmist",
          "eventTurn": 11,
          "actors": [],
          "locationId": "old-subway"
        }
      ]
    }
  ]
}
```

The archive holds at most **20 editions × 6 headlines** and survives world
export/import because it lives inside `WorldState.flags`.

## Cadence

An edition is due when:

- `elapsedDays >= newspaper.everyDays` (default 3), or
- `newEvents >= newspaper.minEvents` (default 6).

At most one edition is published per in-game date, and `PUBLISH_EDITION` is
idempotent by in-game date (falling back to the edition id when the date is
null). A held scene produces no elapsed day and
the publisher also checks the hold explicitly, so a frozen scene never publishes
mid-scene.

## Deterministic fallback

`buildDeterministicEdition` ranks events since the last edition (headline first,
then importance tags, then recency), groups them into sections (`crime`,
`faction`, `hero`, `business`, `society`, `offscreen`), and derives

- `title = event.headline ?? firstSentence(summary, 90)`
- `lede = summary`

This builder is the test surface and the always-available fallback. The agent
is only asked when both the feature and `agents.newspaper` are enabled.

## Agent

`newspaper` is registered with `AGENT_IDS`, defaults, and its prompt in the same
change (the `normalizeAgents` landmine). Its input is the last 20 events since
the last edition plus the current factions/threats/act, season tone, and style.
Output is validated against `{ masthead, dateline, headlines[] }` with strict
caps; one repair retry is attempted. On failure the deterministic edition is
published instead and `source: "deterministic"` is recorded.

The publisher runs **detached** after the turn pipeline, re-checks the chat id
before writing, and is silent on failure.

## UI

- The map overlay shows the latest 1–2 headlines when `map.showHeadlines` is on
  and opens a reader modal.
- The reader shows masthead, dateline, headline chips (section/tone), and the
  archive newest-first; Escape closes it and focus returns to the opener.
- `[NEOTERRA_NEWS]` renders the date and up to two headlines when enabled.

## Style

`newspaper.style` is `auto | tabloid | broadsheet | underground`.

- `auto` derives `tabloid` for villain POV, `broadsheet` for hero seasons, and
  `underground` for a post-victory resistance arc.

## Settings

```json
{
  "newspaper": {
    "enabled": false,
    "style": "auto",
    "everyDays": 3,
    "minEvents": 6,
    "maxHeadlines": 6
  }
}
```

The feature is off by default. With the feature on but the newspaper agent off,
a deterministic edition is still published. `context.blocks.news` and
`tokenBudget.news` control the prompt block.
