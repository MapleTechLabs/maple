# OTel Coverage Roadmap

Status (2026-11-11): log and trace attribute filters (#3, #8) ship through the where-clause
advanced filter on `/logs` and `/traces`, and span events render on the timeline and in span
detail (#5). `minSeverity` is still backend-only (#4). GenAI data has a dedicated surface in
`/agent-sessions`. Other items below are still open.

Tracks OpenTelemetry-standard capabilities Maple does **not** yet surface for filtering and
visualization. Maple ingests all three OTel signals and stores a near-complete span/log/metric model
in ClickHouse/Tinybird. Much of the stored data (span events, span links, span kind, trace state, log
attributes, metric exemplars, exponential histograms) is never exposed in the product.

**Framing:** most high-value gaps need _zero_ ingestion work. The columns are already populated and
only need query-engine and UI plumbing. Tier 3 items require changes to the Rust ingest encoder
(`apps/ingest/src/telemetry.rs`).

Effort key: **S** = schema + query + UI wiring · **M** = new query shape or visual component ·
**L** = ingest encoder + datasource + downstream.

---

## Data verification (run 2026-06 against prod traces/logs/metrics)

Before building, we confirmed which columns are actually populated. A "quick win" is only quick if
data exists:

- **Span kind:** all 5 kinds present (Client/Server/Internal/Consumer/Producer). ✅
- **Span status:** Ok / Unset / Error all present. The large `Client/Unset` volume can't be separated
  from Ok by the current `has_error` boolean. ✅
- **Span events:** present, concentrated on error spans (exception events). ✅
- **Span links:** **0 rows have links.** ❌ No producers emit them, so #6 is deprioritized until data exists.
- **Scope name:** ~100% populated on both traces and logs. ✅
- **Log attributes:** ~100% populated. ✅
- **Log severity:** numbers 5/9/13/17 present. Severity _text_ casing is inconsistent (`info` vs
  `Info`, `debug`), so a severity-**number** range filter beats text matching. ✅
- **Metric exemplars:** 6.7M on histograms, ~46K on sums. ✅
- **Exponential histograms:** **0 rows.** ❌ #10 deprioritized.
- **Explicit histograms:** 36.8M rows. ✅

---

## Tier 1: quick wins (data already stored, surface only)

- [ ] ~~**1. Span kind filter** (Server/Client/Producer/Consumer/Internal)~~. ✗ **REJECTED (tried and reverted).** Built end-to-end and verified working (Client → 36 traces), but judged not useful enough for the sidebar. Don't rebuild without a clearer use case.
- [ ] ~~**2. Span status filter** (Ok / Unset / Error, not just `has_error`)~~. ✗ **REJECTED (tried and reverted).** The existing `has_error` toggle covers the common case; granular Ok/Unset/Error wasn't worth the sidebar space.
- [x] **3. Log attribute filters** (arbitrary `log_attributes`). _S–M, logs_
      Done: the `/logs` where-clause filter maps attribute clauses onto `attributeFilters` / `resourceAttributeFilters` (`apps/web/src/page/logs/list/advanced-filter-sync.ts`).
- [ ] **4. Log severity range** (`>= ERROR`). _S, logs_
      Backend done: `LogsFilters.minSeverity` filters on `severity_number` and is accepted by `packages/web-data/src/warehouse/logs.ts`. The `/logs` route only offers the per-severity list (`severities`), not a range.
- [x] **5. Span events on the waterfall/timeline.** _M, trace visuals_
      Done: event markers on timeline rows (`packages/views/src/traces/timeline/view-row.ts`) and an events section in span detail (`packages/views/src/traces/span-panel/events.ts`).
- [ ] **6. Span links rendered** (clickable links to related traces). _M, trace visuals_. ⏸ **DEPRIORITIZED: 0 links in prod data.** `links_*` arrays are stored, never shown. Revisit once a producer emits links.
- [ ] **7. Scope / instrumentation filter** (`scope_name` / `scope_version`). _S, trace + log filtering_
      Stored on all three signals, filterable on none. Isolates one SDK/library.
- [x] **8. Generic attribute filter UI builder.** _M, trace filtering_
      Done as a where-clause filter rather than a sidebar row builder (`apps/web/src/page/traces/advanced-filter-sync.ts`, shared parsing in `apps/web/src/page/kit/where-clause-filters.ts`).

## Tier 2: medium (data stored, new query/visual work)

- [ ] **9. Exemplar → trace links on charts.** _M, metric visuals_
      `exemplars_trace_id/span_id/value/timestamp` are stored per metric point and never read. Overlay exemplar dots on latency/line charts that deep-link to the trace. This is the standard OTel bridge from metrics to traces.
- [ ] **10. Exponential-histogram heatmap.** _M–L, metric visuals_. ⏸ **DEPRIORITIZED: 0 exp-histogram rows in prod.** Revisit once data exists. Explicit-bucket histograms (#11) have 36.8M rows and are the better first target.
- [ ] **11. Explicit-bucket histogram distribution view.** _M, metric visuals_
      The histogram datasource has bounds and bucket counts. The chart registry has a generic histogram/heatmap, but nothing is wired to OTel histogram buckets.
- [ ] **12. trace_state / sampling filter.** _S, trace filtering_
      `TraceState` and `SampleRate` are stored. Useful for "show only head-sampled" debugging. Lower demand.
- [ ] **13. GenAI / LLM semantic conventions** (`gen_ai.*`). _M, filtering + visuals_
      Partly done: `/agent-sessions` renders GenAI sessions, tool calls, and transcripts. The trace list still has no dedicated `gen_ai.*` facets or token/cost visuals.

## Tier 3: needs ingest-encoder changes (`apps/ingest/src/telemetry.rs`)

- [ ] **14. Summary metrics.** _M._ Silently dropped at encode time. Add a datasource and encode path if customers send Prometheus-summary-style data.
- [ ] **15. Span flags / dropped-attribute counts.** _M._ `flags` and all `dropped_*_count` are hardcoded to 0. Needed for spec-complete fidelity and "data loss" indicators.
- [ ] **16. Structured (nested) log body.** _M._ The OTel AnyValue body is flattened to a string, so nested bodies lose shape.
- [ ] **17. Profiles signal.** _L._ No OTLP profiles ingestion at all. Large, separable effort.
- [ ] **18. Baggage persistence.** _L._ Parsed but not stored. Low product value.

---

## Recommended build order

Done: #3, #5, #8. Rejected: #1, #2.

1. Filter quick-wins batch (Tier 1: #4, #7). Shared schema → query operator → facet → sidebar pattern.
2. Span links (#6), then exemplar links (#9): the two OTel correlation bridges.
3. Histogram / exp-histogram visuals (#10, #11) and GenAI conventions (#13).
4. Tier 3 ingest work as separate, demand-driven efforts.

## Critical files (by area)

- **Filter schema / query spec:** `packages/domain/src/query-engine.ts` (`TracesFilters`, `LogsFilters`, `MetricsFilters`, `AttributeFilter`).
- **Filter operator → SQL:** `packages/query-engine/src/traces-shared.ts`.
- **Trace/log search + facets:** `packages/query-engine/src/observability/{search-traces,search-logs,explore-attributes}.ts`.
- **DSL queries:** `packages/query-engine/src/ch/queries/*.ts` (+ export from `packages/query-engine/src/ch/index.ts`).
- **Filter UIs:** `apps/web/src/page/traces/list/view-filters.ts`, `apps/web/src/page/logs/list/view-filters.ts`, shared `packages/views/src/ui/filters/` (`filter-sidebar.ts`, `filter-section.ts`); where-clause filters in `apps/web/src/page/{traces,logs/list}/advanced-filter-sync.ts`.
- **Trace visuals:** `packages/views/src/traces/` (`timeline/`, `waterfall/`, `flamegraph.ts`, `span-panel/`), page wiring in `apps/web/src/page/traces/detail/`.
- **Chart registry / metric visuals:** `apps/web/src/page/dashboards/kit/chart-registry.ts`; verify via `/lab/widgets`.
- **Datasource schemas:** `packages/domain/src/tinybird/datasources.ts` (traces, logs, metric\_\* tables).
- **Ingest encoder (Tier 3 only):** `apps/ingest/src/telemetry.rs`.
- **MCP parity:** `apps/ai/src/mcp/tools/{search-traces,search-logs,explore-attributes}.ts`.
