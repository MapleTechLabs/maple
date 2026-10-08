# Dashboard grid

The dashboard canvas is our own grid: `@maple/grid-engine` (`lib/grid-engine`) for the layout
rules, native CSS Grid for placement, and `useGridInteraction` for drag, resize and keyboard
rearranging. It replaced react-grid-layout 2.3.0 (and its `react-draggable`, `react-resizable`,
`prop-types`, `resize-observer-polyfill` and `fast-equals`) in October 2026.

## Pieces

| Where | What |
| --- | --- |
| `lib/grid-engine/src/layout.ts` | Pure layout ops: `normalizeLayout`, `compact`, `moveItem`, `resizeItem`, `nudgeItem`, clamping, `changedItems` |
| `lib/grid-engine/src/geometry.ts` | Cells <-> px: `itemRect`, `cellAt`, `sizeAt` |
| `canvas/dashboard-canvas.tsx` | `DashboardGrid`: normalizes the stored layout, places cells with `grid-column`/`grid-row`, glides moved cells (FLIP) |
| `canvas/use-grid-interaction.ts` | Pointer drag and resize, keyboard rearranging, the single commit |
| `canvas/grid-breakpoints.ts` | Tiers and `projectLayout` (unchanged: Maple's responsive policy, not grid mechanics) |
| `canvas/use-container-width.ts` | One width measurement for the board, taken before first paint |

## Rules worth knowing

- **Parity with the old grid.** Stored boards can overlap or float (MCP writes, imports). The
  engine is a port of react-grid-layout's vertical compaction and push-down, so every stored
  board draws in exactly the cells it drew in before. `test/golden.test.ts` holds 342 frozen
  answers from the library (every built-in template under edits, plus generated dirty boards at
  each tier).
- **Moves settle.** The library's drag step is not idempotent: re-applying it for the same cell
  can carry a tile one more slot down a column, so how far a tile went depended on mouse jitter.
  `moveItem` runs the step to its settled point (where enough jitter would have taken it), so the
  result depends only on the cell.
- **No per-pixel React work.** The lifted tile follows the pointer through a `transform` written
  to its element once per frame. React renders only when the pointer enters a cell that changes
  the layout, and only cells whose item changed (the engine keeps unchanged items' identity).
  Widget content never re-renders during a drag.
- **One drop, one commit,** carrying only the widgets whose box changed against what is stored
  (so a board that needed packing is saved packed). Nothing is reported for tier changes or
  window resizes. The store update is a transition: the dropped layout draws at once and the
  moved tiles re-render in time slices.
- **Only the canonical (12-column) tier is editable.** Narrower tiers are projected at render
  time and drawn uncompacted. Losing edit rights mid-drag cancels it.
- **Keyboard:** the grip is a button. Space/Enter picks up, arrows move (reaching past no-op
  cells), Shift+arrows resize, Space/Enter drops, Escape cancels, moving focus away drops. An
  `aria-live` region announces each step.

## Tests

| Layer | Where | Run |
| --- | --- | --- |
| Engine invariants (fast-check): no overlaps, in bounds, packed, idempotent, identity kept, settles | `lib/grid-engine/test/properties.test.ts` | `bun run --cwd lib/grid-engine test` |
| Frozen react-grid-layout answers | `lib/grid-engine/test/golden.test.ts` | same |
| Geometry by hand and round-trip | `lib/grid-engine/test/geometry.test.ts` | same |
| Placement per tier, drag, resize, threshold, Escape, keyboard, a11y, content never re-rendered | `canvas/dashboard-grid.browser.test.tsx` | `bunx vitest run --project browser src/components/dashboard-builder/canvas` (in `apps/web`) |
| Share-page seams (no actions provider, flush first column) | `canvas/dashboard-canvas.browser.test.tsx` | same |
| Perf gates: 1 mount commit, 0 layout shift, 0 content renders mid-drag, <=30 commits per 180-event drag, no long tasks | `apps/web/perf/dashboard-grid.perf.spec.ts` over `/lab/bench/dashboard-grid` | `bun run --cwd apps/web test:perf:dashboard-grid` |

## Measured against react-grid-layout

`docs/benchmarks/dashboard-grid-2026-10-08.json`, same board, renderer and store semantics. For
one drag across a 50-widget board: 12 React commits instead of 182, ~86 ms of React work instead
of ~495 ms, no dropped frames or long tasks (the old grid had 2 and 1), and the same 28 widgets
moved. Resize: 9 commits instead of 122. Mount: 1 commit instead of 2, no layout shift in either.
