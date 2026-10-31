// Fixtures for query builders that never pass through the pipe registry or the
// QuerySpec lowering — the ~125 exports reached only via direct
// `warehouse.compiledQuery` call sites in apps/api. Without a fixture here a
// builder never meets the ClickHouse analyzer until production.
//
// Each fixture calls the REAL exported builder with parameters shaped like its
// production call site (file:line noted per fixture), so the catalog sweeps the
// SQL the app actually emits. `benchmark/catalog.test.ts`'s `uncoveredBuilders`
// anti-rot test enforces that every module export is either fixtured here or
// explicitly exempted there — adding a builder without either breaks the build.
//
// Only builders swept through a pipe, or composed into a fixtured builder, are
// exempt; every other builder has a fixture, so its tenant scope is checked.

import type { CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import * as CH from "../ch"
import { utcSecondsParam } from "../ch/tables"
import { DateTime, Effect, Result } from "effect"
import type { QueryBuilderError } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"

/**
 * Run a compile that is now Effect-returning, throwing on failure.
 *
 * The catalog wants a throw: a fixture that will not compile must fail its test
 * loudly rather than becoming an entry the sweep silently skips. Compilation is
 * synchronous and effect-free, so `runSync` is exact here.
 */
const runCompile = <A>(compiled: Effect.Effect<A, QueryBuilderError>): A => Effect.runSync(compiled)

export interface BuilderFixture {
	/** Module basename under `src/ch/queries/`, e.g. `"session-replays"`. */
	readonly module: string
	/** The exported builder this fixture covers — must match the export name. */
	readonly name: string
	/** Distinguishes fixtures for one builder; appears in failure output. */
	readonly label: string
	readonly compile: () => CompiledQuery<unknown>
	/**
	 * Sample values for output columns whose row schema narrows what the ClickHouse
	 * column type allows.
	 *
	 * The E2E sweep decodes a synthetic row to prove the schema accepts both 64-bit
	 * wire shapes, and it builds that row from the DESCRIBEd column *types* alone —
	 * so every `String` column gets `""`. A schema that legitimately narrows a
	 * String (a literal union over a column the SQL itself guarantees, like
	 * `serviceExternalEdges.targetType`) rejects `""` and fails a check that is
	 * about integer quoting, with a message telling the author to reach for
	 * `CH.CHNumber` on a string field.
	 *
	 * The narrowing is worth keeping — `service-map.test.ts` asserts an unexpected
	 * `targetType` is rejected — so the fixture names the value instead. Keyed by
	 * output column name.
	 */
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

const ORG_ID = OrgId.make("org_sql_catalog")
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"
/** The same window for builders whose bounds are `DateTime.Utc`. */
const START_UTC = DateTime.makeUnsafe("2026-01-01T10:30:00Z")
const END_UTC = DateTime.makeUnsafe("2026-01-03T14:15:00Z")
const SESSION_ID = "sess_0af7651916cd43dd"
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const FINGERPRINT = "11640393269246331608"

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

// Web analytics fixtures used by the v1 route registry.
//
// Two fixtures per page-view builder: unfiltered, and with a
// session_replays-only filter set. The second is the one that matters — it
// forces the `SessionId IN (SELECT …)` semi-join branch, which is a whole
// second SQL shape that no unfiltered fixture reaches.
//
// Every one is emitted TWICE, once per page-view source. `useProductEvents` is a
// routing predicate, and `routeCoverage()` in benchmark/catalog.ts requires a
// predicate to be exercised both ways — but the stronger reason is that the two
// paths are required to return identical numbers, so both SQL shapes belong in
// the reviewable baseline side by side. Generated rather than written out so a
// fixture cannot exist for one source and not the other.
const WEB_ANALYTICS_ALL_FILTERS = {
	host: "maple.dev",
	pagePath: "/pricing",
	referrerHost: "t.co",
	country: "DE",
	deviceType: "desktop",
	browserName: "Chrome",
	osName: "macOS",
	language: "en-US",
	utmSource: "twitter",
	utmMedium: "social",
	utmCampaign: "launch",
	visitorType: "new",
	eventName: "signup_started",
} as const

const webAnalyticsVariants = (
	name: string,
	label: string,
	compile: (useProductEvents: boolean) => CompiledQuery<unknown>,
	module = "web-analytics",
): ReadonlyArray<BuilderFixture> => [
	{ module, name, label, compile: () => compile(false) },
	{ module, name, label: `${label}-rollup`, compile: () => compile(true) },
]

const webAnalyticsFixtures: ReadonlyArray<BuilderFixture> = [
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsSummaryQuery({ useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsSummaryQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsLiveQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsLiveQuery({ useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsLiveQuery", "filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsLiveQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsTimeseriesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsTimeseriesQuery({ bucketSeconds: 3600, useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPageviewsTimeseriesQuery({ bucketSeconds: 3600, useProductEvents }),
			window,
		),
	),
	// Forces the semi-join: `referrerHost` is a session_replays-only dimension,
	// so the page-view source has to narrow through a subquery to honour it.
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPageviewsTimeseriesQuery({
				bucketSeconds: 3600,
				referrerHost: "t.co",
				visitorType: "returning",
				useProductEvents,
			}),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsPagesQuery({ limit: 100, useProductEvents }), window),
	),
	// host/pagePath filter directly off the page-view source — deliberately NOT
	// through the semi-join, so the 82% of sessions with no analytics block still count.
	...webAnalyticsVariants("webAnalyticsPagesQuery", "url-filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPagesQuery({ limit: 100, host: "maple.dev", useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsPagesQuery({ limit: 100, country: "DE", useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsEventsQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsEventsQuery({ limit: 100, useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsEventsQuery", "url-filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsEventsQuery({ limit: 100, host: "maple.dev", useProductEvents }),
			window,
		),
	),
	// `eventName` alongside a replays dimension: the replays semi-join must appear
	// and the event's own filter must NOT — this is the breakdown it is picked from.
	...webAnalyticsVariants("webAnalyticsEventsQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsEventsQuery({
				limit: 100,
				country: "DE",
				eventName: "signup_started",
				useProductEvents,
			}),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "default", (useProductEvents) =>
		CH.compileUnionUnsafe(CH.webAnalyticsBreakdownsQuery({ useProductEvents }), window),
	),
	// Every dimension selected at once: each branch must exclude its own filter,
	// so this is the fixture that would catch a branch that forgot to. On the
	// rollup variant it is also the one that shows the navigation semi-join being
	// inlined into all twelve branches — the shape the rollup exists to make cheap.
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "all-dimensions-filtered", (useProductEvents) =>
		CH.compileUnionUnsafe(
			CH.webAnalyticsBreakdownsQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
]

const webAnalyticsAiFixtures: ReadonlyArray<BuilderFixture> = [
	...webAnalyticsVariants(
		"webAnalyticsAiReferralsQuery",
		"default",
		(useProductEvents) =>
			CH.compileUnsafe(
				CH.webAnalyticsAiReferralsQuery({ bucketSeconds: 3600, useProductEvents }),
				window,
			),
		"web-analytics-ai",
	),
	// A page filter reaches session_replays through the navigation semi-join.
	...webAnalyticsVariants(
		"webAnalyticsAiReferralsQuery",
		"filtered",
		(useProductEvents) =>
			CH.compileUnsafe(
				CH.webAnalyticsAiReferralsQuery({
					...WEB_ANALYTICS_ALL_FILTERS,
					bucketSeconds: 3600,
					useProductEvents,
				}),
				window,
			),
		"web-analytics-ai",
	),
	{
		module: "web-analytics-ai",
		name: "webAnalyticsAiCrawlersQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.webAnalyticsAiCrawlersQuery({}), window),
	},
	{
		module: "web-analytics-ai",
		name: "webAnalyticsAiCrawlerFormatsQuery",
		label: "url-filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.webAnalyticsAiCrawlerFormatsQuery({ host: "maple.dev", pagePath: "/pricing" }),
				window,
			),
	},
	{
		module: "web-analytics-ai",
		name: "webAnalyticsAiCrawledPagesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.webAnalyticsAiCrawledPagesQuery({ limit: 50 }), window),
	},
]

// Product-event funnel fixtures. The funnel SQL has four independent axes —
// person-key resolution (with or without the identity_links join), a session
// step 1 (UNION ALL of a session_replays branch), the population filter
// semi-join, and a breakdown dimension (event column vs session_replays join) —
// and each is a distinct SQL shape the analyzer has to see.
const FUNNEL_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "page", pagePath: "/pricing", host: "maple.dev" },
	{ kind: "event", eventName: "signup_completed" },
	{ kind: "event", eventName: "plan_started", attributeEquals: { plan: "startup" } },
]
const REFERRAL_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "session", dimension: "referrerHost", value: "news.ycombinator.com" },
	...FUNNEL_STEPS,
]

const productEventsFixtures: ReadonlyArray<BuilderFixture> = [
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "person",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelQuery({
						steps: FUNNEL_STEPS,
						keyBy: "person",
						windowSeconds: 7 * 86_400,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "session-step-filtered",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelQuery({
						steps: REFERRAL_STEPS,
						keyBy: "person",
						windowSeconds: 7 * 86_400,
						filters: WEB_ANALYTICS_ALL_FILTERS,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "visitor-session-step",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelQuery({
						steps: REFERRAL_STEPS,
						keyBy: "visitor",
						windowSeconds: 3_600,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "session-key",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelQuery({
						steps: FUNNEL_STEPS,
						keyBy: "session",
						windowSeconds: 1_800,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelBreakdownQuery",
		label: "session-dimension",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelBreakdownQuery({
						steps: FUNNEL_STEPS,
						keyBy: "person",
						windowSeconds: 7 * 86_400,
						breakdownBy: "utmSource",
						limit: 10,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelBreakdownQuery",
		label: "attribute-session-step",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelBreakdownQuery({
						steps: REFERRAL_STEPS,
						keyBy: "user",
						windowSeconds: 7 * 86_400,
						breakdownBy: "attribute:plan",
						limit: 5,
					}),
				),
				window,
			),
	},
	// Drop-off details and paths share the funnel's person-key axis; one fixture
	// per builder plus the direction / include / exclude shapes of the paths one.
	{
		module: "product-events",
		name: "productEventsFunnelTimingQuery",
		label: "person",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelTimingQuery({
						steps: FUNNEL_STEPS,
						keyBy: "person",
						windowSeconds: 7 * 86_400,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelLeaversQuery",
		label: "visitor-filtered",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsFunnelLeaversQuery({
						steps: FUNNEL_STEPS,
						keyBy: "visitor",
						windowSeconds: 7 * 86_400,
						filters: WEB_ANALYTICS_ALL_FILTERS,
					}),
				),
				window,
			),
	},
	{
		module: "product-events-paths",
		name: "productEventsPathsQuery",
		label: "after-person",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsPathsQuery({
						anchor: { kind: "event", eventName: "signup_completed" },
						direction: "after",
						depth: 3,
						branches: 4,
						keyBy: "person",
						windowSeconds: 86_400,
						exclude: ["heartbeat", "/"],
					}),
				),
				window,
			),
	},
	{
		module: "product-events-paths",
		name: "productEventsPathsQuery",
		label: "before-session-pages-filtered",
		compile: () =>
			CH.compileUnsafe(
				Result.getOrThrow(
					CH.productEventsPathsQuery({
						anchor: { kind: "page", pagePath: "/pricing", host: "maple.dev" },
						direction: "before",
						depth: 2,
						branches: 3,
						keyBy: "session",
						windowSeconds: 3_600,
						include: "pages",
						filters: WEB_ANALYTICS_ALL_FILTERS,
					}),
				),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventNamesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.productEventNamesQuery({ limit: 100 }), window),
	},
	{
		module: "product-events",
		name: "productEventNamesQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventNamesQuery({ filters: WEB_ANALYTICS_ALL_FILTERS, limit: 100 }),
				window,
			),
	},
	// The two directions of the trace ↔ product-event link. Both are
	// single-predicate lookups on `TraceId`, so what the sweep is watching for is
	// that neither grows a `Map` read or loses its `OrgId`/time bounds.
	{
		module: "product-events",
		name: "productEventsForTraceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.productEventsForTraceQuery({ limit: 50 }), {
				...window,
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			}),
	},
	{
		module: "product-events",
		name: "productEventTraceSamplesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.productEventTraceSamplesQuery({ limit: 20 }), {
				...window,
				eventName: "checkout_completed",
			}),
	},
]

// The query-builder source over the same table. Every shape once, plus the
// session semi-join and attribute group-by variants — each a distinct SQL shape.
const productEventsExploreFixtures: ReadonlyArray<BuilderFixture> = [
	{
		module: "product-events-explore",
		name: "productEventsTimeseriesQuery",
		label: "count",
		compile: () =>
			CH.compileUnsafe(CH.productEventsTimeseriesQuery({ metric: "count", bucketSeconds: 3600 }), {
				...window,
				bucketSeconds: 3600,
			}),
	},
	{
		module: "product-events-explore",
		name: "productEventsTimeseriesQuery",
		label: "persons-grouped-filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsTimeseriesQuery({
					metric: "persons",
					groupBy: ["event_name", "attribute"],
					groupByAttributeKey: "plan",
					eventNames: ["signup_completed"],
					attributeFilters: [{ key: "plan", value: "startup", mode: "equals" }],
					country: "DE",
					seriesLimit: 5,
					bucketSeconds: 3600,
				}),
				{ ...window, bucketSeconds: 3600 },
			),
	},
	{
		module: "product-events-explore",
		name: "productEventsBreakdownQuery",
		label: "sessions-by-page",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsBreakdownQuery({
					metric: "sessions",
					groupBy: "page_path",
					hosts: ["maple.dev"],
				}),
				window,
			),
	},
	{
		module: "product-events-explore",
		name: "productEventsListQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.productEventsListQuery({ limit: 50, kinds: ["custom"] }), window),
	},
	{
		module: "product-events-explore",
		name: "productEventAttributeKeysQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.productEventAttributeKeysQuery({ limit: 200 }), window),
	},
	{
		module: "product-events-explore",
		name: "productEventAttributeValuesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventAttributeValuesQuery({ attributeKey: "plan", limit: 50 }),
				window,
			),
	},
]

const RULE_ID = "rule_0af7651916cd43dd"
const alertWindow = { orgId: ORG_ID, ruleId: RULE_ID, since: START_UTC, until: END_UTC }

// Alerting correctness (alert checks, anomaly detection, liveness).
const alertingFixtures: ReadonlyArray<BuilderFixture> = [
	{
		// backend AlertReadModelsService, first page of a rule's check history.
		module: "alert-checks",
		name: "listRuleChecksQuery",
		label: "firstPage",
		compile: () =>
			CH.compileUnsafe(CH.listRuleChecksQuery({ limit: 50 }), { orgId: ORG_ID, ruleId: RULE_ID }),
	},
	{
		// Same call site with every optional filter plus the keyset cursor.
		module: "alert-checks",
		name: "listRuleChecksQuery",
		label: "filteredCursor",
		compile: () =>
			CH.compileUnsafe(
				CH.listRuleChecksQuery({
					limit: 50,
					groupKey: "api",
					status: "breached",
					since: START_UTC,
					until: END_UTC,
					beforeTimestamp: END_UTC,
					beforeGroupKey: "api",
				}),
				{
					...alertWindow,
					groupKey: "api",
					status: "breached",
					beforeTimestamp: END_UTC,
					beforeGroupKey: "api",
				},
			),
	},
	{
		// backend AlertReadModelsService, top groups for the checks chart.
		module: "alert-checks",
		name: "alertCheckGroupTotalsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.alertCheckGroupTotalsQuery({ since: START_UTC, until: END_UTC, limit: 20 }),
				alertWindow,
			),
	},
	{
		// backend AlertReadModelsService, bucketed checks for those groups.
		module: "alert-checks",
		name: "alertChecksSummaryQuery",
		label: "topGroups",
		compile: () =>
			CH.compileUnsafe(CH.alertChecksSummaryQuery({ topGroupKeys: ["api", "web"] }), {
				...alertWindow,
				bucketSeconds: 300,
			}),
	},
	{
		module: "alert-checks",
		name: "alertChecksSummaryQuery",
		label: "noGroups",
		compile: () =>
			CH.compileUnsafe(CH.alertChecksSummaryQuery({ topGroupKeys: [] }), {
				...alertWindow,
				bucketSeconds: 300,
			}),
	},

	// backend AnomalyDetectionService, detector baselines on matched hours.
	{
		module: "anomaly",
		name: "anomalyTraceSignalsQuery",
		label: "matchedHours",
		compile: () =>
			CH.compileUnsafe(CH.anomalyTraceSignalsQuery({ hoursOfDay: CH.matchedHoursOfDay(10) }), window),
	},
	{
		module: "anomaly",
		name: "anomalyLogVolumeQuery",
		label: "matchedHours",
		compile: () =>
			CH.compileUnsafe(CH.anomalyLogVolumeQuery({ hoursOfDay: CH.matchedHoursOfDay(10) }), window),
	},
	// AnomalyDetectionService, error-spike current and baseline windows.
	{
		module: "anomaly",
		name: "anomalyErrorSpikeCurrentQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyErrorSpikeCurrentQuery({}), {
				orgId: ORG_ID,
				startTime: START_UTC,
				endTime: END_UTC,
			}),
	},
	{
		module: "anomaly",
		name: "anomalyErrorSpikeBaselineQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyErrorSpikeBaselineQuery({}), {
				orgId: ORG_ID,
				startTime: START_UTC,
				endTime: END_UTC,
			}),
	},
	// AnomalyDetectionService, the incident detail chart series.
	{
		module: "anomaly",
		name: "anomalyTraceSignalTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyTraceSignalTimeseriesQuery(), {
				...window,
				serviceName: "api",
				deploymentEnv: "production",
			}),
	},
	{
		module: "anomaly",
		name: "anomalyLogVolumeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyLogVolumeTimeseriesQuery(), {
				...window,
				serviceName: "api",
				deploymentEnv: "production",
			}),
	},
	{
		module: "anomaly",
		name: "anomalyErrorSpikeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyErrorSpikeTimeseriesQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
				deploymentEnv: "production",
				bucketSeconds: 300,
			}),
	},
	{
		// No production caller yet; shaped like the fingerprint series above.
		module: "anomaly",
		name: "anomalyErrorSpikeServiceTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.anomalyErrorSpikeServiceTimeseriesQuery(), {
				...window,
				serviceName: "api",
				deploymentEnv: "production",
				bucketSeconds: 300,
			}),
	},

	// backend telemetry-liveness, the auto-resolve liveness probes.
	{
		module: "liveness",
		name: "serviceLivenessQuery",
		label: "allEnvironments",
		compile: () => CH.compileUnsafe(CH.serviceLivenessQuery({}), { ...window, serviceName: "api" }),
	},
	{
		module: "liveness",
		name: "serviceLivenessQuery",
		label: "scopedEnvironment",
		compile: () =>
			CH.compileUnsafe(CH.serviceLivenessQuery({ scopeToEnvironment: true }), {
				...window,
				serviceName: "api",
				deploymentEnv: "production",
			}),
	},
	{
		module: "liveness",
		name: "orgTelemetryPulseQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.orgTelemetryPulseQuery(), window),
	},
]

// Infra pages and the service-map / service-infra compiles.
const infraFixtures: ReadonlyArray<BuilderFixture> = [
	{
		// registry `listHosts`.
		module: "infra",
		name: "listHostsQuery",
		label: "searchPaged",
		compile: () =>
			CH.compileUnsafe(CH.listHostsQuery({ search: "ip-10", limit: 50, offset: 50 }), window),
	},
	{
		// registry `hostDetailSummary`.
		module: "infra",
		name: "hostDetailSummaryQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.hostDetailSummaryQuery({ hostName: "ip-10-0-1-42" }), window),
	},
	{
		// apps/api route `hostInfraTimeseries` network metric.
		module: "infra",
		name: "hostNetworkTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "ip-10-0-1-42" }), {
				...window,
				bucketSeconds: 60,
			}),
	},
	{
		// registry `listPods`, default sort.
		module: "infra",
		name: "listPodsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.listPodsQuery({ limit: 50 }), window),
	},
	{
		// Same call site with a fleet scope, which wraps the list in a scoped subquery.
		module: "infra",
		name: "listPodsQuery",
		label: "scopedFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.listPodsQuery({
					search: "checkout",
					namespaces: ["prod"],
					excludedNodeNames: ["node-a"],
					scope: "saturated",
					sortBy: "cpuUsage",
					sortDir: "desc",
					limit: 50,
				}),
				window,
			),
	},
	{
		// registry `listPodsCount`.
		module: "infra",
		name: "listPodsSummaryQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(CH.listPodsSummaryQuery({ namespaces: ["prod"], clusters: ["eu-1"] }), window),
	},
	{
		// registry `podDetailSummary`.
		module: "infra",
		name: "podDetailSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.podDetailSummaryQuery({ podName: "checkout-7d9f", namespace: "prod" }),
				window,
			),
	},
	{
		// registry `listWorkloads`.
		module: "infra",
		name: "listWorkloadsQuery",
		label: "deployments",
		compile: () =>
			CH.compileUnsafe(
				CH.listWorkloadsQuery({ kind: "deployment", namespaces: ["prod"], limit: 50 }),
				window,
			),
	},
	{
		// registry `workloadDetailSummary`.
		module: "infra",
		name: "workloadDetailSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.workloadDetailSummaryQuery({
					kind: "deployment",
					workloadName: "checkout",
					namespace: "prod",
				}),
				window,
			),
	},
	{
		// registry `serviceWorkloads`.
		module: "service-infra",
		name: "serviceWorkloadsSQL",
		label: "default",
		compile: () => runCompile(CH.serviceWorkloadsSQL({ services: ["api", "checkout"] }, window)),
		sampleValues: { workloadKind: "deployment" },
	},
	{
		// registry `serviceRuntimes`.
		module: "service-infra",
		name: "serviceRuntimesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceRuntimesSQL({ services: ["api", "checkout"] }, window)),
	},
	{
		// backend ServiceMapRollupService, the hourly resolutions rollup.
		module: "service-map-rollup",
		name: "serviceMapResolutionsRollupSQL",
		label: "default",
		compile: () =>
			runCompile(
				CH.serviceMapResolutionsRollupSQL({
					orgId: ORG_ID,
					hourStart: START_TIME,
					hourEnd: END_TIME,
				}),
			),
		sampleValues: { OrgId: ORG_ID },
	},
	{
		// registry `servicePlatforms`.
		module: "service-map",
		name: "servicePlatformsSQL",
		label: "envFiltered",
		compile: () => runCompile(CH.servicePlatformsSQL({ deploymentEnv: "production" }, window)),
	},
]

// Service detail raw fallbacks, health, and single trace/log lookups.
const remainderFixtures: ReadonlyArray<BuilderFixture> = [
	{
		// apps/api route `getLog`, keyed by the span it belongs to.
		module: "logs",
		name: "getLogByKeyQuery",
		label: "bySpan",
		compile: () =>
			CH.compileUnsafe(
				CH.getLogByKeyQuery({ serviceName: "api", traceId: TRACE_ID, spanId: SPAN_ID }),
				{
					...window,
					timestamp: START_TIME,
				},
			),
	},
	{
		// backend TelemetryReadService, v2 `GET /logs/:id` by record identity.
		module: "logs",
		name: "getLogByKeyQuery",
		label: "byRecordIdentity",
		compile: () =>
			CH.compileUnsafe(CH.getLogByKeyQuery({ recordIdentity: FINGERPRINT }), {
				...window,
				timestamp: START_TIME,
			}),
	},
	{
		// registry `serviceEndpointsSummaryRaw`, the pre-0008 fallback.
		module: "service-endpoints",
		name: "serviceEndpointsSummaryRawQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceEndpointsSummaryRawQuery({
					serviceName: "api",
					environments: ["production"],
					limit: 50,
				}),
				window,
				{ rowSchema: CH.serviceEndpointsSummaryRowSchema },
			),
	},
	{
		// registry `serviceOperationsSummaryRaw`.
		module: "service-operations",
		name: "serviceOperationsSummaryRawQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceOperationsSummaryRawQuery({
					serviceName: "api",
					environments: ["production"],
					limit: 50,
				}),
				window,
				{ rowSchema: CH.serviceOperationsSummaryRowSchema },
			),
	},
	{
		// registry `serviceOperationsTimeseriesRaw`.
		module: "service-operations",
		name: "serviceOperationsTimeseriesRawQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceOperationsTimeseriesRawQuery({
					serviceName: "api",
					spanNames: ["GET /v2/services", "POST /v2/alerts"],
					bucketSeconds: 300,
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// registry `serviceHealthSnapshot`.
		module: "services",
		name: "serviceHealthSnapshotQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(CH.serviceHealthSnapshotQuery({ environments: ["production"] }), window),
	},
	{
		// registry `serviceHealthBaseline` and TelemetryReadService.
		module: "services",
		name: "serviceHealthBaselineQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceHealthBaselineQuery({ environments: ["production"], namespaces: ["backend"] }),
				window,
			),
	},
	{
		// backend TelemetryReadService, the org-wide environment list.
		module: "services",
		name: "serviceEnvironmentsQuery",
		label: "orgWide",
		compile: () => CH.compileUnsafe(CH.serviceEnvironmentsQuery(), window),
	},
	{
		// registry `serviceEnvironments` for one service.
		module: "services",
		name: "serviceEnvironmentsQuery",
		label: "oneService",
		compile: () => CH.compileUnsafe(CH.serviceEnvironmentsQuery({ serviceName: "api" }), window),
	},
	{
		// registry `serviceUsage` with a comparison period.
		module: "services",
		name: "serviceUsageWithPreviousQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceUsageWithPreviousQuery({ serviceName: "api" }), {
				...window,
				previousStartTime: "2025-12-30 06:45:00",
				previousEndTime: START_TIME,
			}),
	},
	{
		// runtime span estimate before a raw traces breakdown.
		module: "services",
		name: "traceSpanVolumeByServiceQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.traceSpanVolumeByServiceQuery(), window),
	},
	{
		// backend TelemetryReadService, v2 trace search.
		module: "traces",
		name: "traceSummariesQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.traceSummariesQuery({
					serviceName: "api",
					hasError: true,
					httpMethod: "GET",
					deploymentEnv: "production",
					limit: 50,
				}),
				window,
			),
	},
	{
		// v2 trace search as the iOS Traces tab sends it: root scope, no filters.
		module: "traces",
		name: "traceSummariesQuery",
		label: "root-scope",
		compile: () => CH.compileUnsafe(CH.traceSummariesQuery({ spanScope: "root", limit: 51 }), window),
	},
	{
		// v2 trace search, root scope with a filter trace_list_mv cannot express.
		module: "traces",
		name: "traceSummariesQuery",
		label: "root-scope-raw",
		compile: () =>
			CH.compileUnsafe(
				CH.traceSummariesQuery({
					spanScope: "root",
					httpRoute: "/users/:id",
					hasError: true,
					limit: 51,
				}),
				window,
			),
	},
	{
		// runtime query engine, grouped traces list.
		module: "traces",
		name: "traceListQuery",
		label: "grouped",
		compile: () =>
			CH.compileUnsafe(
				CH.traceListQuery({ serviceName: "api", rootOnly: false, limit: 25, sortBy: "timestamp" }),
				window,
			),
	},
	{
		// registry `spanHierarchyProbe`, the unbounded fallback.
		module: "errors",
		name: "traceTimeProbeQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.traceTimeProbeQuery({ traceId: TRACE_ID }), { orgId: ORG_ID }),
	},
	{
		// registry `spanHierarchyProbeRecent`.
		module: "errors",
		name: "recentTraceTimeProbeQuery",
		label: "openEnded",
		compile: () =>
			CH.compileUnsafe(CH.recentTraceTimeProbeQuery({ traceId: TRACE_ID }), {
				orgId: ORG_ID,
				startTime: START_TIME,
			}),
	},
	{
		// inspect-trace, the bounded probe tier.
		module: "errors",
		name: "recentTraceTimeProbeQuery",
		label: "endBounded",
		compile: () =>
			CH.compileUnsafe(CH.recentTraceTimeProbeQuery({ traceId: TRACE_ID, endBounded: true }), window),
	},
]

export const builderFixtures: ReadonlyArray<BuilderFixture> = [
	...productEventsFixtures,
	...productEventsExploreFixtures,
	// Signal presence — the org-wide "have you ever sent this?" probe behind every
	// empty state (apps/api/src/services/org/SignalPresenceService.ts). One fixture
	// suffices: the builder takes no options, so there is only one SQL shape.
	{
		module: "signal-presence",
		name: "signalPresenceQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.signalPresenceQuery(), window),
	},
	// Audit log listing (apps/api/src/services/audit/AuditLogService.ts `list`).
	{
		module: "audit-log",
		name: "auditLogEntriesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.auditLogEntriesQuery({ limit: 50, offset: 0 }), { orgId: ORG_ID }),
	},
	{
		// Every optional filter bound at once, including the raw `has(...)` clause.
		module: "audit-log",
		name: "auditLogEntriesQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.auditLogEntriesQuery({
					actorType: true,
					userId: true,
					apiKeyId: true,
					actorId: true,
					affectedUserId: true,
					action: true,
					outcome: true,
					resourceType: true,
					resourceId: true,
					changedField: true,
					requestId: true,
					since: true,
					until: true,
					limit: 50,
					offset: 50,
				}),
				{
					orgId: ORG_ID,
					actorType: "user",
					userId: "user_1",
					apiKeyId: "key_1",
					actorId: "actor_1",
					affectedUserId: "user_2",
					action: "dashboard.updated",
					outcome: "allowed",
					resourceType: "dashboard",
					resourceId: "dash_1",
					changedField: "name",
					requestId: "ray",
					since: START_TIME,
					until: END_TIME,
				},
			),
	},
	// Session replay fixtures used by the replay routes.
	{
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.sessionReplaysListQuery({}), window),
	},
	{
		// Filters force the session_events semi-join + activity join branches.
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.sessionReplaysListQuery({
					serviceName: "web",
					hasErrors: true,
					search: "checkout",
					userSearch: "ada",
					groupName: "Acme Inc",
					durationMinMs: 1_000,
					activeTimeMinMs: 500,
					limit: 50,
				}),
				window,
			),
	},
	{
		// The product_events semi-join behind the "Page visited" filter.
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "page-visited",
		compile: () => CH.compileUnsafe(CH.sessionReplaysListQuery({ pagePath: "/pricing" }), window),
	},
	{
		// The tag semi-join: every requested tag, decided over the window's finalized rows.
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "tagged",
		compile: () =>
			CH.compileUnsafe(CH.sessionReplaysListQuery({ tags: ["engaged", "signed_in"] }), window),
	},
	{
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.sessionReplaysFacetsQuery({}), window),
	},
	{
		// Covers the identity predicates, which are excluded from their own branch
		// (group) or narrow every branch (userSearch).
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "identity-filtered",
		compile: () =>
			CH.compileUnionUnsafe(
				CH.sessionReplaysFacetsQuery({ userSearch: "ada", groupName: "Acme Inc" }),
				window,
			),
	},
	{
		// A selected page narrows every other branch and is excluded from its own.
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "page-visited",
		compile: () => CH.compileUnionUnsafe(CH.sessionReplaysFacetsQuery({ pagePath: "/pricing" }), window),
	},
	{
		// Selected tags narrow every other branch and are excluded from the tag branch.
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "tagged",
		compile: () => CH.compileUnionUnsafe(CH.sessionReplaysFacetsQuery({ tags: ["engaged"] }), window),
	},
	{
		module: "session-replays",
		name: "getSessionReplayQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.getSessionReplayQuery({ startTime: START_UTC, endTime: END_UTC }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayChunkIndexQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionReplayChunkIndexQuery({ startTime: START_UTC, endTime: END_UTC }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayEventsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionReplayEventsQuery({ startTime: START_UTC, endTime: END_UTC }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		// The shape playback actually emits: a bounded chunk window. Distinct SQL
		// from "default" (ChunkSeq predicates + LIMIT), so it needs its own sweep.
		module: "session-replays",
		name: "sessionReplayEventsQuery",
		label: "ranged",
		compile: () =>
			CH.compileUnsafe(
				CH.sessionReplayEventsQuery({
					startTime: START_UTC,
					endTime: END_UTC,
					fromChunkSeq: 16,
					toChunkSeq: 31,
					limit: 40,
				}),
				{ orgId: ORG_ID, sessionId: SESSION_ID },
			),
	},
	{
		module: "session-replays",
		name: "sessionsForTraceQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.sessionsForTraceQuery({ traceId: TRACE_ID }), window),
	},
	{
		module: "session-replays",
		name: "sessionTraceSummariesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.sessionTraceSummariesQuery({
					traceIds: [TRACE_ID],
					startTime: DateTime.makeUnsafe("2026-01-01T10:30:00Z"),
					endTime: DateTime.makeUnsafe("2026-01-03T14:15:00Z"),
				}),
				{ orgId: ORG_ID },
			),
	},

	// Session event fixtures used by the replay routes.
	{
		module: "session-events",
		name: "sessionTranscriptQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionTranscriptQuery({ startTime: START_UTC, endTime: END_UTC }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-events",
		name: "sessionActivityQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionActivityQuery({ startTime: START_UTC, endTime: END_UTC }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},

	...webAnalyticsFixtures,
	...webAnalyticsAiFixtures,

	// Traces sidebar (query-engine runtime); the pipe fixtures cover the raw-only route.
	{
		module: "errors",
		name: "tracesFacetsQuery",
		label: "rollup",
		compile: () => CH.compileUnionUnsafe(CH.tracesFacetsQuery({ serviceNames: ["api"] }), window),
	},
	{
		module: "errors",
		name: "tracesDurationStatsQuery",
		label: "rollup",
		compile: () => CH.compileUnsafe(CH.tracesDurationStatsQuery({ serviceNames: ["api"] }), window),
	},

	// Error fixtures reached through ErrorsService, v2 telemetry, and observability.
	{
		// telemetry.http.ts v2GetSpan / observability/span-detail.ts
		module: "errors",
		name: "spanDetailQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID }), { orgId: ORG_ID }),
	},
	{
		module: "errors",
		name: "spanDetailQuery",
		label: "narrowByTime",
		compile: () =>
			CH.compileUnsafe(
				CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID, narrowByTime: true }),
				window,
			),
	},
	{
		// query-engine.http.ts spanDetail, after the detail row resolves the span's keys
		module: "errors",
		name: "spanEventsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.spanEventsQuery({
					traceId: TRACE_ID,
					spanId: SPAN_ID,
					serviceName: "api",
					spanName: "GET",
				}),
				window,
			),
	},
	{
		// query-engine.http.ts traceSpanEvents, the trace timeline's event markers
		module: "errors",
		name: "spanEventsByTraceQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.spanEventsByTraceQuery({ traceId: TRACE_ID }), window),
	},
	{
		// ErrorsService errorIssuesScan (the scheduled sweep)
		module: "errors",
		name: "errorIssuesQuery",
		label: "scan",
		compile: () => CH.compileUnsafe(CH.errorIssuesQuery({ limit: 500 }), window),
	},
	{
		// ErrorsService steady-state cursor window over the compact minute rollup.
		module: "errors",
		name: "errorTickIssuesQuery",
		label: "cursor-window",
		compile: () => CH.compileUnsafe(CH.errorTickIssuesQuery(), window),
	},
	{
		// ErrorsService one-time cursor bootstrap from retained canonical events.
		module: "errors",
		name: "errorTickBootstrapIssuesQuery",
		label: "bootstrap-window",
		compile: () => CH.compileUnsafe(CH.errorTickBootstrapIssuesQuery(), window),
	},
	{
		// ErrorsService cursor recovery for an org that was not being scanned.
		module: "errors",
		name: "errorTickFirstErrorMinuteQuery",
		label: "first-error-minute",
		compile: () => CH.compileUnsafe(CH.errorTickFirstErrorMinuteQuery(), window),
	},
	{
		// ErrorsService errorIssueEnvFingerprints
		module: "errors",
		name: "errorFingerprintsQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.errorFingerprintsQuery({ services: ["api"], deploymentEnvs: ["production"] }),
				window,
			),
	},
	{
		module: "errors",
		name: "errorIssueTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueTimeseriesQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
				bucketSeconds: 300,
			}),
	},
	{
		module: "errors",
		name: "errorsSparkQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorsSparkQuery({ fingerprintHashes: [FINGERPRINT] }), {
				...window,
				bucketSeconds: 300,
			}),
	},
	{
		module: "errors",
		name: "errorIssueSampleTracesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueSampleTracesQuery({ limit: 5 }), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
		// TraceId/SpanId decode through their branded schemas (minLength 1), which
		// the synthetic row's "" would fail.
		sampleValues: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" },
	},
	{
		module: "errors",
		name: "errorIssueEnvironmentsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueEnvironmentsQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},
	{
		// FixVerificationTickService — the post-merge occurrence split that decides
		// whether a merged fix actually stopped the error.
		module: "errors",
		name: "errorIssueVersionsSinceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueVersionsSinceQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},
	{
		// error_detail (MCP): a fingerprint's volume and identity, and the window anchor.
		module: "errors",
		name: "errorFingerprintSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorFingerprintSummaryQuery({ fingerprintHash: FINGERPRINT }), window),
	},
	{
		// error_detail (MCP): other fingerprints raised inside the sampled traces.
		module: "errors",
		name: "errorCooccurringFingerprintsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.errorCooccurringFingerprintsQuery({
					fingerprintHash: FINGERPRINT,
					traceIds: ["0af7651916cd43dd8448eb211c80319c"],
				}),
				window,
			),
	},
	{
		// find_errors / list_error_issues (MCP): labels for exception-less fingerprints.
		module: "errors",
		name: "errorFingerprintOccurrencesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.errorFingerprintOccurrencesQuery({ fingerprintHashes: [FINGERPRINT] }),
				window,
			),
		// The branded TraceId/SpanId columns reject the synthetic "" the sweep would use.
		sampleValues: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" },
	},
	{
		module: "errors",
		name: "errorOccurrenceSpansQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.errorOccurrenceSpansQuery({
					traceIds: ["0af7651916cd43dd8448eb211c80319c"],
					spanIds: ["b7ad6b7169203331"],
				}),
				window,
			),
	},
	{
		// find_errors (MCP): every occurrence in the window, beyond the top-N rows.
		module: "errors",
		name: "errorsWindowTotalsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.errorsWindowTotalsQuery({}), window),
	},

	// Batch ④ — the modules the query-engine refactor touches. These exist so a
	// refactor that claims "no SQL changed" is actually checkable: without a
	// fixture, a builder contributes nothing to `__sql_baseline__/catalog.sql`
	// and its SQL can drift silently.

	// Service-operation splice across raw, minutely, and hourly sources.
	{
		// routes/v2/services.http.ts — service detail "Operations" tab.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceOperationsSummaryQuery({ serviceName: "api", limit: 50 }), window),
	},
	{
		// Env filter exercises the extra predicate on every tier of the splice.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceOperationsSummaryQuery({
					serviceName: "api",
					environments: ["production"],
					limit: 50,
				}),
				window,
			),
	},
	{
		// routes/internal/query-engine.http.ts — service detail "API" tab. Same
		// splice as the Operations fixture with the HTTP-endpoint predicate on
		// every tier, so the sweep validates the filtered form separately.
		module: "service-endpoints",
		name: "serviceEndpointsSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceEndpointsSummaryQuery({ serviceName: "api", limit: 50 }), window),
	},
	{
		module: "service-endpoints",
		name: "serviceEndpointsSummaryQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceEndpointsSummaryQuery({
					serviceName: "api",
					environments: ["production"],
					limit: 50,
				}),
				window,
			),
	},
	{
		module: "service-operations",
		name: "serviceOperationsTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceOperationsTimeseriesQuery({
					serviceName: "api",
					spanNames: ["GET /v2/services", "POST /v2/alerts"],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},

	// Service API tab — routes/internal/query-engine.http.ts. Totals and timeseries
	// run the operations splice with migration 0048's HTTP measures; the raw tier
	// is the per-org fallback when the rollups or those columns are absent.
	{
		module: "service-api",
		name: "serviceEndpointsWithHttpQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceEndpointsWithHttpQuery({ serviceName: "api", limit: 50 }), window, {
				rowSchema: CH.serviceEndpointsWithHttpRowSchema,
			}),
	},
	{
		module: "service-api",
		name: "serviceApiTotalsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceApiTotalsQuery({ serviceName: "api", environments: ["production"] }),
				window,
				{
					rowSchema: CH.serviceApiTotalsRowSchema,
				},
			),
	},
	{
		module: "service-api",
		name: "serviceApiTotalsQuery",
		label: "rawTier",
		compile: () =>
			CH.compileUnsafe(CH.serviceApiTotalsQuery({ serviceName: "api", tiers: "raw" }), window, {
				rowSchema: CH.serviceApiTotalsRowSchema,
			}),
	},
	{
		module: "service-api",
		name: "serviceApiTimeseriesQuery",
		label: "mergedSubHour",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceApiTimeseriesQuery({ serviceName: "api", bucketSeconds: 300 }),
				{ ...window, bucketSeconds: 300 },
				{ rowSchema: CH.serviceApiTimeseriesRowSchema },
			),
	},
	{
		module: "service-api",
		name: "serviceApiTimeseriesQuery",
		label: "perEndpointHourly",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceApiTimeseriesQuery({
					serviceName: "api",
					bucketSeconds: 3600,
					spanNames: ["GET /v2/services", "POST /v2/alerts"],
				}),
				{ ...window, bucketSeconds: 3600 },
				{ rowSchema: CH.serviceApiTimeseriesRowSchema },
			),
	},
	{
		module: "service-api",
		name: "serviceApiTimeseriesQuery",
		label: "rawTier",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceApiTimeseriesQuery({ serviceName: "api", bucketSeconds: 300, tiers: "raw" }),
				{ ...window, bucketSeconds: 300 },
				{ rowSchema: CH.serviceApiTimeseriesRowSchema },
			),
	},
	// Endpoint detail — one hour-grain tier off service_endpoint_details_hourly.
	{
		module: "service-endpoint-details",
		name: "serviceEndpointStatusBreakdownQuery",
		label: "allEndpoints",
		compile: () =>
			CH.compileUnsafe(CH.serviceEndpointStatusBreakdownQuery({ serviceName: "api" }), window, {
				rowSchema: CH.serviceEndpointStatusBreakdownRowSchema,
			}),
	},
	{
		module: "service-endpoint-details",
		name: "serviceEndpointStatusBreakdownQuery",
		label: "oneEndpoint",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceEndpointStatusBreakdownQuery({
					serviceName: "api",
					environments: ["production"],
					spanName: "GET /v2/services",
				}),
				window,
				{ rowSchema: CH.serviceEndpointStatusBreakdownRowSchema },
			),
	},
	{
		module: "service-endpoint-details",
		name: "serviceEndpointDistributionQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceEndpointDistributionQuery({ serviceName: "api", spanName: "GET /v2/services" }),
				window,
				{ rowSchema: CH.serviceEndpointDistributionRowSchema },
			),
	},
	{
		module: "service-endpoint-details",
		name: "serviceEndpointSlowestQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceEndpointSlowestQuery({ serviceName: "api", spanName: "GET /v2/services" }),
				window,
				{ rowSchema: CH.serviceEndpointSlowestRowSchema },
			),
	},

	// Releases page — routes/internal/query-engine.http.ts `releasesList` and
	// `releaseDetail`. Same splice as the services list, grouped one level
	// finer (per commit), plus the error-events bridge keyed on the version.
	{
		module: "releases",
		name: "releasesListQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.releasesListQuery({ environments: ["production"], serviceNames: ["api", "web"] }),
				window,
			),
	},
	{
		module: "releases",
		name: "releasesListQuery",
		label: "singleService",
		compile: () =>
			CH.compileUnsafe(
				CH.releasesListQuery({ serviceName: "api", environments: ["production"], limit: 100 }),
				window,
			),
	},
	{
		module: "releases",
		name: "releasesTimelineQuery",
		label: "minutely",
		compile: () =>
			CH.compileUnsafe(CH.releasesTimelineQuery({ environments: ["production"], bucketSeconds: 300 }), {
				...window,
				bucketSeconds: 300,
			}),
	},
	{
		module: "releases",
		name: "releasesTimelineQuery",
		label: "hourly",
		compile: () =>
			CH.compileUnsafe(CH.releasesTimelineQuery({ serviceName: "api", bucketSeconds: 3600 }), {
				...window,
				bucketSeconds: 3600,
			}),
	},
	{
		module: "releases",
		name: "releasesTimelineQuery",
		label: "raw",
		compile: () =>
			CH.compileUnsafe(CH.releasesTimelineQuery({ serviceName: "api", bucketSeconds: 30 }), {
				...window,
				bucketSeconds: 30,
			}),
	},
	{
		module: "releases",
		name: "releaseErrorFingerprintsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.releaseErrorFingerprintsQuery({ serviceName: "api", environments: ["production"] }),
				{ ...window, serviceVersion: "0af7651916cd43dd8448eb211c80319c0af76519" },
			),
	},

	// MCP `service_deployments`, `route_usage` and `ingest_freshness`.
	{
		module: "releases",
		name: "serviceDeploymentsQuery",
		label: "minutePrecision",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceDeploymentsQuery({ serviceName: "api", minutePrecision: true }),
				window,
			),
	},
	{
		module: "releases",
		name: "serviceDeploymentsQuery",
		label: "hourInterior",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceDeploymentsQuery({ environments: ["production"], minutePrecision: false }),
				window,
			),
	},
	{
		module: "ci-runs",
		name: "ciRunsQuery",
		label: "allRuns",
		compile: () => CH.compileUnsafe(CH.ciRunsQuery({}), window),
	},
	{
		module: "ci-runs",
		name: "ciRunsQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.ciRunsQuery({
					pipeline: "CI",
					repository: "api",
					branch: "main",
					result: "failure",
					limit: 50,
				}),
				window,
			),
	},
	{
		module: "ci-runs",
		name: "ciFailedJobsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.ciFailedJobsQuery({ traceIds: ["abc123"] }), window),
	},
	{
		module: "ci-runs",
		name: "ciRunsQuery",
		label: "pageAfterCursor",
		compile: () =>
			CH.compileUnsafe(
				CH.ciRunsQuery({
					ranOnly: true,
					before: { startedAt: START_UTC, traceId: "abc123" },
					limit: 51,
				}),
				{ ...window, beforeStartedAt: START_UTC, beforeTraceId: "abc123" },
			),
	},
	{
		module: "ci-runs",
		name: "ciRunTotalsQuery",
		label: "allWorkflows",
		compile: () => CH.compileUnsafe(CH.ciRunTotalsQuery({}), window),
	},
	{
		module: "ci-runs",
		name: "ciRunSeriesQuery",
		label: "sixHourly",
		compile: () => CH.compileUnsafe(CH.ciRunSeriesQuery({}), { ...window, bucketSeconds: 21_600 }),
	},
	{
		module: "ci-runs",
		name: "ciPipelineStatsQuery",
		label: "oneRepository",
		compile: () =>
			CH.compileUnsafe(
				CH.ciPipelineStatsQuery({ owner: "acme", repository: "api", pipeline: "CI" }),
				window,
			),
	},
	{
		module: "ci-runs",
		name: "ciJobStatsQuery",
		label: "allWorkflows",
		compile: () => CH.compileUnsafe(CH.ciJobStatsQuery({}), window),
	},
	{
		module: "ci-runs",
		name: "ciQueueTotalsQuery",
		label: "allWorkflows",
		compile: () => CH.compileUnsafe(CH.ciQueueTotalsQuery({}), window),
	},
	{
		module: "pr-review",
		name: "operationTrafficHourlyQuery",
		label: "allServices",
		compile: () => CH.compileUnsafe(CH.operationTrafficHourlyQuery({}), window),
	},
	{
		module: "pr-review",
		name: "operationTrafficMinutelyQuery",
		label: "servicesAndSpans",
		compile: () =>
			CH.compileUnsafe(
				CH.operationTrafficMinutelyQuery({ serviceNames: ["api"], spanNames: ["POST /checkout"] }),
				window,
			),
	},
	{
		module: "service-operations",
		name: "routeUsageQuery",
		label: "allServices",
		compile: () => CH.compileUnsafe(CH.routeUsageQuery({}), window),
	},
	{
		module: "service-operations",
		name: "routeUsageQuery",
		label: "searchStalest",
		compile: () =>
			CH.compileUnsafe(
				CH.routeUsageQuery({
					serviceName: "api",
					environments: ["production"],
					search: "/v1/",
					orderBy: "lastSeenAsc",
				}),
				window,
			),
	},
	{
		module: "liveness",
		name: "ingestFreshnessQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.ingestFreshnessQuery(), window),
	},
	{
		module: "liveness",
		name: "logsFreshnessQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.logsFreshnessQuery(), window),
	},
	{
		module: "service-map",
		name: "dbQueryVolumeQuery",
		label: "allDatabases",
		compile: () => CH.compileUnsafe(CH.dbQueryVolumeQuery({}), window),
	},
	{
		module: "service-map",
		name: "dbQueryVolumeQuery",
		label: "scoped",
		compile: () =>
			CH.compileUnsafe(
				CH.dbQueryVolumeQuery({
					dbSystem: "postgresql",
					serviceName: "api",
					deploymentEnv: "production",
					limit: 20,
				}),
				window,
			),
	},

	// SourceUsageService: the sources list totals and one source's hourly chart.
	{
		module: "source-usage",
		name: "sourceUsageTotalsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.sourceUsageTotalsQuery(), window),
	},
	{
		module: "source-usage",
		name: "sourceUsageHourlyQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sourceUsageHourlyQuery(), {
				...window,
				sourceId: "src_aXunrkWtzvXSkw9Z2smcft",
			}),
	},

	// AwsConnectionService.ingest: what one connection's metric stream stored.
	{
		module: "aws-ingest",
		name: "awsIngestQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.awsIngestQuery(), {
				...window,
				connectionId: "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
			}),
	},

	// apps/cli `serviceHasTelemetry`: the `-s <name>` typo check.
	{
		module: "services",
		name: "servicePresenceQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.servicePresenceQuery({ serviceName: "checkout" }), window),
	},

	// Service-catalog hourly-rollup splice.
	{
		// routes/v2/services.http.ts — the services list.
		module: "services",
		name: "serviceCatalogQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.serviceCatalogQuery({ limit: 50 }), window),
	},
	{
		module: "services",
		name: "serviceCatalogQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceCatalogQuery({
					serviceName: "api",
					deploymentEnvironment: "production",
					serviceNamespace: "backend",
					limit: 50,
				}),
				window,
			),
	},

	{
		// Sidebar presence gate — no params beyond the org + window, so one fixture
		// covers it. What the catalog is watching here is that it stays free of
		// aggregates: a `count()` would read the whole match set before LIMIT 1
		// could trim its single output row.
		module: "infra",
		name: "infraPresenceQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.infraPresenceQuery(), window),
	},

	// Infra gauge timeseries and facet unions.
	{
		module: "infra",
		name: "hostFilesystemsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.hostFilesystemsQuery({ hostName: "ip-10-0-1-42" }), window),
	},
	{
		module: "infra",
		name: "hostGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.hostGaugeTimeseriesQuery({
					hostName: "ip-10-0-1-42",
					metricName: "system.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// `groupByAttributeKey` switches the projected column off the `lit("")` default.
		module: "infra",
		name: "hostGaugeTimeseriesQuery",
		label: "grouped",
		compile: () =>
			CH.compileUnsafe(
				CH.hostGaugeTimeseriesQuery({
					hostName: "ip-10-0-1-42",
					metricName: "system.cpu.utilization",
					groupByAttributeKey: "cpu",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "podRestartsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.podRestartsQuery({
					workloadKind: "deployment",
					workloadName: "api",
					namespace: "backend",
				}),
				window,
			),
	},
	{
		// The pod list's shape: one page of pod names, every container on them.
		module: "infra",
		name: "podRestartsQuery",
		label: "podNames",
		compile: () =>
			CH.compileUnsafe(
				CH.podRestartsQuery({
					podNames: ["api-7d9f8b6c5-x2n4k", "worker-5c8d7f9b4-q7m2p"],
					limit: 500,
				}),
				window,
			),
	},
	{
		module: "infra",
		name: "podGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.podGaugeTimeseriesQuery({
					podName: "api-7d9f8b6c5-x2n4k",
					namespace: "backend",
					metricName: "k8s.pod.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "listNodesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.listNodesQuery(), window),
	},
	{
		module: "infra",
		name: "nodeDetailSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.nodeDetailSummaryQuery({ nodeName: "ip-10-0-1-42.ec2.internal" }), window),
	},
	{
		module: "infra",
		name: "nodeGaugeTimeseriesQuery",
		label: "utilization",
		compile: () =>
			CH.compileUnsafe(
				CH.nodeGaugeTimeseriesQuery({
					nodeName: "ip-10-0-1-42.ec2.internal",
					metricName: "k8s.node.memory.working_set",
					capacityMetricName: "k8s.node.allocatable_memory",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "nodeGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.nodeGaugeTimeseriesQuery({
					nodeName: "ip-10-0-1-42.ec2.internal",
					metricName: "k8s.node.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "workloadGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.workloadGaugeTimeseriesQuery({
					kind: "deployment",
					workloadName: "api",
					namespace: "backend",
					metricName: "k8s.pod.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// `groupByPod` fans the workload series out per pod.
		module: "infra",
		name: "workloadGaugeTimeseriesQuery",
		label: "groupedByPod",
		compile: () =>
			CH.compileUnsafe(
				CH.workloadGaugeTimeseriesQuery({
					kind: "statefulset",
					workloadName: "clickhouse",
					namespace: "data",
					metricName: "k8s.pod.memory.usage",
					groupByPod: true,
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "podFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.podFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "nodeFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.nodeFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "workloadFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.workloadFacetsQuery({ kind: "deployment" }), window),
	},

	// Containers (Docker) — list/summary/detail/timeseries/facets, mirrors the
	// /list-containers route family (routes/internal/query-engine.http.ts).
	{
		module: "containers",
		name: "listContainersQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.listContainersQuery({}), window),
	},
	{
		module: "containers",
		name: "listContainersQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.listContainersQuery({
					search: "api",
					hostNames: ["ip-10-0-1-42"],
					images: ["ghcr.io/acme/api:1.4.2"],
					composeProjects: ["shop"],
					excludedContainerNames: ["buildkitd"],
					sortBy: "cpuPct",
					sortDir: "desc",
				}),
				window,
			),
	},
	{
		// `scope` switches on the wrapped-query WHERE over aggregates.
		module: "containers",
		name: "listContainersQuery",
		label: "scoped",
		compile: () => CH.compileUnsafe(CH.listContainersQuery({ scope: "saturated" }), window),
	},
	{
		module: "containers",
		name: "listContainersSummaryQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.listContainersSummaryQuery({}), window),
	},
	{
		// explore_attributes with a service: the hourly key rollup has no ServiceName.
		module: "attribute-keys",
		name: "serviceScopedAttributeKeysQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceScopedAttributeKeysQuery({ scope: "span" }), {
				...window,
				serviceName: "checkout",
			}),
	},
	{
		module: "attribute-keys",
		name: "serviceScopedAttributeValuesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceScopedAttributeValuesQuery({ scope: "resource", attributeKey: "k8s.pod.name" }),
				{ ...window, serviceName: "checkout" },
			),
	},
	{
		module: "containers",
		name: "containerDetailSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.containerDetailSummaryQuery({ containerName: "api", hostName: "ip-10-0-1-42" }),
				window,
			),
	},
	{
		module: "containers",
		name: "containerCountersSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.containerCountersSummaryQuery({ containerName: "api", hostName: "ip-10-0-1-42" }),
				window,
			),
	},
	{
		// Percent gauges divide by 100 so chart scales match the pod pages.
		module: "containers",
		name: "containerGaugeTimeseriesQuery",
		label: "percent",
		compile: () =>
			CH.compileUnsafe(
				CH.containerGaugeTimeseriesQuery({
					containerName: "api",
					hostName: "ip-10-0-1-42",
					metricName: "container.cpu.utilization",
					divideBy: 100,
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "containers",
		name: "containerGaugeTimeseriesQuery",
		label: "unscaled",
		compile: () =>
			CH.compileUnsafe(
				CH.containerGaugeTimeseriesQuery({ containerName: "api", metricName: "container.uptime" }),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// Network splits direction into metric names → multiIf series labels.
		module: "containers",
		name: "containerSumTimeseriesQuery",
		label: "network",
		compile: () =>
			CH.compileUnsafe(
				CH.containerSumTimeseriesQuery({
					containerName: "api",
					metricNames: [
						"container.network.io.usage.rx_bytes",
						"container.network.io.usage.tx_bytes",
					],
					metricLabels: [
						["container.network.io.usage.rx_bytes", "receive"],
						["container.network.io.usage.tx_bytes", "transmit"],
					],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// Sampled sums (memory bytes) average a bucket's samples instead of
		// adding them.
		module: "containers",
		name: "containerSumTimeseriesQuery",
		label: "memory-average",
		compile: () =>
			CH.compileUnsafe(
				CH.containerSumTimeseriesQuery({
					containerName: "api",
					metricNames: ["container.memory.usage.total"],
					average: true,
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// Block IO groups by the `operation` datapoint attribute instead.
		module: "containers",
		name: "containerSumTimeseriesQuery",
		label: "blockio",
		compile: () =>
			CH.compileUnsafe(
				CH.containerSumTimeseriesQuery({
					containerName: "api",
					metricNames: ["container.blockio.io_service_bytes_recursive"],
					groupByAttributeKey: "operation",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "containers",
		name: "containerFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.containerFacetsQuery(), window),
	},

	// ----- service-map: the parent⋈child span join and its two projections.
	// ----- The rollup's rows are `ingest`ed into service_map_edges_hourly
	// ----- verbatim, so these must reach the ClickHouse DESCRIBE sweep.
	{
		// Mirrors ServiceMapRollupService's per-hour call (service-map-rollup.ts).
		module: "service-map",
		name: "serviceMapEdgeJoinQuery",
		label: "rollup-hour",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(utcSecondsParam("hourStart")),
					rangeEnd: CH.toDateTime(utcSecondsParam("hourEnd")),
				}).format("JSON"),
				{ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME },
			),
		sampleValues: { OrgId: ORG_ID },
	},
	{
		// The service-scoped variant pushes the filter into the parent subquery.
		module: "service-map",
		name: "serviceMapEdgeJoinQuery",
		label: "scoped-to-service",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(utcSecondsParam("hourStart")),
					rangeEnd: CH.toDateTime(utcSecondsParam("hourEnd")),
					deploymentEnv: "production",
					parentServiceName: "web",
				}).format("JSON"),
				{ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME },
			),
		sampleValues: { OrgId: ORG_ID },
	},
	{
		module: "service-map-rollup",
		name: "serviceMapEdgesRollupSQL",
		label: "default",
		compile: () =>
			runCompile(
				CH.serviceMapEdgesRollupSQL({ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME }),
			),
		sampleValues: { OrgId: ORG_ID },
	},
	{
		module: "service-map-rollup",
		name: "serviceMapEdgesExistingHoursSQL",
		label: "default",
		compile: () => runCompile(CH.serviceMapEdgesExistingHoursSQL(window)),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapResolutionsExistingHoursSQL",
		label: "default",
		compile: () => runCompile(CH.serviceMapResolutionsExistingHoursSQL(window)),
	},
	{
		// Org-wide: hourly MV branch UNION ALL two partial-hour live joins.
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceDependenciesSQL({}, window)),
	},
	{
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "env-scoped",
		compile: () => runCompile(CH.serviceDependenciesSQL({ deploymentEnv: "production" }, window)),
	},
	{
		module: "service-map",
		name: "serviceDependenciesForServiceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceDependenciesForServiceQuery({ serviceName: "web" }), window),
	},
	{
		module: "service-map",
		name: "serviceDependenciesInvolvingServiceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceDependenciesInvolvingServiceQuery({ serviceName: "web" }), window),
	},
	{
		// Hourly MV UNION ALL the two partial hours from raw traces. Absent from
		// this catalog until 2026-08-30, which is how its splice drifted: the
		// hourly branch floored the start to the hour while the raw branch covered
		// only the trailing one, so every non-hour-aligned window counted the whole
		// leading hour. Nothing swept it and nothing gated it.
		module: "service-map",
		name: "serviceDbEdgesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceDbEdgesSQL({}, window)),
	},
	{
		module: "service-map",
		name: "serviceDbEdgesSQL",
		label: "env-scoped",
		compile: () => runCompile(CH.serviceDbEdgesSQL({ deploymentEnv: "production" }, window)),
	},
	{
		module: "service-map",
		name: "serviceDbEdgesForServiceQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.serviceDbEdgesForServiceQuery({ serviceName: "web" }), window),
	},
	{
		module: "service-map",
		name: "serviceDbQuerySummarySQL",
		label: "default",
		compile: () => runCompile(CH.serviceDbQuerySummarySQL({ ...window, dbSystem: "postgresql" })),
	},
	{
		// Hour-aligned buckets take the sealed-rollup UNION raw-edge path; the
		// sub-hour branch below reads raw `traces` for the whole window instead,
		// and is a genuinely different SQL shape.
		module: "service-map",
		name: "serviceDbQueryTimeseriesSQL",
		label: "hourly-buckets",
		compile: () =>
			runCompile(
				CH.serviceDbQueryTimeseriesSQL({ ...window, dbSystem: "postgresql", bucketSeconds: 3600 }),
			),
	},
	{
		module: "service-map",
		name: "serviceDbQueryTimeseriesSQL",
		label: "sub-hour-buckets",
		compile: () =>
			runCompile(
				CH.serviceDbQueryTimeseriesSQL({ ...window, dbSystem: "postgresql", bucketSeconds: 300 }),
			),
	},
	{
		module: "service-map",
		name: "serviceDbTopQueriesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceDbTopQueriesSQL({ ...window, dbSystem: "postgresql" })),
	},
	{
		// apps/api/src/routes/queries.ts gcpCloudSqlStatementSpans.
		module: "service-map",
		name: "serviceDbQuerySpansQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceDbQuerySpansQuery({
					dbSystem: "postgresql",
					dbNamespaces: ["orders"],
					queryKeys: ["11640393269246331608"],
					limit: 5,
				}),
				window,
			),
	},
	{
		// Hourly MV UNION ALL raw traces, minus the internal-resolution anti-join.
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceExternalEdgesSQL({ serviceName: "web" }, window)),
		// TargetType is a String column, but both branches of the UNION emit only
		// http/messaging/rpc, and the row schema holds that line.
		sampleValues: { targetType: "http" },
	},
	{
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "env-scoped",
		compile: () =>
			runCompile(
				CH.serviceExternalEdgesSQL({ serviceName: "web", deploymentEnv: "production" }, window),
			),
		sampleValues: { targetType: "http" },
	},

	// Trace-list enrichment fixtures.
	{
		module: "traces",
		name: "traceServicesByTraceIdsQuery",
		label: "page-enrichment",
		compile: () =>
			CH.compileUnsafe(
				CH.traceServicesByTraceIdsQuery({
					traceIds: [TRACE_ID, "4bf92f3577b34da6a3ce929d0e0e4736"],
				}),
				window,
			),
	},
	{
		module: "traces",
		name: "traceSpanStatsByTraceIdsQuery",
		label: "page-enrichment",
		compile: () =>
			CH.compileUnsafe(
				CH.traceSpanStatsByTraceIdsQuery({
					traceIds: [TRACE_ID, "4bf92f3577b34da6a3ce929d0e0e4736"],
				}),
				window,
			),
	},

	// ----- activity: the only deliberately cross-org builders in the product.
	// ----- Fixtured so the catalog's tenant-scope test actually exercises the
	// ----- cross-org branch, rather than asserting a rule nothing exemplifies.
	{
		module: "activity",
		name: "activeOrgsByErrorEventsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.activeOrgsByErrorEventsQuery(), { startTime: START_TIME }),
		sampleValues: { orgId: ORG_ID },
	},
	{
		module: "activity",
		name: "activeOrgsByTracesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.activeOrgsByTracesQuery(), { startTime: START_TIME }),
		sampleValues: { orgId: ORG_ID },
	},
	{
		module: "activity",
		name: "activeOrgsByLogsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.activeOrgsByLogsQuery(), { startTime: START_TIME }),
		sampleValues: { orgId: ORG_ID },
	},

	...alertingFixtures,
	...infraFixtures,
	...remainderFixtures,
]
