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
	type Expr,
	parse,
	planPushdowns,
	planRequests,
	type PushdownCandidate,
	type PushdownData,
	type QueryParams,
	resolutionError,
	type QueryResult,
	type SelectorData,
	type SelectorRequest,
	type VectorSelector,
} from "@maple/promql"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	buildPushdownQuery,
	buildSelectorQueries,
	canonicalPromNames,
	catalogFromRows,
	catalogQuery,
	keysForLabel,
	labelNamesFrom,
	matchesValue,
	prometheusMetadata,
	promqlAttributeValuesQuery,
	resourceKeysForLabel,
	promqlMetadataQuery,
	promqlIdentityValuesQuery,
	type PushdownPlan,
	toPushdownData,
	toSelectorData,
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

/** Prometheus' own cap on points per series in a range query. */
export const MAX_STEPS = 11_000

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

const responseLimits = { maxRows: DEFAULT_LIMITS.maxSeries + 1, maxBytes: MAX_RESPONSE_BYTES }

const tooLarge = () =>
	new PromqlExecutionError({
		message:
			"query processing would load too many samples into memory; aggregate with sum by (...), narrow the selector, or increase the step",
	})

export interface PromqlQuery extends QueryParams {
	readonly query: string
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
		if (endMs > startMs || query.instant === false) {
			if (!(stepMs > 0)) {
				return yield* new PromqlBadQueryError({
					message:
						"zero or negative query resolution step widths are not accepted. Try a positive integer",
				})
			}
			if ((endMs - startMs) / stepMs > MAX_STEPS) {
				return yield* new PromqlBadQueryError({
					message: `exceeded maximum resolution of ${MAX_STEPS} points per timeseries. Try decreasing the query resolution (?step=XX)`,
				})
			}
		}
		const parsed = parse(query.query)
		if (Result.isFailure(parsed)) {
			return yield* new PromqlBadQueryError({
				message: parsed.failure.message,
				position: parsed.failure.position,
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

/** One bucket covering `[startMs, endMs]`: the cheapest read that still yields every label set. */
const discoveryRequest = (selector: VectorSelector, window: DiscoveryWindow): SelectorRequest => ({
	metricName: selector.name,
	matchers: selector.matchers,
	startMs: window.startMs - 1,
	endMs: window.endMs,
	originMs: window.startMs - 1,
	widthMs: window.endMs - window.startMs + 1,
	needsValues: false,
})

/** A label set as one string, NUL-separated: label names never hold NUL, and values practically never do. */
const seriesKey = (labels: Readonly<Record<string, string>>): string =>
	Arr.join(
		Arr.map(Rec.toEntries(labels), ([name, value]) => `${name}\u0000${value}`),
		"\u0000",
	)

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

	const query = Effect.fn("PromqlQueryService.query")(function* (
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
		const catalog = entries.length === 0 ? [] : yield* readCatalog(tenant, window)
		const options = { orgId: tenant.orgId, maxSeries: DEFAULT_LIMITS.maxSeries }
		const pushdowns = Arr.flatMap([...planPushdowns(expr, input)], ([node, candidate]) => {
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
		return result.success satisfies QueryResult
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
		const read = yield* Effect.forEach(
			selectors,
			(selector) => readSelector(tenant, discoveryRequest(selector, window), catalog),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		// seriesLabels sorts its keys, so the joined pairs are a stable identity.
		const unique = new Map(
			Arr.flatMap(read, (data) =>
				Arr.map(data.series, (s) => [seriesKey(s.labels), s.labels] as const),
			),
		)
		const limit = Math.min(input.limit ?? DISCOVERY_LIMIT, DISCOVERY_LIMIT)
		yield* Effect.annotateCurrentSpan({
			"maple.promql.matches": input.matches.length,
			"maple.promql.range_ms": window.endMs - window.startMs,
			"maple.promql.series": unique.size,
		})
		return Arr.take([...unique.values()], limit)
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

	const sortedUnique = (values: ReadonlyArray<string>) =>
		Arr.take(Arr.sort(Arr.dedupe(values), Order.String), DISCOVERY_LIMIT)

	/** The caller's `limit` counts distinct names or values, so it applies after deduplication. */
	const limited = (values: ReadonlyArray<string>, limit: number | undefined) =>
		Arr.take(values, Math.min(limit ?? DISCOVERY_LIMIT, DISCOVERY_LIMIT))

	const labelNames = Effect.fn("PromqlQueryService.labelNames")(function* (
		tenant: TenantContext,
		input: DiscoveryQuery,
	) {
		const window = yield* validateWindow(input)
		if (input.matches.length > 0) {
			const found = yield* series(tenant, { ...input, limit: undefined })
			return limited(sortedUnique(Arr.flatMap(found, (labels) => Rec.keys(labels))), input.limit)
		}
		const [catalog, keys] = yield* Effect.all(
			[readCatalog(tenant, window), bothAttributeKeys(tenant, window)],
			{ concurrency: 2 },
		)
		return limited(labelNamesFrom(catalog, ...keys), input.limit)
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
		const values = yield* Effect.forEach(
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
		return Arr.flatten(values)
	})

	/** `job` or `instance` values as series carry them: one bounded read per metric table. */
	const identityValues = Effect.fn("PromqlQueryService.identityValues")(function* (
		tenant: TenantContext,
		window: DiscoveryWindow,
		label: "job" | "instance",
	) {
		const perTable = yield* Effect.forEach(
			PROMQL_METRIC_TABLES,
			(table) =>
				warehouse.compiledQuery(
					tenant,
					CH.compile(promqlIdentityValuesQuery({ table, label, limit: DISCOVERY_LIMIT }), {
						orgId: tenant.orgId,
						startMs: window.startMs,
						endMs: window.endMs,
					}),
					{ profile: "discovery", context: label === "job" ? "promqlJobs" : "promqlInstances" },
				),
			{ concurrency: "unbounded" },
		)
		return Arr.flatMap(perTable, (rows) => Arr.map(rows, (row) => row.value))
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
			return limited(
				sortedUnique(Arr.flatMap(found, (labels) => Option.toArray(Rec.get(labels, input.name)))),
				input.limit,
			)
		}
		switch (input.name) {
			case "__name__":
				return yield* Effect.map(readCatalog(tenant, window), (catalog) =>
					limited(sortedUnique(canonicalPromNames(catalog)), input.limit),
				)
			case "job":
				return yield* Effect.map(identityValues(tenant, window, "job"), (names) =>
					limited(sortedUnique(names), input.limit),
				)
			case "instance":
				return yield* Effect.map(identityValues(tenant, window, "instance"), (values) =>
					limited(sortedUnique(values), input.limit),
				)
			default:
				return yield* Effect.map(attributeValues(tenant, window, input.name), (values) =>
					limited(sortedUnique(values), input.limit),
				)
		}
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
		const limit = input.limit !== undefined && input.limit > 0 ? input.limit : entries.length
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

	return { query, series, labelNames, labelValues, metadata }
})

export class PromqlQueryService extends Context.Service<PromqlQueryService>()(
	"@maple/backend/services/PromqlQueryService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
