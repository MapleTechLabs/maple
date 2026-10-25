# S4: Big virtualized tables in Foldkit

Status: **passed** · 2026-10-17 · Branch `worktree-agent-a3ce4759ff628d02d` (from `fk/parity-harness`)

Question: can Foldkit render Maple's biggest virtualized list (the logs stream, 2,000 wide rows
with chips, hover cards and keyboard focus) pixel-identical to apps/web and at least as fast?

## Result

Ported `/lab/bench/logs` and `/lab/logs` (`apps/web-foldkit/src/lab/entries/{bench/logs,logs}.ts`)
on a reusable stream Submodel (`src/ui/logs/`). Fixtures are imported from apps/web
(`lab/logs-fixture.ts`, and the bench rows moved verbatim to `lab/bench/logs-table-bench-fixture.ts`).

Parity, `--baseline legacy-head --candidate foldkit`, light + dark, runs `s4-final-bench` and `s4-final-lab`:

| Filter                                                                                       | Variants | Pixels | Behavior | Status              |
| -------------------------------------------------------------------------------------------- | -------- | ------ | -------- | ------------------- |
| `lab-bench-logs` (default, scrolled, row hover, chip card, j/k focus, focus past the window) | 12       | 0      | 0 diffs  | **identical**       |
| `lab-logs` (default, scrolled, focused, wrap + search, pins + comfortable, reload)           | 12       | 0      | 0 diffs  | fail: baseline only |

Every `lab-logs` variant is visually identical with a clean candidate; legacy-head itself logs 401s
and an Electric error because `DashboardLayout` calls the API with no session (true of every shell
lab page, e.g. `lab-errors`). That needs a harness change (a session for shell lab pages), not a port fix.

Performance: `packages/ui-parity/src/bench/logs.ts` runs what `perf/logs.perf.spec.ts` and
`perf/logs-hover.spec.ts` measure against both static builds, interleaved, 5 runs each (headless
Chromium, M-series Mac). The original specs also pass unchanged against both builds through the new
`PERF_BASE_URL` in `apps/web/playwright.config.ts`.

| Metric (p50 / p95 of 5)                         | legacy                        | foldkit             |
| ----------------------------------------------- | ----------------------------- | ------------------- |
| Mounted rows before / after full scroll         | 35 / 35                       | 35 / 35             |
| Scroll frames sampled; frame p95 (ms)           | 123; 16.7 / 16.8              | 123; 16.7 / 16.8    |
| Long tasks; blocking ms                         | 0; 0                          | 0; 0                |
| Scroll script ms (CDP `ScriptDuration`)         | 429.0 / 438.4                 | **315.8 / 325.1**   |
| Scroll layout / style ms                        | 97.4 / 455.1                  | 97.3 / 446.6        |
| Scroll task ms (CDP `TaskDuration`)             | 1240.1 / 1262.5               | **1099.4 / 1122.2** |
| Commits during scroll                           | n/a (Profiler is off in prod) | 120 (one per frame) |
| Time to first rows ms                           | 198.4 / 202.3                 | 175.8 / 181.8       |
| JS heap after GC, loaded / scrolled MB          | 27.2 / 28.9                   | 22.3 / 26.6         |
| Chip sweep frame p95 ms; frames > 20 ms         | 16.7 / 16.8; 0                | 16.7 / 16.8; 0      |
| Hover card inserted, ms after the 300 ms delay  | 21.2 / 22.4                   | 30.6 / 33.2         |
| Hover card painted, ms after the delay          | 49.7 / 53.0                   | 47.7 / 53.2         |
| Hover spec: stranded after sweep; cards on rest | 0; 1                          | 0; 1                |

Foldkit inserts the card in the next animation frame (renders coalesce per frame) where React
commits from the timer task; both land in the same paint.

Frame cost and jank are equal (no long tasks; p95 frame is the 60 Hz vsync on both). Foldkit spends
less script time per scroll, boots faster and holds less heap. Hover cards paint in the same frame.

## What made it fast (profiles of the 121-step scroll)

| Finding                                                                                                                                                                                                | Cost before                       | Fix                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `h.submodel` deep-walks `viewInputs` on every render looking for nested functions (`assertNoNestedFunctions`, a path array per node). With 2,000 rows in `viewInputs` that is O(rows) per scroll frame | +258 ms script                    | Rows live in the stream's Model (`setRows` / `replaceRows` entry points); `viewInputs` carries only flags       |
| `h.Class` becomes a class object the differ applies with `classList.add` per token on every created element; rows carry ~40 Tailwind tokens                                                            | +166 ms (`Set.add` / `classList`) | `rowClass(h, s)` = `h.Attribute("class", s)` for row markup: one `setAttribute`                                 |
| Re-rendering on every scroll event                                                                                                                                                                     | n/a                               | The virtualizer Mount emits `ChangedVirtualWindow` only when rows or offsets change; renders coalesce per frame |
| Rebuilding unchanged rows                                                                                                                                                                              | n/a                               | `createKeyedLazy` keyed `index % 256` (bounded cache, one position per slot)                                    |
| Per-row derivation (time format, chips, severity) on every mount                                                                                                                                       | n/a                               | Derived once per data/pin/timezone change in `update` (`LogRowView`)                                            |

Both should go upstream to Foldkit: skip the walk in production or memoize by reference, and set
`className` when an element is created from a fresh class object.

## Approach and why

- **`@tanstack/virtual-core` in a Mount** (`VirtualizeLogStream`), not `@foldkit/ui` VirtualList.
  VirtualList renders `ul`/`li` with spacer rows and is itself the scroll container, so the sticky
  column header inside the scroller, `role="log"` + absolutely positioned `translateY` rows and the
  legacy overscan cannot be reproduced; the DOM and every pixel would differ. virtual-core is the
  same engine apps/web runs, so window, overscan, measurement and scroll correction match exactly.
- The Mount owns the `Virtualizer` (element-scoped), reads count and layout from data attributes
  the view writes, measures rows through a MutationObserver, and reports the window as a Message.
  React's batching matters for parity: notifications raised while measuring are deferred to a
  microtask, and a wrap/density change re-measures only the rows the new window keeps.
- **No `@tanstack/table-core`.** The logs stream has no column model or client sorting. traces
  uses react-table only for `columnSizingFeature`; its sort is a URL search param run by the
  warehouse. Keep sort and column widths in the Model (route search + a pure resize reducer).
- Keyboard selection is a document Subscription (`navigationKeys`); copies and scroll requests are
  Commands; chip open/close delays are Commands carrying a generation so stale ones are dropped.

## Recommendation for traces, errors, infra

1. One Submodel per table: rows (derived `*RowView` structs), window, focus, selection, sort in the
   Model; view flags in `viewInputs`. Never put row arrays in `viewInputs`.
2. Virtualize with virtual-core through this Mount (generalize `virtualize.ts` to take an item
   selector and estimate). Use VirtualList only for new UI with no React DOM to match.
3. `rowClass` (class attribute) for anything rendered per row; keyed lazy rows with a bounded slot.
4. Sorting/filtering stay in route search + `update`; table-core only if a table needs its row
   models (grouping, client sort over thousands of rows), wrapped as pure functions in `update`.
5. Run `src/bench/logs.ts`-style benches per table before calling it done.

## Not ported (open)

Log detail sheet (row click / Enter), the expanded row body (state and chevron work), row-action
and truncation tooltips, copy toasts and copy-status icons, JSON chip values (`CollapsibleJsonValue`),
the auto-refresh interval menu, `SignalEmptyState`, the attribute filter chip strip. The app
sidebar/topbar in `src/lab/shell.ts` is a generated static stand-in until Phase 2.
