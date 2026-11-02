# @maple/views roadmap

`packages/views` holds the Foldkit kit (`ui/`), charts and the service map. `apps/web` and
`apps/local-ui` import it as `@maple/views/*`; the goal is that a view is built once and every
Foldkit surface (dashboard, Maple Local, marketing site) uses it.

## Shape of a shared view

A shared view takes its data through its Model and reports what it needs as an `OutMessage`
(`Requested*`). It never fetches, never reads the org or the route, and never navigates: the app
turns `RequestedTrace { id }` into a URL (`apps/web`) or a hash (`apps/local-ui`). A plain link the
reader may open in a new tab takes its href from the app as a view input (the log sheet's
`traceHref`). Where a view needs Commands that load data, they go through one service per signal
(for example `TraceSource`: `listTraces`, `spanDetail`, `spanLogs`; `LogSource` for the log
sheet), provided by `@maple/web-data` in the dashboard and by `CH.compile` plus `/local/query` in
Maple Local. `ui/logs/logs-stream.ts` (rows handed in by the
parent) is the working example.

## Maple Local onto shared views

Ranked by duplication removed per effort.

1. **Logs list onto `ui/logs/logs-stream`.** Map `LocalLog` to `LogRecord` and delete
   `apps/local-ui/src/page/logs/{view-row,view-chip-card,virtualize,view-highlight,update-chips,stream}`
   (about 600 lines). Local gains density, pinned columns, expanded rows and keyboard navigation.
2. **Small helpers.** One `chartUnitFromOtel` (local handles `%` and `1`, web handles bytes; each
   is wrong where the other is right). Local's `kit/view-states` onto `ui/error-state`,
   `ui/empty`, `ui/skeleton`; its toolbar onto the time controls.
3. **Span panel with injected data.** The panel's Model takes `detail` and `logs` from the parent
   behind `TraceSource`, and infra correlation becomes an optional tab. Removes local's
   `partsModel` stand-in and the import chain that pulls web routing and infra pages into the
   Maple Local bundle.
4. **One async slot.** Web's `Keyed` and local's `Slot` are the same idea with forked fields and
   two `LoadFailure` shapes. Merge them into `@maple/views/data`. Prerequisite for 5 and 6.
5. **Log detail sheet.** Done: `logs/log-sheet` reads through `LogSource` (`listLogs`,
   `traceSpans`); the app passes its trace URL, log page path and an optional Infrastructure
   tab. Local's fork is gone.
6. **Whole page Submodels:** traces list, metrics browse, the service map side panel, the signal
   empty state. Each takes a page-context adapter (time format, navigation OutMessage) and a
   source service.
7. **Drop the `@maple/web/*` alias** from `apps/local-ui` once nothing imports `apps/web/src`.

Sessions, errors and the app shell stay separate (Postgres-backed issues, Clerk).

## Marketing site (`apps/landing`) off React

The site's React islands (NavBar, docs search, pricing calculators, trace visualization, logs
volume chart, hero CTA, logo context menu, GitHub star button) move to Foldkit or plain Astro.

- **Mounting.** Islands cannot hydrate (Foldkit hydrates one application per document). Render
  each on the server with `renderToString(config, { isHydratable: false })` for SEO and no layout
  shift, then start `Runtime.makeElement({ container, ... })` on the client. A small Astro
  renderer integration keeps `client:visible` and `client:idle`.
- **Order.** Static pieces first (GitHub star button, icons from `ui/icons.generated`, hero CTA as
  a script); then the renderer with the pricing calculator, measuring bundle size before going
  further (the site ships React today and would ship Foldkit plus Effect); then the logs chart,
  docs search, NavBar with Clerk loaded the way the dashboard does, and the trace visualization
  (trace flow exists in `service-map/trace-flow`; the flamegraph tab needs a port or the waterfall).
- **Then delete** `@astrojs/react`, `react`, `react-dom`, `@clerk/clerk-react`, and the React
  half of `packages/ui` (`components/ui/*.tsx`, `components/icons`, the React trace and plot
  components, `hooks/`, their browser tests) with `@base-ui/react`, `@xyflow/react` and
  `@testing-library/*`.
