# Design rules

The rules the dashboard (`apps/web`) and its kit (`packages/ui`) follow. Tokens live in
`packages/ui/src/styles/tokens.css`; the `maple/*` lint rules named below enforce them in CI
(`scripts/oxlint-plugins/design-rules.mjs`). A rule you need to break gets a new token, not an
exception at the call site.

## Build from the kit

Pages compose the kit (`apps/web/src/ui`, `apps/web/src/page/kit`; index in
`apps/web/src/ui/INDEX.md`). A control, heading or pattern a page needs and the kit lacks is built
in the kit, and the pages that already hand-roll it move onto it. Outside the kit, lint bans raw
controls (`maple/no-raw-control`), raw headings (`maple/no-raw-heading`) and building a component
from its kit styles (`maple/no-kit-styles-in-pages`). Colours and type sizes come from tokens
(`maple/no-raw-color`, `maple/no-arbitrary-text-size`). Existing violations are counted per file in
`scripts/oxlint-plugins/ui-kit-baseline.json`, which only shrinks (`bun run lint:ui-baseline`).
The workflow is in `apps/web/CLAUDE.md`.

## State is instant, only movement eases

Hover, press, selection and colour changes land in the frame they happen. Transitions are for
things that move: a popup or sheet entering, a chevron turning, a height opening.

- No `transition-colors`, bare `transition`, `transition-shadow` or a colour property inside
  `transition-[…]` on a string with `hover:` or `active:` (`maple/instant-state`).
- Never `transition-all`; name what moves (`maple/no-transition-all`).
- Every `hover:` has an `active:` twin in the same string, so a press on touch shows what a hover
  shows (`maple/hover-needs-active`).

## Shadows and corners

Depth comes from surfaces and the hairline. The only shadows are tokens (`maple/no-raw-shadow`):

| Utility | Use |
| --- | --- |
| `shadow-raised` | A control or card lifted off its surface |
| `shadow-popup` | Menus, popovers, selects, dialogs, sheets, toasts |
| `shadow-control` | A control's 1px highlight (a shade in light, a line of light in dark) |
| `shadow-accent-start` | The current row's leading accent bar |
| `shadow-overflow-up` | A sticky footer over scrolled content |
| `shadow-rule-bottom` | A sticky table header's bottom rule |
| `inset-shadow-highlight` / `inset-shadow-pressed` | A filled button at rest / pressed |

Corners come from the radius scale (`maple/no-arbitrary-radius`). A fill inset 1px inside a
bordered box takes its parent's radius minus 1px: `before:rounded-lg-inset` inside `rounded-lg`.
`rounded-2xs` (1px) is for hairline bars, `rounded-dot` for service and severity dots.

## Colour

- Text greys are solid steps: `foreground`, `foreground-soft`, `muted-foreground`,
  `foreground-subtle`, `foreground-faint`. They read the same on a tinted row.
- Washes are translucent and read the same on any surface: `surface-faint`, `surface-sunken`,
  `surface-strong`.
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

- Failures read "Couldn't {verb} {object}", never "Failed to …" (`maple/couldnt-copy`).
- A button is a verb and its object: "Create dashboard", not "Submit".
- No em dashes and no exclamation marks in UI strings.
- A one-line empty message has no trailing period: "No spans in this window". Multi-sentence
  descriptions keep their periods.
- A time-window empty says "in this window", never "in the selected range" or "in window".
- A filtered empty says "No {noun} match these filters" (`filteredEmpty` in `kit/signal-empty-state.ts`).
- Search placeholders end in "…": "Search services…".
