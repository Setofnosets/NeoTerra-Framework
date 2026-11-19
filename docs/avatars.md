# Portraits and the avatar manifest

Neo Terra resolves a portrait for every registry character through four layers,
highest priority first:

1. the generated manifest (`data/characters/avatars.json`);
2. a per-user **Sync portraits** override (stored in `localStorage` under
   `neoterra.avatarOverrides`, never in the repository);
3. the user's installed SillyTavern card, matched by exact `dataName`, display
   name, or alias;
4. initials, rendered as the fallback.

A missing manifest, a missing installed card, and a broken image all fall back
to initials. No portrait surface ever renders a broken image, and the resolver
never swaps a portrait between two different characters: an ambiguous match
returns no URL.

## Building the manifest

The manifest is generated from a folder of PNG cards:

```bash
npm run build:avatars -- --source "<path-to-KI>/chars/neo"
npm run build:avatars -- --source "<path-to-KI>/chars/neo" --check
```

- Each PNG is matched by its embedded `chara`/`ccv3` card name and aliases, then
  by filename.
- Ambiguous matches are never guessed. Add an entry to
  `data/characters/avatar-overrides.json` mapping the source-relative path to a
  registry id.
- By default matched PNGs are copied into `assets/avatars/`. Pass `--no-copy`
  for a runtime-only install: the manifest then records `file: null`, the card
  body fingerprint, and the source path; the runtime resolves the installed
  card by fingerprint.
- `--check` without `--source` validates the committed manifest against the
  registry (CI-safe). With `--source`, it compares a fresh build and fails on
  stale output or unresolved ambiguity.

The generated file is never hand-edited. `data/characters/avatar-overrides.json`
is authored data.

## Sync portraits and Download manifest

Settings → **Character portraits** offers two actions:

- **Sync portraits** re-scans `ctx.characters`, writes the per-user override map,
  and refreshes every avatar surface. It never writes the extension folder.
- **Download manifest** produces a mergeable `neoterra-avatars.json` built from
  the installed cards. Merge reviewed entries into
  `data/characters/avatars.json` by re-running the tool with `--source`.

## Installed-card matching

Short card names repeat ("Claire", "Vaiva", "Carol", "Aurelia"). The resolver:

- prefers the full display name and aliases derived from the card body;
- uses the manifest's body fingerprint to select the exact installed copy when
  the name repeats;
- returns no portrait (initials) when the remaining candidates are genuinely
  different characters with the same name.

The manifest fingerprint is a stable 32-bit hash of the card description, so
two PNGs that carry the same card text are treated as the same character even
when their art files differ.
