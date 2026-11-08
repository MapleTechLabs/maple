# Design rules

The rules the dashboard (`apps/web`), Maple Local (`apps/local-ui`) and their kit (`packages/views`,
`packages/ui`) follow. Tokens live in
`packages/ui/src/styles/tokens.css`; the `maple/*` lint rules named below enforce them in CI
(`scripts/oxlint-plugins/design-rules.mjs`). A rule you need to break gets a new token, not an
exception at the call site.

## Build from the kit

Pages compose the kit (`packages/views/src/ui`, each app's `src/page/kit`; index in
`packages/views/src/ui/INDEX.md`). A control, heading or pattern a page needs and the kit lacks is built
in the kit, and the pages that already hand-roll it move onto it. Outside the kit, lint bans raw
controls, table parts, divided lists, chip-styled `code` and hand-drawn hairlines
(`maple/no-raw-control`), links drawn as a link or a row (`maple/no-raw-link`), a `div` with a
click handler (`maple/no-clickable-div`), raw headings (`maple/no-raw-heading`) and building a
component from its kit styles (`maple/no-kit-styles-in-pages`). A run of text on the type scale is
`typography` (`maple/prefer-typography`) and a flex row or column is `hstack`/`vstack`
(`maple/prefer-stack`). Colours, type sizes, line heights, tracking and spacing come from tokens
(`maple/no-raw-color`, which also reads palette utilities and colour values in style objects;
`maple/no-arbitrary-text-size`; `maple/no-arbitrary-spacing`), and a colour utility must name a token
tokens.css defines (`maple/no-unknown-color-token`: a typo like `text-severity-ok` draws nothing). Write
Tailwind 4 spellings: `bg-linear-to-t`, `rounded-sm`, `grow` (`maple/no-legacy-utility`). Existing violations are counted per
file in `scripts/oxlint-plugins/ui-kit-baseline.json`, which only shrinks (`bun run lint:ui-baseline`).
A kit component that owns its look (`button`, `badge`, `textLink`, `panel`, `eyebrow`, `tableHead`,
headings, …) is placed by its `className`, never restyled by it: type, colour, radius and shadow
come from its options, and a look the options lack becomes a new variant in the kit
(`maple/kit-class-layout-only`). A status dot, chip or divided list rebuilt from raw classes is
the kit call (`maple/no-handrolled-kit-look`). A class string repeated across 3+ page files is counted in `scripts/ui-class-patterns.json` and may
only shrink (`bun run ui:patterns:check` in CI). The workflow is in `apps/web/CLAUDE.md`.

## Type and spacing

- Weights are `font-normal`, `font-medium` and `font-semibold` (`maple/font-weight-scale`).
- Tracking is a token. An uppercase label is the `eyebrow` kit, or `tracking-caption` (0.08em) /
  `tracking-overline` (0.12em); display type may take `tracking-tight`; nothing else is spaced.
  Tailwind's `tracking-wide`, `-wider`, `-widest` are banned (`maple/tracking-tokens`).
- Spacing moves in half steps (2px). A quarter step (`gap-0.75`, `pl-3.75`) is an odd pixel; when a
  pixel offset is the point (centring a dot on a text line, meeting a rail), write it from a scale
  value: `mt-[calc(--spacing(1)+1px)]` (`maple/no-off-grid-spacing`).

## State is instant, only movement eases

Hover, press, selection and colour changes land in the frame they happen. Transitions are for
things that move: a popup or sheet entering, a chevron turning, a height opening.

- A colour never eases: no `transition-colors` and no colour property inside `transition-[…]`,
  even when the change comes from a parent (`group-hover:`), selection or focus. Bare `transition`
  and `transition-shadow` are banned on a string with `hover:` or `active:` (`maple/instant-state`).
- Never `transition-all`; name what moves (`maple/no-transition-all`).
- Every `hover:` has an `active:` twin in the same string, so a press on touch shows what a hover
  shows (`maple/hover-needs-active`).

## Shadows and corners

Depth comes from surfaces and the hairline. The only shadows are tokens, colour included
(`maple/no-raw-shadow` bans sizes, arbitrary values and `shadow-black/10`-style colours):

| Utility                                           | Use                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `shadow-raised`                                   | A control or card lifted off its surface                              |
| `shadow-popup`                                    | Menus, popovers, selects, dialogs, sheets, toasts                     |
| `shadow-control`                                  | A control's 1px highlight (a shade in light, a line of light in dark) |
| `shadow-accent-start`                             | The current row's leading accent bar                                  |
| `shadow-overflow-up`                              | A sticky footer over scrolled content                                 |
| `shadow-rule-bottom`                              | A sticky table header's bottom rule                                   |
| `inset-shadow-highlight` / `inset-shadow-pressed` | A filled button at rest / pressed                                     |

Corners come from the radius scale (`maple/no-arbitrary-radius`). A fill inset 1px inside a
bordered box takes its parent's radius minus 1px: `before:rounded-lg-inset` inside `rounded-lg`.
`rounded-2xs` (1px) is for hairline bars, `rounded-dot` for service and severity dots.

## Colour

- Text greys are solid steps: `foreground`, `foreground-soft`, `muted-foreground`,
  `foreground-subtle`, `foreground-faint`. They read the same on a tinted row. Text never takes a
  `/NN` opacity, grey or tone (`maple/no-faded-text`).
- Washes are translucent and read the same on any surface: `surface-faint`, `surface-sunken`,
  `surface-strong`.
- A see-through surface is a token, never `bg-background/NN` or `bg-card/NN`
  (`maple/surface-translucency`): `surface-well` is an inset well on a card, `surface-float` (with
  `backdrop-blur-sm`) a label over a chart, map or media, `scrim` the layer behind a dialog.
- Layers come from the z scale, never `z-[…]` (`maple/no-arbitrary-z`): `z-1`..`z-10` inside a
  surface, `z-50` dialogs and sheets, `z-55` popovers and tooltips, `z-60` toasts and nested lists.
  A popup takes a popup radius (`maple/popup-radius`).
- Neutral washes never take a `/NN`: `bg-muted/50` is `bg-surface-sunken` (`maple/surface-washes`).
- Hover fills: a row, list item or chip hovers `bg-surface-sunken`, and a chip already on
  `surface-sunken` hovers `surface-strong`. A control (ghost button, toggle, tab, menu trigger)
  hovers `bg-accent`, and only the kit in `packages/ui` draws one. `hover:bg-muted` is never right
  (`maple/surface-washes`).
- Hover outlines: a pickable card or chip hovers `border-border-strong`, a toned one its tone's
  `-a4` edge. `ring` is focus only, and `foreground` or a `/NN` tone is never a hover edge
  (`maple/hover-edge`).
- Disabled dims to `opacity-64`, the same on every control and menu item
  (`maple/disabled-opacity`).
- Focus draws one ring: solid `ring-ring` (`ring-1` inset on a row, `ring-2` on a control), or an
  input's soft halo `ring-[3px] ring-ring/24`, which needs `border-ring` to carry it (a
  borderless control takes the solid ring). No other ring alpha (`maple/focus-ring`).
- A tone's washes and edges use its alpha steps, never a `/NN` under 50
  (`maple/tone-alpha-steps`): `-a1` a faint wash, `-a2` a toned box's fill, `-a3` its edge, `-a4`
  a strong edge. A toned box takes its tone's edge, not the grey hairline:
  `bg-severity-error-a2 border-severity-error-a3`. Tones: `primary`, `destructive`, `success`,
  `warning`, `info`, `severity-*`.

## Icons

An icon straight inside neutral text draws one solid step under it (the icon ink in tokens.css),
and follows the text on hover. A parent that turns to a tone on hover keeps its icon at full
tone. Never fade an icon with `opacity-*`; give it a quieter text colour
instead. Only a reveal (`opacity-0` → `opacity-100`) sets opacity (`maple/no-dimmed-icon`).

## Waiting

A skeleton stays blank for its first 300ms (`loading-delay`, on the kit `Skeleton`), so a fast
load never flashes one. Every tooltip waits the one open delay, `Tooltip.OPEN_DELAY`
(`maple/single-tooltip-delay`).

## Copy

`maple/ui-copy` and `maple/empty-copy` hold the rules below that can be read from a string.

- Failures read "Couldn't {verb} {object}", never "Failed to …" (`maple/couldnt-copy`).
- A button is a verb and its object: "Create dashboard", not "Submit".
- No em dashes and no exclamation marks in UI strings.
- A one-line empty message has no trailing period: "No spans in this window". Multi-sentence
  descriptions keep their periods.
- A time-window empty says "in this window", never "in the selected range" or "in window".
- A failed load offers "Try again" (the kit error-state's label), never "Retry".
- A picker with no hits says "No {noun} match" ("No matches" without a noun).
- Apostrophes are straight (`'`).
- A filtered empty says "No {noun} match these filters" (`filteredEmpty` in `kit/signal-empty-state.ts`).
- Search placeholders end in "…": "Search services…".
