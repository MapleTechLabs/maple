# S5: The xyflow canvases (service map, trace flow) in Foldkit

Status: **passed** · 2026-10-17 · Branch `worktree-agent-abddce81c5575b6b9` (from `fk/parity-harness`)

Question: can the `@xyflow/react` canvases (26 files) move to Foldkit at pixel parity without losing
performance? Ported: `/lab/flow` (`TraceFlowView` in the dashboard shell) and `/lab/bench/service-map`.

## Option chosen: (a) `@xyflow/system`, DOM rendered by Foldkit

`@xyflow/system` is React Flow's framework-free core (Svelte Flow runs on it). `XYPanZoom` is the
exact d3-zoom setup React Flow uses (wheel delta, filter, click distance, scale extent), and
`getSmoothStepPath` / `getViewportForBounds` are the exact path and fit math. Option (b), hand-built
d3-zoom, would have re-derived all of that; with (a) the wheel-zoom scenarios are strictly identical
on the first try. Shape (`apps/web-foldkit/src/service-map/xyflow/`):

- The **Model owns the camera**, pane size and per-node measurements (`canvas.ts`, a Submodel).
- One Mount on `.react-flow__renderer` (`attach.ts`) runs `XYPanZoom`, a pane ResizeObserver and
  node measurement (offset size plus handle bounds, as `updateNodeInternals` does), all returned as
  Messages. Model-driven camera moves (fits, zoom buttons) reach d3 via `syncViewport` right before
  the next gesture, read from a data attribute.
- The view renders React Flow's DOM class for class (`view.ts`, `panels.ts`). Node, edge, minimap
  and particle layers are `createLazy` slots keyed on graph, layout and measurements, so a pan
  frame only patches the viewport transform, background pattern, minimap mask and controls.
- ELK stays in its worker behind a Command, as does the 2 s fallback; particles are a canvas Mount.

## Parity (`--baseline legacy-head --candidate foldkit`, desktop light + dark)

| Filter                                                                 | Result                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `lab-bench-service-map` (default, small graph, hover node, wheel zoom) | **8/8 identical**, strict 0 px, 0 behavior diffs         |
| `lab-flow` (default, hover node, select node, wheel zoom)              | 8/8 visual **pass**: 0 perceptual px, 32 to 89 strict px |

`lab-flow` reports `fail` only because the **legacy** capture is unhealthy: the legacy sidebar fires
API calls without a session (six 401s and a live-query error) on every lab page in the shell. The
Foldkit capture has no console errors. The strict px are one row under backdrop-blurred edge-label
pills, at most 2/255 per channel; the canvas DOM is otherwise identical (`domdiff`). Legacy-side
refactors were proven neutral: pre- vs post-refactor legacy captures are visually identical (16/16).

## Performance (5 runs each, p50 / p95, static parity builds, headless Chromium, Apple M5 Max)

Bench at 120 services / 400 edges, the spec's measurements (`apps/web-foldkit/perf/service-map-bench.ts`):

| Metric                                    | Legacy                                | Foldkit                   |
| ----------------------------------------- | ------------------------------------- | ------------------------- |
| first map on screen (fallback layout), ms | 2275 / 2282                           | 2187 / 2201               |
| ELK layout on screen, ms                  | 4154 / 4583                           | 4077 / 4124               |
| idle fps · frame p95 ms · TBT             | 60 · 16.7 · 0                         | 59.9 · 16.7 · 0           |
| pan fps (p50 / p95)                       | 52.6 / 59.8                           | 52.6 / 52.8               |
| pan frame p50 / p95 ms · TBT              | 16.7 / 33.3 · 0                       | 16.7 / 33.4 · 0           |
| fit-all (whole graph) fps                 | 13.3 / 13.8 (earlier run 12.8 / 13.1) | 12.6 / 12.8 (12.6 / 13.2) |

Within noise of legacy (fit-all moved between runs on both sides): pan script time is lower than
React's (0.08 s vs 0.11 s per 3 s); frame drops are shared raster work. Startup unchanged (lab is lazy); `@xyflow/system` + d3 is 21 KB gzip.

## Gotchas

1. **A per-frame attribute on an ancestor costs a 30 ms style recalc** (Tailwind attribute and
   `:has` selectors). The camera attribute first lived on the renderer and pan ran at 40 fps; it
   now sits on the empty `.react-flow__viewport-portal` leaf.
2. **Handle positions come from the DOM.** React Flow's 0-size handles still have a 2 px border box,
   and it divides by the zoom read from the computed transform (`m22`). The trace flow re-measures
   once after its first fit (legacy re-adopts its initial nodes on `onInit`); `Canvas.remeasure`
   reproduces that, otherwise edge paths differ by 1e-4 px and pixels follow.
3. **Text nodes must split where JSX interpolates** (`×{count}`, `{" "}`): shaping and the
   structural diff see separate runs.
4. **Data modules that carry React icon components** cannot be imported. `service-map-db.tsx` was
   split into `service-map-db-style.ts` (icon keys) so `service-map-utils`, `-elk`, `-declutter`
   import unchanged; the bench generator moved to `service-map-bench-fixture.ts`. `span-category`,
   `cloud-platforms`, `flow-utils`, `service-map-runtime` and the particle budget are copies marked
   `copied:`; Phase 1 should split them the same way. Icons render from `@maple/ui` via
   `scripts/generate-icons.ts`.
5. `@xyflow/react/dist/style.css` is vendored (`react-flow.css`) and loads with the lab chunk.
6. Importing the pure helpers statically makes the `import()` of `XYPanZoom` ineffective (one
   module); splitting it out means vendoring ~200 lines of path and fit math.
7. Scene: a mapped Mount resolves by name with the lifted Message. `parity codegen` gives void
   elements a children argument (`h.input(..., [])`).

## Legacy bugs found

- With namespace groups (`?groups=3`) the map **never frames itself**: the camera stays at 0,0,1,
  deterministically. The port fits; box geometry matches exactly. No scenario was kept for it.
- `findSpanById` splits combined node ids on `-`, so combined cards whose span ids contain `-`
  cannot be selected. Ported as is.

## Not ported in this spike

Node drag (`XYDrag`), the service and database detail panels (selection state and its tests exist;
the resizable split does not), toolbar and legend popups (rendered closed), tooltip popups, the
300 ms animated refit, camera and drag persistence, the bench's `runReact` / `runStability`
scenarios, and the Base UI toast regions (two a11y-only deltas on every variant).

## The 3D map

`components/service-map/three` is 5.8k lines of React Three Fiber JSX (`scene.tsx`, `maple-props`,
factory and scenery files, `useFrame` loops) over pure modules (`graph`, `spatial-layout`,
`factory-routing`, `live-topology`, `appearance`) that can be reused. Porting means rewriting the
JSX scene graph as vanilla three object construction inside one lazy Mount that consumes the same
`EffectiveGraph`, emits raycast selection as Messages, and leaves labels and the inspector to
Foldkit views. No blocker found; size it as its own task.
