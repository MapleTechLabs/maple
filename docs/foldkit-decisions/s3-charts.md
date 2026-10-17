# S3: Charts spike

Status: **passed** · 2026-10-17 · Branch `worktree-agent-acad4aaa28e2ad3f2` (from `fk/parity-harness`)

Question: can `@tanstack/charts` run without its React adapter inside a Foldkit Mount, with hover
and tooltips as Messages, pixel-identical to apps/web?

## Result

`/lab/charts` against `legacy-head`, 1440x900, light and dark (`parity run --filter lab-charts`):

| Scenario                                                           | Strict px     | Perceptual px | Behavior |
| ------------------------------------------------------------------ | ------------- | ------------- | -------- |
| `lab-charts` (gallery, first viewport)                             | **0** / **0** | 0 / 0         | 0 diffs  |
| `lab-charts-hover-pie` (production pie, a slice hovered)           | **0** / **0** | 0 / 0         | 0 diffs  |
| `lab-charts-hover-histogram` (production histogram, a bin hovered) | **0** / **0** | 0 / 0         | 0 diffs  |

`selfcheck --target foldkit --filter lab-charts`: 6/6 identical. Hover scenarios
(`packages/ui-parity/src/scenarios/charts.ts`) find the chart by `getByRole("img", { name })`, its
accessible role, then hover a **mouse position** inside it: a canvas plot has no element per datum.
The a11y report lists the unported charts below the fold (report-only).

Bundle: `@tanstack/charts` + d3 load lazily in `chart-host` (67.6 KB gzip); the lab entry is 13.1 KB.

## How it is wired (`apps/web-foldkit/src/charts/`)

- **Spec as data.** `ChartSpec` (Schema union: `Pie`, `PieSpike`, `NumericHistogram`,
  `CategoricalHistogram`, `BinnedHistogram`) holds everything a definition is built from: rows,
  resolved colours, the hovered and pinned keys. The view writes it JSON-encoded to the plot box's
  `data-chart-spec`. `definitions/*.ts` turn a spec into the same `defineChart` call the React
  component makes (code copied verbatim, `cn`/class strings unchanged).
- **`MountChart`** (`Mount.defineStream`, on the plot box) is `PlotFrame` + `RendererChart`: it
  `import()`s `chart-host`, which calls `createChartRendererAdapter` with `canvasChartRenderer`
  (or the SVG renderer), measures the box like `useMeasuredHeight`, positions `[data-chart-plot]`
  from `onRender`, and a MutationObserver on `data-chart-spec` calls `adapter.update`, which is what
  a React re-render with a new definition does. `onFocusChange` and `onTooltipBodyChange` become
  `ChangedChartFocus` / `ChangedChartTooltip` Messages.
- **Chart Submodel** (`chart.ts`): `activeKey`, `highlightedKey`, `tooltip`, `containerWidth`. Plot
  focus and legend hover share `activeKey` (production's single `activeName`); the pie spec reads it,
  so the hovered slice grows through update, not inside the canvas.
- **Tooltip body = Foldkit view.** The body Html carries `PortalTooltipBody`, which moves it into the
  `.ts-chart-tooltip__body` the library created (React's `createPortal`). Same DOM as legacy.
- **Theme colours.** `ResolveThemeColors` reads the needed custom properties off the lab root and
  re-reads on `<html>` class flips (`usePlotColors`' `useTheme` invalidation). Model holds them.
- **Lazy runtime.** `LoadChartRuntime` (Command) loads `chart-host` once; the gallery renders when the
  theme and runtime are ready, so it paints in one go with every canvas present.
- Scene test `chart.scene.test.ts`: plot focus grows the slice, legend hover and pin, tooltip body
  follows the datum and leaves with it (asserted on the plot's spec, `aria-pressed` and text).

## Gotchas

| Gotcha                                                                                                                                                                             | Fix                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Inline same-tag divs share one view identity, so when the pie's legend moves beside the plot the plot box was patched into the legend row (Mount on the wrong element, chart gone) | `plotBox` and `sideLegendRow` are named view functions                             |
| `onTooltipBodyChange` must keep its identity: a new function makes the tooltip replace its body element and detach the portaled body                                               | Callbacks created once per host, reading the current build from a holder           |
| Mounting at the measured height left the production histogram's dashed grid ±2 off on 323 px                                                                                       | Mount at `FALLBACK_HEIGHT` (320) then update, the order React's layout effects run |
| Card content arriving after first paint re-rastered card corners (±1, 14 px) through partial invalidation                                                                          | Render the whole gallery once theme and chart runtime are ready                    |
| `plot-tooltip.css` is imported by `plot-frame.tsx`, not by a stylesheet                                                                                                            | Imported by `plot-frame.ts`                                                        |
| Foldkit has no `OnPointerEnter`                                                                                                                                                    | Legend rows use `OnMouseEnter` (same for mouse; touch differs)                     |
| `@tanstack/charts` types need closed row types; polar marks take no `states`                                                                                                       | Kept legacy's two-arc-mark hover and accessor channels                             |

## What remains

- **Other chart types** in the gallery (below the first viewport, card shells only): heatmap
  (cell + scaleBand + sequential colour scale, `color-scale.ts` is reusable), line/area/stacked bar
  (`Timeseries` in `plot/timeseries.tsx`, 907 lines, plus `fixed-metrics`, threshold rules, partial
  tails), box plot, trace scatter (hexbin), sankey, treemap, the legend spikes, `MetricsGrid` empty
  state. Each is a `ChartSpec` variant, a `definitions/*.ts` builder and a view; the Mount,
  tooltip portal, theme and Submodel are done.
- Pie `DonutCenterTotal` overlay (needs the plot rect in the Model via a Message from `onRender`).
- `?renderer=` / `?arm=` search params and the interaction bench harness; `viewStateChanges`
  (read-only during DevTools time travel); legend row `onPointerEnter` for touch.
- `ChartColors` per chart rather than one token list per page; `usePlotLegendSlot` hoisting.
