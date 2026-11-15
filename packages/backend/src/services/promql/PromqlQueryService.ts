// PromQL over Maple's metric tables.
//
// The engine (`@maple/promql`) parses, plans and evaluates; this service is the
// Maple source behind it: one catalog read resolves Prometheus names to stored
// metrics, then every selector's warehouse queries run concurrently and the
// evaluator recombines their pre-aggregated buckets.

import { Context, Effect, Layer, Result, Schema, Array as Arr } from "effect"
import {
	DEFAULT_LIMITS,
	evaluate,
	type Expr,
	parse,
	planRequests,
	type QueryParams,
	type QueryResult,
	type SelectorData,
	type SelectorRequest,
	type VectorSelector,
} from "@maple/promql"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	buildSelectorQueries,
	catalogFromRows,
	catalogQuery,
	toSelectorData,
} from "@maple/query-engine/promql"
import type { CatalogMetric } from "@maple/query-engine/promql"
import type { TenantContext } from "@maple/domain/http"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

/** The query is not valid PromQL, or its parameters are out of range. Prometheus' `bad_data`. */
export class PromqlBadQueryError extends Schema.TaggedError<PromqlBadQueryError>()(
	"@maple/backend/promql/PromqlBadQueryError",
	{ message: Schema.String, position: Schema.optional(Schema.Number) },
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

export interface PromqlQuery extends QueryParams {
	readonly query: string
}

const validate = (query: PromqlQuery): Effect.Effect<Expr, PromqlBadQueryError> =>
	Effect.gen(function* () {
		const { startMs, endMs, stepMs } = query
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
			return yield* new PromqlBadQueryError({ message: "end timestamp must not be before start time" })
		}
		if (endMs > startMs) {
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
		const compiled = CH.compile(catalogQuery(), {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(window.startMs),
			endTime: formatWarehouseDateTime(window.endMs),
		})
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "promqlCatalog",
		})
		return catalogFromRows(rows)
	})

	const readSelector = Effect.fn("PromqlQueryService.readSelector")(function* (
		tenant: TenantContext,
		request: SelectorRequest,
		catalog: ReadonlyArray<CatalogMetric>,
	) {
		const plans = buildSelectorQueries(request, catalog, {
			orgId: tenant.orgId,
			maxSeries: DEFAULT_LIMITS.maxSeries,
		})
		yield* Effect.annotateCurrentSpan({
			"maple.promql.metric": request.metricName ?? "",
			"maple.promql.bucket_ms": request.widthMs,
			"maple.promql.queries": plans.length,
		})
		const results = yield* Effect.forEach(
			plans,
			(plan) =>
				Effect.map(
					warehouse.compiledQuery(tenant, plan.compiled, {
						profile: "aggregation",
						context: "promqlSelector",
					}),
					(rows) => ({ plan, rows }),
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		return toSelectorData(request, results)
	})

	const query = Effect.fn("PromqlQueryService.query")(function* (
		tenant: TenantContext,
		input: PromqlQuery,
	) {
		yield* Effect.annotateCurrentSpan({
			"maple.promql.query": input.query,
			"maple.promql.range_ms": input.endMs - input.startMs,
			"maple.promql.step_ms": input.stepMs,
		})
		const expr = yield* validate(input)
		const plan = planRequests(expr, input)
		const entries = [...plan.entries()]
		if (entries.length > MAX_SELECTORS) {
			return yield* new PromqlBadQueryError({
				message: `query reads more than ${MAX_SELECTORS} selectors`,
			})
		}
		const catalog =
			entries.length === 0
				? []
				: yield* readCatalog(tenant, span(Arr.map(entries, ([, request]) => request)))
		const read = yield* Effect.forEach(
			entries,
			([selector, request]) =>
				Effect.map(
					readSelector(tenant, request, catalog),
					(selectorData): readonly [VectorSelector, SelectorData] => [selector, selectorData],
				),
			{ concurrency: WAREHOUSE_CONCURRENCY },
		)
		const result = evaluate({ expr, params: input, data: new Map(read) })
		if (Result.isFailure(result))
			return yield* new PromqlExecutionError({ message: result.failure.message })
		return result.success satisfies QueryResult
	})

	return { query }
})

export class PromqlQueryService extends Context.Service<PromqlQueryService>()(
	"@maple/backend/services/PromqlQueryService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
