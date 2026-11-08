import { Array as Arr, Effect } from "effect"
import type { HttpClient } from "effect/http"
import {
	DataSourceLimitError,
	type DataSourceDriverError,
	type DataSourceTable,
} from "@maple/domain/data-sources"
import type { QueryContext, QueryRequest } from "../port"
import { aggregateRows, matchesAll, projectRows, valueColumn } from "./aggregate"
import { type ResourcePlan, serverFieldList, tooManyBuckets } from "./plan"
import { bucketStart, toIso } from "./time"
import type { ResolvedFilter, ResourceRow } from "./types"
import type { ValidatedQuery } from "./validate"

/** Calls spent and made together; small so a refused budget stops the plan early. */
const COUNT_BATCH = 5

type Run<A> = Effect.Effect<A, DataSourceDriverError, HttpClient.HttpClient>

const runCount = (
	query: ValidatedQuery,
	{ count, buckets, scanPages }: Extract<ResourcePlan, { _tag: "count" }>,
	request: QueryRequest,
	context: QueryContext,
): Run<DataSourceTable> => {
	const { granularitySeconds, startMs, endMs } = request.window
	const name = valueColumn(query)
	if (buckets === null) {
		return Effect.map(Effect.andThen(context.spend(1), count(query.serverFilters)), (total) => ({
			columns: [{ name, type: "number" }],
			rows: [{ [name]: total }],
			truncated: false,
		}))
	}
	const time = query.timeGroup?.name ?? query.def.timeField
	const rangeOf = (startMs: number, endMs: number): ReadonlyArray<ResolvedFilter> => [
		...query.serverFilters,
		{ field: time, op: "gte", value: startMs },
		{ field: time, op: "lt", value: endMs },
	]
	// A small total is cheaper to read once than to count bucket by bucket.
	const windowQuery: ValidatedQuery = { ...query, serverFilters: rangeOf(startMs, endMs) }
	const perBucket: Run<DataSourceTable> = Effect.map(
		Effect.forEach(Arr.chunksOf(buckets, COUNT_BATCH), (batch) =>
			Effect.andThen(
				context.spend(batch.length),
				Effect.forEach(
					batch,
					(b) => Effect.map(count(rangeOf(b.startMs, b.endMs)), (total) => ({ b, total })),
					{
						concurrency: batch.length,
					},
				),
			),
		),
		(batches) => ({
			columns: [
				{ name: "bucket", type: "timestamp" },
				{ name, type: "number" },
			],
			// Buckets are clipped to the window but labelled with their aligned start, like scans.
			rows: Arr.map(Arr.flatten(batches), ({ b, total }) => ({
				bucket: toIso(bucketStart(b.startMs, granularitySeconds)),
				[name]: total,
			})),
			truncated: false,
		}),
	)
	return Effect.gen(function* () {
		yield* context.spend(1)
		const total = yield* count(windowQuery.serverFilters)
		const pages = Math.max(1, Math.ceil(total / query.def.pageSize))
		if (total <= request.limits.maxScanRows && pages <= scanPages && pages < buckets.length) {
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.resource_plan": "scan",
				"maple.data_source.calls": 1 + pages,
			})
			return yield* runScan(
				windowQuery,
				{ _tag: "scan", estimate: false, knownTotal: total, maxPages: pages, stopAt: null },
				request,
				context,
			)
		}
		if (buckets.length > request.limits.maxCalls - 1) {
			return yield* tooManyBuckets(query, request, buckets.length, total)
		}
		yield* Effect.annotateCurrentSpan({
			"maple.data_source.resource_plan": "count",
			"maple.data_source.calls": 1 + buckets.length,
		})
		return yield* perBucket
	})
}

const tooBig = (query: ValidatedQuery, request: QueryRequest, total: number) =>
	new DataSourceLimitError({
		message:
			`This would read ~${total} ${query.def.noun.many} to answer in Maple (budget ${request.limits.maxScanRows} rows, ${request.limits.maxCalls} calls). ` +
			`Fix: narrow the window, or filter on a field the API filters itself (${serverFieldList(query)})` +
			(query.measure?.fn === "count" ? " so the count runs as a total per bucket." : "."),
	})

const runScan = (
	query: ValidatedQuery,
	plan: Extract<ResourcePlan, { _tag: "scan" }>,
	request: QueryRequest,
	context: QueryContext,
): Run<DataSourceTable> =>
	Effect.gen(function* () {
		const { def } = query
		const count = plan.estimate ? def.count : undefined
		const total =
			plan.knownTotal ??
			(count === undefined ? null : yield* Effect.andThen(context.spend(1), count(query.serverFilters)))
		const needed = total === null ? plan.maxPages : Math.max(1, Math.ceil(total / def.pageSize))
		if (total !== null && (total > request.limits.maxScanRows || needed > plan.maxPages)) {
			return yield* tooBig(query, request, total)
		}
		const pages = Math.min(needed, plan.maxPages)
		const { stopAt } = plan
		// One row past `stopAt` tells a list whether more exist without another call.
		const pageSize =
			stopAt === null || query.clientFilters.length > 0
				? def.pageSize
				: Math.min(def.pageSize, stopAt + 1)
		const fetch = (page: number, limit: number) =>
			Effect.andThen(
				context.spend(1),
				def.fetchPage({
					filters: query.serverFilters,
					orderBy: query.orderBy,
					limit,
					offset: page * pageSize,
				}),
			)
		const step = (
			page: number,
			read: number,
			matched: ReadonlyArray<ResourceRow>,
		): Run<{ rows: ReadonlyArray<ResourceRow>; more: boolean }> =>
			Effect.gen(function* () {
				const rows = yield* fetch(page, pageSize)
				const all = [...matched, ...Arr.filter(rows, (row) => matchesAll(query, row))]
				const seen = read + rows.length
				// A short page, or every row the total promised, is the end.
				const end = rows.length < pageSize || (total !== null && seen >= total)
				if (stopAt !== null && all.length >= stopAt) {
					return { rows: all, more: all.length > stopAt || !end }
				}
				if (end) return { rows: all, more: false }
				if (page + 1 < pages) return yield* step(page + 1, seen, all)
				if (total !== null || stopAt !== null) return { rows: all, more: true }
				// No total: one row from the next page decides whether the last full page was the end.
				const probe = yield* fetch(page + 1, 1)
				return { rows: all, more: probe.length > 0 }
			})
		const result = yield* step(0, 0, [])
		if (query.measure === null) return projectRows(query, result.rows, result.more)
		if (result.more) {
			return yield* new DataSourceLimitError({
				message: `Read ${pages * pageSize} ${def.noun.many} without reaching the end. Fix: narrow the window, or filter on ${serverFieldList(query)}.`,
			})
		}
		return aggregateRows(query, result.rows, request.window, request.limits.maxRows)
	})

export const executeResourcePlan = (
	query: ValidatedQuery,
	plan: ResourcePlan,
	request: QueryRequest,
	context: QueryContext,
): Run<DataSourceTable> =>
	plan._tag === "count" ? runCount(query, plan, request, context) : runScan(query, plan, request, context)
