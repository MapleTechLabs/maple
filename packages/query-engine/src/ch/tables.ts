// Maple Table Definitions
//
// The query tables ARE the warehouse datasources in
// packages/domain/src/tinybird/datasources.ts; these names are aliases. Their
// timestamps decode as the strings ClickHouse sends, the wire format web and
// the iOS app parse.

import { DateTime, Option, Schema, SchemaGetter } from "effect"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { parseUtc } from "../datetime"

/**
 * The type every attribute column in the warehouse has.
 *
 * Named so helpers that work across tables — anything taking "a table with a
 * `SpanAttributes` column" — can say so structurally without falling back to
 * `ColumnRef<"SpanAttributes", any>`. An `any` there erases the map's value
 * type, and `$.SpanAttributes.get(k)` then decodes as `unknown`, which costs
 * the query its derived row schema.
 */
export type StringMap = T.CHMap<T.CHString, T.CHString>

/**
 * Every datasource brands `OrgId` (and the error tables `TraceId`/`SpanId`), so
 * a query that SELECTs one derives the brand without a declared `rowSchema`.
 * Comparisons take the brand too: compare `OrgId` with `orgIdParam`.
 */
export const orgId = Datasources.traces.columns.OrgId

/** The tenant param every warehouse query filters `OrgId` on. */
export const orgIdParam = T.param.of(orgId, "orgId")

/**
 * A string bound written as a `DateTime` literal: floored to whole seconds, as
 * `param.dateTimeSeconds` does, since the column rejects a fractional literal.
 */
const FlooredSecondsString = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.passthrough(),
		encode: SchemaGetter.transform((value: string) =>
			Option.match(parseUtc(value), {
				onNone: () => value,
				onSome: (utc) => DateTime.formatIso(utc).slice(0, 19).replace("T", " "),
			}),
		),
	}),
)

const utcSeconds = T.custom(
	"DateTime",
	T.dateTime.schema,
	Schema.Union([T.dateTime.schema, FlooredSecondsString]),
)

/**
 * A `DateTime.Utc` bound for a second-precision `DateTime` column, floored to
 * whole seconds (a string bound too). It may share a name with a
 * `param.dateTime` bound on a `DateTime64` column. Use it instead of
 * `param.dateTimeSeconds`, which in effect-orm 0.3.0 only accepts strings at
 * runtime despite its type.
 */
export const utcSecondsParam = <const N extends string>(name: N) => T.param.of(utcSeconds, name)

export const Traces = Datasources.traces

export const TraceDetailSpans = Datasources.traceDetailSpans

/**
 * Filtered projection of GenAI agent spans (`maple_ai.vendor.id` stamped),
 * pre-extracted to plain columns — the Agent Sessions detection/facet surface.
 * `SessionId` is `''` on most rows: vendors stamp the session key only on the
 * turn-owning spans, so session resolution stays per-trace at read time.
 *
 * Migration 0026 added the sidebar's other facet dimensions (`DeploymentEnv`,
 * `Model`, `AgentName`, `ToolName`) and the per-span measures the page ranks
 * and filters on (`IsError`, `IsLlmCall`, `IsToolCall`, `Tokens`, `Cost`, with
 * `SpanId`/`ParentSpanId`/`Duration`), each since 0035 a projection of the
 * fact the ingest gateway stamped on the span
 * (`@maple/domain/tinybird/gen-ai-columns`); `''`/0 where the span carries no
 * such fact, and on every row materialized before 0026.
 */
export const AiTraceIndex = Datasources.aiTraceIndex

/**
 * Server spans from AI crawlers (migration 0033), one row per span. A proxied
 * request has several spans in one trace, so requests are `uniq(TraceId)`.
 */
export const AiCrawlerRequests = Datasources.aiCrawlerRequests

export const TraceListMv = Datasources.traceListMv

export const TraceFacetsHourly = Datasources.traceFacetsHourly

export const Logs = Datasources.logs

export const ServiceOverviewSpans = Datasources.serviceOverviewSpans

export const ServiceOverviewHourly = Datasources.serviceOverviewHourly

/**
 * Minute-grain twin of {@link ServiceOverviewHourly}, for windows whose bucket
 * size is under an hour. Columns are deliberately identical apart from the
 * bucket column, so the two can share a UNION ALL branch shape.
 */
export const ServiceOverviewMinutely = Datasources.serviceOverviewMinutely

export const ErrorEvents = Datasources.errorEvents

/**
 * Time-ordered sibling of `error_events` (same rows, sorted by Timestamp instead of
 * FingerprintHash). Use for recent-window scans that filter a Timestamp range and
 * group across fingerprints (e.g. the errorIssuesScan tick); use `ErrorEvents` for
 * per-fingerprint occurrence lookups. See `errorEventsByTime` in
 * `packages/domain/src/tinybird/datasources.ts`.
 */
export const ErrorEventsByTime = Datasources.errorEventsByTime

/** Minute-grain per-fingerprint rollup consumed by the error issue tick. */
export const ErrorFingerprintsMinutely = Datasources.errorFingerprintsMinutely

export const MetricsSum = Datasources.metricsSum

export const MetricsGauge = Datasources.metricsGauge

export const MetricsHistogram = Datasources.metricsHistogram

export const MetricCatalog = Datasources.metricCatalog

export const SpanMetricsCallsHourly = Datasources.spanMetricsCallsHourly

export const AttributeKeysHourly = Datasources.attributeKeysHourly

export const AttributeValuesHourly = Datasources.attributeValuesHourly

export const ServiceUsage = Datasources.serviceUsage

export const ServiceMapSpans = Datasources.serviceMapSpans

export const ServiceMapChildren = Datasources.serviceMapChildren

export const TracesAggregatesHourly = Datasources.tracesAggregatesHourly

export const ServiceOperationsMinutely = Datasources.serviceOperationsMinutely

export const LogsAggregatesHourly = Datasources.logsAggregatesHourly

export const ServiceMapEdgesHourly = Datasources.serviceMapEdgesHourly

// Reached only from the raw-SQL builders in queries/service-map.ts, which
// interpolate `.name` rather than going through the DSL — the `multiIf` ladders
// they emit are what the DSL can't express. Declared here anyway so
// tables.test.ts drift-checks the columns those builders read.
export const ServiceExternalEdgesHourly = Datasources.serviceExternalEdgesHourly

export const ServiceAddressResolutionsHourly = Datasources.serviceAddressResolutionsHourly

export const ServiceMapDbEdgesHourly = Datasources.serviceMapDbEdgesHourly

export const ServiceMapDbQuerySignaturesHourly = Datasources.serviceMapDbQuerySignaturesHourly

export const ServicePlatformsHourly = Datasources.servicePlatformsHourly

export const ServiceOperationsHourly = Datasources.serviceOperationsHourly

export const AlertChecks = Datasources.alertChecks

export const AuditLog = Datasources.auditLog

export const SessionReplays = Datasources.sessionReplays

export const SessionReplayEvents = Datasources.sessionReplayEvents

// Distilled, structured semantic events for a session (navigation, clicks,
// console logs, network requests, errors), captured client-side by the SDK.
// Small and queryable — powers in-session search, the console/network/error
// panels, and the agent transcript. Sparse: only the fields relevant to a row's
// Type are populated; the rest default empty.
export const SessionEvents = Datasources.sessionEvents

// Product events fact table — every event a funnel or product-analytics query
// can step on. Dual-fed: the navigation and custom rows of session_events arrive
// via `product_events_mv` (Source='browser'), backend and mobile events are
// posted directly through `POST /v1/events` (Source='server' | 'mobile').
//
// Exists because session_events is sorted (OrgId, SessionId, Timestamp, Seq), so
// a time-range filter there cannot use the primary index at all, and its idx_type
// skip index prunes ~nothing (navigation rows are interleaved through every
// session's transcript). Reads that only want page views were scanning ~13x the
// rows they used and parsing domain(Url)/path(Url) per row on top.
//
// The funnel substrate: windowFunnel over (Timestamp, EventName, PagePath)
// grouped by the person key `if(UserId != '', UserId, VisitorId)`, stitched
// through `identity_links`. VisitorId is third in the sorting key so one
// person's rows are contiguous inside a time range.
export const ProductEvents = Datasources.productEvents

// (VisitorId, UserId) pairs observed together on a session_replays row.
// AggregatingMergeTree keyed on the pair, `FirstSeen` collapsing under `min` —
// so a merge keeps the pair's EARLIEST sighting rather than an arbitrary one,
// which is what makes ranking a visitor's users by it stable. Unmerged parts
// still hold several rows per pair, so always aggregate (`min(FirstSeen)` per
// pair) or semi-join; never assume one row per pair on read.
export const IdentityLinks = Datasources.identityLinks
export const MetricsExpHistogram = Datasources.metricsExponentialHistogram
