# apps/web: the dashboard

Pages are built from the kit: `src/ui` (controls and surfaces) and `src/page/kit` (page-level
pieces). The design rules are in `docs/design-rules.md`; the `maple/*` lint rules enforce them.

## Build from the kit

1. **Look first.** Read `src/ui/INDEX.md` (generated, one line per kit module), then the module.
   Check the lab (`src/lab`) for how a component looks.
2. **Use it.** Call the kit component, even when a raw element looks quicker. A missing variant or
   option goes into the kit component, not a class string at the call site.
3. **Nothing fits? Build it in the kit.** If you are about to write the same markup or class
   string a second time, or something another page already draws, extract it to `src/ui` (a
   control or surface) or `src/page/kit` (a page-level piece). Give it a doc comment: its first
   sentence is its line in the index.
4. **Move the old copies onto it, in the same change.** Search for the pattern you extracted
   (`rg` the class string or the markup) and switch every existing site to the new component.
   Show before and after screenshots of the pages you touched.
5. Run `bun run ui:index` after adding or renaming a kit export (CI checks it is current).

## What lint enforces

Outside `src/ui`, `src/page/kit`, `src/lab` and tests:

- `maple/no-raw-control`: no `h.button`, `h.input`, `h.textarea`, `h.select`, `h.table`,
  `h.dialog` or `h.label`; the message names the kit component to use.
- `maple/no-raw-heading`: no `h.h1` to `h.h4`; use `sectionHeading`, `pageTitle` or `detailTitle`.
- `maple/no-kit-styles-in-pages`: no `@maple/ui/styles/ui/*` imports; call the wrapper.

Everywhere in `src` and `packages/ui/src`: `maple/no-raw-color` (no hex, `rgb()`, `oklch()` in
class values) and `maple/no-arbitrary-text-size` (no `text-[13px]`), plus the token rules in
`docs/design-rules.md`.

Files that broke a rule when it landed are listed with their count in
`scripts/oxlint-plugins/ui-kit-baseline.json`. A listed file may not gain violations, and lint
fails when it loses some until you run `bun run lint:ui-baseline`, so the list only shrinks. When
you touch a listed file, fix its violations while you are there. Never pass `--allow-increase` to
make new code pass, and never add an `oxlint-disable` for these rules: build the kit piece instead.

Lint like CI: `bunx oxlint -c .oxlintrc.effect.json --quiet <files>`.
