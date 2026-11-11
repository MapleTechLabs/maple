import type { CostDimension, CostMetric } from "@maple/domain/cost"
import type { OrgId } from "@maple/domain"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/cache-policy"
import { wholeDayWindow } from "./day-window"
import { defineQuery } from "./query-definition"

// Cloud cost reads over `cost_daily`. Providers bill whole UTC days, so the page's window is
// floored to the midnight-UTC `Date` rows it covers, both ends inclusive.

/**
 * What every cost read carries. `sourceIds` are the org's connected sources and must not be
 * empty: the query does not narrow on an empty list, and a disconnected source keeps its rows.
 */
interface CostWindowPayload {
	readonly startTime: string
	readonly endTime: string
	/** Defaults to `billed`. */
	readonly metric?: CostMetric | undefined
	readonly filters?: Partial<Record<CostDimension, ReadonlyArray<string>>> | undefined
	readonly sourceIds: ReadonlyArray<string>
}

const readOpts = (payload: CostWindowPayload) => ({
	sourceIds: payload.sourceIds,
	values: payload.filters,
	metric: payload.metric,
})

const params = (payload: CostWindowPayload, orgId: OrgId) => {
	const days = wholeDayWindow(payload)
	return { orgId, startDate: days.startDate, endDate: days.endDate }
}

/** The window's params plus the start of the equal-length run of days before it. */
const comparedParams = (payload: CostWindowPayload, orgId: OrgId) => ({
	...params(payload, orgId),
	previousStartDate: wholeDayWindow(payload).previousStartDate,
})

export const costTotals = defineQuery({
	id: "costTotals",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: CostWindowPayload, orgId: OrgId) =>
		CH.compile(CH.costTotalsQuery(readOpts(payload)), comparedParams(payload, orgId)),
})

export interface CostTimeseriesPayload extends CostWindowPayload {
	readonly groupBy?: CostDimension | undefined
	/** With `groupBy`: the keys that keep their own series; the rest fold into `COST_OTHER_KEY`. */
	readonly keys?: ReadonlyArray<string> | undefined
}

export const costTimeseries = defineQuery({
	id: "costTimeseries",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: CostTimeseriesPayload, orgId: OrgId) =>
		CH.compile(
			CH.costTimeseriesQuery({
				...readOpts(payload),
				dimension: payload.groupBy,
				keys: payload.keys,
			}),
			params(payload, orgId),
		),
})

export interface CostBreakdownPayload extends CostWindowPayload {
	readonly groupBy: CostDimension
	readonly sortBy?: CH.CostBreakdownSortKey | undefined
	readonly limit?: number | undefined
}

export const costBreakdown = defineQuery({
	id: "costBreakdown",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: CostBreakdownPayload, orgId: OrgId) =>
		CH.compile(
			CH.costBreakdownQuery({
				...readOpts(payload),
				dimension: payload.groupBy,
				sortBy: payload.sortBy,
				limit: payload.limit,
			}),
			comparedParams(payload, orgId),
		),
})
