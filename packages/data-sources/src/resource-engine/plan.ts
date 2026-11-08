import { Array as Arr, Effect } from "effect"
import { DataSourceLimitError, type QueryPlanSummary } from "@maple/domain/data-sources"
import type { QueryRequest } from "../port"
import { type Bucket, bucketCount, bucketsFor, describeGranularity } from "./time"
import type { ResourceDefinition } from "./types"
import type { ValidatedQuery } from "./validate"

export type ResourcePlan =
	/** One total call per bucket (or one in all), no rows fetched. */
	| {
			readonly _tag: "count"
			readonly count: NonNullable<ResourceDefinition["count"]>
			readonly buckets: ReadonlyArray<Bucket> | null
	  }
	/** Page through server-filtered rows; `estimate` first when the result needs every matching row. */
	| {
			readonly _tag: "scan"
			readonly estimate: boolean
			readonly maxPages: number
			readonly stopAt: number | null
	  }

export interface PlannedQuery {
	readonly plan: ResourcePlan
	readonly summary: Extract<QueryPlanSummary, { readonly _tag: "resource" }>
}

const DAY = 86_400

/** Server-side fields as a list for "filter on ..." fixes. */
export const serverFieldList = (query: ValidatedQuery): string =>
	Arr.join(
		Arr.map(
			Arr.filter(query.def.fields, (f) => f.capabilities.filter === "server"),
			(f) => `\`${f.name}\``,
		),
		", ",
	)

/** The cheapest plan within the limits, or a refusal with a concrete fix. Makes no calls. */
export const planResourceQuery = (
	query: ValidatedQuery,
	request: QueryRequest,
): Effect.Effect<PlannedQuery, DataSourceLimitError> => {
	const { def } = query
	const { limits, window } = request
	const count = def.count
	if (
		query.measure?.fn === "count" &&
		query.groupField === null &&
		query.clientFilters.length === 0 &&
		count !== undefined
	) {
		if (query.timeGroup === null) {
			return Effect.succeed({
				plan: { _tag: "count", count, buckets: null },
				summary: {
					_tag: "resource",
					strategy: "count",
					calls: 1,
					maxRows: 0,
					description: `One total call for matching ${def.noun.many}; no rows fetched.`,
				},
			})
		}
		const calls = bucketCount(window.startMs, window.endMs, window.granularitySeconds)
		const width = describeGranularity(window.granularitySeconds)
		if (calls > limits.maxCalls) {
			const coarser = window.granularitySeconds < DAY ? "group by day instead of hour" : "group by week"
			return Effect.fail(
				new DataSourceLimitError({
					message: `Counting ${def.noun.many} per ${width} over this window needs ${calls} API calls (one per bucket), over the budget of ${limits.maxCalls}. Fix: ${coarser}, or narrow the window.`,
				}),
			)
		}
		return Effect.succeed({
			plan: {
				_tag: "count",
				count,
				buckets: bucketsFor(window.startMs, window.endMs, window.granularitySeconds),
			},
			summary: {
				_tag: "resource",
				strategy: "count",
				calls,
				maxRows: 0,
				description: `One total call per ${width} bucket of \`${query.timeGroup.name}\` (${calls} calls); no rows fetched.`,
			},
		})
	}
	// List mode with only server filters reads just enough pages for `limit`.
	if (query.measure === null && query.clientFilters.length === 0) {
		const pages = Math.ceil(query.limit / def.pageSize)
		return Effect.succeed({
			plan: { _tag: "scan", estimate: false, maxPages: pages, stopAt: query.limit },
			summary: {
				_tag: "resource",
				strategy: "scan",
				calls: pages,
				maxRows: query.limit,
				description: `Lists up to ${query.limit} ${def.noun.many}, filtered and sorted by the API.`,
			},
		})
	}
	const estimate = def.count !== undefined
	const pageBudget = Math.min(
		limits.maxCalls - (estimate ? 1 : 0),
		Math.ceil(limits.maxScanRows / def.pageSize),
	)
	if (pageBudget < 1) {
		return Effect.fail(
			new DataSourceLimitError({
				message: `The call budget of ${limits.maxCalls} is too small to scan ${def.noun.many}`,
			}),
		)
	}
	const clientSide = Arr.join(Arr.dedupe(Arr.map(query.clientFilters, (f) => `\`${f.field}\``)), ", ")
	return Effect.succeed({
		plan: {
			_tag: "scan",
			estimate,
			maxPages: pageBudget,
			stopAt: query.measure === null ? query.limit : null,
		},
		summary: {
			_tag: "resource",
			strategy: "scan",
			calls: pageBudget + (estimate ? 1 : 0),
			maxRows: Math.min(limits.maxScanRows, pageBudget * def.pageSize),
			description:
				`Reads ${def.noun.many} the API filters (${estimate ? "after a total call to size the scan" : "no total available"}), ` +
				`then ${clientSide === "" ? "groups" : `filters on ${clientSide} and groups`} them in Maple. Refused if more than ${limits.maxScanRows} rows match.`,
		},
	})
}
