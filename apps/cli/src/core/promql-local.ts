// PromQL against the local store: the engine plans its selector reads, each runs as the warehouse
// queries `@maple/query-engine/promql` compiles for it, and the evaluator combines the rows. The
// hosted service also pushes some range functions down to ClickHouse; the answer is the same
// without them, so local mode reads buckets only.

import { Effect, Result, Array as Arr } from "effect"
import {
	DEFAULT_LIMITS,
	evaluate,
	type Expr,
	planRequests,
	resolutionError,
	type SelectorData,
	type SelectorRequest,
	type VectorSelector,
} from "@maple/promql"
import { CH, formatWarehouseDateTime, MAX_PROMQL_READ_WINDOW_SECONDS } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import {
	buildSelectorQueries,
	canonicalPromNames,
	catalogFromRows,
	catalogQuery,
	type CatalogMetric,
	toSelectorData,
} from "@maple/query-engine/promql"
import { CliUsageError } from "../lib/errors"
import { LOCAL_ORG_ID } from "./executor"
import type { PromqlWindow } from "./promql"

const MAX_SELECTORS = 20
const MAX_METRICS_PER_SELECTOR = 100
const CATALOG_LIMIT = 50_000
const CONCURRENCY = 4

const refuse = (message: string, hint?: string) =>
	new CliUsageError({ message, ...(hint === undefined ? undefined : { hint }) })

const readCatalog = (window: { readonly startMs: number; readonly endMs: number }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const rows = yield* executor.compiledQuery(
			CH.compile(catalogQuery(CATALOG_LIMIT + 1), {
				orgId: LOCAL_ORG_ID,
				startTime: formatWarehouseDateTime(window.startMs),
				endTime: formatWarehouseDateTime(window.endMs),
			}),
			{ profile: "discovery", context: "cli.promqlCatalog" },
		)
		if (rows.length > CATALOG_LIMIT) {
			return yield* refuse(`more than ${CATALOG_LIMIT} metrics in the window`, "use a shorter window")
		}
		return catalogFromRows(rows)
	})

const readSelector = (request: SelectorRequest, catalog: ReadonlyArray<CatalogMetric>) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const plans = buildSelectorQueries(request, catalog, {
			orgId: LOCAL_ORG_ID,
			maxSeries: DEFAULT_LIMITS.maxSeries,
		})
		const metrics = new Set(Arr.flatMap(plans, (plan) => [...plan.promNames.keys()])).size
		if (metrics > MAX_METRICS_PER_SELECTOR) {
			return yield* refuse(
				`a selector matches ${metrics} metrics, at most ${MAX_METRICS_PER_SELECTOR}`,
				"narrow its __name__ matcher",
			)
		}
		const results = yield* Effect.forEach(
			plans,
			(plan) =>
				Effect.map(
					executor.compiledQuery(plan.compiled, {
						profile: "aggregation",
						context: "cli.promqlSelector",
					}),
					(rows) => ({ plan, rows }),
				),
			{ concurrency: CONCURRENCY },
		)
		// A read that hit its LIMIT was cut; refuse a partial answer.
		if (Arr.some(results, ({ rows }) => rows.length > DEFAULT_LIMITS.maxSeries)) {
			return yield* refuse(
				`the query selects more than ${DEFAULT_LIMITS.maxSeries} series`,
				"narrow the selector",
			)
		}
		return toSelectorData(request, results)
	})

/** Evaluate a parsed query over the local store. */
export const runLocalPromql = (expr: Expr, window: PromqlWindow) =>
	Effect.gen(function* () {
		const resolution = resolutionError(expr, window)
		if (resolution !== undefined) return yield* refuse(resolution)
		const entries = [...planRequests(expr, window).entries()]
		if (entries.length > MAX_SELECTORS)
			return yield* refuse(`the query reads more than ${MAX_SELECTORS} selectors`)
		// Range selectors, `offset` and `@` widen reads past the window; bound the whole read.
		const readFrom = Math.min(window.startMs, ...Arr.map(entries, ([, r]) => r.startMs))
		const readTo = Math.max(window.endMs, ...Arr.map(entries, ([, r]) => r.endMs))
		if (entries.length > 0 && readTo - readFrom > MAX_PROMQL_READ_WINDOW_SECONDS * 1000) {
			return yield* refuse(
				`the query reads samples over more than ${MAX_PROMQL_READ_WINDOW_SECONDS / 86_400} days`,
				"shorten its ranges, offsets or @ timestamps",
			)
		}
		const catalog = entries.length === 0 ? [] : yield* readCatalog({ startMs: readFrom, endMs: readTo })
		const read = yield* Effect.forEach(
			entries,
			([selector, request]) =>
				Effect.map(
					readSelector(request, catalog),
					(data): readonly [VectorSelector, SelectorData] => [selector, data],
				),
			{ concurrency: CONCURRENCY },
		)
		const result = evaluate({ expr, params: window, data: new Map(read) })
		if (Result.isFailure(result))
			return yield* refuse(`PromQL could not be evaluated: ${result.failure.message}`)
		return result.success
	})

/** The Prometheus metric names the local store holds in the window. */
export const localPromqlMetricNames = (window: { readonly startMs: number; readonly endMs: number }) =>
	Effect.map(readCatalog(window), canonicalPromNames)
