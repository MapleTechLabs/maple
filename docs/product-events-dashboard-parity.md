# Product events as a first-class dashboard source — plan

Status: **phases 1 through 5 built 2026-09-13** on `feat/product-events-query-source`
(PR #877). Verified end to end against a seeded local Tinybird: the Top Events, Events by Page and
Recent Events tiles, a four-step person-stitched funnel built in the step editor, and an alert rule
prefilled from a product-event widget all ran through the real stack. Phase 6 (deleting the last
funnel special cases: `FunnelSource: "query_set"`, `isProductEventsFunnel` as a gate) is still open;
so is the `SignalEmptyState` wiring, which cannot be exercised on an org that has events.

## Where it stands today

Dashboards know three query-builder sources: `traces`, `logs`, `metrics`
(`QUERY_BUILDER_DATA_SOURCES` in `packages/query-model/src/query-draft.ts`). Each is a
`QueryBuilderQueryDraft` variant that lowers to a `QuerySpec` (`packages/domain/src/query-engine.ts`)
and runs through the query set (`packages/query-engine/src/query-set/*`), so every panel type,
formula, comparison, alert rule, template and MCP tool gets it for free.

Product events are not one of those. They reach dashboards through exactly one door: the funnel
widget's own `product_events_funnel` route (`PRODUCT_EVENTS_FUNNEL_ENDPOINT` in
`packages/widgets/src/dashboard/construct.ts`), edited by `FunnelQueryPanel`, which the query
panel shell explicitly documents as NOT a `QueryBuilderDataSource`
(`apps/web/src/components/dashboard-builder/config/query-panel-shell.tsx`). Concretely, today you
cannot:

- chart `signup_completed` per day as a line, stat, bar or pie;
- break events down by name, host, page path, country, service or a `track()` prop;
- list the most recent events in a table widget (`ListDataSource` is `"traces" | "logs"`);
- combine an event count with a trace or log query in a formula (`A / B` conversion-style ratios);
- alert on an event count (`AlertRuleModel` and the alert evaluator accept traces/logs/metrics only);
- author it from MCP (`query_data`, `create_dashboard` reject anything but the three sources;
  `describe_dashboard_schema` never mentions it);
- get "Product events" in the source select on any panel but the funnel's first one.

Everything below mirrors how `logs` became first-class, layer by layer, because `logs` is the
closest sibling: count-only aggregation, a small closed group-by set, a filter struct, and a list
shape. Product events add one thing logs lack: `Attributes` is a `Map(String, String)` of user
props, so `attr.<key>` filters and group-bys matter more than they do for logs.

## Target: what "the same" means

| Capability               | traces / logs / metrics                       | product_events after this plan                                                                      |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Source select            | every panel                                   | every panel; funnel keeps its dedicated step editor as a second mode                                |
| Aggregations             | per-source list                               | `count`, `uniq(sessions)`, `uniq(persons)`, `uniq(users)`, `uniq(visitors)`                          |
| Where clause             | `service.name`, `attr.*`, `resource.*`, …     | `event.name`, `event.kind`, `source`, `host`, `page.path`, `service.name`, `user.id`, `group.id`, `attr.*` plus the session dimensions (`country`, `referrer.host`, `utm.*`, `device.type`, `browser`, `os`) |
| Group by                 | closed set + `attr.` / `resource.`            | `event.name`, `event.kind`, `source`, `host`, `page.path`, `service.name`, `group.id`, `attr.<key>`   |
| Shapes                   | timeseries, breakdown, list                   | all three                                                                                           |
| Formulas / comparisons   | yes                                           | yes (falls out of the query set)                                                                    |
| Alerts                   | yes                                           | yes, `sampleCountStrategy: "product_event_count"`                                                    |
| MCP `query_data`         | yes                                           | yes                                                                                                 |
| `create_dashboard` spec  | yes                                           | yes                                                                                                 |
| Templates / gallery      | per-source tiles                              | "Events over time", "Top events", "Events by page", "Recent events" tiles                            |
| Empty state              | `SignalEmptyState` per signal                 | already exists for `product_events`; wire it to the panel                                          |

Out of scope: retention/cohort charts, per-person timelines, session step semantics outside the
funnel. The funnel's `keyBy` / `identity_links` person stitching stays funnel-only; the query-set
path uses the row's own `if(UserId != '', UserId, VisitorId)` for `uniq(persons)` without the join
(the join is what makes funnels expensive and is not needed for a count).

## Phases

Each phase is independently shippable and typechecks on its own. Order matters: every later phase
hangs off the `QuerySpec` arms from phase 1.

### Phase 1 — the engine: `product_events` as a `QuerySpec` source

**Domain (`packages/domain/src/query-engine.ts`)**

- `ProductEventsFilters`: `eventNames?`, `kinds?` (`navigation | custom | screen`), `sources?`
  (`browser | server | mobile | trace`), `hosts?`, `pagePaths?`, `serviceNames?`, `userIds?`,
  `groupIds?`, `attributeFilters?: AttributeFilter[]`, plus the session-dimension filters reused
  from `WebAnalyticsFilterFields` (`country`, `referrerHost`, `utm*`, `deviceType`, `browserName`,
  `osName`, `language`, `visitorType`). Excluded-variants (`excludedEventNames`, …) to match logs'
  `!=` support.
- `ProductEventsTimeseriesQuery`: `kind: "timeseries"`, `source: "product_events"`,
  `metric: "count" | "sessions" | "persons" | "users" | "visitors"`,
  `groupBy?: ("event_name" | "kind" | "source" | "host" | "page_path" | "service" | "group" | "attribute" | "none")[]`,
  `filters?`, `bucketSeconds?`, `seriesLimit?`. `groupByAttributeKey` lives in filters as it does
  for metrics.
- `ProductEventsBreakdownQuery` (same metric + groupBy minus `none`, `limit ≤ 100`).
- `ProductEventsListQuery` (`filters?`, `limit ≤ 200`, `cursor?`, `columns?`).
- Add all three to `QuerySpec`; widen the `timeseries` / `breakdown` / `list` arms of
  `QueryEngineResult` to include `"product_events"`. Add `"product_events"` to `AttributeKeysQuery`
  and `AttributeValuesQuery` sources so the where-clause autocomplete can discover `attr.*` keys.

**CH DSL (`packages/query-engine/src/ch/queries/product-events.ts`)**

- `productEventsTimeseriesQuery`, `productEventsBreakdownQuery`, `productEventsListQuery`,
  `productEventsAttributeKeysQuery`, `productEventsAttributeValuesQuery`. All `from(ProductEvents)`,
  `OrgId` param, `Timestamp` range. Session dimensions go through the existing `replaysSemiJoin`
  helper in `web-analytics.ts` so the numbers match the `/analytics` page byte for byte.
- Metric lowering: `count()`, `uniq(SessionId)` (excluding `''`), `uniq(if(UserId != '', UserId, VisitorId))`,
  `uniq(UserId)`, `uniq(VisitorId)`, each with the empty-string guard.
- `group: "attribute"` reads `Attributes[key]`; use `mapContains` in the WHERE for filters so the
  `set(64)` index on `EventName` still prunes when an event filter is present.
- List columns: `timestamp`, `eventName`, `kind`, `source`, `host`, `pagePath`, `serviceName`,
  `userId`, `visitorId`, `sessionId`, `traceId`, `attributes`. Cursor on `(Timestamp, Seq)`.
- `rowSchema`s use `CH.CHNumber`. Add cases to `packages/query-engine/src/benchmark/catalog.ts`
  so the SQL catalog gate and the UInt64 `toString()` sweep cover them.
- Export from `src/ch/index.ts`.

**Registry + runtime**

- `packages/query-engine/src/registry/product-events.ts`: `productEventsTimeseries`,
  `productEventsBreakdown`, `productEventsList` via `defineQuery` with `timeRangeCache`
  (`makeTimeBucketQueryCachePolicy` for the timeseries, as logs does).
- `packages/query-engine/src/runtime/query-engine.ts`: three new branches beside the logs ones
  (`source === "product_events" && kind === …`). `resolveAttributeScope` learns `product_events → "event"`.
- `packages/backend/src/services/warehouse/QueryEngineService.ts`: `migratedDefinitionFor` routes
  the timeseries arm to the definition so it gets the bucket cache, like logs.
- Missing-table handling: `isMissingProductEvents` (`packages/backend/src/services/warehouse/missing-table.ts`)
  already exists; the new branches surface it as the same structured error the funnel route does,
  so a BYO cluster below schema 21 gets the "apply schema" message rather than a 500.

**Tests**: `product-events.test.ts` (compile snapshots), `query-engine.test.ts` branches, and a
`web-analytics-parity.clickhouse.e2e.test.ts` case asserting the timeseries `count` for
`kind = navigation` equals `webAnalyticsPageviewsTimeseriesQuery` on the seeded data.

### Phase 2 — the draft: `product_events` in the query builder model

- `packages/query-model/src/query-draft.ts`: add `"product_events"` to
  `QUERY_BUILDER_DATA_SOURCES`; `ProductEventsQueryDraftSchema` = base fields +
  `dataSource: Schema.Literal("product_events")`. Union it in. This is the persisted shape for
  BOTH widgets and `alert_rules.query_builder_draft_json`, so it is additive only.
- `packages/query-engine/src/query-builder/model.ts`:
  - `AGGREGATIONS_BY_SOURCE.product_events` = count, sessions, persons, users, visitors.
  - `GROUP_BY_OPTIONS.product_events` and `GROUP_BY_TOKENS.product_events`
    (`event.name`, `event.kind`, `source`, `host`, `page.path`, `service.name`, `group.id`, `attr.`, `none`).
  - `applyProductEventsClause` mirrors `applyLogsClause`: `event.name`, `event.kind`, `source`,
    `host`, `page.path`, `service.name`, `user.id`, `group.id`, `attr.<key>`, and the session keys
    the funnel population filter already parses (`country`, `referrer.host`, `utm.source`, …,
    reuse `productEventsFilterField` from `apps/web/src/lib/query-builder/funnel-filters.ts` by
    lifting it into `@maple/query-model` where `FUNNEL_POPULATION_FILTER_FIELDS` already lives).
  - `buildTimeseriesQuerySpec` gains the `product_events` branch; `buildBreakdownQuerySpec` and
    `buildListQuerySpec` fall out.
  - `resetQueryForDataSource` handles it (nothing metric-specific to carry).
- `packages/backend/src/dashboard-templates/helpers.ts`: accept the new source in `makeQuerySpec`.
- Tests in `model.test.ts`: clause parsing table, group-by resolution, aggregation guard.

### Phase 3 — the builder UI

- `query-panel-shell.tsx`: delete the `QueryPanelSource = QueryBuilderDataSource | "product_events"`
  special case. `product_events` is now a `QueryBuilderDataSource`; `QUERY_BUILDER_PANEL_SOURCES`
  lists four. Label stays "Product events".
- `widget-query-builder-page.tsx`: the funnel-only `extraSourceOptions` / `onExtraSourceChange`
  plumbing goes. The funnel widget's mode switch becomes: source `product_events` on query A with
  `visualization === "funnel"` shows the step editor (`FunnelQueryPanel`) INSTEAD of the generic
  aggregation row; any other source on a funnel shows the plain panel as today. `FunnelSource`
  in `widget-builder-shared.ts` collapses to a derived value rather than stored state.
- `query-panel.tsx`: for `product_events`, the aggregation select shows the five metrics; the
  where-clause editor gets `scope: "product_events_query"` (new) in
  `where-clause-autocomplete.ts` whose key list is the phase-2 vocabulary. Values come from
  `useFunnelSuggestions` (event names, page paths, session facets) plus an `attributeValues`
  query for `attr.<key>`; put the hook behind `useAutocompleteValuesContext` so every panel
  gets it, not only the funnel.
- `use-widget-builder-data.ts`: fetch event names when any query is `product_events`, the way it
  fetches the metric catalog when any is `metrics`.
- `widget-builder-shared.ts`: `unitForQuery` → `"number"`; `autoTitle` → "Count of events",
  "Sessions with events", … ; `draftFromStored` accepts the new literal.
- List widget: `ListDataSource` becomes `"traces" | "logs" | "product_events"`;
  `list-widget-config.ts` gets `PRODUCT_EVENT_FIELDS` and the `attributes.` prefix;
  `list-config-panel.tsx` renders the third radio. Row click on a row with `traceId` opens the
  trace, reusing `product-event-trace-samples.tsx`'s link.
- Widget gallery (`widget-definitions.ts`): "Events over time" (line, count by `event.name`),
  "Top events" (bar breakdown), "Events by page" (pie, `page.path`), "Recent events" (list). Keep
  "Product-event funnel".
- Empty state: when the panel's source is `product_events` and `useSignalPresence` says `absent`,
  render `SignalEmptyState` for `product_events` under the panel, as the explorers do.
- `auto-contexts.ts`: `/analytics` already maps; nothing to do.

### Phase 4 — alerts

- `packages/backend/src/services/alerts/AlertRuleModel.ts`: `sampleCountStrategy` gains
  `"product_event_count"`; the evaluator (`makeQueryEngineEvaluate` /
  `makeQueryEngineEvaluateSeries` in `runtime/query-engine.ts`) gets a `product_events` branch
  reading `count` as `sampleCount` like logs, and the "supports traces, logs, and metrics" guard is
  widened. `alert-signal-display.ts`: label "Event count" / "Sessions with events", unit `count`.
- Web: `apps/web/src/lib/alerts/form-utils.ts` and `signal-and-threshold-section.tsx` accept the
  source; the where-clause editor gets the same scope as the dashboard panel.
- Alert templates: one "Signups dropped" example under `alert-templates/` is enough to prove the
  path; don't build a catalogue.

### Phase 5 — agents and public surfaces

- `apps/ai/src/mcp/tools/query-data.ts`: `source` accepts `product_events`; new params
  `event_name`, `event_kind`, `host`, `page_path`; `metric` doc lists the five aggregations;
  `group_by` doc lists the tokens. `create-dashboard.ts` widget specs accept it via
  `toQueryBuilderDataSource`.
- `describe-dashboard-schema.ts` is generated from `AGGREGATIONS_BY_SOURCE` / `GROUP_BY_TOKENS`,
  so it updates itself; verify with its test.
- `explore_attributes`: `source: "product_events"` backed by the phase-1 attribute-keys query.
- `mcp-structured-types.ts`: `source` union on the `query_data` structured output.
- `inspect-widget.ts` and `add-dashboard-widget.ts`: nothing structural; update the
  `data_source_json` description string.
- v2 public API: `packages/domain/src/http/v2/telemetry-signals.ts` already lists the signal.
  No new v2 endpoint; product events are queried through the same widget/query-set routes.

### Phase 6 — retire the special case

- `product_events_funnel` route and `makeProductEventsFunnelDataSource` STAY: a funnel is a
  different query shape (windowFunnel + identity join), not a count. What goes is every place that
  treats "product events" as not-a-source: `QueryPanelSource`, `extraSourceOptions`,
  `FunnelSource: "query_set"`, `isProductEventsFunnel` as a gate on the source select.
- `docs/product-events-funnels.md` gets a pointer to this file; `describe_dashboard_schema` output
  is re-snapshotted.

## Sizing

| Phase | Est. | Notes                                                                                    |
| ----- | ---- | ---------------------------------------------------------------------------------------- |
| 1     | 2d   | Largest; the three CH builders + parity e2e. Benchmark before/after with `bench:queries`. |
| 2     | 0.5d | Mostly tables and one clause parser.                                                     |
| 3     | 2d   | Builder UI, list widget, autocomplete, gallery, empty state.                              |
| 4     | 0.5d | Two branches and copy.                                                                   |
| 5     | 0.5d | Param plumbing and doc strings.                                                          |
| 6     | 0.5d | Deletions + docs.                                                                        |

Phases 1 and 2 can go in one PR (engine + model, no UI). Phase 3 is its own PR. 4 and 5 can ride
together. 6 closes it out.

## Risks and decisions taken

- **Cardinality of `attr.<key>` group-bys.** `Attributes` is an unbounded `Map`; `seriesLimit`
  and the breakdown `limit ≤ 100` already bound the output, and the same risk exists on metrics
  `attr.*` today. No new guard.
- **Session-dimension filters cost a semi-join on `session_replays`.** Same as the `/analytics`
  page and the funnel. `needsSessionSemiJoin` already decides when it is needed; a query with only
  event-side filters never pays it.
- **BYO ClickHouse below schema 21** has no `product_events` table. The new branches reuse
  `isMissingProductEvents` so the widget shows the "apply schema" message; nothing falls back to
  `session_events` because server/mobile/trace rows do not exist there.
- **`persons` without `identity_links`.** Deliberately the row-local person key. A person who was
  anonymous and later identified counts twice in `uniq(persons)` on the query-set path. The funnel
  keeps the stitched key. Document this in the aggregation's tooltip.
- **Stored drafts are additive.** No migration: `alert_rules.query_builder_draft_json` and
  `WidgetDataSourceV3` gain a union member. Old readers that switch on `dataSource` and fall
  through to "traces" (there are two: `form-utils.ts` and `alert-signal-display.ts`) must be made
  exhaustive in phase 2 so a `product_events` draft can never be evaluated as traces.
