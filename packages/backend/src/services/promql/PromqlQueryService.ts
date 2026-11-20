// PromQL over Maple's metric tables.
//
// The engine (`@maple/promql`) parses, plans and evaluates; this service is the
// Maple source behind it: one catalog read resolves Prometheus names to stored
// metrics. Subtrees ClickHouse can evaluate whole (a range function over a
// selector, optionally summed by labels) run there and return one value per
// step; every other selector returns pre-aggregated buckets the evaluator
// recombines.

import { Context, Effect, Layer, Option, Order, Result, Schema, Array as Arr, Record as Rec } from "effect"
import {
	DEFAULT_LIMITS,
	evaluate,
	isInstant,
	MAX_POINTS_PER_SERIES,
	type Expr,
	type LabelMatcher,
	parse,
	planPushdowns,
	planRequests,
	type PushdownCandidate,
	type PushdownData,
	type PushdownRequest,
	type QueryParams,
	resolutionError,
	type QueryResult,
	type SelectorData,
	type SelectorRequest,
	valueTypeOf,
	type VectorSelector,
} from "@maple/promql"
import {
	CH,
	formatWarehouseDateTime,
	interpolatePromqlBuiltins,
	MAX_PROMQL_READ_WINDOW_SECONDS,
	parseWarehouseDateTime,
	promqlRowsForDisplay,
	promqlStepSeconds,
	type PromqlRow,
} from "@maple/query-engine"
import {
	buildPushdownQuery,
	buildSelectorQueries,
	buildSeriesLabelsQueries,
	canonicalPromNames,
	catalogFromRows,
	catalogQuery,
	keysForLabel,
	labelNamesFrom,
	matchesValue,
	missingLabelMatchers,
	resolveSelectorName,
	unknownLabelWarning,
	unknownMetricWarning,
	prometheusMetadata,
	promqlAttributeValuesQuery,
	resourceKeysForLabel,
	promqlMetadataQuery,
	promqlIdentityValuesQuery,
	type PushdownPlan,
	toPushdownData,
	toSelectorData,
	toSeriesLabels,
} from "@maple/query-engine/promql"
import type { CatalogMetric } from "@maple/query-engine/promql"
import type { TenantContext } from "@maple/domain/http"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

/** The query is not valid PromQL, or its parameters are out of range. Prometheus' `bad_data`. */
export class PromqlBadQueryError extends Schema.TaggedError<PromqlBadQueryError>()(
	"@maple/backend/promql/PromqlBadQueryError",
	{ message: Schema.String, position: Schema.optionalKey(Schema.Number) },
) {}

/** The query is valid but cannot be evaluated: limits, many-to-many matching. Prometheus' `execution`. */
export class PromqlExecutionError extends Schema.TaggedError<PromqlExecutionError>()(
	"@maple/backend/promql/PromqlExecutionError",
	{ message: Schema.String },
) {}

/** Prometheus' cap on whole steps in a range query; the engine's `resolutionError` enforces it. */
export const MAX_STEPS = MAX_POINTS_PER_SERIES

/** Selectors one query may read; each is at least one warehouse query. */
const MAX_SELECTORS = 20

const WAREHOUSE_CONCURRENCY = 4

/**
 * The most one warehouse response may hold. The API runs in a 128 MB isolate;
 * a selector the source cannot evaluate whole returns its buckets, and past
 * this the query fails cleanly instead of exhausting memory.
 */
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024

/** Stored metrics one selector may read; `{__name__=~".+"}` would otherwise read them all. */
const MAX_METRICS_PER_SELECTOR = 100

/** Catalog rows read to resolve names; one more comes back when the org has more. */
const CATALOG_LIMIT = 50_000

/**
 * The most steps one bucket may feed in a pushdown, which copies each bucket once per step whose
 * window holds it. Measured ~2.3s at 1000 (300 series x 1000 samples); past this the bucket read
 * is cheaper, or fails fast on the response cap instead of scanning for minutes.
 */
const MAX_PUSHDOWN_FANOUT = 4096

const pushdownFanout = (request: PushdownRequest): number =>
	request.steps <= 1 ? 1 : Math.min(request.steps, Math.ceil(request.rangeMs / request.stepMs))

const responseLimits = { maxRows: DEFAULT_LIMITS.maxSeries + 1, maxBytes: MAX_RESPONSE_BYTES }

const tooLarge = () =>
	new PromqlExecutionError({
		message:
			"query processing would load too many samples into memory; aggregate with sum by (...), narrow the selector, or increase the step",
	})

export interface PromqlQuery extends QueryParams {
	readonly query: string
}

/** A query result with Prometheus' `warnings`: the nearest names when a selector matched nothing. */
export type PromqlAnswer = QueryResult & { readonly warnings: ReadonlyArray<string> }

/** A discovery answer with Prometheus' `warnings`, set when the limit cut it. */
export interface Discovered<A> {
	readonly data: A
	readonly warnings: ReadonlyArray<string>
}

export const TRUNCATED_WARNING = "results truncated due to limit"

/** A dashboard widget's PromQL over a warehouse window; the service picks the step. */
export interface PromqlWidgetInput {
	readonly query: string
	readonly startTime: string
	readonly endTime: string
	readonly legendFormat?: string
	readonly minStepSeconds?: number
	readonly maxDataPoints?: number
	readonly displayType?: string
}

export interface PromqlWidgetResult {
	readonly rows: ReadonlyArray<PromqlRow>
	readonly resultType: QueryResult["resultType"]
	readonly seriesCount: number
	readonly stepSeconds: number
	/** Prometheus-style warnings: why the result is empty, or what it left out. */
	readonly warnings: ReadonlyArray<string>
}

/** The epoch ms a JavaScript Date can hold, and so the warehouse time formatting. */
const MAX_DATE_MS = 8.64e15

const inDateRange = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS

const validate = (query: PromqlQuery): Effect.Effect<Expr, PromqlBadQueryError> =>
	Effect.gen(function* () {
		const { startMs, endMs, stepMs } = query
		if (!inDateRange(startMs) || !inDateRange(endMs) || !Number.isFinite(stepMs)) {
			return yield* new PromqlBadQueryError({
				message: "timestamps and step must be finite and in range",
			})
		}
		if (endMs < startMs) {
			return yield* new PromqlBadQueryError({ message: "end timestamp must not be before start time" })
		}
		const parsed = parse(query.query)
		if (Result.isFailure(parsed)) {
			return yield* new PromqlBadQueryError({
				message: parsed.failure.message,
				position: parsed.failure.position,
			})
		}
		// Prometheus refuses these before evaluating, as bad_data.
		const type = valueTypeOf(parsed.success)
		if (!isInstant(query) && (type === "matrix" || type === "string")) {
			return yield* new PromqlBadQueryError({
				message: `invalid expression type "${type === "matrix" ? "range vector" : "string"}" for range query, must be Scalar or instant Vector`,
			})
		}
		return parsed.success
	})

/** A discovery call (series, labels, label values, metadata) over `[startMs, endMs]`. */
export interface DiscoveryWindow {
	readonly startMs: number
	readonly endMs: number
}

export interface DiscoveryQuery extends DiscoveryWindow {
	/** `match[]` series selectors; empty reads the catalog and rollups instead. */
	readonly matches: ReadonlyArray<string>
	readonly limit?: number
}

/** Names and values one discovery call returns at most. */
export const DISCOVERY_LIMIT = 10_000
const ATTRIBUTE_KEY_LIMIT = 1_000

type AttributeScope = "metric" | "resource"

const PROMQL_METRIC_TABLES = [
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
] as const
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const validateWindow = (window: DiscoveryWindow): Effect.Effect<DiscoveryWindow, PromqlBadQueryError> =>
	!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs < window.startMs
		? Effect.fail(new PromqlBadQueryError({ message: "end timestamp must not be before start time" }))
		: Effect.succeed(window)

/** One `match[]` value: a plain vector selector with at least one matcher that rejects "". */
const parseMatch = (text: string): Effect.Effect<VectorSelector, PromqlBadQueryError> => {
	const parsed = parse(text)
	if (Result.isFailure(parsed)) {
		return Effect.fail(
			new PromqlBadQueryError({
				message: `invalid parameter "match[]": ${parsed.failure.message}`,
				position: parsed.failure.position,
			}),
		)
	}
	const expr = parsed.success
	if (expr.type !== "VectorSelector") {
		return Effect.fail(
			new PromqlBadQueryError({
				message: `invalid parameter "match[]": ${text} is not a series selector`,
			}),
		)
	}
	if (!Arr.some(expr.matchers, (m) => !matchesValue(m, ""))) {
		return Effect.fail(
			new PromqlBadQueryError({
				message: "match[] must contain at least one non-empty matcher",
			}),
		)
	}
	return Effect.succeed(expr)
}

/** Stored metrics one discovery read filters on; a selector keeping more splits them over reads. */
const DISCOVERY_NAME_FILTER_LIMIT = 500
/**
 * Reads per table per selector, so a call makes at most 4 tables x 4 x MAX_SELECTORS reads; past
 * 2,000 stored metrics in a table, the rest (in name order) are left out, as rows past the limit are.
 */
const DISCOVERY_NAME_READS = 4

/**
 * The window `job` and `instance` values are read over. No rollup keeps them, so the read scans
 * raw tables; values only seen before the last day of a longer range are left out.
 */
const IDENTITY_WINDOW_MS = 24 * 3_600_000

/** A label set as one string, NUL-separated: label names never hold NUL, and values practically never do. */
const seriesKey = (labels: Readonly<Record<string, string>>): string =>
	Arr.join(
		Arr.map(Rec.toEntries(labels), ([name, value]) => `${name}\u0000${value}`),
		"\u0000",
	)

/** Selectors whose label names one empty answer checks, and the series each check reads. */
const MAX_HINT_READS = 3
const HINT_SERIES_LIMIT = 500
const HINT_NAME_FILTER_LIMIT = 50

const nameMatchersOf = (selector: VectorSelector): ReadonlyArray<LabelMatcher> =>
	Arr.filter(selector.matchers, (m) => m.name === "__name__")

const isEmptyResult = (result: QueryResult): boolean =>
	(result.resultType === "matrix" || result.resultType === "vector") && result.result.length === 0

/**
 * Whether a discovery selector keeps more stored metrics in a table than its name-filtered reads
 * cover; the planner leaves the rest out. A selector keeping every metric of a table reads it unfiltered.
 */
const namesOmitted = (matchers: ReadonlyArray<LabelMatcher>, catalog: ReadonlyArray<CatalogMetric>) => {
	const kept = resolveSelectorName(
		Arr.filter(matchers, (m) => m.name === "__name__"),
		catalog,
	)
	const everything = resolveSelectorName([], catalog)
	return Arr.some(Arr.dedupe(Arr.map(kept, (t) => t.table)), (table) => {
		const inTable = Arr.filter(kept, (t) => t.table === table)
		if (inTable.length === Arr.filter(everything, (t) => t.table === table).length) return false
		const metrics = Arr.dedupe(Arr.map(inTable, (t) => `${t.metricName}\u0000${t.unit}`))
		return metrics.length > DISCOVERY_NAME_FILTER_LIMIT * DISCOVERY_NAME_READS
	})
}

const discovered = <A>(data: A, truncated: boolean): Discovered<A> => ({
	data,
	warnings: truncated ? [TRUNCATED_WARNING] : [],
})

const span = (requests: ReadonlyArray<SelectorRequest>) => ({
	startMs: Math.min(...Arr.map(requests, (r) => r.startMs)),
	endMs: Math.max(...Arr.map(requests, (r) => r.endMs)),
})

const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService

	const readCatalog = Effect.fn("PromqlQueryService.readCatalog")(function* (
		tenant: TenantContext,
		window: { readonly startMs: number; readonly endMs: number },
	) {
		const compiled = CH.compile(catalogQuery(CATALOG_LIMIT + 1), {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(window.startMs),
			endTime: formatWarehouseDateTime(window.endMs),
		})
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "promqlCatalog",
		})
		if (rows.length > CATALOG_LIMIT) {
			// A cut catalog would silently drop names; refuse instead.
			return yield* new PromqlExecutionError({
				message: `this organization has more than ${CATALOG_LIMIT} metrics in the range; shorten the range`,
			})
		}
		return catalogFromRows(rows)
	})

	const readSelector = Effect.fn("PromqlQueryService.readSelector")(
		function* (tenant: TenantContext, request: SelectorRequest, catalog: ReadonlyArray<CatalogMetric>) {
			const plans = buildSelectorQueries(request, catalog, {
				orgId: tenant.orgId,
				maxSeries: DEFAULT_LIMITS.maxSeries,
			})
			// A histogram's _bucket, _count and _sum are three plans over one stored metric.
			const metrics = new Set(Arr.flatMap(plans, (plan) => [...plan.promNames.keys()])).size
			if (metrics > MAX_METRICS_PER_SELECTOR) {
				return yield* new PromqlExecutionError({
					message: `a selector matches ${metrics} metrics, at most ${MAX_METRICS_PER_SELECTOR}; narrow its __name__ matcher`,
				})
			}
			yield* Effect.annotateCurrentSpan({
				"maple.promql.metric": request.metricName ?? "",
				"maple.promql.bucket_ms": request.widthMs,
				"maple.promql.queries": plans.length,
			})
			const results = yield* Effect.forEach(
				plans,
				(plan) =>
					Effect.map(
						warehouse.compiledQueryBounded(tenant, plan.compiled, {
							profile: "aggregation",
							context: "promqlSelector",
							responseLimits,
						}),
						(rows) => ({ plan, rows }),
					),
				{ concurrency: WAREHOUSE_CONCURRENCY },
			)
			// A query that hit its LIMIT was cut, maybe before the regex `le` check after it; refuse a partial answer.
			if (Arr.some(results, ({ rows }) => rows.length > DEFAULT_LIMITS.maxSeries)) {
				return yield* new PromqlExecutionError({
					message: `query selects more than ${DEFAULT_LIMITS.maxSeries} series; narrow the selector`,
				})
			}
			return toSelectorData(request, results)
		},
		Effect.catchTag("@maple/query-engine/execution/WarehouseResponseLimitError", () =>
			Effect.fail(tooLarge()),
		),
	)

	const readPushdown = Effect.fn("PromqlQueryService.readPushdown")(
		function* (tenant: TenantContext, candidate: PushdownCandidate, plan: PushdownPlan) {
			yield* Effect.annotateCurrentSpan({
				"maple.promql.metric": plan.promName,
				"maple.promql.function": candidate.request.func,
				"maple.promql.aggregation": candidate.request.aggregation?.op ?? "",
				"maple.promql.bucket_ms": candidate.request.widthMs,
			})
			const rows = yield* warehouse.compiledQueryBounded(tenant, plan.compiled, {
				profile: "aggregation",
				context: "promqlPushdown",
				responseLimits,
			})
			return toPushdownData(candidate.request, plan, rows)
		},
		Effect.catchTag("@maple/query-engine/execution/WarehouseResponseLimitError", () =>
			Effect.fail(tooLarge()),
		),
	)

	/** The label names series of a selector's metrics carry, from one small series read. */
	const presentLabels = Effect.fn("PromqlQueryService.presentLabels")(function* (
		tenant: TenantContext,
		nameMatchers: ReadonlyArray<LabelMatcher>,
		catalog: ReadonlyArray<CatalogMetric>,
		window: DiscoveryWindow,
	) {
		const plans = buildSeriesLabelsQueries(nameMatchers, window, catalog, {
			orgId: tenant.orgId,
			limit: HINT_SERIES_LIMIT,
			maxNameFilter: HINT_NAME_FILTER_LIMIT,
			maxNameReads: 1,
		})
		const found = yield* Effect.forEach(
			plans,
			(plan) =>
				Effect.map(
					warehouse.compiledQuery(tenant, plan.compiled, {
						profile: "discovery",
						context: "promqlHintLabels",
					}),
					(rows) => toSeriesLabels(nameMatchers, [{ plan, rows }]),
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		return new Set(Arr.flatMap(Arr.flatten(found), (labels) => Rec.keys(labels)))
	})

	/**
	 * Warnings for selectors that matched nothing: unknown metric names always (the catalog is in
	 * hand), unknown label names only when the result is empty, as they cost a series read each.
	 */
	const hints = Effect.fn("PromqlQueryService.hints")(function* (
		tenant: TenantContext,
		selectors: ReadonlyArray<VectorSelector>,
		catalog: ReadonlyArray<CatalogMetric>,
		window: DiscoveryWindow,
		empty: boolean,
	) {
		const exactNames = Arr.flatMap(selectors, (selector) =>
			Option.match(
				Arr.findFirst(selector.matchers, (m) => m.name === "__name__" && m.op === "="),
				{
					onNone: () => [],
					onSome: (m) => [{ selector, name: m.value, nameMatchers: nameMatchersOf(selector) }],
				},
			),
		)
		const resolves = (entry: (typeof exactNames)[number]) =>
			resolveSelectorName(entry.nameMatchers, catalog).length > 0
		const unknown = Arr.filter(exactNames, (entry) => !resolves(entry))
		const known = Arr.filter(exactNames, resolves)
		const nameWarnings = Arr.dedupe(Arr.map(unknown, ({ name }) => unknownMetricWarning(name, catalog)))
		if (!empty) return nameWarnings
		const checked = Arr.take(
			Arr.filter(
				known,
				({ selector }) => missingLabelMatchers(selector.matchers, new Set()).length > 0,
			),
			MAX_HINT_READS,
		)
		const labelWarnings = yield* Effect.forEach(
			checked,
			({ selector, name, nameMatchers }) =>
				Effect.map(presentLabels(tenant, nameMatchers, catalog, window), (present) =>
					present.size === 0
						? []
						: Arr.map(missingLabelMatchers(selector.matchers, present), (matcher) =>
								unknownLabelWarning(name, matcher.name, [...present]),
							),
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		).pipe(
			// Hints explain an answer that already succeeded; a failed hint read must not fail it.
			Effect.catch((error) => Effect.as(Effect.logWarning("PromQL label hint read failed", error), [])),
		)
		return Arr.dedupe([...nameWarnings, ...Arr.flatten(labelWarnings)])
	})

	const query_ = Effect.fn("PromqlQueryService.query")(function* (
		tenant: TenantContext,
		input: PromqlQuery,
	) {
		yield* Effect.annotateCurrentSpan({
			"maple.promql.query_length": input.query.length,
			"maple.promql.range_ms": input.endMs - input.startMs,
			"maple.promql.step_ms": input.stepMs,
		})
		const expr = yield* validate(input)
		const resolution = resolutionError(expr, input)
		if (resolution !== undefined) return yield* new PromqlBadQueryError({ message: resolution })
		const plan = planRequests(expr, input)
		const entries = [...plan.entries()]
		if (entries.length > MAX_SELECTORS) {
			return yield* new PromqlBadQueryError({
				message: `query reads more than ${MAX_SELECTORS} selectors`,
			})
		}
		const window = span(Arr.map(entries, ([, request]) => request))
		// `@` and `offset` move reads past the request's own range.
		if (entries.length > 0 && !(inDateRange(window.startMs) && inDateRange(window.endMs))) {
			return yield* new PromqlBadQueryError({
				message: "query reads samples outside the supported time range",
			})
		}
		// Range selectors, `offset`, `@` and subqueries move and widen reads past [start, end]; bound both.
		const readFrom = Math.min(window.startMs, input.startMs)
		const readTo = Math.max(window.endMs, input.endMs)
		if (entries.length > 0 && readTo - readFrom > MAX_PROMQL_READ_WINDOW_SECONDS * 1000) {
			return yield* new PromqlBadQueryError({
				message: `query reads samples over more than ${MAX_PROMQL_READ_WINDOW_SECONDS / 86_400} days; shorten its ranges, offsets or @ timestamps`,
			})
		}
		const catalog = entries.length === 0 ? [] : yield* readCatalog(tenant, window)
		const options = { orgId: tenant.orgId, maxSeries: DEFAULT_LIMITS.maxSeries }
		const pushdowns = Arr.flatMap([...planPushdowns(expr, input)], ([node, candidate]) => {
			if (pushdownFanout(candidate.request) > MAX_PUSHDOWN_FANOUT) return []
			const plan = buildPushdownQuery(candidate.request, catalog, options)
			return plan === undefined ? [] : [{ node, candidate, plan }]
		})
		const skipped = new Set(Arr.map(pushdowns, ({ candidate }) => candidate.selector))
		yield* Effect.annotateCurrentSpan("maple.promql.pushdowns", pushdowns.length)
		const pushed = yield* Effect.forEach(
			pushdowns,
			({ node, candidate, plan }) =>
				Effect.map(
					readPushdown(tenant, candidate, plan),
					(pushdownData): readonly [Expr, PushdownData] => [node, pushdownData],
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		const read = yield* Effect.forEach(
			Arr.filter(entries, ([selector]) => !skipped.has(selector)),
			([selector, request]) =>
				Effect.map(
					readSelector(tenant, request, catalog),
					(selectorData): readonly [VectorSelector, SelectorData] => [selector, selectorData],
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		const result = evaluate({ expr, params: input, data: new Map(read), pushed: new Map(pushed) })
		if (Result.isFailure(result))
			return yield* new PromqlExecutionError({ message: result.failure.message })
		const selectors = Arr.map(entries, ([selector]) => selector)
		const warnings = yield* hints(tenant, selectors, catalog, window, isEmptyResult(result.success))
		const answer: PromqlAnswer = { ...result.success, warnings }
		return answer
	})

	const windowParams = (tenant: TenantContext, window: DiscoveryWindow) => ({
		orgId: tenant.orgId,
		startTime: formatWarehouseDateTime(window.startMs),
		endTime: formatWarehouseDateTime(window.endMs),
	})

	const series = Effect.fn("PromqlQueryService.series")(function* (
		tenant: TenantContext,
		input: DiscoveryQuery,
	) {
		const window = yield* validateWindow(input)
		if (input.matches.length === 0) {
			return yield* new PromqlBadQueryError({ message: "no match[] parameter provided" })
		}
		// Each match[] is at least one warehouse read, like a selector in a query.
		if (input.matches.length > MAX_SELECTORS) {
			return yield* new PromqlBadQueryError({
				message: `match[] reads more than ${MAX_SELECTORS} selectors`,
			})
		}
		const selectors = yield* Effect.forEach(input.matches, parseMatch)
		const catalog = yield* readCatalog(tenant, window)
		// Not the query path's per-metric reads: `{job="api"}` resolves to every metric, which a
		// discovery call must still answer. A few label-set reads per table instead, cut at the limit.
		const read = yield* Effect.forEach(
			Arr.flatMap(selectors, (selector) =>
				Arr.map(
					buildSeriesLabelsQueries(selector.matchers, window, catalog, {
						orgId: tenant.orgId,
						limit: DISCOVERY_LIMIT,
						maxNameFilter: DISCOVERY_NAME_FILTER_LIMIT,
						maxNameReads: DISCOVERY_NAME_READS,
					}),
					(plan) => ({ selector, plan }),
				),
			),
			({ selector, plan }) =>
				Effect.map(
					warehouse.compiledQuery(tenant, plan.compiled, {
						profile: "discovery",
						context: "promqlSeries",
					}),
					(rows) => ({
						found: toSeriesLabels(selector.matchers, [{ plan, rows }]),
						cut: rows.length >= DISCOVERY_LIMIT,
					}),
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		// seriesLabels sorts its keys, so the joined pairs are a stable identity.
		const unique = new Map(
			Arr.flatMap(read, ({ found }) =>
				Arr.map(found, (labels) => [seriesKey(labels), labels] as const),
			),
		)
		const limit = Math.min(input.limit ?? DISCOVERY_LIMIT, DISCOVERY_LIMIT)
		yield* Effect.annotateCurrentSpan({
			"maple.promql.matches": input.matches.length,
			"maple.promql.range_ms": window.endMs - window.startMs,
			"maple.promql.series": unique.size,
		})
		return discovered(
			Arr.take([...unique.values()], limit),
			unique.size > limit ||
				Arr.some(read, ({ cut }) => cut) ||
				Arr.some(selectors, (selector) => namesOmitted(selector.matchers, catalog)),
		)
	})

	const attributeKeys = Effect.fn("PromqlQueryService.attributeKeys")(function* (
		tenant: TenantContext,
		window: DiscoveryWindow,
		scope: AttributeScope,
	) {
		const compiled = CH.compile(
			CH.attributeKeysQuery({ scope, limit: ATTRIBUTE_KEY_LIMIT }),
			windowParams(tenant, window),
		)
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "promqlLabelNames",
		})
		return Arr.map(rows, (row) => row.attributeKey)
	})

	/** Datapoint keys and resource keys, read concurrently. */
	const bothAttributeKeys = (tenant: TenantContext, window: DiscoveryWindow) =>
		Effect.all([attributeKeys(tenant, window, "metric"), attributeKeys(tenant, window, "resource")], {
			concurrency: 2,
		})

	/**
	 * Distinct values, sorted and cut at the caller's `limit` (at most DISCOVERY_LIMIT), which counts
	 * distinct names or values; warns when that cut them or a source read came back full (`cut`).
	 */
	const limitedUnique = (values: ReadonlyArray<string>, limit: number | undefined, cut: boolean) => {
		const all = Arr.sort(Arr.dedupe(values), Order.String)
		const max = Math.min(limit ?? DISCOVERY_LIMIT, DISCOVERY_LIMIT)
		return discovered(Arr.take(all, max), cut || all.length > max)
	}

	const labelNames = Effect.fn("PromqlQueryService.labelNames")(function* (
		tenant: TenantContext,
		input: DiscoveryQuery,
	) {
		const window = yield* validateWindow(input)
		if (input.matches.length > 0) {
			const found = yield* series(tenant, { ...input, limit: undefined })
			return limitedUnique(
				Arr.flatMap(found.data, (labels) => Rec.keys(labels)),
				input.limit,
				found.warnings.length > 0,
			)
		}
		const [catalog, keys] = yield* Effect.all(
			[readCatalog(tenant, window), bothAttributeKeys(tenant, window)],
			{ concurrency: 2 },
		)
		return limitedUnique(
			labelNamesFrom(catalog, ...keys),
			input.limit,
			Arr.some(keys, (read) => read.length >= ATTRIBUTE_KEY_LIMIT),
		)
	})

	const attributeValues = Effect.fn("PromqlQueryService.attributeValues")(function* (
		tenant: TenantContext,
		window: DiscoveryWindow,
		name: string,
	) {
		const [metricKeys, resourceKeys] = yield* bothAttributeKeys(tenant, window)
		const candidates: ReadonlyArray<{ scope: AttributeScope; keys: ReadonlyArray<string> }> = [
			{ scope: "metric", keys: keysForLabel(metricKeys, name) },
			{ scope: "resource", keys: resourceKeysForLabel(resourceKeys, name) },
		]
		const reads = Arr.filter(candidates, (read) => read.keys.length > 0)
		const perRead = yield* Effect.forEach(
			reads,
			(read) =>
				Effect.map(
					warehouse.compiledQuery(
						tenant,
						CH.compile(
							promqlAttributeValuesQuery({ ...read, limit: DISCOVERY_LIMIT }),
							windowParams(tenant, window),
						),
						{ profile: "discovery", context: "promqlLabelValues" },
					),
					(rows) => Arr.map(rows, (row) => row.attributeValue),
				),
			{ concurrency: 2 },
		)
		// A full key list may have left the label's raw key out, as a full value read leaves values out.
		const keysFull = Arr.some([metricKeys, resourceKeys], (keys) => keys.length >= ATTRIBUTE_KEY_LIMIT)
		return {
			values: Arr.flatten(perRead),
			cut: keysFull || Arr.some(perRead, (v) => v.length >= DISCOVERY_LIMIT),
		}
	})

	/** `job` or `instance` values as series carry them: one bounded read per metric table. */
	const identityValues = Effect.fn("PromqlQueryService.identityValues")(function* (
		tenant: TenantContext,
		window: DiscoveryWindow,
		label: "job" | "instance",
	) {
		const startMs = Math.max(window.startMs, window.endMs - IDENTITY_WINDOW_MS)
		const perTable = yield* Effect.forEach(
			PROMQL_METRIC_TABLES,
			(table) =>
				warehouse.compiledQuery(
					tenant,
					CH.compile(promqlIdentityValuesQuery({ table, label, limit: DISCOVERY_LIMIT }), {
						orgId: tenant.orgId,
						startMs,
						endMs: window.endMs,
					}),
					{ profile: "discovery", context: label === "job" ? "promqlJobs" : "promqlInstances" },
				),
			{ concurrency: "unbounded" },
		)
		return {
			values: Arr.flatMap(perTable, (rows) => Arr.map(rows, (row) => row.value)),
			cut: Arr.some(perTable, (rows) => rows.length >= DISCOVERY_LIMIT),
		}
	})

	const labelValues = Effect.fn("PromqlQueryService.labelValues")(function* (
		tenant: TenantContext,
		input: DiscoveryQuery & { readonly name: string },
	) {
		if (!LABEL_NAME.test(input.name)) {
			return yield* new PromqlBadQueryError({ message: `invalid label name: "${input.name}"` })
		}
		const window = yield* validateWindow(input)
		yield* Effect.annotateCurrentSpan({ "maple.promql.label": input.name })
		if (input.matches.length > 0) {
			const found = yield* series(tenant, { ...input, limit: undefined })
			return limitedUnique(
				Arr.flatMap(found.data, (labels) => Option.toArray(Rec.get(labels, input.name))),
				input.limit,
				found.warnings.length > 0,
			)
		}
		const read =
			input.name === "__name__"
				? Effect.map(readCatalog(tenant, window), (catalog) => ({
						values: canonicalPromNames(catalog),
						cut: false,
					}))
				: input.name === "job" || input.name === "instance"
					? identityValues(tenant, window, input.name)
					: attributeValues(tenant, window, input.name)
		const { values, cut } = yield* read
		return limitedUnique(values, input.limit, cut)
	})

	const metadata = Effect.fn("PromqlQueryService.metadata")(function* (
		tenant: TenantContext,
		input: DiscoveryWindow & { readonly metric?: string; readonly limit?: number },
	) {
		const window = yield* validateWindow(input)
		const compiled = CH.compile(promqlMetadataQuery({ limit: 50_000 }), windowParams(tenant, window))
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "promqlMetadata",
		})
		const entries = Arr.filter(
			[...prometheusMetadata(rows)],
			([name]) => input.metric === undefined || input.metric === name,
		)
		const limit = Math.min(
			input.limit !== undefined && input.limit > 0 ? input.limit : DISCOVERY_LIMIT,
			DISCOVERY_LIMIT,
		)
		return new Map(
			Arr.take(
				Arr.sort(
					entries,
					Order.mapInput(Order.String, (entry: readonly [string, unknown]) => entry[0]),
				),
				limit,
			),
		)
	})

	const widget = Effect.fn("PromqlQueryService.widget")(function* (
		tenant: TenantContext,
		input: PromqlWidgetInput,
	) {
		const startMs = parseWarehouseDateTime(input.startTime)
		const endMs = parseWarehouseDateTime(input.endTime)
		// Checked before alignment, which would turn a reversed window into a valid instant.
		if (!(endMs >= startMs)) {
			return yield* new PromqlBadQueryError({ message: "end timestamp must not be before start time" })
		}
		const stepSeconds = promqlStepSeconds({
			startMs,
			endMs,
			...(input.maxDataPoints === undefined ? undefined : { maxDataPoints: input.maxDataPoints }),
			...(input.minStepSeconds === undefined ? undefined : { minStepSeconds: input.minStepSeconds }),
		})
		const stepMs = stepSeconds * 1000
		// Steps land on multiples of the step, so neighbouring refreshes share their points.
		const alignedStart = Math.floor(startMs / stepMs) * stepMs
		const alignedEnd = Math.max(alignedStart, Math.floor(endMs / stepMs) * stepMs)
		const query = interpolatePromqlBuiltins(input.query, { startMs, endMs, stepMs })
		// Range mode even for a one-step window: a chart always wants a matrix.
		const result = yield* query_(tenant, {
			query,
			startMs: alignedStart,
			endMs: alignedEnd,
			stepMs,
			instant: false,
		})
		const rows = promqlRowsForDisplay(result, {
			...(input.displayType === undefined ? undefined : { displayType: input.displayType }),
			...(input.legendFormat === undefined ? undefined : { legendFormat: input.legendFormat }),
		})
		return {
			rows,
			resultType: result.resultType,
			seriesCount:
				result.resultType === "matrix" || result.resultType === "vector" ? result.result.length : 1,
			stepSeconds,
			warnings: result.warnings,
		} satisfies PromqlWidgetResult
	})

	return { query: query_, series, labelNames, labelValues, metadata, widget }
})

export class PromqlQueryService extends Context.Service<PromqlQueryService>()(
	"@maple/backend/services/PromqlQueryService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
