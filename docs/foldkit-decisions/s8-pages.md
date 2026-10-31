# S8: The page pattern

Status: **decided** · 2026-10-17 · first page: `/services` (`apps/web-foldkit/src/page/services/list/`)

Every area agent copies this. A page is a Submodel the root builds on route entry and drops on
leave (Hazel). Adding one touches the root in exactly one place: an entry in `page/registry.ts`.

## Layout

| File (`page/<area>/<page>/`) | Contents                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `model.ts`                   | `Model` Schema: the route's `search`, `Keyed` slots, UI state. Row schemas mirror the web-data types |
| `message.ts`                 | `Message` (past-tense facts)                                                                         |
| `command.ts`                 | Fetch Commands over `@maple/web-data` functions, Mounts the page needs                               |
| `update.ts`                  | `init(route, context)`, `update(model, message, context)`, `routeChanged`, `contextChanged`          |
| `derive.ts`                  | Pure derivations of the legacy component logic (grouping, health, deploy info)                       |
| `view.ts`, `view-*.ts`       | `view = Submodel.defineView<Model, Message, PageViewInputs>` and its parts                           |
| `subscription.ts`            | Live queries, keyed on `context`                                                                     |
| `index.ts`                   | `entry = definePage("Id", { Model, Message }, { routes, key? })`, `page = entry.lazy(...)`           |
| `implementation.ts`          | `implementation = implementPage(entry, { init, update, view, subscriptions, ... })`                  |
| `*.scene.test.ts`            | Scene tests of the update logic                                                                      |

Shared pieces live in `page/kit/` (layout, time controls and picker, empty states, presence) and
`ui/` (primitives). Register the page: `import * as X from "./area/page"` and append `X.page` to `pages`.

## Contract (`page/contract.ts`)

- **Context.** `PageContext = { orgId, pinnedNamespace, timeZone }`, computed by the root
  (`pageContextOf`) and passed to `init`/`update` and the view (`inputs.context`). Never copy it into
  the Model. A new org builds a new instance; a pin or zone change calls `contextChanged`.
- **Routes.** `definePage(id, schemas, { routes: ["Services"], key? })`. The instance survives while
  `key(route)` (default: the tag) is unchanged; a search change arrives as `routeChanged`.
- **Lazy code.** Only `index.ts` (schemas, routes, key) loads with the app. `implementation.ts` loads
  on first entry or link intent (`loadPageCode`); until then the root shows the page skeleton. Keep
  `model.ts` and `message.ts` free of view and update imports, or they pull the page back into startup.
  The open page's Subscriptions run in the registry's slots (`page.0` ... `page.23`), one per entry.
- **Out.** The page never touches the URL or shell state. It returns a `PageOutMessage`:
  `RequestedNavigation({ url, isReplace })` (build the URL with `hrefOf(AppRoute.X({ search }))`,
  the same TanStack search encoding legacy writes) or `RequestedNamespacePin`.
- **Frame.** The shell renders the top bar; the page renders `PageLayout.Body` with
  `dashboardPage(h, { filters, actions }, children)` (`page/kit/dashboard-page.ts`) and its
  breadcrumbs via the spec's `breadcrumbs(model)`.

```ts
// index.ts
export const entry = definePage("ServicesList", { Model, Message }, { routes: ["Services"] })
export const page = entry.lazy(() => import("./implementation"))

// implementation.ts
export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: () => [{ label: "Services" }],
})
```

## Data (S6 applied)

- Window: a `ResolveWindow` Command reads the clock and resolves `search` + default preset with
  `resolveWindow` (`data/time-range.ts`), snapped on `Load`, unsnapped after a Reload
  (legacy's `refreshVersion`). Its Message carries `nowMs` for relative times in the view.
- One `Keyed` slot per legacy atom read; the key is `requestKey(orgId, "<function>", input)` with the
  namespace pin applied first (`applyGlobalNamespace` "top" = `namespaces: [pin]`, no excludes).
- `Keyed.request(slot, key, mode)` returns the slot and the fetch, `Keyed.accept` drops stale answers.
  Fetch Commands map errors with `toLoadFailure` (the `displayError` body), so `ErrorState` renders it.
- Blocking like `Result.all(...)`: `AsyncData.all([...])` + `matchData` → skeleton, `errorState`, data.
  `Refreshing` is legacy's `waiting` (`refreshingClass`).
- Requests legacy only sends once a component mounts (commit lookup) are sent from a Mount on that
  element, after it painted, never earlier: the behavior diff counts every call.
- Signal presence is the exception: every page asks at `init` through `loadSignalPresences`
  (`readThrough`, 30 s buckets per org), so an empty state knows absent from loading before it paints
  and its copy never flips. The paint-triggered `MountEmptyState` path is gone.
- Live queries: `liveQueryStream` over `OrgCollections`, Messages carry `orgId`, dropped otherwise.

```ts
keyed(
	model.overview,
	requestKey(org, "getServiceOverview", { data: input }),
	mode,
	(overview) => ({ overview }),
	(key) => FetchOverview({ key, input }),
)
```

## Preload (link intent)

Legacy's router runs `defaultPreload: "intent"`: a `<Link>` hovered or focused for 50 ms
(`defaultPreloadDelay`), or touched, runs the target route's loader, which `warmAtoms` the requests
the page will read and holds them 30 s. The root mirrors it (`page/preload.ts`):

- A page whose legacy route has a loader declares `preload(route, context, nowMs)`: the fetch
  Commands its own `init` (or its first window load) sends, picked by name with `pickCommands`, so
  the keys match by construction. Build them the way the loader does (e.g. `/services` ignores the
  namespace pin there). Pages: services list, traces list, trace detail, replays list, replay detail.
- The root listens for `mouseover`/`mouseout`/`focusin`/`focusout`/`touchstart` on internal links,
  waits the delay per href (cancelled on leave or blur), reads the clock and runs the target page's
  `preload` under that route's context. A `mouseover` counts only when the pointer moved there
  (its position differs from the last `mousemove`): a link appearing under a resting pointer, as
  when an overlay unmounts, is not hovered for React's `onMouseEnter` either.
- Preload Commands read through the `ReadCache` (s6 "Read cache"), so a key already preloaded or
  held by the open page is answered there, and the opening page's own reads join or reuse the
  preload. Their result Messages are dropped; unused keys are released after the 30 s hold.
  Every page step's keys are held for its instance (`Preload.held`) and released when it changes.

## Search params

The route union decodes the legacy `validateSearch` schema (`route/search.ts`), so `route.search`
is typed. Filter clicks compute the next search and return `RequestedNavigation`; the root pushes
the URL, re-enters the route and the page gets `routeChanged`, which re-resolves and re-requests.
Rows link with `<a href={hrefOf(...)}>`; the root's `ClickedLink` routes them.

## Charts, overlays, refresh

- Canvas charts embed through `h.submodel` with a constant `Chart.init()` (sparklines) and
  `ResolveThemeColors` on the page root; render the table once theme and chart runtime are ready.
- The time picker is `page/kit/time-range-picker.ts` (a Popover Submodel); its `SelectedPreset`
  OutMessage becomes the page's navigation (`applyTimeRangeSearch`).
- Reload: `ClickedReload` bumps `refreshVersion`, resolves unsnapped, and spins 600 ms.

## Testing

Scene tests drive `update` with a fixed context: `scene({ update: (m, msg) => update(m, msg, ctx),
view: withViewInputs(view, { context })() }, given(model), ...)`. Resolve every Mount the view
mounts (`ResolveThemeColors`, the page's own). Race tests go through `update` directly.
Import Scene's `expect as expectView` so the test-slop rule sees vitest's `expect` assertions.

## Page done

- [ ] `route-<page>` and `route-<page>-empty` (and loading/error if a dataset exists) identical,
      light and dark, 0 behavior diffs, 0 unmocked calls, no console errors
- [ ] Interaction scenarios in `packages/ui-parity/src/scenarios/<area>-page.ts` (filters, sorting
      or grouping, hover, time range)
- [ ] Scene tests for entry, stale answers, navigation out, empty state
- [ ] `bun run --cwd apps/web-foldkit typecheck`, `bunx vitest run src/page/<area>`,
      `oxlint -c .oxlintrc.effect.json --quiet apps/web-foldkit/src` clean
- [ ] Gaps listed as `TODO(...)` in the page and in the report

## Mobile (below `lg` and `md`)

Scenarios: `packages/ui-parity/src/scenarios/mobile.ts` (390 px, every responsive page, its filter
sheet, the nav and org switcher sheets, the top pages' loading and error states).

- **Rails.** Pages keep rendering their rails inline (`dashboardPage`). Below `lg` the shell lifts
  `page-filter-sidebar` / `page-right-sidebar` out of the body (`shell/page-rails.ts`), draws
  "Open filters" / "Open context" in the top bar and shows each rail in a sheet. A rail that is
  not on screen mounts nothing, so its own reads (facets, model detection, GitHub status) go out
  from a Mount on the rail (`MountFilterRail`), as legacy's sidebar reads as it renders.
- **Sidebar.** Below `md` the sidebar's reads wait for its sheet to open. A page that reads
  `useInfraSurfaces` itself returns `RequestedInfraSurfaces`.
- **Branching layouts.** `PageViewInputs.isMobile` (`max-md`) and `isBelowSm` (`max-sm`) for the
  few views that branch in JSX (the analytics chart margin).

## Gotchas

| Gotcha                                                                                                                                        | Fix                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A Submodel view returns one node, but `PageLayout.Body` holds the rail and content as siblings                                                | The page renders the body itself (`dashboardPage`); the shell takes `page: () => Html` |
| Sending a mount-time request early (with the data) changes pixels: corners re-raster differently when content is swapped in after first paint | Send it from a Mount after paint (`MountEmptyState`, `MountTable`)                     |
| `Date.parse` is lint-banned                                                                                                                   | `DateTime.make(iso)` → `DateTime.toEpochMillis`                                        |
| Dictionary constants typed `Record<string, …>` trip `no-known-value-widening`                                                                 | `new Map(...)` or `satisfies`                                                          |
| Base UI `useId` ids differ                                                                                                                    | Pixels and roles only; ids are not compared                                            |

## Open (from /services)

Empty variants are `identical`; loaded ones `pass` with 0 perceptual px and 0 behavior diffs:
6 to 30 strict px of rounded-corner anti-aliasing, and in the filtered view the last pixel column
of redrawn sparklines (88 canvas px in 87.16 CSS px), differ by repaint timing. Legacy's `PlotFrame`
calls `adapter.update` on every row render; `rowRevision` mirrors that, and React's fragment keys
(regrouped rows remount) are mirrored in the row keys. Ported since: the row tooltips, the commit
hover card, `UnnamedServiceHint`, Alt+click exclusion (a root Subscription presses the row's
Exclude: `OnClick` has no modifiers) and the session time range (`route/session-time-range.ts`,
applied on navigation and to a hovered link's preload). Not ported: the picker's shorthand input,
recent ranges, timezone select, custom tab and `D`.

Legacy's retained atoms answer a second reader without a request. Shared reads are resources
(`ServicesFacetsProbe`, `AnomalyServiceCounts`, `IntegrationStatuses`), and Reload refreshes
only what legacy reads through `useRefreshableAtomValue` (every other slot requests in `Load`).
