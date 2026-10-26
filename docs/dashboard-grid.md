# Dashboard grid

The dashboard canvas is our own grid: `@maple/grid-engine` (`lib/grid-engine`) for the layout
rules, native CSS Grid for placement, and the dashboard view's gesture and keyboard steps for drag,
resize and keyboard rearranging. It replaced react-grid-layout 2.3.0 (and its `react-draggable`, `react-resizable`,
`prop-types`, `resize-observer-polyfill` and `fast-equals`) in October 2026.

## Pieces

| Where                                                                          | What                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `lib/grid-engine/src/layout.ts`                                                | Pure layout ops: `normalizeLayout`, `compact`, `moveItem`, `resizeItem`, `nudgeItem`, clamping, `changedItems` |
| `lib/grid-engine/src/geometry.ts`                                              | Cells <-> px: `itemRect`, `cellAt`, `sizeAt`                                                                   |
| `apps/web/src/page/dashboards/view/grid.ts`, `view-grid.ts`            | The canvas grid per container: normalizes the stored layout, places cells with `grid-column`/`grid-row`        |
| `apps/web/src/page/dashboards/view/gesture.ts`, `keyboard-move.ts`     | Pointer drag and resize, keyboard rearranging                                                                  |
| `apps/web/src/page/dashboards/view/layout-commit.ts`                   | The single commit on drop                                                                                      |
| `apps/web/src/components/dashboard-builder/canvas/grid-breakpoints.ts` | Tiers and `projectLayout` (Maple's responsive policy, not grid mechanics)                                      |

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
- **No per-pixel render work.** The lifted tile follows the pointer through a `transform` written
  to its element once per frame. The view renders only when the pointer enters a cell that changes
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

| Layer                                                                                              | Where                                                       | Run                                                                |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Engine invariants (fast-check): no overlaps, in bounds, packed, idempotent, identity kept, settles | `lib/grid-engine/test/properties.test.ts`                   | `bun run --cwd lib/grid-engine test`                               |
| Frozen react-grid-layout answers                                                                   | `lib/grid-engine/test/golden.test.ts`                       | same                                                               |
| Geometry by hand and round-trip                                                                    | `lib/grid-engine/test/geometry.test.ts`                     | same                                                               |
| Dashboard view: grid, narrow tiers, sections, share, history (Scene tests)                         | `apps/web/src/page/dashboards/view/*.scene.test.ts` | `bunx vitest run src/page/dashboards/view` (in `apps/web`) |

## Measured against react-grid-layout

`docs/benchmarks/dashboard-grid-2026-10-08.json`, same board, renderer and store semantics. For
one drag across a 50-widget board: 12 React commits instead of 182, ~86 ms of React work instead
of ~495 ms, no dropped frames or long tasks (the old grid had 2 and 1), and the same 28 widgets
moved. Resize: 9 commits instead of 122. Mount: 1 commit instead of 2, no layout shift in either.

## First domain pass: dashboard names

`@maple/domain/dashboard-domain` defines the name context with import and rename commands,
semantic events, typed rejections, an aggregate and a name view. Its in-memory tests cover
serialization, duplicate command IDs, bootstrap conflicts, tenant-qualified keys, receipt
confirmation and reconnecting a view. These runtime guarantees are tested model behavior;
the model is not hosted in production yet.

The v2 PATCH route uses the same rename decision and event fold inside
`DashboardPersistenceService.mutate`, which retries against the latest org-scoped Postgres
row. Postgres remains the authoritative store for every existing caller (dashboard UI, API,
MCP, imports, templates and history restore). Existing dashboards need no migration: each
rename starts with the stored name. Deletion uses the existing row deletion and a later rename
returns not-found; there is no second aggregate that could resurrect it. Existing version
snapshots remain the persistent history. Rename events and Domain command receipts are not
persisted by this adapter, and HTTP PATCH does not gain commandId deduplication.

The browser collection now sends only fields changed between a transaction's original and
modified documents. A stale rename no longer replaces another client's widgets; a widget edit
no longer restores an older name. Concurrent changes to the same array still use replacement
semantics. The existing optimistic collection, Postgres txid confirmation and Foldkit
`documentStream` subscription remain the production live-update path. A Domain view subscription
has not replaced Electric, and the separate Local UI is unaffected.

A persistent Domain cutover must move **all** writes for this context together, bootstrap
without overwriting live edits, preserve deletion tombstones, and make any Postgres projection
idempotent and explicitly eventually consistent. Production reads would need receipt-based
read-your-own-write behavior. The new model has no public Api: HTTP session/preview auth and
WebSocket cookie, origin and tenant authorization must be implemented before exposing it.

EU deployment is also unresolved for Domain hosting in beta.84: Cloudflare supports
[`namespace.jurisdiction("eu")`](https://developers.cloudflare.com/durable-objects/reference/data-location/),
but the installed Domain platform uses unqualified `getByName` calls and its exported
`DurableObjects` layer has no jurisdiction option. Do not mount this model on that platform
for EU tenants until namespace selection is explicit. No new Durable Object, projection,
WebSocket endpoint or deployment flag is introduced by this first pass.
